#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLivingLoopPulse, seedShadowProposalsFromGraphLint } from '../lib/loop-pulse.mjs'
import { buildGraph } from '../lib/graph-builder.mjs'
import { checkGraphLint } from '../lib/graph-linter.mjs'

const ROOT = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`loop-pulse tests: ${message}\n`)
    process.exitCode = 1
  }
}

const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-loop-xdg-'))
process.env.XDG_STATE_HOME = xdg

// Live vault pulse without evals (fast)
const pulse = runLivingLoopPulse(ROOT, {
  seedProposals: true,
  runEvals: false,
  writeInbox: true,
  writePulseFile: true,
  maxProposals: 3,
})

assert(pulse.version === 1, 'pulse version')
assert(pulse.checklist.apply_still_disabled === true, 'Class B distill --apply must stay disabled')
assert(pulse.checklist.class_a === 'ci-writer', 'Class A labeled as CI writer')
assert(pulse.checklist.class_b === 'disabled', 'Class B labeled disabled')
assert(pulse.living_loop.apply_class_a === 'ci-writer', 'living_loop Class A is CI writer')
assert(pulse.living_loop.apply_class_b === 'disabled', 'living_loop Class B is disabled')
assert(pulse.living_loop.apply_mode === 'class-a-ci-class-b-off', 'apply_mode names both classes')
assert(typeof pulse.checklist.hygiene_ready === 'boolean', 'hygiene_ready required')
assert(pulse.checklist.supervision_ready === false || pulse.checklist.supervision_ready === true, 'supervision flag')
assert(Array.isArray(pulse.next_actions) && pulse.next_actions.length > 0, 'next actions')
assert(fs.existsSync(path.join(ROOT, '_meta/loop-pulse.latest.json')), 'repo pulse file')
assert(pulse.inbox_queue && fs.existsSync(pulse.inbox_queue), 'inbox queue card')

// Idempotent seed: second run should skip already-seeded
const graph = buildGraph(ROOT, { force: true, writeCache: false })
const lint = checkGraphLint(ROOT, { graph })
const second = seedShadowProposalsFromGraphLint(ROOT, lint, { maxProposals: 3 })
assert(second.created.length === 0 || second.skipped.length > 0, 'second seed should skip or create remaining only')

// Proposal shape must be reviewable (no unknown fields)
const proposalDir = path.join(xdg, 'alambic/proposals')
if (fs.existsSync(proposalDir)) {
  const files = fs.readdirSync(proposalDir).filter((name) => name.endsWith('.json'))
  assert(files.length >= 1 || pulse.seeded_proposals.created.length === 0, 'expected at least one seeded proposal when gaps exist, or zero if no gaps')
  for (const name of files) {
    const stored = JSON.parse(fs.readFileSync(path.join(proposalDir, name), 'utf8'))
    assert(stored.mode === 'shadow', 'shadow mode')
    assert(stored.action === 'noop', 'seeded proposals are noop')
    assert(!Object.hasOwn(stored, 'seed'), 'no extra seed field (breaks review hash)')
    const { mode, proposal_sha256: _p, ...proposal } = stored
    const fields = ['version', 'action', 'target', 'source_refs', 'trust', 'rationale', 'preimage_sha256', 'patch']
    for (const key of Object.keys(proposal)) {
      assert(fields.includes(key), `unknown proposal field ${key}`)
    }
  }
}

// Must not claim human supervision without receipts
assert(pulse.living_loop.reviews === 0 || typeof pulse.living_loop.reviews === 'number', 'reviews numeric')
assert(pulse.checklist.supervision_ready === false || pulse.living_loop.reviews >= 20, 'supervision_ready only if enough reviews')

if (!process.exitCode) process.stdout.write('loop-pulse tests: ok\n')
