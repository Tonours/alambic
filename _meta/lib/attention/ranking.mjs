import { createCandidatePipeline } from './candidate-pipeline.mjs'

const DAY_MS = 86_400_000
const SIGNAL_NAMES = Object.freeze(['source', 'technical', 'topics', 'recency', 'query'])
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'de', 'des', 'du', 'et', 'for', 'in', 'la', 'le', 'les',
  'of', 'on', 'or', 'pour', 'the', 'to', 'un', 'une', 'with',
])

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function tokenize(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !QUERY_STOPWORDS.has(token)))]
}

function querySignal(candidate, queryTokens) {
  if (!queryTokens.length) return 0
  const reasonTerms = (candidate.reason_codes || [])
    .filter((reason) => String(reason).startsWith('term:'))
    .map((reason) => String(reason).slice(5))
  const haystack = new Set(tokenize([
    candidate.title,
    ...(candidate.topics || []),
    ...reasonTerms,
  ].join(' ')))
  const matches = queryTokens.filter((token) => haystack.has(token)).length
  return matches / queryTokens.length
}

function signalValues(candidate, { policy, now, queryTokens }) {
  const sourceWeights = Object.values(policy.sources).map((source) => source.weight)
  const maxSourceWeight = Math.max(...sourceWeights)
  const termReasons = new Set((candidate.reason_codes || []).filter((reason) => String(reason).startsWith('term:')))
  const observedAt = Date.parse(candidate.observed_at)
  const nowAt = Date.parse(now)
  const ageDays = Number.isFinite(observedAt) && Number.isFinite(nowAt)
    ? Math.max(0, nowAt - observedAt) / DAY_MS
    : policy.ranking.recency_window_days

  return {
    source: clamp(policy.sources[candidate.source].weight / maxSourceWeight),
    technical: candidate.reason_codes?.includes('technical-domain')
      ? 1
      : clamp(termReasons.size / policy.ranking.max_term_reasons),
    topics: clamp((candidate.topics || []).length / policy.ranking.max_topics),
    recency: clamp(1 - ageDays / policy.ranking.recency_window_days),
    query: querySignal(candidate, queryTokens),
  }
}

export function validateRankingQuery(query) {
  if (typeof query !== 'string' || query.length > 500) throw new Error('attention ranking query must be a string of at most 500 characters')
  if (query.trim() && !tokenize(query).length) throw new Error('attention ranking query has no searchable tokens')
  return query
}

export function scoreAttentionCandidate(candidate, { policy, now, query = '' } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('attention ranking requires a candidate object')
  validateRankingQuery(query)
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) throw new Error('attention ranking requires an injected ISO timestamp')

  const queryTokens = tokenize(query)
  if (query.trim() && !queryTokens.length) throw new Error('attention ranking query has no searchable tokens')
  const signals = signalValues(candidate, { policy, now, queryTokens })
  const activeNames = queryTokens.length ? SIGNAL_NAMES : SIGNAL_NAMES.filter((name) => name !== 'query')
  const activeWeight = activeNames.reduce((sum, name) => sum + policy.ranking.weights[name], 0)
  const reasons = activeNames.map((signal) => {
    const weight = policy.ranking.weights[signal] / activeWeight
    const contribution = signals[signal] * weight
    return {
      signal,
      value: round(signals[signal]),
      weight: round(weight),
      contribution: round(contribution * 100),
    }
  })
  const score = reasons.reduce((sum, reason) => sum + reason.contribution, 0)

  return {
    ...candidate,
    ranking_score: round(score),
    ranking_signals: Object.fromEntries(activeNames.map((name) => [name, round(signals[name])])),
    ranking_reasons: reasons,
  }
}

function stableCandidateId(candidate) {
  return String(candidate.digest || candidate.id || candidate.canonical_url || '')
}

function observedAtValue(candidate) {
  const value = Date.parse(candidate.observed_at)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

export function compareRankedCandidates(left, right) {
  return right.ranking_score - left.ranking_score
    || observedAtValue(right) - observedAtValue(left)
    || stableCandidateId(left).localeCompare(stableCandidateId(right))
}

export function rankAttentionCandidates(candidates, { policy, now, query = '', limit = policy?.limits?.digest_limit } = {}) {
  if (!policy?.ranking || !policy?.limits) throw new Error('attention ranking requires validated policy')
  const requestedLimit = Number(limit)
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) throw new Error('attention ranking limit must be a positive integer')
  const topK = Math.min(requestedLimit, policy.limits.digest_limit)
  const nowAt = Date.parse(now)
  if (!Number.isFinite(nowAt)) throw new Error('attention ranking requires an injected ISO timestamp')
  validateRankingQuery(query)

  const pipeline = createCandidatePipeline({
    filters: [{
      name: 'unexpired',
      keep(candidate) {
        return Number.isFinite(Date.parse(candidate.expires_at)) && Date.parse(candidate.expires_at) > nowAt
      },
    }],
    scorers: [{
      name: 'multi-signal',
      score(candidate) {
        return scoreAttentionCandidate(candidate, { policy, now, query })
      },
    }],
    selector: {
      name: 'deterministic-top-k',
      select(scored) {
        return [...scored].sort(compareRankedCandidates).slice(0, topK)
      },
    },
  })

  return pipeline.run(candidates, { now, query, limit: topK })
}
