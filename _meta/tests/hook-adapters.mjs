#!/usr/bin/env node
// Pi extension and opencode plugin rendered by setup: guarded, time-limited,
// Pi keeps only the latest alambic block, opencode state is per session and
// lasts for every model call of the prompt's turn.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { desiredItems, makeContext } from '../lib/setup.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-adapters-')))
const vault = path.join(temp, "va'ult dir")
const stub = path.join(vault, '_meta/hooks/prompt-context.mjs')

// Stub hook: echoes context for prompts containing "vault", nothing otherwise,
// hangs on "hang", crashes on "crash".
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, `let raw = ''
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const prompt = JSON.parse(raw).prompt
  if (process.argv[3] !== 'text') process.exit(0)
  if (prompt.includes('hang')) setTimeout(() => {}, 60000)
  else if (prompt.includes('crash')) process.exit(3)
  else if (prompt.includes('vault')) process.stdout.write('ctx:' + prompt + '\\n')
})
`)

try {
  const env = { HOME: path.join(temp, 'home'), PATH: process.env.PATH }
  const items = desiredItems(makeContext({ vault, env }), { harnesses: ['pi', 'opencode'], components: { skill: false, mcp: false, shim: false, hook: true } })
  const byId = Object.fromEntries(items.map((item) => [item.id, item]))
  assert(byId['pi:hook'] && byId['opencode:hook'], 'setup must render Pi and opencode hook files')
  for (const item of items) assert(!item.content.includes('{{'), `${item.id} has unrendered placeholders`)
  fs.writeFileSync(path.join(temp, 'pi.ts'), byId['pi:hook'].content)
  fs.writeFileSync(path.join(temp, 'opencode.mjs'), byId['opencode:hook'].content)
  const pi = await import(pathToFileURL(path.join(temp, 'pi.ts')).href)
  const oc = await import(pathToFileURL(path.join(temp, 'opencode.mjs')).href)

  // Time limit and failure paths (shared runner shape).
  for (const mod of [pi, oc]) {
    const started = Date.now()
    assert(await mod.runHook('please hang', 300) === '' && Date.now() - started < 1500, 'slow hook must time out to empty')
    assert(await mod.runHook('crash now') === '', 'crashing hook must yield empty')
    assert(await mod.runHook('about the vault') === 'ctx:about the vault', 'matching prompt must return context')
  }

  // Pi: before_agent_start message, context filter.
  const handlers = {}
  pi.default({ on: (event, handler) => { handlers[event] = handler } })
  const injected = await handlers.before_agent_start({ prompt: 'about the vault' })
  assert(injected?.message?.customType === 'alambic-context' && injected.message.display === false && injected.message.content === 'ctx:about the vault', 'Pi must inject a hidden alambic-context message')
  assert(await handlers.before_agent_start({ prompt: 'unrelated' }) === undefined, 'Pi must not inject on abstain')
  assert(await handlers.before_agent_start(null) === undefined, 'Pi must survive a malformed event')
  const block = (n) => ({ role: 'custom', customType: 'alambic-context', content: `c${n}` })
  const filtered = (await handlers.context({ messages: [block(1), { role: 'user', content: 'u' }, block(2), { role: 'assistant', content: 'a' }] })).messages
  assert(filtered.length === 3 && filtered.filter((m) => m.customType === 'alambic-context').map((m) => m.content).join() === 'c2', 'Pi context filter must keep only the latest block')
  assert(await handlers.context({}) === undefined, 'Pi context filter must survive a malformed event')

  // opencode: per-session state, every model call of the turn, no sessionID means no-op.
  const hooks = await oc.AlambicContext({})
  const message = (sessionID, text) => hooks['chat.message']({ sessionID, messageID: `m-${sessionID}` }, { message: {}, parts: [{ type: 'text', text }] })
  const system = async (sessionID) => { const output = { system: ['base'] }; await hooks['experimental.chat.system.transform']({ sessionID, model: {} }, output); return output.system }
  await message(undefined, 'about the vault')
  assert((await system(undefined)).length === 1, 'no sessionID must be a no-op')
  await message('s1', 'about the vault')
  await message('s2', 'unrelated')
  assert((await system('s2')).length === 1, 'abstaining session must get nothing')
  assert((await system('s1')).at(-1) === 'ctx:about the vault', 'matching session must get context on the first call')
  assert((await system('s1')).at(-1) === 'ctx:about the vault', 'a second model call of the same turn (title, then main) must get context too')
  assert((await system('s2')).length === 1, 'context must not leak to another session')
  await message('s1', 'unrelated follow-up')
  assert((await system('s1')).length === 1, 'an abstaining next prompt must clear the session context')
  await message('s1', 'about the vault again')
  assert((await system('s1')).at(-1) === 'ctx:about the vault again', 'a new matching prompt must replace the context')
  await message('s1', 'crash it')
  assert((await system('s1')).length === 1, 'a failing hook must clear stale session state')
  await hooks['chat.message'](null, null)
  await hooks['experimental.chat.system.transform'](null, null)
  console.log('hook-adapters: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
