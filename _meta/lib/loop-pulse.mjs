import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildGraph } from './graph-builder.mjs'
import { checkGraphLint } from './graph-linter.mjs'
import { lintVault, queryVault, validateVault, retrievalHealth } from './vault.mjs'

const MAX_SEEDED_PROPOSALS = 3
const PULSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'alambic')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* ignore */ }
}

function atomicWrite(file, text, mode = 0o600) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { mode })
  try { fs.chmodSync(temporary, mode) } catch { /* ignore */ }
  fs.renameSync(temporary, file)
}

function atomicJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Build a CI/local living-loop pulse.
 * Never invents human review receipts or human feedback counts.
 * May seed shadow proposals and record deterministic eval feedback separately.
 */
export function runLivingLoopPulse(root, {
  seedProposals = false,
  runEvals = false,
  writeInbox = false,
  writePulseFile = true,
  maxProposals = MAX_SEEDED_PROPOSALS,
} = {}) {
  const started = new Date().toISOString()
  const validation = validateVault(root, { strict: true })
  let graphStats = null
  let graphError = null
  try {
    const graph = buildGraph(root, { force: true, writeCache: true })
    graphStats = graph.stats
  } catch (error) {
    graphError = error instanceof Error ? error.message : String(error)
  }

  const lint = lintVault(root)
  const graphLint = checkGraphLint(root)
  const health = retrievalHealth(root)

  const evalReport = runEvals ? runEvalPulse(root) : null
  if (evalReport && evalReport.recorded) {
    recordEvalFeedback(evalReport)
  }

  const seeded = seedProposals
    ? seedShadowProposalsFromGraphLint(root, graphLint, { maxProposals })
    : { created: [], skipped: [], reason: 'seed-disabled' }

  let inboxPath = null
  if (writeInbox) {
    inboxPath = writeInboxQueueCard(root, {
      started,
      validation,
      lint,
      graphLint,
      seeded,
      evalReport,
      graphStats,
    })
  }

  const dir = stateDir()
  ensureDir(dir)
  ensureDir(path.join(dir, 'proposals'))
  ensureDir(path.join(dir, 'reviews'))
  ensureDir(path.join(dir, 'feedback'))
  ensureDir(path.join(dir, 'pulses'))

  const proposalNames = fs.readdirSync(path.join(dir, 'proposals')).filter((name) => name.endsWith('.json'))
  const reviewNames = fs.readdirSync(path.join(dir, 'reviews')).filter((name) => name.endsWith('.json'))
  const pending = proposalNames.filter((name) => !fs.existsSync(path.join(dir, 'reviews', name)))
  const humanFeedback = readFeedbackCounts(path.join(dir, 'feedback', 'counts.json'))
  const evalFeedback = readFeedbackCounts(path.join(dir, 'feedback', 'eval-counts.json'))
  const humanFeedbackTotal = sumFeedback(humanFeedback)
  const evalFeedbackTotal = sumFeedback(evalFeedback)

  const pulse = {
    version: 1,
    kind: 'living-loop-pulse',
    generated_at: started,
    root,
    validation: { ok: validation.ok, notes: validation.notes, errors: validation.errors?.length || 0 },
    lint: {
      ok: lint.ok,
      orphans: lint.summary?.orphans ?? 0,
      review_due: lint.summary?.review_due ?? 0,
      stale_or_superseded: lint.summary?.stale_or_superseded ?? 0,
      semantic_conflicts: lint.summary?.semantic_conflicts ?? 0,
      graph_co_occurrence_gaps: lint.summary?.graph_co_occurrence_gaps ?? graphLint.co_occurrence_gaps?.length ?? 0,
      graph_stale_invalidations: lint.summary?.graph_stale_invalidations ?? graphLint.stale_invalidations?.length ?? 0,
    },
    graph: { stats: graphStats, error: graphError, source_snapshot_sha256: health.snapshot?.source_snapshot_sha256 || null },
    retrieval: { backend: health.backend, retrieval_mode: health.retrieval_mode },
    seeded_proposals: seeded,
    inbox_queue: inboxPath,
    eval: evalReport,
    living_loop: {
      proposals: proposalNames.length,
      reviews: reviewNames.length,
      pending_reviews: pending.length,
      human_feedback_total: humanFeedbackTotal,
      human_feedback: humanFeedback,
      eval_feedback_total: evalFeedbackTotal,
      eval_feedback: evalFeedback,
      apply_mode: 'class-a-ci-class-b-off',
      apply_class_a: 'ci-writer',
      apply_class_b: 'disabled',
    },
    checklist: {
      validation_green: Boolean(validation.ok),
      lint_structural_green: Boolean(lint.ok),
      graph_rebuild_ok: !graphError,
      eval_green: evalReport ? Boolean(evalReport.ok) : null,
      reviews_ge_20: reviewNames.length >= 20,
      human_feedback_ge_10: humanFeedbackTotal >= 10,
      pending_reviews_zero: pending.length === 0,
      class_a: 'ci-writer',
      class_b: 'disabled',
      apply_still_disabled: true,
      // Hygiene can be CI-owned; human supervision cannot.
      hygiene_ready: Boolean(validation.ok && lint.ok && !graphError && (evalReport ? evalReport.ok : true)),
      supervision_ready: reviewNames.length >= 20 && humanFeedbackTotal >= 10 && pending.length === 0,
    },
    next_actions: buildNextActions({ pending, reviewNames, humanFeedbackTotal, seeded, graphLint }),
  }

  if (writePulseFile) {
    const latestRepo = path.join(root, '_meta/loop-pulse.latest.json')
    const latestState = path.join(dir, 'pulses', `pulse-${started.slice(0, 10)}-${sha256(started).slice(0, 8)}.json`)
    try {
      atomicJson(latestRepo, pulse)
    } catch {
      // read-only checkout
    }
    try {
      atomicJson(latestState, pulse)
    } catch {
      // ignore state write failures in locked CI
    }
    pulse.pulse_paths = { repo: latestRepo, state: latestState }
  }

  return pulse
}

