import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildManifest, retrievalSnapshot } from './vault.mjs'

const STATUS_PRIOR = {
  verified: 1.0,
  accepted: 1.0,
  draft: 0.35,
  stale: 0.12,
  superseded: 0.08,
  unrated: 0.2,
  index: 0.4,
  source: 0.15,
}

const PAGERANK_DAMPING = 0.85
const PAGERANK_ITERS = 30

export function graphCachePath(root) {
  return path.join(root, '_meta/derived-graph.json')
}

function wikilinkNames(text) {
  return [...String(text).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => match[1].trim())
}

function wikilinkKey(name) {
  return String(name).toLowerCase()
}

/**
 * Build a derived knowledge graph from Markdown (canonical).
 * Cache is optional acceleration keyed by retrieval snapshot SHA.
 * Never replaces notes; deleting the cache loses no knowledge.
 */
export function buildGraph(root, { force = false, writeCache = true } = {}) {
  // Always refresh the snapshot fingerprint so note writes in the same process
  // invalidate the derived graph even within the 1s manifest soft-cache window.
  const snapshot = retrievalSnapshot(root, { fresh: true })
  const cachePath = graphCachePath(root)

  if (!force && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      if (
        cached?.version
        && cached.source_snapshot_sha256 === snapshot.source_snapshot_sha256
        && cached.nodes
        && cached.edges
      ) {
        return cached
      }
    } catch {
      // Rebuild on corrupt cache.
    }
  }

  const manifest = buildManifest(root, false, { fresh: true })
  const nodes = {}
  const edges = []
  const claims = []
  const basenameToPath = new Map()
  const edgeKeys = new Set()

  for (const note of manifest) {
    basenameToPath.set(note.basename, note.path)
    for (const alias of note.aliases || []) {
      if (alias && !basenameToPath.has(alias)) basenameToPath.set(alias, note.path)
    }
    nodes[note.path] = {
      path: note.path,
      basename: note.basename,
      title: note.title,
      type: note.type,
      status: note.status,
      summary: note.summary || '',
      tags: note.tags || [],
      aliases: note.aliases || [],
      pagerank: 0,
      outDegree: 0,
      inDegree: 0,
    }
  }

  for (const note of manifest) {
    let rawText = note.text || ''
    try {
      rawText = fs.readFileSync(path.join(root, note.path), 'utf8')
    } catch {
      // Manifest search text is a fallback when the file is unreadable.
    }

    const seenTargets = new Set()
    for (const targetName of wikilinkNames(rawText)) {
      const targetPath = basenameToPath.get(targetName) || basenameToPath.get(wikilinkKey(targetName))
      // basename map is case-sensitive for basenames; resolve case-insensitively.
      let resolved = targetPath
      if (!resolved) {
        const key = wikilinkKey(targetName)
        for (const [name, p] of basenameToPath) {
          if (wikilinkKey(name) === key) {
            resolved = p
            break
          }
        }
      }
      if (!resolved || resolved === note.path || seenTargets.has(resolved)) continue
      seenTargets.add(resolved)
      const key = `${note.path}->${resolved}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({
        source: note.path,
        target: resolved,
        kind: 'wikilink',
        weight: 1.0,
      })
      if (nodes[note.path]) nodes[note.path].outDegree += 1
      if (nodes[resolved]) nodes[resolved].inDegree += 1
    }

    for (const rawClaim of note.claims || []) {
      if (typeof rawClaim !== 'string') continue
      const parts = rawClaim.split('|').map((part) => part.trim())
      if (parts.length < 3) continue
      claims.push({
        subject: parts[0],
        predicate: parts[1],
        value: parts[2],
        scope: parts[3] || 'global',
        nodePath: note.path,
      })
    }
  }

  computePageRank(nodes, edges)

  const graphData = {
    version: '1.1.0',
    generated_at: new Date().toISOString(),
    source_snapshot_sha256: snapshot.source_snapshot_sha256,
    snapshot,
    stats: {
      total_nodes: Object.keys(nodes).length,
      total_edges: edges.length,
      total_claims: claims.length,
      active_nodes: Object.values(nodes).filter((n) => ['verified', 'accepted'].includes(n.status)).length,
    },
    nodes,
    edges,
    claims,
  }

  if (writeCache) {
    try {
      const temporary = `${cachePath}.${process.pid}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(graphData, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, cachePath)
    } catch {
      // Read-only or full filesystem: still return in-memory graph.
    }
  }

  return graphData
}

/**
 * Personalized PageRank: status prior is the personalization vector.
 * Status is NOT re-multiplied each iteration (avoids non-standard decay).
 */
function computePageRank(nodes, edges) {
  const nodeKeys = Object.keys(nodes)
  const N = nodeKeys.length
  if (N === 0) return

  const outDegree = {}
  const incoming = {}
  for (const key of nodeKeys) {
    outDegree[key] = 0
    incoming[key] = []
  }
  for (const edge of edges) {
    if (!nodes[edge.source] || !nodes[edge.target]) continue
    outDegree[edge.source] += 1
    incoming[edge.target].push(edge.source)
  }

  let priorSum = 0
  const prior = {}
  for (const key of nodeKeys) {
    prior[key] = STATUS_PRIOR[nodes[key].status] ?? STATUS_PRIOR.unrated
    priorSum += prior[key]
  }
  for (const key of nodeKeys) prior[key] /= priorSum || 1

  let ranks = { ...prior }
  const d = PAGERANK_DAMPING

  for (let iter = 0; iter < PAGERANK_ITERS; iter += 1) {
    let dangling = 0
    for (const key of nodeKeys) {
      if (outDegree[key] === 0) dangling += ranks[key]
    }
    const next = {}
    for (const key of nodeKeys) {
      let sum = 0
      for (const src of incoming[key]) {
        const deg = outDegree[src] || 1
        sum += ranks[src] / deg
      }
      // Dangling mass redistributed uniformly; personalization uses status prior.
      next[key] = (1 - d) * prior[key] + d * (sum + dangling / N)
    }
    ranks = next
  }

  let rankSum = 0
  for (const key of nodeKeys) rankSum += ranks[key]
  for (const key of nodeKeys) {
    nodes[key].pagerank = Number((ranks[key] / (rankSum || 1)).toFixed(8))
    nodes[key].outDegree = outDegree[key]
    nodes[key].inDegree = incoming[key].length
  }
}

export function loadGraph(root, options = {}) {
  return buildGraph(root, { force: false, writeCache: true, ...options })
}

/** Undirected adjacency for traversal. */
export function graphAdjacencyMap(graph) {
  const adj = new Map()
  for (const pathKey of Object.keys(graph.nodes || {})) adj.set(pathKey, new Set())
  for (const edge of graph.edges || []) {
    if (!adj.has(edge.source)) adj.set(edge.source, new Set())
    if (!adj.has(edge.target)) adj.set(edge.target, new Set())
    adj.get(edge.source).add(edge.target)
    adj.get(edge.target).add(edge.source)
  }
  return adj
}

export function graphFingerprint(graph) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      snapshot: graph.source_snapshot_sha256,
      nodes: graph.stats?.total_nodes,
      edges: graph.stats?.total_edges,
      claims: graph.stats?.total_claims,
    }))
    .digest('hex')
}
