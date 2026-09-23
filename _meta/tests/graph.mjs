#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildGraph, loadGraph, graphAdjacencyMap } from '../lib/graph-builder.mjs'
import { expandForContext, extractSteinerSubgraph } from '../lib/graph-traversal.mjs'
import { checkGraphLint } from '../lib/graph-linter.mjs'
import { recordExecutionTrace } from '../lib/graph-distiller.mjs'
import { contextPack, queryVault } from '../lib/vault.mjs'

const rootArg = process.argv[2]
const ROOT = rootArg || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`graph tests: ${message}\n`)
    process.exitCode = 1
  }
}

function writeNote(dir, name, { title, status = 'verified', tags = [], body = '', links = [] }) {
  const related = links.map((link) => `[[${link}]]`).join(' ')
  const content = `---
type: finding
status: ${status}
summary: "${title}"
sources:
  - "https://example.com/graph-test"
created: 2026-07-28
updated: 2026-07-28
tags:
${tags.map((tag) => `  - ${tag}`).join('\n')}
---

# ${title}

${body}

## Related

${related}
`
  fs.writeFileSync(path.join(dir, name), content)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-graph-'))
const kb = path.join(tmp, 'kb')
const ref = path.join(tmp, 'ref')
const meta = path.join(tmp, '_meta')
fs.mkdirSync(kb)
fs.mkdirSync(ref)
fs.mkdirSync(meta)
fs.writeFileSync(path.join(kb, '_index.md'), '---\ntype: reference\nstatus: verified\nupdated: 2026-07-28\ntags:\n  - index\n---\n\n# Index\n')
writeNote(kb, 'alpha.md', {
  title: 'Alpha node',
  tags: ['graph', 'memory', 'agents'],
  body: 'Alpha seeds the graph with durable knowledge.',
  links: ['beta'],
})
writeNote(kb, 'beta.md', {
  title: 'Beta bridge',
  tags: ['graph', 'memory', 'agents'],
  body: 'Beta bridges alpha and gamma for multi-hop.',
  links: ['alpha', 'gamma'],
})
writeNote(kb, 'gamma.md', {
  title: 'Gamma node',
  tags: ['graph', 'memory', 'agents'],
  body: 'Gamma is the far hop target.',
  links: ['beta'],
})
writeNote(kb, 'orphan-active.md', {
  title: 'Orphan active',
  tags: ['unrelated-tag-only'],
  body: 'No wikilinks out or in.',
  links: [],
})

// 1) Build + snapshot invalidation
const first = buildGraph(tmp, { force: true, writeCache: true })
assert(first.stats.total_nodes >= 4, 'expected fixture nodes')
assert(first.stats.total_edges >= 3, 'expected wikilink edges')
assert(first.source_snapshot_sha256, 'missing snapshot sha')
assert(fs.existsSync(path.join(tmp, '_meta/derived-graph.json')), 'cache not written')

const cached = loadGraph(tmp)
assert(cached.source_snapshot_sha256 === first.source_snapshot_sha256, 'cache load snapshot mismatch')

// Mutate vault → snapshot must change without force (fresh fingerprint)
writeNote(kb, 'delta.md', {
  title: 'Delta node',
  tags: ['graph'],
  body: 'Delta joins later.',
  links: ['gamma'],
})
const rebuilt = buildGraph(tmp, { force: false, writeCache: true })
assert(rebuilt.source_snapshot_sha256 !== first.source_snapshot_sha256, 'snapshot should change after note add without force')
assert(rebuilt.stats.total_nodes > first.stats.total_nodes, 'node count should grow')

// 2) PageRank personalization: verified mass > superseded if present
const ranks = Object.values(rebuilt.nodes).map((n) => n.pagerank)
const rankSum = ranks.reduce((a, b) => a + b, 0)
assert(Math.abs(rankSum - 1) < 1e-4, `pagerank should sum ~1, got ${rankSum}`)

// 3) Steiner: alpha–gamma path includes beta
const steiner = extractSteinerSubgraph(tmp, ['kb/alpha.md', 'kb/gamma.md'], { maxHops: 2, maxNodes: 6 })
const steinerPaths = steiner.nodes.map((n) => n.path)
assert(steinerPaths.includes('kb/alpha.md'), 'steiner missing alpha seed')
assert(steinerPaths.includes('kb/gamma.md'), 'steiner missing gamma seed')
assert(steinerPaths.includes('kb/beta.md'), 'steiner missing bridge beta')

// 4) expandForContext one-hop / multi-seed
const ranked = queryVault(tmp, 'Alpha node durable knowledge', { limit: 5 })
assert(ranked.length >= 1, 'fixture query should hit alpha')
const expanded = expandForContext(tmp, ranked, { maxExpand: 2, minSeedScore: 1 })
assert(expanded.length >= 1, 'expandForContext should return neighbors')
assert(expanded.every((row) => row.edge_from || row.kind), 'expansion needs provenance')

// 5) context pack graph provenance (live root optional light check)
const pack = contextPack(tmp, 'Alpha node graph memory', { maxTokens: 1200 })
assert(pack.results?.length >= 1, 'context pack should select results')

// 6) graph lint: shared tags without edge → gap candidate possible on active pair
// Remove beta links to orphan pair? alpha and gamma share tags and may still connect via beta.
// Create two unlinked notes with 3 shared tags.
writeNote(kb, 'gap-a.md', {
  title: 'Gap A',
  tags: ['css', 'frontend', 'tokens'],
  body: 'Gap A content',
  links: [],
})
writeNote(kb, 'gap-b.md', {
  title: 'Gap B',
  tags: ['css', 'frontend', 'tokens'],
  body: 'Gap B content',
  links: [],
})
buildGraph(tmp, { force: true, writeCache: true })
const lint = checkGraphLint(tmp)
assert(Array.isArray(lint.co_occurrence_gaps), 'gaps array required')
const gapHit = lint.co_occurrence_gaps.some(
  (gap) => (gap.source.includes('gap-a') && gap.target.includes('gap-b'))
    || (gap.source.includes('gap-b') && gap.target.includes('gap-a')),
)
assert(gapHit, 'expected co-occurrence gap between gap-a and gap-b')

// 7) Privacy: distiller must refuse query persistence
let threw = false
try {
  recordExecutionTrace(tmp, { query: 'secret user question', status: 'miss' })
} catch (error) {
  threw = /disabled|feedback/i.test(error.message)
}
assert(threw, 'recordExecutionTrace must throw and refuse query storage')

// 8) Adjacency undirected
const adj = graphAdjacencyMap(rebuilt)
assert(adj.get('kb/alpha.md')?.has('kb/beta.md'), 'alpha should neighbor beta')

// Live vault smoke (optional): ensure production builder does not throw
try {
  const live = buildGraph(ROOT, { force: true, writeCache: true })
  assert(live.stats.total_nodes >= 8, 'live graph too small')
  assert(live.stats.total_edges >= 4, 'live graph edges too few')
} catch (error) {
  assert(false, `live graph build failed: ${error.message}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
if (!process.exitCode) process.stdout.write('graph tests: ok\n')
