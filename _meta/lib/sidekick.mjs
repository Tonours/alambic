import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildGraph } from './graph-builder.mjs'
import { checkGraphLint } from './graph-linter.mjs'
import { runLivingLoopPulse } from './loop-pulse.mjs'
import {
  applyFreeformPromote,
  applyIndexEntry,
  applyStructuralWikilink,
  consumeFreeformBudget,
  freeformDailyBudget,
  judgeFreeformNote,
  judgeFreshStamp,
  judgeIndexEntry,
  judgeStaleSuccessor,
  judgeStructuralLink,
  postApplyHealth,
  sha256,
} from './promotion-judge.mjs'
import { askJev, noul } from './typesafe-judge.mjs'
import { buildManifest, listStagedMarkdown, queryVault, validateVault } from './vault.mjs'

function stateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'alambic')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/**
 * Autonomous shadow sidekick run (v2).
 *
 * - structural: wikilink co-occurrence + index entries + stale→successor
 * - freeform: oracle-gated promote from docs/inbox (update-first, daily budget)
 */
const NOOP_ORACLE_FAILURES = {
  structural_link: new Set(['both_active']),
  stale_successor: new Set(['missing_successor_link']),
}
const DEDUPE_COVERAGE_MIN = 0.7

export function isNoop(judgment) {
  const allowed = NOOP_ORACLE_FAILURES[judgment.class]
  const failed = Object.entries(judgment.oracles || {}).filter(([, value]) => !value).map(([key]) => key)
  return Boolean(allowed && failed.length && failed.every((key) => allowed.has(key)))
}

export function dedupeCanChange(judgment) {
  const failed = Object.entries(judgment.oracles || {}).filter(([, value]) => !value).map(([key]) => key)
  if (failed.length === 1 && failed[0] === 'update_or_unique') return true
  return failed.length === 0 && judgment.mode === 'create'
}

export async function semanticDedupe(root, judgment, options = {}) {
  const summary = String(judgment.data?.summary || '')
  const hits = queryVault(root, summary, { limit: 5, manifest: buildManifest(root, false, { fresh: true }) })
    .filter((hit) => hit.path.startsWith('kb/') && hit.path !== 'kb/_index.md' && ['verified', 'accepted', 'draft'].includes(hit.status))
  if (!hits.length) return { ...judgment, semantic: { available: false, reason: 'no_candidates' } }
  const judged = await askJev({
    state: { candidate: { title: judgment.title, summary }, existing: hits.map((hit) => ({ path: hit.path, title: hit.title, summary: hit.summary })) },
    questions: Object.fromEntries(hits.map((_, index) => [`covers_${index}`, noul(`Does \`existing[${index}]\` already cover the main claim of \`candidate\`?`, {
      true: 'The existing note states the same durable claim, so the candidate should update it instead of creating a new note.',
      false: 'The candidate adds a distinct durable claim that deserves its own note.',
    })])),
  }, options)
  if (!judged.available) return { ...judgment, semantic: judged }
  const best = hits.map((hit, index) => ({ hit, probability: judged.answers[`covers_${index}`].noul })).sort((a, b) => b.probability - a.probability)[0]
  const update = best.probability >= DEDUPE_COVERAGE_MIN
  return {
    ...judgment,
    oracles: { ...judgment.oracles, update_or_unique: true },
    decision: 'auto_apply',
    mode: update ? 'update' : 'create',
    update_target: update ? best.hit.path : null,
    suggested_action: update ? `update ${best.hit.path}` : `create kb/${judgment.create_basename}.md`,
    reason: `oracle:freeform-v2+jev ${update ? `update ${best.hit.path}` : `create ${judgment.create_basename}`}`,
    semantic: { available: true, coverage: Math.round(best.probability * 1000) / 1000, latency_ms: judged.latency_ms },
  }
}

