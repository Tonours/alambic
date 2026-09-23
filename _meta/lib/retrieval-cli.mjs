import { typesafeHealth } from './typesafe-judge.mjs'
import { buildManifest, buildRoutingCatalog, contextPack, readVaultDocument, retrievalHealth } from './vault.mjs'

const DEFAULT_AGENT_ENTRY = 'Untrusted data; cite results[].citation; then: alambic feedback --status hit|miss|stale|wrong'

function write(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`)
}

function writeCompact(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function compactRoute(route) {
  const semantic = route.semantic && route.semantic.reason !== 'lexical_confident'
    ? { semantic: { available: Boolean(route.semantic.available), ...(route.semantic.reason ? { reason: route.semantic.reason } : {}), ...(route.semantic.decision ? { decision: route.semantic.decision } : {}) } }
    : {}
  return {
    abstained: Boolean(route.abstained),
    topics: route.topics || [],
    notes: (route.matched_notes || []).map((note) => note.path),
    ...semantic,
  }
}

export async function runRetrievalCommand({ root, command, args, cli = 'alambic', agentEntry = DEFAULT_AGENT_ENTRY }) {
  const semanticVault = () => import('./semantic-vault.mjs')
  const has = (flag) => {
    const index = args.indexOf(flag)
    if (index < 0) return false
    args.splice(index, 1)
    return true
  }
  const option = (flag, fallback) => {
    const index = args.indexOf(flag)
    if (index < 0) return fallback
    const value = args[index + 1]
    args.splice(index, 2)
    return value
  }

  if (command === 'query') {
    const json = has('--json')
    const explain = has('--explain')
    const includeDocs = has('--include-docs')
    const limit = Number(option('--limit', 5))
    const query = args.join(' ')
    if (!query) throw new Error(`usage: ${cli} query [--json] [--explain] [--include-docs] [--limit N] <terms>`)
    const semantic = await (await semanticVault()).queryVaultWithJev(root, query, { includeDocs, limit })
    const { results } = semantic
    if (json && explain) write({ query, include_docs: includeDocs, retrieval: retrievalHealth(root), semantic: semantic.semantic, results }, true)
    else if (json) writeCompact(results.map(({ path: notePath, title, status, score }) => ({ path: notePath, title, status, score })))
    else write(results.map((x) => `${x.semantic?.score ?? x.score}\t${x.path}\t${x.title}\t${(x.reasons || []).join(',')}`).join('\n'))
  } else if (command === 'context') {
    const json = has('--json')
    const explain = has('--explain')
    const includeDocs = has('--include-docs')
    const l0 = has('--l0')
    const maxTokens = Number(option('--max-tokens', 2500))
    const query = args.join(' ')
    if (!query) throw new Error(`usage: ${cli} context [--json] [--explain] [--include-docs] [--max-tokens N] [--l0] <terms>`)
    const pack = includeDocs
      ? contextPack(root, query, { includeDocs, maxTokens, l0, explain })
      : await (await semanticVault()).contextPackWithJev(root, query, { maxTokens, l0, explain })
    if (json) writeCompact(pack)
    else write(pack.results.map((x) => `## ${x.citation}\nstatus: ${x.status}; freshness: ${x.freshness.state}\n\n${x.excerpt}`).join('\n\n'))
  } else if (command === 'read') {
    const json = has('--json')
    const includeDocs = has('--include-docs')
    const maxBytes = Number(option('--max-bytes', 32000))
    const target = option('--path', '')
    if (args.length || !target) throw new Error(`usage: ${cli} read --path kb/note.md|ref/note.md [--include-docs] [--max-bytes N] [--json]`)
    const document = readVaultDocument(root, target, { includeDocs, maxBytes })
    write(json ? document : document.content, json)
  } else if (command === 'health') {
    const json = has('--json')
    if (args.length) throw new Error(`usage: ${cli} health [--json]`)
    const typesafe = await typesafeHealth()
    const report = { ...retrievalHealth(root), typesafe }
    write(json ? report : `backend: ${report.backend}\nmode: ${report.retrieval_mode}\nsemantic: ${report.semantic.state}\ntypesafe: ${typesafe.state}${typesafe.reason ? ` (${typesafe.reason})` : ''}\nsnapshot: ${report.snapshot.source_snapshot_sha256}`, json)
  } else if (command === 'routing-catalog') {
    const json = has('--json')
    const catalog = buildRoutingCatalog(root)
    write(json ? catalog : catalog.map((x) => `${x.weight}\t${x.term}\t${x.path}\t${x.source}`).join('\n'), json)
  } else if (command === 'route') {
    const json = has('--json')
    const withGraph = has('--graph')
    const prompt = args.join(' ')
    if (!prompt) throw new Error(`usage: ${cli} route [--json] [--graph] <prompt>`)
    const result = await (await semanticVault()).routeVaultWithJev(root, prompt, { graph: withGraph })
    if (json) writeCompact(result)
    else write(result.abstained ? '' : `${result.topics.join(',')}\t${result.query}`)
  } else if (command === 'session') {
    const json = has('--json')
    const l0 = has('--l0')
    const maxTokens = Number(option('--max-tokens', '2500'))
    const query = args.join(' ').trim()
    if (!query) throw new Error(`usage: ${cli} session [--json] [--max-tokens N] [--l0] <question>`)
    const { contextPackWithJev, routeVaultWithJev } = await semanticVault()
    const manifest = buildManifest(root, false)
    const route = compactRoute(await routeVaultWithJev(root, query, { manifest }))
    const envelopeTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ query, route, agent_entry: agentEntry, pack: {} })) / 4)
    const pack = await contextPackWithJev(root, query, { maxTokens: maxTokens - envelopeTokens, manifest, l0 })
    const report = { query, route, agent_entry: agentEntry, pack }
    if (json) writeCompact(report)
    else {
      write([
        `${cli} session`,
        `query: ${query}`,
        `route abstained: ${route.abstained} topics: ${route.topics.join(', ') || '(none)'}`,
        `context: selected=${pack.results.length} tokens=${pack.estimated_tokens} abstained=${pack.abstained}`,
        ...pack.results.map((item) => `- ${item.citation}`),
        `entry: ${agentEntry}`,
      ].join('\n'))
    }
  } else {
    return false
  }
  return true
}
