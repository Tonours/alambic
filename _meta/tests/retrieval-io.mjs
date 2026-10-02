#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildManifest, invalidateManifest, lexicalCachePath, retrievalSnapshot } from '../lib/vault.mjs'
import { buildGraph } from '../lib/graph-builder.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-retrieval-io-'))

function measure(operation) {
  const original = { read: fs.readFileSync, stat: fs.statSync, readdir: fs.readdirSync }
  const counts = { reads: 0, stats: 0, directories: 0 }
  const markdown = (file) => typeof file === 'string' && file.startsWith(`${root}${path.sep}`) && file.endsWith('.md')
  fs.readFileSync = function (file, ...args) {
    if (markdown(file)) counts.reads += 1
    return original.read.call(this, file, ...args)
  }
  fs.statSync = function (file, ...args) {
    if (markdown(file)) counts.stats += 1
    return original.stat.call(this, file, ...args)
  }
  fs.readdirSync = function (dir, ...args) {
    if (dir === path.join(root, 'kb') || dir === path.join(root, 'ref')) counts.directories += 1
    return original.readdir.call(this, dir, ...args)
  }
  try {
    return { value: operation(), counts }
  } finally {
    fs.readFileSync = original.read
    fs.statSync = original.stat
    fs.readdirSync = original.readdir
  }
}

try {
  for (const dir of ['kb', 'ref', '_meta']) fs.mkdirSync(path.join(root, dir))
  const count = 12
  for (let index = 0; index < count; index += 1) {
    const raw = `---\ntype: reference\nstatus: verified\nsummary: "Gateway ${index}"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - graph\n---\n\n# Gateway ${index}\n\n[[gateway-${(index + 1) % count}]]\n`
    fs.writeFileSync(path.join(root, 'kb', `gateway-${index}.md`), raw)
  }
  fs.writeFileSync(path.join(root, 'kb/_index.md'), '# Index\n\n[[gateway-0]]\n')
  const files = count + 1
  invalidateManifest(root)
  fs.rmSync(lexicalCachePath(root), { force: true })
  const cold = measure(() => buildManifest(root, false, { fresh: true }))
  assert.equal(cold.counts.reads, files, 'read each cold note once; parse the already captured text')

  // Warm in-memory manifest; force the graph itself to rebuild.
  const rebuilt = measure(() => buildGraph(root, { force: true }))
  assert.deepEqual(rebuilt.counts, { reads: 0, stats: files, directories: 2 }, 'reuse one fresh manifest and its raw text for graph rebuilds')
  assert.equal(rebuilt.value.stats.total_nodes, count, 'indexes stay outside graph nodes')
  assert.equal(rebuilt.value.stats.total_edges, count)
  assert.equal(rebuilt.value.source_snapshot_sha256, retrievalSnapshot(root, { manifest: cold.value }).source_snapshot_sha256, 'fingerprint includes index files')

  const cached = measure(() => buildGraph(root))
  assert.deepEqual(cached.counts, { reads: 0, stats: files, directories: 2 }, 'cache hits still validate every file once')
  assert.deepEqual(cached.value, rebuilt.value)

  // Warm disk lexical cache, with no in-memory entry.
  invalidateManifest(root)
  const disk = measure(() => buildGraph(root, { force: true }))
  assert.deepEqual(disk.counts, rebuilt.counts, 'disk lexical cache avoids graph note rereads too')

  invalidateManifest(root)
  fs.rmSync(lexicalCachePath(root), { force: true })
  const coldGraph = measure(() => buildGraph(root, { force: true, writeCache: false }))
  assert.deepEqual(coldGraph.counts, { reads: files, stats: files, directories: 2 }, 'a cold graph consumes each note once')
  console.log('retrieval-io: ok')
} finally {
  invalidateManifest(root)
  fs.rmSync(root, { recursive: true, force: true })
}
