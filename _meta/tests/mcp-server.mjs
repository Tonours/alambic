#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EOF_GRACE_MS, MAX_LINE_CHARS, SUPPORTED_VERSIONS, serveStdio } from '../lib/mcp-stdio.mjs'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-mcp-server-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert(Date.now() < deadline, 'timed out waiting for a condition')
    await sleep(10)
  }
}

const stubVault = path.join(temp, 'vault')
const stubDir = path.join(temp, 'stub')
fs.mkdirSync(path.join(stubVault, '_meta/mcp'), { recursive: true })
fs.mkdirSync(stubDir)
fs.copyFileSync(path.join(root, '_meta/mcp/server.mjs'), path.join(stubVault, '_meta/mcp/server.mjs'))
fs.symlinkSync(path.join(root, '_meta/lib'), path.join(stubVault, '_meta/lib'))
if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(stubVault, 'node_modules'))
fs.writeFileSync(path.join(stubVault, '_meta/alambic'), `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const dir = process.env.STUB_DIR
const args = process.argv.slice(2)
const record = { args, pid: process.pid, at: Date.now() }
if (args[0] === 'capture') {
  record.mode = fs.statSync(args[2]).mode & 0o777
  record.file = args[2]
  record.text = fs.readFileSync(args[2], 'utf8')
}
fs.appendFileSync(path.join(dir, 'cli.log'), JSON.stringify(record) + '\\n')
if (process.env.STUB_IGNORE_TERM) process.on('SIGTERM', () => {})
if (process.env.STUB_SLEEP) setTimeout(() => fs.appendFileSync(path.join(dir, 'done.log'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n'), Number(process.env.STUB_SLEEP) * 1000)
else process.stdout.write('ok\\n')
`, { mode: 0o755 })
const cliLog = () => (fs.existsSync(path.join(stubDir, 'cli.log')) ? fs.readFileSync(path.join(stubDir, 'cli.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const doneLog = () => (fs.existsSync(path.join(stubDir, 'done.log')) ? fs.readFileSync(path.join(stubDir, 'done.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const resetCliLog = () => {
  fs.rmSync(path.join(stubDir, 'cli.log'), { force: true })
  fs.rmSync(path.join(stubDir, 'done.log'), { force: true })
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function open(extraEnv = {}) {
  const env = { ...process.env, ALAMBIC_ROOT: root, XDG_STATE_HOME: path.join(temp, 'state'), TYPESAFE_API_KEY: '', STUB_DIR: stubDir, ...extraEnv }
  const child = spawn(process.execPath, [path.join(stubVault, '_meta/mcp/server.mjs')], { env, cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] })
  const session = { child, lines: [], stderr: '', exit: null, nextId: 1, waiters: new Map() }
  opened.push(child)
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const message = JSON.parse(line)
      assert.equal(message.jsonrpc, '2.0', `stdout carried a non JSON-RPC line: ${line}`)
      session.lines.push(message)
      session.waiters.get(message.id)?.(message)
    }
  })
  child.stderr.on('data', (chunk) => { session.stderr += chunk })
  session.closed = new Promise((resolve) => child.on('close', (code, signal) => {
    session.exit = { code, signal, at: Date.now() }
    resolve(session.exit)
  }))
  session.write = (text) => child.stdin.write(text)
  session.send = (message) => session.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  session.request = (method, params, id = session.nextId++) => {
    const reply = new Promise((resolve) => session.waiters.set(id, resolve))
    session.send({ id, method, ...(params === undefined ? {} : { params }) })
    return reply
  }
  session.call = (name, args) => session.request('tools/call', args === undefined ? { name } : { name, arguments: args })
  session.initialize = () => session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } })
  session.finish = async () => {
    child.stdin.end()
    return session.closed
  }
  return session
}

