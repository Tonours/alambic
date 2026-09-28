#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alambicStateDir } from '../lib/state-dir.mjs'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-state-'))
try {
  const xdg = path.join(temp, 'xdg')
  const pinned = path.join(temp, 'pinned')
  assert.equal(alambicStateDir(undefined, { XDG_STATE_HOME: xdg }), path.join(xdg, 'alambic'))
  assert.equal(alambicStateDir(undefined, { XDG_STATE_HOME: xdg, ALAMBIC_STATE_DIR: pinned }), pinned)
  assert.equal(alambicStateDir(xdg, { ALAMBIC_STATE_DIR: pinned }), path.join(xdg, 'alambic'))
  assert.throws(() => alambicStateDir(undefined, { ALAMBIC_STATE_DIR: 'relative/state' }), /absolute/)

  const run = spawnSync(path.join(root, '_meta/alambic'), ['state', 'init'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: xdg, ALAMBIC_STATE_DIR: pinned } })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(fs.existsSync(path.join(pinned, 'feedback')), 'ALAMBIC_STATE_DIR was not used by the CLI')
  assert.ok(!fs.existsSync(path.join(xdg, 'alambic')), 'CLI wrote to XDG_STATE_HOME despite ALAMBIC_STATE_DIR')

  const purgeState = path.join(temp, 'purge-state')
  const cli = (argv) => spawnSync(path.join(root, '_meta/alambic'), argv, { encoding: 'utf8', env: { ...process.env, ALAMBIC_STATE_DIR: purgeState } })
  const stage = (name) => {
    const input = path.join(temp, `${name}.json`)
    fs.writeFileSync(input, JSON.stringify({ version: 1, action: 'noop', target: '', source_refs: [`codex:2026-09-01:${name}`], trust: 'untrusted-session-data', rationale: `${name} purge fixture`, preimage_sha256: '', patch: '' }))
    const staged = cli(['distill', '--proposal', input])
    assert.equal(staged.status, 0, staged.stderr)
    return staged.stdout.trim().replace(/^shadow proposal: /, '')
  }
  const age = (file, days) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    fs.utimesSync(file, when, when)
  }
  const pending = stage('pending')
  const receipted = stage('receipted')
  const abandoned = stage('abandoned')
  const decided = cli(['review', '--proposal', receipted, '--decision', 'reject', '--reason', 'purge policy fixture'])
  assert.equal(decided.status, 0, decided.stderr)
  const candidate = path.join(purgeState, 'candidates', 'old-candidate.json')
  fs.writeFileSync(candidate, '{}\n')
  age(pending, 10)
  age(receipted, 10)
  age(abandoned, 31)
  age(candidate, 8)
  const feedback = cli(['feedback', '--status', 'hit'])
  assert.equal(feedback.status, 0, feedback.stderr)
  assert.ok(fs.existsSync(pending), 'feedback purged a pending proposal that has no receipt')
  assert.match(feedback.stderr, /purged 3 expired state file/, 'the purge count must reach stderr')
  for (const argv of [['review', '--proposal', pending], ['status', '--json']]) {
    const run = cli(argv)
    assert.equal(run.status, 0, `${argv[0]}: ${run.stderr}`)
  }
  assert.ok(fs.existsSync(pending), 'feedback, review or status purged a pending proposal that has no receipt')
  assert.ok(!fs.existsSync(receipted), 'a receipted proposal older than 7 days must be purged')
  assert.ok(!fs.existsSync(abandoned), 'an unreceipted proposal older than 30 days must be purged')
  assert.ok(!fs.existsSync(candidate), 'a candidate older than 7 days must be purged')
  console.log('state-dir: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
