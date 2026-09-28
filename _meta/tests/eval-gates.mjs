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
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`eval-gates tests: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('eval-gates tests: ok\n')
