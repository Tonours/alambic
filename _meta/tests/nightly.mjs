#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-nightly-')))
const vault = path.join(temp, 'vault')
const remote = path.join(temp, 'remote.git')
const home = path.join(temp, 'home')
const state = path.join(temp, 'state')
const gitconfig = path.join(temp, 'gitconfig')
const fake = path.join(temp, 'fake-distiller.sh')
const env = { ...process.env, HOME: home, ALAMBIC_ROOT: vault, ALAMBIC_STATE_DIR: state, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', ALAMBIC_HARVEST_DISTILLER: fake }
for (const key of ['TYPESAFE_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'XDG_STATE_HOME']) delete env[key]
Object.assign(process.env, env)
for (const key of ['TYPESAFE_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'XDG_STATE_HOME']) delete process.env[key]
const cliPath = path.join(root, '_meta/alambic.mjs')
const cli = (argv) => spawnSync(process.execPath, [cliPath, ...argv], { cwd: vault, encoding: 'utf8', env, timeout: 300_000 })
const git = (argv, cwd = vault) => {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', env })
  assert.equal(result.status, 0, `git ${argv.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const nightly = (argv = ['--push']) => {
  const result = cli(['nightly', ...argv, '--json'])
  try { return { status: result.status, ...JSON.parse(result.stdout) } } catch { assert.fail(`nightly output is not JSON: ${result.stdout}${result.stderr}`) }
}
const remoteCount = () => Number(git(['rev-list', '--count', 'main'], remote))
const rich = 'We decided the lexical cache keeps raw fields because the root cause was _meta/lib/vault.mjs:42 and _meta/alambic.mjs:10. The fix passes and validated green. Decision: convention is lowercase tags. Also _meta/lib/harvest.mjs:5 confirms it.'
const writeSession = (name, id) => {
  const dir = path.join(home, '.claude/projects/-work-repo')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, [
    { type: 'user', sessionId: id, cwd: '/work/repo', message: { role: 'user', content: 'Why does the lexical cache break? fix it please' } },
    { type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: rich }] } },
    { type: 'user', sessionId: id, message: { role: 'user', content: 'ok decided, thanks, that fix works now' } },
  ].map((line) => JSON.stringify(line)).join('\n'))
  const past = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(file, past, past)
}
const answer = { type: 'finding', title: 'Zyxwv quorble cache keeps raw fields', summary: 'The zyxwv quorble cache must store raw fields and sources or queries crash on stale entries.', tags: ['retrieval'], sources: ['https://docs.example.org/quorble-cache'], body: 'The zyxwv quorble cache must keep raw fields and sources because stale entries crash queries after an upgrade. Rebuild the cache when the format version changes. The rebuild runs on the next query and takes a few seconds on a large vault, so schedule it after upgrades.' }

try {
  fs.writeFileSync(gitconfig, '[user]\n\tname = nightly-test\n\temail = nightly@example.invalid\n[init]\n\tdefaultBranch = main\n')
  const init = spawnSync(process.execPath, [cliPath, 'init', vault], { encoding: 'utf8', env: { ...env, ALAMBIC_ROOT: '' } })
  assert.equal(init.status, 0, init.stderr)
  git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  git(['init', '-q', '--bare', remote], temp)
  git(['remote', 'add', 'origin', remote])
  git(['push', '-q', 'origin', 'main'])
  git(['remote', 'set-head', 'origin', 'main'])
  fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(answer)}'\n`, { mode: 0o755 })

  const dry = nightly(['--dry-run'])
  assert.equal(dry.ok, true, JSON.stringify(dry))
  assert.equal(dry.commit, null)
  let warm = nightly()
  for (let index = 0; index < 10 && warm.ok && warm.commit; index += 1) warm = nightly()
  assert.equal(warm.ok, true, JSON.stringify(warm))
  assert.equal(warm.commit, null, 'heals converge within ten runs')
  assert.equal(nightly().commit, null, 'a run with no input is idempotent')
  const base = remoteCount()

  writeSession('s1.jsonl', 'claude-s1')
  const first = nightly()
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.commit, null, 'a pending session note never commits')
  assert.equal(remoteCount(), base)
  const inboxDir = path.join(vault, 'docs/inbox/ai')
  const pending = fs.readdirSync(inboxDir).filter((name) => name.startsWith('harvest-'))
  assert.equal(pending.length, 1, JSON.stringify(first.steps))
  assert.equal(git(['status', '--porcelain']), '', 'harvest staging stays gitignored')
  const note = `docs/inbox/ai/${pending[0]}`

  const accepted = spawnSync('python3', ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, cliPath, 'review', '--inbox', note, '--decision', 'accept', '--reason', 'checked the cache rule'], { encoding: 'utf8', input: '', env })
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)

  const second = nightly()
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.ok(second.commit, `accepted note is committed: ${JSON.stringify(second)}`)
  assert.equal(second.pushed, true)
  assert.ok(second.files.every((file) => file.startsWith('kb/')), second.files.join(','))
  assert.equal(remoteCount(), base + 1)
  assert.equal(git(['rev-parse', 'main'], remote), git(['rev-parse', 'HEAD']))
  assert.equal(git(['log', '-1', '--format=%s']), 'chore(sidekick): nightly heals')
  const promoted = second.files.find((file) => file !== 'kb/_index.md')
  assert.match(fs.readFileSync(path.join(vault, promoted), 'utf8'), /^reviewed_by: human:alambic-review$/m)
  assert.equal(fs.existsSync(path.join(vault, note)), false)

  const kbBefore = fs.readdirSync(path.join(vault, 'kb')).sort()
  writeSession('s2.jsonl', 'claude-s2')
  const replay = nightly()
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.commit, null, 'a replayed session is a noop')
  assert.equal(remoteCount(), base + 1)
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb')).sort(), kbBefore)
  assert.ok(fs.readdirSync(path.join(inboxDir, 'processed')).some((name) => name.startsWith('noop-harvest-')))

  fs.writeFileSync(path.join(vault, 'kb/broken-note.md'), 'no frontmatter\n')
  git(['add', 'kb/broken-note.md'])
  git(['commit', '-q', '-m', 'broken'])
  git(['push', '-q', 'origin', 'main'])
  const red = nightly()
  assert.equal(red.ok, false)
  assert.match(red.reason, /red gates: .*validate/)
  assert.equal(red.commit, null)
  assert.equal(remoteCount(), base + 2)
  git(['rm', '-q', 'kb/broken-note.md'])
  git(['commit', '-q', '-m', 'unbroken'])
  git(['push', '-q', 'origin', 'main'])

  fs.appendFileSync(path.join(vault, 'README.md'), '\nlocal edit\n')
  const dirty = nightly()
  assert.match(dirty.reason, /preflight: tracked tree or index is dirty/)
  git(['checkout', '--', 'README.md'])

  const readme = fs.readFileSync(path.join(vault, 'README.md'), 'utf8')
  fs.appendFileSync(path.join(vault, 'README.md'), '\nstaged edit\n')
  git(['add', 'README.md'])
  fs.writeFileSync(path.join(vault, 'README.md'), readme)
  assert.match(nightly().reason, /preflight: tracked tree or index is dirty/, 'an index-only change is dirty')
  git(['reset', '-q'])

  fs.writeFileSync(path.join(vault, 'kb/session.jsonl'), '{"role":"user"}\n')
  const untracked = nightly()
  assert.match(untracked.reason, /preflight: untracked files in publishable paths/)
  assert.deepEqual(untracked.preflight.paths, ['kb/session.jsonl'])
  fs.rmSync(path.join(vault, 'kb/session.jsonl'))

  git(['checkout', '-q', '-b', 'side'])
  assert.match(nightly().reason, /preflight: not on the default branch/)
  assert.match(nightly([]).reason, /preflight: not on the default branch/, 'a local commit run checks the branch too')
  assert.equal(nightly(['--dry-run']).ok, true, 'a dry run works on any branch')
  git(['checkout', '-q', 'main'])

  const { nightlyCommit, nightlyPreflight } = await import(path.join(root, '_meta/lib/nightly.mjs'))
  const preflight = nightlyPreflight(vault, { push: true, env })
  assert.equal(preflight.ok, true, JSON.stringify(preflight))
  fs.writeFileSync(path.join(vault, 'kb/extra-note.md'), fs.readFileSync(path.join(vault, promoted), 'utf8').replace(/^# .*$/m, '# Extra note'))
  fs.appendFileSync(path.join(vault, 'package.json'), '\n')
  const refused = nightlyCommit(vault, { push: true, preflight, env })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /outside the commit allowlist/)
  assert.deepEqual(refused.paths, ['package.json'])
  assert.equal(git(['diff', '--cached', '--name-only']), '', 'refused commit leaves nothing staged')
  git(['checkout', '--', 'package.json'])
  fs.rmSync(path.join(vault, 'kb/extra-note.md'))

  const stuckNote = path.join(vault, 'kb', path.basename(promoted))
  fs.appendFileSync(stuckNote, '\nLocal nightly commit that never reached the remote.\n')
  git(['add', 'kb'])
  git(['commit', '-q', '-m', 'chore(sidekick): nightly heals'])
  const before = remoteCount()
  const resumed = nightly()
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.ok(resumed.preflight.resumed, 'an unpushed nightly commit is resumed')
  assert.equal(resumed.pushed, true)
  assert.equal(remoteCount(), before + 1)
  git(['commit', '-q', '--allow-empty', '-m', 'someone else'])
  assert.match(nightly().reason, /HEAD differs from origin/, 'a foreign local commit is not resumed')
  git(['reset', '-q', '--hard', 'HEAD^'])

  const inVault = nightly(['--push'])
  assert.equal(inVault.ok, true)
  const insideEnv = spawnSync(process.execPath, [cliPath, 'nightly', '--dry-run', '--json'], { cwd: vault, encoding: 'utf8', env: { ...env, ALAMBIC_STATE_DIR: path.join(vault, 'kb/state') } })
  assert.match(JSON.parse(insideEnv.stdout).reason, /state dir is inside the vault/)

  fs.mkdirSync(path.join(state, 'harvest/lock'), { recursive: true })
  const locked = nightly()
  assert.equal(locked.locked, true)
  fs.rmSync(path.join(state, 'harvest/lock'), { recursive: true })
  console.log('nightly: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
