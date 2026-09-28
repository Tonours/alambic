#!/usr/bin/env node
// Re-freeze the frozen eval sets after re-authoring them for your own notes.
// Hashes every case file, then re-measures the probes-v2 floor on the lexical
// baseline (TYPESAFE_API_KEY unset) so the floor never depends on a provider.
// Review the resulting freeze diff like code: it is the regression contract.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canariesDigest, canaryPaths, limitsDigest, loadCanaries, measureCanaries } from '../lib/canaries.mjs'

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args.splice(onlyIndex, 2)[1] : null
if (only !== null && only !== 'canaries') {
  process.stderr.write('eval-freeze: --only accepts canaries\n')
  process.exit(2)
}
const root = path.resolve(args[0] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const evals = path.join(root, '_meta/evals')
const today = new Date().toISOString().slice(0, 10)
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(evals, file))).digest('hex')
const lines = (file) => fs.readFileSync(path.join(evals, file), 'utf8').trim().split('\n').filter(Boolean).length
const write = (file, data) => fs.writeFileSync(path.join(evals, file), `${JSON.stringify(data, null, 2)}\n`)
const read = (file) => JSON.parse(fs.readFileSync(path.join(evals, file), 'utf8'))

const canaryFiles = canaryPaths(root)
if (fs.existsSync(canaryFiles.cases)) {
  const measured = measureCanaries(loadCanaries(root))
  const previous = fs.existsSync(canaryFiles.freeze) ? read('canaries.freeze.json') : null
  if (previous?.floor && measured.catch_rate < previous.floor.catch_rate) {
    process.stderr.write(`eval-freeze: canaries catch rate ${measured.catch_rate} is below the frozen floor ${previous.floor.catch_rate}; the floor can only rise\n`)
    process.exit(1)
  }
  if (previous?.ceiling && measured.benign_false_positive_rate > previous.ceiling.benign_false_positive_rate) {
    process.stderr.write(`eval-freeze: canaries benign false-positive rate ${measured.benign_false_positive_rate} is above the frozen ceiling ${previous.ceiling.benign_false_positive_rate}; the ceiling can only fall\n`)
    process.exit(1)
  }
  const floor = { catch_rate: measured.catch_rate }
  const ceiling = { benign_false_positive_rate: measured.benign_false_positive_rate }
  write('canaries.freeze.json', { canaries_sha256: canariesDigest(root), cases: measured.attacks + measured.benign, attacks: measured.attacks, benign: measured.benign, frozen_at: today, floor, ceiling, limits_sha256: limitsDigest(floor, ceiling), measured_with: 'scanUnsafe in _meta/lib/vault.mjs' })
  process.stdout.write(`eval-freeze: canaries floor catch_rate=${floor.catch_rate} ceiling benign_false_positive_rate=${ceiling.benign_false_positive_rate}\n`)
} else if (only === 'canaries') {
  process.stderr.write('eval-freeze: _meta/evals/canaries.jsonl is missing\n')
  process.exit(1)
}
if (only === 'canaries') process.exit(0)

write('held-out.freeze.json', {
  ...read('held-out.freeze.json'),
  held_out_sha256: sha('held-out.jsonl'),
  cases: lines('held-out.jsonl'),
  frozen_at: today,
  capability_sha256: sha('capability.jsonl'),
  regression_sha256: sha('regression.jsonl'),
  hook_gate_sha256: sha('hook-gate.json'),
})

// Freeze the probe hash first (floor unchanged), then measure against it.
const probes = read('probes-v2.freeze.json')
Object.assign(probes, { probes_sha256: sha('probes-v2.jsonl'), cases: lines('probes-v2.jsonl'), frozen_at: today })
write('probes-v2.freeze.json', probes)
const env = { ...process.env }
delete env.TYPESAFE_API_KEY
const run = spawnSync(process.execPath, [path.join(root, '_meta/tests/eval.mjs'), 'probes-v2', root], { encoding: 'utf8', env })
let report
try { report = JSON.parse(run.stdout) } catch {
  process.stderr.write(`eval-freeze: probes-v2 produced no report (fix the set first):\n${run.stderr}`)
  process.exit(1)
}
if (/missing notes|leaked/.test(run.stderr)) {
  process.stderr.write(`eval-freeze: probes-v2 set is invalid:\n${run.stderr}`)
  process.exit(1)
}
const floor = { hit_at_5: report.hit_at_5, abstain_rate: report.abstain_rate }
write('probes-v2.freeze.json', {
  ...probes,
  floor,
  floor_sha256: crypto.createHash('sha256').update(JSON.stringify(floor)).digest('hex'),
  floor_measured: 'lexical baseline (TYPESAFE_API_KEY unset)',
})
process.stdout.write(`eval-freeze: frozen ${today}; probes-v2 floor hit@5=${floor.hit_at_5} abstain=${floor.abstain_rate}\n`)
