import crypto from 'node:crypto'

const TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token'
const ME_ENDPOINT = 'https://api.x.com/2/users/me'
const BOOKMARKS_PATH = (id) => `https://api.x.com/2/users/${id}/bookmarks`
const REQUEST_TIMEOUT_MS = 15_000
const READ_SCOPES = Object.freeze(['bookmark.read', 'tweet.read', 'users.read'])

function requireString(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`x OAuth ${field} is unavailable`)
  return value
}

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function jsonResponse(response, message) {
  if (!response?.ok) {
    const status = response?.status ?? 'unknown'
    let detail = ''
    try {
      const body = await response.json()
      const title = typeof body?.title === 'string' ? body.title : ''
      const reason = typeof body?.detail === 'string' ? body.detail : (typeof body?.detail === 'object' ? '' : '')
      // Never include raw body dumps that might echo credentials; short titles only.
      detail = title ? `: ${title}` : ''
      if (reason && reason.length < 120 && !/token|secret|bearer|oauth_signature/i.test(reason)) {
        detail += ` — ${reason}`
      }
    } catch {
      // ignore unreadable error bodies
    }
    throw new Error(`${message} (http ${status}${detail})`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(message)
  }
}

async function request(fetchImpl, url, options, message) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${message} (timeout)`)
    throw new Error(message)
  } finally {
    clearTimeout(timeout)
  }
}

function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret }) {
  const parsed = new URL(url)
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  }
  const params = []
  for (const [key, value] of parsed.searchParams.entries()) params.push([key, value])
  for (const [key, value] of Object.entries(oauth)) params.push([key, value])
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  const paramString = params.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join('&')
  const baseUrl = `${parsed.origin}${parsed.pathname}`
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&')
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64')
  oauth.oauth_signature = signature
  const header = Object.keys(oauth)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauth[key])}"`)
    .join(', ')
  return `OAuth ${header}`
}

/**
 * X API v2 user-context client for bookmarks (read-only).
 * Supports:
 * - OAuth 2.0: refresh_token (+ client_id/secret) or bearer access_token
 * - OAuth 1.0a: access_token + access_token_secret + consumer key/secret
 * Never logs secrets.
 */
