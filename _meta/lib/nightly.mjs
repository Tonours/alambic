import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { harvestDistill, harvestScan, resolveDistiller, stateInsideVault, withHarvestLock } from './harvest.mjs'
import { fileSha, journalWrite, readJournal } from './write-journal.mjs'

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
  if (head && head !== upstream && git(root, ['rev-parse', 'HEAD^'], env).out === upstream && git(root, ['log', '-1', '--format=%s'], env).out === COMMIT_MESSAGE) {
    const own = changes(root, env, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', 'HEAD'])
    if (own && own.every(allowedChange) && git(root, ['reset', '-q', upstream], env).ok) return { ok: true, branch, target, head: upstream, resumed: head }
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

export function publishableTree(root, env) {
  return withTempIndex(root, env, (indexEnv) => {
    const error = stagePublishable(root, indexEnv)
    if (error) return { ok: false, reason: error }
    const tree = git(root, ['write-tree'], indexEnv)
    return tree.ok ? { ok: true, tree: tree.out } : { ok: false, reason: 'git write-tree failed' }
  })
}

function foreignChanges(root, list, journal) {
  const written = readJournal(journal)
  return list.filter(({ status, file }) => {
    const absolute = path.resolve(root, file)
    if (!written.has(absolute)) return true
    return status === 'D' ? written.get(absolute) !== null : written.get(absolute) !== fileSha(absolute)
  }).map((item) => item.file)
}

export function seedJournal(root, env, journal) {
  const pending = changes(root, env, ['diff', 'HEAD', '--name-status', '--no-renames'])
  if (pending === null) return false
  for (const { file } of pending) {
    const absolute = path.resolve(root, file)
    const content = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null
    journalWrite(absolute, content, { ALAMBIC_WRITE_JOURNAL: journal })
  }
  return true
}

export function nightlyCommit(root, { push, preflight, env, expectedTree = null, journal = null }) {
  const indexed = changes(root, env, ['diff', '--cached', '--name-status', '--no-renames'])
  const tracked = changes(root, env, ['diff', 'HEAD', '--name-status', '--no-renames'])
  if (indexed === null || tracked === null) return { ok: false, reason: 'git diff failed' }
  if (indexed.length) return { ok: false, reason: 'the index changed during the run', paths: [...new Set(indexed.map((item) => item.file))].slice(0, 20) }
  const outside = tracked.filter((item) => !allowedChange(item))
  if (outside.length) return { ok: false, reason: 'changes outside the commit allowlist', paths: [...new Set(outside.map((item) => item.file))].slice(0, 20) }
  const built = withTempIndex(root, env, (indexEnv) => {
    const stageError = stagePublishable(root, indexEnv)
    if (stageError) return { ok: false, reason: stageError }
    const index = changes(root, indexEnv, ['diff', '--cached', '--name-status', '--no-renames'])
    if (index === null) return { ok: false, reason: 'git diff failed' }
    const refused = index.filter((item) => !allowedChange(item))
    if (refused.length) return { ok: false, reason: 'changes outside the commit allowlist', paths: [...new Set(refused.map((item) => item.file))].slice(0, 20) }
    if (journal) {
      const foreign = foreignChanges(root, index, journal)
      if (foreign.length) return { ok: false, reason: 'changes not written by this run', paths: foreign.slice(0, 20) }
    }
    const tree = git(root, ['write-tree'], indexEnv)
    if (!tree.ok) return { ok: false, reason: 'git write-tree failed' }
    if (expectedTree && tree.out !== expectedTree) return { ok: false, reason: 'publishable paths changed after the gates ran' }
    return { ok: true, tree: tree.out, files: index.map((item) => item.file) }
  })
  if (!built.ok) return built
  if (!built.files.length) return { ok: true, commit: null, pushed: false }
  const parent = git(root, ['rev-parse', 'HEAD'], env).out
  const made = git(root, ['commit-tree', built.tree, '-p', parent, '-m', COMMIT_MESSAGE], env)
  if (!made.ok) return { ok: false, reason: `git commit failed: ${made.err}` }
  const commit = made.out
  if (!git(root, ['update-ref', '-m', `commit: ${COMMIT_MESSAGE}`, 'HEAD', commit, parent], env).ok) return { ok: false, reason: 'HEAD moved during the run' }
  git(root, ['reset', '-q', '--', ...built.files], env)
  const files = built.files
  if (!push) return { ok: true, commit, files, pushed: false }
  const outgoing = git(root, ['rev-list', '--count', `origin/${preflight.target}..${commit}`], env).out
  if (outgoing !== '1') return { ok: false, commit, files, pushed: false, reason: `expected one outgoing commit, found ${outgoing || 'none'}` }
  const pushed = git(root, ['push', '--quiet', 'origin', `${commit}:refs/heads/${preflight.target}`], env)
  if (!pushed.ok) return { ok: false, commit, files, pushed: false, reason: `git push failed: ${pushed.err}` }
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

function nightlyLocked(root, { push, dryRun, env, distiller, journal }) {
  const locked = withHarvestLock(null, () => {
    const report = { ok: false, dry_run: dryRun, push, steps: [] }
    const preflight = nightlyPreflight(root, { push: push && !dryRun, commit: !dryRun, env })
    report.preflight = preflight
    if (!preflight.ok) return { ...report, reason: `preflight: ${preflight.reason}` }
    if (preflight.resumed && !seedJournal(root, env, journal)) return { ...report, reason: 'preflight: git diff failed' }
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
    report.steps.push(cliStep(root, 'validate', ['validate', '--mode', 'strict'], env))
    report.steps.push(cliStep(root, 'lint', ['lint', '--check'], env))
    report.steps.push(step(root, 'leak-scan', '/bin/bash', [path.join(ENGINE, 'tests/leak-scan.sh'), root], env))
    const red = report.steps.filter((step) => !step.ok).map((step) => step.name)
    if (red.length) return { ...report, reason: `red gates: ${red.join(', ')}`, commit: null, pushed: false }
    if (dryRun) return { ...report, ok: true, commit: null, pushed: false }
    const result = nightlyCommit(root, { push, preflight, env, expectedTree: snapshot.tree, journal })
    return { ...report, ...result }
  })
  return locked.locked ? { ok: false, locked: true, reason: 'another harvest or nightly run holds the lock' } : locked
}
