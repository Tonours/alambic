import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alambicStateDir } from './state-dir.mjs'
import { scanUnsafe } from './vault.mjs'
import { REFUSE_BODY } from './promotion-judge.mjs'
import { vaultDir } from './write-journal.mjs'

export const HARNESSES = ['claude', 'codex', 'pi']
export const HARVEST_ORIGIN = 'session-harvest'
export const SESSION_TRUST = 'untrusted-session-data'
export const DEFAULT_DISTILLER = 'claude -p --setting-sources "" --disable-slash-commands --tools "" --strict-mcp-config --no-session-persistence --model sonnet'
const NOTE_TYPES = ['finding', 'incident', 'adr', 'reference', 'synthesis']
const QUIET_MS = 10 * 60 * 1000
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EXCERPT_MAX = 6000
const DISTILL_ATTEMPTS = 3
const MESSAGE_MAX = 800
const FILE_REF = /(?:^|[\s`(])((?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]{1,6}):\d+(?:-\d+)?\b/gi
const DECISION = /\b(decided|decision|decide|chose|choose|trade-?off|convention|adr|rule|policy|d[ée]cid[ée]?|d[ée]cision|choix|on part sur|r[èe]gle)\b/gi
const RESOLUTION = /\b(fixed|fix|root cause|works now|resolved|passes|green|validated|r[ée]solu|cause racine|corrig[ée]|[çc]a marche)\b/gi
const COUNTERS = ['scanned', 'queued', 'distilled', 'acked', 'skipped', 'distill_failed', 'accepted', 'rejected', 'promoted', 'noop']

function home(env) { return env.HOME || os.homedir() }

export function sessionRoots(env = process.env) {
  const unique = (dirs) => [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))]
  return {
    claude: unique([env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, 'projects'), path.join(home(env), '.claude/projects')]),
    codex: unique([env.CODEX_HOME && path.join(env.CODEX_HOME, 'sessions'), path.join(home(env), '.codex/sessions')]),
    pi: unique([env.PI_CODING_AGENT_DIR && path.join(env.PI_CODING_AGENT_DIR, 'sessions'), path.join(home(env), '.pi/agent/sessions')]),
  }
}

function listJsonl(dir, depth) {
  const files = []
  const walk = (current, level) => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory() && level < depth) walk(full, level + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && level === depth) files.push(full)
    }
  }
  walk(dir, 0)
  return files
}

export function listSessionFiles(harness, roots = sessionRoots()) {
  const depth = { claude: 1, codex: 3, pi: 1 }[harness]
  return [...new Set(roots[harness].flatMap((dir) => listJsonl(dir, depth)))].sort()
}

export function detectHarness(file, roots = sessionRoots()) {
  let resolved
  try {
    if (!file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) return null
    resolved = fs.realpathSync(file)
  } catch {
    return null
  }
  const real = (dir) => { try { return fs.realpathSync(dir) } catch { return path.resolve(dir) } }
  return HARNESSES.find((harness) => roots[harness].some((dir) => resolved.startsWith(`${real(dir)}${path.sep}`))) || null
}

function textParts(content, types) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter((part) => part && types.includes(part.type) && typeof part.text === 'string').map((part) => part.text)
}

function cleanText(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ')
    .trim()
}

function injected(text) {
  return /^<[a-z_-]+>/i.test(text) || /^# AGENTS\.md instructions/.test(text) || /^Caveat: The messages below/.test(text)
}

export function readSession(harness, file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let id = path.basename(file, '.jsonl')
  let cwd = null
  const messages = []
  const push = (role, parts) => {
    const text = cleanText(parts.join('\n'))
    if (text && !injected(text)) messages.push({ role, text })
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (harness === 'claude') {
      if (record.sessionId) id = record.sessionId
      if (record.cwd && !cwd) cwd = record.cwd
      if (record.isMeta || record.isSidechain || !['user', 'assistant'].includes(record.type)) continue
      push(record.type, textParts(record.message?.content, ['text']))
    } else if (harness === 'codex') {
      const payload = record.payload || {}
      if (record.type === 'session_meta') {
        id = payload.session_id || payload.id || id
        cwd = payload.cwd || cwd
      } else if (record.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
        push(payload.role, textParts(payload.content, ['input_text', 'output_text']))
      }
    } else if (harness === 'pi') {
      if (record.type === 'session') {
        id = record.id || id
        cwd = record.cwd || cwd
      } else if (record.type === 'message' && ['user', 'assistant'].includes(record.message?.role)) {
        push(record.message.role, textParts(record.message.content, ['text']))
      }
    }
  }
  return { harness, id: String(id), cwd, file, messages }
}

function count(regex, text) { return (String(text).match(regex) || []).length }

function signals(text) {
  const refs = new Set([...String(text).matchAll(FILE_REF)].map((match) => match[0].trim()))
  return { file_refs: refs.size, decisions: count(DECISION, text), resolutions: count(RESOLUTION, text) }
}

export function scoreSession(messages) {
  const text = messages.map((message) => message.text).join('\n')
  const found = signals(text)
  const userTurns = messages.filter((message) => message.role === 'user').length
  const parts = {
    file_refs: Math.min(30, found.file_refs * 6),
    decisions: Math.min(21, found.decisions * 3),
    resolutions: Math.min(14, found.resolutions * 2),
    user_turns: Math.min(12, userTurns * 2),
  }
  return { score: Object.values(parts).reduce((sum, value) => sum + value, 0), parts, signals: { ...found, user_turns: userTurns } }
}

export function buildExcerpt(messages, max = EXCERPT_MAX) {
  const safe = messages
    .map((message, index) => ({ ...message, index }))
    .filter((message) => scanUnsafe(message.text).length === 0 && !REFUSE_BODY.some((regex) => regex.test(message.text)))
  const dropped = messages.length - safe.length
  const density = (message) => { const found = signals(message.text); return found.file_refs * 3 + found.decisions * 2 + found.resolutions }
  const first = safe.find((message) => message.role === 'user')
  const picked = new Map()
  let used = 0
  const take = (message, limit) => {
    if (picked.has(message.index)) return
    const text = message.text.length > limit ? `${message.text.slice(0, limit)} [...]` : message.text
    const line = `${message.role}: ${text}`
    const size = line.length + (picked.size ? 2 : 0)
    if (used + size > max) return
    picked.set(message.index, line)
    used += size
  }
  if (first) take(first, 400)
  for (const message of [...safe].sort((a, b) => density(b) - density(a) || a.index - b.index)) {
    if (density(message) === 0) break
    take(message, MESSAGE_MAX)
  }
  const excerpt = [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n\n')
  return { excerpt, dropped_unsafe: dropped }
}

function harvestDir(stateDir, ...parts) { return path.join(stateDir || alambicStateDir(), 'harvest', ...parts) }

function existingAncestor(target) {
  let current = path.resolve(target)
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current)
  return fs.realpathSync.native(current)
}

function insideVault(root, target) {
  const vault = fs.statSync(root)
  for (let current = existingAncestor(target); ; current = path.dirname(current)) {
    const stat = fs.statSync(current)
    if (stat.dev === vault.dev && stat.ino === vault.ino) return true
    if (path.dirname(current) === current) return false
  }
}

export function stateInsideVault(root, stateDir = null) {
  const state = stateDir || alambicStateDir()
  return [state, path.join(state, 'reviews'), harvestDir(state), ...['queue', 'processed', 'lock'].map((sub) => harvestDir(state, sub))].some((dir) => insideVault(root, dir))
}

function assertStateOutside(root, stateDir) {
  if (stateInsideVault(root, stateDir)) throw new Error('alambic state dir must be outside the vault')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

const LOCK_STALE_MS = 30 * 60 * 1000
const REAP_DEPTH = 8

function lockOwner(dir) { return readJson(path.join(dir, 'owner.json'), null) }

function ownerAlive(dir, owner) {
  if (!owner) {
    try { return Date.now() - fs.statSync(dir).mtimeMs < LOCK_STALE_MS } catch { return false }
  }
  try { process.kill(owner.pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function createOwned(dir, owner) {
  if (fs.existsSync(dir)) return false
  let temporary
  try { temporary = fs.mkdtempSync(`${dir}.new-`) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  fs.writeFileSync(path.join(temporary, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
  try {
    fs.renameSync(temporary, dir)
    return true
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return false
    throw error
  }
}

function discard(dir) {
  const gone = `${dir}.gone-${crypto.randomUUID()}`
  try { fs.renameSync(dir, gone) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  fs.rmSync(gone, { recursive: true, force: true })
}

function ownerKey(dir, owner) {
  if (owner?.token) return String(owner.token).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || null
  try { const stat = fs.statSync(dir); return `ino${stat.ino}m${Math.floor(stat.mtimeMs)}` } catch { return null }
}

function claim(dir, me, depth) {
  if (createOwned(dir, me)) return true
  if (depth >= REAP_DEPTH) return false
  const owner = lockOwner(dir)
  if (ownerAlive(dir, owner)) return false
  const key = ownerKey(dir, owner)
  return Boolean(key) && claim(path.join(dir, `reap-${key}`), me, depth + 1)
}

function sweepClaims(lock) {
  const current = fs.existsSync(lock) ? ownerKey(lock, lockOwner(lock)) : null
  const prefix = `${path.basename(lock)}.reap-`
  for (const name of fs.readdirSync(path.dirname(lock))) {
    if (name.startsWith(prefix) && !name.includes('.gone-') && name.slice(prefix.length) !== current) discard(path.join(path.dirname(lock), name))
  }
}

function acquireOwned(lock, me) {
  if (createOwned(lock, me)) return true
  const holder = lockOwner(lock)
  if (ownerAlive(lock, holder)) return false
  const key = ownerKey(lock, holder)
  if (!key || !claim(`${lock}.reap-${key}`, me, 0)) return false
  if (ownerKey(lock, lockOwner(lock)) !== key) return false
  discard(lock)
  const acquired = createOwned(lock, me)
  sweepClaims(lock)
  return acquired
}

function releaseOwned(lock, me) {
  if (lockOwner(lock)?.token === me.token) discard(lock)
  sweepClaims(lock)
}

export function withHarvestLock(stateDir, fn) {
  const lock = harvestDir(stateDir, 'lock')
  const me = { pid: process.pid, token: crypto.randomUUID() }
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  if (!acquireOwned(lock, me)) return { ok: false, locked: true }
  try { return fn() } finally { releaseOwned(lock, me) }
}

function withFileLock(file, fn) {
  const lock = `${file}.lock`
  const me = { pid: process.pid, token: crypto.randomUUID() }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  for (let attempt = 0; !acquireOwned(lock, me); attempt += 1) {
    if (attempt >= 400) throw new Error(`lock busy: ${path.basename(file)}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  try { return fn() } finally { releaseOwned(lock, me) }
}

export function bumpMetrics(stateDir, delta) {
  const file = harvestDir(stateDir, 'metrics.json')
  return withFileLock(file, () => {
    const metrics = { version: 1, ...Object.fromEntries(COUNTERS.map((key) => [key, 0])), ...readJson(file, {}) }
    for (const [key, value] of Object.entries(delta)) if (COUNTERS.includes(key) && value) metrics[key] += value
    metrics.updated_at = new Date().toISOString()
    writeJson(file, metrics)
    return metrics
  })
}

function safeId(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16) }

