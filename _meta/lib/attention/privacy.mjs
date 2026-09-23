const SENSITIVE_QUERY = /(?:^|[_-])(token|secret|password|pass|auth|code|session|key|jwt|cookie)(?:$|[_-])/i
const PROMPT_INJECTION = /(?:ignore|disregard) (?:all )?(?:previous|prior|system) instructions|system prompt|execute (?:this|the following) command/i
const SECRET_TEXT = /(?:\bgh[opusr]_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const PII_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[ .-]?){9,14}\d\b/i

export function isUnsafeText(value) {
  const text = String(value || '')
  if (PROMPT_INJECTION.test(text)) return 'prompt-injection'
  if (SECRET_TEXT.test(text)) return 'secret-pattern'
  if (PII_TEXT.test(text)) return 'pii-pattern'
  return null
}

export function safeText(value, limit = 240) {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact || compact.length > limit || isUnsafeText(compact)) return null
  return compact
}

function sourceUrl(url, source) {
  if (source === 'youtube-liked') {
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname.toLowerCase())) return null
    const id = url.searchParams.get('v') || (url.hostname === 'youtu.be' ? url.pathname.slice(1) : '')
    if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return null
    return `https://www.youtube.com/watch?v=${id}`
  }
  if (source === 'x-bookmarks') {
    if (!['x.com', 'www.x.com'].includes(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/)
    if (!match) return null
    return `https://x.com/${match[1]}/status/${match[2]}`
  }
  if (source === 'reddit-saved' || source === 'reddit-upvoted') {
    if (!['reddit.com', 'www.reddit.com', 'old.reddit.com'].includes(url.hostname.toLowerCase())) return null
    return `https://www.reddit.com${url.pathname.replace(/\/+$/, '')}`
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}`
}

export function canonicalizeUrl(raw, source) {
  if (typeof raw !== 'string' || raw.length > 4096) return { ok: false, reason: 'invalid-url' }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { ok: false, reason: 'unsafe-url' }
  for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY.test(key)) return { ok: false, reason: 'sensitive-query' }
  const canonical = sourceUrl(url, source)
  return canonical ? { ok: true, canonical_url: canonical } : { ok: false, reason: 'unsupported-url' }
}

export function assertNoForbiddenFields(value) {
  const forbidden = new Set(['raw_payload', 'authorization', 'cookie', 'token', 'account_id', 'upstream_id', 'excerpt', 'description'])
  const found = Object.keys(value || {}).filter((key) => forbidden.has(key))
  if (found.length) throw new Error(`attention candidate contains forbidden field(s): ${found.join(', ')}`)
}
