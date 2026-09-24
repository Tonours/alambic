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

  const pendingBefore = fs.readFileSync(path.join(state, 'harvest/queue', 'claude-claude-s1-m0.json'), 'utf8')
  const clash = json(cli(['harvest', 'scan', '--session', recentFile]))
  assert.equal(clash.skipped_pending, 1, 'a second file for a queued session never overwrites the pending excerpt')
  assert.equal(fs.readFileSync(path.join(state, 'harvest/queue', 'claude-claude-s1-m0.json'), 'utf8'), pendingBefore)
  fs.rmSync(path.join(state, 'harvest/queue', 'claude-claude-s1-m0.json'))
  const hook = json(cli(['harvest', 'scan', '--session', recentFile]))
  assert.equal(hook.queued.length, 1, '--session bypasses the quiet window and retries once the queue slot is free')
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

  fs.appendFileSync(claudeFile, `\n${JSON.stringify({ type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: richer }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', claudeFile])).queued.length, 1)
  fs.renameSync(path.join(vault, 'docs/inbox/ai'), path.join(temp, 'inbox-ai'))
  fs.mkdirSync(path.join(vault, 'kb/imports'))
  fs.symlinkSync(path.join(vault, 'kb/imports'), path.join(vault, 'docs/inbox/ai'))
  const redirected = failedJson(cli(['harvest', 'distill', '--distiller', fake]))
  assert.match(redirected.failed[0]?.error || '', /real directory/, 'a symlinked harvest inbox is refused')
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb/imports')), [])
  fs.rmSync(path.join(vault, 'docs/inbox/ai'))
  fs.rmSync(path.join(vault, 'kb/imports'), { recursive: true })
  fs.renameSync(path.join(temp, 'inbox-ai'), path.join(vault, 'docs/inbox/ai'))
  for (const item of listQueue()) fs.rmSync(path.join(state, 'harvest/queue', item.name))
  fs.appendFileSync(claudeFile, `\n${JSON.stringify({ type: 'assistant', sessionId: 'claude-s1', message: { role: 'assistant', content: [{ type: 'text', text: `${richer} Swap.` }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', claudeFile])).queued.length, 1)
  const { harvestDistill } = await import(path.join(root, '_meta/lib/harvest.mjs'))
  const inboxAi = path.join(vault, 'docs/inbox/ai')
  const kbBeforeSwap = fs.readdirSync(path.join(vault, 'kb')).sort()
  const { openSync } = fs
  fs.openSync = (file, ...rest) => {
    if (String(file).startsWith(path.join(inboxAi, 'harvest-')) && !fs.lstatSync(inboxAi).isSymbolicLink()) { fs.renameSync(inboxAi, path.join(temp, 'inbox-ai')); fs.symlinkSync(path.join(vault, 'kb'), inboxAi) }
    return openSync(file, ...rest)
  }
  let swappedRun
  try { swappedRun = harvestDistill(vault, { distiller: fake, stateDir: state, env }) } finally {
    fs.openSync = openSync
    if (fs.lstatSync(inboxAi).isSymbolicLink()) { fs.unlinkSync(inboxAi); fs.renameSync(path.join(temp, 'inbox-ai'), inboxAi) }
  }
  assert.match(swappedRun.failed[0]?.error || '', /changed during the distill/, JSON.stringify(swappedRun))
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb')).sort(), kbBeforeSwap, 'a harvest inbox swapped during the write leaves nothing in kb')
  assert.equal(listQueue().length, 1, 'the entry stays queued')
  const movedInbox = path.join(temp, 'inbox-ai-moved')
  const draftsBeforeMove = new Set(fs.readdirSync(inboxAi))
  fs.openSync = (file, ...rest) => {
    const fd = openSync(file, ...rest)
    if (String(file).startsWith(path.join(inboxAi, 'harvest-')) && !fs.existsSync(movedInbox)) { fs.renameSync(inboxAi, movedInbox); fs.mkdirSync(inboxAi) }
    return fd
  }
  let movedRun
  try { movedRun = harvestDistill(vault, { distiller: fake, stateDir: state, env }) } finally {
    fs.openSync = openSync
    fs.rmSync(inboxAi, { recursive: true })
    fs.renameSync(movedInbox, inboxAi)
  }
  assert.match(movedRun.failed[0]?.error || '', /changed during the distill/, JSON.stringify(movedRun))
  assert.equal(listQueue().length, 1, 'a harvest inbox moved away during the write keeps the entry queued')
  for (const name of fs.readdirSync(inboxAi).filter((entry) => !draftsBeforeMove.has(entry))) fs.rmSync(path.join(inboxAi, name))
  const draftsBefore = new Set(fs.readdirSync(inboxAi))
  const { writeSync } = fs
  const drafts = new Set()
  let intended = null
  fs.openSync = (file, ...rest) => {
    const fd = openSync(file, ...rest)
    if (String(file).startsWith(path.join(inboxAi, 'harvest-'))) drafts.add(fd)
    return fd
  }
  fs.writeSync = (fd, data, ...rest) => {
    if (!drafts.has(fd)) return writeSync(fd, data, ...rest)
    intended ??= Buffer.from(data)
    return typeof data === 'string' ? writeSync(fd, data.slice(0, 64), rest[0]) : writeSync(fd, data, rest[0], Math.min(rest[1], 64))
  }
  let shortRun
  try { shortRun = harvestDistill(vault, { distiller: fake, stateDir: state, env }) } finally { Object.assign(fs, { openSync, writeSync }) }
  const shortDraft = fs.readdirSync(inboxAi).filter((name) => !draftsBefore.has(name))
  assert.equal(shortDraft.length, 1, JSON.stringify(shortRun))
  assert.ok(intended && intended.length > 64)
  assert.deepEqual(fs.readFileSync(path.join(inboxAi, shortDraft[0])), intended, 'short writes still produce the exact draft')
  fs.rmSync(path.join(inboxAi, shortDraft[0]))
  for (const item of listQueue()) fs.rmSync(path.join(state, 'harvest/queue', item.name))

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
  fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '{"title": "Qwpfragment leaked", "summary": }'\n`, { mode: 0o755 })
  const malformed = failedJson(cli(['harvest', 'distill', '--distiller', fake]))
  assert.equal(malformed.failed[0].error, 'distiller output is not valid JSON')
  assert.equal(JSON.stringify(listQueue()).includes('Qwpfragment'), false, 'a malformed answer never reaches the queue state')
  assert.equal(failedJson(cli(['harvest', 'distill', '--distiller', fake])).failed[0].attempts, 3)
  assert.equal(listQueue().length, 0, 'a candidate is retired after three failed attempts')
  const failedEntry = JSON.parse(fs.readFileSync(path.join(state, 'harvest/processed', retry[0].name), 'utf8'))
  assert.equal(failedEntry.status, 'distill_failed')
  assert.equal(failedEntry.excerpt, retry[0].entry.excerpt, 'a retired failure keeps its excerpt so it can be requeued')

  fs.appendFileSync(codexFile, `\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: richer }] } })}`)
  assert.equal(json(cli(['harvest', 'scan', '--session', codexFile])).queued.length, 1)
  assert.notEqual(cli(['harvest', 'digest', '--out', path.join(vault, 'kb/raw-session.json')]).status, 0, 'a digest inside the vault is refused')
  assert.equal(fs.existsSync(path.join(vault, 'kb/raw-session.json')), false)
  fs.symlinkSync(vault, path.join(temp, 'vault-alias'))
  assert.notEqual(cli(['harvest', 'digest', '--out', path.join(temp, 'vault-alias/kb/new/raw.json')]).status, 0, 'a digest under a missing dir of an aliased vault is refused')
  assert.equal(fs.existsSync(path.join(vault, 'kb/new')), false)
  const caseAlias = path.join(path.dirname(vault), path.basename(vault).toUpperCase())
  if (caseAlias !== vault && fs.existsSync(caseAlias)) {
    assert.notEqual(cli(['harvest', 'digest', '--out', path.join(caseAlias, 'kb/raw.json')]).status, 0, 'a case alias of the vault is refused')
    assert.equal(fs.existsSync(path.join(vault, 'kb/raw.json')), false)
    const caseState = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'harvest', 'scan', '--dry-run', '--json'], { encoding: 'utf8', env: { ...env, ALAMBIC_ROOT: vault, ALAMBIC_STATE_DIR: path.join(caseAlias, 'kb/runtime') } })
    assert.notEqual(caseState.status, 0, 'a state dir under a case alias of the vault is refused')
  }
  const digestFile = path.join(temp, 'digest.json')
  const digest = json(cli(['harvest', 'digest', '--out', digestFile]))
  assert.equal(digest.count, 1)
  const digestData = JSON.parse(fs.readFileSync(digestFile, 'utf8'))
  assert.equal(digestData.trust, 'untrusted-session-data')
  assert.notEqual(cli(['harvest', 'ack', '--digest', digestFile, '--bogus']).status, 0)
  assert.equal(listQueue().length, 1, 'an usage error leaves the queue intact')
  assert.equal(json(cli(['harvest', 'ack', '--digest', digestFile, '--dry-run'])).acked, 1)
  assert.equal(listQueue().length, 1, 'a dry-run ack leaves the queue intact')
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

  const linkedState = path.join(temp, 'linked-state')
  fs.mkdirSync(linkedState)
  fs.mkdirSync(path.join(vault, 'kb/imports'))
  fs.symlinkSync(path.join(vault, 'kb/imports'), path.join(linkedState, 'harvest'))
  assert.notEqual(cli(['harvest', 'scan', '--session', claudeFile], { ALAMBIC_STATE_DIR: linkedState }).status, 0, 'a harvest dir linked into the vault is refused')
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb/imports')), [])
  fs.rmSync(path.join(vault, 'kb/imports'), { recursive: true })

  const harvestLib = await import(path.join(root, '_meta/lib/harvest.mjs'))
  const lockState = path.join(temp, 'lock-state')
  fs.mkdirSync(path.join(lockState, 'harvest/lock'), { recursive: true })
  fs.writeFileSync(path.join(lockState, 'harvest/lock/owner.json'), JSON.stringify({ pid: 999999, token: 'dead' }))
  assert.equal(harvestLib.withHarvestLock(lockState, () => ({ ok: true, ran: true })).ran, true, 'a dead owner lock is taken over')
  assert.deepEqual(fs.readdirSync(path.join(lockState, 'harvest')), [], 'takeover leaves no lock or tombstone')
  fs.mkdirSync(path.join(lockState, 'harvest/lock'))
  fs.writeFileSync(path.join(lockState, 'harvest/lock/owner.json'), JSON.stringify({ pid: process.pid, token: 'live' }))
  assert.equal(harvestLib.withHarvestLock(lockState, () => ({ ok: true })).locked, true, 'a live owner keeps the lock')
  fs.writeFileSync(path.join(lockState, 'harvest/lock/owner.json'), JSON.stringify({ pid: 999999, token: 'dead2' }))
  fs.mkdirSync(path.join(lockState, 'harvest/lock.reap-dead2'))
  fs.writeFileSync(path.join(lockState, 'harvest/lock.reap-dead2/owner.json'), JSON.stringify({ pid: process.pid, token: 'reaper' }))
  assert.equal(harvestLib.withHarvestLock(lockState, () => ({ ok: true })).locked, true, 'a live reaper serializes the takeover')
  fs.writeFileSync(path.join(lockState, 'harvest/lock.reap-dead2/owner.json'), JSON.stringify({ pid: 999998, token: 'dead3' }))
  let inside = null
  assert.equal(harvestLib.withHarvestLock(lockState, () => { inside = harvestLib.withHarvestLock(lockState, () => ({ ok: true })); return { ok: true, ran: true } }).ran, true, 'a dead reaper is inherited through its own reap claim')
  assert.equal(inside.locked, true, 'the new owner excludes a concurrent run')
  assert.deepEqual(fs.readdirSync(path.join(lockState, 'harvest')), [], 'the takeover chain leaves no lock, reaper or tombstone')
  fs.mkdirSync(path.join(lockState, 'harvest/lock'))
  fs.writeFileSync(path.join(lockState, 'harvest/lock/owner.json'), JSON.stringify({ pid: 999999, token: 'dead4' }))
  fs.mkdirSync(path.join(lockState, 'harvest/lock.reap-dead4/reap-dead5'), { recursive: true })
  fs.writeFileSync(path.join(lockState, 'harvest/lock.reap-dead4/owner.json'), JSON.stringify({ pid: 999998, token: 'dead5' }))
  fs.writeFileSync(path.join(lockState, 'harvest/lock.reap-dead4/reap-dead5/owner.json'), JSON.stringify({ pid: process.pid, token: 'heir' }))
  assert.equal(harvestLib.withHarvestLock(lockState, () => ({ ok: true })).locked, true, 'a live heir of a dead reaper keeps the takeover exclusive')
  assert.ok(fs.existsSync(path.join(lockState, 'harvest/lock.reap-dead4/reap-dead5')), 'a claim on the current dead lock is never swept')
  fs.rmSync(path.join(lockState, 'harvest/lock.reap-dead4'), { recursive: true })
  fs.mkdirSync(path.join(lockState, 'harvest/lock.reap-gone'))
  fs.writeFileSync(path.join(lockState, 'harvest/lock.reap-gone/owner.json'), JSON.stringify({ pid: process.pid, token: 'old' }))
  assert.equal(harvestLib.withHarvestLock(lockState, () => ({ ok: true, ran: true })).ran, true)
  assert.deepEqual(fs.readdirSync(path.join(lockState, 'harvest')), [], 'claims for a lock that no longer exists are swept')

  const bumper = `import(${JSON.stringify(path.join(root, '_meta/lib/harvest.mjs'))}).then((lib) => { for (let index = 0; index < 20; index += 1) lib.bumpMetrics(${JSON.stringify(lockState)}, { accepted: 1 }) })`
  const { spawn } = await import('node:child_process')
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => spawn(process.execPath, ['-e', bumper], { stdio: 'inherit' }).on('exit', (code) => code === 0 ? resolve() : reject(new Error(`bumper exited ${code}`))))))
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockState, 'harvest/metrics.json'), 'utf8')).accepted, 120, 'concurrent metric bumps are not lost')
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
  const metricsLock = path.join(lockState, 'harvest/metrics.json.lock')
  fs.mkdirSync(metricsLock)
  fs.writeFileSync(path.join(metricsLock, 'owner.json'), JSON.stringify({ pid: holder.pid, token: 'slow' }))
  const longAgo = new Date(Date.now() - 3600 * 1000)
  fs.utimesSync(metricsLock, longAgo, longAgo)
  const holderExit = new Promise((resolve) => holder.on('exit', resolve))
  const waitedFrom = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const blocked = await new Promise((resolve) => spawn(process.execPath, ['-e', `import(${JSON.stringify(path.join(root, '_meta/lib/harvest.mjs'))}).then((lib) => lib.bumpMetrics(${JSON.stringify(lockState)}, { accepted: 1 }))`], { stdio: 'inherit' }).on('exit', resolve))
  await holderExit
  assert.equal(blocked, 0, 'the waiting bump succeeds once the owner exits')
  assert.ok(Date.now() - waitedFrom >= 1200, 'an old lock with a live owner is never stolen')
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockState, 'harvest/metrics.json'), 'utf8')).accepted, 121)

  const dense = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${richer} step ${index}` }))
  assert.ok(harvestLib.buildExcerpt(dense).excerpt.length <= 6000, 'the excerpt respects its bound')

  const nulAnswer = { title: 'Nul byte draft', summary: 'A draft whose body hides a control character.', body: `${'Body text. '.repeat(30)}\u0000 zyxwv quorble`, tags: ['harvest'] }
  assert.throws(() => harvestLib.renderHarvestNote(nulAnswer, { source_ref: 'claude:s1', score: 50 }), /control characters/, 'a draft with a NUL byte is refused before the leak scan')

  const raceState = path.join(temp, 'race-state')
  const raceTarget = path.join(vault, 'kb/race')
  fs.mkdirSync(raceTarget)
  const { mkdirSync } = fs
  fs.mkdirSync = (dir, options) => {
    if (dir === path.join(raceState, 'harvest/queue')) { fs.mkdirSync = mkdirSync; fs.mkdirSync(path.join(raceState, 'harvest'), { recursive: true }); fs.symlinkSync(raceTarget, dir) }
    return mkdirSync(dir, options)
  }
  try { assert.throws(() => harvestLib.harvestScan(vault, { session: claudeFile, stateDir: raceState, env }), /real directories/, 'a queue swapped for a link after the check is refused') } finally { fs.mkdirSync = mkdirSync }
  assert.deepEqual(fs.readdirSync(raceTarget), [], 'no excerpt lands in the vault')
  assert.equal(fs.existsSync(path.join(raceState, 'harvest/cursor.json')), false, 'the cursor stays put')
  fs.rmSync(raceTarget, { recursive: true })

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
