#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-harvest-'))
const vault = path.join(temp, 'vault')
const home = path.join(temp, 'home')
const state = path.join(temp, 'state')
const env = { ...process.env, HOME: home, ALAMBIC_ROOT: vault, ALAMBIC_STATE_DIR: state, TYPESAFE_API_KEY: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', PI_CODING_AGENT_DIR: '', ALAMBIC_HARVEST_DISTILLER: '' }
const cli = (argv, extra = {}) => spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), ...argv], { encoding: 'utf8', env: { ...env, ...extra } })
const json = (result) => { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout) }
const failedJson = (result) => { assert.equal(result.status, 1, result.stderr || result.stdout); return JSON.parse(result.stdout) }
const listQueue = () => { try { return fs.readdirSync(path.join(state, 'harvest/queue')).map((name) => ({ name, entry: JSON.parse(fs.readFileSync(path.join(state, 'harvest/queue', name), 'utf8')) })) } catch { return [] } }
const old = (file) => { const past = new Date(Date.now() - 60 * 60 * 1000); fs.utimesSync(file, past, past) }
const rich = 'We decided to keep the cursor in state because the root cause was _meta/lib/vault.mjs:42 and _meta/alambic.mjs:10. The fix passes and validated green. Decision: convention is lowercase tags.'
const richer = `${rich} Also _meta/lib/harvest.mjs:5 and _meta/lib/sidekick.mjs:9 confirm it.`
const secret = `token sk-${'a'.repeat(30)} leaked`

