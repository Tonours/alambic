import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { harvestDistill, harvestScan, resolveDistiller, stateInsideVault, withHarvestLock } from './harvest.mjs'
import { alambicStateDir } from './state-dir.mjs'
import { digest, displacedEdits, journalRecord, readJournal, writeAll } from './write-journal.mjs'

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT_PATHS = ['kb', 'ref', '_meta/enrich-ledger.json']
const COMMIT_MESSAGE = 'chore(sidekick): nightly heals'
const STEP_TIMEOUT_MS = 20 * 60 * 1000

const allowedChange = ({ status, file }) => /^(kb|ref)\/[^/]+$/.test(file) || file === '_meta/enrich-ledger.json' || (status === 'D' && file.startsWith('docs/inbox/'))
const tail = (text) => String(text || '').trim().split('\n').slice(-3).join('\n').slice(-300)

function git(root, argv, env) {
  const result = spawnSync('git', argv, { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: tail(result.stderr) }
}

function changes(root, env, argv) {
  const result = git(root, [...argv, '-z'], env)
  if (!result.ok) return null
  const fields = result.out.split('\0').filter(Boolean)
  const list = []
  for (let index = 0; index < fields.length; index += 2) list.push({ status: fields[index][0], file: fields[index + 1] })
  return list
}

const recordPath = (env) => path.join(env.ALAMBIC_STATE_DIR || alambicStateDir(), 'harvest', 'nightly-commit.json')

function recordedCommit(root, env) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(env), 'utf8'))
    return record.root === fs.realpathSync.native(root) ? record.commit : null
  } catch { return null }
}

function recordCommit(root, env, commit) {
  const file = recordPath(env)
  if (commit === null) return fs.rmSync(file, { force: true })
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ root: fs.realpathSync.native(root), commit }), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

function gitPath(root, env, name) {
  const located = git(root, ['rev-parse', '--git-path', name], env)
  return located.ok ? path.resolve(root, located.out) : null
}

function defaultBranch(root, env) {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env)
  return head.ok && head.out.startsWith('origin/') ? head.out.slice('origin/'.length) : 'main'
}

export function nightlyPreflight(root, { push = false, commit = push, env = process.env } = {}) {
  const inside = git(root, ['rev-parse', '--show-toplevel'], env)
  if (!inside.ok) return { ok: false, reason: 'not a git work tree' }
  if (stateInsideVault(root)) return { ok: false, reason: 'alambic state dir is inside the vault' }
  const worktree = changes(root, env, ['diff', 'HEAD', '--name-status'])
  const index = changes(root, env, ['diff', '--cached', '--name-status'])
  if (worktree === null || index === null) return { ok: false, reason: 'git diff failed' }
  const dirty = [...index, ...worktree]
  if (dirty.length) return { ok: false, reason: 'tracked tree or index is dirty', paths: [...new Set(dirty.map((item) => item.file))].slice(0, 20) }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', ...COMMIT_PATHS], env)
  if (!untracked.ok) return { ok: false, reason: 'git ls-files failed' }
  if (untracked.out) return { ok: false, reason: 'untracked files in publishable paths', paths: untracked.out.split('\n').slice(0, 20) }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], env).out
  if (!commit) return { ok: true, branch }
  const target = defaultBranch(root, env)
  if (branch !== target) return { ok: false, reason: `not on the default branch (${target})`, branch }
  if (!push) return { ok: true, branch, target }
  const fetched = git(root, ['fetch', '--quiet', 'origin'], env)
  if (!fetched.ok) return { ok: false, reason: `git fetch failed: ${fetched.err}` }
  const head = git(root, ['rev-parse', 'HEAD'], env).out
  const upstream = git(root, ['rev-parse', `origin/${target}`], env).out
  if (head && head !== upstream && head === recordedCommit(root, env) && git(root, ['rev-parse', 'HEAD^'], env).out === upstream) {
    const own = changes(root, env, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', 'HEAD'])
    if (own && own.every(allowedChange)) {
      const reset = resetToUpstream(root, env, head, upstream, branch)
      return reset.ok ? { ok: true, branch, target, head: upstream, resumed: head } : reset
    }
  }
  if (!head || head !== upstream) return { ok: false, reason: `HEAD differs from origin/${target}`, branch }
  return { ok: true, branch, target, head }
}

