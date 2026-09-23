import { classifyTechnical } from './classifier.mjs'
import { canonicalizeUrl } from './privacy.mjs'
import { buildCandidate, assertSource, ATTENTION_SOURCES, validateRawEvent } from './schema.mjs'
import { validateCredentialMetadata } from './credentials.mjs'
import { promoteCandidateDraft, stagePromoteCandidates } from './stage.mjs'
import { promoteSuggest as runPromoteSuggest, writeSynthesis } from './compile.mjs'
import { rankAttentionCandidates } from './ranking.mjs'

function reasonCounts(items) {
  return Object.fromEntries(items.reduce((counts, item) => {
    for (const reason of item.reason_codes || []) counts.set(reason, (counts.get(reason) || 0) + 1)
    return counts
  }, new Map()))
}

export class AttentionService {
  constructor({ policy, state, credentials, connectors = {}, connectorFactory = null, now = () => new Date().toISOString() }) {
    this.policy = policy
    this.state = state
    this.credentials = credentials
    this.connectors = connectors
    this.connectorFactory = connectorFactory
    this.now = now
  }

  async authCheck(source) {
    assertSource(source)
    if (source === 'chrome-history') {
      // Live multi-device client is created by connectorFactory; without it, remain unsupported.
      const result = {
        status: 'unsupported',
        checked_at: this.now(),
        evidence: 'chrome multi-device client unavailable (no foreign originators or missing local cache_guid)',
      }
      return this.state.saveCapability(source, result)
    }
    const metadata = await this.credentials.inspect(source)
    const checked = validateCredentialMetadata(source, metadata)
    const result = checked.ok
      ? { status: 'blocked-policy', checked_at: this.now(), evidence: 'credential metadata verified live probe requires human checkpoint', account_alias: checked.account_alias, scope_fingerprint: checked.scope_fingerprint }
      : { status: 'blocked-auth', checked_at: this.now(), evidence: checked.reason }
    return this.state.saveCapability(source, result)
  }

  async collect({ source, connector, dryRun = false }) {
    assertSource(source)
    const resolvedConnector = connector || this.connectors[source] || await this.connectorFactory?.(source)
    if (!resolvedConnector) {
      const capability = await this.authCheck(source)
      return { source, status: capability.status, accepted: 0, rejected: 0, replayed: 0, candidates: [], cursor_advanced: false }
    }
    if (resolvedConnector.source !== source || typeof resolvedConnector.collect !== 'function') throw new Error(`invalid attention connector: ${source}`)
    const keys = this.state.keys(source)
    if (!keys) {
      const capability = this.state.saveCapability(source, { status: 'blocked-auth', checked_at: this.now(), evidence: 'per-source key unavailable from OS-backed credential boundary' })
      return { source, status: capability.status, accepted: 0, rejected: 0, replayed: 0, candidates: [], cursor_advanced: false }
    }

    const collectWithResolvedConnector = async () => {
      const response = await resolvedConnector.collect({ limit: this.policy.limits.max_items_per_source })
      if (response?.unsupported) {
        if (!dryRun) {
          const raw = String(response.unsupported || 'unsupported')
          const evidence = raw.replace(/[^a-z0-9 .:_-]+/gi, ' ').trim().slice(0, 160) || 'unsupported'
          this.state.saveCapability(source, { status: 'unsupported', checked_at: this.now(), evidence })
        }
        return { source, status: 'unsupported', accepted: 0, rejected: 0, replayed: 0, candidates: [], cursor_advanced: false }
      }
      if (!response || !Array.isArray(response.items) || response.items.length > this.policy.limits.max_items_per_source) throw new Error(`${source} collection response is invalid`)
      const cursor = this.state.loadCursor(source)
      const prepared = []
      const metrics = { accepted: 0, rejected: 0, replayed: 0, reasons: {} }

      for (const raw of response.items) {
        validateRawEvent(raw, source)
        const digest = this.state.digest(source, raw.id, keys.hmac)
        if (this.state.hasSeen(cursor, digest, this.now())) {
          metrics.replayed += 1
          continue
        }
        const canonical = canonicalizeUrl(raw.url, source)
        const classification = canonical.ok ? classifyTechnical(raw, canonical.canonical_url, this.policy) : { accepted: false, reason_codes: [canonical.reason], topics: [] }
        if (!classification.accepted) {
          metrics.rejected += 1
          for (const reason of classification.reason_codes) metrics.reasons[reason] = (metrics.reasons[reason] || 0) + 1
          prepared.push({ kind: 'reject', digest, reason_code: classification.reason_codes[0] })
          continue
        }
        if (prepared.filter((item) => item.kind === 'candidate').length >= this.policy.limits.max_candidates_per_run) {
          metrics.rejected += 1
          metrics.reasons['run-cap-reached'] = (metrics.reasons['run-cap-reached'] || 0) + 1
          prepared.push({ kind: 'reject', digest, reason_code: 'run-cap-reached' })
          continue
        }
        const candidate = buildCandidate({ source, raw, canonicalUrl: canonical.canonical_url, classification, policy: this.policy, now: this.now() })
        prepared.push({ kind: 'candidate', digest, candidate })
        metrics.accepted += 1
      }

      if (!dryRun) {
        for (const item of prepared) {
          const expiresAt = item.kind === 'candidate'
            ? item.candidate.expires_at
            : new Date(Date.parse(this.now()) + this.policy.limits.tombstone_retention_days * 86400_000).toISOString()
          if (item.kind === 'candidate') this.state.saveCandidate(source, item.digest, item.candidate, keys.data)
          else this.state.saveTombstone(source, item.digest, item.reason_code, expiresAt)
          this.state.markSeen(cursor, item.digest, expiresAt, this.policy.limits.max_seen_digests)
        }
        cursor.policy_version = this.policy.version
        cursor.last_success_at = this.now()
        this.state.saveCursor(source, cursor)
        this.state.saveMetrics(source, metrics)
        this.state.saveCapability(source, {
          status: resolvedConnector.capability_status || 'fixture-green',
          checked_at: this.now(),
          evidence: resolvedConnector.capability_evidence || 'local injected fixture adapter completed not live-provider evidence',
        })
        this.state.purge(source, this.policy)
      }

      return {
        source,
        status: dryRun ? 'dry-run' : (resolvedConnector.capability_status || 'fixture-green'),
        accepted: metrics.accepted,
        rejected: metrics.rejected,
        replayed: metrics.replayed,
        reason_counts: metrics.reasons,
        candidates: prepared.filter((item) => item.kind === 'candidate').map((item) => ({ digest: item.digest, ...item.candidate })),
        cursor_advanced: !dryRun,
      }
    }
    return dryRun ? collectWithResolvedConnector() : this.state.withLock(source, collectWithResolvedConnector)
  }

