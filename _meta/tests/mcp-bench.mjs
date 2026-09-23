#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { contextPackWithJev, queryVaultWithJev } from '../lib/semantic-vault.mjs'
import { buildManifest } from '../lib/vault.mjs'

const [vaultArg, probesArg, ...flags] = process.argv.slice(2)
if (!vaultArg || !probesArg) {
  process.stderr.write('usage: mcp-bench.mjs <vault-root> <probes.jsonl> [--runs N] [--tool search|context] [--warm]\n')
  process.exit(2)
}
if (!process.env.TYPESAFE_API_KEY) {
  process.stderr.write('mcp-bench: TYPESAFE_API_KEY is required; configure it outside Git and rerun\n')
  process.exit(2)
}

function flag(name, fallback) {
  const index = flags.indexOf(name)
  return index < 0 ? fallback : flags[index + 1]
}

const root = path.resolve(vaultArg)
const runs = Number(flag('--runs', 3))
const tool = flag('--tool', 'search')
const probes = fs.readFileSync(path.resolve(probesArg), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => typeof row.query === 'string')
  .map((row) => ({
    id: row.id || row.case_id,
    query: row.query,
    expected: row.expected || row.expected_any || [],
    abstain: Boolean(row.abstain ?? row.expect_abstain),
  }))

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)])
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

async function retrieve(query, manifest) {
  if (tool === 'context') {
    const pack = await contextPackWithJev(root, query, { maxTokens: 1200, manifest })
    return { paths: pack.results.map((row) => row.path), semantic: pack.retrieval?.semantic || {} }
  }
  const { results, semantic } = await queryVaultWithJev(root, query, { limit: 5, manifest })
  return { paths: results.map((row) => row.path), semantic }
}

const auditFile = process.env.ALAMBIC_TYPESAFE_AUDIT_FILE

function providerCalls() {
  return auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length : 0
}

async function runOnce() {
  const manifest = buildManifest(root)
  const rows = []
  for (const probe of probes) {
    const callsBefore = providerCalls()
    const started = performance.now()
    const { paths, semantic } = await retrieve(probe.query, manifest)
    const ms = performance.now() - started
    const calls = providerCalls() - callsBefore
    const rank = paths.slice(0, 5).findIndex((candidate) => probe.expected.includes(candidate)) + 1
    rows.push({ id: probe.id, abstain: probe.abstain, ms, rank, returned: paths.length, decision: semantic.decision || semantic.reason || 'none', calls })
  }
  const answers = rows.filter((row) => !row.abstain)
  const abstains = rows.filter((row) => row.abstain)
  const decisions = {}
  for (const row of rows) decisions[row.decision] = (decisions[row.decision] || 0) + 1
  return {
    p50_ms: percentile(rows.map((row) => row.ms), 50),
    p95_ms: percentile(rows.map((row) => row.ms), 95),
    jev_calls: rows.reduce((sum, row) => sum + row.calls, 0),
    hit_at_5: answers.filter((row) => row.rank > 0).length,
    mrr_at_5: Math.round((answers.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / (answers.length || 1)) * 1000) / 1000,
    abstain_ok: abstains.filter((row) => row.returned === 0).length,
    decisions,
    per_probe: Object.fromEntries(rows.map((row) => [row.id, `${row.decision}:${row.rank}`])),
  }
}

if (flags.includes('--sample')) {
  if (flags.includes('--warm')) await runOnce()
  process.stdout.write(JSON.stringify(await runOnce()))
  process.exit(0)
}

const samples = []
for (let index = 0; index < runs; index += 1) {
  const sampleAudit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-')), 'audit.jsonl')
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, vaultArg, probesArg, ...flags, '--sample'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ALAMBIC_TYPESAFE_AUDIT_FILE: sampleAudit } })
  fs.rmSync(path.dirname(sampleAudit), { recursive: true, force: true })
  if (child.status !== 0) throw new Error(`mcp-bench sample failed: ${child.stderr.slice(0, 300)}`)
  samples.push(JSON.parse(child.stdout))
}
const unstable = probes.map((probe) => probe.id).filter((id) => new Set(samples.map((sample) => sample.per_probe[id])).size > 1)
const report = {
  vault: root,
  probes: path.basename(probesArg),
  tool,
  runs,
  answer_cases: probes.filter((probe) => !probe.abstain).length,
  abstain_cases: probes.filter((probe) => probe.abstain).length,
  median: Object.fromEntries(['p50_ms', 'p95_ms', 'jev_calls', 'hit_at_5', 'mrr_at_5', 'abstain_ok'].map((key) => [key, median(samples.map((sample) => sample[key]))])),
  samples: samples.map(({ per_probe: _perProbe, ...sample }) => sample),
  unstable,
  per_probe: samples.map((sample) => sample.per_probe),
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
