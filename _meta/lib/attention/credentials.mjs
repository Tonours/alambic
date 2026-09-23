import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { attentionKeychainAllowed } from './crypto.mjs'
import { assertSource } from './schema.mjs'

const READ_ONLY_SCOPES = Object.freeze({
  'youtube-liked': ['https://www.googleapis.com/auth/youtube.readonly'],
  'reddit-saved': ['history', 'read'],
  'reddit-upvoted': ['history', 'read'],
  'x-bookmarks': ['bookmark.read', 'tweet.read', 'users.read'],
  'chrome-history': [],
})

function scopeFingerprint(scopes) {
  return crypto.createHash('sha256').update([...scopes].sort().join('\n')).digest('hex')
}

export function requiredScopes(source) {
  assertSource(source)
  return READ_ONLY_SCOPES[source]
}

export function validateCredentialMetadata(source, metadata) {
  const required = requiredScopes(source)
  if (!metadata || typeof metadata !== 'object') return { ok: false, reason: 'credential-unavailable' }
  if (typeof metadata.account_alias !== 'string' || !metadata.account_alias || metadata.account_alias.length > 80) return { ok: false, reason: 'account-alias-missing' }
  if (!Array.isArray(metadata.scopes) || metadata.scopes.some((scope) => typeof scope !== 'string')) return { ok: false, reason: 'scope-metadata-invalid' }
  if (metadata.scopes.some((scope) => /(^|[.:/])(write|manage|delete)([.:/]|$)|(?:like|bookmark|vote|comment|post)[._-]write\b/i.test(scope))) return { ok: false, reason: 'write-scope-refused' }
  if (required.some((scope) => !metadata.scopes.includes(scope))) return { ok: false, reason: 'required-read-scope-missing' }
  return { ok: true, account_alias: metadata.account_alias, scope_fingerprint: scopeFingerprint(metadata.scopes) }
}

// This interface deliberately returns no credential material to default commands.
// A platform adapter may implement it after the human OAuth checkpoint.
export class UnavailableCredentialProvider {
  async inspect(source) {
    assertSource(source)
    return null
  }

  async client() {
    return null
  }

  async forget() {}
}

export class MemoryCredentialProvider {
  #entries = new Map()

  set(source, metadata, client) {
    assertSource(source)
    this.#entries.set(source, { metadata, client })
  }

  async inspect(source) {
    return this.#entries.get(source)?.metadata || null
  }

  async client(source) {
    return this.#entries.get(source)?.client || null
  }

  async forget(source) {
    this.#entries.delete(source)
  }
}

// Primary: OAuth material from local environment (e.g. ~/.zshrc).
// Optional Keychain fallback only when ALAMBIC_ATTENTION_ALLOW_KEYCHAIN=1.
// Secrets stay in process memory; never printed by this CLI.
export class MacOSKeychainCredentialProvider {
  constructor({
    account = process.env.ALAMBIC_ATTENTION_KEYCHAIN_ACCOUNT || 'alambic.attention.v1',
    run = execFileSync,
    allowKeychain = attentionKeychainAllowed(),
  } = {}) {
    this.account = account
    this.run = run
    this.allowKeychain = allowKeychain
  }

  #readItem(name) {
    if (!this.allowKeychain) return null
    try {
      return String(this.run('security', ['find-generic-password', '-s', name, '-a', this.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null
    } catch {
      return null
    }
  }

  #read(source) {
    assertSource(source)
    if (source === 'youtube-liked') {
      const clientId = process.env.ALAMBIC_YOUTUBE_CLIENT_ID || this.#readItem(`oauth-client-id.${source}`)
      const clientSecret = process.env.ALAMBIC_YOUTUBE_CLIENT_SECRET || this.#readItem(`oauth-client-secret.${source}`)
      if (!clientId || !clientSecret) return null
      const refreshToken = process.env.ALAMBIC_YOUTUBE_REFRESH_TOKEN || this.#readItem(`oauth-refresh-token.${source}`)
      return {
        metadata: { account_alias: 'youtube-primary', scopes: requiredScopes(source) },
        client: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken },
      }
    }
    if (source === 'x-bookmarks') {
      // X API v2 user-context: OAuth 2.0 refresh/bearer OR OAuth 1.0a token pair.
      const clientId = process.env.ALAMBIC_X_CLIENT_ID || this.#readItem(`oauth-client-id.${source}`)
      const clientSecret = process.env.ALAMBIC_X_CLIENT_SECRET || this.#readItem(`oauth-client-secret.${source}`) || null
      const refreshToken = process.env.ALAMBIC_X_REFRESH_TOKEN || this.#readItem(`oauth-refresh-token.${source}`) || null
      const accessToken = process.env.ALAMBIC_X_ACCESS_TOKEN || this.#readItem(`oauth-access-token.${source}`) || null
      const accessTokenSecret = process.env.ALAMBIC_X_ACCESS_TOKEN_SECRET || this.#readItem(`oauth-access-token-secret.${source}`) || null
      const bearerToken = process.env.ALAMBIC_X_BEARER_TOKEN || null
      const apiKey = process.env.ALAMBIC_X_API_KEY || null
      const apiSecret = process.env.ALAMBIC_X_API_SECRET || null
      const oauth1Ready = Boolean(accessToken && accessTokenSecret && (apiKey || clientId) && (apiSecret || clientSecret))
      const oauth2Ready = Boolean(refreshToken && clientId) || Boolean(bearerToken) || Boolean(accessToken && !accessTokenSecret)
      if (!oauth1Ready && !oauth2Ready) return null
      return {
        metadata: { account_alias: 'x-primary', scopes: requiredScopes(source) },
        client: {
          client_id: clientId || null,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          access_token: accessToken,
          access_token_secret: accessTokenSecret,
          bearer_token: bearerToken,
          api_key: apiKey,
          api_secret: apiSecret,
        },
      }
    }
    return null
  }