const opened = []
const refused = (reply) => reply.result?.isError === true && /^MCP error -32602: /.test(reply.result.content[0].text)
const ids = (session) => session.lines.map((line) => line.id)
let ran = 0
const results = []
async function test(name, fn) {
  try {
    let timer
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('case timed out after 25 s')), 25000) })]).finally(() => clearTimeout(timer))
    results.push(`ok ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
  ran++
}

await test('static import graph keeps the idle process dependency-free', () => {
  const staticImports = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/^import\s[^'"\n]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  const server = path.join(root, '_meta/mcp/server.mjs')
  const allowedLocal = new Set(['../lib/mcp-stdio.mjs', '../lib/mcp-format.mjs', './mcp-format.mjs'])
  for (const file of [server, path.join(root, '_meta/lib/mcp-stdio.mjs'), path.join(root, '_meta/lib/mcp-format.mjs')].filter((candidate) => fs.existsSync(candidate))) {
    for (const specifier of staticImports(file)) {
      assert(specifier.startsWith('node:') || allowedLocal.has(specifier), `${path.basename(file)} statically imports ${specifier}`)
    }
  }
  const source = fs.readFileSync(server, 'utf8')
  for (const lazy of ['semantic-vault.mjs', 'typesafe-judge.mjs', 'vault.mjs']) assert(new RegExp(`import\\(['"]\\.\\./lib/${lazy}['"]\\)`).test(source), `${lazy} must be imported lazily`)
  assert(!/spawnSync|execFileSync|execSync/.test(source), 'server.mjs must not block on child processes')
  assert(/timeout:\s*CLI_TIMEOUT_MS/.test(source), 'CLI calls need a timeout')
})

await test('serveStdio refuses schemas it cannot validate', () => {
  const open = { name: 't', inputSchema: { type: 'object', properties: {} }, handler() {} }
  const array = { name: 't', inputSchema: { type: 'object', properties: { a: { type: 'array' } }, additionalProperties: false }, handler() {} }
  const keyword = { name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: 'x' } }, additionalProperties: false }, handler() {} }
  const missing = { name: 't', inputSchema: { type: 'object', properties: {}, required: ['a'], additionalProperties: false }, handler() {} }
  const quiet = { input: { setEncoding() {}, on() {} }, output: { on() {}, write() {} } }
  for (const tool of [open, array, keyword, missing]) assert.throws(() => serveStdio({ name: 'x', version: '0', tools: [tool], ...quiet }), /mcp-stdio/)
  const okTool = { name: 't', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler() {} }
  assert.throws(() => serveStdio({ name: 'x', version: '0', tools: [okTool, okTool], ...quiet }), /duplicate/)
})

await test('surface, handshake and negotiation', async () => {
  const session = open()
  const init = await session.initialize()
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal(init.result.serverInfo.name, 'alambic')
  assert(typeof init.result.instructions === 'string' && init.result.instructions.length <= 400, 'instructions must be one short string')
  for (const version of SUPPORTED_VERSIONS) assert.equal((await session.request('initialize', { protocolVersion: version })).result.protocolVersion, version)
  for (const params of [{ protocolVersion: '1999-01-01' }, { protocolVersion: 7 }, {}, undefined]) {
    assert.equal((await session.request('initialize', params)).result.protocolVersion, SUPPORTED_VERSIONS[0])
  }
  assert.deepEqual((await session.request('ping')).result, {})
  const listed = (await session.request('tools/list')).result.tools
  assert.deepEqual(listed.map((tool) => tool.name).sort(), ['vault_capture', 'vault_context', 'vault_feedback', 'vault_health', 'vault_read', 'vault_search'])
  for (const tool of listed) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert(!('$schema' in tool.inputSchema) && !('execution' in tool), `${tool.name} carries SDK-only keys`)
    assert(typeof tool.annotations.readOnlyHint === 'boolean' && tool.annotations.destructiveHint === false)
    assert(!JSON.stringify(tool.inputSchema).includes('"trim"'), 'trim is an input transform, not published')
  }
  const writes = listed.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name).sort()
  assert.deepEqual(writes, ['vault_capture', 'vault_feedback'])
  assert.equal(listed.find((tool) => tool.name === 'vault_capture').annotations.idempotentHint, true)
  assert.equal((await session.request('nope')).error.code, -32601)
  assert.equal((await session.request('server/discover')).error.code, -32601)
  await session.finish()
  assert.equal(session.stderr, '')
})

