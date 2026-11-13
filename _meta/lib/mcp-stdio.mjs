/**
 * Zero-dependency MCP stdio server layer: newline-delimited JSON-RPC 2.0,
 * closed-schema argument validation and a bounded lifecycle. It imports only
 * node: builtins so an idle server costs what an empty Node process does.
 */
import process from 'node:process'

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
export const MAX_LINE_CHARS = 1024 * 1024
export const EOF_GRACE_MS = 500
export const EOF_INFLIGHT_MS = 3000

const INVALID_PARAMS = -32602
const METHOD_NOT_FOUND = -32601
const INVALID_REQUEST = -32600

const OBJECT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties'])
const PROPERTY_KEYS = {
  string: new Set(['type', 'minLength', 'maxLength', 'enum', 'trim']),
  integer: new Set(['type', 'minimum', 'maximum']),
  boolean: new Set(['type']),
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (id) => typeof id === 'string' || Number.isInteger(id)
const validInitialize = (params) => plainObject(params)
  && typeof params.protocolVersion === 'string'
  && plainObject(params.capabilities)
  && typeof params.clientInfo?.name === 'string'
  && typeof params.clientInfo?.version === 'string'

/** Accepts only the closed-schema subset the validator implements; `trim` is an input transform and is not published. */
function compileSchema(toolName, schema) {
  if (!plainObject(schema) || schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new Error(`mcp-stdio: ${toolName} inputSchema must be a closed object (additionalProperties: false)`)
  }
  for (const key of Object.keys(schema)) {
    if (!OBJECT_KEYS.has(key)) throw new Error(`mcp-stdio: ${toolName} inputSchema uses unsupported keyword ${key}`)
  }
  const properties = schema.properties ?? {}
  const required = schema.required ?? []
  if (!plainObject(properties) || !Array.isArray(required) || required.some((key) => !Object.hasOwn(properties, key))) {
    throw new Error(`mcp-stdio: ${toolName} inputSchema has invalid properties or required`)
  }
  const published = { type: 'object', properties: {}, ...(required.length ? { required: [...required] } : {}), additionalProperties: false }
  for (const [key, property] of Object.entries(properties)) {
    const allowed = PROPERTY_KEYS[property?.type]
    if (!allowed) throw new Error(`mcp-stdio: ${toolName}.${key} has unsupported type`)
    const copy = {}
    for (const [keyword, value] of Object.entries(property)) {
      if (!allowed.has(keyword)) throw new Error(`mcp-stdio: ${toolName}.${key} uses unsupported keyword ${keyword}`)
      if (keyword !== 'trim') copy[keyword] = Array.isArray(value) ? [...value] : value
    }
    published.properties[key] = copy
  }
  return { properties, required, published }
}

function checkValue(property, value) {
  if (property.type === 'boolean') return typeof value === 'boolean' ? { value } : { issue: 'expected boolean' }
  if (property.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { issue: 'expected integer' }
    if (property.minimum !== undefined && value < property.minimum) return { issue: `must be >= ${property.minimum}` }
    if (property.maximum !== undefined && value > property.maximum) return { issue: `must be <= ${property.maximum}` }
    return { value }
  }
  if (typeof value !== 'string') return { issue: 'expected string' }
  const text = property.trim ? value.trim() : value
  if (property.minLength !== undefined && text.length < property.minLength) return { issue: `must have at least ${property.minLength} character(s)` }
  if (property.maxLength !== undefined && text.length > property.maxLength) return { issue: `must have at most ${property.maxLength} character(s)` }
  if (property.enum && !property.enum.includes(text)) return { issue: `must be one of ${property.enum.join(', ')}` }
  return { value: text }
}

/** Own keys only; the result is a fresh object holding known keys, so a `__proto__` key can only be reported as unknown. */
function validateArguments(compiled, args) {
  const issues = []
  const out = {}
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(compiled.properties, key)) issues.push(`${key}: unrecognized key`)
  }
  for (const key of compiled.required) {
    if (!Object.hasOwn(args, key)) issues.push(`${key}: required`)
  }
  for (const [key, property] of Object.entries(compiled.properties)) {
    if (!Object.hasOwn(args, key)) continue
    const checked = checkValue(property, args[key])
    if (checked.issue) issues.push(`${key}: ${checked.issue}`)
    else out[key] = checked.value
  }
  return issues.length ? { issues } : { value: out }
}

