#!/usr/bin/env node
// Re-freeze the frozen eval sets after re-authoring them for your own notes.
// Hashes every case file, then re-measures the probes-v2 floor on the lexical
// baseline (TYPESAFE_API_KEY unset) so the floor never depends on a provider.
// Review the resulting freeze diff like code: it is the regression contract.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '../..'))
const evals = path.join(root, '_meta/evals')
const today = new Date().toISOString().slice(0, 10)
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(evals, file))).digest('hex')
const lines = (file) => fs.readFileSync(path.join(evals, file), 'utf8').trim().split('\n').filter(Boolean).length
const write = (file, data) => fs.writeFileSync(path.join(evals, file), `${JSON.stringify(data, null, 2)}\n`)
const read = (file) => JSON.parse(fs.readFileSync(path.join(evals, file), 'utf8'))

write('held-out.freeze.json', {
  ...read('held-out.freeze.json'),
  held_out_sha256: sha('held-out.jsonl'),
  cases: lines('held-out.jsonl'),
  frozen_at: today,
  capability_sha256: sha('capability.jsonl'),
  regression_sha256: sha('regression.jsonl'),
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
