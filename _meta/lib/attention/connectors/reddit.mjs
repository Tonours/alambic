import { assertSource } from '../schema.mjs'
import { collectPages } from './pagination.mjs'

export function createRedditConnector(source, client) {
  if (!['reddit-saved', 'reddit-upvoted'].includes(source)) throw new Error('invalid Reddit attention source')
  assertSource(source)
  if (!client || typeof client.list !== 'function') throw new Error(`${source} connector requires list client`)
  return {
    source,
    async collect({ limit }) {
      return collectPages({
        source,
        limit,
        fetchPage: (page) => client.list({ source, ...page }),
        map: (item, required, optional) => ({
          id: required(item.id, 'id'),
          url: required(item.url || item.permalink, 'url'),
          title: required(item.title, 'title'),
          text: optional(item.selftext),
          occurred_at: item.occurred_at,
        }),
      })
    },
  }
}