export function serveStdio({ name, version, instructions, tools, input = process.stdin, output = process.stdout, log = process.stderr }) {
  const table = new Map()
  for (const tool of tools) {
    if (table.has(tool.name)) throw new Error(`mcp-stdio: duplicate tool ${tool.name}`)
    table.set(tool.name, { tool, compiled: compileSchema(tool.name, tool.inputSchema) })
  }
  const listed = [...table.values()].map(({ tool, compiled }) => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: compiled.published,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }))

  const controller = new AbortController()
  let inflight = 0

  const warn = (message) => log.write(`${name}: ${message}\n`)
  const send = (message) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const reply = (id, result) => send({ id, result })
  const fail = (id, code, message) => send({ id, error: { code, message } })
  const toolFailure = (text) => ({ content: [{ type: 'text', text }], isError: true })

  const stop = () => {
    controller.abort()
    process.exit(0)
  }
  output.on('error', stop)
  input.on('error', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  async function callTool(params) {
    const entry = table.get(params.name)
    if (!entry) return toolFailure(`MCP error ${INVALID_PARAMS}: Tool ${params.name} not found`)
    const checked = validateArguments(entry.compiled, params.arguments ?? {})
    if (checked.issues) {
      return toolFailure(`MCP error ${INVALID_PARAMS}: Input validation error: Invalid arguments for tool ${params.name}: ${checked.issues.join('; ')}`)
    }
    try {
      return await entry.tool.handler(checked.value, { signal: controller.signal })
    } catch (error) {
      return toolFailure(`${name}: ${error instanceof Error ? error.message : 'unexpected tool error'}`)
    }
  }

  async function handle(message) {
    const { id, method, params } = message
    if (typeof method !== 'string') {
      if ('result' in message || 'error' in message) return
      if (validId(id)) return fail(id, INVALID_REQUEST, 'Invalid Request')
      return warn('dropped message without method')
    }
    if (id === undefined) return
    if (!validId(id)) return warn('dropped request with invalid id')
    switch (method) {
      case 'initialize': {
        if (!validInitialize(params)) return fail(id, INVALID_PARAMS, 'Invalid params')
        const asked = params.protocolVersion
        return reply(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        })
      }
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        if (params !== undefined && (!plainObject(params) || (params.cursor !== undefined && typeof params.cursor !== 'string'))) return fail(id, INVALID_PARAMS, 'Invalid params')
        return reply(id, { tools: listed })
      case 'tools/call': {
        if (!plainObject(params) || typeof params.name !== 'string' || (params.arguments !== undefined && !plainObject(params.arguments))) {
          return fail(id, INVALID_PARAMS, 'Invalid params')
        }
        inflight++
        try {
          return reply(id, await callTool(params))
        } finally {
          inflight--
        }
      }
      default:
        return fail(id, METHOD_NOT_FOUND, 'Method not found')
    }
  }

  function onLine(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return warn('dropped malformed JSON line')
    }
    if (!plainObject(message) || message.jsonrpc !== '2.0') return warn('dropped message that is not a JSON-RPC 2.0 object')
    handle(message).catch((error) => warn(`internal error: ${error instanceof Error ? error.message : 'unknown'}`))
  }

  let pending = ''
  let skipping = false
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf('\n', start)
      if (newline < 0) {
        if (!skipping) {
          pending += chunk.slice(start)
          if (pending.length > MAX_LINE_CHARS) {
            pending = ''
            skipping = true
            warn('dropped oversize line')
          }
        }
        return
      }
      if (skipping) skipping = false
      else {
        const line = pending + chunk.slice(start, newline)
        pending = ''
        if (line.length > MAX_LINE_CHARS) warn('dropped oversize line')
        else onLine(line)
      }
      start = newline + 1
    }
  })
  input.on('end', () => {
    if (!skipping && pending) onLine(pending)
    pending = ''
    setTimeout(stop, inflight ? EOF_INFLIGHT_MS : EOF_GRACE_MS).unref()
  })
}
