#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHumanDecisionReceipt, isRefusedReviewReason, isStoredOracleReason, readReviewLedger } from '../lib/review-ledger.mjs'

const root = path.resolve(process.argv[2] || '.')

assert.equal(isRefusedReviewReason('oracle: ok'), true)
assert.equal(isRefusedReviewReason('  ORACLE: ok'), true)
assert.equal(isRefusedReviewReason(' Oracle:ok'), true)
assert.equal(isRefusedReviewReason('\toracle: kept'), true)
assert.equal(isRefusedReviewReason('human review'), false)
assert.equal(isRefusedReviewReason('not oracle: hidden'), false)

const hashed = (payload) => ({ ...payload, receipt_sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') })
const payload = {
  version: 1,
  proposal_sha256: 'a'.repeat(64),
  decision: 'accept',
  reason: 'human review',
  reviewed_at: '2026-10-07T00:00:00.000Z',
}
const human = hashed(payload)
const keptHuman = ['Oracle: x', '  ORACLE: kept', ' oracle: y']
assert.equal(isHumanDecisionReceipt(human), true)
assert.equal(isHumanDecisionReceipt(hashed({ ...payload, reason: 'oracle:structural leftover' })), false)
assert.equal(isStoredOracleReason('oracle:structural leftover'), true)
for (const reason of keptHuman) {
  assert.equal(isStoredOracleReason(reason), false, reason)
  assert.equal(isHumanDecisionReceipt(hashed({ ...payload, reason })), true, reason)
}
const forged = { ...payload, receipt_sha256: 'b'.repeat(64) }
const edited = { ...human, reason: 'edited after hashing' }
assert.equal(isHumanDecisionReceipt(forged), false, 'a well-formed but wrong receipt_sha256 is not human')
assert.equal(isHumanDecisionReceipt(edited), false, 'a receipt edited after hashing is not human')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-ledger-'))
try {
  const reviews = path.join(dir, 'reviews')
  fs.mkdirSync(reviews)
  const write = (name, reason) => fs.writeFileSync(path.join(reviews, name), `${JSON.stringify(hashed({ ...payload, reason }))}\n`)
  write('human.json', 'human review')
  write('exact.json', 'oracle:structural leftover')
  write('upper.json', 'Oracle: x')
  write('padded.json', '  ORACLE: kept')
  write('space.json', ' oracle: y')
  fs.writeFileSync(path.join(reviews, 'forged.json'), `${JSON.stringify(forged)}\n`)
  fs.writeFileSync(path.join(reviews, 'edited.json'), `${JSON.stringify(edited)}\n`)
  const ledger = readReviewLedger(dir)
  assert.deepEqual(ledger.human, ['human.json', 'padded.json', 'space.json', 'upper.json'])
  assert.deepEqual(ledger.oracle, ['exact.json'])
  assert.equal(ledger.human_count, 4)
  assert.equal(ledger.oracle_count, 1)
  assert.deepEqual(ledger.other, ['edited.json', 'forged.json'])

  const state = path.join(dir, 'state')
  const env = { ...process.env, ALAMBIC_STATE_DIR: state }
  const cliPath = path.join(root, '_meta/alambic.mjs')
  const cli = (argv) => spawnSync(process.execPath, [cliPath, ...argv], { encoding: 'utf8', env })
  const viaPty = (argv) => spawnSync('python3', ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, cliPath, ...argv], { encoding: 'utf8', input: '', env })
  const receipts = () => fs.readdirSync(path.join(state, 'reviews')).filter((name) => name.endsWith('.json'))
  for (const decision of ['accept', 'reject']) {
    const input = path.join(dir, `${decision}.json`)
    fs.writeFileSync(input, JSON.stringify({ version: 1, action: 'noop', target: '', source_refs: [`codex:2026-10-21:${decision}`], trust: 'trusted-local', rationale: `${decision} tty gate fixture`, preimage_sha256: '', patch: '' }))
    const staged = cli(['distill', '--proposal', input])
    assert.equal(staged.status, 0, staged.stderr)
    const proposal = staged.stdout.trim().replace(/^shadow proposal: /, '')
    const before = receipts()
    const piped = cli(['review', '--proposal', proposal, '--decision', decision, '--reason', 'piped decision'])
    assert.notEqual(piped.status, 0, `a non-interactive ${decision} must be refused`)
    assert.match(piped.stderr, /interactive terminal/)
    assert.deepEqual(receipts(), before, `a refused ${decision} must not write a receipt`)
    const preview = cli(['review', '--proposal', proposal])
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /decision: pending/)
    const terminal = viaPty(['review', '--proposal', proposal, '--decision', decision, '--reason', 'checked in a terminal'])
    assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr)
    assert.match(terminal.stdout, new RegExp(`decision: ${decision}`))
  }
  assert.equal(readReviewLedger(state).human_count, 2, 'terminal decisions count as human receipts')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('review-ledger tests: ok\n')
