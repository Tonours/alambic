#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const source = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-path-'))
const vault = path.join(temp, 'My Vault é')

function copyWorkingTree() {
  const listed = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: source, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${source}: ${listed.stderr.trim()}`)
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const from = path.join(source, file)
    if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue
    const to = path.join(vault, file)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    fs.chmodSync(to, fs.statSync(from).mode)
  }
  const modules = path.join(source, 'node_modules')
  fs.mkdirSync(path.join(vault, 'node_modules'))
  for (const entry of fs.readdirSync(modules)) fs.symlinkSync(path.join(modules, entry), path.join(vault, 'node_modules', entry))
}

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALAMBIC_') && key !== 'TYPESAFE_API_KEY'))
env.XDG_STATE_HOME = path.join(temp, 'state')
const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [path.join(vault, '_meta/alambic.mjs'), ...args], { cwd: temp, env: { ...env, ...extraEnv }, encoding: 'utf8' })

async function checkMcpSpawnsCli() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(vault, '_meta/mcp/server.mjs')], cwd: temp, stderr: 'pipe', env })
  const client = new Client({ name: 'alambic-path-encoding', version: '1.0.0' })
  try {
    await client.connect(transport)
    const feedback = await client.callTool({ name: 'vault_feedback', arguments: { status: 'hit' } })
    const text = feedback.content?.[0]?.text || ''
    check(!feedback.isError && /"recorded":\s*true/.test(text), `MCP vault_feedback did not reach the CLI: ${text.trim()}`)
  } finally {
    await client.close()
  }
}

try {
  copyWorkingTree()

  const validate = cli(['validate', '--mode', 'strict'])
  check(validate.status === 0, `validate exited ${validate.status}: ${(validate.stderr || validate.stdout).trim()}`)

  const query = cli(['query', '--json', 'second brain architecture'])
  let results = []
  try {
    results = JSON.parse(query.stdout)
  } catch {
    results = []
  }
  check(query.status === 0 && Array.isArray(results) && results.length >= 1, `query --json returned ${Array.isArray(results) ? results.length : 'no'} results (exit ${query.status})`)

  const emptyRoot = path.join(temp, 'empty root')
  fs.mkdirSync(emptyRoot)
  for (const command of [['query', '--json', 'second brain architecture'], ['context', '--json', 'second brain architecture'], ['session', '--json', 'second brain architecture']]) {
    const guarded = cli(command, { ALAMBIC_ROOT: emptyRoot })
    check(guarded.status !== 0 && /kb\//.test(guarded.stderr), `${command[0]} without kb/ exited ${guarded.status} with "${guarded.stderr.trim()}"`)
  }

  await checkMcpSpawnsCli()
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`path-encoding tests: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('path-encoding tests: ok\n')
