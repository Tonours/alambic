import { graphAdjacencyMap, loadGraph } from './graph-builder.mjs'

const MAX_GAPS = 10
const MAX_STALE = 10
const MIN_SHARED_TAGS = 3

/**
 * Graph health signals for human review.
 * Co-occurrence gaps and stale dependency edges are warnings, not auto-edits.
 * Claim contradictions on active notes are structural review candidates.
 */
export function checkGraphLint(root, { graph = null } = {}) {
  const data = graph || loadGraph(root)
  const nodes = data.nodes || {}
  const edges = data.edges || []
  const claims = data.claims || []
  const adj = graphAdjacencyMap(data)

  const edgeSet = new Set()
  for (const edge of edges) {
    edgeSet.add(`${edge.source}|${edge.target}`)
    edgeSet.add(`${edge.target}|${edge.source}`)
  }

  // Inverted tag index → O(sum binom(|tag|,2)) instead of full O(n²).
  const tagToPaths = new Map()
  for (const [pathKey, node] of Object.entries(nodes)) {
    if (pathKey === 'kb/_index.md') continue
    for (const tag of node.tags || []) {
      const list = tagToPaths.get(tag) || []
      list.push(pathKey)
      tagToPaths.set(tag, list)
    }
  }

  const pairShared = new Map()
  for (const [, paths] of tagToPaths) {
    if (paths.length < 2 || paths.length > 80) continue
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const a = paths[i]
        const b = paths[j]
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        pairShared.set(key, (pairShared.get(key) || 0) + 1)
      }
    }
  }

  const coOccurrenceGaps = []
  for (const [key, count] of pairShared) {
    if (count < MIN_SHARED_TAGS) continue
    const [pathA, pathB] = key.split('|')
    if (edgeSet.has(`${pathA}|${pathB}`)) continue
    const tagsA = new Set(nodes[pathA]?.tags || [])
    const shared = (nodes[pathB]?.tags || []).filter((tag) => tagsA.has(tag))
    if (shared.length < MIN_SHARED_TAGS) continue
    // Prefer active notes for review signal.
    const statusA = nodes[pathA]?.status
    const statusB = nodes[pathB]?.status
    if (!['verified', 'accepted'].includes(statusA) && !['verified', 'accepted'].includes(statusB)) continue
    coOccurrenceGaps.push({
      source: pathA,
      target: pathB,
      shared_tags: shared,
      recommendation: `consider adding a [[wikilink]] between ${pathA} and ${pathB}`,
    })
    if (coOccurrenceGaps.length >= MAX_GAPS) break
  }

  const claimMap = new Map()
  const claimContradictions = []
  for (const claim of claims) {
    const noteStatus = nodes[claim.nodePath]?.status
    if (!['verified', 'accepted'].includes(noteStatus)) continue
    const key = `${claim.subject.toLowerCase()}|${claim.predicate.toLowerCase()}|${(claim.scope || 'global').toLowerCase()}`
    const existing = claimMap.get(key)
    if (!existing) {
      claimMap.set(key, claim)
      continue
    }
    if (existing.value.toLowerCase() !== claim.value.toLowerCase()) {
      claimContradictions.push({
        subject: claim.subject,
        predicate: claim.predicate,
        scope: claim.scope,
        conflicting_notes: [existing.nodePath, claim.nodePath],
        values: [existing.value, claim.value],
      })
    }
  }

  const staleInvalidations = []
  for (const edge of edges) {
    const src = nodes[edge.source]
    const tgt = nodes[edge.target]
    if (!src || !tgt) continue
    if (['verified', 'accepted'].includes(src.status) && ['stale', 'superseded'].includes(tgt.status)) {
      staleInvalidations.push({
        verified_note: edge.source,
        stale_dependency: edge.target,
        recommendation: `review ${edge.source} because linked target ${edge.target} is ${tgt.status}`,
      })
      if (staleInvalidations.length >= MAX_STALE) break
    }
  }

  // Zero-degree active orphans (graph view; may differ from backlink-only orphans).
  const graphOrphans = Object.values(nodes)
    .filter((node) => node.path.startsWith('kb/')
      && node.path !== 'kb/_index.md'
      && ['verified', 'accepted'].includes(node.status)
      && (adj.get(node.path)?.size || 0) === 0)
    .map((node) => ({ path: node.path, status: node.status }))
    .slice(0, MAX_GAPS)

  return {
    version: 1,
    source_snapshot_sha256: data.source_snapshot_sha256 || null,
    stats: data.stats || null,
    co_occurrence_gaps: coOccurrenceGaps,
    claim_contradictions: claimContradictions,
    stale_invalidations: staleInvalidations,
    graph_orphans: graphOrphans,
  }
}
