#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESSES, applySetup, desiredItems, doctorSetup, makeContext, parseSetupArgs, planSetup, runSetup, selectHarnesses, detectHarnesses, setupStatus } from '../lib/setup.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-setup-')))
const CANARY = `canary-${crypto.randomBytes(8).toString('hex')}`
const stubBin = path.join(temp, 'bin')
const log = path.join(temp, 'argv.jsonl')

const CLAUDE_STUB = `#!${process.execPath}
const fs = require('fs'), path = require('path')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ bin: 'claude', argv }) + '\\n')
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json')
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
const write = (json) => fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\\n')
const named = (value) => /^alambic(-[a-z0-9-]+)?$/.test(value || '')
if (argv[0] === 'mcp' && argv[1] === 'add' && argv[2] === '-s' && argv[3] === 'user' && named(argv[4])) {
  const name = argv[4]
  if (process.env.STUB_FAIL === 'claude:add' || process.env.STUB_FAIL === 'claude:add:' + argv[argv.indexOf('--') + 1]) { process.stderr.write('boom ' + process.env.STUB_CANARY); process.exit(5) }
  const sep = argv.indexOf('--')
  const env = {}
  for (let i = 5; i < sep; i += 2) { if (argv[i] !== '-e') process.exit(98); const [k, ...v] = argv[i + 1].split('='); env[k] = v.join('=') }
  const json = read()
  if (json.mcpServers?.[name]) { process.stderr.write('already exists'); process.exit(1) }
  json.mcpServers = { ...json.mcpServers, [name]: { type: 'stdio', command: argv[sep + 1], args: argv.slice(sep + 2), env } }
  write(json)
} else if (argv.length === 5 && argv.slice(0, 4).join(' ') === 'mcp remove -s user' && named(argv[4])) {
  const json = read(); delete json.mcpServers[argv[4]]; write(json)
} else process.exit(97)
`
const CODEX_STUB = `#!${process.execPath}
const fs = require('fs'), path = require('path')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ bin: 'codex', argv }) + '\\n')
const file = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'stub-mcp.json')
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
const write = (json) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(json)) }
const cmd = argv.join(' ')
const named = (value) => /^alambic(-[a-z0-9-]+)?$/.test(value || '')
if (cmd === 'features list') process.stdout.write('apply_patch  stable  true\\nhooks  stable  ' + (process.env.STUB_CODEX_HOOKS || 'true') + '\\n')
else if (argv.length === 4 && argv[0] === 'mcp' && argv[1] === 'get' && named(argv[2]) && argv[3] === '--json') {
  const entry = read()[argv[2]]
  if (!entry) { process.stderr.write("Error: No MCP server named '" + argv[2] + "' found."); process.exit(1) }
  process.stdout.write(JSON.stringify({ name: argv[2], enabled: true, transport: { type: 'stdio', ...entry } }))
} else if (argv[0] === 'mcp' && argv[1] === 'add' && named(argv[2])) {
  const sep = argv.indexOf('--')
  const env = {}
  for (let i = 3; i < sep; i += 2) { if (argv[i] !== '--env') process.exit(98); const [k, ...v] = argv[i + 1].split('='); env[k] = v.join('=') }
  write({ ...read(), [argv[2]]: { command: argv[sep + 1], args: argv.slice(sep + 2), env } })
} else if (argv.length === 3 && argv[0] === 'mcp' && argv[1] === 'remove' && named(argv[2])) {
  const json = read(); delete json[argv[2]]; write(json)
} else process.exit(97)
`

function writeExec(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode: 0o755 })
}
function freshHome(name) {
  const home = path.join(temp, name)
  fs.mkdirSync(home, { recursive: true })
  return home
}
function envFor(home, extra = {}) {
  return { HOME: home, PATH: `${stubBin}:/usr/bin:/bin`, STUB_LOG: log, STUB_CANARY: CANARY, ...extra }
}
function calls(bin) {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !bin || entry.bin === bin)
}
function resetLog() { fs.rmSync(log, { force: true }) }
async function setup(vault, args, env, node = process.execPath) {
  let out = ''
  const code = await runSetup({ vault, args, env, node, stdin: { isTTY: false }, stdout: { isTTY: false, write: (chunk) => { out += chunk } } })
  return { code, out, json: args.includes('--json') ? JSON.parse(out) : null }
}
function snapshot(dir) {
  const result = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) result[full] = `link:${fs.readlinkSync(full)}`
      else if (entry.isDirectory()) walk(full)
      else result[full] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return result
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const mode = (file) => fs.statSync(file).mode & 0o777
const byId = (report) => Object.fromEntries(report.actions.map((action) => [action.id, action]))

