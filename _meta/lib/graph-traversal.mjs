import { graphAdjacencyMap, loadGraph } from './graph-builder.mjs'

/**
 * Approximate Steiner subgraph: seeds + shortest paths between seeds +
 * PageRank-ordered BFS expansion. Bounded for context packs (not whole-graph dump).
 */
export function extractSteinerSubgraph(root, seedPaths, { maxHops = 2, maxNodes = 8, graph = null } = {}) {
  const loaded = graph || loadGraph(root)
  const nodesMap = loaded.nodes || {}
  const adj = graphAdjacencyMap(loaded)
  const selectedMap = new Map()

  for (const seed of seedPaths) {
    if (!nodesMap[seed]) continue
    selectedMap.set(seed, {
      path: seed,
      title: nodesMap[seed].title,
      summary: nodesMap[seed].summary,
      status: nodesMap[seed].status,
      pagerank: nodesMap[seed].pagerank,
      hop: 0,
      edgeFrom: null,
    })
  }

  const seedsArray = [...selectedMap.keys()]
  for (let i = 0; i < seedsArray.length; i += 1) {
    for (let j = i + 1; j < seedsArray.length; j += 1) {
      const pathNodes = findShortestPath(adj, seedsArray[i], seedsArray[j])
      for (let index = 0; index < pathNodes.length; index += 1) {
        const p = pathNodes[index]
        if (selectedMap.has(p) || !nodesMap[p] || selectedMap.size >= maxNodes) continue
        selectedMap.set(p, {
          path: p,
          title: nodesMap[p].title,
          summary: nodesMap[p].summary,
          status: nodesMap[p].status,
          pagerank: nodesMap[p].pagerank,
          hop: index === 0 || index === pathNodes.length - 1 ? 0 : 1,
          edgeFrom: index > 0 ? pathNodes[index - 1] : seedsArray[i],
        })
      }
    }
  }

  let queue = [...selectedMap.keys()]
  let currentHop = 1
  while (queue.length > 0 && currentHop <= maxHops && selectedMap.size < maxNodes) {
    const nextQueue = []
    for (const current of queue) {
      const neighbors = [...(adj.get(current) || [])]
        .filter((target) => !selectedMap.has(target) && nodesMap[target])
        .sort((a, b) => (nodesMap[b].pagerank || 0) - (nodesMap[a].pagerank || 0))

      for (const neighbor of neighbors) {
        if (selectedMap.size >= maxNodes) break
        selectedMap.set(neighbor, {
          path: neighbor,
          title: nodesMap[neighbor].title,
          summary: nodesMap[neighbor].summary,
          status: nodesMap[neighbor].status,
          pagerank: nodesMap[neighbor].pagerank,
          hop: currentHop,
          edgeFrom: current,
        })
        nextQueue.push(neighbor)
      }
    }
    queue = nextQueue
    currentHop += 1
  }

  const selectedNodes = [...selectedMap.values()]
  const pathLines = selectedNodes.map((node) => {
    const basenames = (p) => p.replace(/\.md$/, '').replace(/^(kb|ref)\//, '')
    if (node.hop === 0) return `- [[${basenames(node.path)}]]: ${node.summary} (seed)`
    return `- [[${basenames(node.path)}]] via [[${basenames(node.edgeFrom || '')}]]: ${node.summary}`
  })

  return {
    nodes: selectedNodes,
    graphSummary: pathLines.length
      ? `### Knowledge Graph Subgraph Traversal\n${pathLines.join('\n')}\n`
      : '',
  }
}

/**
 * Context-pack expansion: multi-seed Steiner-approx when ≥2 strong seeds,
 * else PageRank-ordered one-hop. Returns lightweight expansion rows for vault merge.
 */
export function expandForContext(root, ranked, { maxExpand = 2, minSeedScore = 12, graph = null } = {}) {
  const seeds = ranked
    .filter((result) => result.score >= minSeedScore && ['verified', 'accepted'].includes(result.status))
    .slice(0, 3)
  if (!seeds.length) return []

  const loaded = graph || loadGraph(root)
  const selected = new Set(ranked.map((result) => result.path))
  const candidates = []

  if (seeds.length >= 2) {
    const sub = extractSteinerSubgraph(root, seeds.map((seed) => seed.path), {
      maxHops: 2,
      maxNodes: seeds.length + maxExpand + 2,
      graph: loaded,
    })
    for (const node of sub.nodes) {
      if (node.hop === 0) continue
      if (!['verified', 'accepted'].includes(node.status)) continue
      candidates.push({
        path: node.path,
        hop: node.hop,
        edge_from: node.edgeFrom,
        pagerank: node.pagerank,
        kind: 'steiner',
      })
    }
  } else {
    const seed = seeds[0]
    const adj = graphAdjacencyMap(loaded)
    const neighbors = [...(adj.get(seed.path) || [])]
      .map((pathKey) => loaded.nodes[pathKey])
      .filter((node) => node && ['verified', 'accepted'].includes(node.status))
      .sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0))
    for (const node of neighbors) {
      candidates.push({
        path: node.path,
        hop: 1,
        edge_from: seed.path,
        pagerank: node.pagerank,
        kind: 'one-hop',
      })
    }
  }

  const expanded = []
  for (const candidate of candidates) {
    if (expanded.length >= maxExpand) break
    if (selected.has(candidate.path)) continue
    if (String(candidate.path).startsWith('docs/')) continue
    selected.add(candidate.path)
    expanded.push(candidate)
  }
  return expanded
}

function findShortestPath(adj, start, end) {
  if (start === end) return [start]
  const visited = new Set([start])
  const parent = new Map()
  const queue = [start]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === end) {
      const path = []
      let cursor = end
      while (cursor) {
        path.unshift(cursor)
        cursor = parent.get(cursor)
      }
      return path
    }
    for (const neighbor of adj.get(current) || []) {
      if (visited.has(neighbor)) continue
      visited.add(neighbor)
      parent.set(neighbor, current)
      queue.push(neighbor)
    }
  }
  return []
}
