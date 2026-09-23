// `alambic setup`: user-level wiring of the vault into coding agents.
// Every path derives from an injected env; every write is owned (fingerprint),
// re-checked against its preimage, backed up once (0600) and journaled.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARNESSES = ['claude', 'codex', 'pi', 'opencode', 'cursor']
export const COMPONENTS = ['skill', 'mcp', 'shim', 'hook']
const BINARIES = { claude: 'claude', codex: 'codex', pi: 'pi', opencode: 'opencode', cursor: 'cursor-agent' }
const MCP_HARNESSES = ['claude', 'codex', 'opencode', 'cursor']
const HOOK_SCRIPT = '_meta/hooks/prompt-context.mjs'
const HOOK_MARKER = 'prompt-context.mjs'
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../harness')
export const USAGE = 'usage: alambic setup [--yes] [--dry-run] [--json] [--harness claude,codex,pi,opencode,cursor|all|detected] [--prompt-hook] [--no-skill] [--no-mcp] [--no-shim] | --status | --uninstall [--yes]'

class Refusal extends Error {}
const failureReason = (error) => (error instanceof Refusal ? error.message : `${error.code || error.name}`)

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (value) => sha256(canonical(value))
export function shq(value) { return `'${String(value).replace(/'/g, `'\\''`)}'` }

export function resolvePaths(env) {
  const home = env.HOME
  if (!home || !path.isAbsolute(home)) throw new Error('setup needs an absolute HOME')
  const abs = (value, fallback) => (value && path.isAbsolute(value) ? value : fallback)
  const xdgConfig = abs(env.XDG_CONFIG_HOME, path.join(home, '.config'))
  const xdgState = abs(env.XDG_STATE_HOME, path.join(home, '.local/state'))
  const customClaude = abs(env.CLAUDE_CONFIG_DIR, null)
  const claudeDir = customClaude || path.join(home, '.claude')
  return {
    home,
    claudeDir,
    claudeJson: customClaude ? path.join(customClaude, '.claude.json') : path.join(home, '.claude.json'),
    codexDir: abs(env.CODEX_HOME, path.join(home, '.codex')),
    piDir: abs(env.PI_CODING_AGENT_DIR, path.join(home, '.pi/agent')),
    opencodeDir: path.join(xdgConfig, 'opencode'),
    cursorDir: path.join(home, '.cursor'),
    agentsSkills: path.join(home, '.agents/skills'),
    binDir: path.join(home, '.local/bin'),
    manifest: path.join(xdgState, 'alambic', 'setup.json'),
  }
}

export function findBinary(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {}
  }
  return null
}

export function detectHarnesses(env, paths = resolvePaths(env)) {
  const dirs = { claude: paths.claudeDir, codex: paths.codexDir, pi: paths.piDir, opencode: paths.opencodeDir, cursor: paths.cursorDir }
  return Object.fromEntries(HARNESSES.map((harness) => {
    const binary = findBinary(BINARIES[harness], env)
    return [harness, { detected: Boolean(binary || fs.existsSync(dirs[harness])), binary }]
  }))
}

export function parseSetupArgs(argv) {
  const options = { mode: 'install', yes: false, dryRun: false, json: false, harness: null, components: { skill: true, mcp: true, shim: true, hook: false } }
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--prompt-hook') options.components.hook = true
    else if (arg === '--no-skill') options.components.skill = false
    else if (arg === '--no-mcp') options.components.mcp = false
    else if (arg === '--no-shim') options.components.shim = false
    else if (arg === '--status') options.mode = 'status'
    else if (arg === '--uninstall') options.mode = 'uninstall'
    else if (arg === '--harness' || arg.startsWith('--harness=')) {
      const value = arg === '--harness' ? rest.shift() : arg.slice('--harness='.length)
      if (!value) throw new Error(`--harness needs a value\n${USAGE}`)
      options.harness = value
    } else throw new Error(`unknown setup argument: ${arg}\n${USAGE}`)
  }
  return options
}

export function selectHarnesses(spec, detection) {
  if (!spec || spec === 'detected') return HARNESSES.filter((harness) => detection[harness].detected)
  if (spec === 'all') return [...HARNESSES]
  const list = spec.split(',').map((item) => item.trim()).filter(Boolean)
  const unknown = list.filter((item) => !HARNESSES.includes(item))
  if (!list.length || unknown.length) throw new Error(`unknown harness: ${unknown.join(', ') || spec} (use ${HARNESSES.join(',')}, all, or detected)`)
  return HARNESSES.filter((harness) => list.includes(harness))
}

// ---------------------------------------------------------------- disk state

// Deepest existing ancestor resolved through symlinks, plus the missing tail.
function realTarget(file) {
  let dir = path.dirname(file)
  const tail = [path.basename(file)]
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    tail.unshift(path.basename(dir))
    dir = parent
  }
  return path.join(fs.realpathSync(dir), ...tail)
}

function readTarget(file) {
  let link
  try {
    link = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, real: realTarget(file), hash: 'absent' }
    throw new Refusal(`cannot stat (${error.code})`)
  }
  let real
  try {
    real = fs.realpathSync(file)
  } catch {
    throw new Refusal('broken symlink')
  }
  const stat = fs.statSync(real)
  if (!stat.isFile()) throw new Refusal('not a regular file')
  const bytes = fs.readFileSync(real)
  return { exists: true, symlink: link.isSymbolicLink(), real, bytes, hash: sha256(bytes), mode: stat.mode & 0o7777 }
}

// JSON.parse errors quote file content; never surface them (secrets).
function parseStrictJson(bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Refusal('not strict JSON (JSONC or unknown format)')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('JSON root is not an object')
  return value
}

function indentOf(bytes) {
  const match = /^[{[]\r?\n([ \t]+)\S/.exec(bytes.toString('utf8'))
  return match ? match[1] : 2
}

function walk(object, keys) {
  let node = object
  for (const key of keys) {
    if (node === undefined) return undefined
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Refusal(`${keys.join('.')} crosses a non-object`)
    node = node[key]
  }
  return node
}

function atomicWrite(real, data, mode) {
  fs.mkdirSync(path.dirname(real), { recursive: true })
  const temporary = path.join(path.dirname(real), `.${path.basename(real)}.alambic-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, data)
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temporary, real)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function backupOnce(run, real) {
  if (run.backedUp.has(real)) return
  let file = `${real}.bak.${run.stamp}`
  for (let n = 1; ; n += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.fchmodSync(fd, 0o600)
        fs.writeFileSync(fd, fs.readFileSync(real))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      file = `${real}.bak.${run.stamp}.${n}`
    }
  }
  run.backedUp.add(real)
  run.backups.push(file)
}