try {
  writeExec(path.join(stubBin, 'claude'), CLAUDE_STUB)
  writeExec(path.join(stubBin, 'codex'), CODEX_STUB)
  for (const name of ['pi', 'opencode', 'cursor-agent']) writeExec(path.join(stubBin, name), '#!/bin/sh\nexit 97\n')

  const vault = path.join(temp, "my va'ult")
  writeExec(path.join(vault, '_meta/alambic.mjs'), "console.log('cli:' + process.argv.slice(2).join('|'))\n")
  writeExec(path.join(vault, '_meta/hooks/prompt-context.mjs'), "console.log('hook:' + process.argv.slice(2).join('|'))\n")

  assert(parseSetupArgs(['--yes']).harness === null && parseSetupArgs(['--harness=pi,codex']).harness === 'pi,codex', 'arg parsing')
  let threw = false
  try { parseSetupArgs(['--bogus']) } catch { threw = true }
  assert(threw, 'unknown argument must throw')
  threw = false
  try { selectHarnesses('claude,nope', {}) } catch { threw = true }
  assert(threw, 'unknown harness must throw')

  const home = freshHome('home')
  const env = envFor(home)
  const detection = detectHarnesses(env)
  assert(Object.values(detection).every((entry) => entry.detected && entry.binary.startsWith(stubBin)), 'stubs must be detected, from the stub dir only')
  const before = snapshot(home)
  const dry = await setup(vault, ['--harness', 'all', '--prompt-hook', '--json'], env)
  assert(dry.json.mode === 'dry-run' && JSON.stringify(snapshot(home)) === JSON.stringify(before), 'dry-run must write nothing')
  assert(calls().every((entry) => /^(mcp get alambic --json|features list)$/.test(entry.argv.join(' '))), 'dry-run may only read')
  assert(!fs.existsSync(path.join(home, '.claude.json')), 'dry-run touched .claude.json')
  for (const action of dry.json.actions) assert(action.type === 'mcp-cli' || action.target.startsWith(temp), `target escapes the temp root: ${action.target}`)
  assert(dry.json.actions.every((action) => !('content' in action) && !('value' in action)), 'json output leaks internals')

  resetLog()
  const installed = await setup(vault, ['--yes', '--harness', 'all', '--prompt-hook', '--json'], env)
  assert(installed.code === 0 && installed.json.actions.every((action) => action.result === 'applied'), `install failed: ${JSON.stringify(installed.json.actions.filter((a) => a.result !== 'applied'))}`)
  const claudeSkill = fs.readFileSync(path.join(home, '.claude/skills/alambic/SKILL.md'), 'utf8')
  assert(claudeSkill.includes(vault) && claudeSkill.startsWith('---\nname: alambic'), 'claude skill wrong')
  assert(fs.readFileSync(path.join(home, '.agents/skills/alambic/SKILL.md'), 'utf8') === claudeSkill, 'shared skill wrong')
  const server = path.join(vault, '_meta/mcp/server.mjs')
  const claudeAdd = calls('claude').find((entry) => entry.argv[1] === 'add').argv
  assert(JSON.stringify(claudeAdd) === JSON.stringify(['mcp', 'add', '-s', 'user', 'alambic', '-e', `ALAMBIC_ROOT=${vault}`, '--', process.execPath, server]), `claude argv wrong: ${claudeAdd}`)
  assert(readJson(path.join(home, '.claude.json')).mcpServers.alambic.env.ALAMBIC_ROOT === vault, 'claude mcp missing')
  assert(readJson(path.join(home, '.codex/stub-mcp.json')).alambic.command === process.execPath, 'codex mcp missing')
  const opencode = readJson(path.join(home, '.config/opencode/opencode.json'))
  assert(opencode.$schema && opencode.mcp.alambic.command[0] === process.execPath && opencode.mcp.alambic.environment.ALAMBIC_ROOT === vault, 'opencode mcp wrong')
  assert(readJson(path.join(home, '.cursor/mcp.json')).mcpServers.alambic.args[0] === server, 'cursor mcp wrong')
  const shim = path.join(home, '.local/bin/alambic')
  assert(mode(shim) === 0o755, 'shim must be 0755')
  assert(spawnSync(shim, ['a b', "c'd"], { encoding: 'utf8' }).stdout.trim() === "cli:a b|c'd", 'shim quoting broken')
  const claudeHook = readJson(path.join(home, '.claude/settings.json')).hooks.UserPromptSubmit[0].hooks[0]
  assert(claudeHook.timeout === 5 && spawnSync('/bin/sh', ['-c', claudeHook.command], { encoding: 'utf8' }).stdout.trim() === 'hook:--format|claude', 'claude hook command broken')
  assert(readJson(path.join(home, '.codex/hooks.json')).hooks.UserPromptSubmit[0].hooks[0].command.endsWith('--format codex'), 'codex hook wrong')
  const cursorHooks = readJson(path.join(home, '.cursor/hooks.json'))
  assert(cursorHooks.version === 1 && cursorHooks.hooks.beforeSubmitPrompt[0].command.endsWith('--format cursor') && cursorHooks.hooks.beforeSubmitPrompt[0].timeout === 5, 'cursor hook wrong')
  assert(fs.readFileSync(path.join(home, '.pi/agent/extensions/alambic-context.ts'), 'utf8').includes(JSON.stringify(path.join(vault, '_meta/hooks/prompt-context.mjs'))), 'pi extension wrong')
  assert(fs.existsSync(path.join(home, '.config/opencode/plugins/alambic-context.js')), 'opencode plugin missing')
  assert(mode(path.join(home, '.claude/settings.json')) === 0o600, 'new config files must be 0600')
  const manifestFile = path.join(home, '.local/state/alambic/setup.json')
  assert(mode(manifestFile) === 0o600 && mode(path.dirname(manifestFile)) === 0o700, 'manifest modes wrong')
  const manifest = readJson(manifestFile)
  assert(manifest.vault === vault && manifest.items.length === installed.json.actions.length, 'manifest incomplete')
  assert(installed.json.warnings.some((warning) => warning.includes('pending-trust')) && installed.json.warnings.some((warning) => warning.includes('not on PATH')), 'expected warnings missing')

  resetLog()
  const stable = snapshot(home)
  const again = await setup(vault, ['--yes', '--harness', 'all', '--prompt-hook', '--json'], env)
  assert(again.code === 0 && again.json.actions.every((action) => action.status === 'unchanged'), 'second run must be unchanged')
  assert(JSON.stringify(snapshot(home)) === JSON.stringify(stable), 'second run changed bytes')
  assert(!calls().some((entry) => /add|remove/.test(entry.argv[1])), 'second run called a mutating CLI')

  let status = setupStatus(makeContext({ vault, env }))
  assert(status.items.find((item) => item.id === 'codex:hook').state === 'pending-trust', 'codex hook should be pending-trust')
  assert(status.items.filter((item) => item.id !== 'codex:hook').every((item) => item.state === 'installed'), 'items should be installed')
  fs.symlinkSync(path.join(home, '.codex/hooks.json'), path.join(temp, 'hooks-link.json'))
  fs.writeFileSync(path.join(home, '.codex/config.toml'), `[hooks.state."${path.join(temp, 'hooks-link.json')}:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:x"\n`)
  status = setupStatus(makeContext({ vault, env }))
  assert(status.items.find((item) => item.id === 'codex:hook').state === 'installed', 'trusted codex hook (symlinked key) should be installed')
  fs.appendFileSync(path.join(home, '.agents/skills/alambic/SKILL.md'), '\nuser edit\n')
  status = setupStatus(makeContext({ vault, env }))
  assert(status.items.find((item) => item.id === 'agents:skill').state === 'drifted', 'edited skill should be drifted')
  const codexMcp = path.join(home, '.codex/stub-mcp.json')
  const codexBefore = fs.readFileSync(codexMcp, 'utf8')
  fs.writeFileSync(codexMcp, JSON.stringify({ alambic: { ...readJson(codexMcp).alambic, cwd: '/somewhere' } }))
  status = setupStatus(makeContext({ vault, env }))
  fs.writeFileSync(codexMcp, codexBefore)
  assert(status.items.find((item) => item.id === 'codex:mcp').state === 'drifted', 'customised codex mcp should be drifted')
  const statusRun = await setup(vault, ['--status'], env)
  assert(statusRun.code === 1 && statusRun.out.includes('drifted'), 'status must fail on drift')
  fs.renameSync(shim, `${shim}.away`)
  const missingRun = await setup(vault, ['--status', '--json'], env)
  fs.renameSync(`${shim}.away`, shim)
  assert(missingRun.code === 1 && missingRun.json.items.find((item) => item.id === 'cli:shim').state === 'missing', 'status must report a deleted target as missing')

  const node3 = path.join(temp, 'node-bad/node')
  fs.mkdirSync(path.dirname(node3))
  fs.symlinkSync(process.execPath, node3)
  const failedUpdate = await setup(vault, ['--yes', '--harness', 'claude', '--no-skill', '--no-shim', '--json'], envFor(home, { STUB_FAIL: `claude:add:${node3}` }), node3)
  assert(failedUpdate.code === 1 && byId(failedUpdate.json)['claude:mcp'].result === 'failed' && readJson(path.join(home, '.claude.json')).mcpServers.alambic.command === process.execPath, 'a failed update must restore the previous MCP entry')
  resetLog()
  const node2 = path.join(temp, 'node-bin/node')
  fs.mkdirSync(path.dirname(node2))
  fs.symlinkSync(process.execPath, node2)
  const moved = await setup(vault, ['--yes', '--harness', 'claude,codex', '--no-skill', '--json'], env, node2)
  const movedActions = byId(moved.json)
  assert(movedActions['claude:mcp'].status === 'update' && movedActions['codex:mcp'].status === 'update' && movedActions['cli:shim'].status === 'update', 'owned items should update')
  for (const bin of ['claude', 'codex']) {
    const ops = calls(bin).map((entry) => entry.argv[1]).filter((op) => op === 'add' || op === 'remove')
    assert(ops.join() === 'remove,add', `${bin} update must remove then add (${ops})`)
  }
  assert(fs.readFileSync(shim, 'utf8').includes(node2) && moved.json.backups.some((file) => file.startsWith(`${shim}.bak.`)), 'shim should update with a backup')
  for (const file of moved.json.backups) assert(mode(file) === 0o600, 'backups must be 0600')

  const settingsFile = path.join(home, '.claude/settings.json')
  const settings = readJson(settingsFile)
  settings.theme = 'dark'
  settings.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo stop' }] }]
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  const piExtension = path.join(home, '.pi/agent/extensions/alambic-context.ts')
  const piCopy = path.join(temp, 'pi-copy.ts')
  fs.copyFileSync(piExtension, piCopy)
  fs.rmSync(piExtension)
  fs.symlinkSync(piCopy, piExtension)
  const preview = snapshot(home)
  const unDry = await setup(vault, ['--uninstall'], env)
  assert(unDry.out.includes('dry-run') && JSON.stringify(snapshot(home)) === JSON.stringify(preview), 'uninstall without --yes must be a dry-run')
  resetLog()
  const removed = await setup(vault, ['--uninstall', '--yes', '--json'], env)
  const removedById = Object.fromEntries(removed.json.items.map((item) => [item.id, item]))
  assert(removedById['agents:skill'].result === 'kept' && fs.existsSync(path.join(home, '.agents/skills/alambic/SKILL.md')), 'drifted skill must be kept')
  assert(removedById['claude:skill'].result === 'removed' && !fs.existsSync(path.join(home, '.claude/skills/alambic')), 'owned skill and its dir must be removed')
  const afterSettings = readJson(settingsFile)
  assert(afterSettings.theme === 'dark' && afterSettings.hooks.Stop && !afterSettings.hooks.UserPromptSubmit, 'uninstall must keep foreign settings')
  assert(!readJson(path.join(home, '.cursor/hooks.json')).hooks, 'emptied hook container on our path should be pruned')
  assert(!('alambic' in readJson(path.join(home, '.claude.json')).mcpServers) && calls('claude').some((entry) => entry.argv[1] === 'remove'), 'claude mcp must be removed')
  assert(removed.code === 1, 'uninstall with a kept item exits 1')
  assert(removedById['pi:hook'].result === 'kept' && fs.existsSync(piCopy), 'a symlinked file must be kept, its target untouched')
  assert(readJson(manifestFile).items.map((item) => item.id).join() === 'agents:skill,pi:hook', 'manifest keeps only the kept items')

  const home2 = freshHome('home2')
  const env2 = envFor(home2)
  const dotfiles = path.join(temp, 'dotfiles')
  fs.mkdirSync(path.join(dotfiles, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true })
  const foreignSettings = { env: { TOKEN: CANARY }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }
  fs.writeFileSync(path.join(dotfiles, 'settings.json'), JSON.stringify(foreignSettings, null, 4), { mode: 0o640 })
  fs.symlinkSync(path.join(dotfiles, 'settings.json'), path.join(home2, '.claude/settings.json'))
  fs.mkdirSync(path.join(home2, '.agents'), { recursive: true })
  fs.symlinkSync(path.join(dotfiles, 'skills'), path.join(home2, '.agents/skills'))
  fs.mkdirSync(path.join(home2, '.claude/skills/alambic'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.claude/skills/alambic/SKILL.md'), 'my own skill\n')
  fs.writeFileSync(path.join(home2, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x', env: { KEY: CANARY } } } }))
  fs.mkdirSync(path.join(home2, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.codex/stub-mcp.json'), JSON.stringify({ alambic: { command: '/elsewhere/node', args: [], env: { K: CANARY } } }))
  fs.mkdirSync(path.join(home2, '.config/opencode'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.config/opencode/opencode.jsonc'), `{ // ${CANARY}\n}`)
  fs.mkdirSync(path.join(home2, '.cursor'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.cursor/mcp.json'), `{ "mcpServers": { "x": { "env": { "T": "${CANARY}" } }, }`)
  resetLog()
  const foreign = await setup(vault, ['--yes', '--harness', 'all', '--prompt-hook', '--json'], env2)
  const foreignActions = byId(foreign.json)
  assert(foreign.code === 1, 'collisions must exit 1')
  assert(foreignActions['claude:skill'].status === 'collision' && fs.readFileSync(path.join(home2, '.claude/skills/alambic/SKILL.md'), 'utf8') === 'my own skill\n', 'foreign skill must not be overwritten')
  assert(foreignActions['codex:mcp'].status === 'collision' && !calls('codex').some((entry) => entry.argv[1] === 'add'), 'foreign codex mcp must not be replaced')
  assert(foreignActions['opencode:mcp'].status === 'refuse' && foreignActions['cursor:mcp'].status === 'refuse', 'JSONC configs must be refused')
  assert(foreignActions['claude:hook'].result === 'applied', 'claude hook should merge beside the foreign hook')
  assert(fs.lstatSync(path.join(home2, '.claude/settings.json')).isSymbolicLink(), 'symlinked settings must stay a symlink')
  const merged = readJson(path.join(dotfiles, 'settings.json'))
  assert(merged.env.TOKEN === CANARY && merged.hooks.UserPromptSubmit.length === 2 && merged.hooks.UserPromptSubmit[0].hooks[0].command === 'other-tool', 'foreign hook must be preserved')
  assert(fs.readFileSync(path.join(dotfiles, 'settings.json'), 'utf8').startsWith('{\n    "env"') && mode(path.join(dotfiles, 'settings.json')) === 0o640, 'indent and mode must be kept')
  assert(fs.lstatSync(path.join(home2, '.agents/skills')).isSymbolicLink() && fs.existsSync(path.join(dotfiles, 'skills/alambic/SKILL.md')), 'skill must land through the symlinked dir')
  const settingsBackup = foreign.json.backups.find((file) => file.startsWith(path.join(dotfiles, 'settings.json.bak.')))
  assert(settingsBackup && mode(settingsBackup) === 0o600 && readJson(settingsBackup).hooks.UserPromptSubmit.length === 1, 'settings backup must be the 0600 preimage')
  const foreignManifest = fs.readFileSync(path.join(home2, '.local/state/alambic/setup.json'), 'utf8')
  assert(!foreign.out.includes(CANARY) && !foreignManifest.includes(CANARY), 'foreign secret leaked to output or manifest')
  const textRun = await setup(vault, ['--harness', 'all', '--prompt-hook'], env2)
  assert(!textRun.out.includes(CANARY) && textRun.out.includes('add manually to'), 'text dry-run must print snippets, never secrets')
  const foreignStatus = await setup(vault, ['--status', '--json', '--harness', 'claude'], env2)
  const foreignSkill = foreignStatus.json.items.find((item) => item.id === 'claude:skill')
  assert(foreignStatus.code === 1 && foreignSkill?.state === 'collision' && !foreignStatus.out.includes(CANARY), `status must report the foreign skill as a collision: ${JSON.stringify(foreignSkill)}`)

  const partialBin = path.join(temp, 'bin-partial')
  for (const name of ['pi', 'opencode']) writeExec(path.join(partialBin, name), '#!/bin/sh\nexit 97\n')
  const bareHome = freshHome('home-bare')
  const bare = await setup(vault, ['--yes', '--json'], { ...envFor(bareHome), PATH: `${partialBin}:/usr/bin:/bin` })
  assert(bare.code === 0 && bare.json.mode === 'apply' && bare.json.selection.harnesses.join() === 'pi,opencode', `bare --yes must select the detected harnesses: ${JSON.stringify(bare.json.selection)}`)
  assert(!bare.json.selection.components.hook && !bare.json.actions.some((action) => action.id.endsWith(':hook')), 'bare --yes must leave the prompt hook off')

  const adoptHome = freshHome('home-adopt')
  const adoptEnv = envFor(adoptHome)
  await setup(vault, ['--yes', '--harness', 'cursor', '--no-skill', '--no-shim', '--json'], adoptEnv)
  fs.rmSync(path.join(adoptHome, '.local/state/alambic/setup.json'))
  const adopted = await setup(vault, ['--yes', '--harness', 'cursor', '--no-skill', '--no-shim', '--json'], adoptEnv)
  assert(byId(adopted.json)['cursor:mcp'].status === 'unchanged', 'identical foreign entry should plan as unchanged')
  const unAdoptDry = await setup(vault, ['--uninstall', '--json'], adoptEnv)
  const unAdopt = await setup(vault, ['--uninstall', '--yes', '--json'], adoptEnv)
  assert(unAdoptDry.json.items[0].result === 'would-leave' && unAdopt.code === 0 && unAdopt.json.items[0].result === 'left', `preexisting entry must be left: ${JSON.stringify(unAdopt.json.items)}`)
  assert(readJson(path.join(adoptHome, '.cursor/mcp.json')).mcpServers.alambic, 'preexisting entry must survive uninstall')

  const home3 = freshHome('home3')
  const env3 = envFor(home3, { STUB_FAIL: 'claude:add' })
  const partial = await setup(vault, ['--yes', '--harness', 'claude,codex', '--json'], env3)
  const partialActions = byId(partial.json)
  assert(partial.code === 1 && partialActions['claude:mcp'].result === 'failed' && /exit 5/.test(partialActions['claude:mcp'].reason), 'claude add failure should be reported by exit code')
  assert(!partial.out.includes(CANARY), 'CLI stderr leaked')
  const journal = readJson(path.join(home3, '.local/state/alambic/setup.json')).items.map((item) => item.id).sort()
  assert(journal.join() === ['agents:skill', 'claude:skill', 'cli:shim', 'codex:mcp'].sort().join(), `journal mismatch: ${journal}`)

  const home4 = freshHome('home4')
  const env4 = envFor(home4)
  fs.mkdirSync(path.join(home4, '.cursor'), { recursive: true })
  fs.writeFileSync(path.join(home4, '.cursor/mcp.json'), '{"mcpServers":{}}')
  const context4 = makeContext({ vault, env: env4 })
  const plan = planSetup(context4, { harnesses: ['cursor'], components: { skill: false, mcp: true, shim: false, hook: false } })
  fs.writeFileSync(path.join(home4, '.cursor/mcp.json'), '{"mcpServers":{"late":{}}}')
  const raced = applySetup(context4, plan)
  assert(raced.actions[0].result === 'changed-during-setup' && fs.readFileSync(path.join(home4, '.cursor/mcp.json'), 'utf8') === '{"mcpServers":{"late":{}}}', 'concurrent edit must win')

  fs.mkdirSync(path.join(home4, '.codex'), { recursive: true })
  const otherHook = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: "node '/other/vault/_meta/hooks/prompt-context.mjs' --format codex" }] }] } })
  fs.writeFileSync(path.join(home4, '.codex/hooks.json'), otherHook)
  const twin = await setup(vault, ['--yes', '--harness', 'codex', '--prompt-hook', '--no-mcp', '--no-skill', '--no-shim', '--json'], env4)
  assert(twin.code === 1 && byId(twin.json)['codex:hook'].status === 'collision' && /another alambic hook/.test(byId(twin.json)['codex:hook'].reason), 'second alambic hook must collide')
  assert(fs.readFileSync(path.join(home4, '.codex/hooks.json'), 'utf8') === otherHook, 'colliding hooks.json must be untouched')

  const home5 = freshHome('home5')
  const env5 = envFor(home5, { CLAUDE_CONFIG_DIR: path.join(temp, 'claude-cfg'), CODEX_HOME: path.join(temp, 'codex-cfg'), STUB_CODEX_HOOKS: 'false' })
  const custom = await setup(vault, ['--yes', '--harness', 'claude,codex', '--prompt-hook', '--no-shim', '--json'], env5)
  assert(fs.existsSync(path.join(temp, 'claude-cfg/skills/alambic/SKILL.md')) && fs.existsSync(path.join(temp, 'claude-cfg/.claude.json')) && fs.existsSync(path.join(temp, 'codex-cfg/hooks.json')), 'custom config dirs ignored')
  assert(custom.json.warnings.some((warning) => warning.includes('codex hooks are disabled')), 'disabled codex hooks must be reported')

  const pi = await setup(vault, ['--harness', 'pi', '--json'], envFor(freshHome('home6')))
  assert(pi.json.actions.every((action) => action.kind !== 'mcp') && pi.json.warnings.some((warning) => warning.includes('pi has no MCP')), 'pi must not get MCP')

  assert(JSON.stringify(doctorSetup(vault, envFor(freshHome('home7')))) === JSON.stringify({ installed: false, warnings: [] }), 'fresh home: not installed, no warning')
  const drift = doctorSetup(vault, env)
  assert(drift.installed && drift.warnings.some((warning) => warning.startsWith('agents:skill: drifted')), 'doctor must warn on drift')
  assert(doctorSetup(path.join(temp, 'other-vault'), env).warnings[0].startsWith('manifest points to another vault'), 'doctor must warn on another vault')
  const home8 = freshHome('home8')
  await setup(vault, ['--yes', '--harness', 'codex', '--prompt-hook', '--no-mcp', '--json'], envFor(home8), node2)
  const stale = doctorSetup(vault, envFor(home8)).warnings
  assert(stale.includes('cli:shim: outdated') && stale.includes('codex:hook: outdated') && !stale.some((warning) => warning.startsWith('agents:skill')), `doctor must flag Node-path drift: ${stale}`)
  const staleStatus = await setup(vault, ['--status', '--json'], envFor(home8))
  const staleState = Object.fromEntries(staleStatus.json.items.map((item) => [item.id, item.state]))
  assert(staleStatus.code === 1 && staleState['cli:shim'] === 'outdated' && staleState['codex:hook'] === 'outdated' && staleState['agents:skill'] === 'installed', `status must flag Node-path drift: ${JSON.stringify(staleState)}`)
  const home9 = freshHome('home9')
  await setup(vault, ['--yes', '--harness', 'codex', '--prompt-hook', '--no-mcp', '--json'], envFor(home9))
  assert(doctorSetup(vault, envFor(home9)).warnings.join() === 'codex:hook: pending-trust', 'doctor must report pending-trust only')

  const DEFAULT_ITEMS_SHA = '5282d4916238467307a8dc3c014613b4f16bfb697bc613bd0369fa36597cdc95'
  const goldenItems = desiredItems(makeContext({ vault: '/fixed/vault', node: process.execPath, env: { HOME: '/fixed/home', PATH: '/usr/bin' } }), { harnesses: HARNESSES, components: { skill: true, mcp: true, shim: true, hook: true } }).map(({ fingerprint, ...item }) => item)
  assert(crypto.createHash('sha256').update(JSON.stringify(goldenItems).replaceAll(process.execPath, '<node>')).digest('hex') === DEFAULT_ITEMS_SHA, 'default setup items drifted from their frozen fingerprint')
  assert(claudeSkill.includes('\n# alambic vault\n') && claudeSkill.includes('description: Query the alambic vault (a compiled'), 'default skill must keep its alambic identity')
  for (const args of [['--vault', vault], ['--name', 'Bad'], ['--name', 'x'.repeat(40)], ['--name', 'brain', '--prompt-hook'], ['--name']]) {
    threw = false
    try { parseSetupArgs(args) } catch { threw = true }
    assert(threw, `setup must refuse ${args.join(' ')}`)
  }
  const engine = path.join(temp, 'engine')
  writeExec(path.join(engine, '_meta/alambic.mjs'), "console.log([process.env.ALAMBIC_ROOT, process.env.ALAMBIC_STATE_DIR, ...process.argv.slice(2)].join('|'))\n")
  writeExec(path.join(engine, '_meta/alambic'), `#!/bin/sh\nexec '${process.execPath}' "$(dirname "$0")/alambic.mjs" "$@"\n`)
  const brain = path.join(temp, "br'ain")
  fs.mkdirSync(path.join(brain, 'kb'), { recursive: true })
  const homeN = freshHome('home-named')
  const envN = envFor(homeN)
  for (const bad of [path.join(temp, 'missing'), engine]) {
    threw = false
    try { await setup(engine, ['--yes', '--name', 'brain', '--vault', bad], envN) } catch { threw = true }
    assert(threw, `--vault must refuse ${bad}`)
  }
  resetLog()
  const namedRun = await setup(engine, ['--yes', '--harness', 'claude,codex,opencode,cursor', '--name', 'brain', '--vault', brain, '--json'], envN)
  assert(namedRun.code === 0 && namedRun.json.vault === brain && namedRun.json.engine === engine && namedRun.json.name === 'brain', `named install failed: ${namedRun.out}`)
  const pinned = { ALAMBIC_ROOT: brain, ALAMBIC_STATE_DIR: path.join(homeN, '.local/state/alambic-brain') }
  const namedServer = path.join(engine, '_meta/mcp/server.mjs')
  const namedAdd = calls('claude').find((entry) => entry.argv[1] === 'add').argv
  assert(JSON.stringify(namedAdd) === JSON.stringify(['mcp', 'add', '-s', 'user', 'alambic-brain', '-e', `ALAMBIC_ROOT=${brain}`, '-e', `ALAMBIC_STATE_DIR=${pinned.ALAMBIC_STATE_DIR}`, '--', process.execPath, namedServer]), `named claude argv wrong: ${namedAdd}`)
  assert(!readJson(path.join(homeN, '.claude.json')).mcpServers.alambic, 'named setup must not register the default MCP')
  assert(JSON.stringify(readJson(path.join(homeN, '.codex/stub-mcp.json'))['alambic-brain'].env) === JSON.stringify(pinned), 'named codex env wrong')
  const namedOpencode = readJson(path.join(homeN, '.config/opencode/opencode.json')).mcp['alambic-brain']
  assert(namedOpencode.command[1] === namedServer && JSON.stringify(namedOpencode.environment) === JSON.stringify(pinned), 'named opencode entry wrong')
  assert(JSON.stringify(readJson(path.join(homeN, '.cursor/mcp.json')).mcpServers['alambic-brain'].env) === JSON.stringify(pinned), 'named cursor entry wrong')
  const namedSkill = fs.readFileSync(path.join(homeN, '.claude/skills/alambic-brain/SKILL.md'), 'utf8')
  assert(namedSkill.startsWith('---\nname: alambic-brain\n') && namedSkill.includes('\n# brain vault\n') && namedSkill.includes(`Vault: \`${brain}\``), 'named skill identity wrong')
  const namedCli = /^(.*) session --json/m.exec(namedSkill)?.[1]
  assert(namedCli && spawnSync('/bin/sh', ['-c', `${namedCli} q`], { encoding: 'utf8' }).stdout.trim() === `${brain}|${pinned.ALAMBIC_STATE_DIR}|q`, `named skill CLI must pin root and state: ${namedCli}`)
  assert(fs.readFileSync(path.join(homeN, '.agents/skills/alambic-brain/SKILL.md'), 'utf8') === namedSkill, 'named shared skill wrong')
  const namedShim = path.join(homeN, '.local/bin/alambic-brain')
  assert(mode(namedShim) === 0o755 && spawnSync(namedShim, ['a b'], { encoding: 'utf8' }).stdout.trim() === `${brain}|${pinned.ALAMBIC_STATE_DIR}|a b`, 'named shim must pin root and state')
  assert(!fs.existsSync(path.join(homeN, '.local/bin/alambic')) && !fs.existsSync(path.join(homeN, '.local/state/alambic/setup.json')), 'named setup must not touch the default shim or manifest')
  const namedManifest = readJson(path.join(homeN, '.local/state/alambic/setup-brain.json'))
  assert(namedManifest.name === 'brain' && namedManifest.vault === brain && namedManifest.engine === engine, 'named manifest wrong')
  const namedStatus = await setup(engine, ['--status', '--name', 'brain', '--json'], envN)
  assert(namedStatus.code === 0 && namedStatus.json.installed && !namedStatus.json.otherVault, `named status must resolve the vault from its manifest: ${namedStatus.out}`)
  assert(JSON.stringify(doctorSetup(brain, envN)) === JSON.stringify({ installed: true, warnings: [], items: namedStatus.json.items }), 'doctor must find the named manifest for its vault')
  assert(JSON.stringify(doctorSetup(engine, envN)) === JSON.stringify({ installed: false, warnings: [] }), 'doctor must ignore named manifests of other vaults')

  const defaultRun = await setup(engine, ['--yes', '--harness', 'claude', '--no-shim', '--json'], envN)
  const selfRun = await setup(engine, ['--yes', '--harness', 'claude', '--no-shim', '--name', 'self', '--json'], envN)
  assert(defaultRun.code === 0 && selfRun.code === 0 && selfRun.json.vault === engine, 'default and self-named setups must coexist')
  assert(Object.keys(readJson(path.join(homeN, '.claude.json')).mcpServers).sort().join() === 'alambic,alambic-brain,alambic-self', 'handles must stay separate')
  assert(doctorSetup(brain, envN).warnings.length === 0, 'default manifest of another vault must not warn when a named one matches')
  const both = doctorSetup(engine, envN)
  assert(both.installed && both.warnings.length === 0 && both.items.length === 4, `doctor must aggregate default and named setups: ${JSON.stringify(both)}`)
  const namedSkillFile = path.join(homeN, '.claude/skills/alambic-brain/SKILL.md')
  fs.writeFileSync(namedSkillFile, 'edited\n')
  assert(doctorSetup(brain, envN).warnings.includes('alambic-brain: claude:skill: drifted'), 'doctor must prefix named warnings with the handle')
  fs.writeFileSync(namedSkillFile, namedSkill)
  const brokenManifest = path.join(homeN, '.local/state/alambic/setup-broken.json')
  fs.writeFileSync(brokenManifest, '{')
  const poisoned = doctorSetup(engine, envN)
  assert(poisoned.installed && poisoned.items.length === 4 && poisoned.warnings.length === 1 && poisoned.warnings[0].startsWith('alambic-broken: setup check failed'), `a corrupt named manifest must not hide healthy setups: ${JSON.stringify(poisoned.warnings)}`)
  fs.rmSync(brokenManifest)
  const selfManifest = path.join(homeN, '.local/state/alambic/setup-self.json')
  const selfBytes = fs.readFileSync(selfManifest)
  fs.writeFileSync(selfManifest, JSON.stringify({ ...readJson(selfManifest), node: path.join(temp, 'gone/node') }))
  const goneNode = doctorSetup(engine, envN)
  assert(goneNode.installed && goneNode.items.length === 2 && goneNode.warnings.length === 1 && goneNode.warnings[0].startsWith('alambic-self: setup check failed'), `a named setup with a vanished node must not hide the default one: ${JSON.stringify(goneNode.warnings)}`)
  fs.writeFileSync(selfManifest, selfBytes)
  const brainLink = path.join(temp, 'brain-link')
  fs.symlinkSync(brain, brainLink)
  const viaLink = doctorSetup(brainLink, envN)
  assert(viaLink.installed && viaLink.warnings.length === 0 && viaLink.items.length === namedStatus.json.items.length, 'doctor must match a named vault reached through a symlink')

  const namedGone = await setup(engine, ['--uninstall', '--yes', '--name', 'brain', '--json'], envN)
  assert(namedGone.code === 0, `named uninstall failed: ${namedGone.out}`)
  assert(!fs.existsSync(path.join(homeN, '.claude/skills/alambic-brain')) && !fs.existsSync(path.join(homeN, '.agents/skills/alambic-brain')) && !fs.existsSync(namedShim), 'named uninstall must remove its skill dirs and shim')
  assert(Object.keys(readJson(path.join(homeN, '.claude.json')).mcpServers).sort().join() === 'alambic,alambic-self' && !readJson(path.join(homeN, '.codex/stub-mcp.json'))['alambic-brain'], 'named uninstall must remove only its MCP entries')
  assert(fs.existsSync(path.join(homeN, '.claude/skills/alambic/SKILL.md')) && fs.existsSync(path.join(homeN, '.claude/skills/alambic-self/SKILL.md')), 'named uninstall must keep sibling setups')

  console.log('setup: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