  digest({ limit = this.policy.limits.digest_limit, query = '' } = {}) {
    const entries = []
    for (const source of ATTENTION_SOURCES) {
      const keys = this.state.keys(source)
      if (!keys) continue
      for (const { digest, candidate } of this.state.listCandidates(source, keys.data)) {
        entries.push({ digest, ...candidate })
      }
    }
    return rankAttentionCandidates(entries, {
      policy: this.policy,
      now: this.now(),
      query,
      limit,
    })
  }

  /**
   * Stage digest entries under docs/inbox/ai/ for human promote review.
   * Never writes kb/ or ref/. dryRun previews without filesystem writes.
   */
  stage({ root, limit, dryRun = false, runId = 'attention-daily' } = {}) {
    if (!root) throw new Error('attention stage requires repository root')
    const entries = this.digest({ limit })
    return stagePromoteCandidates({ root, entries, now: this.now, dryRun, runId })
  }

  /**
   * Human-confirm path: stages a single candidate draft under docs/inbox/ai/.
   * Refuses without --confirm; never writes kb/ or ref/.
   */
  promote({ root, source, digest, confirm = false } = {}) {
    if (!root) throw new Error('attention promote requires repository root')
    if (!confirm) return promoteCandidateDraft({ root, entry: { source, digest }, confirm: false, now: this.now })
    assertSource(source)
    const keys = this.state.keys(source)
    if (!keys) throw new Error(`attention keys are unavailable for ${source}`)
    const candidate = this.state.loadCandidate(source, digest, keys.data)
    if (!candidate) throw new Error('attention candidate is missing or expired')
    return promoteCandidateDraft({
      root,
      entry: { digest, ...candidate },
      confirm: true,
      now: this.now,
    })
  }

  /**
   * Compile digest entries into a high-signal inbox synthesis (never kb/ref).
   */
  compile({ root, limit, dryRun = false, runId = 'attention-compile', maxClaims } = {}) {
    if (!root) throw new Error('attention compile requires repository root')
    const entries = this.digest({ limit })
    return writeSynthesis({ root, entries, now: this.now, dryRun, runId, maxClaims })
  }

  /**
   * Suggest promote targets; --confirm stages inbox drafts only.
   */
  promoteSuggest({ root, limit, confirm = false, maxClaims } = {}) {
    if (!root) throw new Error('attention promote-suggest requires repository root')
    const entries = this.digest({ limit })
    return runPromoteSuggest({ root, entries, confirm, now: this.now, maxClaims })
  }

  review({ source, digest, decision, reasonCode }) {
    assertSource(source)
    const keys = this.state.keys(source)
    if (!keys) throw new Error(`attention keys are unavailable for ${source}`)
    const candidate = this.state.loadCandidate(source, digest, keys.data)
    if (!candidate) throw new Error('attention candidate is missing or expired')
    return this.state.saveReceipt(source, digest, decision, reasonCode)
  }

  purge(source) {
    if (source) return { source, removed: this.state.purge(source, this.policy) }
    return Object.fromEntries(ATTENTION_SOURCES.map((entry) => [entry, this.state.purge(entry, this.policy)]))
  }

  async disconnect({ source, dryRun = true, confirm = false }) {
    assertSource(source)
    if (dryRun || !confirm) return this.state.disconnect(source, { dryRun: true, confirm: false })
    await this.credentials.forget(source)
    return this.state.disconnect(source, { dryRun: false, confirm: true })
  }

  async collectEnabled({ dryRun = false } = {}) {
    const sources = ATTENTION_SOURCES.filter((source) => this.policy.sources[source].enabled)
    const results = []
    for (const source of sources) results.push(await this.collect({ source, dryRun }))
    return results
  }

  status() {
    return { policy_version: this.policy.version, sources: this.state.status().sources }
  }
}

export { reasonCounts }
