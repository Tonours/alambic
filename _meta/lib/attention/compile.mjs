import fs from 'node:fs'
import path from 'node:path'
import { ATTENTION_INBOX_RELATIVE } from './stage.mjs'
import { compareRankedCandidates } from './ranking.mjs'

export const SYNTHESIS_PREFIX = 'attention-synthesis-'
export const MAX_SYNTHESIS_CLAIMS = 7

function dayStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error('attention compile requires a valid ISO timestamp')
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function assertInboxOnly(root, targetPath) {
  const inboxRoot = path.resolve(root, ATTENTION_INBOX_RELATIVE)
  const resolved = path.resolve(targetPath)
  if (resolved !== inboxRoot && !resolved.startsWith(`${inboxRoot}${path.sep}`)) {
    throw new Error('attention compile may only write under docs/inbox/ai')
  }
  if (resolved.includes(`${path.sep}kb${path.sep}`) || resolved.endsWith(`${path.sep}kb`) || resolved.includes(`${path.sep}ref${path.sep}`)) {
    throw new Error('attention compile refuses kb/ and ref/ paths')
  }
  return resolved
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôùûüç#+.\s-]/gi, ' ')
    .split(/[\s/_-]+/)
    .filter((token) => token.length >= 3)
}

/**
 * Score kb note basenames/titles against entry text for update-before-create.
 * Pure: no I/O.
 */
export function suggestKbTarget(entry, kbIndex = []) {
  const hay = tokenize([entry?.title, entry?.canonical_url, ...(entry?.topics || []), ...(entry?.reason_codes || [])].join(' '))
  if (!hay.length || !Array.isArray(kbIndex) || !kbIndex.length) {
    return { action: 'create', path: null, score: 0, reason: 'no-index-match' }
  }
  let best = null
  for (const note of kbIndex) {
    const needle = tokenize([note.basename, note.title, note.summary, ...(note.tags || [])].join(' '))
    if (!needle.length) continue
    const set = new Set(needle)
    let hit = 0
    for (const token of hay) if (set.has(token)) hit += 1
    const score = hit / Math.max(3, Math.min(hay.length, 12))
    if (!best || score > best.score) best = { ...note, score }
  }
  if (!best || best.score < 0.15) {
    return { action: 'create', path: null, score: best?.score || 0, reason: 'below-threshold' }
  }
  return {
    action: 'update',
    path: best.path || `kb/${best.basename}.md`,
    basename: best.basename,
    score: Number(best.score.toFixed(3)),
    reason: 'token-overlap',
  }
}

