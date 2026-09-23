import { isUnsafeText, safeText } from './privacy.mjs'

const TOPICS = [
  ['ai-agents', /\b(llm|agent|openai|anthropic|machine learning)\b/i],
  ['software-development', /\b(javascript|typescript|react|tanstack|adonis|node|python|rust|golang|programming|developer|frontend|backend|api)\b/i],
  ['infrastructure', /\b(docker|kubernetes|terraform|devops|infrastructure|cloud|aws|gcp|azure)\b/i],
  ['security', /\b(security|cybersecurity|oauth|auth)\b/i],
  ['knowledge-systems', /\b(obsidian|knowledge management)\b/i],
]

function matchesDomain(host, configured) {
  return configured.some((domain) => {
    const value = domain.toLowerCase()
    if (value.endsWith('.')) return host.startsWith(value)
    return host === value || host.endsWith(`.${value}`)
  })
}

/** Longer cap for descriptions (e.g. YouTube snippet) used only at classify time — not stored wholesale. */
const CLASSIFY_TEXT_LIMIT = 2500

/**
 * Prepare optional body (YouTube description, etc.) for term scoring.
 * Strips URLs and long digit runs that false-trigger PII; never hard-rejects the item for body noise.
 */
function bodyForClassify(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const cleaned = value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d{11,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CLASSIFY_TEXT_LIMIT)
  if (!cleaned) return ''
  // If still looks secret-like after strip, drop body and keep title-only scoring.
  if (isUnsafeText(cleaned)) return ''
  return cleaned
}

function classifyBody(raw) {
  const title = safeText(raw?.title)
  if (!title || isUnsafeText(raw?.title)) return { ok: false, reason: 'unsafe-content' }
  // Prefer title + description (YouTube). Empty/noisy description → title-only, not reject.
  const body = bodyForClassify(raw?.text)
  return { ok: true, title, body }
}

export function classifyTechnical(raw, canonicalUrl, policy) {
  const parsed = classifyBody(raw)
  if (!parsed.ok) return rejected(parsed.reason)

  let host
  try {
    host = new URL(canonicalUrl).hostname.toLowerCase()
  } catch {
    return rejected('invalid-url')
  }
  if (matchesDomain(host, policy.classifier.blocked_domains)) return rejected('blocked-domain')

  const haystack = `${parsed.title} ${parsed.body}`.toLowerCase()
  const technicalTerms = policy.classifier.technical_terms.filter((term) => haystack.includes(term.toLowerCase()))
  const negativeTerms = policy.classifier.negative_terms.filter((term) => haystack.includes(term.toLowerCase()))
  const domainMatch = matchesDomain(host, policy.classifier.technical_domains)
  if (negativeTerms.length) return rejected('non-technical')
  const score = (domainMatch ? 3 : 0) + Math.min(4, technicalTerms.length)
  if (score < policy.classifier.minimum_score) return rejected(negativeTerms.length ? 'non-technical' : 'insufficient-technical-signal')

  const topics = TOPICS.filter(([, expression]) => expression.test(haystack)).map(([topic]) => topic)
  return {
    accepted: true,
    reason_codes: [domainMatch ? 'technical-domain' : 'technical-terms', ...technicalTerms.slice(0, 3).map((term) => `term:${term}`)],
    topics,
  }
}

function rejected(reason) {
  return { accepted: false, reason_codes: [reason], topics: [] }
}