await test('notifications get no reply; ids 0 and strings are echoed', async () => {
  const session = open()
  session.send({ method: 'notifications/initialized' })
  session.send({ method: 'notifications/cancelled', params: { requestId: 1 } })
  session.send({ method: 'unknown/notification' })
  assert.deepEqual((await session.request('ping', undefined, 0)).result, {})
  assert.deepEqual((await session.request('ping', undefined, 'abc')).result, {})
  assert.deepEqual(ids(session), [0, 'abc'])
  await session.finish()
})

await test('envelope: malformed messages never reach a handler', async () => {
  resetCliLog()
  const session = open()
  session.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])}\n`)
  session.write('{not json\n')
  session.write('"just a string"\n')
  session.write('null\n')
  session.write(`${JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'vault_capture', arguments: { text: 'no jsonrpc member' } } })}\n`)
  session.write(`${JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'tools/call', params: { name: 'vault_capture', arguments: { text: 'wrong version' } } })}\n`)
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'vault_capture', arguments: { text: 'null id' } } })}\n`)
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'tools/call', params: { name: 'vault_feedback', arguments: { status: 'hit' } } })}\n`)
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} })}\n`)
  session.write('{"jsonrpc":"2.0","id":1e999,"method":"tools/call","params":{"name":"vault_feedback","arguments":{"status":"hit"}}}\n')
  session.write('{"jsonrpc":"2.0","id":1.5,"method":"tools/call","params":{"name":"vault_feedback","arguments":{"status":"hit"}}}\n')
  session.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'vault_feedback', arguments: { status: 'hit' } } })}\n`)
  assert.equal((await session.request('tools/call', 'vault_capture')).error.code, -32602)
  assert.equal((await session.request('tools/call', ['vault_capture'])).error.code, -32602)
  assert.equal((await session.request('tools/call', null)).error.code, -32602)
  assert.equal((await session.request('tools/call', { name: 5 })).error.code, -32602)
  assert.equal((await session.request('tools/call', { name: 'vault_capture', arguments: [] })).error.code, -32602)
  assert.equal((await session.request('tools/call', { name: 'vault_capture', arguments: 'x' })).error.code, -32602)
  assert.equal((await session.request('tools/call', { name: 'vault_capture', arguments: null })).error.code, -32602)
  assert.equal((await session.request('tools/call', { name: 'vault_capture' })).result.isError, true)
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 5 })}\n`)
  await until(() => ids(session).includes(9))
  assert.equal(session.lines.find((line) => line.id === 9).error.code, -32600)
  assert.deepEqual((await session.request('ping')).result, {})
  await session.finish()
  assert.deepEqual(cliLog(), [], 'a malformed envelope reached the CLI')
  assert(session.lines.every((line) => typeof line.id === 'number' || typeof line.id === 'string'), 'every reply must carry a real id')
  assert(/dropped/.test(session.stderr), 'dropped messages must be reported on stderr')
})

await test('framing: split, coalesced, CRLF, multi-byte, oversize and unterminated lines', async () => {
  const session = open()
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  session.write(line.slice(0, 7))
  await sleep(30)
  session.write(line.slice(7, 20))
  await sleep(30)
  session.write(`${line.slice(20)}\n`)
  await until(() => ids(session).includes(1))
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`)
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\r\n`)
  await until(() => [2, 3, 4].every((id) => ids(session).includes(id)))
  const search = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vault_search', arguments: { query: ' strict € second brain ' } } })}\n`)
  const cut = search.indexOf(0xe2) + 1
  session.child.stdin.write(search.subarray(0, cut))
  await sleep(30)
  session.child.stdin.write(search.subarray(cut))
  await until(() => ids(session).includes(5))
  assert.equal(session.lines.find((reply) => reply.id === 5).result.structuredContent.query, 'strict € second brain')
  session.write('x'.repeat(MAX_LINE_CHARS + 10))
  await until(() => /oversize/.test(session.stderr))
  session.write('\n')
  session.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' })}\n`)
  await until(() => ids(session).includes(6))
  assert(/oversize/.test(session.stderr))
  session.write(`${'y'.repeat(MAX_LINE_CHARS / 2)}`)
  session.write(`${'y'.repeat(MAX_LINE_CHARS / 2 + 5)}\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`)
  await until(() => ids(session).includes(7))
  session.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }))
  await session.finish()
  assert(ids(session).includes(8), 'a final unterminated line must still be answered')
  assert.equal(session.exit.code, 0)
})

