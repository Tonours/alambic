import crypto from 'node:crypto'
import fs from 'node:fs'
import { alambicStateDir } from './state-dir.mjs'
import path from 'node:path'
import { parseMarkdownText } from './frontmatter.mjs'
import { moveChecked, unarchive, vaultDir, writeChecked } from './write-journal.mjs'
import { buildManifest, invalidateManifest, queryVault, scanUnsafe, validateVault } from './vault.mjs'

/**
 * Ultra-generic tags that must not be the *only* shared signal for auto-linking.
 * Domain tags (retrieval, css, mcp, …) remain valid co-occurrence glue.
 */
const GENERIC_TAGS = new Set([
  'agents', 'agent', 'ai', 'automation', 'workflows', 'workflow',
  'tools', 'product', 'backend', 'frontend',
])

export const REFUSE_BODY = [
  /\bBEGIN [A-Z ]*PRIVATE KEY\b/,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /docs\/inbox\/.*transcript/i,
  /raw (chat|conversation|session) dump/i,
]

const PLACEHOLDER_SOURCE = /REPLACE|TODO|FIXME|example\.com|example\.invalid|repo\/path\/file/i
const FREEFORM_DAILY_MAX = 3
const SESSION_SOURCE = /^(claude|codex|pi):/i
export const HUMAN_REVIEWER = 'human:alambic-review'
const UPDATE_SCORE_THRESHOLD = 45
// OKM-lite FRESH-2: a dated `(as of YYYY-MM-DD)` stamp older than this window
// needs re-observe / convert-to-pointer / retire. 90d matches the fastest
// lifecycle family (security); dormant findings stay silent, never auto-edit.
const FRESH_WINDOW_DAYS = 90

/**
 * Deterministic promotion / structural-heal judge.
 * No LLM. Decisions are fully explainable from oracle results.
 *
 * Classes:
 * - structural_link: auto-apply wikilink between active notes
 * - index_entry: auto-add missing [[basename]] to kb/_index.md
 * - stale_successor: verified note links superseded target → also link successor
 * - freeform_note: auto_apply under hard oracles + daily budget (v2)
 * - reject: hard fail safety
 */
export function judgeStructuralLink(root, { sourcePath, targetPath, sharedTags = [] }) {
  const oracles = {}
  const notes = indexNotes(root)
  const source = notes.get(sourcePath)
  const target = notes.get(targetPath)

  oracles.both_exist = Boolean(source && target)
  oracles.both_active = ['verified', 'accepted'].includes(source?.status)
    && ['verified', 'accepted'].includes(target?.status)
  oracles.not_index = sourcePath !== 'kb/_index.md' && targetPath !== 'kb/_index.md'
  oracles.not_self = sourcePath !== targetPath
  oracles.shared_tags_ge_3 = sharedTags.length >= 3
  const nonGeneric = sharedTags.filter((tag) => !GENERIC_TAGS.has(String(tag).toLowerCase()))
  oracles.non_generic_tag = nonGeneric.length >= 1 || sharedTags.length >= 4
  oracles.no_existing_link = source && target
    ? !hasWikilink(readRaw(root, sourcePath), target.basename)
      && !hasWikilink(readRaw(root, targetPath), source.basename)
    : false

  const pass = Object.values(oracles).every(Boolean)
  return {
    class: 'structural_link',
    decision: pass ? 'auto_apply' : 'reject',
    oracles,
    shared_tags: sharedTags,
    non_generic_tags: nonGeneric,
    source: sourcePath,
    target: targetPath,
    reason: pass
      ? `oracle:structural-link-v1 shared_tags=[${sharedTags.join(',')}]`
      : `oracle:structural-link-v1 fail ${failedKeys(oracles).join(',')}`,
  }
}

export function judgeIndexEntry(root, notePath) {
  const oracles = {}
  const notes = indexNotes(root)
  const note = notes.get(notePath)
  const indexRaw = readRaw(root, 'kb/_index.md')
  oracles.exists = Boolean(note)
  oracles.kb_note = notePath.startsWith('kb/') && notePath.endsWith('.md') && notePath !== 'kb/_index.md'
  oracles.active = ['verified', 'accepted'].includes(note?.status)
  oracles.missing_from_index = note ? !hasWikilink(indexRaw, note.basename) : false

  const pass = Object.values(oracles).every(Boolean)
  return {
    class: 'index_entry',
    decision: pass ? 'auto_apply' : 'reject',
    oracles,
    path: notePath,
    basename: note?.basename,
    reason: pass
      ? `oracle:index-entry-v1 ${note?.basename}`
      : `oracle:index-entry-v1 fail ${failedKeys(oracles).join(',')}`,
  }
}

