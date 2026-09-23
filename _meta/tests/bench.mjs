#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
function option(flag, fallback) {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
const vault = path.resolve(option('--vault', path.join(HERE, '../..')))
const probesFile = path.resolve(option('--probes', path.join(HERE, '../evals/probes-v2.jsonl')))
const label = option('--label', 'run')
const out = option('--out', '')
const noKey = args.includes('--no-key')
const coldRuns = Number(option('--cold-runs', 3))
const maxTokens = '2500'
const PROVIDER_FAILURES = new Set(['authentication_failed', 'rate_limited', 'timeout', 'connection_failed', 'provider_rejected', 'invalid_response', 'provider_unavailable'])

const COMMANDS = {
  query: (query) => ['query', '--json', query],
  context: (query) => ['context', '--json', '--max-tokens', maxTokens, query],
  session: (query) => ['session', '--json', '--max-tokens', maxTokens, query],
  route: (query) => ['route', '--json', query],
  jev_cost: (query) => ['query', '--explain', '--json', query],
}

const probes = fs.readFileSync(probesFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const childEnv = { ...process.env, ...(noKey ? { TYPESAFE_API_KEY: '' } : {}) }

function run(commandArgs) {
  const started = process.hrtime.bigint()
  const child = spawnSync(process.execPath, [path.join(vault, '_meta/alambic.mjs'), ...commandArgs], { cwd: vault, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  let json = null
  try { json = JSON.parse(child.stdout) } catch { json = null }
  return { ms, bytes: Buffer.byteLength(child.stdout || ''), status: child.status, json, stderr: (child.stderr || '').slice(0, 300) }
}

function dropCaches() {
  fs.rmSync(path.join(vault, '_meta/.cache'), { recursive: true, force: true })
  fs.rmSync(path.join(vault, '_meta/derived-graph.json'), { force: true })
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 10) / 10
}

function stats(values) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), mean: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null }
}

function resultPaths(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : []
  return rows.map((row) => row.path)
}

function semanticOf(json) {
  return json?.semantic || json?.retrieval?.semantic || json?.pack?.retrieval?.semantic || null
}

function scoreQuality(rows) {
  const answer = rows.filter((row) => !row.probe.abstain)
  const abstain = rows.filter((row) => row.probe.abstain)
  let hits = 0
  let reciprocal = 0
  const perCategory = {}
  for (const row of answer) {
    const top = row.paths.slice(0, 5)
    const rank = top.findIndex((candidate) => row.probe.expected.includes(candidate))
    const bucket = perCategory[row.probe.category] || (perCategory[row.probe.category] = { cases: 0, hits: 0 })
    bucket.cases += 1
    if (rank >= 0) {
      hits += 1
      reciprocal += 1 / (rank + 1)
      bucket.hits += 1
    }
  }
  const abstained = abstain.filter((row) => row.paths.length === 0).length
  return {
    answer_cases: answer.length,
    hit_at_5: Math.round((hits / answer.length) * 1000) / 1000,
    mrr_at_5: Math.round((reciprocal / answer.length) * 1000) / 1000,
    abstain_cases: abstain.length,
    abstain_rate: Math.round((abstained / abstain.length) * 1000) / 1000,
    per_category: perCategory,
    misses: answer.filter((row) => !row.paths.slice(0, 5).some((candidate) => row.probe.expected.includes(candidate))).map((row) => row.probe.id),
    false_answers: abstain.filter((row) => row.paths.length > 0).map((row) => row.probe.id),
  }
}

const report = { label, vault, probes: probesFile, probes_count: probes.length, key: noKey ? 'absent' : (process.env.TYPESAFE_API_KEY ? 'present' : 'absent'), generated_at: new Date().toISOString(), commands: {} }

for (const [name, build] of Object.entries(COMMANDS)) {
  const cold = []
  for (let index = 0; index < coldRuns; index += 1) {
    dropCaches()
    cold.push(run(build(probes[index % probes.length].query)).ms)
  }
  const warm = []
  const tokens = []
  const rows = []
  const semantic = { calls: 0, available: 0, latency_ms: [], input_tokens: 0, reasons: {}, decisions: {} }
  let failures = 0
  for (const probe of probes) {
    const result = run(build(probe.query))
    if (result.status !== 0) failures += 1
    warm.push(result.ms)
    tokens.push(Math.ceil(result.bytes / 4))
    const top = semanticOf(result.json)
    for (const diag of [top, top?.expansion].filter(Boolean)) {
      if (diag.available || PROVIDER_FAILURES.has(diag.reason)) semantic.calls += 1
      if (diag.available) {
        semantic.available += 1
        if (Number.isFinite(diag.latency_ms)) semantic.latency_ms.push(diag.latency_ms)
        semantic.input_tokens += diag.usage?.input_tokens || 0
        semantic.decisions[diag.decision || 'judged'] = (semantic.decisions[diag.decision || 'judged'] || 0) + 1
      } else {
        semantic.reasons[diag.reason] = (semantic.reasons[diag.reason] || 0) + 1
      }
    }
    const paths = name === 'session' ? resultPaths(result.json?.pack) : resultPaths(result.json?.results ?? result.json)
    rows.push({ probe, paths })
  }
  report.commands[name] = {
    cold_ms: stats(cold),
    warm_ms: stats(warm),
    output_tokens: stats(tokens),
    failures,
    semantic: { ...semantic, latency_ms: stats(semantic.latency_ms) },
    quality: ['route', 'jev_cost'].includes(name) ? null : scoreQuality(rows),
  }
  process.stderr.write(`bench ${label}: ${name} done\n`)
}

const serialized = `${JSON.stringify(report, null, 2)}\n`
if (out) fs.writeFileSync(out, serialized)
process.stdout.write(serialized)