function step(root, name, command, argv, env) {
  const result = spawnSync(command, argv, { cwd: root, env: { ...env, ALAMBIC_ROOT: root }, encoding: 'utf8', timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  return { name, ok: result.status === 0, status: result.status ?? result.signal, ...(result.status === 0 ? {} : { error: tail(result.stderr || result.stdout) }) }
}
const cliStep = (root, name, argv, env) => step(root, name, process.execPath, [path.join(ENGINE, 'alambic.mjs'), ...argv], env)

function stagePublishable(root, env) {
  const targets = COMMIT_PATHS.filter((item) => fs.existsSync(path.join(root, item)) || git(root, ['ls-files', '--error-unmatch', '--', item], env).ok)
  const staged = git(root, ['add', '-A', '--', ...targets], env)
  if (!staged.ok) return `git add failed: ${staged.err}`
  const deletions = git(root, ['add', '-u', '--', 'docs/inbox'], env)
  return deletions.ok ? null : `git add failed: ${deletions.err}`
}

function withTempIndex(root, env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-index-'))
  const indexEnv = { ...env, GIT_INDEX_FILE: path.join(dir, 'index') }
  try {
    if (!git(root, ['read-tree', 'HEAD'], indexEnv).ok) return { ok: false, reason: 'git read-tree failed' }
    return fn(indexEnv)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function exportTree(root, env, tree, work) {
  const listed = spawnSync('git', ['ls-tree', '-r', '-z', tree], { cwd: root, env, maxBuffer: 1 << 30 })
  if (listed.status !== 0) return false
  const entries = listed.stdout.toString('utf8').split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t')
    const [mode, type, sha] = line.slice(0, tab).split(' ')
    return { mode, type, sha, file: line.slice(tab + 1) }
  }).filter((entry) => entry.type === 'blob')
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: root, env, input: entries.map((entry) => `${entry.sha}\n`).join(''), maxBuffer: 1 << 30 })
  if (batch.status !== 0) return false
  let offset = 0
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(10, offset)
    const [sha, type, size] = batch.stdout.subarray(offset, newline).toString('utf8').split(' ')
    if (sha !== entry.sha || type !== 'blob') return false
    const bytes = batch.stdout.subarray(newline + 1, newline + 1 + Number(size))
    offset = newline + 2 + Number(size)
    const dest = path.join(work, entry.file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (entry.mode === '120000') fs.symlinkSync(bytes.toString('utf8'), dest)
    else fs.writeFileSync(dest, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 })
  }
  return true
}