/**
 * FRESH-2 aged-stamp oracle (OKM-lite automation). Advisory only: `review`
 * seeds a pending noop proposal for a human; `skip` stays silent. Never
 * auto-applies — only a human re-observation can refresh a stamp.
 */
export function judgeFreshStamp(root, { notePath, line, stamp, today = new Date().toISOString().slice(0, 10) }) {
  const oracles = {}
  const stampMs = Date.parse(`${stamp}T00:00:00Z`)
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  oracles.valid_stamp = /^\d{4}-\d{2}-\d{2}$/.test(stamp) && Number.isFinite(stampMs)
  oracles.valid_today = /^\d{4}-\d{2}-\d{2}$/.test(today) && Number.isFinite(todayMs)
  const ageDays = oracles.valid_stamp && oracles.valid_today
    ? Math.floor((todayMs - stampMs) / 86400000)
    : NaN
  oracles.aged = Number.isFinite(ageDays) && ageDays > FRESH_WINDOW_DAYS
  oracles.note_exists = typeof notePath === 'string' && fs.existsSync(path.join(root, notePath))
  oracles.safe_reason = scanUnsafe(`${notePath}:${line} ${stamp}`).length === 0

  const review = Object.values(oracles).every(Boolean)
  const reason = review
    ? `oracle:fresh-stamp-v1 ${notePath}:${line} stamp ${stamp} age ${ageDays}d — re-observe, convert to pointer, or retire`
    : `oracle:fresh-stamp-v1 skip ${failedKeys(oracles).join(',')}`
  return {
    class: 'fresh_stamp',
    decision: review ? 'review' : 'skip',
    oracles,
    path: notePath,
    line,
    stamp,
    age_days: Number.isFinite(ageDays) ? ageDays : null,
    reason: reason.slice(0, 500),
  }
}

/**
 * When a verified note links a superseded note, prefer also linking the successor.
 */
export function judgeStaleSuccessor(root, { verifiedPath, stalePath }) {
  const oracles = {}
  const notes = indexNotes(root)
  const verified = notes.get(verifiedPath)
  const stale = notes.get(stalePath)
  oracles.verified_active = ['verified', 'accepted'].includes(verified?.status)
  oracles.target_superseded = stale?.status === 'superseded'
  const successor = stale ? extractSupersessionTarget(root, stalePath) : null
  oracles.has_successor = Boolean(successor)
  const successorPath = successor ? `kb/${successor}.md` : null
  const successorNote = successorPath ? notes.get(successorPath) : null
  // successor may live under ref/ rarely — check basename map
  let resolvedSuccessor = successorPath
  let resolvedBase = successor
  if (successor && !successorNote) {
    for (const note of notes.values()) {
      if (note.basename === successor || (note.aliases || []).includes(successor)) {
        resolvedSuccessor = note.path
        resolvedBase = note.basename
        break
      }
    }
  }
  oracles.successor_active = ['verified', 'accepted'].includes(notes.get(resolvedSuccessor)?.status)
  oracles.missing_successor_link = verified && resolvedBase
    ? !hasWikilink(readRaw(root, verifiedPath), resolvedBase)
    : false

  const pass = Object.values(oracles).every(Boolean)
  return {
    class: 'stale_successor',
    decision: pass ? 'auto_apply' : 'reject',
    oracles,
    source: verifiedPath,
    stale: stalePath,
    successor: resolvedBase,
    successor_path: resolvedSuccessor,
    reason: pass
      ? `oracle:stale-successor-v1 ${verifiedPath} → ${resolvedBase}`
      : `oracle:stale-successor-v1 fail ${failedKeys(oracles).join(',')}`,
  }
}

