import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { harvestDistill, harvestScan, resolveDistiller, stateInsideVault, withHarvestLock } from './harvest.mjs'

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT_PATHS = ['kb', 'ref', '_meta/enrich-ledger.json']
const COMMIT_MESSAGE = 'chore(sidekick): nightly heals'
const STEP_TIMEOUT_MS = 20 * 60 * 1000

const allowedChange = ({ status, file }) => file.startsWith('kb/') || file.startsWith('ref/') || file === '_meta/enrich-ledger.json' || (status === 'D' && file.startsWith('docs/inbox/'))
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

export function nightlyCommit(root, { push, preflight, env }) {
  const targets = COMMIT_PATHS.filter((item) => fs.existsSync(path.join(root, item)) || git(root, ['ls-files', '--error-unmatch', '--', item], env).ok)
  const staged = git(root, ['add', '-A', '--', ...targets], env)
  if (!staged.ok) return { ok: false, reason: `git add failed: ${staged.err}` }
  const deletions = git(root, ['add', '-u', '--', 'docs/inbox'], env)
  if (!deletions.ok) return { ok: false, reason: `git add failed: ${deletions.err}` }
  const index = changes(root, env, ['diff', '--cached', '--name-status', '--no-renames'])
  const pending = changes(root, env, ['diff', '--name-status', '--no-renames'])
  if (index === null || pending === null) return { ok: false, reason: 'git diff failed' }
  const refused = [...index, ...pending].filter((item) => !allowedChange(item))
  if (refused.length) {
    git(root, ['reset', '-q'], env)
    return { ok: false, reason: 'changes outside the commit allowlist', paths: [...new Set(refused.map((item) => item.file))].slice(0, 20) }
  }
  if (!index.length) return { ok: true, commit: null, pushed: false }
  const committed = git(root, ['commit', '-q', '--no-verify', '-m', COMMIT_MESSAGE], env)
  if (!committed.ok) {
    git(root, ['reset', '-q'], env)
    return { ok: false, reason: `git commit failed: ${committed.err}` }
  }
  const commit = git(root, ['rev-parse', 'HEAD'], env).out
  const committedChanges = changes(root, env, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', 'HEAD'])
  if (!committedChanges || !committedChanges.every(allowedChange)) {
    git(root, ['reset', '-q', '--soft', 'HEAD^'], env)
    git(root, ['reset', '-q'], env)
    return { ok: false, reason: 'commit changed outside the allowlist during the run', paths: (committedChanges || []).filter((item) => !allowedChange(item)).map((item) => item.file).slice(0, 20) }
  }
  const files = committedChanges.map((item) => item.file)
  if (!push) return { ok: true, commit, files, pushed: false }
  const outgoing = git(root, ['rev-list', '--count', `origin/${preflight.target}..HEAD`], env).out
  if (outgoing !== '1') return { ok: false, commit, files, pushed: false, reason: `expected one outgoing commit, found ${outgoing || 'none'}` }
  const pushed = git(root, ['push', '--quiet', 'origin', `HEAD:${preflight.target}`], env)
  if (!pushed.ok) return { ok: false, commit, files, pushed: false, reason: `git push failed: ${pushed.err}` }
  return { ok: true, commit, files, pushed: true }
}

export function runNightly(root, { push = false, dryRun = false, env = process.env, distiller = null } = {}) {
  if (stateInsideVault(root)) return { ok: false, dry_run: dryRun, push, steps: [], reason: 'preflight: alambic state dir is inside the vault' }
  const locked = withHarvestLock(null, () => {
    const report = { ok: false, dry_run: dryRun, push, steps: [] }
    const preflight = nightlyPreflight(root, { push: push && !dryRun, commit: !dryRun, env })
    report.preflight = preflight
    if (!preflight.ok) return { ...report, reason: `preflight: ${preflight.reason}` }
    const scan = harvestScan(root, { dryRun, env })
    report.steps.push({ name: 'harvest-scan', ok: scan.ok, queued: scan.queued.length, ...(scan.error ? { error: scan.error } : {}) })
    if (resolveDistiller(distiller, env)) {
      const distilled = harvestDistill(root, { distiller, dryRun, env })
      report.steps.push({ name: 'harvest-distill', ok: distilled.ok, written: distilled.written.length, skipped: distilled.skipped, failed: distilled.failed.length, ...(distilled.failed.length ? { error: distilled.failed[0].error } : {}) })
    } else report.steps.push({ name: 'harvest-distill', ok: true, skipped_reason: 'no distiller' })
    if (env.TYPESAFE_API_KEY && !dryRun) report.steps.push(cliStep(root, 'enrich', ['enrich', '--apply', '--max', '40', '--json'], env))
    else report.steps.push({ name: 'enrich', ok: true, skipped_reason: dryRun ? 'dry-run' : 'no TYPESAFE_API_KEY' })
    report.steps.push(cliStep(root, 'sidekick', ['sidekick', 'run', ...(dryRun ? ['--dry-run'] : ['--apply-all', '--max-freeform', '3']), '--max', '12', '--json'], env))
    report.steps.push(cliStep(root, 'validate', ['validate', '--mode', 'strict'], env))
    report.steps.push(cliStep(root, 'lint', ['lint', '--check'], env))
    report.steps.push(step(root, 'leak-scan', '/bin/bash', [path.join(ENGINE, 'tests/leak-scan.sh'), root], env))
    const red = report.steps.filter((step) => !step.ok).map((step) => step.name)
    if (red.length) return { ...report, reason: `red gates: ${red.join(', ')}`, commit: null, pushed: false }
    if (dryRun) return { ...report, ok: true, commit: null, pushed: false }
    const result = nightlyCommit(root, { push, preflight, env })
    return { ...report, ...result }
  })
  return locked.locked ? { ok: false, locked: true, reason: 'another harvest or nightly run holds the lock' } : locked
}
