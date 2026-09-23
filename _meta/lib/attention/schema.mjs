import fs from 'node:fs'
import path from 'node:path'
import { assertNoForbiddenFields, canonicalizeUrl, safeText } from './privacy.mjs'

export const ATTENTION_SOURCES = Object.freeze([
  'youtube-liked',
  'reddit-saved',
  'reddit-upvoted',
  'x-bookmarks',
  'chrome-history',
])

const EVENT_TYPES = Object.freeze({
  'youtube-liked': 'like',
  'reddit-saved': 'save',
  'reddit-upvoted': 'upvote',
  'x-bookmarks': 'bookmark',
  'chrome-history': 'visit',
})

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

export function assertSource(source) {
  if (!ATTENTION_SOURCES.includes(source)) throw new Error(`unsupported attention source: ${source}`)
  return source
}

export function readAttentionPolicy(root) {
  const file = path.join(root, '_meta', 'technical-attention-policy.json')
  let policy
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown parse error'
    throw new Error(`invalid attention policy file: ${detail}`)
  }
  validatePolicy(policy)
  return policy
}

export function validatePolicy(policy) {
  if (!policy || policy.version !== 2 || !policy.limits || !policy.sources || !policy.ranking || !policy.classifier) throw new Error('invalid attention policy')
  for (const source of ATTENTION_SOURCES) {
    const config = policy.sources[source]
    if (!config || typeof config.enabled !== 'boolean' || !Number.isFinite(config.weight) || config.weight <= 0) throw new Error(`invalid attention policy source: ${source}`)
  }
  for (const key of ['max_items_per_source', 'max_candidates_per_run', 'digest_limit', 'candidate_retention_days', 'tombstone_retention_days', 'receipt_retention_days', 'metrics_retention_days', 'disabled_audit_retention_days', 'max_seen_digests']) {
    if (!Number.isInteger(policy.limits[key]) || policy.limits[key] <= 0) throw new Error(`invalid attention policy limit: ${key}`)
  }
  const rankingSignals = ['source', 'technical', 'topics', 'recency', 'query']
  const rankingWeightKeys = Object.keys(policy.ranking.weights || {}).sort()
  if (rankingWeightKeys.join(',') !== [...rankingSignals].sort().join(',')) throw new Error('invalid attention ranking weights')
  const rankingWeightSum = rankingSignals.reduce((sum, signal) => {
    const weight = policy.ranking.weights[signal]
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`invalid attention ranking weight: ${signal}`)
    return sum + weight
  }, 0)
  if (Math.abs(rankingWeightSum - 1) > 1e-9) throw new Error('attention ranking weights must sum to 1')
  const nonQueryWeightSum = rankingSignals
    .filter((signal) => signal !== 'query')
    .reduce((sum, signal) => sum + policy.ranking.weights[signal], 0)
  if (nonQueryWeightSum <= 0) throw new Error('attention ranking requires a positive non-query weight')
  for (const key of ['max_term_reasons', 'max_topics', 'recency_window_days']) {
    if (!Number.isInteger(policy.ranking[key]) || policy.ranking[key] <= 0) throw new Error(`invalid attention ranking setting: ${key}`)
  }
  return policy
}

export function validateRawEvent(raw, source) {
  assertSource(source)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('attention adapter returned invalid item')
  const allowed = new Set(['id', 'url', 'title', 'text', 'occurred_at'])
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`attention adapter returned unknown field(s): ${unknown.join(', ')}`)
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 512) throw new Error('attention adapter item id is required')
  if (typeof raw.url !== 'string' || !raw.url) throw new Error('attention adapter item url is required')
  if (typeof raw.title !== 'string' || !raw.title) throw new Error('attention adapter item title is required')
  if (raw.text !== undefined && typeof raw.text !== 'string') throw new Error('attention adapter item text must be a string')
  if (raw.occurred_at !== undefined && !isIsoDate(raw.occurred_at)) throw new Error('attention adapter item occurred_at must be an ISO date')
  return raw
}

export function buildCandidate({ source, raw, canonicalUrl, classification, policy, now }) {
  assertSource(source)
  validateRawEvent(raw, source)
  if (!classification?.accepted) throw new Error('cannot build a candidate from a rejected attention event')
  const title = safeText(raw.title)
  if (!title) throw new Error('attention candidate title is unsafe')
  const observedAt = raw.occurred_at || now
  // Retention starts at ingest time (now), not original event time — otherwise
  // bookmarks older than candidate_retention_days vanish immediately on purge.
  const retentionBase = Math.max(Date.parse(now), Date.parse(observedAt))
  if (!Number.isFinite(retentionBase)) throw new Error('attention candidate has invalid now/observed_at')
  const expiresAt = new Date(retentionBase + policy.limits.candidate_retention_days * 86400_000).toISOString()
  const candidate = {
    version: 1,
    source,
    event_type: EVENT_TYPES[source],
    canonical_url: canonicalUrl,
    title,
    observed_at: observedAt,
    expires_at: expiresAt,
    signal_weight: policy.sources[source].weight,
    reason_codes: classification.reason_codes,
    topics: classification.topics,
    confidence: 'deterministic',
  }
  validateCandidate(candidate)
  return candidate
}

export function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('attention candidate must be an object')
  const required = ['version', 'source', 'event_type', 'canonical_url', 'title', 'observed_at', 'expires_at', 'signal_weight', 'reason_codes', 'topics', 'confidence']
  const unknown = Object.keys(candidate).filter((key) => !required.includes(key))
  if (unknown.length || required.some((key) => !Object.hasOwn(candidate, key))) throw new Error('attention candidate has an invalid shape')
  assertNoForbiddenFields(candidate)
  assertSource(candidate.source)
  if (candidate.version !== 1 || candidate.event_type !== EVENT_TYPES[candidate.source]) throw new Error('attention candidate has an invalid version or event type')
  if (typeof candidate.canonical_url !== 'string' || !candidate.canonical_url || typeof candidate.title !== 'string' || !candidate.title || candidate.title.length > 240) throw new Error('attention candidate has invalid content')
  const normalized = canonicalizeUrl(candidate.canonical_url, candidate.source)
  if (!normalized.ok || normalized.canonical_url !== candidate.canonical_url) throw new Error('attention candidate URL is not canonical')
  if (!isIsoDate(candidate.observed_at) || !isIsoDate(candidate.expires_at) || Date.parse(candidate.expires_at) <= Date.parse(candidate.observed_at)) throw new Error('attention candidate has invalid retention dates')
  if (!Number.isFinite(candidate.signal_weight) || candidate.signal_weight <= 0 || candidate.confidence !== 'deterministic') throw new Error('attention candidate has invalid ranking metadata')
  if (!Array.isArray(candidate.reason_codes) || !candidate.reason_codes.length || candidate.reason_codes.some((value) => typeof value !== 'string' || !value)) throw new Error('attention candidate reason codes are invalid')
  if (!Array.isArray(candidate.topics) || candidate.topics.some((value) => typeof value !== 'string' || !value)) throw new Error('attention candidate topics are invalid')
  return candidate
}
