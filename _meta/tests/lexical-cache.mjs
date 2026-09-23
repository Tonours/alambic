#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-lexical-cache-'))
const note = (title, body) => `---\ntype: reference\nstatus: verified\nsummary: "${title}"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - bff\n---\n\n# ${title}\n\n${body}\n`
const query = () => spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'query', '--json', 'gateway'], {
  encoding: 'utf8',
  env: { ...process.env, ALAMBIC_ROOT: temp, ALAMBIC_STATE_DIR: path.join(temp, 'state'), TYPESAFE_API_KEY: '' },
})
try {
  fs.mkdirSync(path.join(temp, 'kb'), { recursive: true })
  fs.mkdirSync(path.join(temp, 'ref'), { recursive: true })
  fs.writeFileSync(path.join(temp, 'kb/_index-bff.md'), note('BFF index', '- [[bff-gateway]]'))
  fs.writeFileSync(path.join(temp, 'kb/bff-gateway.md'), note('BFF gateway', 'The gateway proxies agent calls.'))

  const cold = query()
  assert.equal(cold.status, 0, cold.stderr)
  const cachePath = path.join(temp, '_meta/.cache/lexical-index.json')
  const pristine = fs.readFileSync(cachePath, 'utf8')
  const corruptions = {
    'missing raw': (cache) => cache.entries.forEach((entry) => delete entry.item.raw),
    'missing sources': (cache) => cache.entries.forEach((entry) => delete entry.item.sources),
    'empty search': (cache) => cache.entries.forEach((entry) => { entry.item.search = {} }),
    'null entry': (cache) => cache.entries.push(null),
  }
  for (const [label, corrupt] of Object.entries(corruptions)) {
    const cache = JSON.parse(pristine)
    corrupt(cache)
    fs.writeFileSync(cachePath, JSON.stringify(cache))
    const stale = query()
    assert.equal(stale.status, 0, `${label}: a corrupt cache entry must be re-parsed: ${stale.stderr}`)
    assert.equal(JSON.parse(stale.stdout)[0]?.path, 'kb/bff-gateway.md', label)
  }
  console.log('lexical-cache: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
