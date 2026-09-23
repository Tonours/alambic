import { loadGraph } from './graph-builder.mjs'
import { routeVaultKnowledge } from './vault.mjs'

const SKILL_MAP = {
  harness: { name: 'alambic-dev-workflow', path: '_meta/skills/alambic-dev-workflow.md' },
  attention: { name: 'technical-attention-intake', path: 'ref/technical-attention-intake.md' },
  obsidian: { name: 'obsidian-hybrid-workflow', path: 'ref/obsidian-hybrid-workflow.md' },
  security: { name: 'agent-trust', path: 'kb/agent-input-and-tool-trust-boundaries.md' },
  graph: { name: 'derived-graph', path: 'kb/derived-graph-markdown-canonical.md' },
  retrieval: { name: 'compiled-wiki', path: 'kb/compiled-wiki-vs-rag-complement.md' },
}

/**
 * Augment metadata routing with one-hop graph propagation and skill hints.
 * Does not change write authority; read-only routing aid.
 */
export function routeQueryWithGraph(root, prompt, options = {}) {
  const baseRoute = routeVaultKnowledge(root, prompt, options)
  return augmentRouteWithGraph(root, baseRoute)
}

export function augmentRouteWithGraph(root, baseRoute, graphSnapshot = null) {
  if (baseRoute.abstained) {
    return { ...baseRoute, matched_skills: [], graph_propagated_notes: [] }
  }

  const graph = graphSnapshot || loadGraph(root)
  const matchedPaths = baseRoute.matched_notes.map((note) => note.path)
  const graphPropagated = new Set()
  const matchedSkillsMap = new Map()

  for (const edge of graph.edges || []) {
    if (matchedPaths.includes(edge.source)) {
      const target = graph.nodes?.[edge.target]
      if (target && ['verified', 'accepted'].includes(target.status)) graphPropagated.add(edge.target)
    }
    if (matchedPaths.includes(edge.target)) {
      const source = graph.nodes?.[edge.source]
      if (source && ['verified', 'accepted'].includes(source.status)) graphPropagated.add(edge.source)
    }
  }

  for (const topic of baseRoute.topics || []) {
    const key = String(topic).toLowerCase()
    if (SKILL_MAP[key]) matchedSkillsMap.set(SKILL_MAP[key].name, SKILL_MAP[key])
  }
  for (const note of baseRoute.matched_notes || []) {
    for (const tag of note.tags || []) {
      const key = String(tag).toLowerCase()
      if (SKILL_MAP[key]) matchedSkillsMap.set(SKILL_MAP[key].name, SKILL_MAP[key])
    }
  }

  return {
    ...baseRoute,
    matched_skills: [...matchedSkillsMap.values()],
    graph_propagated_notes: [...graphPropagated]
      .filter((pathKey) => !matchedPaths.includes(pathKey))
      .slice(0, 4)
      .map((pathKey) => ({
        path: pathKey,
        status: graph.nodes[pathKey]?.status,
        pagerank: graph.nodes[pathKey]?.pagerank,
      })),
  }
}