export async function runSidekick(root, {
  dryRun = true,
  applyStructural = false,
  applyFreeform = false,
  maxActions = 8,
  maxFreeform = 3,
  seedProposals = true,
  writePulse = true,
  semanticOptions = {},
} = {}) {
  const started = new Date().toISOString()
  const actions = []
  const noops = []
  const rejected = []
  const quarantined = []
  const applyAny = applyStructural || applyFreeform

  const preValidate = validateVault(root, { strict: true })
  if (!preValidate.ok) {
    return {
      version: 2,
      kind: 'sidekick-run',
      started,
      dry_run: dryRun || !applyAny,
      apply_structural: applyStructural,
      apply_freeform: applyFreeform,
      ok: false,
      aborted: 'pre-validate-failed',
      autonomy: autonomyModel(),
      validation: { ok: false, errors: preValidate.errors?.length || 0 },
      actions: [],
      message: 'Refuse to auto-edit while vault validation is red',
    }
  }

  buildGraph(root, { force: true, writeCache: true })
  const graphLint = checkGraphLint(root)
  const budget = freeformDailyBudget()

  // 1) Structural co-occurrence gaps
  for (const gap of graphLint.co_occurrence_gaps || []) {
    if (actions.length >= maxActions) break
    const judgment = judgeStructuralLink(root, {
      sourcePath: gap.source,
      targetPath: gap.target,
      sharedTags: gap.shared_tags || [],
    })
    if (judgment.decision !== 'auto_apply') {
      (isNoop(judgment) ? noops : rejected).push(judgment)
      continue
    }
    const sourceBase = path.basename(gap.source, '.md')
    const targetBase = path.basename(gap.target, '.md')
    const planned = {
      type: 'structural_link',
      judgment,
      edits: [
        { path: gap.source, link: targetBase },
        { path: gap.target, link: sourceBase },
      ],
    }
    if (dryRun || !applyStructural) {
      actions.push({ ...planned, applied: false })
      continue
    }
    const results = planned.edits.map((edit) => applyStructuralWikilink(root, edit.path, edit.link))
    const health = postApplyHealth(root)
    writeOracleReceipt(judgment.reason, { kind: 'structural_link', source: gap.source, target: gap.target })
    actions.push({ ...planned, applied: true, results, health })
    if (!health.ok) break
  }

  // 2) Stale dependency → successor wikilink
  for (const item of graphLint.stale_invalidations || []) {
    if (actions.length >= maxActions) break
    const judgment = judgeStaleSuccessor(root, {
      verifiedPath: item.verified_note,
      stalePath: item.stale_dependency,
    })
    if (judgment.decision !== 'auto_apply') {
      (isNoop(judgment) ? noops : rejected).push(judgment)
      continue
    }
    if (dryRun || !applyStructural) {
      actions.push({ type: 'stale_successor', judgment, applied: false })
      continue
    }
    const result = applyStructuralWikilink(root, judgment.source, judgment.successor)
    const health = postApplyHealth(root)
    writeOracleReceipt(judgment.reason, { kind: 'stale_successor', source: judgment.source, target: judgment.successor })
    actions.push({ type: 'stale_successor', judgment, applied: true, result, health })
    if (!health.ok) break
  }

  // 3) Missing index entries for active notes
  let indexRaw = fs.readFileSync(path.join(root, 'kb/_index.md'), 'utf8')
  for (const note of buildManifest(root, false, { fresh: true })) {
    if (actions.length >= maxActions) break
    if (!note.path.startsWith('kb/') || note.path === 'kb/_index.md') continue
    if (!['verified', 'accepted'].includes(note.status)) continue
    if (indexRaw.includes(`[[${note.basename}]]`)) continue
    const judgment = judgeIndexEntry(root, note.path)
    if (judgment.decision !== 'auto_apply') {
      rejected.push(judgment)
      continue
    }
    if (dryRun || !applyStructural) {
      actions.push({ type: 'index_entry', judgment, applied: false })
      continue
    }
    const result = applyIndexEntry(root, note.basename)
    if (result.changed) indexRaw += `[[${note.basename}]]`
    const health = postApplyHealth(root)
    writeOracleReceipt(judgment.reason, { kind: 'index_entry', path: note.path })
    actions.push({ type: 'index_entry', judgment, applied: true, result, health })
    if (!health.ok) break
  }

  // 4) Freeform inbox promote (oracle + daily budget)
  let freeformApplied = 0
  let remaining = budget.remaining
  try {
    const inboxFiles = listStagedMarkdown(root)
      .filter((file) => file.includes(`${path.sep}inbox${path.sep}`))
      .filter((file) => !file.includes(`${path.sep}processed${path.sep}`))
      .slice(-30)

    for (const file of inboxFiles) {
      if (freeformApplied >= maxFreeform || remaining <= 0) break
      const lexicalJudgment = judgeFreeformNote(root, file, { freeformBudgetRemaining: remaining })
      const judgment = applyFreeform && !dryRun && dedupeCanChange(lexicalJudgment) ? await semanticDedupe(root, lexicalJudgment, semanticOptions) : lexicalJudgment
      if (judgment.decision === 'reject') {
        rejected.push(judgment)
        continue
      }
      if (judgment.decision === 'quarantine_ready') {
        quarantined.push(judgment)
        continue
      }
      // auto_apply
      if (dryRun || !applyFreeform) {
        actions.push({ type: 'freeform_promote', judgment, applied: false })
        continue
      }
      const result = applyFreeformPromote(root, judgment)
      if (!result.ok) {
        rejected.push({ ...judgment, apply_error: result.error })
        continue
      }
      consumeFreeformBudget()
      remaining -= 1
      freeformApplied += 1
      const health = postApplyHealth(root)
      writeOracleReceipt(judgment.reason, { kind: 'freeform_promote', path: result.path })
      actions.push({ type: 'freeform_promote', judgment, applied: true, result, health })
      if (!health.ok) break
    }
  } catch {
    // staged roots optional
  }

  // 5) FRESH-2 aged stamps → pending noop proposals (advisory only: the
  // oracle flags, a human re-observes; nothing here ever auto-applies)
  try {
    const today = new Date().toISOString().slice(0, 10)
    const findings = []
    for (const note of buildManifest(root, false)) {
      if (!['verified', 'accepted'].includes(note.status)) continue
      if (!note.path.endsWith('.md')) continue
      let lines
      try {
        lines = fs.readFileSync(path.join(root, note.path), 'utf8').split('\n')
      } catch {
        rejected.push({ class: 'fresh_stamp', decision: 'reject', path: note.path, reason: 'oracle:fresh-stamp-v1 unreadable note, skipped' })
        continue
      }
      lines.forEach((text, index) => {
        for (const match of text.matchAll(/\(as of (\d{4}-\d{2}-\d{2})\)/g)) {
          // Skip doc examples inside code spans (odd backtick count before match).
          const before = text.slice(0, match.index)
          if ((before.match(/`/g) || []).length % 2 === 1) continue
          const judgment = judgeFreshStamp(root, { notePath: note.path, line: index + 1, stamp: match[1], today })
          if (judgment.decision === 'review') findings.push(judgment)
        }
      })
    }
    findings.sort((a, b) => a.stamp.localeCompare(b.stamp))
    for (const judgment of findings.slice(0, 3)) {
      if (actions.length >= maxActions) break
      let seeded = false
      try {
        seeded = seedProposals ? seedFreshProposal(judgment) : false
      } catch {
        rejected.push({ class: 'fresh_stamp', decision: 'reject', path: judgment.path, reason: 'oracle:fresh-stamp-v1 seed failed, skipped' })
        continue
      }
      actions.push({ type: 'fresh_review', judgment, applied: false, seeded })
    }
  } catch {
    // manifest unreadable: skip advisory scan, never fail the run
  }

  // 6) Hygiene pulse
  let pulse = null
  if (writePulse) {
    pulse = runLivingLoopPulse(root, {
      seedProposals: seedProposals && actions.some((a) => a.type === 'structural_link' && !a.applied),
      runEvals: false,
      writeInbox: true,
      writePulseFile: true,
      maxProposals: 3,
    })
  }

  const postValidate = validateVault(root, { strict: true })
  const report = {
    version: 2,
    kind: 'sidekick-run',
    started,
    finished: new Date().toISOString(),
    dry_run: dryRun || !applyAny,
    apply_structural: applyStructural,
    apply_freeform: applyFreeform,
    ok: postValidate.ok,
    autonomy: autonomyModel(),
    freeform_budget: freeformDailyBudget(),
    counts: {
      actions: actions.length,
      applied: actions.filter((item) => item.applied).length,
      noop: noops.length,
      rejected: rejected.length,
      quarantined: quarantined.length,
      freeform_applied: freeformApplied,
    },
    actions,
    rejected: rejected.slice(0, 25),
    quarantined: quarantined.slice(0, 20),
    validation: { ok: postValidate.ok, notes: postValidate.notes, errors: postValidate.errors?.length || 0 },
    pulse: pulse ? {
      hygiene_ready: pulse.checklist?.hygiene_ready,
      pending_reviews: pulse.living_loop?.pending_reviews,
      generated_at: pulse.generated_at,
    } : null,
    next: buildSidekickNext(actions, quarantined, postValidate.ok, applyFreeform),
  }

  try {
    const dir = path.join(stateDir(), 'sidekick')
    ensureDir(dir)
    const id = sha256(`${started}:${report.counts.applied}:${report.counts.actions}`).slice(0, 12)
    atomicJson(path.join(dir, `run-${started.slice(0, 10)}-${id}.json`), report)
  } catch {
    // ignore
  }

  return report
}

function autonomyModel() {
  return {
    model: 'oracle-gated-sidekick-v2',
    human_required_for: ['secret_exceptions', 'remote_push', 'unbounded_freeform'],
    auto_classes: [
      'structural_link',
      'stale_successor',
      'index_entry',
      'freeform_promote_budgeted',
      'fresh_review_pending',
      'oracle_receipt',
      'hygiene_pulse',
    ],
  }
}

// Seed a pending (receipt-less) noop proposal for a FRESH finding. Same
// content hashes to the same file, so reruns dedupe naturally and reviewed
// proposals are never resurrected. Returns true only when newly written.
function seedFreshProposal(judgment) {
  ensureDir(path.join(stateDir(), 'proposals'))
  const proposal = {
    version: 1,
    action: 'noop',
    target: '',
    source_refs: [`${judgment.path}:${judgment.line}`, 'ref/knowledge-lifecycle-policy.md'],
    trust: 'trusted-local',
    // Stable across days (no age): same stamp rehashes to the same file.
    rationale: `oracle:fresh-stamp-v1 ${judgment.path}:${judgment.line} stamp ${judgment.stamp} — re-observe, convert to pointer, or retire`,
    preimage_sha256: '',
    patch: '',
  }
  const proposalSha256 = crypto.createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  const proposalFile = path.join(stateDir(), 'proposals', `${proposalSha256}.json`)
  if (fs.existsSync(proposalFile)) return false
  atomicJson(proposalFile, { ...proposal, mode: 'shadow', proposal_sha256: proposalSha256 })
  return true
}

function writeOracleReceipt(reason, meta) {
  const dir = path.join(stateDir(), 'reviews')
  ensureDir(path.join(stateDir(), 'proposals'))
  ensureDir(dir)
  const proposal = {
    version: 1,
    action: 'noop',
    target: 'kb/_index.md',
    source_refs: [meta.source || meta.path || 'sidekick', meta.target || meta.kind || 'structural', '_meta/lib/promotion-judge.mjs'].filter(Boolean),
    trust: 'trusted-local',
    rationale: reason.slice(0, 500),
    preimage_sha256: '',
    patch: '',
  }
  const proposalSha256 = crypto.createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  const proposalFile = path.join(stateDir(), 'proposals', `${proposalSha256}.json`)
  if (!fs.existsSync(proposalFile)) {
    atomicJson(proposalFile, { ...proposal, mode: 'shadow', proposal_sha256: proposalSha256 })
  }
  const payload = {
    version: 1,
    proposal_sha256: proposalSha256,
    decision: 'accept',
    reason: reason.slice(0, 500),
    reviewed_at: new Date().toISOString(),
  }
  const receiptSha = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const receiptFile = path.join(dir, `${proposalSha256}.json`)
  if (!fs.existsSync(receiptFile)) {
    atomicJson(receiptFile, { ...payload, receipt_sha256: receiptSha })
  }
}

function buildSidekickNext(actions, quarantined, validationOk, applyFreeform) {
  const next = []
  if (!validationOk) next.push('Validation red after run — inspect errors before next apply')
  const applied = actions.filter((item) => item.applied).length
  if (applied) next.push(`Applied ${applied} action(s); retrieval/graph will refresh on next query`)
  if (quarantined.length) {
    next.push(`${quarantined.length} inbox candidate(s) partial-ready (missing oracle) — leave staged`)
  }
  if (!applyFreeform) {
    next.push('Freeform promote available: sidekick run --apply-freeform (or --apply-all), budget ≤3/day')
  }
  next.push('Writer: GitHub Actions alambic-sidekick-daily; laptop sidekick stays dry-run')
  return next
}