await test('tool errors keep their envelopes', async () => {
  const session = open()
  const unknown = await session.call('nope', {})
  assert.equal(unknown.result.isError, true)
  assert.equal(unknown.result.content[0].text, 'MCP error -32602: Tool nope not found')
  const invalid = await session.call('vault_search', { query: 'x', unbounded: true })
  assert(refused(invalid) && /Input validation error/.test(invalid.result.content[0].text), invalid.result.content[0].text)
  const traversal = await session.call('vault_read', { path: '../CLAUDE.md' })
  assert.equal(traversal.result.isError, true)
  assert(traversal.result.content[0].text.startsWith('alambic: '), traversal.result.content[0].text)
  const health = await session.call('vault_health')
  assert(!health.result.isError && JSON.parse(health.result.content[0].text).typesafe.state === 'degraded')
  await session.finish()
  assert.equal(session.exit.code, 0)
})

const original = async () => {
  const { z } = await import('zod/v4')
  const query = z.string().trim().min(1).max(500)
  return {
    vault_search: z.object({ query, limit: z.number().int().min(1).max(10).optional(), include_docs: z.boolean().optional() }).strict(),
    vault_context: z.object({ query, max_tokens: z.number().int().min(512).max(4000).optional(), include_docs: z.boolean().optional() }).strict(),
    vault_read: z.object({ path: z.string().trim().min(1).max(300), include_docs: z.boolean().optional(), max_bytes: z.number().int().min(128).max(32000).optional() }).strict(),
    vault_health: z.object({}).strict(),
    vault_capture: z.object({ text: z.string().trim().min(1).max(12000) }).strict(),
    vault_feedback: z.object({ status: z.enum(['hit', 'miss', 'stale', 'wrong']) }).strict(),
  }
}

await test('validation matches the original zod schemas (table and seeded corpus)', async () => {
  const schemas = await original()
  const session = open()
  await session.initialize()
  const table = [
    ['vault_search', {}], ['vault_search', { query: '' }], ['vault_search', { query: '   ' }], ['vault_search', { query: 'x'.repeat(500) }], ['vault_search', { query: 'x'.repeat(501) }],
    ['vault_search', { query: ` ${'x'.repeat(500)} ` }], ['vault_search', { query: '😀'.repeat(250) }], ['vault_search', { query: '😀'.repeat(251) }], ['vault_search', { query: 'a', extra: 1 }],
    ...[0, 1, 10, 11, 1.5, -1, '5', null, true, 5.0].map((limit) => ['vault_search', { query: 'a', limit }]),
    ...[true, false, 'false', 'true', 0, 1, null].map((include_docs) => ['vault_search', { query: 'a', include_docs }]),
    ...[511, 512, 4000, 4001, 1200.5, '1200', null].map((max_tokens) => ['vault_context', { query: 'a', max_tokens }]),
    ...[127, 128, 32000, 32001, null, '128'].map((max_bytes) => ['vault_read', { path: 'kb/_index.md', max_bytes }]),
    ['vault_read', { path: 'p'.repeat(300) }], ['vault_read', { path: 'p'.repeat(301) }], ['vault_read', { path: ' kb/_index.md ' }], ['vault_read', { path: '   ' }], ['vault_read', {}],
    ['vault_health', {}], ['vault_health', { a: 1 }],
    ['vault_capture', { text: 'ok' }], ['vault_capture', { text: 't'.repeat(12000) }], ['vault_capture', { text: 't'.repeat(12001) }], ['vault_capture', { text: '\n\t  ' }], ['vault_capture', { text: 5 }], ['vault_capture', {}],
    ...['hit', 'miss', 'stale', 'wrong', 'HIT', 'hit ', '', 5, null].map((status) => ['vault_feedback', { status }]),
  ]
  let seed = 20260713
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const pool = ['', ' ', 'a', ' a ', 'x'.repeat(500), 'x'.repeat(501), '😀'.repeat(251), 'false', 'true', 'kb/_index.md', 'hit', 'stale', ' ', '﻿a', 0, 1, 5, 10, 11, 127, 128, 511, 512, 4000, 4001, 32000, 32001, 1.5, -1, true, false, null, [], {}, [1]]
  const keys = { vault_search: ['query', 'limit', 'include_docs'], vault_context: ['query', 'max_tokens', 'include_docs'], vault_read: ['path', 'include_docs', 'max_bytes'], vault_health: [], vault_capture: ['text'], vault_feedback: ['status'] }
  const names = Object.keys(keys)
  for (let index = 0; index < 600; index++) {
    const name = pick(names)
    const args = {}
    for (const key of keys[name]) if (random() < 0.7) args[key] = pick(pool)
    if (random() < 0.1) args[pick(['extra', 'constructor', 'toString'])] = pick(pool)
    table.push([name, args])
  }
  table.push(['vault_search', JSON.parse('{"query":"a","__proto__":{"limit":3}}')], ['vault_search', JSON.parse('{"__proto__":1,"query":"a"}')])
  const unfit = new Set(['vault_capture', 'vault_feedback'])
  let accepted = 0
  for (const [name, args] of table) {
    if (random() < 0.5 && unfit.has(name) && name !== 'vault_feedback') continue
    const parsed = schemas[name].safeParse(args)
    const expected = Object.hasOwn(args, '__proto__') ? { success: false } : parsed
    const reply = await session.call(name, args)
    const label = `${name} ${JSON.stringify(args).slice(0, 120)}`
    assert.equal(refused(reply), !expected.success, `${label}: expected ${expected.success ? 'accept' : 'refuse'}, got ${reply.result?.content?.[0]?.text?.slice(0, 160) ?? JSON.stringify(reply.error)}`)
    if (!expected.success) continue
    accepted++
    if (name === 'vault_search' && !reply.result.isError) assert.equal(reply.result.structuredContent.query, expected.data.query, `${label}: normalized query`)
    if (name === 'vault_read' && !reply.result.isError) assert.equal(reply.result.structuredContent.path, expected.data.path, `${label}: normalized path`)
    if (name === 'vault_capture') assert.equal(cliLog().at(-1).text, expected.data.text, `${label}: normalized text`)
  }
  assert(accepted > 100, `corpus accepted only ${accepted} cases`)
  await session.finish()
})