export function loadLatestPulse(root) {
  const repoPulse = path.join(root, '_meta/loop-pulse.latest.json')
  if (fs.existsSync(repoPulse)) {
    try {
      return { source: 'repo', pulse: JSON.parse(fs.readFileSync(repoPulse, 'utf8')) }
    } catch {
      // fall through
    }
  }
  const dir = path.join(stateDir(), 'pulses')
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse()
  if (!files.length) return null
  try {
    return { source: 'state', pulse: JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) }
  } catch {
    return null
  }
}

export function pulseFreshness(pulse, { now = Date.now(), maxAgeMs = PULSE_MAX_AGE_MS } = {}) {
  if (!pulse?.generated_at) return { fresh: false, age_ms: null, max_age_ms: maxAgeMs }
  const age = now - Date.parse(pulse.generated_at)
  return { fresh: Number.isFinite(age) && age >= 0 && age <= maxAgeMs, age_ms: age, max_age_ms: maxAgeMs }
}

function readFeedbackCounts(file) {
  if (!fs.existsSync(file)) return { version: 1, hit: 0, miss: 0, stale: 0, wrong: 0 }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { version: 1, hit: 0, miss: 0, stale: 0, wrong: 0 }
  }
}

function sumFeedback(counts) {
  return (counts.hit || 0) + (counts.miss || 0) + (counts.stale || 0) + (counts.wrong || 0)
}

function recordEvalFeedback(evalReport) {
  const file = path.join(stateDir(), 'feedback', 'eval-counts.json')
  ensureDir(path.dirname(file))
  const counts = readFeedbackCounts(file)
  // One aggregate signal per pulse category outcome — no query text.
  if (evalReport.ok) counts.hit = (counts.hit || 0) + 1
  else counts.miss = (counts.miss || 0) + 1
  counts.updated_at = new Date().toISOString()
  counts.source = 'eval-pulse'
  atomicJson(file, counts)
}

