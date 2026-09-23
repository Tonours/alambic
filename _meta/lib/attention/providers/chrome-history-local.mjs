import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Chrome/WebKit epoch: microseconds since 1601-01-01 UTC
const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)

function chromeTimeToIso(chromeTime) {
  // visit_time is μs since 1601-01-01; may exceed Number.MAX_SAFE_INTEGER — use BigInt.
  try {
    const micros = typeof chromeTime === 'bigint' ? chromeTime : BigInt(String(chromeTime))
    if (micros <= 0n) return undefined
    const ms = WEBKIT_EPOCH_MS + Number(micros / 1000n)
    if (!Number.isFinite(ms)) return undefined
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

function defaultHistoryPath() {
  if (process.env.ALAMBIC_CHROME_HISTORY_PATH) return process.env.ALAMBIC_CHROME_HISTORY_PATH
  const profile = process.env.ALAMBIC_CHROME_PROFILE || 'Default'
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', profile, 'History')
}

function defaultPreferencesPath(historyPath) {
  if (process.env.ALAMBIC_CHROME_PREFERENCES_PATH) return process.env.ALAMBIC_CHROME_PREFERENCES_PATH
  return path.join(path.dirname(historyPath), 'Preferences')
}

/**
 * Resolve this profile's Chrome Sync cache_guid (local device).
 * Returns null if missing — multi-device filter cannot run safely without it.
 */
export function readLocalCacheGuid(preferencesPath) {
  try {
    const prefs = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
    const transport = prefs?.sync?.transport_data_per_account
    if (transport && typeof transport === 'object') {
      for (const entry of Object.values(transport)) {
        const guid = entry?.['sync.cache_guid'] || entry?.sync_cache_guid
        if (typeof guid === 'string' && guid) return guid
      }
    }
    const local = prefs?.sync?.local_device_guids_with_timestamp
    if (Array.isArray(local) && local[0]?.cache_guid) return String(local[0].cache_guid)
  } catch {
    return null
  }
  return null
}

function openHistoryCopy(historyPath) {
  if (!fs.existsSync(historyPath)) throw new Error('chrome history database is missing')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-chrome-history-'))
  const copyPath = path.join(dir, 'History')
  fs.copyFileSync(historyPath, copyPath)
  // Also copy -wal/-shm if present so we see a consistent snapshot when possible
  for (const suffix of ['-wal', '-shm']) {
    const side = `${historyPath}${suffix}`
    if (fs.existsSync(side)) {
      try { fs.copyFileSync(side, `${copyPath}${suffix}`) } catch { /* ignore lock races */ }
    }
  }
  const db = new DatabaseSync(copyPath, { readOnly: true })
  return {
    db,
    cleanup() {
      try { db.close() } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

/**
 * Local Chrome History multi-device client.
 * Collects only visits with a non-empty originator_cache_guid different from this
 * profile's sync cache_guid (foreign/synced devices). Does not claim Android OS
 * labels — only multi-device originators.
 * Never logs URLs or titles.
 */
export class ChromeHistoryLocalClient {
  constructor({
    historyPath = defaultHistoryPath(),
    preferencesPath = null,
  } = {}) {
    this.historyPath = historyPath
    this.preferencesPath = preferencesPath || defaultPreferencesPath(historyPath)
    this.mode = 'live'
  }

  /**
   * Compat name used by chrome-history connector.
   * "Android" in the old name is historical; evidence is multi-device originators.
   */
  async probeSyncedAndroidVisits() {
    return this.probeMultiDeviceVisits()
  }

  async probeMultiDeviceVisits() {
    const localGuid = readLocalCacheGuid(this.preferencesPath)
    if (!localGuid) {
      return {
        supported: false,
        reason: 'local-cache-guid-unavailable',
        evidence: 'chrome Preferences sync.cache_guid not found',
      }
    }
    let handle
    try {
      handle = openHistoryCopy(this.historyPath)
      const row = handle.db.prepare(`
        SELECT
          COUNT(*) AS foreign_visits,
          COUNT(DISTINCT originator_cache_guid) AS foreign_originators
        FROM visits
        WHERE originator_cache_guid IS NOT NULL
          AND originator_cache_guid != ''
          AND originator_cache_guid != ?
      `).get(localGuid)
      const foreignVisits = Number(row?.foreign_visits || 0)
      const foreignOriginators = Number(row?.foreign_originators || 0)
      if (foreignVisits <= 0 || foreignOriginators <= 0) {
        return {
          supported: false,
          reason: 'no-foreign-originators',
          evidence: 'no multi-device originator_cache_guid visits distinct from local cache_guid',
          foreign_visits: 0,
          foreign_originators: 0,
        }
      }
      return {
        supported: true,
        reason: 'multi-device-originators',
        evidence: `foreign_originators ${foreignOriginators}; foreign_visits ${foreignVisits}; local_guid resolved`,
        foreign_visits: foreignVisits,
        foreign_originators: foreignOriginators,
      }
    } catch (error) {
      return {
        supported: false,
        reason: 'history-unreadable',
        evidence: `chrome history probe failed: ${error?.message || 'unknown'}`,
      }
    } finally {
      handle?.cleanup()
    }
  }

  async listVisits({ limit, pageToken }) {
    // Single-page local scan (no remote pagination tokens stored).
    if (pageToken) return { items: [], next_page_token: undefined }
    const localGuid = readLocalCacheGuid(this.preferencesPath)
    if (!localGuid) throw new Error('chrome local cache_guid unavailable')
    const max = Math.min(Math.max(1, Number(limit) || 50), 500)
    let handle
    try {
      handle = openHistoryCopy(this.historyPath)
      const rows = handle.db.prepare(`
        SELECT
          v.id AS visit_id,
          CAST(v.visit_time AS TEXT) AS visit_time,
          u.url AS url,
          u.title AS title
        FROM visits v
        JOIN urls u ON u.id = v.url
        WHERE v.originator_cache_guid IS NOT NULL
          AND v.originator_cache_guid != ''
          AND v.originator_cache_guid != ?
          AND u.url IS NOT NULL
          AND u.url != ''
        ORDER BY v.visit_time DESC
        LIMIT ?
      `).all(localGuid, max)
      return {
        items: rows.map((row) => ({
          id: `chrome-${row.visit_id}`,
          url: row.url,
          title: row.title || row.url,
          visited_at: chromeTimeToIso(row.visit_time),
        })),
        next_page_token: undefined,
      }
    } finally {
      handle?.cleanup()
    }
  }
}
