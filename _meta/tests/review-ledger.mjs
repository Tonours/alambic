#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHumanDecisionReceipt, isRefusedReviewReason, isStoredOracleReason, readReviewLedger } from '../lib/review-ledger.mjs'

assert.equal(isRefusedReviewReason('oracle: ok'), true)
assert.equal(isRefusedReviewReason('  ORACLE: ok'), true)
assert.equal(isRefusedReviewReason(' Oracle:ok'), true)
assert.equal(isRefusedReviewReason('\toracle: kept'), true)
assert.equal(isRefusedReviewReason('human review'), false)
assert.equal(isRefusedReviewReason('not oracle: hidden'), false)

const human = {
  version: 1,
  proposal_sha256: 'a'.repeat(64),
  decision: 'accept',
  reason: 'human review',
  reviewed_at: '2026-10-07T00:00:00.000Z',
  receipt_sha256: 'b'.repeat(64),
}
const keptHuman = ['Oracle: x', '  ORACLE: kept', ' oracle: y']
assert.equal(isHumanDecisionReceipt(human), true)
assert.equal(isHumanDecisionReceipt({ ...human, reason: 'oracle:structural leftover' }), false)
assert.equal(isStoredOracleReason('oracle:structural leftover'), true)
for (const reason of keptHuman) {
  assert.equal(isStoredOracleReason(reason), false, reason)
  assert.equal(isHumanDecisionReceipt({ ...human, reason }), true, reason)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-ledger-'))
try {
  const reviews = path.join(dir, 'reviews')
  fs.mkdirSync(reviews)
  const write = (name, reason) => fs.writeFileSync(path.join(reviews, name), `${JSON.stringify({ ...human, reason })}\n`)
  write('human.json', 'human review')
  write('exact.json', 'oracle:structural leftover')
  write('upper.json', 'Oracle: x')
  write('padded.json', '  ORACLE: kept')
  write('space.json', ' oracle: y')
  const ledger = readReviewLedger(dir)
  assert.deepEqual(ledger.human, ['human.json', 'padded.json', 'space.json', 'upper.json'])
  assert.deepEqual(ledger.oracle, ['exact.json'])
  assert.equal(ledger.human_count, 4)
  assert.equal(ledger.oracle_count, 1)
  assert.deepEqual(ledger.other, [])
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('review-ledger tests: ok\n')
