import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decryptJson, encryptJson, hmac, keyHandle } from './crypto.mjs'
import { isUnsafeText } from './privacy.mjs'
import { ATTENTION_SOURCES, assertSource, validateCandidate } from './schema.mjs'

const SOURCE_STATE_FIELDS = new Set(['version', 'source', 'policy_version', 'last_success_at', 'seen'])
const CAPABILITY_STATUSES = new Set(['fixture-green', 'live-green', 'blocked-auth', 'blocked-policy', 'unsupported'])
const RECEIPT_DECISIONS = new Set(['accept', 'reject'])

function resolveStateHome(value) {
  return path.resolve(value || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'alambic', 'attention')
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function mode(file) {
  return fs.statSync(file).mode & 0o777
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`attention state is corrupt: ${path.basename(file)}`)
  }
}

function atomicJson(file, value, fileMode = 0o600) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: fileMode })
  fs.chmodSync(temporary, fileMode)
  fs.renameSync(temporary, file)
  fs.chmodSync(file, fileMode)
}

function atomicJsonExclusive(file, value) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o400 })
  fs.chmodSync(temporary, 0o400)
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function listFiles(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => path.join(directory, name)) : []
}

export class AttentionState {
  constructor({ root, xdgStateHome, keyStore, now = () => new Date().toISOString(), forbiddenRoots = [] }) {
    if (!root || !keyStore) throw new Error('attention state requires a root and key store')
    this.root = path.resolve(root)
    this.dir = resolveStateHome(xdgStateHome)
    this.keyStore = keyStore
    this.now = now
    this.forbiddenRoots = [this.root, process.env.ALAMBIC_OBSIDIAN_ROOT, process.env.ALAMBIC_SYNCTHING_ROOTS?.split(path.delimiter), ...forbiddenRoots]
      .flat().filter(Boolean).map((value) => path.resolve(value))
    if (this.forbiddenRoots.some((forbidden) => isWithin(this.dir, forbidden))) throw new Error('attention state must not be stored inside repository, Obsidian, or Syncthing roots')
  }

  sourceDir(source) {
    assertSource(source)
    const result = path.join(this.dir, source)
    if (!isWithin(result, this.dir)) throw new Error('unsafe attention source path')
    return result
  }

  sourcePath(source, ...segments) {
    const result = path.join(this.sourceDir(source), ...segments)
    if (!isWithin(result, this.sourceDir(source))) throw new Error('unsafe attention state path')
    return result
  }

  ensure(source) {
    const directory = this.sourceDir(source)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    for (const child of ['candidates', 'tombstones', 'receipts']) {
      const target = this.sourcePath(source, child)
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.chmodSync(target, 0o700)
    }
  }

