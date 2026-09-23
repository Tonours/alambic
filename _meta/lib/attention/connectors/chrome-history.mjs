import { assertSource } from '../schema.mjs'
import { collectPages } from './pagination.mjs'

export function createChromeHistoryConnector(client) {
  const source = 'chrome-history'
  assertSource(source)
  const probe = client?.probeMultiDeviceVisits || client?.probeSyncedAndroidVisits
  if (!client || typeof probe !== 'function' || typeof client.listVisits !== 'function') {
    throw new Error('chrome-history connector requires multi-device provenance probe and listVisits clients')
  }
  return {
    source,
    capability_status: client.mode === 'live' ? 'live-green' : 'fixture-green',
    capability_evidence: client.mode === 'live'
      ? 'chrome multi-device foreign originator visits excluding local cache_guid'
      : 'local injected fixture adapter completed not live-provider evidence',
    async collect({ limit }) {
      const provenance = await probe.call(client)
      if (!provenance?.supported) {
        return {
          items: [],
          exhausted: true,
          unsupported: provenance?.reason || provenance?.evidence || 'multi-device-history-provenance-unproven',
        }
      }
      return collectPages({
        source,
        limit,
        fetchPage: (page) => client.listVisits(page),
        map: (item, required) => ({
          id: required(item.id, 'id'),
          url: required(item.url, 'url'),
          title: required(item.title, 'title'),
          occurred_at: item.visited_at,
        }),
      })
    },
  }
}
