function requiredString(value, field) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`attention provider item is missing ${field}`)
  const result = String(value)
  if (!result) throw new Error(`attention provider item has empty ${field}`)
  return result
}

export function optionalString(value) {
  if (value === undefined || value === null) return undefined
  return requiredString(value, 'optional field')
}

// Page tokens never cross this boundary: they exist only in this stack frame.
export async function collectPages({ source, limit, fetchPage, map }) {
  const items = []
  const seenTokens = new Set()
  let pageToken
  while (items.length < limit) {
    const response = await fetchPage({ limit: limit - items.length, pageToken })
    if (!response || !Array.isArray(response.items)) throw new Error(`${source} response must contain items`)
    for (const item of response.items) {
      if (items.length >= limit) break
      items.push(map(item, requiredString, optionalString))
    }
    const next = response.next_page_token
    if (next === undefined || next === null || next === '') return { items, exhausted: true }
    if (typeof next !== 'string' || seenTokens.has(next)) throw new Error(`${source} pagination token is invalid`)
    seenTokens.add(next)
    pageToken = next
  }
  return { items, exhausted: false }
}
