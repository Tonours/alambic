import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChromeHistoryConnector } from '../lib/attention/connectors/chrome-history.mjs'
import { createManualBrowserConnector, MANUAL_BROWSER_MAX_INPUT_BYTES, parseManualBrowserEvents } from '../lib/attention/connectors/manual-browser.mjs'
import { createRedditConnector } from '../lib/attention/connectors/reddit.mjs'
import { createXBookmarksConnector } from '../lib/attention/connectors/x-bookmarks.mjs'
import { createYouTubeLikedConnector } from '../lib/attention/connectors/youtube-liked.mjs'
import { decryptJson, environmentKeyName, keyHandle, MacOSKeychainKeyStore, MemoryKeyStore, randomKey } from '../lib/attention/crypto.mjs'
import { AttentionService } from '../lib/attention/pipeline.mjs'
import { createCandidatePipeline } from '../lib/attention/candidate-pipeline.mjs'
import { rankAttentionCandidates, scoreAttentionCandidate } from '../lib/attention/ranking.mjs'
import { canonicalizeUrl } from '../lib/attention/privacy.mjs'
import { readAttentionPolicy, ATTENTION_SOURCES, validateCandidate, validatePolicy } from '../lib/attention/schema.mjs'
import { AttentionState } from '../lib/attention/state.mjs'
import { MacOSKeychainCredentialProvider, validateCredentialMetadata } from '../lib/attention/credentials.mjs'
import { YouTubeOAuthClient } from '../lib/attention/providers/youtube-oauth.mjs'
import { XOAuth2Client } from '../lib/attention/providers/x-oauth.mjs'
import { runAttentionCommand } from '../lib/attention/index.mjs'
import { buildStageMarkdown, promoteCandidateDraft, stagePromoteCandidates } from '../lib/attention/stage.mjs'
import {
  buildAttentionSessionPack,
  buildClaimsFromEntries,
  promoteSuggest,
  suggestKbTarget,
  writeSynthesis,
} from '../lib/attention/compile.mjs'

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const fixtures = JSON.parse(fs.readFileSync(path.join(root, '_meta/tests/fixtures/attention/events.json'), 'utf8'))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-attention-test-'))
const stateHome = path.join(temporary, 'state')
const keys = new MemoryKeyStore()
const policy = readAttentionPolicy(root)
let clock = '2026-07-22T16:00:00.000Z'
const now = () => clock
let forgottenSource = null

function rankingCandidate({
  digest,
  source = 'youtube-liked',
  title,
  observedAt = '2026-08-15T07:00:00.000Z',
  expiresAt = '2026-08-22T07:00:00.000Z',
  reasonCodes = ['technical-terms', 'term:agent', 'term:graph engineering'],
  topics = ['agents', 'graph'],
} = {}) {
  return {
    digest,
    version: 1,
    source,
    event_type: source === 'youtube-liked' ? 'like' : source === 'x-bookmarks' ? 'bookmark' : 'visit',
    canonical_url: source === 'youtube-liked' ? `https://www.youtube.com/watch?v=${digest}` : `https://x.com/dev/status/${digest}`,
    title,
    observed_at: observedAt,
    expires_at: expiresAt,
    signal_weight: policy.sources[source].weight,
    reason_codes: reasonCodes,
    topics,
    confidence: 'deterministic',
  }
}

function provision(source) {
  keys.set(keyHandle(source, 'data'))
  keys.set(keyHandle(source, 'hmac'))
}

function connector(source, items, extras = {}) {
  return { source, async collect() { return { items, exhausted: true, ...extras } } }
}

function fakeKeychain(entries) {
  return (_command, args) => {
    const service = args[args.indexOf('-s') + 1]
    const account = args[args.indexOf('-a') + 1]
    const value = entries.get(`${service}:${account}`)
    if (!value) {
      const error = new Error('not found')
      error.status = 44
      throw error
    }
    return value
  }
}

