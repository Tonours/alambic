import fs from 'node:fs'
import path from 'node:path'

export const ATTENTION_INBOX_RELATIVE = 'docs/inbox/ai'
export const ATTENTION_DROP_X_RELATIVE = 'docs/inbox/ai/attention-drop/x-bookmarks'

function dayStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error('attention stage requires a valid ISO timestamp')
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function assertStagingRoot(root, targetPath) {
  const inboxRoot = path.resolve(root, ATTENTION_INBOX_RELATIVE)
  const resolved = path.resolve(targetPath)
  if (resolved !== inboxRoot && !resolved.startsWith(`${inboxRoot}${path.sep}`)) {
    throw new Error('attention stage may only write under docs/inbox/ai')
  }
  if (resolved.includes(`${path.sep}kb${path.sep}`) || resolved.endsWith(`${path.sep}kb`) || resolved.includes(`${path.sep}ref${path.sep}`)) {
    throw new Error('attention stage refuses kb/ and ref/ paths')
  }
  return resolved
}

/**
 * Build a batched promote-candidate digest for human review.
 * Never writes kb/ or ref/; staging only under docs/inbox/ai/.
 */
export function buildStageMarkdown({ entries, generatedAt, runId }) {
  if (!Array.isArray(entries)) throw new Error('attention stage entries must be an array')
  const lines = [
    '---',
    'type: draft',
    'status: draft',
    'summary: "Daily technical-attention promote candidates (shadow queue; not auto-applied to kb)."',
    `generated_at: "${generatedAt}"`,
    `run_id: "${runId}"`,
    'tags:',
    '  - attention',
    '  - promote-candidates',
    '---',
    '',
    '# Attention promote candidates',
    '',
    'Shadow staging only. Do **not** treat this file as durable `kb/` knowledge.',
    'Review each item, then promote manually (update-before-create) with `promoted_from` / `reviewed_by` / `reviewed_at`.',
    'apply-auto remains DISABLED.',
    '',
    `Generated: ${generatedAt}`,
    `Candidates: ${entries.length}`,
    '',
  ]
  if (!entries.length) {
    lines.push('_No unexpired technical attention candidates._', '')
    return lines.join('\n')
  }
  for (const entry of entries) {
    const digest = entry.digest || '(missing-digest)'
    const source = entry.source || '(unknown)'
    const title = String(entry.title || '').replace(/\s+/g, ' ').trim() || '(untitled)'
    const url = entry.canonical_url || ''
    const weight = entry.signal_weight ?? ''
    const rankingScore = entry.ranking_score ?? ''
    const rankingReasons = Array.isArray(entry.ranking_reasons)
      ? entry.ranking_reasons.map((reason) => `${reason.signal}=${reason.contribution}`).join(', ')
      : ''
    const reasons = Array.isArray(entry.reason_codes) ? entry.reason_codes.join(', ') : ''
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(`- source: \`${source}\``)
    lines.push(`- digest: \`${digest}\``)
    if (url) lines.push(`- url: ${url}`)
    if (weight !== '') lines.push(`- signal_weight: ${weight}`)
    if (rankingScore !== '') lines.push(`- ranking_score: ${rankingScore}`)
    if (rankingReasons) lines.push(`- ranking_reasons: ${rankingReasons}`)
    if (reasons) lines.push(`- reasons: ${reasons}`)
    lines.push('- action: human review → optional promote to kb (never automatic)')
    lines.push('')
  }
  return lines.join('\n')
}

export function stagePromoteCandidates({
  root,
  entries,
  now = () => new Date().toISOString(),
  dryRun = false,
  runId = 'attention-daily',
} = {}) {
  if (!root) throw new Error('attention stage requires root')
  const generatedAt = typeof now === 'function' ? now() : now
  const stamp = dayStamp(generatedAt)
  const relative = path.join(ATTENTION_INBOX_RELATIVE, `attention-digest-${stamp}.md`)
  const target = assertStagingRoot(root, path.join(root, relative))
  const markdown = buildStageMarkdown({ entries, generatedAt, runId })
  if (dryRun) {
    return {
      dry_run: true,
      path: relative,
      absolute_path: target,
      staged: entries.length,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      wrote_kb: false,
      wrote_ref: false,
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, markdown, { encoding: 'utf8', mode: 0o600 })
  return {
    dry_run: false,
    path: relative,
    absolute_path: target,
    staged: entries.length,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    wrote_kb: false,
    wrote_ref: false,
  }
}

/**
 * Promote requires explicit confirm and still refuses kb/ref writes.
 * It writes a single candidate draft under docs/inbox/ai/ only.
 */
export function promoteCandidateDraft({
  root,
  entry,
  confirm = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (!confirm) {
    return {
      ok: false,
      reason: 'confirm-required',
      wrote_kb: false,
      wrote_ref: false,
    }
  }
  if (!entry?.digest || !entry?.source) throw new Error('promote requires candidate digest and source')
  const generatedAt = typeof now === 'function' ? now() : now
  const safeDigest = String(entry.digest).replace(/[^a-f0-9]/gi, '').slice(0, 16) || 'unknown'
  const relative = path.join(ATTENTION_INBOX_RELATIVE, `attention-candidate-${entry.source}-${safeDigest}.md`)
  const target = assertStagingRoot(root, path.join(root, relative))
  const title = String(entry.title || 'Untitled technical signal').replace(/\s+/g, ' ').trim()
  const body = [
    '---',
    'type: draft',
    'status: draft',
    `summary: "Staged attention candidate from ${entry.source} (not durable kb)."`,
    `promoted_from: "attention:${entry.source}:${entry.digest}"`,
    `generated_at: "${generatedAt}"`,
    'tags:',
    '  - attention',
    '  - staged-candidate',
    '---',
    '',
    `# ${title}`,
    '',
    `- source: \`${entry.source}\``,
    `- digest: \`${entry.digest}\``,
    entry.canonical_url ? `- url: ${entry.canonical_url}` : null,
    '',
    'Human must review and file into `kb/` with full frontmatter if durable.',
    'This file is staging only; apply-auto remains DISABLED.',
    '',
  ].filter((line) => line !== null).join('\n')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body, { encoding: 'utf8', mode: 0o600 })
  return {
    ok: true,
    path: relative,
    absolute_path: target,
    wrote_kb: false,
    wrote_ref: false,
  }
}

export function listXDropFiles(root) {
  const dir = path.join(root, ATTENTION_DROP_X_RELATIVE)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson') || name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
    .sort()
}

export function appendAttentionWorkflowEvent(root, detail) {
  const dir = path.join(root, '.workflow', 'autonomous-attention-scheduling')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'events.jsonl')
  const payload = {
    schema_version: 2,
    ts: new Date().toISOString(),
    event: 'attention_daily_run',
    run: 'autonomous-attention-scheduling',
    detail: {
      ...detail,
      // never allow secret-looking keys to be merged by callers casually
    },
  }
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' })
  return file
}
