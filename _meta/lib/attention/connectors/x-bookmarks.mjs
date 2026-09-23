import { assertSource } from '../schema.mjs'
import { collectPages } from './pagination.mjs'

export function createXBookmarksConnector(client) {
  const source = 'x-bookmarks'
  assertSource(source)
  if (!client || typeof client.listBookmarks !== 'function') throw new Error('x-bookmarks connector requires listBookmarks client')
  return {
    source,
    capability_status: client.mode === 'live' ? 'live-green' : 'fixture-green',
    capability_evidence: client.mode === 'live'
      ? 'x api v2 bookmarks read-only user-context completed'
      : 'local injected fixture adapter completed not live-provider evidence',
    async collect({ limit }) {
      return collectPages({
        source,
        limit,
        fetchPage: (page) => client.listBookmarks(page),
        map: (item, required, optional) => {
          const id = required(item.id, 'id')
          return {
            id,
            url: item.url ? required(item.url, 'url') : `https://x.com/${required(item.author_handle, 'author_handle')}/status/${id}`,
            title: required(item.title || item.text, 'title'),
            text: optional(item.text),
            occurred_at: item.bookmarked_at,
          }
        },
      })
    },
  }
}
