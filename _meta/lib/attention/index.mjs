import fs from 'node:fs'
import path from 'node:path'
import { inspectAttentionEnv, MacOSKeychainCredentialProvider } from './credentials.mjs'
import { createManualBrowserConnector, MANUAL_BROWSER_MAX_INPUT_BYTES, parseManualBrowserEvents } from './connectors/manual-browser.mjs'
import { createYouTubeLikedConnector } from './connectors/youtube-liked.mjs'
import { createXBookmarksConnector } from './connectors/x-bookmarks.mjs'
import { createChromeHistoryConnector } from './connectors/chrome-history.mjs'
import { YouTubeOAuthClient } from './providers/youtube-oauth.mjs'
import { XOAuth2Client } from './providers/x-oauth.mjs'
import { ChromeHistoryLocalClient } from './providers/chrome-history-local.mjs'
import { authorizeYouTube } from './youtube-authorize.mjs'
import { AttentionService } from './pipeline.mjs'
import { readAttentionPolicy, assertSource } from './schema.mjs'
import { AttentionState } from './state.mjs'
import { keyHandle, MacOSKeychainKeyStore, MemoryKeyStore } from './crypto.mjs'
import { appendAttentionWorkflowEvent, listXDropFiles } from './stage.mjs'
import { buildAttentionSessionPack } from './compile.mjs'

function takeFlag(args, flag) {
  const index = args.indexOf(flag)
  if (index < 0) return false
  args.splice(index, 1)
  return true
}

function takeOption(args, flag, fallback = null) {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`attention option requires a value: ${flag}`)
  args.splice(index, 2)
  return value
}

function formatDigest(entries) {
  return entries.length
    ? entries.map((entry) => `${entry.digest}\t${entry.source}\t${entry.event_type}\tscore=${entry.ranking_score}\t${entry.confidence}\t${entry.canonical_url}\t${entry.title}`).join('\n')
    : '(empty) no unexpired technical attention candidates'
}

function render(value, json, output, formatter = null) {
  output(json ? value : (formatter ? formatter(value) : JSON.stringify(value)), json)
}

function collectionSummary(entries) {
  return entries.map(({ candidates, ...entry }) => ({ ...entry, candidate_count: candidates.length }))
}