// ------------------------------------------------------------------ manifest

export function readManifest(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`setup manifest unreadable (${error.code})`)
  }
  try {
    const manifest = JSON.parse(raw)
    if (manifest?.version === 1 && Array.isArray(manifest.items)) return manifest
  } catch {}
  throw new Error(`setup manifest is corrupt: ${file}`)
}

function writeManifest(file, manifest) {
  if (!manifest.items.length) {
    fs.rmSync(file, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  atomicWrite(file, `${JSON.stringify({ ...manifest, updated_at: new Date().toISOString() }, null, 2)}\n`, 0o600)
}

function recordItem(run, action, preState) {
  const items = run.manifest.items.filter((item) => item.id !== action.id)
  const previous = run.manifest.items.find((item) => item.id === action.id)
  items.push({
    id: action.id,
    harnesses: action.harnesses,
    kind: action.kind,
    type: action.type,
    target: action.target,
    ...(action.entryPath ? { entryPath: action.entryPath, container: action.container } : {}),
    fingerprint: action.fingerprint,
    preState: previous?.preState || preState,
    installed_at: new Date().toISOString(),
  })
  run.manifest = { ...run.manifest, vault: run.context.vault, node: run.context.node, items }
  writeManifest(run.context.paths.manifest, run.manifest)
}

function dropItem(run, id) {
  run.manifest = { ...run.manifest, items: run.manifest.items.filter((item) => item.id !== id) }
  writeManifest(run.context.paths.manifest, run.manifest)
}

// ----------------------------------------------------------------------- MCP

function runCli(context, name, argv, { allowFail = false } = {}) {
  const binary = findBinary(name, context.env)
  if (!binary) throw new Refusal(`${name} not found on PATH`)
  const result = spawnSync(binary, argv, { env: context.env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  // CLI stderr may quote config content; report the exit code only.
  if (!allowFail && result.status !== 0) throw new Refusal(`${name} ${argv.slice(0, 2).join(' ')} failed (exit ${result.status ?? result.signal})`)
  return result
}

function normalizeMcp(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const env = entry.env && typeof entry.env === 'object' ? entry.env : {}
  return { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], env: Object.fromEntries(Object.entries(env).sort()) }
}

function mcpAdapter(context, harness) {
  if (harness === 'claude') {
    return {
      read() {
        const state = readTarget(context.paths.claudeJson)
        if (!state.exists) return undefined
        const entry = parseStrictJson(state.bytes).mcpServers?.alambic
        return entry === undefined ? undefined : normalizeMcp(entry)
      },
      add(value) {
        const envArgs = Object.entries(value.env).flatMap(([key, item]) => ['-e', `${key}=${item}`])
        runCli(context, 'claude', ['mcp', 'add', '-s', 'user', 'alambic', ...envArgs, '--', value.command, ...value.args])
      },
      remove() { runCli(context, 'claude', ['mcp', 'remove', '-s', 'user', 'alambic']) },
    }
  }
  return {
    read() {
      const result = runCli(context, 'codex', ['mcp', 'get', 'alambic', '--json'], { allowFail: true })
      if (result.status !== 0) {
        if (/No MCP server named/.test(result.stderr || '')) return undefined
        throw new Refusal(`codex mcp get failed (exit ${result.status ?? result.signal})`)
      }
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new Refusal('codex mcp get returned non-JSON output')
      }
      return normalizeMcp(parsed?.transport || parsed)
    },
    add(value) {
      const envArgs = Object.entries(value.env).flatMap(([key, item]) => ['--env', `${key}=${item}`])
      runCli(context, 'codex', ['mcp', 'add', 'alambic', ...envArgs, '--', value.command, ...value.args])
    },
    remove() { runCli(context, 'codex', ['mcp', 'remove', 'alambic']) },
  }
}

// ------------------------------------------------------------------ planning

function renderTemplate(relative, values) {
  let text = fs.readFileSync(path.join(TEMPLATES, relative), 'utf8')
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  return text
}
// Placeholders inside JS/TS string literals get JSON escaping.
const jsString = (value) => JSON.stringify(String(value)).slice(1, -1)

function hookCommand(context, format) {
  return `${shq(context.node)} ${shq(path.join(context.vault, HOOK_SCRIPT))} --format ${format}`
}

// Desired state for a selection. Pure except for template reads.
export function desiredItems(context, selection) {
  const { paths, vault, node } = context
  const { harnesses, components } = selection
  const items = []
  const server = path.join(vault, '_meta/mcp/server.mjs')
  const mcpValue = { command: node, args: [server], env: { ALAMBIC_ROOT: vault } }
  if (components.skill) {
    const content = renderTemplate('skill/SKILL.md', { VAULT: vault, CLI: shq(path.join(vault, '_meta/alambic')), VAULT_DOCS: path.join(vault, 'docs/inbox') + path.sep })
    if (harnesses.includes('claude')) items.push({ id: 'claude:skill', harnesses: ['claude'], kind: 'skill', type: 'file', target: path.join(paths.claudeDir, 'skills/alambic/SKILL.md'), content, mode: 0o644 })
    const shared = harnesses.filter((harness) => harness !== 'claude')
    if (shared.length) items.push({ id: 'agents:skill', harnesses: shared, kind: 'skill', type: 'file', target: path.join(paths.agentsSkills, 'alambic/SKILL.md'), content, mode: 0o644 })
  }
  if (components.mcp) {
    for (const harness of harnesses.filter((item) => MCP_HARNESSES.includes(item))) {
      if (harness === 'claude' || harness === 'codex') {
        items.push({ id: `${harness}:mcp`, harnesses: [harness], kind: 'mcp', type: 'mcp-cli', target: `${harness} mcp (user) alambic`, value: normalizeMcp(mcpValue) })
      } else if (harness === 'opencode') {
        items.push({ id: 'opencode:mcp', harnesses: ['opencode'], kind: 'mcp', type: 'entry', container: 'object', target: path.join(paths.opencodeDir, 'opencode.json'), jsoncSibling: path.join(paths.opencodeDir, 'opencode.jsonc'), entryPath: ['mcp', 'alambic'], value: { type: 'local', command: [node, server], environment: { ALAMBIC_ROOT: vault }, enabled: true }, base: { $schema: 'https://opencode.ai/config.json' } })
      } else {
        items.push({ id: 'cursor:mcp', harnesses: ['cursor'], kind: 'mcp', type: 'entry', container: 'object', target: path.join(paths.cursorDir, 'mcp.json'), entryPath: ['mcpServers', 'alambic'], value: mcpValue, base: {} })
      }
    }
  }
  if (components.shim) {
    const content = `#!/bin/sh\n# Managed by alambic setup; remove with: alambic setup --uninstall --yes\nexec ${shq(node)} ${shq(path.join(vault, '_meta/alambic.mjs'))} "$@"\n`
    items.push({ id: 'cli:shim', harnesses: ['cli'], kind: 'shim', type: 'file', target: path.join(paths.binDir, 'alambic'), content, mode: 0o755 })
  }
  if (components.hook) {
    const values = { NODE: jsString(node), HOOK: jsString(path.join(vault, HOOK_SCRIPT)) }
    for (const harness of harnesses) {
      if (harness === 'claude' || harness === 'codex') {
        const target = harness === 'claude' ? path.join(paths.claudeDir, 'settings.json') : path.join(paths.codexDir, 'hooks.json')
        items.push({ id: `${harness}:hook`, harnesses: [harness], kind: 'hook', type: 'entry', container: 'array', target, entryPath: ['hooks', 'UserPromptSubmit'], value: { hooks: [{ type: 'command', command: hookCommand(context, harness), timeout: 5 }] }, base: {} })
      } else if (harness === 'cursor') {
        items.push({ id: 'cursor:hook', harnesses: ['cursor'], kind: 'hook', type: 'entry', container: 'array', target: path.join(paths.cursorDir, 'hooks.json'), entryPath: ['hooks', 'beforeSubmitPrompt'], value: { command: hookCommand(context, 'cursor') }, base: { version: 1 } })
      } else if (harness === 'pi') {
        items.push({ id: 'pi:hook', harnesses: ['pi'], kind: 'hook', type: 'file', target: path.join(paths.piDir, 'extensions/alambic-context.ts'), content: renderTemplate('pi/alambic-context.ts', values), mode: 0o644 })
      } else {
        items.push({ id: 'opencode:hook', harnesses: ['opencode'], kind: 'hook', type: 'file', target: path.join(paths.opencodeDir, 'plugins/alambic-context.js'), content: renderTemplate('opencode/alambic-context.js', values), mode: 0o644 })
      }
    }
  }
  for (const item of items) item.fingerprint = item.type === 'file' ? sha256(item.content) : fingerprint(item.value)
  return items
}

const claimsHook = (entry) => JSON.stringify(entry ?? null).includes(HOOK_MARKER)
const classify = (found, item, recorded) => (found === item.fingerprint ? 'match' : found === recorded?.fingerprint ? 'owned' : 'foreign')

// Current state of one item: { preimage, current } where current is
// 'absent' | 'match' | 'owned' | 'foreign' (+ reason).
function inspect(context, item, recorded) {
  if (item.type === 'mcp-cli') {
    if (!findBinary(BINARIES[item.harnesses[0]], context.env)) throw new Refusal(`${BINARIES[item.harnesses[0]]} not found on PATH`)
    const current = mcpAdapter(context, item.harnesses[0]).read()
    if (current === undefined) return { preimage: 'absent', state: 'absent' }
    const found = fingerprint(current)
    return { preimage: found, state: classify(found, item, recorded) }
  }
  const file = readTarget(item.target)
  if (item.type === 'file') {
    if (!file.exists) return { preimage: 'absent', state: 'absent', file }
    return { preimage: file.hash, file, state: classify(file.hash, item, recorded) }
  }
  if (!file.exists) {
    if (item.jsoncSibling && fs.existsSync(item.jsoncSibling)) throw new Refusal('config is JSONC (opencode.jsonc)')
    return { preimage: 'absent', state: 'absent', file }
  }
  const json = parseStrictJson(file.bytes)
  const node = walk(json, item.entryPath)
  if (node === undefined) return { preimage: file.hash, state: 'absent', file, json }
  if (item.container === 'object') {
    return { preimage: file.hash, file, json, state: classify(fingerprint(node), item, recorded) }
  }
  if (!Array.isArray(node)) throw new Refusal(`${item.entryPath.join('.')} is not an array`)
  const fingerprints = node.map(fingerprint)
  if (fingerprints.includes(item.fingerprint)) return { preimage: file.hash, file, json, state: 'match' }
  if (recorded && fingerprints.includes(recorded.fingerprint)) return { preimage: file.hash, file, json, state: 'owned' }
  if (node.some(claimsHook)) return { preimage: file.hash, file, json, state: 'foreign', reason: 'another alambic hook entry exists' }
  return { preimage: file.hash, file, json, state: 'absent' }
}

function planItem(context, item, recorded) {
  const action = { ...item }
  try {
    const found = inspect(context, item, recorded)
    action.preimage = found.preimage
    action.status = { absent: 'create', match: 'unchanged', owned: 'update', foreign: 'collision' }[found.state]
    if (found.state === 'foreign') action.reason = found.reason || (recorded ? 'changed since setup wrote it' : 'exists and is not owned by setup')
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    action.status = 'refuse'
    action.reason = error.message
  }
  if (action.status === 'refuse' && item.type === 'entry') action.snippet = { file: item.target, key: item.entryPath.join('.'), value: item.value }
  return action
}

export function makeContext({ vault, env, node = process.execPath }) {
  if (!path.isAbsolute(vault)) throw new Error('vault path must be absolute')
  try {
    fs.accessSync(node, fs.constants.X_OK)
  } catch {
    throw new Error(`node binary is not executable: ${node}`)
  }
  const paths = resolvePaths(env)
  return { vault, env, node, paths, manifest: readManifest(paths.manifest) || { version: 1, items: [] } }
}

export function planSetup(context, selection) {
  const recorded = new Map(context.manifest.items.map((item) => [item.id, item]))
  const actions = desiredItems(context, selection).map((item) => planItem(context, item, recorded.get(item.id)))
  const warnings = []
  if (selection.components.shim && !String(context.env.PATH || '').split(path.delimiter).includes(context.paths.binDir)) warnings.push(`${context.paths.binDir} is not on PATH; add it to use the \`alambic\` command`)
  if (selection.components.hook && selection.harnesses.includes('codex')) {
    const codex = findBinary('codex', context.env)
    const features = codex ? spawnSync(codex, ['features', 'list'], { env: context.env, encoding: 'utf8', timeout: 30_000 }) : null
    if (features?.status === 0 && /^hooks\s+\S+\s+false\b/m.test(features.stdout)) warnings.push('codex hooks are disabled; enable with: codex features enable hooks')
    warnings.push('codex hook stays pending-trust until you approve it in codex /hooks')
  }
  if (selection.components.mcp && selection.harnesses.includes('pi')) warnings.push('pi has no MCP support; pi gets the skill (and the hook when selected)')
  return { vault: context.vault, node: context.node, selection, actions, warnings }
}

// ------------------------------------------------------------------- applying

function applyAction(run, action) {
  const context = run.context
  const recorded = run.manifest.items.find((item) => item.id === action.id)
  const found = inspect(context, action, recorded)
  if (found.preimage !== action.preimage) return 'changed-during-setup'
  if (action.type === 'mcp-cli') {
    const adapter = mcpAdapter(context, action.harnesses[0])
    if (action.status === 'update') adapter.remove()
    adapter.add(action.value)
    const after = adapter.read()
    if (!after || fingerprint(after) !== action.fingerprint) throw new Refusal('registered entry does not match after add')
    return 'applied'
  }
  const file = found.file
  if (file.exists) backupOnce(run, file.real)
  if (action.type === 'file') {
    atomicWrite(file.real, action.content, action.mode)
    return 'applied'
  }
  const json = found.json || structuredClone(action.base)
  let parent = json
  for (const key of action.entryPath.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {}
    parent = parent[key]
  }
  const key = action.entryPath.at(-1)
  if (action.container === 'object') parent[key] = action.value
  else {
    const list = Array.isArray(parent[key]) ? parent[key] : []
    const index = recorded ? list.findIndex((entry) => fingerprint(entry) === recorded.fingerprint) : -1
    if (index >= 0) list[index] = action.value
    else list.push(action.value)
    parent[key] = list
  }
  const indent = file.exists ? indentOf(file.bytes) : 2
  atomicWrite(file.real, `${JSON.stringify(json, null, indent)}\n`, file.exists ? file.mode : 0o600)
  return 'applied'
}

function newRun(context) {
  return { context, manifest: context.manifest, stamp: new Date().toISOString().replace(/[:.]/g, '-'), backedUp: new Set(), backups: [] }
}

export function applySetup(context, plan) {
  const run = newRun(context)
  for (const action of plan.actions) {
    if (action.status === 'collision' || action.status === 'refuse') {
      action.result = 'skipped'
      continue
    }
    const preState = action.status === 'create' ? 'absent' : 'existing-owned'
    const journaled = run.manifest.items.some((item) => item.id === action.id && item.fingerprint === action.fingerprint)
    try {
      action.result = action.status === 'unchanged' ? 'unchanged' : applyAction(run, action)
      // An unchanged, already journaled item leaves the manifest bytes alone (AC10).
      if (action.result === 'applied' || (action.result === 'unchanged' && !journaled)) recordItem(run, action, preState)
    } catch (error) {
      action.result = 'failed'
      action.reason = failureReason(error)
    }
  }
  context.manifest = run.manifest
  return { ...plan, applied: true, backups: run.backups }
}

// --------------------------------------------------------- status/uninstall

// Codex keys hook trust as "<hooks.json>:user_prompt_submit:<group>:<hook>".
function codexTrusted(context, recorded) {
  try {
    const target = readTarget(recorded.target)
    if (!target.exists) return false
    const list = walk(parseStrictJson(target.bytes), recorded.entryPath) || []
    const index = list.findIndex((entry) => fingerprint(entry) === recorded.fingerprint)
    const toml = fs.readFileSync(path.join(context.paths.codexDir, 'config.toml'), 'utf8')
    for (const match of toml.matchAll(/^\[hooks\.state\."(.+):user_prompt_submit:(\d+):0"\]\s*\n\s*trusted_hash\s*=/gm)) {
      let real = match[1]
      try { real = fs.realpathSync(match[1]) } catch {}
      if (real === target.real && Number(match[2]) === index) return true
    }
  } catch {}
  return false
}

function itemState(context, recorded) {
  try {
    const found = inspect(context, recorded, null)
    if (found.state === 'match') {
      if (recorded.id === 'codex:hook' && !codexTrusted(context, recorded)) return { state: 'pending-trust', found }
      return { state: 'installed', found }
    }
    if (found.state === 'absent') return { state: 'missing', found }
    return { state: 'drifted', found }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    return { state: 'drifted', reason: error.message }
  }
}

// Outdated = the recorded value differs from what setup would write now (e.g.
// the Node binary moved after an upgrade). Without a selection, the recorded
// harnesses and components are re-rendered; collisions need an explicit one.
export function setupStatus(context, selection = null) {
  const recorded = context.manifest.items
  const items = recorded.map((entry) => {
    const { state, reason } = itemState(context, entry)
    return { id: entry.id, kind: entry.kind, target: entry.target, ...(entry.entryPath ? { entryPath: entry.entryPath } : {}), state, ...(reason ? { reason } : {}) }
  })
  const wanted = selection ?? {
    harnesses: HARNESSES.filter((harness) => recorded.some((item) => item.harnesses.includes(harness))),
    components: Object.fromEntries(COMPONENTS.map((component) => [component, recorded.some((item) => item.kind === component)])),
  }
  for (const item of desiredItems(context, wanted)) {
    const known = items.find((entry) => entry.id === item.id)
    if (known) {
      if (['installed', 'pending-trust'].includes(known.state) && recorded.find((entry) => entry.id === item.id).fingerprint !== item.fingerprint) known.state = 'outdated'
      continue
    }
    if (!selection) continue
    const action = planItem(context, item, null)
    if (action.status === 'collision' || action.status === 'refuse') items.push({ id: item.id, kind: item.kind, target: item.target, state: 'collision', reason: action.reason })
  }
  const manifestVault = context.manifest.vault
  return {
    installed: context.manifest.items.length > 0,
    manifest: context.paths.manifest,
    ...(manifestVault && manifestVault !== context.vault ? { otherVault: manifestVault } : {}),
    items,
  }
}

// Doctor view: never fails, only warns.
export function doctorSetup(vault, env = process.env) {
  try {
    const context = makeContext({ vault, env })
    if (!context.manifest.items.length) return { installed: false, warnings: [] }
    const status = setupStatus(context)
    const warnings = status.items.filter((item) => item.state !== 'installed').map((item) => `${item.id}: ${item.state}${item.reason ? ` (${item.reason})` : ''}`)
    if (status.otherVault) warnings.unshift(`manifest points to another vault: ${status.otherVault}`)
    return { installed: true, warnings, items: status.items }
  } catch (error) {
    return { installed: false, warnings: [`setup check failed: ${error.message}`] }
  }
}

function removeAction(run, recorded) {
  const context = run.context
  const { state, found, reason } = itemState(context, recorded)
  if (state === 'missing') {
    dropItem(run, recorded.id)
    return { result: 'already-absent' }
  }
  if (state === 'drifted') return { result: 'kept', reason: reason || 'changed since setup wrote it' }
  if (recorded.type === 'mcp-cli') {
    mcpAdapter(context, recorded.harnesses[0]).remove()
  } else if (recorded.type === 'file') {
    if (readTarget(recorded.target).hash !== found.preimage) return { result: 'changed-during-setup' }
    fs.rmSync(found.file.real)
    const dir = path.dirname(found.file.real)
    if (recorded.kind === 'skill' && path.basename(dir) === 'alambic' && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
  } else {
    const current = readTarget(recorded.target)
    if (current.hash !== found.preimage) return { result: 'changed-during-setup' }
    backupOnce(run, current.real)
    const json = parseStrictJson(current.bytes)
    const parents = [json]
    for (const key of recorded.entryPath.slice(0, -1)) parents.push(parents.at(-1)[key])
    const key = recorded.entryPath.at(-1)
    const parent = parents.at(-1)
    if (Array.isArray(parent[key])) {
      parent[key] = parent[key].filter((entry) => fingerprint(entry) !== recorded.fingerprint)
      if (!parent[key].length) delete parent[key]
    } else delete parent[key]
    // Prune containers emptied on our own path only.
    for (let depth = recorded.entryPath.length - 1; depth >= 1; depth -= 1) {
      const holder = parents[depth - 1]
      const name = recorded.entryPath[depth - 1]
      if (Object.keys(holder[name]).length) break
      delete holder[name]
    }
    atomicWrite(current.real, `${JSON.stringify(json, null, indentOf(current.bytes))}\n`, current.mode)
  }
  dropItem(run, recorded.id)
  return { result: 'removed' }
}

export function uninstallSetup(context, { dryRun = false } = {}) {
  const run = newRun(context)
  const results = []
  for (const recorded of [...context.manifest.items].reverse()) {
    const base = { id: recorded.id, kind: recorded.kind, target: recorded.target, ...(recorded.entryPath ? { entryPath: recorded.entryPath } : {}) }
    if (dryRun) {
      const { state } = itemState(context, recorded)
      results.push({ ...base, result: { installed: 'would-remove', 'pending-trust': 'would-remove', missing: 'already-absent', drifted: 'kept' }[state] })
      continue
    }
    try {
      results.push({ ...base, ...removeAction(run, recorded) })
    } catch (error) {
      results.push({ ...base, result: 'failed', reason: failureReason(error) })
    }
  }
  context.manifest = run.manifest
  return { dryRun, items: results, backups: run.backups }
}

// ------------------------------------------------------------------------ CLI

const where = (item) => `${item.target}${item.entryPath ? ` #${item.entryPath.join('.')}` : ''}${item.reason ? ` (${item.reason})` : ''}`

function actionLine(action) {
  const status = action.result && action.result !== action.status ? `${action.status} -> ${action.result}` : action.status
  return `  ${status.padEnd(12)} ${action.harnesses.join(',').padEnd(18)} ${action.kind.padEnd(6)} ${where(action)}`
}

const publicAction = ({ content, value, base, jsoncSibling, fingerprint: _fp, preimage, mode, container, ...rest }) => rest

function pickerRows(detection, options) {
  return [
    ...HARNESSES.map((harness) => ({ id: harness, group: 'Harnesses', label: harness, hint: detection[harness].detected ? 'detected' : 'not found', checked: options.harness ? selectHarnesses(options.harness, detection).includes(harness) : detection[harness].detected })),
    { id: 'skill', group: 'Components', label: 'skill', hint: 'alambic skill in each harness', checked: options.components.skill },
    { id: 'mcp', group: 'Components', label: 'MCP server', hint: 'vault_search/context/read tools (not pi)', checked: options.components.mcp },
    { id: 'shim', group: 'Components', label: 'CLI shim', hint: '~/.local/bin/alambic', checked: options.components.shim },
    { id: 'hook', group: 'Components', label: 'per-prompt context', hint: 'opt-in: inject matching vault notes on every prompt', checked: options.components.hook },
  ]
}

export async function runSetup({ vault, args, env = process.env, stdin = process.stdin, stdout = process.stdout, node = process.execPath }) {
  const options = parseSetupArgs(args)
  const context = makeContext({ vault, env, node })
  const print = (value) => stdout.write(options.json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`)
  const tty = Boolean(stdin.isTTY && stdout.isTTY)
  const detection = detectHarnesses(env, context.paths)

  if (options.mode === 'status') {
    const status = setupStatus(context, options.harness || !context.manifest.items.length ? { harnesses: selectHarnesses(options.harness, detection), components: options.components } : null)
    if (options.json) print(status)
    else {
      const lines = [`alambic setup status: ${status.installed ? 'installed' : 'not installed'}`, `manifest: ${status.manifest}`]
      if (status.otherVault) lines.push(`warning: manifest points to another vault: ${status.otherVault}`)
      for (const item of status.items) lines.push(`  ${item.state.padEnd(13)} ${item.id.padEnd(14)} ${where(item)}`)
      print(lines.join('\n'))
    }
    return status.items.some((item) => item.state !== 'installed') || status.otherVault ? 1 : 0
  }

  if (options.mode === 'uninstall') {
    const dryRun = options.dryRun || !options.yes
    const report = uninstallSetup(context, { dryRun })
    if (options.json) print(report)
    else {
      const lines = [`alambic setup uninstall${dryRun ? ' (dry-run; add --yes to apply)' : ''}: ${report.items.length} item(s)`]
      for (const item of report.items) lines.push(`  ${item.result.padEnd(15)} ${item.id.padEnd(14)} ${where(item)}`)
      print(lines.join('\n'))
    }
    return report.items.some((item) => ['kept', 'failed', 'changed-during-setup'].includes(item.result)) ? 1 : 0
  }

  let selection = { harnesses: selectHarnesses(options.harness, detection), components: { ...options.components } }
  const interactive = tty && !options.yes && !options.dryRun && !options.json
  if (interactive) {
    const { runPicker } = await import('./checkbox.mjs')
    const rows = await runPicker(pickerRows(detection, options), { input: stdin, output: stdout, title: `alambic setup: ${vault}` })
    if (!rows) {
      print('alambic setup: aborted, nothing written')
      return 130
    }
    const checked = new Set(rows.filter((row) => row.checked).map((row) => row.id))
    selection = { harnesses: HARNESSES.filter((harness) => checked.has(harness)), components: Object.fromEntries(COMPONENTS.map((component) => [component, checked.has(component)])) }
  }
  const dryRun = options.dryRun || (!interactive && !options.yes)
  const plan = planSetup(context, selection)
  const report = dryRun ? plan : applySetup(context, plan)
  if (options.json) print({ mode: dryRun ? 'dry-run' : 'apply', vault, node: context.node, selection, warnings: report.warnings, actions: report.actions.map(publicAction), ...(report.backups ? { backups: report.backups } : {}) })
  else {
    const lines = [`alambic setup: ${dryRun ? 'dry-run' : 'applied'}`, `vault: ${vault}`, `node: ${context.node}`, `harnesses: ${selection.harnesses.join(', ') || 'none'}`]
    if (!report.actions.length) lines.push('  nothing selected')
    lines.push(...report.actions.map(actionLine))
    for (const action of report.actions.filter((item) => item.snippet)) lines.push(`  add manually to ${action.snippet.file} at ${action.snippet.key}:`, `    ${JSON.stringify(action.snippet.value)}`)
    for (const warning of report.warnings) lines.push(`warning: ${warning}`)
    if (report.backups?.length) lines.push(`backups: ${report.backups.join(', ')}`)
    if (dryRun && !options.dryRun) lines.push(tty ? 'next: rerun with --yes to apply' : 'not a TTY: dry-run only; rerun with --yes to apply')
    print(lines.join('\n'))
  }
  const bad = report.actions.some((action) => ['collision', 'refuse'].includes(action.status) || ['failed', 'changed-during-setup'].includes(action.result))
  return bad ? 1 : 0
}