function observedAtValue(entry) {
  const value = Date.parse(entry?.observed_at)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function stableEntryId(entry) {
  return String(entry?.digest || entry?.title || entry?.canonical_url || '')
}

function compareLegacyEntries(left, right) {
  return (right.signal_weight || 0) - (left.signal_weight || 0)
    || observedAtValue(right) - observedAtValue(left)
    || stableEntryId(left).localeCompare(stableEntryId(right))
}

function rankCompileEntries(entries) {
  const scored = entries.filter((entry) => Number.isFinite(entry.ranking_score)).sort(compareRankedCandidates)
  const legacy = entries.filter((entry) => !Number.isFinite(entry.ranking_score)).sort(compareLegacyEntries)
  return [...scored, ...legacy]
}

/**
 * Build ≤7 durable claims from digest entries (deterministic, no LLM).
 */
export function buildClaimsFromEntries(entries, { kbIndex = [], maxClaims = MAX_SYNTHESIS_CLAIMS } = {}) {
  if (!Array.isArray(entries)) throw new Error('compile entries must be an array')
  const ranked = rankCompileEntries(entries.filter((entry) => entry && (entry.digest || entry.title)))
    .slice(0, maxClaims)

  return ranked.map((entry, index) => {
    const title = String(entry.title || 'Untitled signal').replace(/\s+/g, ' ').trim()
    const target = suggestKbTarget(entry, kbIndex)
    return {
      id: index + 1,
      claim: title.slice(0, 200),
      source: entry.source || 'unknown',
      digest: entry.digest || null,
      canonical_url: entry.canonical_url || null,
      signal_weight: entry.signal_weight ?? null,
      ranking_score: Number.isFinite(entry.ranking_score) ? entry.ranking_score : null,
      ranking_reasons: Array.isArray(entry.ranking_reasons) ? entry.ranking_reasons : [],
      topics: Array.isArray(entry.topics) ? entry.topics : [],
      confidence: entry.confidence === 'deterministic' ? 'deterministic' : 'approximate',
      suggested_kb: target,
      agent_check: target.action === 'update'
        ? `Load ${target.path}; merge durable fact; keep frontmatter sources; validate-kb`
        : 'Search kb/_index for near-duplicate; create finding only if reusable + sourced; validate-kb',
    }
  })
}

export function extractThemes(entries, claims) {
  const bag = new Map()
  const bump = (key, weight = 1) => {
    if (!key) return
    const k = String(key).toLowerCase()
    bag.set(k, (bag.get(k) || 0) + weight)
  }
  for (const entry of entries || []) {
    for (const topic of entry.topics || []) bump(topic, 3)
    for (const reason of entry.reason_codes || []) {
      if (String(reason).startsWith('term:')) bump(String(reason).slice(5), 2)
    }
    for (const token of tokenize(entry.title).slice(0, 8)) bump(token, 1)
  }
  for (const claim of claims || []) {
    for (const topic of claim.topics || []) bump(topic, 2)
  }
  return [...bag.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([theme, weight]) => ({ theme, weight }))
}

export function buildSynthesisMarkdown({ claims, themes, generatedAt, runId, entryCount }) {
  const lines = [
    '---',
    'type: draft',
    'status: draft',
    'summary: "Daily attention synthesis for LLM context (shadow; not durable kb)."',
    `generated_at: "${generatedAt}"`,
    `run_id: "${runId}"`,
    'tags:',
    '  - attention',
    '  - synthesis',
    '  - llm-context',
    '---',
    '',
    '# Attention daily synthesis',
    '',
    'High-signal compile of technical attention candidates for agent session start.',
    '**Not** durable `kb/` knowledge. apply-auto remains DISABLED.',
    'Prefer update-before-create using suggested targets below.',
    '',
    `Generated: ${generatedAt}`,
    `Queue entries considered: ${entryCount}`,
    `Claims: ${claims.length} (max ${MAX_SYNTHESIS_CLAIMS})`,
    '',
    '## Themes',
    '',
  ]
  if (!themes.length) lines.push('_No themes (empty queue)._', '')
  else {
    for (const item of themes) lines.push(`- ${item.theme} (w=${item.weight})`)
    lines.push('')
  }
  lines.push('## Durable candidate claims', '')
  if (!claims.length) {
    lines.push('_No-op: no unexpired technical candidates to compile._', '')
    return lines.join('\n')
  }
  for (const claim of claims) {
    lines.push(`### ${claim.id}. ${claim.claim}`)
    lines.push('')
    lines.push(`- source: \`${claim.source}\``)
    if (claim.digest) lines.push(`- digest: \`${claim.digest}\``)
    if (claim.canonical_url) lines.push(`- url: ${claim.canonical_url}`)
    lines.push(`- confidence: ${claim.confidence}`)
    if (claim.signal_weight != null) lines.push(`- signal_weight: ${claim.signal_weight}`)
    if (claim.ranking_score != null) lines.push(`- ranking_score: ${claim.ranking_score}`)
    if (claim.ranking_reasons.length) {
      lines.push(`- ranking_reasons: ${claim.ranking_reasons.map((reason) => `${reason.signal}=${reason.contribution}`).join(', ')}`)
    }
    const sk = claim.suggested_kb || {}
    lines.push(`- suggested_kb: **${sk.action}**${sk.path ? ` → \`${sk.path}\`` : ''} (score=${sk.score ?? 0}; ${sk.reason || ''})`)
    lines.push(`- agent_check: ${claim.agent_check}`)
    lines.push('')
  }
  lines.push('## Next step', '')
  lines.push('1. Read the items; attention is a reading queue, not a promotion lane.', '')
  lines.push('2. When an item yields a durable, sourced claim, write it to `docs/inbox/manual/` for the normal promotion gate.', '')
  lines.push('3. Never dump raw transcripts into kb/; sources must stay inspectable URLs.', '')
  return lines.join('\n')
}

/**
 * Load lightweight kb index for routing suggestions (basename + frontmatter summary/tags).
 */
export function loadKbIndex(root, { limit = 400 } = {}) {
  const kbDir = path.join(root, 'kb')
  if (!fs.existsSync(kbDir)) return []
  const files = fs.readdirSync(kbDir).filter((name) => name.endsWith('.md') && name !== '_index.md')
  const notes = []
  for (const file of files.slice(0, limit)) {
    const full = path.join(kbDir, file)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8').slice(0, 4000)
    } catch {
      continue
    }
    const basename = file.replace(/\.md$/, '')
    const titleMatch = text.match(/^#\s+(.+)$/m)
    const summaryMatch = text.match(/^summary:\s*["']?(.+?)["']?\s*$/m)
    const tagBlock = text.match(/^tags:\n((?:  - .+\n)*)/m)
    const tags = tagBlock
      ? tagBlock[1].split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
      : []
    notes.push({
      basename,
      path: `kb/${file}`,
      title: titleMatch?.[1]?.trim() || basename,
      summary: summaryMatch?.[1]?.trim() || '',
      tags,
    })
  }
  return notes
}

export function writeSynthesis({
  root,
  entries,
  now = () => new Date().toISOString(),
  dryRun = false,
  runId = 'attention-compile',
  maxClaims = MAX_SYNTHESIS_CLAIMS,
  kbIndex = null,
} = {}) {
  if (!root) throw new Error('attention compile requires root')
  const generatedAt = typeof now === 'function' ? now() : now
  const stamp = dayStamp(generatedAt)
  const relative = path.join(ATTENTION_INBOX_RELATIVE, `${SYNTHESIS_PREFIX}${stamp}.md`)
  const target = assertInboxOnly(root, path.join(root, relative))
  const index = kbIndex || loadKbIndex(root)
  const claims = buildClaimsFromEntries(entries || [], { kbIndex: index, maxClaims })
  const themes = extractThemes(entries || [], claims)
  const markdown = buildSynthesisMarkdown({
    claims,
    themes,
    generatedAt,
    runId,
    entryCount: (entries || []).length,
  })
  const result = {
    dry_run: Boolean(dryRun),
    path: relative,
    absolute_path: target,
    claims: claims.length,
    themes: themes.map((t) => t.theme),
    empty: claims.length === 0,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    wrote_kb: false,
    wrote_ref: false,
    suggestions: claims.map((c) => ({
      source: c.source,
      digest: c.digest,
      claim: c.claim,
      suggested_kb: c.suggested_kb,
    })),
  }
  if (dryRun) return result
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, markdown, { encoding: 'utf8', mode: 0o600 })
  return result
}

export const PROMOTE_READY_RELATIVE = path.join(ATTENTION_INBOX_RELATIVE, 'promote-ready')

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Build a freeform-oracle-ready draft for sidekick promote (update-first target optional).
 * Skips claims without an inspectable https/http canonical_url (no freeform without source).
 */
export function buildOracleReadyDraft(claim, { generatedAt } = {}) {
  if (!claim?.digest || !claim?.source) return null
  if (!isHttpsUrl(claim.canonical_url)) return null
  const title = String(claim.claim || 'Attention signal').replace(/\s+/g, ' ').trim().slice(0, 120)
  const summary = title.length >= 20 ? title.slice(0, 200) : `${title} (attention durable candidate)`
  const topics = Array.isArray(claim.topics) && claim.topics.length
    ? claim.topics.slice(0, 6)
    : ['attention', 'technical-signal']
  const tags = [...new Set(['attention', 'promote-ready', ...topics.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32)).filter(Boolean)])]
  const suggested = claim.suggested_kb || {}
  // Body must clear freeform body_min (~200 chars) with reusable framing.
  const body = [
    `# ${title}`,
    '',
    '## Behavior / Cause',
    '',
    `Attention intake surfaced a high-signal technical item from \`${claim.source}\`.`,
    `Title/claim: ${title}.`,
    claim.signal_weight != null ? `Signal weight: ${claim.signal_weight}.` : null,
    claim.confidence ? `Confidence class: ${claim.confidence}.` : null,
    '',
    'This draft is staged for oracle-gated sidekick promotion (not a raw transcript dump).',
    'Prefer updating an existing kb note when suggested_kb action is update.',
    '',
    '## Practical Implication',
    '',
    String(claim.agent_check || 'Search kb for near-duplicates; update-before-create; keep sources.'),
    suggested.action === 'update' && suggested.path
      ? `Primary update target: \`${suggested.path}\` (score=${suggested.score ?? 0}).`
      : 'No strong existing note match; create only if the fact is reusable across sessions.',
    '',
    '## Evidence',
    '',
    `- canonical_url: ${claim.canonical_url}`,
    `- attention_source: ${claim.source}`,
    `- digest: ${claim.digest}`,
    topics.length ? `- topics: ${topics.join(', ')}` : null,
    '',
    '## Related',
    '',
    '- [[capture-quarantine-before-kb]]',
    '- [[technical-attention-intake]]',
    '- [[adr-alambic-autonomous-oracle-sidekick]]',
    '',
  ].filter((line) => line !== null).join('\n')

  const front = [
    '---',
    'type: finding',
    'status: draft',
    `summary: ${yamlQuote(summary)}`,
    'sources:',
    `  - ${yamlQuote(claim.canonical_url)}`,
    `  - ${yamlQuote(`attention:${claim.source}:${claim.digest}`)}`,
    `created: ${String(generatedAt || new Date().toISOString()).slice(0, 10)}`,
    `updated: ${String(generatedAt || new Date().toISOString()).slice(0, 10)}`,
    `promoted_from: ${yamlQuote(`attention:${claim.source}:${claim.digest}`)}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
    '',
    body,
  ].join('\n')

  return { title, summary, markdown: front, suggested_kb: suggested }
}

/**
 * Promote-suggest / materialize: dry refuses writes; --confirm stages
 * freeform-oracle-ready drafts under docs/inbox/ai/promote-ready/ for sidekick.
 */
export function promoteSuggest({
  root,
  entries,
  confirm = false,
  now = () => new Date().toISOString(),
  maxClaims = MAX_SYNTHESIS_CLAIMS,
  kbIndex = null,
} = {}) {
  if (!root) throw new Error('promote-suggest requires root')
  const index = kbIndex || loadKbIndex(root)
  const claims = buildClaimsFromEntries(entries || [], { kbIndex: index, maxClaims })
  const suggestions = claims.map((c) => ({
    source: c.source,
    digest: c.digest,
    claim: c.claim,
    canonical_url: c.canonical_url || null,
    materializable: isHttpsUrl(c.canonical_url),
    suggested_kb: c.suggested_kb,
    agent_check: c.agent_check,
  }))
  if (!confirm) {
    return {
      ok: false,
      reason: 'confirm-required',
      suggestions,
      staged: [],
      skipped: suggestions.filter((s) => !s.materializable).length,
      wrote_kb: false,
      wrote_ref: false,
    }
  }
  const generatedAt = typeof now === 'function' ? now() : now
  const staged = []
  const skipped = []
  for (const claim of claims) {
    const draft = buildOracleReadyDraft(claim, { generatedAt })
    if (!draft) {
      skipped.push({ source: claim.source, digest: claim.digest, reason: 'missing-https-url' })
      continue
    }
    const safeDigest = String(claim.digest).replace(/[^a-f0-9]/gi, '').slice(0, 16) || 'unknown'
    const safeSource = String(claim.source).replace(/[^a-z0-9-]/gi, '-').slice(0, 40)
    const relative = path.join(PROMOTE_READY_RELATIVE, `${safeSource}-${safeDigest}.md`)
    const target = assertInboxOnly(root, path.join(root, relative))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, draft.markdown, { encoding: 'utf8', mode: 0o600 })
    staged.push({
      path: relative,
      wrote_kb: false,
      suggested_kb: draft.suggested_kb,
      oracle_ready: true,
    })
  }
  return {
    ok: true,
    suggestions,
    staged,
    skipped,
    wrote_kb: false,
    wrote_ref: false,
  }
}

/**
 * Bounded session pack for morning attention review (paths + statuses only).
 */
export function buildAttentionSessionPack({
  root,
  status = null,
  maxTokens = 2500,
  now = () => new Date().toISOString(),
} = {}) {
  if (!root) throw new Error('attention session pack requires root')
  const stamp = dayStamp(typeof now === 'function' ? now() : now)
  const digestRel = path.join(ATTENTION_INBOX_RELATIVE, `attention-digest-${stamp}.md`)
  const synthesisRel = path.join(ATTENTION_INBOX_RELATIVE, `${SYNTHESIS_PREFIX}${stamp}.md`)
  const digestAbs = path.join(root, digestRel)
  const synthesisAbs = path.join(root, synthesisRel)

  const sources = status?.sources || {}
  const sourceLines = Object.entries(sources).map(([name, state]) => {
    const cap = state?.capability?.status || 'unknown'
    const n = state?.candidates ?? 0
    return `${name}: ${cap} candidates=${n}`
  })

  const lines = [
    '# Attention session pack',
    'Untrusted paths only. No encrypted blobs. apply-auto DISABLED.',
    '',
    '## Source status',
    ...(sourceLines.length ? sourceLines.map((l) => `- ${l}`) : ['- (status unavailable)']),
    '',
    '## Today artifacts',
    `- digest: ${fs.existsSync(digestAbs) ? digestRel : '(missing)'}`,
    `- synthesis: ${fs.existsSync(synthesisAbs) ? synthesisRel : '(missing)'}`,
    '',
    '## Agent entry',
    '- Read synthesis if present; else digest.',
    '- Use promote-suggest dry for update-before-create hints.',
    '- Never paste secrets; do not auto-write kb/.',
    '',
  ]
  let text = lines.join('\n')
  // rough token estimate ~ chars/4
  const hardChars = Math.max(400, Math.floor(maxTokens * 4))
  if (text.length > hardChars) text = `${text.slice(0, hardChars - 20)}\n…[truncated]\n`
  const estimated_tokens = Math.ceil(text.length / 4)
  return {
    max_tokens: maxTokens,
    estimated_tokens,
    within_budget: estimated_tokens <= maxTokens,
    digest_path: fs.existsSync(digestAbs) ? digestRel : null,
    synthesis_path: fs.existsSync(synthesisAbs) ? synthesisRel : null,
    sources: sourceLines,
    text,
    wrote_kb: false,
  }
}