await test('missing arguments mean an empty object', async () => {
  const session = open()
  const health = await session.call('vault_health')
  assert(!health.result.isError)
  assert(refused(await session.call('vault_search')))
  await session.finish()
})

await test('capture: private temp file, removed afterwards, ping stays answered meanwhile', async () => {
  resetCliLog()
  const session = open({ STUB_SLEEP: '1' })
  const capture = session.call('vault_capture', { text: '  durable fact  ' })
  await until(() => cliLog().length === 1)
  const started = Date.now()
  assert.deepEqual((await session.request('ping')).result, {})
  assert(Date.now() - started < 500, 'ping must not wait for the CLI')
  const [record] = cliLog()
  assert.equal(record.mode, 0o600)
  assert.equal(record.text, 'durable fact')
  assert(path.basename(record.file).startsWith(`alambic-mcp-capture-${session.child.pid}-`))
  await capture
  await session.finish()
  assert.equal(session.exit.code, 0)
})

await test('capture and feedback reach the CLI and report success', async () => {
  resetCliLog()
  const session = open()
  const capture = await session.call('vault_capture', { text: 'durable fact' })
  assert.deepEqual(capture.result.structuredContent, { staged: true, detail: 'ok' })
  const record = cliLog()[0]
  assert(!fs.existsSync(record.file), 'temp file must be removed after the call')
  assert.deepEqual(record.args.slice(0, 1).concat(record.args.slice(3)), ['capture', '--surface', 'mcp'])
  const feedback = await session.call('vault_feedback', { status: 'stale' })
  assert.deepEqual(feedback.result.structuredContent, { recorded: true, status: 'stale' })
  assert.deepEqual(cliLog()[1].args, ['feedback', '--status', 'stale'])
  await session.finish()
})

await test('lifecycle: exits 0 on stdin EOF', async () => {
  const session = open()
  await session.initialize()
  const ended = Date.now()
  await session.finish()
  assert.equal(session.exit.code, 0)
  assert(session.exit.at - ended < 1000, `exit took ${session.exit.at - ended} ms`)
})