export function extractSupersessionTarget(root, supersededPath) {
  const text = readRaw(root, supersededPath)
  const declared = text.match(/^superseded_by:\s*"?([^"\n]+)"?\s*$/m)
  if (declared) return declared[1].trim()
  const patterns = [
    /\*\*Superseded\*\*\s+by\s+\[\[([^\]|#]+)/i,
    /Superseded\s+by\s+\[\[([^\]|#]+)/i,
    /superseded\s+by\s+\[\[([^\]|#]+)/i,
  ]
  for (const re of patterns) {
    const match = text.match(re)
    if (match) return match[1].trim()
  }
  return null
}

/**
 * Freeform durable note candidate from inbox.
 * v2: auto_apply when hard oracles pass (still requires sidekick --apply-freeform).
 * Prefer update when a strong lexical match exists on an active kb note.
 */
export function isSessionOrigin(data, relativePath = '') {
  return data?.origin === 'session-harvest'
    || path.basename(String(relativePath)).startsWith('harvest-')
    || data?.trust === 'untrusted-session-data'
    || (Array.isArray(data?.sources) && data.sources.some((source) => SESSION_SOURCE.test(String(source))))
}

function inboxReceiptFile(stateHome, digest) {
  return path.join(alambicStateDir(stateHome), 'reviews', `inbox-${digest}.json`)
}

export function writeInboxReceipt(stateHome, { inboxPath, text, decision, reason }) {
  const digest = sha256(text)
  const payload = { version: 1, kind: 'inbox-review', inbox_path: inboxPath, inbox_sha256: digest, decision, reason, reviewer: HUMAN_REVIEWER, reviewed_at: new Date().toISOString() }
  const receipt = { ...payload, receipt_sha256: sha256(JSON.stringify(payload)) }
  const file = inboxReceiptFile(stateHome, digest)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400 })
  try {
    fs.linkSync(temporary, file)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = readInboxReceipt(stateHome, text)
    if (!existing || existing.decision !== decision) throw new Error('inbox review receipt is immutable; a different decision already exists')
    return { receipt: existing, idempotent: true }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return { receipt, idempotent: false }
}

export function readInboxReceipt(stateHome, text) {
  const digest = sha256(text)
  try {
    const receipt = JSON.parse(fs.readFileSync(inboxReceiptFile(stateHome, digest), 'utf8'))
    const { receipt_sha256: stored, ...payload } = receipt
    if (receipt.kind !== 'inbox-review' || receipt.inbox_sha256 !== digest || stored !== sha256(JSON.stringify(payload))) return null
    return receipt
  } catch {
    return null
  }
}

export function reviewInbox(root, relativePath, { decision, reason, tty = false, stateHome } = {}) {
  const relative = path.relative(root, path.resolve(root, String(relativePath || ''))).split(path.sep).join('/')
  if (!/^docs\/inbox\/(ai|manual)\/[^/]+\.md$/.test(relative)) throw new Error('review --inbox expects docs/inbox/{ai,manual}/NOTE.md')
  if (!['accept', 'reject'].includes(decision) || !String(reason || '').trim()) throw new Error('review decision requires accept|reject and a non-empty reason')
  if (reason.length > 500 || scanUnsafe(reason).length) throw new Error('review reason is unsafe or exceeds 500 characters')
  if (decision === 'accept' && !tty) throw new Error('review --inbox accept needs an interactive terminal (human review)')
  const text = readRaw(root, relative)
  if (scanUnsafe(text).length) throw new Error('inbox note contains unsafe content')
  const { data } = parseMarkdownText(text)
  const sessionOrigin = isSessionOrigin(data, relative)
  if (decision === 'reject') vaultDir(root, 'docs/inbox/ai/processed')
  const { receipt, idempotent } = writeInboxReceipt(stateHome, { inboxPath: relative, text, decision, reason })
  const archived = decision === 'reject' ? archiveInboxSource(root, relative, 'rejected', sha256(text)) : null
  return { ok: true, path: relative, decision, session_origin: sessionOrigin, receipt, idempotent, archived: archived && path.relative(root, archived).split(path.sep).join('/') }
}

export function reviewGate(judgment, text, stateHome) {
  if (!judgment.session_origin || judgment.decision !== 'auto_apply') return judgment
  const receipt = readInboxReceipt(stateHome, text)
  if (receipt?.decision === 'accept') return { ...judgment, review: { reviewer: receipt.reviewer, reviewed_at: receipt.reviewed_at.slice(0, 10) } }
  return { ...judgment, decision: 'review_required', review: null, suggested_action: `alambic review --inbox ${judgment.path} --decision accept|reject --reason TEXT`, reason: `${judgment.reason} review_required` }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function coveredBy(root, targetPath, body) {
  const clean = normalizeText(body.replace(/^#\s+.+$/m, ''))
  if (clean.length < 80) return null
  try { const target = readRaw(root, targetPath); return normalizeText(target).includes(clean) ? sha256(target) : null } catch { return null }
}

export function judgeFreeformNote(root, filePath, { freeformBudgetRemaining = FREEFORM_DAILY_MAX, stateHome } = {}) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return {
      class: 'freeform_note',
      decision: 'reject',
      oracles: { parse_ok: false },
      path: path.relative(root, filePath).split(path.sep).join('/'),
      reason: `oracle:freeform-v2 parse_fail ${error.message}`,
    }
  }
  return judgeFreeformContent(root, filePath, text, { freeformBudgetRemaining, stateHome })
}

export function judgeFreeformContent(root, filePath, text, { freeformBudgetRemaining = FREEFORM_DAILY_MAX, stateHome } = {}) {
  const oracles = {}
  const relative = path.relative(root, filePath).split(path.sep).join('/')
  let data = {}
  let body = ''
  try {
    ;({ data, body } = parseMarkdownText(text))
    oracles.parse_ok = true
  } catch (error) {
    oracles.parse_ok = false
    return {
      class: 'freeform_note',
      decision: 'reject',
      oracles,
      path: relative,
      reason: `oracle:freeform-v2 parse_fail ${error.message}`,
    }
  }

  const unsafe = scanUnsafe(text)
  oracles.no_secrets = unsafe.length === 0
  oracles.has_type = ['finding', 'incident', 'adr', 'reference', 'synthesis'].includes(data.type)
  oracles.has_summary = typeof data.summary === 'string' && data.summary.trim().length >= 20
  oracles.has_sources = Array.isArray(data.sources) && data.sources.length >= 1
  oracles.sources_not_placeholder = Array.isArray(data.sources)
    && data.sources.length >= 1
    && data.sources.every((source) => !PLACEHOLDER_SOURCE.test(String(source)))
  oracles.sources_inspectable = Array.isArray(data.sources)
    && data.sources.every((source) => sourceLooksInspectable(root, source))
  oracles.has_tags = Array.isArray(data.tags) && data.tags.length >= 1
  oracles.body_min = body.replace(/\s+/g, ' ').trim().length >= 200
  oracles.refuse_patterns = !REFUSE_BODY.some((re) => re.test(text))
  oracles.inbox_lane = relative.startsWith('docs/inbox/')
  oracles.budget_ok = freeformBudgetRemaining > 0

  const hits = queryVault(root, String(data.summary || ''), { limit: 5 })
    .filter((hit) => hit.path.startsWith('kb/') && hit.path !== 'kb/_index.md')
  const top = hits[0]
  const preferUpdate = top && top.score >= UPDATE_SCORE_THRESHOLD && ['verified', 'accepted', 'draft'].includes(top.status)
  // Near-duplicate create is blocked; update path is preferred instead.
  oracles.update_or_unique = preferUpdate || !top || top.score < UPDATE_SCORE_THRESHOLD

  const hard = [
    'parse_ok', 'no_secrets', 'has_type', 'has_summary', 'has_sources',
    'sources_not_placeholder', 'sources_inspectable', 'has_tags', 'body_min',
    'refuse_patterns', 'inbox_lane', 'budget_ok', 'update_or_unique',
  ]
  const hardPass = hard.every((key) => oracles[key])

  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relative, '.md')
  const basename = slugifyBasename(title)
  const sessionOrigin = isSessionOrigin(data, relative)
  const covered = preferUpdate && oracles.no_secrets ? coveredBy(root, top.path, body) : null

  if (covered) {
    return {
      class: 'freeform_note',
      decision: 'noop',
      oracles,
      path: relative,
      session_origin: sessionOrigin,
      update_target: top.path,
      target_sha256: covered,
      data,
      sha256: sha256(text),
      suggested_action: 'archive-as-noop',
      top_similar: { path: top.path, score: top.score, status: top.status },
      reason: `oracle:freeform-v2 noop already covered by ${top.path}`,
    }
  }

  return reviewGate({
    class: 'freeform_note',
    decision: hardPass ? 'auto_apply' : (oracles.parse_ok && oracles.no_secrets && oracles.has_summary ? 'quarantine_ready' : 'reject'),
    session_origin: sessionOrigin,
    oracles,
    path: relative,
    mode: preferUpdate ? 'update' : 'create',
    update_target: preferUpdate ? top.path : null,
    create_basename: basename,
    title,
    data,
    suggested_action: hardPass
      ? (preferUpdate ? `update ${top.path}` : `create kb/${basename}.md`)
      : 'leave-in-inbox',
    top_similar: top ? { path: top.path, score: top.score, status: top.status } : null,
    reason: hardPass
      ? `oracle:freeform-v2 ${preferUpdate ? 'update' : 'create'} ${preferUpdate ? top.path : basename}`
      : `oracle:freeform-v2 fail ${hard.filter((key) => !oracles[key]).join(',')}`,
  }, text, stateHome)
}

export function freeformDailyBudget(stateHome) {
  const dir = path.join(alambicStateDir(stateHome), 'sidekick')
  const file = path.join(dir, 'freeform-budget.json')
  const today = new Date().toISOString().slice(0, 10)
  let data = { date: today, count: 0, max: FREEFORM_DAILY_MAX }
  try {
    if (fs.existsSync(file)) {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
      if (data.date !== today) data = { date: today, count: 0, max: FREEFORM_DAILY_MAX }
    }
  } catch {
    // reset
  }
  return {
    date: data.date,
    count: data.count || 0,
    max: data.max || FREEFORM_DAILY_MAX,
    remaining: Math.max(0, (data.max || FREEFORM_DAILY_MAX) - (data.count || 0)),
    file,
  }
}

export function consumeFreeformBudget(stateHome) {
  const budget = freeformDailyBudget(stateHome)
  fs.mkdirSync(path.dirname(budget.file), { recursive: true, mode: 0o700 })
  const next = { date: budget.date, count: budget.count + 1, max: budget.max }
  fs.writeFileSync(budget.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

/**
 * Promote freeform inbox note: update existing kb note or create new one.
 */
function coveredSha(root, targetPath) {
  try { return sha256(readRaw(root, targetPath)) } catch { return null }
}

export function archiveNoop(root, judgment) {
  if (judgment.decision !== 'noop') return { ok: false, error: 'not-noop', path: judgment.path }
  if (!judgment.update_target || coveredSha(root, judgment.update_target) !== judgment.target_sha256) return { ok: false, error: 'target-changed-since-judged', path: judgment.path }
  const archived = archiveInboxSource(root, judgment.path, 'noop', judgment.sha256)
  if (!archived) return { ok: false, error: 'changed-since-judged', path: judgment.path }
  if (coveredSha(root, judgment.update_target) !== judgment.target_sha256) {
    unarchive(archived, path.join(root, judgment.path), judgment.sha256)
    return { ok: false, error: 'target-changed-since-judged', path: judgment.path }
  }
  return { ok: true, mode: 'noop', path: judgment.path, changed: false }
}

const RELATED_NOTES = ['capture-quarantine-before-kb', 'adr-alambic-autonomous-oracle-sidekick']
function relatedLinks(root) {
  const links = RELATED_NOTES.filter((name) => fs.existsSync(path.join(root, 'kb', `${name}.md`))).map((name) => `- [[${name}]]`)
  return links.length ? ['## Related', '', ...links, ''] : []
}

function setFrontmatterField(text, key, value) {
  const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1
  if (end < 0) return text
  const head = text.slice(0, end)
  const line = new RegExp(`^${key}:.*$`, 'm')
  return (line.test(head) ? head.replace(line, `${key}: ${value}`) : `${head}\n${key}: ${value}`) + text.slice(end)
}

export function applyFreeformPromote(root, judgment, { stateHome } = {}) {
  if (judgment.decision !== 'auto_apply') {
    return { ok: false, error: 'not-auto-apply', path: judgment.path }
  }
  const today = new Date().toISOString().slice(0, 10)
  const sourceAbs = path.join(root, judgment.path)
  if (!fs.existsSync(sourceAbs)) return { ok: false, error: 'missing-source' }

  const text = fs.readFileSync(sourceAbs, 'utf8')
  const { data, body } = parseMarkdownText(text)
  if (scanUnsafe(text).length) return { ok: false, error: 'unsafe-source' }
  const receipt = readInboxReceipt(stateHome, text)
  if (isSessionOrigin(data, judgment.path) && receipt?.decision !== 'accept') return { ok: false, error: 'review-required', path: judgment.path }
  const reviewedBy = receipt?.decision === 'accept' ? receipt.reviewer : 'oracle:sidekick-freeform-v2'
  const reviewedAt = receipt?.decision === 'accept' ? receipt.reviewed_at.slice(0, 10) : today

  if (judgment.mode === 'update' && judgment.update_target) {
    const targetAbs = path.join(root, judgment.update_target)
    const before = fs.readFileSync(targetAbs, 'utf8')
    const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 600)
    const block = `\n\n## Sidekick promote ${today}\n\nPromoted signal from \`${judgment.path}\` (${reviewedBy === HUMAN_REVIEWER ? `${HUMAN_REVIEWER} ${reviewedAt}` : 'oracle:freeform-v2'}).\n\n> ${excerpt}\n`
    let after = before.replace(/\s*$/, '') + block
    if (/^updated:\s*\d{4}-\d{2}-\d{2}/m.test(after)) {
      after = after.replace(/^updated:\s*\d{4}-\d{2}-\d{2}/m, `updated: ${today}`)
    }
    if (receipt?.decision === 'accept') after = setFrontmatterField(setFrontmatterField(after, 'reviewed_by', reviewedBy), 'reviewed_at', reviewedAt)
    // Merge inbound wikilinks from source body into Related if present
    const links = [...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim())
    for (const link of links.slice(0, 5)) {
      if (!hasWikilink(after, link) && link !== path.basename(judgment.update_target, '.md')) {
        if (/^## Related\s*$/m.test(after)) {
          after = after.replace(/^(## Related\s*\n)/m, `$1\n- [[${link}]]\n`)
        }
      }
    }
    if (scanUnsafe(after).length) return { ok: false, error: 'unsafe-after' }
    if (!writeChecked(targetAbs, before, after)) return { ok: false, error: 'concurrent-edit', path: judgment.update_target }
    archiveInboxSource(root, judgment.path, 'updated', sha256(text))
    invalidateManifest(root)
    return { ok: true, mode: 'update', path: judgment.update_target, changed: true }
  }

  // Create
  const basename = judgment.create_basename || slugifyBasename(judgment.title || 'note')
  const targetRel = `kb/${basename}.md`
  const targetAbs = path.join(root, targetRel)
  if (fs.existsSync(targetAbs)) {
    // Fallback to update if race
    return applyFreeformPromote(root, { ...judgment, mode: 'update', update_target: targetRel }, { stateHome })
  }

  const sources = Array.isArray(data.sources) ? data.sources : []
  if (!sources.includes(judgment.path)) sources.unshift(judgment.path)

  const front = [
    '---',
    `type: ${data.type || 'finding'}`,
    'status: verified',
    `summary: ${yamlQuote(data.summary || judgment.title)}`,
    'sources:',
    ...sources.map((s) => `  - ${yamlQuote(s)}`),
    `created: ${data.created || today}`,
    `updated: ${today}`,
    `verified_at: ${today}`,
    `promoted_from: ${yamlQuote(judgment.path)}`,
    `reviewed_by: ${reviewedBy}`,
    `reviewed_at: ${reviewedAt}`,
    'confidence: medium',
    'tags:',
    ...(data.tags || ['auto-promoted']).map((t) => `  - ${t}`),
    '---',
    '',
    body.trim(),
    '',
    ...relatedLinks(root),
  ].join('\n')

  if (scanUnsafe(front).length) return { ok: false, error: 'unsafe-create' }
  if (!writeChecked(targetAbs, null, front)) return { ok: false, error: 'concurrent-edit', path: targetRel }
  applyIndexEntry(root, basename)
  archiveInboxSource(root, judgment.path, 'created', sha256(text))
  invalidateManifest(root)
  return { ok: true, mode: 'create', path: targetRel, changed: true, basename }
}

function archiveInboxSource(root, relativePath, mode, expected) {
  const abs = path.join(root, relativePath)
  if (!fs.existsSync(abs)) return null
  const processedDir = vaultDir(root, 'docs/inbox/ai/processed')
  const ext = path.extname(relativePath)
  const base = path.basename(relativePath, ext)
  const names = Array.from({ length: 20 }, (_, attempt) => path.join(processedDir, `${mode}-${base}${attempt ? `-${attempt}` : ''}${ext}`))
  const real = fs.realpathSync.native(processedDir)
  const archived = moveChecked(abs, names, expected)
  if (archived && fs.realpathSync.native(path.dirname(archived)) !== real) {
    unarchive(archived, abs, expected)
    throw new Error('docs/inbox/ai/processed changed during the archive')
  }
  return archived
}

function sourceLooksInspectable(root, source) {
  const value = String(source || '')
  if (!value || PLACEHOLDER_SOURCE.test(value)) return false
  if (/^https?:\/\//i.test(value)) return true
  if (/^(codex|claude|pi|obsidian|repo):/i.test(value)) return true
  const clean = value.replace(/:\d+(?:-\d+)?$/, '')
  const candidates = [
    path.join(root, clean),
    path.join(path.dirname(root), clean),
  ]
  return candidates.some((candidate) => fs.existsSync(candidate))
}

function slugifyBasename(title) {
  const slug = String(title || 'note')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'auto-note'
}

function yamlQuote(value) {
  const text = String(value).replace(/"/g, '\\"')
  return `"${text}"`
}

/**
 * Apply a structural wikilink from source → target basename under ## Related.
 * Returns { ok, path, changed }.
 */
export function applyStructuralWikilink(root, sourcePath, targetBasename) {
  const absolute = path.join(root, sourcePath)
  if (!fs.existsSync(absolute)) return { ok: false, error: 'missing-file', path: sourcePath }
  const before = fs.readFileSync(absolute, 'utf8')
  if (hasWikilink(before, targetBasename)) {
    return { ok: true, path: sourcePath, changed: false, reason: 'already-linked' }
  }

  const link = `[[${targetBasename}]]`
  let after
  if (/^## Related\s*$/m.test(before)) {
    after = before.replace(/^(## Related\s*\n)/m, `$1\n- ${link}\n`)
  } else {
    const trimmed = before.replace(/\s*$/, '')
    after = `${trimmed}\n\n## Related\n\n- ${link}\n`
  }

  // Bump updated: frontmatter if present
  const today = new Date().toISOString().slice(0, 10)
  if (/^updated:\s*\d{4}-\d{2}-\d{2}/m.test(after)) {
    after = after.replace(/^updated:\s*\d{4}-\d{2}-\d{2}/m, `updated: ${today}`)
  }

  // Safety: no secrets introduced
  if (scanUnsafe(after).length) return { ok: false, error: 'unsafe-after', path: sourcePath }

  if (!writeChecked(absolute, before, after)) return { ok: false, error: 'concurrent-edit', path: sourcePath }
  invalidateManifest(root)
  return { ok: true, path: sourcePath, changed: true, link }
}

/**
 * Ensure kb/_index.md lists [[basename]] under Active durable notes section.
 */
export function applyIndexEntry(root, basename) {
  const indexPath = path.join(root, 'kb/_index.md')
  const before = fs.readFileSync(indexPath, 'utf8')
  if (hasWikilink(before, basename)) {
    return { ok: true, path: 'kb/_index.md', changed: false, reason: 'already-listed' }
  }

  const entry = `- [[${basename}]] - (auto) indexed by sidekick oracle`
  let after
  if (/^## Active durable notes\s*$/m.test(before)) {
    after = before.replace(/^(## Active durable notes\s*\n)/m, `$1\n${entry}\n`)
  } else {
    after = `${before.replace(/\s*$/, '')}\n\n## Active durable notes\n\n${entry}\n`
  }

  const today = new Date().toISOString().slice(0, 10)
  if (/^updated:\s*\d{4}-\d{2}-\d{2}/m.test(after)) {
    after = after.replace(/^updated:\s*\d{4}-\d{2}-\d{2}/m, `updated: ${today}`)
  }

  if (scanUnsafe(after).length) return { ok: false, error: 'unsafe-after', path: 'kb/_index.md' }
  if (!writeChecked(indexPath, before, after)) return { ok: false, error: 'concurrent-edit', path: 'kb/_index.md' }
  invalidateManifest(root)
  return { ok: true, path: 'kb/_index.md', changed: true, basename }
}

export function postApplyHealth(root) {
  const report = validateVault(root, { strict: true })
  return {
    ok: report.ok,
    errors: report.errors?.length || 0,
    notes: report.notes,
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function indexNotes(root) {
  const map = new Map()
  for (const note of buildManifest(root, false, { fresh: true })) {
    map.set(note.path, note)
  }
  return map
}

export function readRaw(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function hasWikilink(text, basename) {
  const re = new RegExp(`\\[\\[${escapeRegExp(basename)}(?:[|#][^\\]]*)?\\]\\]`, 'i')
  return re.test(text)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function failedKeys(oracles) {
  return Object.entries(oracles).filter(([, ok]) => !ok).map(([key]) => key)
}