function readManualInput(input) {
  if (typeof input === 'string') return input
  if (Buffer.isBuffer(input)) return input.toString('utf8')
  const chunks = []
  let total = 0
  const chunk = Buffer.alloc(64 * 1024)
  for (;;) {
    const read = fs.readSync(0, chunk)
    if (!read) break
    total += read
    if (total > MANUAL_BROWSER_MAX_INPUT_BYTES) throw new Error('manual browser ingest input is too large')
    chunks.push(Buffer.from(chunk.subarray(0, read)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export function createAttentionService({ root, xdgStateHome, keyStore = new MacOSKeychainKeyStore(), credentials = new MacOSKeychainCredentialProvider(), connectors = {}, now } = {}) {
  const policy = readAttentionPolicy(root)
  const state = new AttentionState({ root, xdgStateHome, keyStore, now })
  const connectorFactory = async (source) => {
    if (source === 'youtube-liked') {
      const client = await credentials.client(source)
      if (!client?.refresh_token) return null
      return createYouTubeLikedConnector(new YouTubeOAuthClient(client))
    }
    if (source === 'x-bookmarks') {
      const client = await credentials.client(source)
      if (!client?.refresh_token && !client?.access_token && !client?.bearer_token) return null
      try {
        return createXBookmarksConnector(new XOAuth2Client(client))
      } catch {
        return null
      }
    }
    if (source === 'chrome-history') {
      try {
        const client = new ChromeHistoryLocalClient()
        const probe = await client.probeMultiDeviceVisits()
        if (!probe?.supported) return null
        return createChromeHistoryConnector(client)
      } catch {
        return null
      }
    }
    return null
  }
  return new AttentionService({ policy, state, credentials, connectors, connectorFactory, now })
}

export async function runAttentionCommand({ root, args, output, input, keyStore, credentials, xdgStateHome, now } = {}) {
  const values = [...args]
  const subcommand = values.shift() || 'status'
  const json = takeFlag(values, '--json')
  const service = createAttentionService({ root, keyStore, credentials, xdgStateHome, now })

  if (subcommand === 'status') {
    if (values.length) throw new Error('usage: alambic attention status [--json]')
    render(service.status(), json, output, (result) => Object.entries(result.sources).map(([source, state]) => `${source}\t${state.capability?.status || 'disabled'}\tcandidates=${state.candidates}`).join('\n'))
    return
  }
  if (subcommand === 'auth-check') {
    const source = takeOption(values, '--source')
    if (!source || values.length) throw new Error('usage: alambic attention auth-check --source SOURCE [--json]')
    render(await service.authCheck(source), json, output, (result) => `${source}\t${result.status}\t${result.evidence}`)
    return
  }
  if (subcommand === 'env-check') {
    if (values.length) throw new Error('usage: alambic attention env-check [--json]')
    const result = inspectAttentionEnv()
    render(result, json, output, (entry) => [
      `backend\t${entry.backend}`,
      `youtube_ready\t${entry.youtube_ready}`,
      `x_bookmarks_keys_ready\t${entry.x_bookmarks_keys_ready}`,
      `x_bookmarks_api_ready\t${entry.x_bookmarks_api_ready}`,
      ...Object.entries(entry.youtube).map(([name, set]) => `${name}\t${set ? 'set' : 'unset'}`),
      ...Object.entries(entry.x_bookmarks).map(([name, set]) => `${name}\t${set ? 'set' : 'unset'}`),
    ].join('\n'))
    return
  }
  if (subcommand === 'env-template') {
    if (values.length) throw new Error('usage: alambic attention env-template [--json]')
    const { randomKey } = await import('./crypto.mjs')
    const template = {
      comment: 'Paste into ~/.zshrc (never commit). Restart shell or source ~/.zshrc.',
      exports: {
        ALAMBIC_YOUTUBE_CLIENT_ID: 'REPLACE_ME',
        ALAMBIC_YOUTUBE_CLIENT_SECRET: 'REPLACE_ME',
        ALAMBIC_YOUTUBE_REFRESH_TOKEN: 'REPLACE_ME_FROM_authorize_clipboard',
        ALAMBIC_ATTENTION_YOUTUBE_LIKED_DATA_KEY: randomKey(),
        ALAMBIC_ATTENTION_YOUTUBE_LIKED_HMAC_KEY: randomKey(),
        ALAMBIC_ATTENTION_X_BOOKMARKS_DATA_KEY: randomKey(),
        ALAMBIC_ATTENTION_X_BOOKMARKS_HMAC_KEY: randomKey(),
        ALAMBIC_ATTENTION_CHROME_HISTORY_DATA_KEY: randomKey(),
        ALAMBIC_ATTENTION_CHROME_HISTORY_HMAC_KEY: randomKey(),
        ALAMBIC_X_CLIENT_ID: 'REPLACE_ME_X_OAUTH2_CLIENT_ID',
        ALAMBIC_X_CLIENT_SECRET: 'REPLACE_ME_OPTIONAL_IF_PUBLIC_CLIENT',
        ALAMBIC_X_REFRESH_TOKEN: 'REPLACE_ME_X_OAUTH2_REFRESH_TOKEN',
        // Alternative short test path (expires): ALAMBIC_X_ACCESS_TOKEN
        ALAMBIC_ATTENTION_ALLOW_KEYCHAIN: '0',
      },
    }
    const shell = [
      '# alambic attention — local secrets (do not commit)',
      `# generated ${new Date().toISOString()}`,
      ...Object.entries(template.exports).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
      '',
    ].join('\n')
    if (json) render({ ...template, shell }, true, output)
    else output(shell, false)
    return
  }
  if (subcommand === 'authorize') {
    const source = takeOption(values, '--source')
    if (source !== 'youtube-liked' || values.length) throw new Error('usage: alambic attention authorize --source youtube-liked')
    await authorizeYouTube({ client: await service.credentials.client(source), output })
    return
  }
  if (subcommand === 'collect') {
    const source = takeOption(values, '--source')
    const enabled = takeFlag(values, '--enabled')
    const dryRun = takeFlag(values, '--dry-run')
    const summary = takeFlag(values, '--summary')
    if ((source && enabled) || (!source && !enabled) || values.length) throw new Error('usage: alambic attention collect --source SOURCE|--enabled [--dry-run] [--summary] [--json]')
    const result = source ? [await service.collect({ source, dryRun })] : await service.collectEnabled({ dryRun })
    const safeResult = summary ? collectionSummary(result) : result
    render(safeResult, json, output, (entries) => entries.map((entry) => `${entry.source}\t${entry.status}\taccepted=${entry.accepted}\trejected=${entry.rejected}\treplayed=${entry.replayed}`).join('\n') || '(empty) no enabled attention sources')
    return
  }
  if (subcommand === 'ingest') {
    const source = takeOption(values, '--source')
    const stdin = takeFlag(values, '--stdin')
    const dryRun = takeFlag(values, '--dry-run')
    const persist = takeFlag(values, '--persist')
    const confirm = takeFlag(values, '--confirm')
    const summary = takeFlag(values, '--summary')
    const dryMode = dryRun && !persist && !confirm
    const persistentXMode = source === 'x-bookmarks' && persist && confirm && !dryRun
    if (!['x-bookmarks', 'reddit-saved'].includes(source) || !stdin || !summary || !json || (!dryMode && !persistentXMode) || values.length) throw new Error('usage: alambic attention ingest --source x-bookmarks|reddit-saved --stdin --dry-run --summary --json | ingest --source x-bookmarks --stdin --persist --confirm --summary --json')
    const events = parseManualBrowserEvents(source, readManualInput(input))
    const dryRunKeyStore = new MemoryKeyStore()
    dryRunKeyStore.set(keyHandle(source, 'data'))
    dryRunKeyStore.set(keyHandle(source, 'hmac'))
    const manualService = dryMode
      ? createAttentionService({ root, keyStore: dryRunKeyStore, connectors: { [source]: createManualBrowserConnector(source, events) } })
      : service
    const connector = createManualBrowserConnector(source, events, { live: persistentXMode })
    const result = [await manualService.collect({ source, connector, dryRun: dryMode })]
    render(collectionSummary(result), true, output)
    return
  }
  if (subcommand === 'digest') {
    const limit = takeOption(values, '--limit', undefined)
    const query = takeOption(values, '--query', '')
    if (values.length) throw new Error('usage: alambic attention digest [--limit N] [--query TEXT] [--json]')
    const result = service.digest({ limit: limit == null ? undefined : Number(limit), query })
    render(result, json, output, formatDigest)
    return
  }
  if (subcommand === 'stage') {
    const dryRun = takeFlag(values, '--dry-run')
    const limit = takeOption(values, '--limit', undefined)
    const runId = takeOption(values, '--run-id', 'attention-daily')
    if (values.length) throw new Error('usage: alambic attention stage [--dry-run] [--limit N] [--run-id ID] [--json]')
    const result = service.stage({
      root,
      dryRun,
      runId,
      limit: limit == null ? undefined : Number(limit),
    })
    render(result, json, output, (entry) => `${entry.dry_run ? 'dry-run' : 'staged'}\t${entry.path}\tcount=${entry.staged}`)
    return
  }
  if (subcommand === 'promote') {
    const source = takeOption(values, '--source')
    const digest = takeOption(values, '--candidate')
    const confirm = takeFlag(values, '--confirm')
    if (!source || !digest || values.length) throw new Error('usage: alambic attention promote --source SOURCE --candidate DIGEST --confirm [--json]')
    const result = service.promote({ root, source, digest, confirm })
    render(result, json, output, (entry) => entry.ok ? `staged\t${entry.path}` : `refused\t${entry.reason}`)
    return
  }
  if (subcommand === 'compile') {
    const dryRun = takeFlag(values, '--dry-run')
    const limit = takeOption(values, '--limit', undefined)
    const runId = takeOption(values, '--run-id', 'attention-compile')
    if (values.length) throw new Error('usage: alambic attention compile [--dry-run] [--limit N] [--run-id ID] [--json]')
    const result = service.compile({
      root,
      dryRun,
      runId,
      limit: limit == null ? undefined : Number(limit),
    })
    render(result, json, output, (entry) => `${entry.dry_run ? 'dry-run' : 'compiled'}\t${entry.path}\tclaims=${entry.claims}\tempty=${entry.empty}`)
    return
  }
  if (subcommand === 'promote-suggest' || subcommand === 'materialize') {
    // materialize is an alias: attention → freeform-oracle-ready drafts for sidekick
    const confirm = takeFlag(values, '--confirm')
    const limit = takeOption(values, '--limit', undefined)
    if (values.length) throw new Error('usage: alambic attention promote-suggest|materialize [--confirm] [--limit N] [--json]')
    const result = service.promoteSuggest({
      root,
      confirm,
      limit: limit == null ? undefined : Number(limit),
    })
    render(result, json, output, (entry) => entry.ok
      ? `staged\tcount=${entry.staged?.length || 0}\tskipped=${Array.isArray(entry.skipped) ? entry.skipped.length : (entry.skipped || 0)}\twrote_kb=${entry.wrote_kb}`
      : `refused\t${entry.reason}\tmaterializable=${(entry.suggestions || []).filter((s) => s.materializable).length}`)
    return
  }
  if (subcommand === 'session-pack') {
    const maxTokens = Number(takeOption(values, '--max-tokens', '2500'))
    if (values.length) throw new Error('usage: alambic attention session-pack [--max-tokens N] [--json]')
    const pack = buildAttentionSessionPack({ root, status: service.status(), maxTokens })
    render(pack, json, output, (entry) => entry.text)
    return
  }
  if (subcommand === 'drop-list') {
    const source = takeOption(values, '--source', 'x-bookmarks')
    if (source !== 'x-bookmarks' || values.length) throw new Error('usage: alambic attention drop-list --source x-bookmarks [--json]')
    const files = listXDropFiles(root)
    render({ source, files: files.map((file) => path.basename(file)), count: files.length }, json, output, (entry) => entry.files.join('\n') || '(empty) no x-bookmarks drop files')
    return
  }
  if (subcommand === 'receipt') {
    const status = takeOption(values, '--status', 'ok')
    const note = takeOption(values, '--note', 'daily-run')
    if (values.length) throw new Error('usage: alambic attention receipt --status STATUS --note NOTE [--json]')
    const file = appendAttentionWorkflowEvent(root, {
      status,
      note,
      content_free: true,
    })
    render({ ok: true, file: path.relative(root, file) }, json, output, (entry) => `receipt\t${entry.file}`)
    return
  }
  if (subcommand === 'review') {
    const source = takeOption(values, '--source')
    const digest = takeOption(values, '--candidate')
    const decision = takeOption(values, '--decision')
    const reasonCode = takeOption(values, '--reason-code')
    if (!source || !digest || !decision || !reasonCode || values.length) throw new Error('usage: alambic attention review --source SOURCE --candidate DIGEST --decision accept|reject --reason-code CODE [--json]')
    render(service.review({ source, digest, decision, reasonCode }), json, output, (result) => `${result.source}\t${result.decision}\t${result.reviewed_at}`)
    return
  }
  if (subcommand === 'purge') {
    const source = takeOption(values, '--source', undefined)
    if (source) assertSource(source)
    if (values.length) throw new Error('usage: alambic attention purge [--source SOURCE] [--json]')
    render(service.purge(source), json, output)
    return
  }
  if (subcommand === 'disconnect') {
    const source = takeOption(values, '--source')
    const dryRun = takeFlag(values, '--dry-run')
    const confirm = takeFlag(values, '--confirm')
    if (!source || values.length || (!dryRun && !confirm)) throw new Error('usage: alambic attention disconnect --source SOURCE --dry-run|--confirm [--json]')
    render(await service.disconnect({ source, dryRun, confirm }), json, output)
    return
  }
  throw new Error('usage: alambic attention status|auth-check|env-check|env-template|authorize|collect|ingest|digest|stage|compile|promote|promote-suggest|materialize|session-pack|drop-list|receipt|review|purge|disconnect')
}
