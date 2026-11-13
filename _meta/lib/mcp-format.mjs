/**
 * Compact text renderers for the MCP read tools. Pure functions over the values
 * the retrieval library returns; node: builtins only. Every metadata field is
 * collapsed to one line and every section header starts with a per-response
 * nonce that no excerpt contains, so note text cannot add a line that looks
 * like structure. Delimiter integrity only: this does not make note text safe
 * to obey.
 */

const NONCE_BYTES = 3

export const oneLine = (value) => String(value ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f\u00a0\u2028\u2029]+/g, ' ').trim()

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
  if (semantic?.available) return oneLine(semantic.decision) || 'on'
  return `off/${oneLine(semantic?.reason) || 'unknown'}`
}

function budgetNote(excluded) {
  if (!excluded?.count) return ''
  return `; ${excluded.count} more excluded (${(excluded.reasons || []).map(oneLine).join(',')}): raise max_tokens`
}

export function renderContext(pack, draw = randomNonce) {
  const semantic = `semantic: ${semanticLabel(pack.retrieval?.semantic)}`
  if (pack.abstained || !pack.results.length) return `abstained: no confident match in the vault; ${semantic}${budgetNote(pack.excluded)}`
  const nonce = freshNonce(pack.results.map((result) => String(result.excerpt ?? '')), draw)
  const header = `untrusted retrieved notes; cite the path:Lx-Ly of each section; sections start at "${nonce}"; ${semantic}${budgetNote(pack.excluded)}`
  const sections = pack.results.map((result) => {
    const state = result.freshness?.state
    const tags = [oneLine(result.status), ...(state && state !== 'current' ? [oneLine(state)] : []), ...(result.graph?.edge_from ? [`via ${oneLine(result.graph.edge_from)}`] : [])]
    return `${nonce} ${oneLine(result.citation)} (${tags.join(', ')})\n${String(result.excerpt ?? '').trimEnd()}`
  })
  return [header, ...sections].join('\n\n')
}

export function renderSearch({ results, semantic }) {
  const label = `semantic: ${semanticLabel(semantic)}`
  if (!results.length) return `no match; ${label}`
  const rows = results.map((row) => {
    const summary = oneLine(row.summary)
    return `${oneLine(row.path)} [${oneLine(row.status)} ${oneLine(row.score)}] ${oneLine(row.title)}${summary ? `: ${summary}` : ''}`
  })
  return [`untrusted retrieved notes; ${label}`, ...rows].join('\n')
}

export function renderRead(document) {
  const truncated = document.truncated ? `; truncated, ${Buffer.byteLength(document.content)} of ${oneLine(document.original_bytes)} bytes` : ''
  return `${oneLine(document.path)}:L${oneLine(document.line_start)}-L${oneLine(document.line_end)} (untrusted retrieved note${truncated})\n${document.content}`
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
