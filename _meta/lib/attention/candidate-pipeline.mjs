function assertNamedStage(stage, method, kind) {
  if (!stage || typeof stage !== 'object' || typeof stage.name !== 'string' || !stage.name || typeof stage[method] !== 'function') {
    throw new Error(`attention candidate pipeline has an invalid ${kind} stage`)
  }
  return stage
}

/**
 * Build the smallest composable post-ingestion candidate pipeline.
 *
 * Filters and scorers run per candidate. They never receive the candidate
 * batch, which keeps scoring isolated from batch composition. Only the final
 * selector sees the scored list so it can apply deterministic Top-K ordering.
 */
export function createCandidatePipeline({ filters = [], scorers = [], selector } = {}) {
  if (!Array.isArray(filters) || !Array.isArray(scorers)) throw new Error('attention candidate pipeline stages must be arrays')
  const checkedFilters = filters.map((stage) => assertNamedStage(stage, 'keep', 'filter'))
  const checkedScorers = scorers.map((stage) => assertNamedStage(stage, 'score', 'scorer'))
  const checkedSelector = assertNamedStage(selector, 'select', 'selector')

  return Object.freeze({
    run(candidates, context = {}) {
      if (!Array.isArray(candidates)) throw new Error('attention candidate pipeline requires a candidate array')
      let current = candidates.map((candidate) => ({ ...candidate }))

      for (const filter of checkedFilters) {
        current = current.filter((candidate) => filter.keep(candidate, context))
      }
      for (const scorer of checkedScorers) {
        current = current.map((candidate) => scorer.score(candidate, context))
      }

      const selected = checkedSelector.select(current, context)
      if (!Array.isArray(selected)) throw new Error('attention candidate selector must return an array')
      return selected
    },
  })
}