  async inspect(source) {
    return this.#read(source)?.metadata || null
  }

  async client(source) {
    return this.#read(source)?.client || null
  }

  async forget(source) {
    assertSource(source)
    // Env-backed secrets are removed by the human from ~/.zshrc; Keychain only when enabled.
    if (!this.allowKeychain) return
    try {
      this.run('security', ['delete-generic-password', '-s', `oauth-refresh-token.${source}`, '-a', this.account], { stdio: 'ignore' })
    } catch {
      // A missing credential is already a safe disconnected state.
    }
  }
}

/** Known env var names for attention secrets (values never returned). */
export function attentionEnvVarNames() {
  return Object.freeze({
    youtube: [
      'ALAMBIC_YOUTUBE_CLIENT_ID',
      'ALAMBIC_YOUTUBE_CLIENT_SECRET',
      'ALAMBIC_YOUTUBE_REFRESH_TOKEN',
      'ALAMBIC_ATTENTION_YOUTUBE_LIKED_DATA_KEY',
      'ALAMBIC_ATTENTION_YOUTUBE_LIKED_HMAC_KEY',
    ],
    xBookmarksKeys: [
      'ALAMBIC_ATTENTION_X_BOOKMARKS_DATA_KEY',
      'ALAMBIC_ATTENTION_X_BOOKMARKS_HMAC_KEY',
    ],
    chromeHistoryKeys: [
      'ALAMBIC_ATTENTION_CHROME_HISTORY_DATA_KEY',
      'ALAMBIC_ATTENTION_CHROME_HISTORY_HMAC_KEY',
    ],
    xBookmarksOauth: [
      'ALAMBIC_X_CLIENT_ID',
      'ALAMBIC_X_CLIENT_SECRET',
      'ALAMBIC_X_REFRESH_TOKEN',
      'ALAMBIC_X_ACCESS_TOKEN',
      'ALAMBIC_X_ACCESS_TOKEN_SECRET',
      'ALAMBIC_X_BEARER_TOKEN',
      'ALAMBIC_X_API_KEY',
      'ALAMBIC_X_API_SECRET',
    ],
    policy: [
      'ALAMBIC_ATTENTION_ALLOW_KEYCHAIN',
    ],
  })
}

/**
 * Content-free presence map for env-backed secrets.
 * Never includes secret values — only set/unset booleans.
 */
export function inspectAttentionEnv(env = process.env) {
  const names = attentionEnvVarNames()
  const present = (name) => Boolean(env[name] && String(env[name]).trim())
  const youtube = Object.fromEntries(names.youtube.map((name) => [name, present(name)]))
  const xKeys = Object.fromEntries(names.xBookmarksKeys.map((name) => [name, present(name)]))
  const xOauth = Object.fromEntries(names.xBookmarksOauth.map((name) => [name, present(name)]))
  const chromeKeys = Object.fromEntries(names.chromeHistoryKeys.map((name) => [name, present(name)]))
  const oauth1Ready = present('ALAMBIC_X_ACCESS_TOKEN')
    && present('ALAMBIC_X_ACCESS_TOKEN_SECRET')
    && (present('ALAMBIC_X_API_KEY') || present('ALAMBIC_X_CLIENT_ID'))
    && (present('ALAMBIC_X_API_SECRET') || present('ALAMBIC_X_CLIENT_SECRET'))
  const xApiReady = oauth1Ready
    || (present('ALAMBIC_X_CLIENT_ID') && present('ALAMBIC_X_REFRESH_TOKEN'))
    || present('ALAMBIC_X_BEARER_TOKEN')
    || (present('ALAMBIC_X_ACCESS_TOKEN') && !present('ALAMBIC_X_ACCESS_TOKEN_SECRET'))
  return {
    backend: attentionKeychainAllowed(env) ? 'env-then-keychain' : 'env-only',
    allow_keychain: attentionKeychainAllowed(env),
    youtube,
    x_bookmarks_keys: xKeys,
    x_bookmarks_oauth: xOauth,
    chrome_history_keys: chromeKeys,
    // backward-compatible alias used by existing CLI formatters
    x_bookmarks: { ...xKeys, ...xOauth },
    youtube_ready: names.youtube.every((name) => present(name)),
    x_bookmarks_keys_ready: names.xBookmarksKeys.every((name) => present(name)),
    x_bookmarks_api_ready: xApiReady && names.xBookmarksKeys.every((name) => present(name)),
    chrome_history_keys_ready: names.chromeHistoryKeys.every((name) => present(name)),
  }
}
