#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildManifest } from '../lib/vault.mjs'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-lexical-cache-'))
const note = (title, body) => `---\ntype: reference\nstatus: verified\nsummary: "${title}"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - bff\n---\n\n# ${title}\n\n${body}\n`
const run = (args) => spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), ...args], {
  encoding: 'utf8',
  env: { ...process.env, ALAMBIC_ROOT: temp, ALAMBIC_STATE_DIR: path.join(temp, 'state'), TYPESAFE_API_KEY: '' },
})
const query = () => run(['query', '--json', 'gateway'])
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

  const windowsPath = 'kb/windows-gateway.md'
  const lf = note('Windows gateway', 'The gateway coordinates Windows agents.')
    .replace('  - bff\n', '  - bff\naliases:\n  - WindowsGateway\n')
  const file = path.join(temp, windowsPath)
  fs.writeFileSync(file, lf)
  const lfEntry = buildManifest(temp, false, { fresh: true }).find((entry) => entry.path === windowsPath)
  const crlf = lf.replaceAll('\n', '\r\n')
  fs.writeFileSync(file, crlf)
  const crlfEntry = buildManifest(temp, false, { fresh: true }).find((entry) => entry.path === windowsPath)
  for (const field of ['type', 'status', 'summary', 'title', 'tags', 'aliases', 'search', 'text']) {
    assert.deepEqual(crlfEntry[field], lfEntry[field], `CRLF must preserve ${field}`)
  }
  assert.equal(crlfEntry.raw, crlf, 'CRLF raw bytes must stay canonical')
  assert.equal(crlfEntry.sha256, crypto.createHash('sha256').update(crlf).digest('hex'))

  for (const label of ['cold graph CRLF', 'warm graph CRLF']) {
    const result = run(['session', '--json', '--max-tokens', '1800', 'WindowsGateway'])
    assert.equal(result.status, 0, `${label}: ${result.stderr}`)
    const session = JSON.parse(result.stdout)
    assert.equal(session.pack.results[0]?.path, windowsPath, label)
    assert.equal(session.pack.results[0]?.status, 'verified', label)
    assert.ok(session.pack.results[0]?.citation, `${label}: citation required`)
    assert.ok(Buffer.byteLength(JSON.stringify(session)) <= 7200, `${label}: session budget`)
  }

  const legacyLexical = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  legacyLexical.version = 2
  const oldEntry = legacyLexical.entries.find((entry) => entry.key === windowsPath)
  Object.assign(oldEntry.item, { type: 'source', status: 'unrated', tags: [], aliases: [] })
  oldEntry.item.search.aliases = []
  oldEntry.item.search.tags = []
  fs.writeFileSync(cachePath, JSON.stringify(legacyLexical))
  const graphPath = path.join(temp, '_meta/derived-graph.json')
  const legacyGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  legacyGraph.version = '1.2.0'
  legacyGraph.nodes[windowsPath].status = 'unrated'
  fs.writeFileSync(graphPath, JSON.stringify(legacyGraph))

  const repaired = run(['query', '--json', 'WindowsGateway'])
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(JSON.parse(repaired.stdout)[0]?.path, windowsPath, 'legacy lexical cache must retain the alias hit')
  assert.equal(JSON.parse(repaired.stdout)[0]?.status, 'verified', 'legacy lexical cache must be reparsed without a note edit')
  const graph = run(['graph', '--json'])
  assert.equal(graph.status, 0, graph.stderr)
  assert.equal(JSON.parse(fs.readFileSync(graphPath, 'utf8')).nodes[windowsPath].status, 'verified', 'legacy graph cache must be rebuilt without a note edit')
  console.log('lexical-cache: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
