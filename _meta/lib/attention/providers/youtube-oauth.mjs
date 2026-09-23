const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos'
const REQUEST_TIMEOUT_MS = 15_000

function requireString(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`youtube OAuth ${field} is unavailable`)
  return value
}

async function jsonResponse(response, message) {
  if (!response?.ok) throw new Error(message)
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
  } catch {
    throw new Error(message)
  } finally {
    clearTimeout(timeout)
  }
}

export class YouTubeOAuthClient {
  constructor({ client_id, client_secret, refresh_token, fetchImpl = globalThis.fetch }) {
    this.clientId = requireString(client_id, 'client id')
    this.clientSecret = requireString(client_secret, 'client secret')
    this.refreshToken = requireString(refresh_token, 'refresh token')
    if (typeof fetchImpl !== 'function') throw new Error('youtube OAuth fetch is unavailable')
    this.fetch = fetchImpl
    this.mode = 'live'
  }

  async #accessToken() {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    })
    const payload = await jsonResponse(
      await request(this.fetch, TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 'youtube OAuth token refresh failed'),
      'youtube OAuth token refresh failed',
    )
    return requireString(payload.access_token, 'access token')
  }

  async listLiked({ limit, pageToken }) {
    const query = new URLSearchParams({ part: 'snippet', myRating: 'like', maxResults: String(limit) })
    if (pageToken) query.set('pageToken', pageToken)
    const token = await this.#accessToken()
    const payload = await jsonResponse(
      await request(this.fetch, `${VIDEOS_ENDPOINT}?${query}`, { headers: { authorization: `Bearer ${token}` } }, 'youtube liked videos request failed'),
      'youtube liked videos request failed',
    )
    if (!Array.isArray(payload.items)) throw new Error('youtube liked videos response is invalid')
    return {
      items: payload.items.map((item) => ({
        id: item?.id,
        video_id: item?.id,
        title: item?.snippet?.title,
        // Classification must use title + description; channel alone is not enough signal.
        description: typeof item?.snippet?.description === 'string' ? item.snippet.description : '',
        channel_title: item?.snippet?.channelTitle,
        liked_at: item?.snippet?.publishedAt,
      })),
      next_page_token: payload.nextPageToken,
    }
  }
}
