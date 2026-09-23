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
  console.log('state-dir: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