export class XOAuth2Client {
  constructor({
    client_id = null,
    client_secret = null,
    refresh_token = null,
    access_token = null,
    access_token_secret = null,
    bearer_token = null,
    api_key = null,
    api_secret = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.clientId = typeof client_id === 'string' && client_id ? client_id : null
    this.clientSecret = typeof client_secret === 'string' && client_secret ? client_secret : null
    this.refreshToken = typeof refresh_token === 'string' && refresh_token ? refresh_token : null
    this.staticAccessToken = typeof access_token === 'string' && access_token ? access_token : null
    this.accessTokenSecret = typeof access_token_secret === 'string' && access_token_secret ? access_token_secret : null
    this.bearerToken = typeof bearer_token === 'string' && bearer_token ? bearer_token : null
    // OAuth 1.0a consumer: explicit API key/secret, else fall back to client id/secret
    this.consumerKey = (typeof api_key === 'string' && api_key ? api_key : null) || this.clientId
    this.consumerSecret = (typeof api_secret === 'string' && api_secret ? api_secret : null) || this.clientSecret

    this.authMode = null
    // Prefer user-context auth for bookmarks. App-only bearer cannot call users/me or bookmarks.
    if (this.staticAccessToken && this.accessTokenSecret && this.consumerKey && this.consumerSecret) {
      this.authMode = 'oauth1'
    } else if (this.refreshToken && this.clientId) {
      this.authMode = 'oauth2-refresh'
    } else if (this.bearerToken) {
      this.authMode = 'oauth2-bearer'
      this.staticAccessToken = this.bearerToken
    } else if (this.staticAccessToken && !this.accessTokenSecret) {
      this.authMode = 'oauth2-bearer'
    } else {
      throw new Error('x OAuth credentials incomplete (need oauth1 token+secret+consumer, or oauth2 refresh, or bearer)')
    }
    if (typeof fetchImpl !== 'function') throw new Error('x OAuth fetch is unavailable')
    this.fetch = fetchImpl
    this.mode = 'live'
    this.#userId = null
    this.#cachedAccess = null
    this.#cachedAccessExpiresAt = 0
  }

  #userId
  #cachedAccess
  #cachedAccessExpiresAt

  static requiredScopes() {
    return READ_SCOPES
  }

  async #oauth2AccessToken() {
    const now = Date.now()
    if (this.#cachedAccess && now < this.#cachedAccessExpiresAt) return this.#cachedAccess
    if (this.authMode === 'oauth2-refresh') {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      })
      const headers = { 'content-type': 'application/x-www-form-urlencoded' }
      if (this.clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`
      }
      const payload = await jsonResponse(
        await request(this.fetch, TOKEN_ENDPOINT, { method: 'POST', headers, body }, 'x OAuth token refresh failed'),
        'x OAuth token refresh failed',
      )
      const token = requireString(payload.access_token, 'access token')
      const expiresIn = Number(payload.expires_in)
      this.#cachedAccess = token
      this.#cachedAccessExpiresAt = Number.isFinite(expiresIn) ? now + Math.max(30, expiresIn - 60) * 1000 : now + 14 * 60 * 1000
      if (typeof payload.refresh_token === 'string' && payload.refresh_token) this.refreshToken = payload.refresh_token
      return token
    }
    return requireString(this.staticAccessToken, 'access token')
  }

  #authHeaders(method, url) {
    if (this.authMode === 'oauth1') {
      return {
        authorization: oauth1Header({
          method,
          url,
          consumerKey: this.consumerKey,
          consumerSecret: this.consumerSecret,
          token: this.staticAccessToken,
          tokenSecret: this.accessTokenSecret,
        }),
      }
    }
    return null
  }

  async #meId() {
    if (this.#userId) return this.#userId
    // OAuth 1.0a user access tokens are often "userId-random"
    if (this.authMode === 'oauth1' && this.staticAccessToken.includes('-')) {
      const prefix = this.staticAccessToken.split('-')[0]
      if (/^\d+$/.test(prefix)) {
        this.#userId = prefix
        return this.#userId
      }
    }
    let headers
    if (this.authMode === 'oauth1') {
      headers = this.#authHeaders('GET', ME_ENDPOINT)
    } else {
      const token = await this.#oauth2AccessToken()
      headers = { authorization: `Bearer ${token}` }
    }
    const payload = await jsonResponse(
      await request(this.fetch, ME_ENDPOINT, { headers }, 'x users/me request failed'),
      'x users/me request failed',
    )
    this.#userId = requireString(payload?.data?.id, 'user id')
    return this.#userId
  }

  async listBookmarks({ limit, pageToken }) {
    const userId = await this.#meId()
    const maxResults = Math.min(Math.max(1, Number(limit) || 10), 100)
    const query = new URLSearchParams({
      max_results: String(maxResults),
      'tweet.fields': 'created_at,author_id,text',
      expansions: 'author_id',
      'user.fields': 'username',
    })
    if (pageToken) query.set('pagination_token', pageToken)
    const url = `${BOOKMARKS_PATH(userId)}?${query}`
    let headers
    if (this.authMode === 'oauth1') {
      headers = this.#authHeaders('GET', url)
    } else {
      const token = await this.#oauth2AccessToken()
      headers = { authorization: `Bearer ${token}` }
    }
    const payload = await jsonResponse(
      await request(this.fetch, url, { headers }, 'x bookmarks request failed'),
      'x bookmarks request failed',
    )
    const usersById = new Map()
    for (const user of payload?.includes?.users || []) {
      if (user?.id && user?.username) usersById.set(String(user.id), String(user.username))
    }
    const rows = Array.isArray(payload?.data) ? payload.data : []
    return {
      items: rows.map((tweet) => {
        const id = tweet?.id
        const authorId = tweet?.author_id
        const handle = (authorId && usersById.get(String(authorId))) || 'i'
        return {
          id,
          author_handle: handle,
          text: tweet?.text,
          title: tweet?.text,
          bookmarked_at: tweet?.created_at,
          url: id ? `https://x.com/${handle}/status/${id}` : undefined,
        }
      }),
      next_page_token: payload?.meta?.next_token || undefined,
    }
  }
}
