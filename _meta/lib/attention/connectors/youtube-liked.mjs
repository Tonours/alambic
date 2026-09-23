import { assertSource } from '../schema.mjs'
import { collectPages } from './pagination.mjs'

export function createYouTubeLikedConnector(client) {
  const source = 'youtube-liked'
  assertSource(source)
  if (!client || typeof client.listLiked !== 'function') throw new Error('youtube-liked connector requires listLiked client')
  return {
    source,
    capability_status: client.mode === 'live' ? 'live-green' : 'fixture-green',
    capability_evidence: client.mode === 'live' ? 'youtube data api read only dry run completed' : 'local injected fixture adapter completed not live-provider evidence',
    async collect({ limit }) {
      return collectPages({
        source,
        limit,
        fetchPage: (page) => client.listLiked(page),
        map: (item, required, optional) => {
          // Prefer description for technical classification; fall back to channel title only.
          const description = typeof item.description === 'string' ? item.description.trim() : ''
          const channel = typeof item.channel_title === 'string' ? item.channel_title.trim() : ''
          const text = description || channel || undefined
          return {
            id: required(item.id, 'id'),
            url: `https://www.youtube.com/watch?v=${required(item.video_id || item.id, 'video_id')}`,
            title: required(item.title, 'title'),
            text: text === undefined ? undefined : text,
            occurred_at: item.liked_at,
          }
        },
      })
    },
  }
}