function runEvalPulse(root) {
  const cli = path.join(root, '_meta/alambic')
  const suites = ['retrieval', 'retrieval-semantic', 'graph-engineering']
  const results = []
  let ok = true
  for (const suite of suites) {
    const run = spawnSync(cli, ['eval', '--suite', suite], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 120_000,
    })
    let parsed = null
    try {
      parsed = JSON.parse(run.stdout || '{}')
    } catch {
      parsed = { suite, parse_error: true }
    }
    const suiteOk = run.status === 0
    if (!suiteOk) ok = false
    results.push({
      suite,
      ok: suiteOk,
      status: run.status,
      // keep only aggregate fields, never query text
      summary: summarizeEval(parsed),
    })
  }
  // Lightweight lexical smoke without spawning for latency-sensitive CI paths
  const smoke = queryVault(root, 'derived graph markdown source of truth', { limit: 3 })
  const smokeOk = smoke.some((row) => row.path.includes('derived-graph'))
  if (!smokeOk) ok = false
  results.push({ suite: 'smoke-derived-graph', ok: smokeOk, status: smokeOk ? 0 : 1, summary: { hits: smoke.length } })

  return { ok, recorded: true, results }
}

function summarizeEval(parsed) {
  if (!parsed || typeof parsed !== 'object') return {}
  const out = { suite: parsed.suite }
  if (parsed.hit_at_5 != null) out.hit_at_5 = parsed.hit_at_5
  if (parsed.mrr_at_5 != null) out.mrr_at_5 = parsed.mrr_at_5
  if (parsed.categories) {
    out.categories = Object.fromEntries(
      Object.entries(parsed.categories).map(([key, value]) => [key, { hit_at_5: value.hit_at_5, cases: value.cases }]),
    )
  }
  if (parsed.live_nodes != null) out.live_nodes = parsed.live_nodes
  if (parsed.privacy_blocked != null) out.privacy_blocked = parsed.privacy_blocked
  return out
}

/**
 * Seed deterministic noop shadow proposals from graph-lint signals.
 * Human still must review; apply remains disabled.
 */
export function seedShadowProposalsFromGraphLint(root, graphLint, { maxProposals = MAX_SEEDED_PROPOSALS } = {}) {
  const dir = path.join(stateDir(), 'proposals')
  ensureDir(dir)
  const created = []
  const skipped = []

  const candidates = []
  for (const gap of graphLint.co_occurrence_gaps || []) {
    candidates.push({
      kind: 'co-occurrence-gap',
      source: gap.source,
      target: gap.target,
      shared_tags: gap.shared_tags || [],
      rationale: `Graph lint: notes share tags [${(gap.shared_tags || []).join(', ')}] but have no wikilink. Consider linking or documenting why not.`,
    })
  }
  for (const item of graphLint.stale_invalidations || []) {
    candidates.push({
      kind: 'stale-dependency',
      source: item.verified_note,
      target: item.stale_dependency,
      shared_tags: [],
      rationale: `Graph lint: verified note links to ${item.stale_dependency} which is stale/superseded. Review Related links or supersede edge.`,
    })
  }

  for (const candidate of candidates) {
    if (created.length >= maxProposals) break
    // Canonical proposal only (no extra fields): review hash must match distill contract.
    const canonical = {
      version: 1,
      action: 'noop',
      target: 'kb/_index.md',
      source_refs: [candidate.source, candidate.target, '_meta/lib/graph-linter.mjs'].filter(Boolean),
      trust: 'trusted-local',
      rationale: candidate.rationale.slice(0, 500),
      preimage_sha256: '',
      patch: '',
    }
    const proposalSha256 = sha256(JSON.stringify(canonical))
    const file = path.join(dir, `${proposalSha256}.json`)
    if (fs.existsSync(file)) {
      skipped.push({ path: file, reason: 'already-seeded', kind: candidate.kind })
      continue
    }
    atomicJson(file, { ...canonical, mode: 'shadow', proposal_sha256: proposalSha256 })
    created.push({ path: file, proposal_sha256: proposalSha256, kind: candidate.kind, source: candidate.source, target: candidate.target })
  }

  return { created, skipped, considered: candidates.length }
}

