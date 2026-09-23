import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { queryVaultWithJev } from './semantic-vault.mjs'

function round(value) {
  return Math.round(value * 1000) / 1000
}

export async function runProbeEval({ root, probesPath, freezePath }) {
  const failures = []
  const freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'))
  const raw = fs.readFileSync(probesPath)
  if (crypto.createHash('sha256').update(raw).digest('hex') !== freeze.probes_sha256) failures.push('probe hash drift: the probe set is frozen; never edit it to green a change')
  if (!freeze.floor || !Number.isFinite(freeze.floor.hit_at_5) || !Number.isFinite(freeze.floor.abstain_rate)) failures.push('freeze file must declare floor.hit_at_5 and floor.abstain_rate from the recorded baseline')
  const probes = raw.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  const libDir = path.join(root, '_meta/lib')
  const libSources = fs.readdirSync(libDir, { recursive: true })
    .filter((name) => String(name).endsWith('.mjs'))
    .map((name) => fs.readFileSync(path.join(libDir, String(name)), 'utf8').toLowerCase())
  const leaked = probes.filter((probe) => libSources.some((source) => source.includes(probe.id.toLowerCase()) || source.includes(probe.query.toLowerCase())))
  if (leaked.length) failures.push(`probe ids or queries leaked into _meta/lib: ${leaked.map((probe) => probe.id).join(', ')}`)
  let hits = 0
  let reciprocal = 0
  let abstained = 0
  const misses = []
  const falseAnswers = []
  const semantic = {}
  for (const probe of probes) {
    const { results, semantic: diagnostics } = await queryVaultWithJev(root, probe.query, { limit: 5 })
    const key = diagnostics.available ? `jev:${diagnostics.decision}` : diagnostics.reason
    semantic[key] = (semantic[key] || 0) + 1
    if (probe.abstain) {
      if (results.length === 0) abstained += 1
      else falseAnswers.push(probe.id)
      continue
    }
    const rank = results.findIndex((result) => probe.expected.includes(result.path))
    if (rank >= 0) {
      hits += 1
      reciprocal += 1 / (rank + 1)
    } else misses.push(probe.id)
  }
  const answerCases = probes.filter((probe) => !probe.abstain).length
  const abstainCases = probes.length - answerCases
  const report = {
    cases: probes.length,
    provider: process.env.TYPESAFE_API_KEY ? 'credential-present' : 'credential-absent',
    hit_at_5: round(hits / answerCases),
    mrr_at_5: round(reciprocal / answerCases),
    abstain_rate: abstainCases ? round(abstained / abstainCases) : 1,
    misses,
    false_answers: falseAnswers,
    semantic,
    floor: freeze.floor || null,
  }
  if (freeze.floor && (report.hit_at_5 < freeze.floor.hit_at_5 || report.abstain_rate < freeze.floor.abstain_rate)) {
    failures.push(`probe quality regressed below the recorded baseline floor (${JSON.stringify(freeze.floor)})`)
  }
  return { report, failures }
}
