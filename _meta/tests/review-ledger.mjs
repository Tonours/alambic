#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHumanDecisionReceipt, isOracleReason, readReviewLedger } from '../lib/review-ledger.mjs'

assert.equal(isOracleReason('oracle: ok'), true)
assert.equal(isOracleReason('  ORACLE: ok'), true)
assert.equal(isOracleReason(' Oracle:ok'), true)
assert.equal(isOracleReason('\toracle: kept'), true)
assert.equal(isOracleReason('human review'), false)
assert.equal(isOracleReason('not oracle: hidden'), false)
assert.equal(isOracleReason('oracle'), false)
assert.equal(isOracleReason(''), false)
assert.equal(isOracleReason('   '), false)
assert.equal(isOracleReason(null), false)
assert.equal(isOracleReason(undefined), false)

const human = {
  version: 1,
  proposal_sha256: 'a'.repeat(64),
  decision: 'accept',
  reason: 'human review',
  reviewed_at: '2026-10-07T00:00:00.000Z',
  receipt_sha256: 'b'.repeat(64),
}
assert.equal(isHumanDecisionReceipt(human), true)
assert.equal(isHumanDecisionReceipt({ ...human, reason: 'oracle:structural leftover' }), false)
assert.equal(isHumanDecisionReceipt({ ...human, reason: '  ORACLE: kept' }), false)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-ledger-'))
try {
  const reviews = path.join(dir, 'reviews')
  fs.mkdirSync(reviews)
  const write = (name, reason) => fs.writeFileSync(path.join(reviews, name), `${JSON.stringify({ ...human, reason })}\n`)
  write('human.json', 'human review')
  write('exact.json', 'oracle:structural leftover')
  write('padded.json', '  ORACLE: kept')
  const ledger = readReviewLedger(dir)
  assert.deepEqual(ledger.human, ['human.json'])
  assert.deepEqual(ledger.oracle, ['exact.json', 'padded.json'])
  assert.equal(ledger.human_count, 1)
  assert.equal(ledger.oracle_count, 2)
  assert.deepEqual(ledger.other, [])
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('review-ledger tests: ok\n')