function writeInboxQueueCard(root, payload) {
  const day = payload.started.slice(0, 10).replace(/-/g, '')
  const dir = path.join(root, 'docs/inbox/ai')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `loop-queue-${day}.md`)
  const gaps = (payload.graphLint?.co_occurrence_gaps || []).slice(0, 8)
  const stale = (payload.graphLint?.stale_invalidations || []).slice(0, 8)
  const seeded = payload.seeded?.created || []
  const lines = [
    '---',
    'type: staging',
    'status: draft',
    `summary: "Living-loop CI/local queue for ${payload.started.slice(0, 10)} — review only, no auto-apply"`,
    `created: ${payload.started.slice(0, 10)}`,
    '---',
    '',
    `# Living loop queue ${payload.started.slice(0, 10)}`,
    '',
    'Staging only. Not durable kb. Apply-auto remains DISABLED.',
    '',
    '## Hygiene',
    '',
    `- validation: ${payload.validation?.ok ? 'ok' : 'FAILED'}`,
    `- lint: ${payload.lint?.ok ? 'ok' : 'review'}`,
    `- graph nodes/edges: ${payload.graphStats?.total_nodes ?? 'n/a'}/${payload.graphStats?.total_edges ?? 'n/a'}`,
    `- eval pulse: ${payload.evalReport ? (payload.evalReport.ok ? 'ok' : 'FAILED') : 'skipped'}`,
    '',
    '## Seeded shadow proposals',
    '',
    seeded.length
      ? seeded.map((item) => `- \`${item.proposal_sha256.slice(0, 12)}\` ${item.kind}: ${item.source} → ${item.target}`).join('\n')
      : '- (none this run)',
    '',
    '## Co-occurrence gaps (review)',
    '',
    gaps.length
      ? gaps.map((gap) => `- ${gap.source} ↔ ${gap.target} (tags: ${(gap.shared_tags || []).join(', ')})`).join('\n')
      : '- none',
    '',
    '## Stale dependency edges (review)',
    '',
    stale.length
      ? stale.map((item) => `- ${item.verified_note} → ${item.stale_dependency}`).join('\n')
      : '- none',
    '',
    '## Human next actions',
    '',
    '1. `_meta/alambic status --json` — pending proposals',
    '2. `_meta/alambic review --proposal FILE --decision accept|reject --reason "…"`',
    '3. If accept useful: update existing kb note (wikilink/claims), then validate',
    '4. After retrieval in a real session: `_meta/alambic feedback --status hit|miss|stale|wrong`',
    '',
  ]
  atomicWrite(file, `${lines.join('\n')}\n`, 0o644)
  return file
}

function buildNextActions({ pending, reviewNames, humanFeedbackTotal, seeded, graphLint }) {
  const actions = []
  if (pending.length) {
    actions.push(`Review ${pending.length} pending shadow proposal(s): _meta/alambic review --proposal FILE --decision accept|reject --reason "…"`)
  } else if (seeded?.created?.length) {
    actions.push(`Review ${seeded.created.length} newly seeded proposal(s) from graph lint`)
  } else {
    actions.push('No pending shadow proposals — run loop --ci --seed-proposals after bulk edits')
  }
  if (reviewNames.length < 20) {
    actions.push(`Human reviews: ${reviewNames.length}/20 toward shadow-apply-gate (do not fabricate)`)
  }
  if (humanFeedbackTotal < 10) {
    actions.push(`Human feedback: ${humanFeedbackTotal}/10 — log after real retrieval sessions only`)
  }
  const gaps = graphLint?.co_occurrence_gaps?.length || 0
  if (gaps) actions.push(`Graph co-occurrence gaps open: ${gaps} (warnings only)`)
  actions.push('Class A/A2 writes belong to GitHub Actions; Class B distill --apply stays off without shadow-apply-gate + current-work YES')
  return actions
}
