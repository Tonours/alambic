import crypto from 'node:crypto'
import http from 'node:http'
import { spawnSync } from 'node:child_process'

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function copyToClipboard(value) {
  const result = spawnSync('pbcopy', [], { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] })
  if (result.status !== 0) throw new Error('macOS clipboard is unavailable for OAuth handoff')
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url')
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function exchangeCode({ code, redirectUri, verifier, client, fetchImpl }) {
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    grant_type: 'authorization_code',
  })
  const response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (!response.ok) throw new Error('youtube OAuth code exchange failed')
  const payload = await response.json()
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token) throw new Error('youtube OAuth did not return a refresh token')
  return payload.refresh_token
}

export async function authorizeYouTube({ client, output, fetchImpl = globalThis.fetch }) {
  if (!client?.client_id || !client?.client_secret) throw new Error('youtube OAuth client is unavailable from the local credential provider')
  if (typeof fetchImpl !== 'function') throw new Error('youtube OAuth fetch is unavailable')
  const state = crypto.randomBytes(32).toString('base64url')
  const verifier = crypto.randomBytes(48).toString('base64url')
  let complete
  const completed = new Promise((resolve, reject) => { complete = { resolve, reject } })
  const server = http.createServer((request, response) => {
    const current = new URL(request.url || '/', 'http://127.0.0.1')
    if (current.pathname !== '/oauth/callback' || current.searchParams.get('state') !== state || !current.searchParams.get('code')) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('OAuth verification failed. You may close this tab.')
      complete.reject(new Error('youtube OAuth callback validation failed'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('YouTube authorization received. Return to Codex.')
    complete.resolve({ code: current.searchParams.get('code'), redirectUri: `http://127.0.0.1:${server.address().port}/oauth/callback` })
  })

  try {
    await listen(server)
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })
    copyToClipboard(`${AUTHORIZE_ENDPOINT}?${query}`)
    output({ source: 'youtube-liked', status: 'authorization-url-copied', scope: 'youtube.readonly' }, true)
    const { code, redirectUri: callbackUri } = await completed
    const refreshToken = await exchangeCode({ code, redirectUri: callbackUri, verifier, client, fetchImpl })
    copyToClipboard(refreshToken)
    output({ source: 'youtube-liked', status: 'refresh-token-copied', storage: 'clipboard-only' }, true)
  } finally {
    server.close()
  }
}
