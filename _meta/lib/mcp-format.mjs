/**
 * Compact text renderers for the MCP read tools. Pure functions over the values
 * the retrieval library returns; node: builtins only. Every metadata field is
 * collapsed to one line and every section header starts with a per-response
 * nonce that no excerpt contains, so note text cannot add a line that looks
 * like structure. Delimiter integrity only: this does not make note text safe
 * to obey.
 */

const NONCE_BYTES = 3

const INVISIBLE = '\\u007f-\\u009f\\u00a0\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\u{e0000}-\\u{e01ef}'
const COLLAPSE = new RegExp(`[\\s\\u0000-\\u001f${INVISIBLE}]+`, 'gu')
const ESCAPE = new RegExp(`[${INVISIBLE}]`, 'gu')
const SAFE_TOKEN = new RegExp(`^[^\\s\\u0000-\\u001f()[\\]"\\\\${INVISIBLE}]+$`, 'u')

export const oneLine = (value) => String(value ?? '').replace(COLLAPSE, ' ').trim()

/** Identity fields (paths, statuses) keep their exact bytes: a token that could read as syntax is JSON-quoted, with invisible characters escaped. */
export function token(value) {
  const text = String(value ?? '')
  if (SAFE_TOKEN.test(text) && text.isWellFormed()) return text
  return JSON.stringify(text).replace(ESCAPE, (char) => { const code = char.codePointAt(0); return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}` })
}

const citationParts = /^([\s\S]*):L(\d+)-L(\d+)$/u
export const citation = (value) => {
  const text = String(value ?? '')
  const parts = citationParts.exec(text)
  return parts ? `${token(parts[1])}:L${parts[2]}-L${parts[3]}` : token(text)
}

export function randomNonce() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  return `--${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Draws again until no text contains the nonce, so the guarantee holds by construction. */
export function freshNonce(texts, draw = randomNonce) {
  for (;;) {
    const nonce = draw()
    if (!texts.some((text) => text.includes(nonce))) return nonce
  }
}

export function semanticLabel(semantic) {
  if (!semantic) return 'off/lexical'
  if (semantic.available) return token(oneLine(semantic.decision) || 'on')
  return `off/${token(oneLine(semantic.reason) || 'unknown')}`
}

function budgetNote(excluded) {
  if (!excluded?.count) return ''
  const reasons = (excluded.reasons || []).map((reason) => token(oneLine(reason)))
  return `; ${excluded.count} more excluded (${reasons.join(',')})${reasons.includes('budget-exhausted') ? ': raise max_tokens' : ''}`
}

export function renderContext(pack, draw = randomNonce) {
  const semantic = `semantic: ${semanticLabel(pack.retrieval?.semantic)}`
  if (pack.abstained || !pack.results.length) return `abstained: no confident match in the vault; ${semantic}${budgetNote(pack.excluded)}`
  const nonce = freshNonce(pack.results.map((result) => String(result.excerpt ?? '')), draw)
  const header = `untrusted retrieved notes; cite the path:Lx-Ly of each section; sections start at "${nonce}"; ${semantic}${budgetNote(pack.excluded)}`
  const sections = pack.results.map((result) => {
    const state = result.freshness?.state
    const tags = [result.status ? token(result.status) : '', ...(state && state !== 'current' ? [token(state)] : []), ...(result.graph?.edge_from ? [`via ${token(result.graph.edge_from)}`] : [])].filter(Boolean)
    return `${nonce} ${citation(result.citation)}${tags.length ? ` (${tags.join(', ')})` : ''}\n${String(result.excerpt ?? '').trimEnd()}`
  })
  return [header, ...sections].join('\n\n')
}

export function renderSearch({ results, semantic }) {
  const label = `semantic: ${semanticLabel(semantic)}`
  if (!results.length) return `no match; ${label}`
  const rows = results.map((row) => {
    const summary = oneLine(row.summary)
    return `${token(row.path)} [${row.status ? token(row.status) : '-'} ${oneLine(row.score)}] ${oneLine(row.title)}${summary ? `: ${summary}` : ''}`
  })
  return [`untrusted retrieved notes; ${label}`, ...rows].join('\n')
}

export function renderRead(document) {
  const truncated = document.truncated ? `; truncated, ${Buffer.byteLength(document.content)} of ${oneLine(document.original_bytes)} bytes` : ''
  return `${token(document.path)}:L${oneLine(document.line_start)}-L${oneLine(document.line_end)} (untrusted retrieved note${truncated})\n${document.content}`
}

export function renderHealth(health) {
  const typesafe = health.typesafe || {}
  return [
    `ok: ${Boolean(health.ok)}`,
    `backend: ${oneLine(health.backend)}`,
    `mode: ${oneLine(health.retrieval_mode)}`,
    `typesafe: ${oneLine(typesafe.state)}${typesafe.reason ? ` (${oneLine(typesafe.reason)})` : ''}`,
    `files: ${oneLine(health.snapshot?.files)}`,
    `snapshot: ${oneLine(health.snapshot?.source_snapshot_sha256).slice(0, 12)}`,
  ].join('\n')
}