export function harvestScan(root, { harnesses = HARNESSES, session = null, minScore = 40, dryRun = false, now = Date.now(), stateDir = null, env = process.env } = {}) {
  assertStateOutside(root, stateDir)
  const roots = sessionRoots(env)
  const cursorFile = harvestDir(stateDir, 'cursor.json')
  const cursor = readJson(cursorFile, { version: 1, files: {} })
  const targets = session
    ? [{ harness: detectHarness(session, roots), file: path.resolve(session) }]
    : harnesses.flatMap((harness) => listSessionFiles(harness, roots).map((file) => ({ harness, file })))
  const report = { ok: true, dry_run: dryRun, min_score: minScore, scanned: 0, queued: [], below: 0, skipped_recent: 0, skipped_unchanged: 0, skipped_pending: 0, dropped_unsafe: 0 }
  for (const target of targets) {
    const { harness } = target
    if (!harness) { report.ok = false; report.error = 'session file is outside known harness session roots'; continue }
    let stat
    let file
    try { file = fs.realpathSync.native(target.file); stat = fs.statSync(file) } catch { continue }
    const previous = cursor.files[file] || cursor.files[path.resolve(target.file)]
    if (file !== path.resolve(target.file)) delete cursor.files[path.resolve(target.file)]
    if (previous) cursor.files[file] = previous
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) { report.skipped_unchanged += 1; continue }
    if (!session && now - stat.mtimeMs < QUIET_MS) { report.skipped_recent += 1; continue }
    if (!previous && !session && now - stat.mtimeMs > LOOKBACK_MS) continue
    let parsed
    try { parsed = readSession(harness, file) } catch { continue }
    const fresh = parsed.messages.slice(previous?.messages || 0)
    report.scanned += 1
    cursor.files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, messages: parsed.messages.length }
    if (!fresh.length) continue
    const scored = scoreSession(fresh)
    if (scored.score < minScore) { report.below += 1; continue }
    const { excerpt, dropped_unsafe } = buildExcerpt(fresh)
    report.dropped_unsafe += dropped_unsafe
    if (!excerpt || scanUnsafe(excerpt).length) { report.below += 1; continue }
    const entry = {
      version: 1,
      harness,
      session_id: parsed.id,
      source_ref: `${harness}:${parsed.id}`,
      cwd: parsed.cwd,
      score: scored.score,
      parts: scored.parts,
      signals: scored.signals,
      trust: SESSION_TRUST,
      queued_at: new Date(now).toISOString(),
      excerpt,
    }
    const name = `${harness}-${safeId(parsed.id)}-m${previous?.messages || 0}.json`
    if (fs.existsSync(harvestDir(stateDir, 'queue', name))) {
      if (previous) cursor.files[file] = previous
      else delete cursor.files[file]
      report.skipped_pending += 1
      continue
    }
    report.queued.push({ name, source_ref: entry.source_ref, score: entry.score })
    if (!dryRun) writeJson(harvestDir(stateDir, 'queue', name), entry)
  }
  for (const [file, value] of Object.entries(cursor.files)) if (now - value.mtimeMs > CURSOR_TTL_MS) delete cursor.files[file]
  if (!dryRun) {
    writeJson(cursorFile, cursor)
    bumpMetrics(stateDir, { scanned: report.scanned, queued: report.queued.length })
  }
  return report
}