await test('lifecycle: idle SIGINT exits promptly', async () => {
  const session = open()
  await session.initialize()
  const sent = Date.now()
  session.child.kill('SIGINT')
  await session.closed
  assert(session.exit.at - sent < 100, `SIGINT exit took ${session.exit.at - sent} ms`)
})

await test('lifecycle: EOF during a stalled capture kills the child and cleans up within 1 s', async () => {
  resetCliLog()
  const session = open({ STUB_SLEEP: '30' })
  session.call('vault_capture', { text: 'stalled' })
  await until(() => cliLog().length === 1)
  const [record] = cliLog()
  const ended = Date.now()
  session.child.stdin.end()
  await session.closed
  const took = session.exit.at - ended
  assert.equal(session.exit.code, 0)
  assert(took < 1000 && took >= EOF_GRACE_MS - 50, `exit took ${took} ms`)
  await sleep(100)
  assert(!alive(record.pid), 'CLI child must not outlive the server')
  assert(!fs.existsSync(record.file), 'temp file must be removed when the call is aborted')
})

await test('lifecycle: EOF with a child that ignores SIGTERM still kills it', async () => {
  resetCliLog()
  const session = open({ STUB_SLEEP: '30', STUB_IGNORE_TERM: '1' })
  session.call('vault_capture', { text: 'stubborn' })
  await until(() => cliLog().length === 1)
  const [record] = cliLog()
  const ended = Date.now()
  session.child.stdin.end()
  await session.closed
  assert.equal(session.exit.code, 0)
  assert(session.exit.at - ended < 1000, `exit took ${session.exit.at - ended} ms`)
  await sleep(100)
  assert(!alive(record.pid), 'a child that ignores SIGTERM must still die')
  assert(!fs.existsSync(record.file))
})

await test('lifecycle: SIGINT and a closed stdout reader during a capture clean up at once', async () => {
  for (const how of ['sigint', 'epipe']) {
    resetCliLog()
    const session = open({ STUB_SLEEP: '30' })
    session.call('vault_capture', { text: how })
    await until(() => cliLog().length === 1)
    const [record] = cliLog()
    const started = Date.now()
    if (how === 'sigint') session.child.kill('SIGINT')
    else {
      session.child.stdout.destroy()
      session.send({ id: 99, method: 'ping' })
    }
    await session.closed
    assert.equal(session.exit.code, 0, `${how}: ${session.stderr}`)
    assert(session.exit.at - started < 300, `${how}: exit took ${session.exit.at - started} ms`)
    await sleep(100)
    assert(!alive(record.pid), `${how}: CLI child must die`)
    assert(!fs.existsSync(record.file), `${how}: temp file must be removed`)
  }
})

await test('CLI calls run one at a time and a queued call is dropped on shutdown', async () => {
  resetCliLog()
  const session = open({ STUB_SLEEP: '0.4' })
  const first = session.call('vault_feedback', { status: 'hit' })
  const second = session.call('vault_feedback', { status: 'miss' })
  await Promise.all([first, second])
  const [one, two] = cliLog()
  assert(two.at - one.at >= 350, `second CLI call started ${two.at - one.at} ms after the first`)
  assert.equal(doneLog().length, 2)
  await session.finish()
  resetCliLog()
  const closing = open({ STUB_SLEEP: '30' })
  closing.call('vault_feedback', { status: 'hit' })
  closing.call('vault_feedback', { status: 'miss' })
  await until(() => cliLog().length === 1)
  await closing.finish()
  await sleep(100)
  assert.equal(cliLog().length, 1, 'a queued CLI call must not start after shutdown')
})

await test('stdout carries only JSON-RPC across a full session', async () => {
  const session = open()
  await session.initialize()
  for (const query of ['strict second brain', 'mcp security', 'typesafe']) {
    await session.call('vault_search', { query, limit: 3 })
    await session.call('vault_context', { query, max_tokens: 512 })
  }
  await session.call('vault_read', { path: 'kb/_index.md' })
  await session.finish()
  assert.equal(session.exit.code, 0)
  assert.equal(session.stderr, '')
})

for (const child of opened) child.kill('SIGKILL')
fs.rmSync(temp, { recursive: true, force: true })
process.stdout.write(`${results.join('\n')}\nmcp-server: ${process.exitCode ? 'FAIL' : 'PASS'} (${ran} cases)\n`)