function withExport(root, env, tree, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-gates-'))
  const work = path.join(dir, 'tree')
  try {
    fs.mkdirSync(work)
    if (!exportTree(root, env, tree, work)) return null
    return fn(work)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function publishableTree(root, env) {
  return withTempIndex(root, env, (indexEnv) => {
    const error = stagePublishable(root, indexEnv)
    if (error) return { ok: false, reason: error }
    const tree = git(root, ['write-tree'], indexEnv)
    return tree.ok ? { ok: true, tree: tree.out } : { ok: false, reason: 'git write-tree failed' }
  })
}

function blobSha(root, env, spec) {
  const result = spawnSync('git', ['cat-file', 'blob', spec], { cwd: root, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? digest(result.stdout) : null
}

function foreignChanges(root, list, journal, env, indexEnv) {
  const chains = readJournal(journal)
  return list.filter(({ status, file }) => {
    const chain = chains.get(path.resolve(root, file))
    if (!chain) return true
    let expected = blobSha(root, env, `HEAD:${file}`)
    for (const entry of chain) {
      if (entry.before !== expected) return true
      expected = entry.after
    }
    return expected !== (status === 'D' ? null : blobSha(root, indexEnv, `:${file}`))
  }).map((item) => item.file)
}

export function seedJournal(root, env, journal, base, resumed) {
  const own = changes(root, env, ['diff-tree', '-r', '--no-renames', '--name-status', base, resumed])
  if (own === null) return false
  for (const { file } of own) journalRecord(path.resolve(root, file), blobSha(root, env, `${base}:${file}`), blobSha(root, env, `${resumed}:${file}`), { ALAMBIC_WRITE_JOURNAL: journal })
  return true
}

function withIndexLock(root, env, fn) {
  const index = gitPath(root, env, 'index')
  if (!index) return { ok: false, reason: 'git rev-parse failed' }
  const held = { index, lock: `${index}.lock`, fd: null, published: false }
  try { held.fd = fs.openSync(held.lock, 'wx', 0o644) } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, reason: 'the git index is locked by another process' }
    throw error
  }
  try {
    return fn(held)
  } finally {
    fs.closeSync(held.fd)
    if (!held.published) fs.rmSync(held.lock, { force: true })
  }
}

function publishIndex(root, env, held, build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-index-'))
  const next = path.join(dir, 'index')
  try {
    if (!build({ ...env, GIT_INDEX_FILE: next }, next)) return false
    writeAll(held.fd, fs.readFileSync(next))
    fs.fsyncSync(held.fd)
    fs.renameSync(held.lock, held.index)
    held.published = true
    return true
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function resetToUpstream(root, env, head, upstream, branch) {
  const readEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' }
  return withIndexLock(root, env, (held) => {
    const indexed = changes(root, readEnv, ['diff', '--cached', '--name-status', '--no-renames'])
    if (indexed === null) return { ok: false, reason: 'git diff failed' }
    if (indexed.length) return { ok: false, reason: 'the index changed during preflight', paths: [...new Set(indexed.map((item) => item.file))].slice(0, 20) }
    const ref = `refs/heads/${branch}`
    if (git(root, ['symbolic-ref', '-q', 'HEAD'], readEnv).out !== ref) return { ok: false, reason: 'the branch changed during preflight' }
    if (!git(root, ['update-ref', '-m', 'reset: resume nightly', ref, upstream, head], readEnv).ok) return { ok: false, reason: 'HEAD moved during preflight' }
    if (!publishIndex(root, readEnv, held, (indexEnv) => git(root, ['read-tree', upstream], indexEnv).ok)) return { ok: false, reason: 'git index reset failed during preflight' }
    return { ok: true }
  })
}

export function nightlyCommit(root, { push, preflight, env, expectedTree = null, journal = null }) {
  const readEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' }
  const preserved = env.ALAMBIC_DISPLACED_DIR ? displacedEdits(env.ALAMBIC_DISPLACED_DIR) : []
  if (preserved.length) return { ok: false, reason: 'concurrent edits were preserved during the run', paths: preserved.slice(0, 20) }
  const committed = withIndexLock(root, env, (held) => {
    const indexed = changes(root, readEnv, ['diff', '--cached', '--name-status', '--no-renames'])
    const tracked = changes(root, readEnv, ['diff', 'HEAD', '--name-status', '--no-renames'])
    if (indexed === null || tracked === null) return { ok: false, reason: 'git diff failed' }
    if (indexed.length) return { ok: false, reason: 'the index changed during the run', paths: [...new Set(indexed.map((item) => item.file))].slice(0, 20) }
    const outside = tracked.filter((item) => !allowedChange(item))
    if (outside.length) return { ok: false, reason: 'changes outside the commit allowlist', paths: [...new Set(outside.map((item) => item.file))].slice(0, 20) }
    const built = withTempIndex(root, readEnv, (indexEnv) => {
      const stageError = stagePublishable(root, indexEnv)
      if (stageError) return { ok: false, reason: stageError }
      const index = changes(root, indexEnv, ['diff', '--cached', '--name-status', '--no-renames'])
      if (index === null) return { ok: false, reason: 'git diff failed' }
      const refused = index.filter((item) => !allowedChange(item))
      if (refused.length) return { ok: false, reason: 'changes outside the commit allowlist', paths: [...new Set(refused.map((item) => item.file))].slice(0, 20) }
      if (journal) {
        const foreign = foreignChanges(root, index, journal, readEnv, indexEnv)
        if (foreign.length) return { ok: false, reason: 'changes not written by this run', paths: foreign.slice(0, 20) }
      }
      const tree = git(root, ['write-tree'], indexEnv)
      if (!tree.ok) return { ok: false, reason: 'git write-tree failed' }
      if (expectedTree && tree.out !== expectedTree) return { ok: false, reason: 'publishable paths changed after the gates ran' }
      return { ok: true, tree: tree.out, files: index.map((item) => item.file) }
    })
    if (!built.ok || !built.files.length) return built.ok ? { ok: true, commit: null, pushed: false } : built
    const ref = `refs/heads/${preflight.branch}`
    if (git(root, ['symbolic-ref', '-q', 'HEAD'], readEnv).out !== ref) return { ok: false, reason: 'the branch changed during the run' }
    const parent = git(root, ['rev-parse', ref], readEnv).out
    const made = git(root, ['commit-tree', built.tree, '-p', parent, '-m', COMMIT_MESSAGE], readEnv)
    if (!made.ok) return { ok: false, reason: `git commit failed: ${made.err}` }
    const commit = made.out
    if (!git(root, ['update-ref', '-m', `commit: ${COMMIT_MESSAGE}`, ref, commit, parent], readEnv).ok) return { ok: false, reason: 'HEAD moved during the run' }
    recordCommit(root, env, commit)
    const refresh = (indexEnv, next) => { fs.copyFileSync(held.index, next); return git(root, ['reset', '-q', '--', ...built.files], indexEnv).ok }
    if (!publishIndex(root, readEnv, held, refresh)) return { ok: false, commit, files: built.files, pushed: false, reason: 'git index update failed after commit' }
    return { ok: true, commit, files: built.files }
  })
  if (!committed.ok || !committed.commit || !push) return committed.ok && committed.commit ? { ...committed, pushed: false } : committed
  const { commit, files } = committed
  const outgoing = git(root, ['rev-list', '--count', `origin/${preflight.target}..${commit}`], env).out
  if (outgoing !== '1') return { ok: false, commit, files, pushed: false, reason: `expected one outgoing commit, found ${outgoing || 'none'}` }
  const pushed = git(root, ['push', '--quiet', 'origin', `${commit}:refs/heads/${preflight.target}`], env)
  if (!pushed.ok) return { ok: false, commit, files, pushed: false, reason: `git push failed: ${pushed.err}` }
  recordCommit(root, env, null)
  return { ok: true, commit, files, pushed: true }
}

export function runNightly(root, { push = false, dryRun = false, env: baseEnv = process.env, distiller = null } = {}) {
  if (stateInsideVault(root)) return { ok: false, dry_run: dryRun, push, steps: [], reason: 'preflight: alambic state dir is inside the vault' }
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-journal-'))
  const journal = path.join(journalDir, 'writes.jsonl')
  const env = { ...baseEnv, ALAMBIC_WRITE_JOURNAL: journal }
  try {
    return nightlyLocked(root, { push, dryRun, env, distiller, journal })
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true })
  }
}

function nightlyLocked(root, { push, dryRun, env: baseEnv, distiller, journal }) {
  const locked = withHarvestLock(null, () => {
    const report = { ok: false, dry_run: dryRun, push, steps: [] }
    const preflight = nightlyPreflight(root, { push: push && !dryRun, commit: !dryRun, env: baseEnv })
    report.preflight = preflight
    if (!preflight.ok) return { ...report, reason: `preflight: ${preflight.reason}` }
    const displaced = gitPath(root, baseEnv, 'alambic-displaced')
    if (!displaced) return { ...report, reason: 'preflight: git rev-parse failed' }
    const kept = displacedEdits(displaced)
    if (kept.length) return { ...report, reason: 'preflight: concurrent edits preserved by an earlier run, resolve and delete them', paths: kept.slice(0, 20) }
    const env = { ...baseEnv, ALAMBIC_DISPLACED_DIR: displaced }
    if (preflight.resumed && !seedJournal(root, env, journal, preflight.head, preflight.resumed)) return { ...report, reason: 'preflight: git diff failed' }
    return runSteps(root, { push, dryRun, env, distiller, journal, report, preflight })
  })
  return locked.locked ? { ok: false, locked: true, reason: 'another harvest or nightly run holds the lock' } : locked
}

function evalGate(root, env, vault) {
  const modules = path.join(vault, 'node_modules')
  if (root !== vault && fs.existsSync(modules)) fs.symlinkSync(modules, path.join(root, 'node_modules'))
  let listed = ''
  try { listed = fs.readFileSync(path.join(root, '_meta/tests/run.sh'), 'utf8') } catch {}
  const suites = [...new Set([...listed.matchAll(/eval --suite ([\w-]+)/g)].map((match) => match[1]))]
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-evals-'))
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TYPESAFE_API_KEY' && !key.startsWith('ALAMBIC_')))
  try {
    const failed = suites.filter((suite) => !cliStep(root, `eval ${suite}`, ['eval', '--suite', suite], { ...isolated, XDG_STATE_HOME: state }).ok)
    return { name: 'evals', ok: !failed.length, suites: suites.length, ...(failed.length ? { error: `failed suites: ${failed.join(', ')}` } : {}) }
  } finally {
    fs.rmSync(state, { recursive: true, force: true })
  }
}

function leakPatterns(root, env) {
  const file = path.resolve(root, env.ALAMBIC_LEAK_PATTERNS_FILE || '.leak-patterns')
  if (!env.ALAMBIC_LEAK_PATTERNS_FILE && !fs.lstatSync(file, { throwIfNoEntry: false })) return { ok: true, file: null }
  try { fs.accessSync(file, fs.constants.R_OK); if (fs.statSync(file).isFile()) return { ok: true, file } } catch {}
  return { ok: false }
}

function runSteps(root, { push, dryRun, env, distiller, journal, report, preflight }) {
  const patterns = leakPatterns(root, env)
  if (!patterns.ok) return { ...report, reason: 'the leak pattern file is configured or present but is not a readable file', commit: null, pushed: false }
  const scan = harvestScan(root, { dryRun, env })
  report.steps.push({ name: 'harvest-scan', ok: scan.ok, queued: scan.queued.length, ...(scan.error ? { error: scan.error } : {}) })
  if (resolveDistiller(distiller, env)) {
    const distilled = harvestDistill(root, { distiller, dryRun, env })
    report.steps.push({ name: 'harvest-distill', ok: distilled.ok, written: distilled.written.length, skipped: distilled.skipped, failed: distilled.failed.length, ...(distilled.failed.length ? { error: distilled.failed[0].error } : {}) })
  } else report.steps.push({ name: 'harvest-distill', ok: true, skipped_reason: 'no distiller' })
  if (env.TYPESAFE_API_KEY && !dryRun) report.steps.push(cliStep(root, 'enrich', ['enrich', '--apply', '--max', '40', '--json'], env))
  else report.steps.push({ name: 'enrich', ok: true, skipped_reason: dryRun ? 'dry-run' : 'no TYPESAFE_API_KEY' })
  report.steps.push(cliStep(root, 'sidekick', ['sidekick', 'run', ...(dryRun ? ['--dry-run'] : ['--apply-all', '--max-freeform', '3']), '--max', '12', '--json'], env))
  const snapshot = dryRun ? null : publishableTree(root, env)
  if (snapshot && !snapshot.ok) return { ...report, reason: snapshot.reason, commit: null, pushed: false }
  const gateEnv = { ...env, ...(patterns.file ? { ALAMBIC_LEAK_PATTERNS_FILE: patterns.file } : {}) }
  const gates = (gateRoot) => [
    cliStep(gateRoot, 'validate', ['validate', '--mode', 'strict'], gateEnv),
    cliStep(gateRoot, 'lint', ['lint', '--check'], gateEnv),
    step(gateRoot, 'leak-scan', '/bin/bash', [path.join(ENGINE, 'tests/leak-scan.sh'), gateRoot], gateEnv),
    evalGate(gateRoot, gateEnv, root),
  ]
  const checked = snapshot ? withExport(root, env, snapshot.tree, gates) : gates(root)
  if (!checked) return { ...report, reason: 'could not export the snapshot for the gates', commit: null, pushed: false }
  report.steps.push(...checked)
  const red = report.steps.filter((step) => !step.ok).map((step) => step.name)
  if (red.length) return { ...report, reason: `red gates: ${red.join(', ')}`, commit: null, pushed: false }
  if (dryRun) return { ...report, ok: true, commit: null, pushed: false }
  const result = nightlyCommit(root, { push, preflight, env, expectedTree: snapshot.tree, journal })
  return { ...report, ...result }
}