try {
  assert.equal(policy.version, 2)
  assert.throws(
    () => validatePolicy({
      ...structuredClone(policy),
      ranking: { ...structuredClone(policy.ranking), weights: { ...policy.ranking.weights, query: 0.2 } },
    }),
    /weights must sum to 1/,
  )
  assert.throws(
    () => validatePolicy({
      ...structuredClone(policy),
      ranking: {
        ...structuredClone(policy.ranking),
        weights: { source: 0, technical: 0, topics: 0, recency: 0, query: 1 },
      },
    }),
    /positive non-query weight/,
  )

  const stageTrace = []
  const stagePipeline = createCandidatePipeline({
    filters: [{
      name: 'fixture-filter',
      keep(candidate) {
        stageTrace.push(`filter:${candidate.digest}`)
        return true
      },
    }],
    scorers: [{
      name: 'fixture-scorer',
      score(candidate) {
        stageTrace.push(`score:${candidate.digest}`)
        return { ...candidate, ranking_score: candidate.digest === 'a' ? 2 : 1 }
      },
    }],
    selector: {
      name: 'fixture-selector',
      select(candidates) {
        stageTrace.push('select')
        return [...candidates].sort((left, right) => right.ranking_score - left.ranking_score).slice(0, 1)
      },
    },
  })
  assert.deepEqual(stagePipeline.run([{ digest: 'b' }, { digest: 'a' }]), [{ digest: 'a', ranking_score: 2 }])
  assert.deepEqual(stageTrace, ['filter:b', 'filter:a', 'score:b', 'score:a', 'select'])

  const rankingNow = '2026-08-15T08:00:00.000Z'
  const graphCandidate = rankingCandidate({ digest: 'graph', title: 'Graph engineering agents pipeline' })
  const sourceHeavyCandidate = rankingCandidate({
    digest: 'oauth',
    source: 'x-bookmarks',
    title: 'OAuth token rotation security',
    reasonCodes: ['technical-terms', 'term:oauth', 'term:security'],
    topics: ['security'],
  })
  const graphSnapshot = JSON.stringify(graphCandidate)
  const queryRanked = rankAttentionCandidates([sourceHeavyCandidate, graphCandidate], {
    policy,
    now: rankingNow,
    query: 'graph engineering agents',
    limit: 2,
  })
  assert.equal(queryRanked[0].digest, 'graph')
  assert.deepEqual(queryRanked[0].ranking_reasons.map((reason) => reason.signal), ['source', 'technical', 'topics', 'recency', 'query'])
  assert.equal(JSON.stringify(graphCandidate), graphSnapshot)
  assert.equal(
    queryRanked.find((candidate) => candidate.digest === 'graph').ranking_score,
    scoreAttentionCandidate(graphCandidate, { policy, now: rankingNow, query: 'graph engineering agents' }).ranking_score,
  )
  assert.equal(
    rankAttentionCandidates([graphCandidate], { policy, now: rankingNow, query: 'graph engineering agents', limit: 1 })[0].ranking_score,
    scoreAttentionCandidate(graphCandidate, { policy, now: rankingNow, query: 'graph engineering agents' }).ranking_score,
  )

  const sourcePriority = rankAttentionCandidates([
    rankingCandidate({ digest: 'youtube', title: 'Node API', reasonCodes: ['technical-domain'], topics: [] }),
    rankingCandidate({ digest: 'x', source: 'x-bookmarks', title: 'Node API', reasonCodes: ['technical-domain'], topics: [] }),
  ], { policy, now: rankingNow, limit: 2 })
  assert.equal(sourcePriority[0].digest, 'x')
  assert.deepEqual(sourcePriority[0].ranking_reasons.map((reason) => reason.signal), ['source', 'technical', 'topics', 'recency'])

  const stableTies = rankAttentionCandidates([
    rankingCandidate({ digest: 'b', title: 'Same candidate' }),
    rankingCandidate({ digest: 'a', title: 'Same candidate' }),
  ], { policy, now: rankingNow, limit: 2 })
  assert.deepEqual(stableTies.map((candidate) => candidate.digest), ['a', 'b'])
  const equivalentInstantTies = rankAttentionCandidates([
    rankingCandidate({ digest: 'b', title: 'Same instant', observedAt: '2026-08-15T07:00:00Z' }),
    rankingCandidate({ digest: 'a', title: 'Same instant', observedAt: '2026-08-15T07:00:00.000Z' }),
  ], { policy, now: rankingNow, limit: 2 })
  assert.deepEqual(equivalentInstantTies.map((candidate) => candidate.digest), ['a', 'b'])
  const cppRanked = scoreAttentionCandidate(
    rankingCandidate({ digest: 'cpp', title: 'C++ runtime design' }),
    { policy, now: rankingNow, query: 'C++' },
  )
  assert.equal(cppRanked.ranking_signals.query, 1)
  assert.throws(
    () => scoreAttentionCandidate(graphCandidate, { policy, now: rankingNow, query: 'the or' }),
    /no searchable tokens/,
  )
  assert.throws(
    () => rankAttentionCandidates([], { policy, now: rankingNow, query: 'the or' }),
    /no searchable tokens/,
  )
  assert.throws(
    () => rankAttentionCandidates([], { policy, now: rankingNow, query: 'x'.repeat(501) }),
    /at most 500 characters/,
  )
  assert.deepEqual(rankAttentionCandidates([], { policy, now: rankingNow, limit: 1 }), [])
  assert.deepEqual(rankAttentionCandidates([
    rankingCandidate({ digest: 'expired', title: 'Expired', expiresAt: '2026-08-14T07:00:00.000Z' }),
  ], { policy, now: rankingNow, limit: 1 }), [])

  for (const source of ATTENTION_SOURCES) provision(source)
  const state = new AttentionState({ root, xdgStateHome: stateHome, keyStore: keys, now })
  const service = new AttentionService({ policy, state, credentials: { async inspect() { return null }, async forget(source) { forgottenSource = source } }, now })

  assert.deepEqual(canonicalizeUrl(fixtures.youtube_technical.url, 'youtube-liked'), { ok: true, canonical_url: 'https://www.youtube.com/watch?v=TechVideo42' })
  assert.deepEqual(canonicalizeUrl(fixtures.sensitive_url.url, 'youtube-liked'), { ok: false, reason: 'sensitive-query' })
  assert.deepEqual(canonicalizeUrl(fixtures.shopping.url, 'chrome-history'), { ok: true, canonical_url: 'https://shop.example.com/products/garden/drill-123' })
  assert.equal(validateCredentialMetadata('x-bookmarks', { account_alias: 'personal-x', scopes: ['bookmark.read', 'tweet.read', 'users.read'] }).ok, true)
  assert.equal(validateCredentialMetadata('x-bookmarks', { account_alias: 'personal-x', scopes: ['bookmark.write', 'tweet.read', 'users.read'] }).reason, 'write-scope-refused')

  const keychainEntries = new Map([
    [`${keyHandle('youtube-liked', 'data')}:alambic.attention.v1`, randomKey()],
    [`${keyHandle('youtube-liked', 'hmac')}:alambic.attention.v1`, randomKey()],
    ['oauth-client-id.youtube-liked:alambic.attention.v1', 'client-id-fixture'],
    ['oauth-client-secret.youtube-liked:alambic.attention.v1', 'client-secret-fixture'],
    ['oauth-refresh-token.youtube-liked:alambic.attention.v1', 'refresh-token-fixture'],
  ])
  // Keychain is opt-in (ALAMBIC_ATTENTION_ALLOW_KEYCHAIN); default is env-only.
  // Isolate from ambient host env so hermetic CI and developer shells both pass.
  const youtubeDataHandle = keyHandle('youtube-liked', 'data')
  const environmentDataKey = environmentKeyName(youtubeDataHandle)
  const priorEnvironmentDataKey = process.env[environmentDataKey]
  delete process.env[environmentDataKey]
  const macKeysBlocked = new MacOSKeychainKeyStore({
    allowKeychain: false,
    run() { throw new Error('Keychain must not be called when allowKeychain is false') },
  })
  assert.equal(macKeysBlocked.get(youtubeDataHandle), null)
  const macKeys = new MacOSKeychainKeyStore({ run: fakeKeychain(keychainEntries), allowKeychain: true })
  assert.equal(typeof macKeys.get(youtubeDataHandle), 'string')
  process.env[environmentDataKey] = 'sYdXki6S_E2tRB0oGZRHKyTZQrcBEzUlXrVX9QGoOb4'
  const environmentKeys = new MacOSKeychainKeyStore({
    allowKeychain: false,
    run() { throw new Error('Keychain must not be called for an environment override') },
  })
  assert.equal(environmentKeys.get(youtubeDataHandle), process.env[environmentDataKey])
  if (priorEnvironmentDataKey === undefined) delete process.env[environmentDataKey]
  else process.env[environmentDataKey] = priorEnvironmentDataKey
  // Clear ambient OAuth env so keychain-fixture and env-fixture paths stay hermetic.
  const youtubeOauthNames = [
    'ALAMBIC_YOUTUBE_CLIENT_ID',
    'ALAMBIC_YOUTUBE_CLIENT_SECRET',
    'ALAMBIC_YOUTUBE_REFRESH_TOKEN',
  ]
  const priorYoutubeOauth = Object.fromEntries(youtubeOauthNames.map((name) => [name, process.env[name]]))
  for (const name of youtubeOauthNames) delete process.env[name]
  const macCredentials = new MacOSKeychainCredentialProvider({ run: fakeKeychain(keychainEntries), allowKeychain: true })
  assert.deepEqual(await macCredentials.inspect('youtube-liked'), { account_alias: 'youtube-primary', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] })
  assert.deepEqual(await macCredentials.client('youtube-liked'), { client_id: 'client-id-fixture', client_secret: 'client-secret-fixture', refresh_token: 'refresh-token-fixture' })
  const envOnlyCredentials = new MacOSKeychainCredentialProvider({
    allowKeychain: false,
    run() { throw new Error('Keychain must not be called in env-only mode') },
  })
  process.env.ALAMBIC_YOUTUBE_CLIENT_ID = 'env-client-id'
  process.env.ALAMBIC_YOUTUBE_CLIENT_SECRET = 'env-client-secret'
  process.env.ALAMBIC_YOUTUBE_REFRESH_TOKEN = 'env-refresh-token'
  assert.deepEqual(await envOnlyCredentials.client('youtube-liked'), {
    client_id: 'env-client-id',
    client_secret: 'env-client-secret',
    refresh_token: 'env-refresh-token',
  })
  for (const name of youtubeOauthNames) {
    if (priorYoutubeOauth[name] === undefined) delete process.env[name]
    else process.env[name] = priorYoutubeOauth[name]
  }
  const { inspectAttentionEnv } = await import('../lib/attention/credentials.mjs')
  const envProbe = inspectAttentionEnv({
    ALAMBIC_YOUTUBE_CLIENT_ID: 'x',
    ALAMBIC_YOUTUBE_CLIENT_SECRET: 'x',
    ALAMBIC_YOUTUBE_REFRESH_TOKEN: 'x',
    ALAMBIC_ATTENTION_YOUTUBE_LIKED_DATA_KEY: 'x',
    ALAMBIC_ATTENTION_YOUTUBE_LIKED_HMAC_KEY: 'x',
    ALAMBIC_ATTENTION_X_BOOKMARKS_DATA_KEY: 'x',
    ALAMBIC_ATTENTION_X_BOOKMARKS_HMAC_KEY: 'x',
    ALAMBIC_X_CLIENT_ID: 'x',
    ALAMBIC_X_REFRESH_TOKEN: 'x',
  })
  assert.equal(envProbe.backend, 'env-only')
  assert.equal(envProbe.youtube_ready, true)
  assert.equal(envProbe.x_bookmarks_keys_ready, true)
  assert.equal(envProbe.x_bookmarks_api_ready, true)
  assert.equal(Object.values(envProbe.youtube).every(Boolean), true)
  const envProbeNoX = inspectAttentionEnv({
    ALAMBIC_ATTENTION_X_BOOKMARKS_DATA_KEY: 'x',
    ALAMBIC_ATTENTION_X_BOOKMARKS_HMAC_KEY: 'x',
  })
  assert.equal(envProbeNoX.x_bookmarks_api_ready, false)

  const fetchCalls = []
  const youtubeLiveClient = new YouTubeOAuthClient({
    client_id: 'client-id-fixture',
    client_secret: 'client-secret-fixture',
    refresh_token: 'refresh-token-fixture',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options })
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) return { ok: true, async json() { return { access_token: 'access-token-fixture' } } }
      return {
        ok: true,
        async json() {
          return {
            items: [{
              id: 'live-video-id',
              snippet: {
                title: 'Node.js OAuth API tutorial',
                description: 'Walkthrough of OAuth refresh tokens and YouTube Data API likes for agent pipelines.',
                channelTitle: 'Dev Channel',
                publishedAt: '2026-07-01T00:00:00.000Z',
              },
            }],
          }
        },
      }
    },
  })
  const liveConnector = createYouTubeLikedConnector(youtubeLiveClient)
  assert.equal(liveConnector.capability_status, 'live-green')
  const liveItems = (await liveConnector.collect({ limit: 1 })).items
  assert.equal(liveItems[0].id, 'live-video-id')
  assert.match(liveItems[0].text || '', /OAuth refresh tokens/)
  assert.equal(fetchCalls.length, 2)
  assert.match(fetchCalls[1].url, /myRating=like/)
  assert.equal(fetchCalls[1].options.headers.authorization, 'Bearer access-token-fixture')
  // Title alone may be weak; title+description must score as technical for YouTube-like items
  {
    const { classifyTechnical } = await import('../lib/attention/classifier.mjs')
    const weakTitle = classifyTechnical(
      { title: 'Why We Killed Our Multi-Agent Pipeline', text: undefined },
      'https://www.youtube.com/watch?v=u6jJcIFDLE4',
      policy,
    )
    const withDesc = classifyTechnical(
      {
        title: 'Why We Killed Our Multi-Agent Pipeline',
        text: 'Pharma analytics multi-agent pipeline replaced by a single reasoning agent and knowledge graph control plane. LLM agents, API, software engineering.',
      },
      'https://www.youtube.com/watch?v=u6jJcIFDLE4',
      policy,
    )
    assert.equal(withDesc.accepted, true)
    assert.ok(withDesc.reason_codes.some((code) => code.startsWith('term:') || code === 'technical-terms'))
    void weakTitle
  }

  const xFetchCalls = []
  const xLiveClient = new XOAuth2Client({
    client_id: 'x-client-id',
    client_secret: 'x-client-secret',
    refresh_token: 'x-refresh-token',
    fetchImpl: async (url, options) => {
      xFetchCalls.push({ url: String(url), options })
      if (String(url).startsWith('https://api.x.com/2/oauth2/token')) {
        return { ok: true, async json() { return { access_token: 'x-access-token', expires_in: 7200 } } }
      }
      if (String(url).startsWith('https://api.x.com/2/users/me')) {
        return { ok: true, async json() { return { data: { id: '42', username: 'dev' } } } }
      }
      return {
        ok: true,
        async json() {
          return {
            data: [{ id: '999', text: 'OpenAI agent architecture for backend software', author_id: '7', created_at: clock }],
            includes: { users: [{ id: '7', username: 'example' }] },
            meta: { next_token: undefined },
          }
        },
      }
    },
  })
  assert.equal(xLiveClient.mode, 'live')
  assert.equal(xLiveClient.authMode, 'oauth2-refresh')
  const xLivePage = await xLiveClient.listBookmarks({ limit: 10 })
  assert.equal(xLivePage.items[0].id, '999')
  assert.equal(xLivePage.items[0].author_handle, 'example')
  assert.equal(xFetchCalls.length, 3)
  assert.match(xFetchCalls[2].url, /\/users\/42\/bookmarks/)
  assert.equal(xFetchCalls[2].options.headers.authorization, 'Bearer x-access-token')
  const xLiveConnector = createXBookmarksConnector(xLiveClient)
  assert.equal(xLiveConnector.capability_status, 'live-green')
  assert.equal((await xLiveConnector.collect({ limit: 1 })).items[0].id, '999')

  // OAuth 1.0a path: user id inferred from token prefix; Authorization starts with OAuth
  const xOauth1Calls = []
  const xOauth1 = new XOAuth2Client({
    api_key: 'api-key',
    api_secret: 'api-secret',
    access_token: '42-access-token',
    access_token_secret: 'access-secret',
    fetchImpl: async (url, options) => {
      xOauth1Calls.push({ url: String(url), authorization: options?.headers?.authorization || '' })
      return {
        ok: true,
        async json() {
          return {
            data: [{ id: '111', text: 'TanStack Start server functions', author_id: '9', created_at: clock }],
            includes: { users: [{ id: '9', username: 'devrel' }] },
          }
        },
      }
    },
  })
  assert.equal(xOauth1.authMode, 'oauth1')
  const oauth1Page = await xOauth1.listBookmarks({ limit: 5 })
  assert.equal(oauth1Page.items[0].author_handle, 'devrel')
  assert.match(xOauth1Calls[0].url, /\/users\/42\/bookmarks/)
  assert.match(xOauth1Calls[0].authorization, /^OAuth /)

  const manualXNonTechnical = { ...fixtures.x_technical, id: 'x-manual-nontechnical-01', title: 'Promotion shopping mobilier jardin', text: 'soldes non technique' }
  const manualXGraphEngineering = { ...fixtures.x_technical, id: 'x-manual-graph-engineering-01', url: 'https://x.com/example/status/1234567890999', title: 'Agent graph engineering systems', text: 'Operational guide for reliable agent hand-offs.' }
  const manualXEvents = parseManualBrowserEvents('x-bookmarks', `${JSON.stringify(fixtures.x_technical)}\n${JSON.stringify(manualXNonTechnical)}\n`)
  assert.equal(manualXEvents.length, 2)
  assert.equal(manualXEvents[0].url, 'https://x.com/example/status/1234567890123')
  assert.throws(() => parseManualBrowserEvents('x-bookmarks', `${JSON.stringify({ ...fixtures.x_technical, cookie: 'forbidden' })}\n`), /unknown field/)
  assert.throws(() => parseManualBrowserEvents('reddit-saved', `${JSON.stringify({ ...fixtures.reddit_technical, url: 'https://www.reddit.com/user/example/saved/' })}\n`), /Reddit post permalink/)
  assert.throws(() => parseManualBrowserEvents('reddit-saved', Array.from({ length: 101 }, () => JSON.stringify(fixtures.reddit_technical)).join('\n')), /1-100 events/)
  assert.throws(() => parseManualBrowserEvents('x-bookmarks', 'x'.repeat(MANUAL_BROWSER_MAX_INPUT_BYTES + 1)), /input is too large/)

  const manualKeys = new MemoryKeyStore()
  manualKeys.set(keyHandle('x-bookmarks', 'data'))
  manualKeys.set(keyHandle('x-bookmarks', 'hmac'))
  const manualStateHome = path.join(temporary, 'manual-state')
  const manualState = new AttentionState({ root, xdgStateHome: manualStateHome, keyStore: manualKeys, now })
  const manualService = new AttentionService({ policy, state: manualState, credentials: { async inspect() { return null }, async forget() {} }, connectors: { 'x-bookmarks': createManualBrowserConnector('x-bookmarks', manualXEvents) }, now })
  const manualDry = await manualService.collect({ source: 'x-bookmarks', dryRun: true })
  assert.equal(manualDry.status, 'dry-run')
  assert.equal(manualDry.accepted, 1)
  assert.equal(manualDry.rejected, 1)
  assert.equal(fs.existsSync(manualState.sourceDir('x-bookmarks')), false)
  const manualGraphDry = await manualService.collect({ source: 'x-bookmarks', connector: createManualBrowserConnector('x-bookmarks', [manualXGraphEngineering]), dryRun: true })
  assert.equal(manualGraphDry.accepted, 1)
  assert.equal(manualGraphDry.rejected, 0)
  assert.equal(manualGraphDry.candidates[0].reason_codes.includes('term:graph engineering'), true)
  assert.equal(fs.existsSync(manualState.sourceDir('x-bookmarks')), false)

  const priorXdgStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = path.join(temporary, 'manual-cli-state')
  let manualCliOutput = null
  await runAttentionCommand({
    root,
    args: ['ingest', '--source', 'x-bookmarks', '--stdin', '--dry-run', '--summary', '--json'],
    input: `${JSON.stringify(fixtures.x_technical)}\n${JSON.stringify(manualXNonTechnical)}\n`,
    output(value) { manualCliOutput = value },
  })
  if (priorXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = priorXdgStateHome
  assert.equal(manualCliOutput[0].candidate_count, 1)
  assert.equal(Object.hasOwn(manualCliOutput[0], 'candidates'), false)
  assert.equal(fs.existsSync(path.join(temporary, 'manual-cli-state', 'alambic', 'attention', 'x-bookmarks')), false)
  const persistentManualKeys = new MemoryKeyStore()
  persistentManualKeys.set(keyHandle('x-bookmarks', 'data'))
  persistentManualKeys.set(keyHandle('x-bookmarks', 'hmac'))
  const persistentManualStateHome = path.join(temporary, 'persistent-manual-cli-state')
  let persistentManualOutput = null
  await runAttentionCommand({
    root,
    args: ['ingest', '--source', 'x-bookmarks', '--stdin', '--persist', '--confirm', '--summary', '--json'],
    input: `${JSON.stringify(manualXGraphEngineering)}\n`,
    keyStore: persistentManualKeys,
    xdgStateHome: persistentManualStateHome,
    output(value) { persistentManualOutput = value },
  })
  assert.equal(persistentManualOutput[0].status, 'live-green')
  assert.equal(persistentManualOutput[0].candidate_count, 1)
  const persistentManualState = new AttentionState({ root, xdgStateHome: persistentManualStateHome, keyStore: persistentManualKeys, now })
  const persistentManualCandidateFiles = fs.readdirSync(path.join(persistentManualState.sourceDir('x-bookmarks'), 'candidates'))
  assert.equal(persistentManualCandidateFiles.length, 1)
  const persistentManualStored = fs.readFileSync(path.join(persistentManualState.sourceDir('x-bookmarks'), 'candidates', persistentManualCandidateFiles[0]), 'utf8')
  assert.match(persistentManualStored, /"ciphertext"/)
  assert.equal(persistentManualStored.includes(manualXGraphEngineering.title), false)
  assert.equal(persistentManualState.assertPermissions('x-bookmarks'), true)
  let persistentWithoutKeysOutput = null
  await runAttentionCommand({
    root,
    args: ['ingest', '--source', 'x-bookmarks', '--stdin', '--persist', '--confirm', '--summary', '--json'],
    input: `${JSON.stringify(manualXGraphEngineering)}\n`,
    keyStore: new MemoryKeyStore(),
    xdgStateHome: path.join(temporary, 'persistent-manual-cli-no-keys'),
    output(value) { persistentWithoutKeysOutput = value },
  })
  assert.equal(persistentWithoutKeysOutput[0].status, 'blocked-auth')
  assert.equal(persistentWithoutKeysOutput[0].candidate_count, 0)
  await assert.rejects(
    runAttentionCommand({ root, args: ['ingest', '--source', 'x-bookmarks', '--stdin', '--summary', '--json'], input: `${JSON.stringify(fixtures.x_technical)}\n`, output() {} }),
    /usage/,
  )
  await assert.rejects(
    runAttentionCommand({ root, args: ['ingest', '--source', 'x-bookmarks', '--stdin', '--persist', '--summary', '--json'], input: `${JSON.stringify(manualXGraphEngineering)}\n`, output() {} }),
    /usage/,
  )
  await assert.rejects(
    runAttentionCommand({ root, args: ['ingest', '--source', 'reddit-saved', '--stdin', '--persist', '--confirm', '--summary', '--json'], input: `${JSON.stringify(fixtures.reddit_technical)}\n`, output() {} }),
    /usage/,
  )

  const first = await service.collect({ source: 'youtube-liked', connector: connector('youtube-liked', [fixtures.youtube_technical, fixtures.shopping, fixtures.hostile, fixtures.sensitive_url, fixtures.pii]) })
  assert.equal(first.status, 'fixture-green')
  assert.equal(first.accepted, 1)
  assert.equal(first.rejected, 4)
  assert.equal(first.cursor_advanced, true)
  assert.equal(first.reason_counts['unsupported-url'], 1)
  assert.equal(first.reason_counts['unsafe-content'], 2)
  assert.equal(first.reason_counts['sensitive-query'], 1)
  assert.equal(first.candidates[0].canonical_url, 'https://www.youtube.com/watch?v=TechVideo42')
  assert.equal(first.candidates[0].title, fixtures.youtube_technical.title)
  assert.throws(() => validateCandidate({ ...first.candidates[0], raw_payload: 'must-fail' }), /invalid shape/)

  const stateText = fs.readdirSync(state.sourceDir('youtube-liked'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.json'))
    .map((entry) => fs.readFileSync(path.join(state.sourceDir('youtube-liked'), String(entry)), 'utf8')).join('\n')
  for (const forbidden of [fixtures.shopping.title, fixtures.shopping.url, fixtures.hostile.title, fixtures.pii.title, 'shopping-private-id-04', 'private-value', 'yt-private-id-01']) assert.equal(stateText.includes(forbidden), false, `state leaked ${forbidden}`)
  assert.match(stateText, /"ciphertext"/)
  assert.equal(state.assertPermissions('youtube-liked'), true)

  const replay = await service.collect({ source: 'youtube-liked', connector: connector('youtube-liked', [fixtures.youtube_technical, fixtures.shopping]) })
  assert.equal(replay.accepted, 0)
  assert.equal(replay.replayed, 2)
  assert.equal(service.digest().length, 1)

  const candidate = service.digest()[0]
  const candidateStateFile = path.join(state.sourceDir('youtube-liked'), 'candidates', `${candidate.digest}.json`)
  const cursorStateFile = path.join(state.sourceDir('youtube-liked'), 'cursor.json')
  const beforeRankedRead = {
    candidate: fs.readFileSync(candidateStateFile, 'utf8'),
    cursor: fs.readFileSync(cursorStateFile, 'utf8'),
  }
  const rankedRead = service.digest({ query: 'node api security' })
  assert.equal(rankedRead[0].ranking_reasons.some((reason) => reason.signal === 'query'), true)
  let cliDigest = null
  await runAttentionCommand({
    root,
    args: ['digest', '--query', 'node api security', '--json'],
    keyStore: keys,
    xdgStateHome: stateHome,
    now,
    output(value) { cliDigest = value },
  })
  assert.equal(cliDigest.length, 1)
  assert.equal(cliDigest[0].ranking_score, rankedRead[0].ranking_score)
  assert.equal(fs.readFileSync(candidateStateFile, 'utf8'), beforeRankedRead.candidate)
  assert.equal(fs.readFileSync(cursorStateFile, 'utf8'), beforeRankedRead.cursor)
  assert.equal(beforeRankedRead.candidate.includes('ranking_score'), false)
  assert.equal(beforeRankedRead.cursor.includes('node api security'), false)

  const receipt = service.review({ source: 'youtube-liked', digest: candidate.digest, decision: 'accept', reasonCode: 'keep' })
  assert.equal(receipt.decision, 'accept')
  assert.throws(() => service.review({ source: 'youtube-liked', digest: candidate.digest, decision: 'accept', reasonCode: 'keep' }), /EEXIST/)
  const receiptFile = path.join(state.sourceDir('youtube-liked'), 'receipts', `${candidate.digest}.json`)
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o400)
  assert.equal(fs.readFileSync(receiptFile, 'utf8').includes(candidate.title), false)

  const blocked = await service.collect({ source: 'reddit-saved' })
  assert.equal(blocked.status, 'blocked-auth')
  assert.equal(blocked.cursor_advanced, false)
  assert.equal(fs.existsSync(path.join(state.sourceDir('reddit-saved'), 'cursor.json')), false)

  const redditPageTokens = []
  const redditAdapter = createRedditConnector('reddit-saved', { async list({ pageToken }) {
    redditPageTokens.push(pageToken || null)
    if (!pageToken) return { items: [{ id: 'r1', url: fixtures.reddit_technical.url, title: fixtures.reddit_technical.title, selftext: fixtures.reddit_technical.text, occurred_at: fixtures.reddit_technical.occurred_at }], next_page_token: 'private-page-token' }
    return { items: [{ id: 'r2', url: 'https://www.reddit.com/r/node/comments/node123/api_security/', title: 'Node.js API security architecture', selftext: 'Developer discussion', occurred_at: clock }] }
  } })
  const reddit = await service.collect({ source: 'reddit-saved', connector: redditAdapter })
  assert.equal(reddit.accepted, 2)
  assert.deepEqual(redditPageTokens, [null, 'private-page-token'])
  const redditStateText = fs.readdirSync(state.sourceDir('reddit-saved'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.json'))
    .map((entry) => fs.readFileSync(path.join(state.sourceDir('reddit-saved'), String(entry)), 'utf8')).join('\n')
  assert.equal(redditStateText.includes('private-page-token'), false)
  const youtubeAdapter = createYouTubeLikedConnector({ async listLiked() { return { items: [{ id: 'video987', video_id: 'video987', title: 'Node.js API security', channel_title: 'Dev channel', liked_at: clock }], exhausted: true } } })
  assert.equal((await service.collect({ source: 'youtube-liked', connector: youtubeAdapter })).accepted, 1)
  const xAdapter = createXBookmarksConnector({ async listBookmarks() { return { items: [{ id: '555', author_handle: 'dev', text: 'OpenAI agent architecture for backend software', bookmarked_at: clock }], exhausted: true } } })
  assert.equal((await service.collect({ source: 'x-bookmarks', connector: xAdapter })).accepted, 1)
  const chromeAdapter = createChromeHistoryConnector({ async probeMultiDeviceVisits() { return { supported: false } }, async listVisits() { throw new Error('must not list unsupported history') } })
  assert.equal((await service.collect({ source: 'chrome-history', connector: chromeAdapter })).status, 'unsupported')
  const chromeSupported = createChromeHistoryConnector({
    mode: 'fixture',
    async probeMultiDeviceVisits() { return { supported: true } },
    async listVisits() { return { items: [{ id: 'chrome-1', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', title: 'Fetch API - MDN Web Docs', visited_at: clock }] } },
  })
  assert.equal((await service.collect({ source: 'chrome-history', connector: chromeSupported })).accepted, 1)

  // Multi-device local client: foreign originators only
  const { ChromeHistoryLocalClient, readLocalCacheGuid } = await import('../lib/attention/providers/chrome-history-local.mjs')
  const chromeTmp = path.join(temporary, 'chrome-fixture')
  fs.mkdirSync(chromeTmp, { recursive: true })
  const prefsPath = path.join(chromeTmp, 'Preferences')
  const historyPath = path.join(chromeTmp, 'History')
  fs.writeFileSync(prefsPath, JSON.stringify({
    sync: {
      local_device_guids_with_timestamp: [{ cache_guid: 'local-guid-aaa', timestamp: 1 }],
      transport_data_per_account: {
        acc1: { 'sync.cache_guid': 'local-guid-aaa' },
      },
    },
  }))
  assert.equal(readLocalCacheGuid(prefsPath), 'local-guid-aaa')
  // Build minimal History sqlite with foreign + local visits
  const { DatabaseSync } = await import('node:sqlite')
  const chromeDb = new DatabaseSync(historyPath)
  chromeDb.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY,
      url INTEGER,
      visit_time INTEGER,
      originator_cache_guid TEXT,
      is_known_to_sync INTEGER
    );
    INSERT INTO urls(id,url,title) VALUES
      (1,'https://developer.mozilla.org/docs/Web/API','Fetch API'),
      (2,'https://shopping.example/buy','Shoes');
    INSERT INTO visits(id,url,visit_time,originator_cache_guid,is_known_to_sync) VALUES
      (10,1,13300000000000000,'remote-guid-bbb',1),
      (11,2,13300000000000001,'local-guid-aaa',1),
      (12,1,13300000000000002,'',1);
  `)
  chromeDb.close()
  const localClient = new ChromeHistoryLocalClient({ historyPath, preferencesPath: prefsPath })
  const multi = await localClient.probeMultiDeviceVisits()
  assert.equal(multi.supported, true)
  assert.equal(multi.foreign_originators, 1)
  const listed = await localClient.listVisits({ limit: 10 })
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].url, 'https://developer.mozilla.org/docs/Web/API')
  assert.match(listed.items[0].id, /^chrome-10$/)

  const beforeDry = fs.readFileSync(path.join(state.sourceDir('reddit-saved'), 'cursor.json'), 'utf8')
  const dry = await service.collect({ source: 'reddit-saved', connector: connector('reddit-saved', [{ ...fixtures.reddit_technical, id: 'new-dry-run-id' }]), dryRun: true })
  assert.equal(dry.status, 'dry-run')
  assert.equal(fs.readFileSync(path.join(state.sourceDir('reddit-saved'), 'cursor.json'), 'utf8'), beforeDry)
  const redditCursor = path.join(state.sourceDir('reddit-saved'), 'cursor.json')
  fs.writeFileSync(redditCursor, '{"corrupt":true}\n', { mode: 0o600 })
  await assert.rejects(service.collect({ source: 'reddit-saved', connector: connector('reddit-saved', []) }), /attention cursor is invalid/)
  fs.writeFileSync(redditCursor, beforeDry, { mode: 0o600 })
  await assert.rejects(
    service.collect({ source: 'reddit-saved', connector: { source: 'reddit-saved', async collect() { throw new Error('fixture provider failure') } } }),
    /fixture provider failure/,
  )
  assert.equal(fs.readFileSync(path.join(state.sourceDir('reddit-saved'), 'cursor.json'), 'utf8'), beforeDry)

  let releaseSlow
  const slow = new Promise((resolve) => { releaseSlow = resolve })
  const running = service.collect({ source: 'reddit-upvoted', connector: { source: 'reddit-upvoted', async collect() { await slow; return { items: [{ ...fixtures.reddit_technical, id: 'concurrent-private-id' }] } } } })
  await new Promise((resolve) => setImmediate(resolve))
  const busy = service.collect({ source: 'reddit-upvoted', connector: connector('reddit-upvoted', [{ ...fixtures.reddit_technical, id: 'concurrent-private-id' }]) })
  releaseSlow()
  const concurrent = await Promise.allSettled([running, busy])
  assert.equal(concurrent.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter((entry) => entry.status === 'rejected')[0].reason.message, 'attention source is busy: reddit-upvoted')
  assert.equal(service.digest().filter((entry) => entry.source === 'reddit-upvoted').length, 1)

  const sourceDigest = candidate.digest
  const candidateFile = path.join(state.sourceDir('youtube-liked'), 'candidates', `${sourceDigest}.json`)
  const backup = fs.readFileSync(candidateFile, 'utf8')
  assert.equal((await service.disconnect({ source: 'youtube-liked', dryRun: true })).dry_run, true)
  assert.equal((await service.disconnect({ source: 'youtube-liked', dryRun: false, confirm: true })).disconnected, true)
  assert.equal(forgottenSource, 'youtube-liked')
  assert.equal(keys.get(keyHandle('youtube-liked', 'data')), null)
  assert.equal(fs.existsSync(state.sourceDir('youtube-liked')), false)
  assert.throws(() => decryptJson(JSON.parse(backup).encrypted, keys.get(keyHandle('youtube-liked', 'data'))), /attention key is missing/)

  const unsafeRoot = path.join(root, '.attention-state-test')
  assert.throws(() => new AttentionState({ root, xdgStateHome: root, keyStore: keys, now }), /must not be stored inside repository/)
  void unsafeRoot

  clock = '2026-11-01T16:00:00.000Z'
  assert.equal(service.purge('reddit-saved').removed >= 1, true)

  // Staging / promote-candidate path: inbox only; never kb without separate human workflow.
  const stageRoot = path.join(temporary, 'stage-root')
  fs.mkdirSync(path.join(stageRoot, 'docs', 'inbox', 'ai'), { recursive: true })
  const stageEntries = [
    {
      digest: 'a'.repeat(64),
      source: 'youtube-liked',
      event_type: 'like',
      canonical_url: 'https://www.youtube.com/watch?v=TechVideo42',
      title: 'Node.js API security architecture',
      observed_at: '2026-07-22T16:00:00.000Z',
      expires_at: '2026-07-29T16:00:00.000Z',
      signal_weight: 4,
      reason_codes: ['technical-terms'],
      topics: ['backend'],
      confidence: 'deterministic',
    },
  ]
  const dryStage = stagePromoteCandidates({
    root: stageRoot,
    entries: stageEntries,
    now: '2026-07-23T06:00:00.000Z',
    dryRun: true,
    runId: 'test-run',
  })
  assert.equal(dryStage.dry_run, true)
  assert.equal(dryStage.staged, 1)
  assert.equal(dryStage.wrote_kb, false)
  assert.equal(fs.existsSync(dryStage.absolute_path), false)
  const wetStage = stagePromoteCandidates({
    root: stageRoot,
    entries: stageEntries,
    now: '2026-07-23T06:00:00.000Z',
    dryRun: false,
    runId: 'test-run',
  })
  assert.equal(wetStage.dry_run, false)
  assert.equal(wetStage.path, 'docs/inbox/ai/attention-digest-20260723.md')
  assert.equal(fs.existsSync(wetStage.absolute_path), true)
  const stagedBody = fs.readFileSync(wetStage.absolute_path, 'utf8')
  assert.match(stagedBody, /Node\.js API security architecture/)
  assert.match(stagedBody, /apply-auto remains DISABLED/)
  // Refuse promote without confirm
  const refused = promoteCandidateDraft({ root: stageRoot, entry: stageEntries[0], confirm: false })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'confirm-required')
  assert.equal(refused.wrote_kb, false)
  const promoted = promoteCandidateDraft({ root: stageRoot, entry: stageEntries[0], confirm: true, now: '2026-07-23T06:05:00.000Z' })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.wrote_kb, false)
  assert.equal(promoted.wrote_ref, false)
  assert.match(promoted.path, /^docs\/inbox\/ai\//)
  assert.equal(fs.existsSync(promoted.absolute_path), true)
  const md = buildStageMarkdown({ entries: [], generatedAt: '2026-07-23T06:00:00.000Z', runId: 'empty' })
  assert.match(md, /No unexpired technical attention candidates/)

  // CLI stage dry-run writes only under real repo inbox path when not dry; dry-run must not write.
  const cliStageRoot = path.join(temporary, 'cli-stage-root')
  fs.mkdirSync(path.join(cliStageRoot, '_meta'), { recursive: true })
  fs.mkdirSync(path.join(cliStageRoot, 'docs', 'inbox', 'ai'), { recursive: true })
  fs.copyFileSync(path.join(root, '_meta/technical-attention-policy.json'), path.join(cliStageRoot, '_meta/technical-attention-policy.json'))
  let stageCli = null
  await runAttentionCommand({
    root: cliStageRoot,
    args: ['stage', '--dry-run', '--json'],
    keyStore: keys,
    xdgStateHome: stateHome,
    output(value) { stageCli = value },
  })
  assert.equal(stageCli.dry_run, true)
  assert.equal(stageCli.wrote_kb, false)
  assert.equal(fs.existsSync(path.join(cliStageRoot, stageCli.path)), false)
  let promoteCli = null
  await runAttentionCommand({
    root: cliStageRoot,
    args: ['promote', '--source', 'youtube-liked', '--candidate', 'a'.repeat(64), '--json'],
    keyStore: keys,
    xdgStateHome: stateHome,
    output(value) { promoteCli = value },
  })
  assert.equal(promoteCli.ok, false)
  assert.equal(promoteCli.reason, 'confirm-required')

  // Compile + promote-suggest (pure builders + CLI dry paths)
  const compileRoot = path.join(temporary, 'compile-root')
  fs.mkdirSync(path.join(compileRoot, 'docs', 'inbox', 'ai'), { recursive: true })
  fs.mkdirSync(path.join(compileRoot, 'kb'), { recursive: true })
  fs.mkdirSync(path.join(compileRoot, '_meta'), { recursive: true })
  fs.copyFileSync(path.join(root, '_meta/technical-attention-policy.json'), path.join(compileRoot, '_meta/technical-attention-policy.json'))
  fs.writeFileSync(path.join(compileRoot, 'kb', 'agent-harness-engineering.md'), '---\nsummary: "Harness patterns for agents"\ntags:\n  - harness\n  - agents\n---\n# Agent harness engineering\n')
  const compileEntries = [
    {
      digest: 'b'.repeat(64),
      source: 'youtube-liked',
      title: 'Agent harness engineering for long-running coding agents',
      canonical_url: 'https://www.youtube.com/watch?v=TechVideo99',
      signal_weight: 5,
      topics: ['agents', 'harness'],
      reason_codes: ['term:agent', 'term:harness'],
      confidence: 'deterministic',
      observed_at: '2026-07-23T06:00:00.000Z',
    },
    {
      digest: 'c'.repeat(64),
      source: 'x-bookmarks',
      title: 'TanStack Start server functions boundaries',
      canonical_url: 'https://x.com/dev/status/1',
      signal_weight: 4,
      topics: ['tanstack'],
      reason_codes: ['technical-terms'],
      confidence: 'deterministic',
      observed_at: '2026-07-23T06:01:00.000Z',
    },
  ]
  const target = suggestKbTarget(compileEntries[0], [
    { basename: 'agent-harness-engineering', path: 'kb/agent-harness-engineering.md', title: 'Agent harness engineering', tags: ['harness', 'agents'], summary: 'Harness patterns' },
  ])
  assert.equal(target.action, 'update')
  assert.equal(target.path, 'kb/agent-harness-engineering.md')
  const claims = buildClaimsFromEntries(compileEntries, {
    kbIndex: [{ basename: 'agent-harness-engineering', path: 'kb/agent-harness-engineering.md', title: 'Agent harness', tags: ['agents'], summary: '' }],
    maxClaims: 7,
  })
  assert.equal(claims.length, 2)
  assert.ok(claims.length <= 7)
  const mixedClaims = buildClaimsFromEntries([
    { ...compileEntries[0], digest: 'legacy', signal_weight: 5 },
    { ...compileEntries[0], digest: 'b', ranking_score: 10, observed_at: '2026-07-23T06:00:00Z' },
    { ...compileEntries[0], digest: 'a', ranking_score: 10, observed_at: '2026-07-23T06:00:00.000Z' },
  ], { kbIndex: [], maxClaims: 7 })
  assert.deepEqual(mixedClaims.map((claim) => claim.digest), ['a', 'b', 'legacy'])
  const synDry = writeSynthesis({
    root: compileRoot,
    entries: compileEntries,
    now: '2026-07-23T06:00:00.000Z',
    dryRun: true,
    kbIndex: [{ basename: 'agent-harness-engineering', path: 'kb/agent-harness-engineering.md', title: 'Agent harness', tags: ['agents'], summary: '' }],
  })
  assert.equal(synDry.dry_run, true)
  assert.equal(synDry.wrote_kb, false)
  assert.equal(fs.existsSync(synDry.absolute_path), false)
  const synWet = writeSynthesis({
    root: compileRoot,
    entries: compileEntries,
    now: '2026-07-23T06:00:00.000Z',
    dryRun: false,
    kbIndex: [{ basename: 'agent-harness-engineering', path: 'kb/agent-harness-engineering.md', title: 'Agent harness', tags: ['agents'], summary: '' }],
  })
  assert.equal(synWet.path, 'docs/inbox/ai/attention-synthesis-20260723.md')
  assert.equal(fs.existsSync(synWet.absolute_path), true)
  assert.equal(synWet.wrote_kb, false)
  const synBody = fs.readFileSync(synWet.absolute_path, 'utf8')
  assert.match(synBody, /Agent harness engineering/)
  assert.match(synBody, /apply-auto remains DISABLED/)
  const emptySyn = writeSynthesis({
    root: compileRoot,
    entries: [],
    now: '2026-07-24T06:00:00.000Z',
    dryRun: false,
  })
  assert.equal(emptySyn.empty, true)
  assert.match(fs.readFileSync(emptySyn.absolute_path, 'utf8'), /No-op/)

  const refuseSuggest = promoteSuggest({ root: compileRoot, entries: compileEntries, confirm: false })
  assert.equal(refuseSuggest.ok, false)
  assert.equal(refuseSuggest.reason, 'confirm-required')
  assert.equal(refuseSuggest.wrote_kb, false)
  assert.equal(refuseSuggest.suggestions.length, 2)
  const acceptSuggest = promoteSuggest({ root: compileRoot, entries: compileEntries, confirm: true, now: '2026-07-23T07:00:00.000Z' })
  assert.equal(acceptSuggest.ok, true)
  assert.equal(acceptSuggest.wrote_kb, false)
  // Only claims with https canonical_url materialize into promote-ready/
  assert.ok(acceptSuggest.staged.length >= 1, 'expected at least one oracle-ready draft')
  assert.match(acceptSuggest.staged[0].path, /^docs\/inbox\/ai\/promote-ready\//)
  assert.equal(acceptSuggest.staged[0].oracle_ready, true)
  const promoteReadyBody = fs.readFileSync(path.join(compileRoot, acceptSuggest.staged[0].path), 'utf8')
  assert.match(promoteReadyBody, /^type: finding/m)
  assert.match(promoteReadyBody, /^sources:/m)
  assert.match(promoteReadyBody, /https?:\/\//)
  assert.equal(fs.existsSync(path.join(compileRoot, acceptSuggest.staged[0].path)), true)

  const pack = buildAttentionSessionPack({
    root: compileRoot,
    status: { sources: { 'youtube-liked': { capability: { status: 'live-green' }, candidates: 1 } } },
    maxTokens: 2500,
    now: '2026-07-23T08:00:00.000Z',
  })
  assert.equal(pack.within_budget, true)
  assert.ok(pack.estimated_tokens <= 2500)
  assert.equal(pack.wrote_kb, false)
  assert.match(pack.text, /Attention session pack/)
  assert.equal(pack.synthesis_path, 'docs/inbox/ai/attention-synthesis-20260723.md')

  let compileCli = null
  await runAttentionCommand({
    root: compileRoot,
    args: ['compile', '--dry-run', '--json'],
    keyStore: keys,
    xdgStateHome: stateHome,
    output(value) { compileCli = value },
  })
  assert.equal(compileCli.dry_run, true)
  assert.equal(compileCli.wrote_kb, false)
  let suggestCli = null
  await runAttentionCommand({
    root: compileRoot,
    args: ['promote-suggest', '--json'],
    keyStore: keys,
    xdgStateHome: stateHome,
    output(value) { suggestCli = value },
  })
  assert.equal(suggestCli.ok, false)
  assert.equal(suggestCli.reason, 'confirm-required')

  console.log('attention tests: ok')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
