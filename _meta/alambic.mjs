#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// Cold-path speed: attention/sidekick/loop-pulse modules load only on the
// commands that need them. Read commands (query/context/route/read/health)
// pay only for vault + graph modules.
// (Dynamic imports live in the `attention`, `session --attention`,
// `sidekick`, and `status|loop` branches below.)
import {
  AGENT_PROMPT,
  buildManifest,
  checkObsidianBootstrap,
  checkSources,
  contextPack,
  lintVault,
  listStagedMarkdown,
  queryVault,
  retrievalHealth,
  routeVaultKnowledge,
  scanUnsafe,
  validateVault,
} from './lib/vault.mjs'
import { buildGraph } from './lib/graph-builder.mjs'
import { checkGraphLint } from './lib/graph-linter.mjs'

const ROOT = process.env.ALAMBIC_ROOT ? path.resolve(process.env.ALAMBIC_ROOT) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const command = args.shift() || 'help'
const RETRIEVAL_COMMANDS = new Set(['query', 'context', 'read', 'health', 'routing-catalog', 'route', 'session'])
const PROPOSAL_FIELDS = ['version', 'action', 'target', 'source_refs', 'trust', 'rationale', 'preimage_sha256', 'patch']

function has(flag) { const i = args.indexOf(flag); if (i >= 0) { args.splice(i, 1); return true } return false }
function option(flag, fallback) { const i = args.indexOf(flag); if (i < 0) return fallback; const value = args[i + 1]; args.splice(i, 2); return value }
function output(value, json = false) { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`) }
function stateDir() { return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'alambic') }
function ensureState() {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  for (const sub of ['candidates', 'proposals', 'reviews', 'feedback']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 })
  for (const cursor of ['seen', 'proposed', 'applied']) {
    const file = path.join(dir, `${cursor}.json`)
    if (!fs.existsSync(file)) atomicJson(file, { version: 1, cursor: null, updated_at: null })
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  for (const sub of ['candidates', 'proposals']) {
    for (const entry of fs.readdirSync(path.join(dir, sub))) {
      const file = path.join(dir, sub, entry)
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file)
    }
  }
  return dir
}
function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, file)
}

function atomicJsonExclusive(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(temporary, 0o400)
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

// Fallback walk (no git checkout): skip VCS, deps, editor state, private
// leak markers, plans, and regenerated runtime artifacts.
const INBOX_SKELETON = new Set(['README.md', '.gitkeep'])
const INIT_SKIP = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.pi', '.workflow', '.leak-patterns', 'PLAN.md', '.cache', 'loop-pulse.latest.json', 'derived-graph.json', '.DS_Store'])

function scaffoldFiles(from) {
  // Publishable set = tracked + untracked-not-ignored (same set leak-scan audits).
  const git = spawnSync('git', ['-C', from, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8' })
  const listed = git.status === 0 ? git.stdout.split('\0').filter((rel) => rel && !rel.startsWith('node_modules/') && fs.existsSync(path.join(from, rel))) : []
  // An engine nested under a parent repo's ignored path lists nothing: walk instead.
  if (listed.includes('_meta/alambic.mjs')) return listed
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(from, dir), { withFileTypes: true })) {
      if (INIT_SKIP.has(entry.name)) continue
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      // Inbox staging is personal capture; ship only its skeleton.
      else if (entry.isFile() && (!rel.startsWith(`docs${path.sep}inbox${path.sep}`) || INBOX_SKELETON.has(entry.name))) out.push(rel)
    }
  }
  walk('')
  return out
}

function initVault(dest, { force = false } = {}) {
  let target = path.resolve(dest)
  if (fs.existsSync(target)) {
    const names = fs.readdirSync(target).filter((name) => name !== '.git' && name !== '.DS_Store')
    if (names.length && !force) throw new Error(`init refuses non-empty directory ${target} (pass --force to overwrite missing files only)`)
  } else fs.mkdirSync(target, { recursive: true })
  // Physical path, like _meta/alambic (pwd -P): setup reruns from the vault must see the same root.
  target = fs.realpathSync(target)
  for (const rel of scaffoldFiles(ROOT)) {
    const dest = path.join(target, rel)
    if (fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(ROOT, rel), dest)
  }
  // npm pack (npx github:...) always drops .gitignore; restore it from the template.
  const gitignore = path.join(target, '.gitignore')
  if (!fs.existsSync(gitignore)) fs.copyFileSync(path.join(ROOT, '_meta/templates/gitignore'), gitignore)
  return target
}

// One-shot install for `npx github:<owner>/alambic init <dir> --install`: the
// npx copy is throwaway, so every step runs against the new vault.
function installVault(target, setupArgs) {
  const cli = path.join(target, '_meta/alambic.mjs')
  const steps = [
    ['npm', ['ci', '--no-audit', '--no-fund']],
    ['bash', [path.join(target, '_meta/bootstrap-obsidian.sh')]],
    [process.execPath, [cli, 'setup', '--yes', ...setupArgs]],
    [process.execPath, [cli, 'doctor']],
  ]
  for (const [bin, argv] of steps) {
    const label = bin === process.execPath ? `alambic ${argv.slice(1).join(' ')}` : `${bin} ${argv.map((arg) => path.basename(arg)).join(' ')}`
    output(`\n==> ${label}`)
    const run = spawnSync(bin, argv, { cwd: target, stdio: 'inherit', env: { ...process.env, ALAMBIC_ROOT: target } })
    if (run.status !== 0) {
      process.stderr.write(`alambic init: '${label}' failed; fix it, then rerun from ${target}\n`)
      return run.status || 1
    }
  }
  output(`\nalambic init: vault ready at ${target}`)
  return 0
}

function validateProposal(proposal) {
  const unknown = Object.keys(proposal).filter((key) => !PROPOSAL_FIELDS.includes(key))
  if (unknown.length) throw new Error(`proposal has unknown fields: ${unknown.join(', ')}`)
  for (const field of PROPOSAL_FIELDS) if (!Object.hasOwn(proposal, field)) throw new Error(`proposal is missing '${field}'`)
  if (proposal.version !== 1) throw new Error('proposal version must be 1')
  if (!['create', 'update', 'noop'].includes(proposal.action)) throw new Error('proposal action must be create, update, or noop')
  if (!Array.isArray(proposal.source_refs) || !proposal.source_refs.length || proposal.source_refs.some((value) => typeof value !== 'string' || !value)) throw new Error('proposal source_refs must be a non-empty string list')
  if (!['trusted-local', 'untrusted-session-data', 'untrusted-public'].includes(proposal.trust)) throw new Error('proposal trust is invalid')
  if (typeof proposal.rationale !== 'string' || !proposal.rationale.trim()) throw new Error('proposal rationale is required')
  if (proposal.action !== 'noop' && !/^(kb\/[a-z0-9][a-z0-9-]*\.md|kb\/_index\.md|ref\/current-work\.md)$/.test(proposal.target)) throw new Error('proposal target is outside the write allowlist')
  if (proposal.action === 'update' && !/^[a-f0-9]{64}$/.test(proposal.preimage_sha256)) throw new Error('update proposal requires a SHA-256 preimage')
  if (proposal.action === 'create' && proposal.preimage_sha256 !== '') throw new Error('create proposal preimage must be empty')
  if (typeof proposal.patch !== 'string') throw new Error('proposal patch must be a string')
}

function inspectShadowProposal(file) {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (stored.mode !== 'shadow' || !/^[a-f0-9]{64}$/.test(stored.proposal_sha256 || '')) throw new Error('review requires a stored shadow proposal')
  const proposal = { ...stored }
  delete proposal.mode
  delete proposal.proposal_sha256
  validateProposal(proposal)
  const proposalSha256 = sha256(JSON.stringify(proposal))
  if (proposalSha256 !== stored.proposal_sha256) throw new Error('proposal hash mismatch; stored shadow proposal was altered')
  const unsafe = scanUnsafe(JSON.stringify(proposal))
  if (unsafe.length) throw new Error(`proposal rejected by security scan: ${unsafe.join(', ')}`)

  let precondition = { ok: true, state: 'noop' }
  if (proposal.action === 'create') {
    const exists = fs.existsSync(path.join(ROOT, proposal.target))
    precondition = { ok: !exists, state: exists ? 'target-exists' : 'target-absent' }
  } else if (proposal.action === 'update') {
    const target = path.join(ROOT, proposal.target)
    if (!fs.existsSync(target)) precondition = { ok: false, state: 'target-missing' }
    else {
      const currentSha256 = sha256(fs.readFileSync(target))
      precondition = { ok: currentSha256 === proposal.preimage_sha256, state: currentSha256 === proposal.preimage_sha256 ? 'preimage-matches' : 'preimage-conflict', current_sha256: currentSha256 }
    }
  }

  return {
    proposal_sha256: proposalSha256,
    action: proposal.action,
    target: proposal.target,
    trust: proposal.trust,
    rationale: proposal.rationale,
    source_refs: proposal.source_refs,
    patch: { bytes: Buffer.byteLength(proposal.patch), lines: proposal.patch ? proposal.patch.split(/\r?\n/).length : 0 },
    precondition,
    apply_enabled: false,
  }
}

function validateReceipt(receipt, expectedProposalSha256) {
  const fields = ['version', 'proposal_sha256', 'decision', 'reason', 'reviewed_at']
  const unknown = Object.keys(receipt).filter((key) => ![...fields, 'receipt_sha256'].includes(key))
  if (unknown.length || fields.some((field) => !Object.hasOwn(receipt, field)) || !Object.hasOwn(receipt, 'receipt_sha256')) throw new Error('review receipt has an invalid shape')
  if (receipt.version !== 1 || !['accept', 'reject'].includes(receipt.decision) || receipt.proposal_sha256 !== expectedProposalSha256) throw new Error('review receipt does not match the proposal')
  const payload = Object.fromEntries(fields.map((field) => [field, receipt[field]]))
  if (sha256(JSON.stringify(payload)) !== receipt.receipt_sha256) throw new Error('review receipt hash mismatch; receipt was altered')
  return receipt
}

try {
  if (RETRIEVAL_COMMANDS.has(command) && !(command === 'session' && args.includes('--attention'))) {
    const { runRetrievalCommand } = await import('./lib/retrieval-cli.mjs')
    await runRetrievalCommand({ root: ROOT, command, args })
  } else if (command === 'setup') {
    const { runSetup } = await import('./lib/setup.mjs')
    process.exitCode = await runSetup({ vault: ROOT, args })
  } else if (command === 'init') {
    const force = has('--force')
    const install = has('--install')
    const dest = args.shift()
    if (!dest || (args.length && !install)) throw new Error('usage: alambic init <dir> [--force] [--install [setup options]]')
    const target = initVault(dest, { force })
    if (install) process.exitCode = installVault(target, args)
    else output(`alambic init: ${target}\nnext: cd ${target} && npm ci && _meta/bootstrap-obsidian.sh && _meta/alambic doctor`)
  } else if (command === 'attention') {
    const { runAttentionCommand } = await import('./lib/attention/index.mjs')
    await runAttentionCommand({ root: ROOT, args, output })
  } else if (command === 'validate') {
    const json = has('--json')
    const mode = option('--mode', 'strict')
    const report = validateVault(ROOT, { strict: mode === 'strict' })
    if (report.ok) {
      try {
        buildGraph(ROOT, { force: true, writeCache: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`alambic validate: graph rebuild warning: ${message}\n`)
        if (json) report.graph_rebuild_error = message
      }
    }
    if (json) output(report, true)
    else if (report.ok) output(`alambic validate: ok (${report.mode}, ${report.notes} notes)`)
    else for (const error of report.errors) process.stderr.write(`${error.file}: ${error.field}: ${error.message}; ${error.remediation}\n`)
    if (!report.ok) process.exitCode = 1
  } else if (command === 'graph') {
    const json = has('--json')
    const force = has('--force')
    const graphData = buildGraph(ROOT, { force })
    if (json) output(graphData, true)
    else output(`alambic graph: ok (${graphData.stats.total_nodes} nodes, ${graphData.stats.total_edges} edges, ${graphData.stats.total_claims} claims)`)
  } else if (command === 'graph-lint') {
    const json = has('--json')
    const report = checkGraphLint(ROOT)
    if (json) output(report, true)
    else {
      output([
        `alambic graph-lint: gaps=${report.co_occurrence_gaps.length} claim_conflicts=${report.claim_contradictions.length} stale_deps=${report.stale_invalidations.length} graph_orphans=${report.graph_orphans.length}`,
        ...report.co_occurrence_gaps.slice(0, 5).map((gap) => `gap\t${gap.source}\t${gap.target}\t${gap.shared_tags.join(',')}`),
        ...report.stale_invalidations.slice(0, 5).map((item) => `stale\t${item.verified_note}\t${item.stale_dependency}`),
      ].join('\n'))
    }
  } else if (command === 'manifest') {
    const json = has('--json')
    const includeDocs = has('--include-docs')
    const check = has('--check')
    const manifest = buildManifest(ROOT, includeDocs).map(({ raw, text, ...item }) => item)
    output(json ? manifest : manifest.map((x) => `${x.path}\t${x.status}\t${x.sha256}`).join('\n'), json)
    if (check && manifest.some((item) => !item.path || !item.sha256)) process.exitCode = 1
  } else if (command === 'sources') {
    const json = has('--json')
    has('--check')
    // --resolve-local: fail if sibling-repo paths are not on disk (strict machine check).
    // Default (CI / multi-machine): sibling + docs/inbox staging refs are portable.
    const requireLocalSiblings = has('--resolve-local')
    const report = checkSources(ROOT, { requireLocalSiblings })
    output(json ? report : report.ok ? `alambic sources: ok (${report.total})` : report.unresolved.map((x) => `${x.note}: unresolved source ${x.source}`).join('\n'), json)
    if (!report.ok) process.exitCode = 1
  } else if (command === 'lint') {
    const json = has('--json')
    const check = has('--check')
    if (args.length) throw new Error('usage: alambic lint [--json] [--check]')
    const report = lintVault(ROOT)
    if (json) output(report, true)
    else output([
      `alambic lint: ${report.ok ? 'ok' : 'review required'}`,
      `structural errors: ${report.summary.structural_errors}`,
      `invalid claims: ${report.summary.invalid_claims}`,
      `semantic conflicts: ${report.summary.semantic_conflicts}`,
      `orphans: ${report.summary.orphans}`,
      `review due: ${report.summary.review_due}`,
      `stale or superseded: ${report.summary.stale_or_superseded}`,
      `graph co-occurrence gaps: ${report.summary.graph_co_occurrence_gaps || 0}`,
      `graph stale invalidations: ${report.summary.graph_stale_invalidations || 0}`,
    ].join('\n'))
    if (check && !report.ok) process.exitCode = 1
  } else if (command === 'doctor') {
    const json = has('--json')
    const validation = validateVault(ROOT, { strict: true })
    const sources = checkSources(ROOT)
    const obsidian = checkObsidianBootstrap(ROOT)
    const { doctorSetup } = await import('./lib/setup.mjs')
    const setup = doctorSetup(ROOT)
    const report = {
      ok: validation.ok && sources.ok && obsidian.ok,
      root: ROOT,
      state: stateDir(),
      validation,
      sources,
      obsidian,
      setup,
    }
    if (json) output(report, true)
    else {
      const lines = [
        `alambic doctor: ${report.ok ? 'ok' : 'failed'}`,
        `root: ${ROOT}`,
        `state: ${report.state}`,
        `validation errors: ${validation.errors.length}`,
        `unresolved sources: ${sources.unresolved.length}`,
        `obsidian: ${obsidian.installed ? (obsidian.ok ? 'ok' : 'misconfigured') : 'not installed'}`,
      ]
      if (obsidian.issues.length) lines.push(...obsidian.issues.map((issue) => `  - ${issue}`))
      lines.push(`setup: ${setup.installed ? (setup.warnings.length ? 'warnings' : 'ok') : 'not installed (run _meta/alambic setup)'}`)
      lines.push(...setup.warnings.map((warning) => `  - warning: ${warning}`))
      output(lines.join('\n'))
    }
    if (!report.ok) process.exitCode = 1
  } else if (command === 'state') {
    if ((args.shift() || 'init') !== 'init') throw new Error('usage: alambic state init')
    output(`alambic state: ${ensureState()}`)
  } else if (command === 'capture') {
    const input = option('--input', '')
    const surface = option('--surface', 'unknown')
    const dryRun = has('--dry-run')
    if (!input) throw new Error('usage: alambic capture --input FILE --surface codex|claude|pi|opencode|cursor|zcode [--dry-run]')
    if (!['codex', 'claude', 'pi', 'mcp', 'opencode', 'cursor', 'zcode'].includes(surface)) throw new Error('surface must be codex, claude, pi, mcp, opencode, cursor, or zcode')
    const text = fs.readFileSync(input, 'utf8')
    const unsafe = scanUnsafe(text)
    if (unsafe.length) throw new Error(`capture rejected unsafe content: ${unsafe.join(', ')}`)
    const digest = sha256(text)
    const candidate = { version: 1, surface, source_id: path.basename(input), sha256: digest, observed_at: new Date().toISOString(), trust: 'untrusted-session-data', content: text.slice(0, 12000), truncated: text.length > 12000 }
    if (dryRun) output(candidate, true)
    else { const dir = ensureState(); const target = path.join(dir, 'candidates', `${digest}.json`); atomicJson(target, candidate); output(`shadow candidate: ${target}`) }
  } else if (command === 'distill') {
    const proposalFile = option('--proposal', '')
    if (!proposalFile) throw new Error('usage: alambic distill --proposal FILE [--shadow]')
    if (has('--apply')) throw new Error('apply is disabled until the 7-day shadow gate is satisfied')
    has('--shadow')
    const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'))
    validateProposal(proposal)
    if (scanUnsafe(JSON.stringify(proposal)).length) throw new Error('proposal rejected by security scan')
    const digest = sha256(JSON.stringify(proposal))
    const dir = ensureState(); const target = path.join(dir, 'proposals', `${digest}.json`)
    atomicJson(target, { ...proposal, mode: 'shadow', proposal_sha256: digest })
    output(`shadow proposal: ${target}`)
  } else if (command === 'review') {
    const json = has('--json')
    const proposalFile = option('--proposal', '')
    const decision = option('--decision', '')
    const reason = option('--reason', '')
    if (has('--apply')) throw new Error('review never applies proposals')
    if (args.length || !proposalFile) throw new Error('usage: alambic review --proposal FILE [--decision accept|reject --reason TEXT] [--json]')
    if ((decision && !reason) || (!decision && reason) || (decision && !['accept', 'reject'].includes(decision))) throw new Error('review decision requires accept|reject and a non-empty reason')
    if (reason.length > 500 || (reason && scanUnsafe(reason).length)) throw new Error('review reason is unsafe or exceeds 500 characters')
    const inspection = inspectShadowProposal(proposalFile)
    if (decision === 'accept' && !inspection.precondition.ok) throw new Error(`proposal cannot be accepted: ${inspection.precondition.state}`)
    const dir = ensureState()
    const receiptFile = path.join(dir, 'reviews', `${inspection.proposal_sha256}.json`)
    let receipt = null
    let idempotent = false
    if (fs.existsSync(receiptFile)) {
      receipt = validateReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), inspection.proposal_sha256)
      if (decision && (receipt.decision !== decision || receipt.reason !== reason)) throw new Error('review receipt is immutable; a different decision already exists')
      idempotent = Boolean(decision)
    } else if (decision) {
      const payload = { version: 1, proposal_sha256: inspection.proposal_sha256, decision, reason, reviewed_at: new Date().toISOString() }
      receipt = { ...payload, receipt_sha256: sha256(JSON.stringify(payload)) }
      try {
        atomicJsonExclusive(receiptFile, receipt)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = validateReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), inspection.proposal_sha256)
        if (existing.decision !== decision || existing.reason !== reason) throw new Error('review receipt is immutable; a different decision already exists')
        receipt = existing
        idempotent = true
      }
    }
    const report = { ...inspection, receipt, idempotent }
    if (json) output(report, true)
    else output(`proposal: ${report.proposal_sha256}\naction: ${report.action}\ntarget: ${report.target || '(none)'}\nprecondition: ${report.precondition.state}\ndecision: ${receipt?.decision || 'pending'}\napply: disabled`)
  } else if (command === 'feedback') {
    const status = option('--status', '')
    if (!['hit', 'miss', 'stale', 'wrong'].includes(status)) throw new Error('usage: alambic feedback --status hit|miss|stale|wrong')
    if (args.length) throw new Error('feedback accepts no question or answer content')
    const dir = ensureState()
    const file = path.join(dir, 'feedback', 'counts.json')
    const counts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, hit: 0, miss: 0, stale: 0, wrong: 0 }
    counts[status] += 1
    counts.updated_at = new Date().toISOString()
    atomicJson(file, counts)
    output(`feedback: ${status}`)
  } else if (command === 'sidekick') {
    const { runSidekick } = await import('./lib/sidekick.mjs')
    const json = has('--json')
    const sub = args.shift() || 'run'
    if (sub !== 'run') throw new Error('usage: alambic sidekick run [--dry-run|--apply-structural|--apply-freeform|--apply-all] [--max N] [--max-freeform N] [--json]')
    const applyAll = has('--apply-all')
    const applyStructural = applyAll || has('--apply-structural')
    const applyFreeform = applyAll || has('--apply-freeform')
    const dryRun = has('--dry-run') || (!applyStructural && !applyFreeform)
    const maxActions = Number(option('--max', 8))
    const maxFreeform = Number(option('--max-freeform', 3))
    const report = await runSidekick(ROOT, {
      dryRun,
      applyStructural,
      applyFreeform,
      maxActions: Number.isFinite(maxActions) ? maxActions : 8,
      maxFreeform: Number.isFinite(maxFreeform) ? maxFreeform : 3,
      seedProposals: true,
      writePulse: true,
    })
    if (json) output(report, true)
    else {
      const mode = report.dry_run
        ? 'dry-run'
        : [report.apply_structural && 'structural', report.apply_freeform && 'freeform'].filter(Boolean).join('+')
      output([
        `alambic sidekick (${mode || 'dry-run'})`,
        `ok: ${report.ok}  actions: ${report.counts?.actions || 0}  applied: ${report.counts?.applied || 0}  freeform: ${report.counts?.freeform_applied || 0}`,
        `rejected: ${report.counts?.rejected || 0}  quarantined: ${report.counts?.quarantined || 0}`,
        `budget freeform: ${report.freeform_budget?.count || 0}/${report.freeform_budget?.max || 3} today`,
        `autonomy: ${report.autonomy?.model}`,
        ...(report.actions || []).slice(0, 12).map((item) => `- ${item.type} applied=${Boolean(item.applied)} ${item.judgment?.reason || item.judgment?.path || ''}`),
        'next:',
        ...(report.next || []).map((line) => `- ${line}`),
      ].join('\n'))
    }
    if (!report.ok) process.exitCode = 1
  } else if (command === 'status' || command === 'loop') {
    const { loadLatestPulse, pulseFreshness, runLivingLoopPulse } = await import('./lib/loop-pulse.mjs')
    const json = has('--json')
    // CI / automated hygiene pulse (never fabricates human reviews or human feedback).
    const ci = has('--ci')
    const pulseFlag = has('--pulse') || ci
    const seedProposals = has('--seed-proposals') || ci
    // Evals are optional here: CI jobs usually already ran `npm test`.
    const runEvals = has('--with-evals')
    const writeInbox = has('--write-inbox') || ci

    if (pulseFlag && command === 'loop') {
      const pulse = runLivingLoopPulse(ROOT, {
        seedProposals,
        runEvals,
        writeInbox,
        writePulseFile: true,
      })
      const report = {
        command: 'loop',
        mode: ci ? 'ci' : 'pulse',
        root: ROOT,
        state: stateDir(),
        ...pulse,
      }
      if (json) output(report, true)
      else {
        const lines = [
          `alambic loop (${report.mode})`,
          `validation: ${pulse.validation.ok ? 'ok' : 'FAILED'}`,
          `lint: ${pulse.lint.ok ? 'ok' : 'review'} gaps=${pulse.lint.graph_co_occurrence_gaps} stale_deps=${pulse.lint.graph_stale_invalidations}`,
          `graph: ${pulse.graph?.stats ? `${pulse.graph.stats.total_nodes}n/${pulse.graph.stats.total_edges}e` : pulse.graph?.error || 'n/a'}`,
          `seeded proposals: ${pulse.seeded_proposals?.created?.length || 0} (skipped ${pulse.seeded_proposals?.skipped?.length || 0})`,
          `human reviews: ${pulse.living_loop.reviews}/20  feedback: ${pulse.living_loop.human_feedback_total}/10  pending: ${pulse.living_loop.pending_reviews}`,
          `eval feedback (separate): ${pulse.living_loop.eval_feedback_total}  eval_green: ${pulse.checklist.eval_green}`,
          `hygiene_ready: ${pulse.checklist.hygiene_ready}  supervision_ready: ${pulse.checklist.supervision_ready}`,
          `apply: Class A ${pulse.checklist.class_a} / Class B ${pulse.checklist.class_b}`,
          'next:',
          ...pulse.next_actions.map((action) => `- ${action}`),
        ]
        output(lines.join('\n'))
      }
      if (!pulse.checklist.hygiene_ready) process.exitCode = 1
    } else {
      const dir = ensureState()
      const proposalDir = path.join(dir, 'proposals')
      const reviewDir = path.join(dir, 'reviews')
      const feedbackFile = path.join(dir, 'feedback', 'counts.json')
      const evalFeedbackFile = path.join(dir, 'feedback', 'eval-counts.json')
      const proposals = fs.existsSync(proposalDir) ? fs.readdirSync(proposalDir).filter((name) => name.endsWith('.json')) : []
      const reviews = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir).filter((name) => name.endsWith('.json')) : []
      const pending = proposals.filter((name) => !fs.existsSync(path.join(reviewDir, name)))
      const feedback = fs.existsSync(feedbackFile)
        ? JSON.parse(fs.readFileSync(feedbackFile, 'utf8'))
        : { version: 1, hit: 0, miss: 0, stale: 0, wrong: 0 }
      const evalFeedback = fs.existsSync(evalFeedbackFile)
        ? JSON.parse(fs.readFileSync(evalFeedbackFile, 'utf8'))
        : { version: 1, hit: 0, miss: 0, stale: 0, wrong: 0 }
      const feedbackTotal = (feedback.hit || 0) + (feedback.miss || 0) + (feedback.stale || 0) + (feedback.wrong || 0)
      const evalFeedbackTotal = (evalFeedback.hit || 0) + (evalFeedback.miss || 0) + (evalFeedback.stale || 0) + (evalFeedback.wrong || 0)
      const validation = validateVault(ROOT, { strict: true })
      const health = retrievalHealth(ROOT)
      let applyUnlock = false
      const currentWork = path.join(ROOT, 'ref/current-work.md')
      if (fs.existsSync(currentWork)) {
        applyUnlock = /apply-auto unlock:\s*\*\*YES\*\*/i.test(fs.readFileSync(currentWork, 'utf8'))
      }
      const staged = listStagedMarkdown(ROOT)
      const latest = loadLatestPulse(ROOT)
      const freshness = latest?.pulse ? pulseFreshness(latest.pulse) : { fresh: false, age_ms: null }
      const report = {
        command,
        root: ROOT,
        state: dir,
        validation: { ok: validation.ok, notes: validation.notes, errors: validation.errors?.length || 0 },
        retrieval: { backend: health.backend, retrieval_mode: health.retrieval_mode, files: health.snapshot?.files },
        living_loop: {
          proposals: proposals.length,
          reviews: reviews.length,
          pending_reviews: pending.length,
          pending_paths: pending.slice(0, 20).map((name) => path.join(proposalDir, name)),
          feedback_total: feedbackTotal,
          feedback,
          eval_feedback_total: evalFeedbackTotal,
          eval_feedback: evalFeedback,
          apply_unlock: applyUnlock,
          apply_mode: 'class-a-ci-class-b-off',
          apply_class_a: 'ci-writer',
          apply_class_b: applyUnlock ? 'unlocked' : 'disabled',
          last_pulse: latest ? { source: latest.source, generated_at: latest.pulse.generated_at, hygiene_ready: latest.pulse.checklist?.hygiene_ready ?? null, fresh: freshness.fresh } : null,
        },
        inbox_staged: staged.length,
        next_actions: [
          pending.length ? `Review ${pending.length} shadow proposal(s) with: _meta/alambic review --proposal FILE --decision accept|reject --reason "…"` : 'No pending shadow proposals — run: _meta/alambic loop --ci',
          'Before non-trivial work: _meta/alambic context --max-tokens 2500 "<question>"',
          'After retrieval outcomes: _meta/alambic feedback --status hit|miss|stale|wrong',
          'Automated hygiene: _meta/alambic loop --ci  (or the GitHub Actions ci workflow)',
          applyUnlock ? 'Class B unlock is YES — still prefer review receipts before any distill --apply experiment' : 'Class A/A2: GitHub Actions writer; Class B distill --apply remains DISABLED (shadow-apply-gate)',
        ],
      }
      if (command === 'loop') {
        const lint = lintVault(ROOT)
        report.lint = {
          ok: lint.ok,
          orphans: lint.summary?.orphans,
          review_due: lint.summary?.review_due,
          stale_or_superseded: lint.summary?.stale_or_superseded,
          semantic_conflicts: lint.summary?.semantic_conflicts,
        }
        report.checklist = {
          validation_green: validation.ok,
          lint_structural_green: Boolean(lint.ok),
          reviews_ge_20: reviews.length >= 20,
          feedback_ge_10: feedbackTotal >= 10,
          human_feedback_ge_10: feedbackTotal >= 10,
          pending_reviews_zero: pending.length === 0,
          class_a: 'ci-writer',
          class_b: applyUnlock ? 'unlocked' : 'disabled',
          apply_still_disabled: !applyUnlock,
          pulse_fresh: Boolean(freshness.fresh),
          hygiene_ready: Boolean(validation.ok && lint.ok && freshness.fresh !== false && (latest?.pulse?.checklist?.hygiene_ready ?? true)),
          supervision_ready: reviews.length >= 20 && feedbackTotal >= 10 && pending.length === 0,
        }
      }
      if (json) output(report, true)
      else {
        const lines = [
          `alambic ${command}`,
          `root: ${report.root}`,
          `validation: ${report.validation.ok ? 'ok' : 'FAILED'} (notes=${report.validation.notes})`,
          `retrieval: ${report.retrieval.backend} / ${report.retrieval.retrieval_mode} (files=${report.retrieval.files})`,
          `reviews: ${report.living_loop.reviews}  pending: ${report.living_loop.pending_reviews}  proposals: ${report.living_loop.proposals}`,
          `human feedback: total=${report.living_loop.feedback_total} hit=${feedback.hit || 0} miss=${feedback.miss || 0} stale=${feedback.stale || 0} wrong=${feedback.wrong || 0}`,
          `eval feedback: total=${evalFeedbackTotal} (does not count toward apply gate)`,
          `last pulse: ${report.living_loop.last_pulse ? `${report.living_loop.last_pulse.generated_at} fresh=${report.living_loop.last_pulse.fresh}` : 'none — run loop --ci'}`,
          `apply: Class A CI-writer / Class B ${applyUnlock ? 'unlocked' : 'disabled'} (unlock=${applyUnlock ? 'YES' : 'NO'})`,
          `inbox staged md: ${report.inbox_staged}`,
        ]
        if (report.lint) {
          lines.push(`lint: ${report.lint.ok ? 'ok' : 'review'} orphans=${report.lint.orphans} review_due=${report.lint.review_due} conflicts=${report.lint.semantic_conflicts}`)
        }
        lines.push('next:')
        for (const action of report.next_actions) lines.push(`- ${action}`)
        output(lines.join('\n'))
      }
      if (!validation.ok) process.exitCode = 1
    }
  } else if (command === 'session' && args.includes('--attention')) {
    const json = has('--json')
    has('--attention')
    const l0 = has('--l0')
    const maxTokens = Number(option('--max-tokens', '2500'))
    const query = args.join(' ').trim()
    if (l0) throw new Error('--l0 cannot be combined with --attention')
    const { createAttentionService } = await import('./lib/attention/index.mjs')
    const { buildAttentionSessionPack } = await import('./lib/attention/compile.mjs')
    const service = createAttentionService({ root: ROOT })
    const attentionPack = buildAttentionSessionPack({
      root: ROOT,
      status: service.status(),
      maxTokens,
    })
    // Optional light route when a short question is also provided
    let route = null
    let notePaths = []
    if (query) {
      const sharedManifest = buildManifest(ROOT, false)
      route = routeVaultKnowledge(ROOT, query, { manifest: sharedManifest })
      const pack = contextPack(ROOT, query, { maxTokens: Math.min(1200, maxTokens), manifest: sharedManifest })
      notePaths = (pack.results || []).map((item) => item.path).slice(0, 5)
    }
    const report = {
      mode: 'attention',
      max_tokens: maxTokens,
      attention: attentionPack,
      route,
      note_paths: notePaths,
      estimated_tokens: attentionPack.estimated_tokens + Math.ceil(JSON.stringify(notePaths).length / 4),
      within_budget: (attentionPack.estimated_tokens + Math.ceil(JSON.stringify(notePaths).length / 4)) <= maxTokens,
      agent_entry: [
        'Read attention.synthesis_path or attention.digest_path (inbox only).',
        'Use attention promote-suggest (dry) for update-before-create hints.',
        'Do not decrypt or dump candidate ciphertext into chat.',
        'apply-auto remains DISABLED; human promotes to kb/.',
      ],
    }
    if (json) output(report, true)
    else {
      const lines = [
        'alambic session --attention',
        `tokens≈${report.estimated_tokens}/${maxTokens} within_budget=${report.within_budget}`,
        `digest: ${attentionPack.digest_path || '(missing)'}`,
        `synthesis: ${attentionPack.synthesis_path || '(missing)'}`,
        'sources:',
        ...attentionPack.sources.map((line) => `- ${line}`),
        ...(notePaths.length ? ['routed notes:', ...notePaths.map((p) => `- ${p}`)] : []),
        'entry:',
        ...report.agent_entry.map((line) => `- ${line}`),
      ]
      output(lines.join('\n'))
    }
  } else if (command === 'enrich') {
    const json = has('--json')
    const apply = has('--apply')
    const max = Number(option('--max', 25))
    if (args.length) throw new Error('usage: alambic enrich [--apply] [--max N] [--json]')
    const { enrichVault } = await import('./lib/enrich.mjs')
    const report = await enrichVault(ROOT, { apply, max: Number.isFinite(max) ? max : 25 })
    output(json ? report : `alambic enrich (${apply ? 'apply' : 'dry-run'}): judged=${report.judged}/${report.pending} tags_added=${report.tags_added} notes_changed=${report.notes_changed} provider_failures=${report.provider_failures}${report.failure_reason ? ` (${report.failure_reason})` : ''}`, json)
    if (report.validation && !report.validation.ok) process.exitCode = 1
  } else if (command === 'eval') {
    const suite = option('--suite', 'retrieval')
    const runner = new URL('./tests/eval.mjs', import.meta.url)
    process.argv = ['node', runner.pathname, suite, ROOT]
    await import(`${runner.href}?run=${Date.now()}`)
  } else if (command === 'refresh') {
    const sub = args.shift() || 'status'
    if (sub === 'status') {
      const report = validateVault(ROOT, { strict: true })
      output(`validation: ${report.ok ? 'ok' : 'failed'}\nkb/ref notes: ${report.notes}\nstate: ${stateDir()}\nwriter mode: shadow`)
      if (!report.ok) process.exitCode = 1
    } else if (sub === 'query') {
      const results = queryVault(ROOT, args.join(' '), { limit: 5 })
      output(results.map((x) => `${x.score}\t${x.path}\t${x.title}`).join('\n'))
    } else if (sub === 'staged') {
      const files = listStagedMarkdown(ROOT)
      output(files.slice(-40).join('\n') || `(empty) ${path.join(ROOT, 'docs/inbox')}`)
    } else if (sub === 'agent-prompt') {
      output(AGENT_PROMPT)
    } else throw new Error('usage: alambic refresh status|query|staged|agent-prompt')
  } else {
    output('usage: alambic init|setup|attention|validate|graph|graph-lint|manifest|routing-catalog|route|sources|lint|doctor|query|context|read|health|status|loop|sidekick|session|enrich|eval|state|capture|distill|review|feedback|refresh')
  }
} catch (error) {
  process.stderr.write(`alambic: ${error.message}\n`)
  process.exitCode = 2
}
