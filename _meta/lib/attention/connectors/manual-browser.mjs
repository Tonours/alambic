import { canonicalizeUrl } from '../privacy.mjs'
import { assertSource, validateRawEvent } from '../schema.mjs'

const MANUAL_SOURCES = new Set(['x-bookmarks', 'reddit-saved'])
const MAX_EVENTS = 100
export const MANUAL_BROWSER_MAX_INPUT_BYTES = 256 * 1024
const EVENT_FIELDS = new Set(['id', 'url', 'title', 'text', 'occurred_at'])

function assertManualSource(source) {
  assertSource(source)
  if (!MANUAL_SOURCES.has(source)) throw new Error(`manual browser ingest is unsupported for ${source}`)
}

function assertPermalink(source, url) {
  const canonical = canonicalizeUrl(url, source)
  if (!canonical.ok) throw new Error(`manual browser event has invalid ${source} URL`)
  const parsed = new URL(canonical.canonical_url)
  if (source === 'x-bookmarks' && !/^\/[^/]+\/status\/\d+$/.test(parsed.pathname)) throw new Error('manual browser event requires an X post permalink')
  if (source === 'reddit-saved' && !/^\/r\/[^/]+\/comments\/[A-Za-z0-9_]+(?:\/|$)/.test(parsed.pathname)) throw new Error('manual browser event requires a Reddit post permalink')
  return canonical.canonical_url
}

export function parseManualBrowserEvents(source, input) {
  assertManualSource(source)
  if (typeof input !== 'string' || !input.trim()) throw new Error('manual browser ingest requires NDJSON stdin input')
  if (Buffer.byteLength(input, 'utf8') > MANUAL_BROWSER_MAX_INPUT_BYTES) throw new Error('manual browser ingest input is too large')
  const lines = input.split(/\r?\n/).filter(Boolean)
  if (!lines.length || lines.length > MAX_EVENTS) throw new Error(`manual browser ingest must contain 1-${MAX_EVENTS} events`)
  return lines.map((line, index) => {
    let item
    try {
      item = JSON.parse(line)
    } catch {
      throw new Error(`manual browser ingest line ${index + 1} is not valid JSON`)
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`manual browser ingest line ${index + 1} must be an object`)
    const unknown = Object.keys(item).filter((key) => !EVENT_FIELDS.has(key))
    if (unknown.length) throw new Error(`manual browser ingest line ${index + 1} has unknown field(s): ${unknown.join(', ')}`)
    validateRawEvent(item, source)
    return { ...item, url: assertPermalink(source, item.url) }
  })
}

export function createManualBrowserConnector(source, items, { live = false } = {}) {
  assertManualSource(source)
  if (!Array.isArray(items) || !items.length || items.length > MAX_EVENTS) throw new Error(`manual browser connector requires 1-${MAX_EVENTS} events`)
  const normalized = items.map((item) => {
    validateRawEvent(item, source)
    return { ...item, url: assertPermalink(source, item.url) }
  })
  return {
    source,
    ...(live ? { capability_status: 'live-green', capability_evidence: 'supervised manual browser ingest' } : {}),
    async collect({ limit }) {
      return { items: normalized.slice(0, Math.min(limit, MAX_EVENTS)), exhausted: normalized.length <= limit }
    },
  }
}