export function listQueue(stateDir) {
  const dir = harvestDir(stateDir, 'queue')
  let names = []
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() } catch { return [] }
  return names.map((name) => ({ name, entry: readJson(path.join(dir, name), null) })).filter((item) => item.entry)
}

function retire(stateDir, name, status, extra = {}) {
  const from = harvestDir(stateDir, 'queue', name)
  const entry = readJson(from, null)
  if (!entry) return
  const { excerpt, ...rest } = entry
  writeJson(harvestDir(stateDir, 'processed', name), { ...rest, excerpt_sha256: crypto.createHash('sha256').update(excerpt || '').digest('hex'), status, processed_at: new Date().toISOString(), ...extra })
  fs.rmSync(from, { force: true })
}

export function distillPrompt(root, entry) {
  const template = fs.readFileSync(path.join(root, '_meta/prompts/harvest-distill.md'), 'utf8')
  const fence = `excerpt-${crypto.randomBytes(6).toString('hex')}`
  return `${template.trim()}\n\n<${fence}>\n${entry.excerpt}\n</${fence}>\n`
}

function parseAnswer(stdout) {
  const text = String(stdout || '').trim()
  if (/^SKIP\b/i.test(text)) return { skip: true }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in distiller output')
  return JSON.parse(text.slice(start, end + 1))
}

