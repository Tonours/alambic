#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const vault = path.resolve(option('--vault', repo))
const server = path.resolve(option('--server', path.join(repo, '_meta/mcp/server.mjs')))
const runs = Number(option('--runs', '3'))
const nodeArgs = option('--node-args', '').split(' ').filter(Boolean)
const QUERIES = ['strict second brain', 'mcp security', 'typesafe rerank', 'harvest sessions', 'retrieval health', 'graph traversal', 'capture quarantine', 'harness setup']

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const round = (value, digits = 1) => Number(value.toFixed(digits))

function memoryMb(pid) {
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    return Number(/^Pss:\s+(\d+) kB/m.exec(rollup)[1]) / 1024
  } catch {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
  }
}

async function session() {
  const started = performance.now()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-footprint-'))
  const child = spawn(process.execPath, [...nodeArgs, server], { env: { ...process.env, ALAMBIC_ROOT: vault, TYPESAFE_API_KEY: '', XDG_STATE_HOME: state }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiters = new Map()
  let buffer = ''
  let nextId = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      waiters.get(message.id)?.(message)
    }
  })
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++
    waiters.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'footprint', version: '0' } })
  const initMs = performance.now() - started
  await request('tools/list', {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  const idle = memoryMb(child.pid)
  const latencies = []
  for (let index = 0; index < 24; index++) {
    const tool = index % 3 === 2 ? 'vault_context' : 'vault_search'
    const call = performance.now()
    await request('tools/call', { name: tool, arguments: tool === 'vault_context' ? { query: QUERIES[index % QUERIES.length], max_tokens: 1200 } : { query: QUERIES[index % QUERIES.length], limit: 5 } })
    latencies.push(performance.now() - call)
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const afterCalls = memoryMb(child.pid)
  child.stdin.end()
  await new Promise((resolve) => child.on('close', resolve))
  fs.rmSync(state, { recursive: true, force: true })
  return { initMs, idle, afterCalls, p50: median(latencies) }
}

const samples = []
for (let run = 0; run < runs; run++) samples.push(await session())
const notes = (() => {
  try { return fs.readdirSync(path.join(vault, 'kb')).filter((file) => file.endsWith('.md')).length } catch { return 0 }
})()
process.stdout.write(`${JSON.stringify({
  manifest: { node: process.version, platform: `${process.platform}-${process.arch}`, vault_notes: notes, runs, node_args: nodeArgs, workload: '16 vault_search + 8 vault_context', memory: fs.existsSync('/proc/self/smaps_rollup') ? 'PSS MB' : 'RSS MB' },
  init_ms: round(median(samples.map((sample) => sample.initMs)), 0),
  idle_mb: round(median(samples.map((sample) => sample.idle))),
  after_24_calls_mb: round(median(samples.map((sample) => sample.afterCalls))),
  p50_call_ms: round(median(samples.map((sample) => sample.p50))),
}, null, 2)}\n`)
