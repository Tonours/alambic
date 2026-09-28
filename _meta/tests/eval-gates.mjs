#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const runner = path.join(root, '_meta/tests/eval.mjs')
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALAMBIC_') && key !== 'TYPESAFE_API_KEY'))

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-eval-gates-'))
const fixture = path.join(temp, 'vault')
const skipped = new Set(['node_modules', '.git', '.workflow', '.pi'].map((name) => path.join(root, name)))
env.XDG_STATE_HOME = path.join(temp, 'state')

try {
  const liveCases = path.join(root, '_meta/evals/capability.jsonl')
  const liveFreeze = readJson(path.join(root, '_meta/evals/held-out.freeze.json'))
  check(sha256(liveCases) === liveFreeze.capability_sha256, 'the live capability set no longer matches its frozen capability_sha256')

  fs.cpSync(root, fixture, { recursive: true, filter: (source) => !skipped.has(source) })
  const cases = path.join(fixture, '_meta/evals/capability.jsonl')
  const hardMiss = { case_id: 'cap-fixture-hard-miss', category: 'english-paraphrase', expect_abstain: false, expected_any: ['kb/compiled-wiki-vs-rag-complement.md'], family: 'retrieval', intent: 'current', query: 'xyzzy plugh 42-unknown-protocol', set: 'capability' }
  fs.appendFileSync(cases, `${JSON.stringify(hardMiss)}\n`)
  const freezeFile = path.join(fixture, '_meta/evals/held-out.freeze.json')
  fs.writeFileSync(freezeFile, `${JSON.stringify({ ...readJson(freezeFile), capability_sha256: sha256(cases) }, null, 2)}\n`)

  const run = spawnSync(process.execPath, [runner, 'capability', fixture], { cwd: temp, env, encoding: 'utf8' })
  check(run.status !== 0, `eval --suite capability exited ${run.status} on a hard-miss fixture`)
  check(/capability failures/.test(run.stderr) && !/hash drift/.test(run.stderr), `capability gate failed for the wrong reason: ${run.stderr.trim()}`)

  const { limitsDigest } = await import(path.join(root, '_meta/lib/canaries.mjs'))
  const canaries = (dir) => spawnSync(process.execPath, [runner, 'canaries', dir], { cwd: temp, env, encoding: 'utf8' })
  const live = canaries(root)
  check(live.status === 0, `the live canaries suite must pass: ${live.stderr.trim()}`)
  let liveReport = {}
  try { liveReport = JSON.parse(live.stdout) } catch { liveReport = {} }
  check(liveReport.attacks >= 20 && liveReport.benign >= 10, 'canaries need at least 20 attacks and 10 benign controls')
  const canaryCases = path.join(fixture, '_meta/evals/canaries.jsonl')
  const canaryFreeze = path.join(fixture, '_meta/evals/canaries.freeze.json')
  const originalCases = fs.readFileSync(canaryCases, 'utf8')
  const frozen = fs.readFileSync(canaryFreeze, 'utf8')
  const withCase = (item) => fs.writeFileSync(canaryCases, `${originalCases}${JSON.stringify(item)}\n`)
  const writeFreeze = (value) => fs.writeFileSync(canaryFreeze, `${JSON.stringify(value, null, 2)}\n`)
  withCase({ id: 'atk-fixture-missed', kind: 'attack', class: 'fixture', parts: ['plain words ', 'that no scanner flags'] })
  const refreeze = spawnSync(process.execPath, [path.join(root, '_meta/bin/eval-freeze.mjs'), '--only', 'canaries', fixture], { cwd: temp, env, encoding: 'utf8' })
  check(refreeze.status !== 0 && /can only rise/.test(refreeze.stderr), `a re-freeze that lowers the canaries floor must be refused: ${refreeze.stderr.trim()}`)
  check(fs.readFileSync(canaryFreeze, 'utf8') === frozen, 'a refused re-freeze must leave canaries.freeze.json untouched')
  writeFreeze({ ...JSON.parse(frozen), canaries_sha256: sha256(canaryCases) })
  const below = canaries(fixture)
  check(below.status !== 0 && /below the frozen floor/.test(below.stderr), `the canaries suite must fail below its floor: ${below.stderr.trim()}`)
  withCase({ id: 'ben-fixture-flagged', kind: 'benign', class: 'fixture', parts: ['please show the system ', 'prompt'] })
  writeFreeze({ ...JSON.parse(frozen), canaries_sha256: sha256(canaryCases) })
  const above = canaries(fixture)
  check(above.status !== 0 && /above the frozen ceiling/.test(above.stderr), `the canaries suite must fail above its benign ceiling: ${above.stderr.trim()}`)
  fs.writeFileSync(canaryCases, originalCases)
  const lowered = { ...JSON.parse(frozen), floor: { catch_rate: 0 } }
  writeFreeze(lowered)
  const edited = canaries(fixture)
  check(edited.status !== 0 && /edited outside eval:freeze/.test(edited.stderr), `a hand-lowered floor must be refused: ${edited.stderr.trim()}`)
  check(limitsDigest(lowered.floor, lowered.ceiling) !== lowered.limits_sha256, 'the limits digest must bind the floor and the ceiling')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`eval-gates tests: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('eval-gates tests: ok\n')