  async withLock(source, action) {
    this.ensure(source)
    const lock = this.sourcePath(source, '.lock')
    let descriptor
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600)
      fs.fchmodSync(descriptor, 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`attention source is busy: ${source}`)
      throw error
    }
    try {
      return await action()
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      fs.rmSync(lock, { force: true })
    }
  }

  keys(source) {
    assertSource(source)
    const data = this.keyStore.get(keyHandle(source, 'data'))
    const hmacKey = this.keyStore.get(keyHandle(source, 'hmac'))
    return data && hmacKey ? { data, hmac: hmacKey } : null
  }

  digest(source, upstreamId, key = this.keys(source)?.hmac) {
    if (typeof upstreamId !== 'string' || !upstreamId) throw new Error('attention source item id is invalid')
    if (!key) throw new Error(`attention keys are unavailable for ${source}`)
    return hmac(`${source}:${upstreamId}`, key)
  }

  loadCursor(source) {
    const fallback = { version: 1, source, policy_version: 1, last_success_at: null, seen: [] }
    const state = readJson(this.sourcePath(source, 'cursor.json'), fallback)
    const unknown = Object.keys(state).filter((key) => !SOURCE_STATE_FIELDS.has(key))
    if (unknown.length || state.version !== 1 || state.source !== source || !Number.isInteger(state.policy_version) || !Array.isArray(state.seen)) throw new Error(`attention cursor is invalid: ${source}`)
    if (state.seen.some((entry) => !entry || !/^[a-f0-9]{64}$/.test(entry.digest || '') || typeof entry.expires_at !== 'string')) throw new Error(`attention cursor replay state is invalid: ${source}`)
    return state
  }

  saveCursor(source, cursor) {
    atomicJson(this.sourcePath(source, 'cursor.json'), cursor)
  }

  hasSeen(cursor, digest, now = this.now()) {
    return cursor.seen.some((entry) => entry.digest === digest && Date.parse(entry.expires_at) > Date.parse(now))
  }

  markSeen(cursor, digest, expiresAt, maxSeen) {
    cursor.seen = cursor.seen.filter((entry) => Date.parse(entry.expires_at) > Date.parse(this.now()) && entry.digest !== digest)
    cursor.seen.push({ digest, expires_at: expiresAt })
    cursor.seen = cursor.seen.slice(-maxSeen)
  }

  saveCandidate(source, digest, candidate, dataKey) {
    validateCandidate(candidate)
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('attention candidate digest is invalid')
    const stored = {
      version: 1,
      source,
      expires_at: candidate.expires_at,
      encrypted: encryptJson(candidate, dataKey),
    }
    atomicJson(this.sourcePath(source, 'candidates', `${digest}.json`), stored)
  }

  loadCandidate(source, digest, dataKey) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('attention candidate digest is invalid')
    const file = this.sourcePath(source, 'candidates', `${digest}.json`)
    if (!fs.existsSync(file)) return null
    const stored = readJson(file, null)
    if (!stored || stored.version !== 1 || stored.source !== source || typeof stored.expires_at !== 'string' || !stored.encrypted) throw new Error(`attention candidate state is invalid: ${source}`)
    if (Date.parse(stored.expires_at) <= Date.parse(this.now())) {
      fs.rmSync(file, { force: true })
      return null
    }
    const candidate = decryptJson(stored.encrypted, dataKey)
    validateCandidate(candidate)
    return candidate
  }

  listCandidates(source, dataKey) {
    const result = []
    for (const file of listFiles(this.sourcePath(source, 'candidates'))) {
      const digest = path.basename(file, '.json')
      const candidate = this.loadCandidate(source, digest, dataKey)
      if (candidate) result.push({ digest, candidate })
    }
    return result
  }

  saveTombstone(source, digest, reasonCode, expiresAt) {
    if (!/^[a-f0-9]{64}$/.test(digest) || typeof reasonCode !== 'string' || !reasonCode || typeof expiresAt !== 'string') throw new Error('invalid attention tombstone')
    atomicJson(this.sourcePath(source, 'tombstones', `${digest}.json`), { version: 1, expires_at: expiresAt, reason_code: reasonCode })
  }

  saveCapability(source, capability) {
    assertSource(source)
    if (!capability || !CAPABILITY_STATUSES.has(capability.status) || typeof capability.checked_at !== 'string' || Number.isNaN(Date.parse(capability.checked_at)) || typeof capability.evidence !== 'string' || !/^[a-z0-9 .:_-]{1,160}$/i.test(capability.evidence) || isUnsafeText(capability.evidence)) throw new Error('invalid attention capability')
    if (capability.account_alias !== undefined && capability.account_alias !== null && !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(capability.account_alias)) throw new Error('invalid attention account alias')
    if (capability.scope_fingerprint !== undefined && capability.scope_fingerprint !== null && !/^[a-f0-9]{64}$/.test(capability.scope_fingerprint)) throw new Error('invalid attention scope fingerprint')
    const value = { version: 1, source, status: capability.status, checked_at: capability.checked_at, evidence: capability.evidence, scope_fingerprint: capability.scope_fingerprint || null, account_alias: capability.account_alias || null }
    atomicJson(this.sourcePath(source, 'capability.json'), value)
    return value
  }

  loadCapability(source) {
    return readJson(this.sourcePath(source, 'capability.json'), null)
  }

  saveReceipt(source, digest, decision, reasonCode) {
    if (!/^[a-f0-9]{64}$/.test(digest) || !RECEIPT_DECISIONS.has(decision) || !/^[a-z0-9-]+$/.test(reasonCode || '')) throw new Error('invalid attention review receipt')
    const payload = { version: 1, source, candidate_digest: digest, decision, reason_code: reasonCode, reviewed_at: this.now() }
    const receipt = { ...payload, receipt_sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
    atomicJsonExclusive(this.sourcePath(source, 'receipts', `${digest}.json`), receipt)
    return receipt
  }

  saveMetrics(source, metrics) {
    const current = readJson(this.sourcePath(source, 'metrics.json'), { version: 1, source, days: [] })
    if (current.version !== 1 || current.source !== source || !Array.isArray(current.days)) throw new Error(`attention metrics are invalid: ${source}`)
    const day = this.now().slice(0, 10)
    const existing = current.days.find((entry) => entry.day === day)
    const target = existing || { day, accepted: 0, rejected: 0, replayed: 0, reasons: {} }
    if (!existing) current.days.push(target)
    for (const key of ['accepted', 'rejected', 'replayed']) target[key] += Number(metrics[key] || 0)
    for (const [reason, count] of Object.entries(metrics.reasons || {})) target.reasons[reason] = Number(target.reasons[reason] || 0) + Number(count)
    atomicJson(this.sourcePath(source, 'metrics.json'), current)
  }

  purge(source, policy) {
    this.ensure(source)
    const now = Date.parse(this.now())
    let removed = 0
    for (const directory of ['candidates', 'tombstones', 'receipts']) {
      for (const file of listFiles(this.sourcePath(source, directory))) {
        const item = readJson(file, null)
        const expiresAt = directory === 'candidates' || directory === 'tombstones'
          ? item?.expires_at
          : new Date(Date.parse(item?.reviewed_at || '') + policy.limits.receipt_retention_days * 86400_000).toISOString()
        if (!expiresAt || Date.parse(expiresAt) <= now) {
          fs.rmSync(file, { force: true })
          removed += 1
        }
      }
    }
    const metricsFile = this.sourcePath(source, 'metrics.json')
    const metrics = readJson(metricsFile, null)
    if (metrics?.days) {
      const cutoff = now - policy.limits.metrics_retention_days * 86400_000
      metrics.days = metrics.days.filter((entry) => Date.parse(`${entry.day}T00:00:00.000Z`) > cutoff)
      atomicJson(metricsFile, metrics)
    }
    const capabilityFile = this.sourcePath(source, 'capability.json')
    const capability = readJson(capabilityFile, null)
    if (capability && ['blocked-auth', 'blocked-policy', 'unsupported'].includes(capability.status) && Date.parse(capability.checked_at) <= now - policy.limits.disabled_audit_retention_days * 86400_000) {
      fs.rmSync(capabilityFile, { force: true })
      removed += 1
    }
    return removed
  }

  status() {
    const sources = {}
    for (const source of ATTENTION_SOURCES) {
      const directory = this.sourceDir(source)
      sources[source] = {
        present: fs.existsSync(directory),
        capability: this.loadCapability(source),
        candidates: listFiles(this.sourcePath(source, 'candidates')).length,
      }
    }
    return { version: 1, state_dir: this.dir, sources }
  }

  disconnect(source, { dryRun = true, confirm = false } = {}) {
    assertSource(source)
    const directory = this.sourceDir(source)
    const targets = [directory, keyHandle(source, 'data'), keyHandle(source, 'hmac')]
    if (dryRun || !confirm) return { source, dry_run: true, targets, external_revoke: 'not-configured' }
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
    this.keyStore.delete(keyHandle(source, 'data'))
    this.keyStore.delete(keyHandle(source, 'hmac'))
    return { source, disconnected: true, external_revoke: 'not-configured' }
  }

  assertPermissions(source) {
    const directory = this.sourceDir(source)
    if (!fs.existsSync(directory)) return true
    if (mode(directory) !== 0o700) throw new Error(`attention state directory permissions are unsafe: ${source}`)
    for (const child of ['candidates', 'tombstones', 'receipts']) {
      const target = this.sourcePath(source, child)
      if (mode(target) !== 0o700) throw new Error(`attention state directory permissions are unsafe: ${child}`)
    }
    for (const file of [...listFiles(this.sourcePath(source, 'candidates')), ...listFiles(this.sourcePath(source, 'tombstones')), ...listFiles(this.sourcePath(source, 'receipts'))]) {
      const expected = file.includes(`${path.sep}receipts${path.sep}`) ? 0o400 : 0o600
      if (mode(file) !== expected) throw new Error(`attention state file permissions are unsafe: ${path.basename(file)}`)
    }
    for (const file of ['cursor.json', 'capability.json', 'metrics.json']) {
      const target = this.sourcePath(source, file)
      if (fs.existsSync(target) && mode(target) !== 0o600) throw new Error(`attention state file permissions are unsafe: ${file}`)
    }
    return true
  }
}