function yamlString(value) { return JSON.stringify(String(value)) }

export function renderHarvestNote(answer, entry, today = new Date().toISOString().slice(0, 10)) {
  const type = NOTE_TYPES.includes(answer.type) ? answer.type : 'finding'
  const title = String(answer.title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const summary = String(answer.summary || '').replace(/\s+/g, ' ').trim()
  const body = String(answer.body || '').replace(/\r/g, '').trim()
  const tags = (Array.isArray(answer.tags) ? answer.tags : []).map((tag) => String(tag).toLowerCase().trim()).filter((tag) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(tag)).slice(0, 6)
  const sources = (Array.isArray(answer.sources) ? answer.sources : []).map(String).filter((source) => /^https:\/\/[^\s"]+$/.test(source)).slice(0, 5)
  if (!title) throw new Error('missing title')
  if (summary.length < 20 || summary.length > 300) throw new Error('summary must be 20-300 characters')
  if (body.length < 200 || body.length > 6000) throw new Error('body must be 200-6000 characters')
  if (!tags.length) throw new Error('missing tags')
  const text = [
    '---',
    `type: ${type}`,
    'status: draft',
    `summary: ${yamlString(summary)}`,
    'sources:',
    ...[entry.source_ref, ...sources].map((source) => `  - ${yamlString(source)}`),
    `origin: ${HARVEST_ORIGIN}`,
    `trust: ${SESSION_TRUST}`,
    `harvest_score: ${Number(entry.score) || 0}`,
    `created: ${today}`,
    `updated: ${today}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n')
  if (scanUnsafe(text).length) throw new Error('unsafe content')
  if (REFUSE_BODY.some((regex) => regex.test(text))) throw new Error('refused content')
  return text
}

function writeExclusive(dir, base, text) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const file = path.join(dir, `${base}${attempt ? `-${attempt}` : ''}.md`)
    try {
      fs.writeFileSync(file, text, { flag: 'wx' })
      return file
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not allocate a harvest inbox filename')
}

export function resolveDistiller(explicit, env = process.env) {
  const command = explicit || env.ALAMBIC_HARVEST_DISTILLER || ''
  if (command) return command
  const found = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8', env })
  return found.status === 0 ? DEFAULT_DISTILLER : null
}

export function harvestDistill(root, { distiller = null, max = 5, stateDir = null, timeoutMs = 180000, env = process.env, dryRun = false } = {}) {
  assertStateOutside(root, stateDir)
  const command = resolveDistiller(distiller, env)
  const report = { ok: true, distiller: command ? command.split(/\s+/)[0] : null, written: [], skipped: 0, failed: [] }
  if (!command) return { ...report, ok: true, unavailable: true }
  const queue = listQueue(stateDir).sort((a, b) => b.entry.score - a.entry.score).slice(0, max)
  for (const { name, entry } of queue) {
    if (dryRun) { report.written.push({ name, dry_run: true }); continue }
    const result = spawnSync('/bin/sh', ['-c', command], {
      input: distillPrompt(root, entry),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      cwd: os.tmpdir(),
      env: { ...env, ALAMBIC_HARVEST_CHILD: '1' },
    })
    try {
      if (result.status !== 0) throw new Error(`distiller exited ${result.status ?? result.signal}`)
      const answer = parseAnswer(result.stdout)
      if (answer.skip) {
        report.skipped += 1
        retire(stateDir, name, 'skipped')
        continue
      }
      const text = renderHarvestNote(answer, entry)
      const today = new Date().toISOString().slice(0, 10)
      const file = writeExclusive(vaultDir(root, 'docs/inbox/ai'), `harvest-${today}-${entry.harness}-${safeId(entry.session_id).slice(0, 8)}`, text)
      const relative = path.relative(root, file).split(path.sep).join('/')
      report.written.push({ name, path: relative })
      retire(stateDir, name, 'distilled', { inbox_path: relative })
    } catch (error) {
      const message = error.message.slice(0, 200)
      const attempts = (entry.attempts || 0) + 1
      report.failed.push({ name, error: message, attempts })
      if (attempts >= DISTILL_ATTEMPTS) retire(stateDir, name, 'distill_failed', { error: message, attempts })
      else writeJson(harvestDir(stateDir, 'queue', name), { ...entry, attempts, last_error: message })
    }
  }
  report.ok = report.failed.length === 0
  if (!dryRun) bumpMetrics(stateDir, { distilled: report.written.length, skipped: report.skipped, distill_failed: report.failed.length })
  return report
}

export function harvestDigest(root, { out, max = 20, stateDir = null } = {}) {
  if (!out) throw new Error('usage: alambic harvest digest --out FILE')
  const entries = listQueue(stateDir).sort((a, b) => b.entry.score - a.entry.score).slice(0, max)
  const digest = {
    version: 1,
    kind: 'alambic-harvest-digest',
    trust: SESSION_TRUST,
    created_at: new Date().toISOString(),
    entries: entries.map(({ name, entry }) => ({ name, source_ref: entry.source_ref, harness: entry.harness, cwd: entry.cwd, score: entry.score, excerpt_sha256: crypto.createHash('sha256').update(entry.excerpt).digest('hex'), excerpt: entry.excerpt })),
  }
  const target = path.resolve(out)
  if (insideVault(root, path.dirname(target))) throw new Error('harvest digest --out must be outside the vault')
  writeJson(target, digest)
  return { ok: true, out: target, count: digest.entries.length }
}

export function harvestAck(root, { digest, stateDir = null, dryRun = false } = {}) {
  if (!digest) throw new Error('usage: alambic harvest ack --digest FILE')
  const data = readJson(path.resolve(digest), null)
  if (!data || data.kind !== 'alambic-harvest-digest' || !Array.isArray(data.entries)) throw new Error('not an alambic harvest digest')
  let acked = 0
  for (const item of data.entries) {
    const name = path.basename(String(item.name || ''))
    const current = readJson(harvestDir(stateDir, 'queue', name), null)
    if (!current || crypto.createHash('sha256').update(current.excerpt).digest('hex') !== item.excerpt_sha256) continue
    if (!dryRun) retire(stateDir, name, 'acked')
    acked += 1
  }
  if (!dryRun) bumpMetrics(stateDir, { acked })
  return { ok: true, dry_run: dryRun, acked }
}

export function harvestStatus(root, { stateDir = null } = {}) {
  const metrics = { ...Object.fromEntries(COUNTERS.map((key) => [key, 0])), ...readJson(harvestDir(stateDir, 'metrics.json'), {}) }
  const reviewed = metrics.accepted + metrics.rejected
  const inbox = path.join(root, 'docs/inbox/ai')
  let pending = []
  try { pending = fs.readdirSync(inbox).filter((name) => /^harvest-.*\.md$/.test(name)).sort().map((name) => `docs/inbox/ai/${name}`) } catch {}
  return {
    ok: true,
    metrics: Object.fromEntries(COUNTERS.map((key) => [key, metrics[key]])),
    review_acceptance_rate: reviewed ? Number((metrics.accepted / reviewed).toFixed(3)) : null,
    queue: listQueue(stateDir).length,
    pending_review: pending,
    updated_at: metrics.updated_at || null,
  }
}