try {
  fs.mkdirSync(path.join(vault, 'kb'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'ref'), { recursive: true })
  fs.mkdirSync(path.join(vault, '_meta/prompts'), { recursive: true })
  fs.copyFileSync(path.join(root, '_meta/prompts/harvest-distill.md'), path.join(vault, '_meta/prompts/harvest-distill.md'))
  fs.writeFileSync(path.join(vault, 'kb/_index.md'), '---\ntype: reference\nstatus: verified\nupdated: 2026-01-01\ntags:\n  - index\n---\n\n# Index\n')

  const claudeDir = path.join(home, '.claude/projects/-work-repo')
  fs.mkdirSync(claudeDir, { recursive: true })
  const claudeFile = path.join(claudeDir, 'c1.jsonl')
  fs.writeFileSync(claudeFile, [
    { type: 'user', sessionId: 'claude-s1', cwd: '/work/repo', message: { role: 'user', content: 'Why does the lexical cache break? fix it please' } },
    { type: 'user', isMeta: true, sessionId: 'claude-s1', message: { role: 'user', content: 'META SHOULD NOT APPEAR' } },
    { type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: rich }, { type: 'tool_use', name: 'Bash', input: { command: 'TOOL SHOULD NOT APPEAR' } }] } },
    { type: 'assistant', isSidechain: true, sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN SHOULD NOT APPEAR' }] } },
    { type: 'user', sessionId: 'claude-s1', message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL RESULT SHOULD NOT APPEAR' }] } },
    { type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: secret }] } },
    { type: 'user', sessionId: 'claude-s1', message: { role: 'user', content: 'ok decided, thanks, that fix works now' } },
  ].map((line) => JSON.stringify(line)).join('\n'))
  old(claudeFile)

  const codexDir = path.join(home, '.codex/sessions/2026/09/23')
  fs.mkdirSync(codexDir, { recursive: true })
  const codexFile = path.join(codexDir, 'rollout-x.jsonl')
  fs.writeFileSync(codexFile, [
    { type: 'session_meta', payload: { session_id: 'codex-s1', cwd: '/work/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEVELOPER SHOULD NOT APPEAR' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>INJECTED SHOULD NOT APPEAR</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'decide the retry rule and fix the flaky test' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: rich }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'validated, green' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'))
  old(codexFile)

  const piDir = path.join(home, '.pi/agent/sessions/--work-repo--')
  fs.mkdirSync(piDir, { recursive: true })
  const piFile = path.join(piDir, '2026_p1.jsonl')
  fs.writeFileSync(piFile, [
    { type: 'session', id: 'pi-s1', cwd: '/work/repo' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'))
  old(piFile)

  const recentFile = path.join(claudeDir, 'recent.jsonl')
  fs.writeFileSync(recentFile, fs.readFileSync(claudeFile))

  const dry = json(cli(['harvest', 'scan', '--dry-run']))
  assert.equal(dry.queued.length, 2, JSON.stringify(dry))
  assert.equal(dry.skipped_recent, 1)
  assert.equal(fs.existsSync(path.join(state, 'harvest/queue')), false, 'dry-run must not write the queue')

  const scan = json(cli(['harvest', 'scan']))
  assert.deepEqual(scan.queued.map((item) => item.source_ref).sort(), ['claude:claude-s1', 'codex:codex-s1'])
  assert.equal(scan.below, 1, 'low-signal pi session stays below the threshold')
  assert.equal(scan.dropped_unsafe >= 1, true)
  const queued = JSON.parse(fs.readFileSync(path.join(state, 'harvest/queue/claude-claude-s1-m0.json'), 'utf8'))
  assert.equal(queued.trust, 'untrusted-session-data')
  assert.equal((fs.statSync(path.join(state, 'harvest/queue/claude-claude-s1-m0.json')).mode & 0o777), 0o600)
  for (const marker of ['META', 'SIDECHAIN', 'TOOL', 'sk-', 'INJECTED', 'DEVELOPER']) assert.equal(queued.excerpt.includes(marker), false, `${marker} leaked into the excerpt`)
  assert.ok(queued.excerpt.length <= 6000)
  assert.equal(fs.readdirSync(vault).includes('docs'), false, 'scan never writes inside the vault')

  const again = json(cli(['harvest', 'scan']))
  assert.equal(again.scanned, 0, 'cursor skips unchanged files')

  const hook = json(cli(['harvest', 'scan', '--session', recentFile]))
  assert.equal(hook.queued.length, 1, '--session bypasses the quiet window')
  fs.rmSync(path.join(state, 'harvest/queue', 'claude-claude-s1-m0.json'))
  const outside = cli(['harvest', 'scan', '--session', path.join(temp, 'nowhere.jsonl')])
  assert.notEqual(outside.status, 0, 'a session outside harness roots is refused')
  const linked = path.join(claudeDir, 'linked.jsonl')
  fs.symlinkSync(claudeFile, linked)
  assert.notEqual(cli(['harvest', 'scan', '--session', linked]).status, 0, 'a symlinked session is refused')
  const escape = path.join(temp, 'escape.jsonl')
  fs.writeFileSync(escape, fs.readFileSync(claudeFile))
  fs.symlinkSync(temp, path.join(claudeDir, 'up'))
  assert.notEqual(cli(['harvest', 'scan', '--session', path.join(claudeDir, 'up', 'escape.jsonl')]).status, 0, 'a path escaping through a symlinked dir is refused')
  const fifo = path.join(claudeDir, 'fifo.jsonl')
  spawnSync('mkfifo', [fifo])
  assert.notEqual(cli(['harvest', 'scan', '--session', fifo]).status, 0, 'a FIFO is refused')
  const renamed = path.join(claudeDir, 'session.txt')
  fs.copyFileSync(claudeFile, renamed)
  assert.notEqual(cli(['harvest', 'scan', '--session', renamed]).status, 0, 'a non-jsonl session is refused')
  for (const file of [linked, fifo, renamed, path.join(claudeDir, 'up')]) fs.rmSync(file)

  const fake = path.join(temp, 'fake-distiller.sh')
  const answer = { type: 'finding', title: 'Lexical cache keeps raw fields', summary: 'The lexical cache must store raw and sources or queries crash on stale entries.', tags: ['retrieval', 'Cache!'], sources: ['https://docs.example.org/cache', 'file:///etc/passwd'], body: `${'Evidence and context for the cache fix. '.repeat(8)}`, reviewed_by: 'human:fake', status: 'verified' }
  fs.writeFileSync(fake, `#!/bin/sh\ncat > "${temp}/prompt.txt"\nprintf '%s' '${JSON.stringify(answer)}'\n`, { mode: 0o755 })
  const distilled = json(cli(['harvest', 'distill', '--distiller', fake]))
  assert.equal(distilled.written.length, 1, JSON.stringify(distilled))
  const note = fs.readFileSync(path.join(vault, distilled.written[0].path), 'utf8')
  assert.match(distilled.written[0].path, /^docs\/inbox\/ai\/harvest-\d{4}-\d{2}-\d{2}-codex-codex-s1\.md$/)
  assert.match(note, /^status: draft$/m)
  assert.match(note, /^origin: session-harvest$/m)
  assert.match(note, /^trust: untrusted-session-data$/m)
  assert.match(note, /"codex:codex-s1"/)
  assert.equal(/reviewed_by|file:\/\/|Cache!/.test(note), false, 'model cannot set review fields, non-https sources or bad tags')
  const prompt = fs.readFileSync(path.join(temp, 'prompt.txt'), 'utf8')
  assert.match(prompt, /untrusted data/)
  assert.equal(fs.existsSync(path.join(state, 'harvest/processed/codex-codex-s1-m0.json')), true)

  fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho SKIP\n', { mode: 0o755 })
  fs.appendFileSync(claudeFile, `\n${JSON.stringify({ type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: richer }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', claudeFile])).queued.length, 1)
  const skipped = json(cli(['harvest', 'distill', '--distiller', fake]))
  assert.deepEqual([skipped.written.length, skipped.skipped], [0, 1], JSON.stringify(skipped))

  fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ ...answer, body: `${answer.body} sk-${'b'.repeat(30)}` })}'\n`, { mode: 0o755 })
  fs.appendFileSync(claudeFile, `\n${JSON.stringify({ type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: richer }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', claudeFile])).queued.length, 1)
  const unsafe = failedJson(cli(['harvest', 'distill', '--distiller', fake]))
  assert.equal(unsafe.failed.length, 1, 'unsafe distiller output is refused')
  assert.equal(unsafe.ok, false)
  const retry = listQueue()
  assert.equal(retry.length, 1, 'a failed candidate stays queued for retry')
  assert.equal(retry[0].entry.attempts, 1)
  cli(['harvest', 'distill', '--distiller', fake])
  assert.equal(failedJson(cli(['harvest', 'distill', '--distiller', fake])).failed[0].attempts, 3)
  assert.equal(listQueue().length, 0, 'a candidate is retired after three failed attempts')
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'harvest/processed', retry[0].name), 'utf8')).status, 'distill_failed')

  fs.appendFileSync(codexFile, `\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: richer }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', codexFile])).queued.length, 1)
  assert.notEqual(cli(['harvest', 'digest', '--out', path.join(vault, 'kb/raw-session.json')]).status, 0, 'a digest inside the vault is refused')
  assert.equal(fs.existsSync(path.join(vault, 'kb/raw-session.json')), false)
  const digestFile = path.join(temp, 'digest.json')
  const digest = json(cli(['harvest', 'digest', '--out', digestFile]))
  assert.equal(digest.count, 1)
  const digestData = JSON.parse(fs.readFileSync(digestFile, 'utf8'))
  assert.equal(digestData.trust, 'untrusted-session-data')
  assert.notEqual(cli(['harvest', 'ack', '--digest', digestFile, '--bogus']).status, 0)
  assert.equal(listQueue().length, 1, 'an usage error leaves the queue intact')
  assert.equal(json(cli(['harvest', 'ack', '--digest', digestFile])).acked, 1)
  assert.equal(json(cli(['harvest', 'ack', '--digest', digestFile])).acked, 0, 'ack is idempotent')

  const status = json(cli(['harvest', 'status']))
  assert.equal(status.queue, 0)
  assert.deepEqual(status.pending_review, [distilled.written[0].path])
  assert.equal(status.review_acceptance_rate, null)
  assert.equal(status.metrics.acked, 1)
  assert.ok(status.metrics.scanned >= 2 && status.metrics.queued >= 2)

  const child = spawnSync(process.execPath, [path.join(root, '_meta/hooks/harvest-hook.mjs')], { input: JSON.stringify({ transcript_path: claudeFile }), encoding: 'utf8', env: { ...env, ALAMBIC_HARVEST_CHILD: '1' } })
  assert.equal(child.status, 0)
  assert.equal(listQueue().length, 0, 'the child guard skips the scan')

  const inVault = cli(['harvest', 'scan', '--session', claudeFile], { ALAMBIC_STATE_DIR: path.join(vault, 'kb/runtime') })
  assert.notEqual(inVault.status, 0, 'a state dir inside the vault is refused')
  assert.equal(fs.existsSync(path.join(vault, 'kb/runtime')), false)

  fs.appendFileSync(claudeFile, `\n${JSON.stringify({ type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: richer }] } })}`)
  const started = Date.now()
  const hooked = spawnSync(process.execPath, [path.join(root, '_meta/hooks/harvest-hook.mjs')], { input: JSON.stringify({ transcript_path: claudeFile }), encoding: 'utf8', env })
  assert.equal(hooked.status, 0)
  assert.ok(Date.now() - started < 5000, 'the hook returns without waiting for the scan')
  for (let index = 0; index < 100 && !listQueue().length; index += 1) spawnSync('sleep', ['0.1'])
  assert.equal(listQueue().length, 1, 'the detached scan queues the ended session')
  console.log('harvest: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
