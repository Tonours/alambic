#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  choice,
  noul,
  score,
} from '@typesafe-ai/sdk'
import { augmentRouteWithGraph } from '../lib/graph-router.mjs'
import {
  contextPackWithJev,
  expandTopics,
  queryVaultWithJev,
  rerankVaultResults,
  routeVaultWithJev,
  topicQuestion,
  topicVocabulary,
} from '../lib/semantic-vault.mjs'
import { appendTags, candidateTags, enrichVault } from '../lib/enrich.mjs'
import { askJev, TYPESAFE_MODEL, typesafeHealth, validateTypesafeRequest } from '../lib/typesafe-judge.mjs'
import { buildManifest, contextPack, queryVault, routeVaultKnowledge, validateVault } from '../lib/vault.mjs'

function answerFor(id, question) {
  if (question.type === 'noul') return { type: 'noul', noul: id.startsWith('instruction_') ? 0.05 : 0.86 }
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria)
    const preferred = labels.find((label) => label !== 'no_match' && label !== 'irrelevant') || labels[0]
    const rest = labels.length > 1 ? 0.08 / (labels.length - 1) : 0
    return {
      type: 'choice',
      choice: preferred,
      confidence: 0.92,
      probabilities: Object.fromEntries(labels.map((label) => [label, label === preferred ? 0.92 : rest])),
    }
  }
  const labels = question.criteria.map((_, index) => String(index))
  const probabilities = Object.fromEntries(labels.map((label, index) => [label, index === labels.length - 1 ? 0.8 : 0.2 / (labels.length - 1)]))
  return { type: 'score', score: labels.length - 1.2, confidence: 0.8, legend: Object.fromEntries(question.criteria.map((value, index) => [index, value])), probabilities }
}

function fakeClient({ mutate } = {}) {
  return {
    calls: 0,
    async systemOne(request) {
      this.calls += 1
      const result = {
        model: TYPESAFE_MODEL,
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerFor(id, question)])),
        usage: { input_tokens: 120, output_tokens: 20 },
      }
      return mutate ? mutate(result, request) : result
    },
  }
}

function writeNote(dir, name, { title, summary, tags, body }) {
  fs.writeFileSync(path.join(dir, name), `---
type: finding
status: verified
summary: "${summary}"
sources:
  - "https://docs.example.org/typesafe-fixture"
created: 2026-09-18
updated: 2026-09-18
tags:
${tags.map((tag) => `  - ${tag}`).join('\n')}
---

# ${title}

${body}
`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-typesafe-'))
const kb = path.join(tmp, 'kb')
const ref = path.join(tmp, 'ref')
const inbox = path.join(tmp, 'docs', 'inbox', 'ai')
fs.mkdirSync(kb, { recursive: true })
fs.mkdirSync(ref, { recursive: true })
fs.mkdirSync(inbox, { recursive: true })
fs.mkdirSync(path.join(tmp, '_meta'), { recursive: true })
fs.writeFileSync(path.join(kb, '_index.md'), '# Index\n')
writeNote(kb, 'rollback-recovery.md', {
  title: 'Rollback recovery',
  summary: 'Recover failed delivery safely with a bounded rollback procedure.',
  tags: ['delivery', 'recovery'],
  body: 'A failed delivery should preserve evidence, run rollback, and verify the restored service.',
})
writeNote(kb, 'delivery-observability.md', {
  title: 'Delivery observability',
  summary: 'Observe failed delivery and recovery with explicit runtime evidence.',
  tags: ['delivery', 'observability'],
  body: 'Record deployment failure, recovery state, and the terminal verification result.',
})

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
for (const file of [...fs.readdirSync(path.join(repoRoot, '_meta/lib')).map((name) => path.join(repoRoot, '_meta/lib', name)), path.join(repoRoot, '_meta/alambic.mjs'), path.join(repoRoot, '_meta/mcp/server.mjs')]) {
  if (!file.endsWith('.mjs')) continue
  assert.equal(/^import[^\n]*['"]@typesafe-ai\/sdk['"]/m.test(fs.readFileSync(file, 'utf8')), false, `${path.relative(repoRoot, file)} must load @typesafe-ai/sdk lazily inside askJev, never at module top`)
}

assert.equal(/^import[^\n]*semantic-vault\.mjs['"]/m.test(fs.readFileSync(path.join(repoRoot, '_meta/alambic.mjs'), 'utf8')), false, 'alambic.mjs must load semantic-vault.mjs only inside the retrieval branches so health stays independent')

const expansionRequest = { state: { query: 'q'.repeat(500) }, questions: { topic: topicQuestion(topicVocabulary(buildManifest(repoRoot, false))) } }
assert.doesNotThrow(() => validateTypesafeRequest(expansionRequest.state, expansionRequest.questions), 'topic expansion over the real tag vocabulary must fit TypeSafe request ceilings')

const defaultClient = fakeClient()
const enabledByDefault = await askJev({ state: { text: 'safe fixture' }, questions: { relevant: noul('Is `text` relevant?') } }, { env: {}, client: defaultClient })
assert.equal(enabledByDefault.available, true)
assert.equal(defaultClient.calls, 1)
const seamDisabledClient = fakeClient()
const seamDisabled = await askJev({ state: { text: 'safe fixture' }, questions: { relevant: noul('Is `text` relevant?') } }, { enabled: false, env: { ALAMBIC_TYPESAFE_ENABLED: '1' }, client: seamDisabledClient })
assert.equal(seamDisabled.reason, 'disabled')
assert.equal(seamDisabledClient.calls, 0)
const envCannotDisable = await askJev({ state: { text: 'safe fixture' }, questions: { relevant: noul('Is `text` relevant?') } }, { env: { ALAMBIC_TYPESAFE_ENABLED: '0' }, client: fakeClient() })
assert.equal(envCannotDisable.available, true)

const missingCredential = await askJev({ state: { text: 'safe fixture' }, questions: { relevant: noul('Is `text` relevant?') } }, { enabled: true, env: {} })
assert.equal(missingCredential.reason, 'credential_missing')

const modelOverride = await askJev({ state: { text: 'safe fixture' }, questions: { relevant: noul('Is `text` relevant?') } }, {
  enabled: true,
  env: { ALAMBIC_TYPESAFE_MODEL: 'jev-9.9.9' },
  client: fakeClient(),
})
assert.equal(modelOverride.reason, 'invalid_configuration')
assert.equal((await typesafeHealth({ ALAMBIC_TYPESAFE_MODEL: 'jev-latest' })).reason, 'invalid_configuration')
assert.equal((await typesafeHealth({})).reason, 'credential_missing')
assert.equal((await typesafeHealth({ TYPESAFE_API_KEY: 'health-fixture' })).state, 'active')

const successClient = fakeClient()
const success = await askJev({
  state: { message: 'A rollback restored service.' },
  questions: {
    recovered: noul('Did recovery complete?'),
    status: choice('What is the status?', { recovered: null, failing: null }),
    severity: score('How severe is the current impact?', ['None', 'Limited', 'Major']),
  },
}, { enabled: true, client: successClient, env: {} })
assert.equal(success.available, true)
assert.deepEqual(Object.values(success.answers).map((answer) => answer.type), ['noul', 'choice', 'score'])

const normalized = await askJev({ state: { text: 'safe' }, questions: { relevant: noul('Is `text` relevant?') } }, {
  enabled: true,
  env: {},
  client: fakeClient({
    mutate(result) {
      return {
        ...result,
        provider_debug: 'must not escape',
        answers: { relevant: { ...result.answers.relevant, provider_text: 'must not escape' } },
      }
    },
  }),
})
assert.equal(JSON.stringify(normalized).includes('must not escape'), false)

const unsafeClient = fakeClient()
const unsafe = await askJev({ state: { text: `sk-${'a'.repeat(30)}` }, questions: { relevant: noul('Is `text` relevant?') } }, { enabled: true, client: unsafeClient, env: {} })
assert.equal(unsafe.reason, 'unsafe_input')
assert.equal(unsafeClient.calls, 0)

const unsafeQuestionClient = fakeClient()
const unsafeQuestion = await askJev({
  state: { text: 'safe fixture' },
  questions: { relevant: choice('Which label applies?', { safe: null, leaked: `sk-${'b'.repeat(30)}` }) },
}, { enabled: true, client: unsafeQuestionClient, env: {} })
assert.equal(unsafeQuestion.reason, 'unsafe_input')
assert.equal(unsafeQuestionClient.calls, 0)

const oversizedQuestionClient = fakeClient()
const oversizedQuestion = await askJev({
  state: { text: 'safe fixture' },
  questions: { relevant: noul(`Is this relevant? ${'x'.repeat(36_000)}`) },
}, { enabled: true, client: oversizedQuestionClient, env: {} })
assert.equal(oversizedQuestion.reason, 'invalid_request')
assert.equal(oversizedQuestionClient.calls, 0)

const malformed = await askJev({ state: { text: 'safe' }, questions: { relevant: noul('Is `text` relevant?') } }, {
  enabled: true,
  env: {},
  client: fakeClient({ mutate: (result) => ({ ...result, model: 'jev-latest' }) }),
})
assert.equal(malformed.reason, 'invalid_response')

const inconsistentChoice = await askJev({ state: { text: 'safe' }, questions: { route: choice('Which route?', { first: null, second: null }) } }, {
  enabled: true,
  env: {},
  client: fakeClient({
    mutate(result) {
      return {
        ...result,
        answers: { route: { type: 'choice', choice: 'first', confidence: 0.9, probabilities: { first: 0.1, second: 0.9 } } },
      }
    },
  }),
})
assert.equal(inconsistentChoice.reason, 'invalid_response')

const throwing = await askJev({ state: { text: 'safe' }, questions: { relevant: noul('Is `text` relevant?') } }, {
  enabled: true,
  env: {},
  client: { async systemOne() { throw new Error('provider echoed private payload: safe') } },
})
assert.equal(throwing.reason, 'provider_unavailable')
assert.equal(JSON.stringify(throwing).includes('private payload'), false)

for (const [error, reason] of [
  [new AuthenticationError(401, { detail: 'private auth detail' }, new Headers()), 'authentication_failed'],
  [new RateLimitError(429, { detail: 'private rate detail' }, new Headers()), 'rate_limited'],
  [new APITimeoutError(1_000), 'timeout'],
  [new APIConnectionError('private connection detail'), 'connection_failed'],
  [new APIError(500, { detail: 'private provider detail' }, new Headers()), 'provider_rejected'],
]) {
  const failure = await askJev({ state: { text: 'safe' }, questions: { relevant: noul('Is `text` relevant?') } }, {
    enabled: true,
    env: {},
    client: { async systemOne() { throw error } },
  })
  assert.equal(failure.reason, reason)
  assert.equal(JSON.stringify(failure).includes('private'), false)
}

const auditFile = path.join(tmp, 'provider-audit.jsonl')
await askJev({ state: { text: 'safe' }, questions: { relevant: noul('Is `text` relevant?') } }, {
  enabled: true,
  env: { ALAMBIC_TYPESAFE_AUDIT_FILE: auditFile },
  client: fakeClient(),
})
assert.equal(fs.readFileSync(auditFile, 'utf8').trim(), '{"event":"provider_call"}')

const lexical = queryVault(tmp, 'failed delivery recovery evidence', { limit: 8 })
assert.ok(lexical.length >= 2)
const rerankClient = fakeClient({
  mutate(result) {
    return {
      ...result,
      answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
        if (answer.type !== 'noul' || id.startsWith('instruction_')) return [id, answer]
        return [id, { ...answer, noul: id.endsWith('_0') ? 0.96 : 0.4 }]
      })),
    }
  },
})
const reranked = await rerankVaultResults(tmp, 'failed delivery recovery evidence', lexical, { enabled: true, client: rerankClient, env: {} })
assert.equal(reranked.semantic.available, true)
assert.equal(rerankClient.calls, 1)
assert.equal(reranked.semantic.decision, 'confirm_lexical')
assert.ok(reranked.results.every((result) => result.semantic?.score >= 0))

const failedRerank = await rerankVaultResults(tmp, 'failed delivery recovery evidence', lexical, {
  enabled: true,
  client: { async systemOne() { throw new APITimeoutError(1_000) } },
  env: {},
})
assert.equal(failedRerank.semantic.reason, 'timeout')
assert.deepEqual(failedRerank.results.map((result) => result.path), lexical.map((result) => result.path))

const ambiguousRerank = await rerankVaultResults(tmp, 'failed delivery recovery evidence', lexical, {
  enabled: true,
  client: fakeClient({
    mutate(result) {
      return {
        ...result,
        answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, answer.type === 'noul' ? { ...answer, noul: 0.51 } : answer])),
      }
    },
  }),
  env: {},
})
assert.equal(ambiguousRerank.semantic.reason, 'low_confidence')
assert.equal(ambiguousRerank.semantic.decision, 'preserve_lexical')
assert.deepEqual(ambiguousRerank.results.map((result) => result.path), lexical.map((result) => result.path))

function passageClient({ first, second }) {
  return fakeClient({
    mutate(result) {
      return {
        ...result,
        answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
          if (answer.type !== 'noul') return [id, answer]
          if (id.startsWith('instruction_')) return [id, { ...answer, noul: 0.02 }]
          const index = Number(id.split('_').at(-1))
          return [id, { ...answer, noul: index === 0 ? first : index === 1 ? second : 0.1 }]
        })),
      }
    },
  })
}

const confidentMove = await rerankVaultResults(tmp, 'failed delivery recovery evidence', lexical, { enabled: true, client: passageClient({ first: 0.4, second: 0.95 }), env: {} })
assert.equal(confidentMove.semantic.decision, 'rerank')
assert.equal(confidentMove.results[0].path, lexical[1].path)
assert.deepEqual(confidentMove.results.slice(1).map((result) => result.path), lexical.filter((result) => result.path !== lexical[1].path).map((result) => result.path))

const narrowMargin = await rerankVaultResults(tmp, 'failed delivery recovery evidence', lexical, { enabled: true, client: passageClient({ first: 0.82, second: 0.9 }), env: {} })
assert.equal(narrowMargin.semantic.decision, 'preserve_lexical')
assert.equal(narrowMargin.semantic.reason, 'low_confidence')
assert.deepEqual(narrowMargin.results.map((result) => result.path), lexical.map((result) => result.path))

const exactClient = fakeClient()
const exact = await queryVaultWithJev(tmp, 'Rollback recovery', { enabled: true, client: exactClient, env: {} })
assert.equal(exactClient.calls, 0)
assert.equal(exact.semantic.reason, 'exact_lexical_match')

for (let index = 0; index < 60; index += 1) {
  writeNote(kb, `limit-fixture-${index}.md`, {
    title: `Semantic limit fixture ${index}`,
    summary: 'A repeated fixture used only to prove result-limit normalization.',
    tags: ['limit-fixture'],
    body: 'Semantic limit normalization fixture.',
  })
}
const limitManifest = buildManifest(tmp, false, { fresh: true })
for (const [limit, expected] of [['nope', 5], [-4, 5], [Infinity, 5], [Number.NaN, 5], [2.8, 2], [500, 50]]) {
  const normalizedLimit = await queryVaultWithJev(tmp, 'semantic limit fixture', { limit, manifest: limitManifest, enabled: true, client: fakeClient(), env: {} })
  assert.equal(normalizedLimit.results.length, expected)
}

const contextClient = fakeClient()
const pack = await contextPackWithJev(tmp, 'failed delivery recovery evidence', { maxTokens: 1200, enabled: true, client: contextClient, env: {} })
assert.ok(Array.isArray(pack.results))
assert.ok(pack.results.length >= 1)

const failedContext = await contextPackWithJev(tmp, 'failed delivery recovery evidence', {
  maxTokens: 1200,
  enabled: true,
  client: { async systemOne() { throw new APITimeoutError(1_000) } },
  env: {},
})
assert.equal(failedContext.retrieval.semantic.reason, 'timeout')
const failedContextCandidates = queryVault(tmp, 'failed delivery recovery evidence', { limit: 8 })
const lexicalContext = contextPack(tmp, 'failed delivery recovery evidence', { maxTokens: 1200, durableResults: failedContextCandidates })
assert.deepEqual(failedContext.results, lexicalContext.results)
assert.deepEqual(failedContext.excluded, lexicalContext.excluded)

function topicClient(pick) {
  return fakeClient({
    mutate(result, request) {
      if (!request.questions.topic) return result
      const labels = Object.keys(request.questions.topic.criteria)
      const probabilities = pick(labels)
      const choiceLabel = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0]
      return { ...result, answers: { ...result.answers, topic: { type: 'choice', choice: choiceLabel, confidence: probabilities[choiceLabel], probabilities } } }
    },
  })
}
const spread = (labels, winner, share) => Object.fromEntries(labels.map((label) => [label, label === winner ? share : (1 - share) / (labels.length - 1)]))

const routePrompt = 'failed preserve evidence restored service'
const lexicalRoute = routeVaultKnowledge(tmp, routePrompt)
assert.equal(lexicalRoute.abstained, true)
const routeClient = topicClient((labels) => spread(labels, 'delivery', 0.9))
const semanticRoute = await routeVaultWithJev(tmp, routePrompt, { enabled: true, client: routeClient, env: {} })
assert.equal(semanticRoute.abstained, false)
assert.equal(semanticRoute.semantic.decision, 'expand')
assert.deepEqual(semanticRoute.semantic.topics, ['delivery'])
assert.deepEqual(semanticRoute.semantic.usage, { input_tokens: 120, output_tokens: 20 })
assert.ok(Number.isFinite(semanticRoute.semantic.latency_ms))

const failedRoute = await routeVaultWithJev(tmp, routePrompt, {
  enabled: true,
  client: { async systemOne() { throw new APITimeoutError(1_000) } },
  env: {},
})
assert.equal(failedRoute.abstained, true)
assert.equal(failedRoute.semantic.reason, 'timeout')

const noMatchRoute = await routeVaultWithJev(tmp, routePrompt, { enabled: true, env: {}, client: topicClient((labels) => spread(labels, 'no_match', 0.91)) })
assert.equal(noMatchRoute.abstained, true)
assert.equal(noMatchRoute.semantic.decision, 'no_match')

const flatRoute = await routeVaultWithJev(tmp, routePrompt, { enabled: true, env: {}, client: topicClient((labels) => Object.fromEntries(labels.map((label) => [label, label === 'no_match' ? 1 - 0.12 * (labels.length - 1) : 0.12]))) })
assert.equal(flatRoute.abstained, true)
assert.equal(flatRoute.semantic.decision, 'no_match')

const confidentClient = fakeClient()
const confidentRoute = await routeVaultWithJev(tmp, 'rollback recovery', { enabled: true, env: {}, client: confidentClient })
assert.equal(confidentRoute.semantic.reason, 'lexical_confident')
assert.equal(confidentClient.calls, 0)

const vocabulary = topicVocabulary(buildManifest(tmp, false, { fresh: true }))
assert.ok(vocabulary.includes('delivery'))
const memoClient = topicClient((labels) => spread(labels, 'delivery', 0.9))
const expansionA = await expandTopics('memo fixture query', buildManifest(tmp, false), { enabled: true, env: {}, client: memoClient })
assert.deepEqual(expansionA.topics, ['delivery'])

const graphAugmented = augmentRouteWithGraph(tmp, {
  abstained: false,
  topics: [],
  query: 'delivery recovery',
  matched_notes: [{ path: 'kb/rollback-recovery.md', status: 'verified', score: 90, terms: [] }],
}, {
  nodes: {
    'kb/rollback-recovery.md': { status: 'verified', pagerank: 0.6 },
    'kb/delivery-observability.md': { status: 'verified', pagerank: 0.4 },
  },
  edges: [{ source: 'kb/rollback-recovery.md', target: 'kb/delivery-observability.md' }],
})
assert.equal(graphAugmented.graph_propagated_notes[0].path, 'kb/delivery-observability.md')

writeNote(ref, 'critical-facts.md', {
  title: 'Critical facts snapshot',
  summary: 'A stable operator profile captured with the semantic session manifest.',
  tags: ['profile', 'snapshot'],
  body: 'Original L0 snapshot content for the semantic session.',
})
writeNote(kb, 'graph-snapshot-neighbor.md', {
  title: 'Graph snapshot neighbor',
  summary: 'A deliberately unrelated note used to prove graph snapshot timing.',
  tags: ['graph-snapshot-neighbor'],
  body: 'This note must not appear through a link created during the provider wait.',
})
const sharedManifest = buildManifest(tmp, false, { fresh: true })
writeNote(kb, 'post-snapshot.md', {
  title: 'Post snapshot only',
  summary: 'A unique post snapshot semantic routing target.',
  tags: ['post-snapshot-only'],
  body: 'This note must remain invisible to a semantic session using an earlier manifest snapshot.',
})
const snapshotRoute = await routeVaultWithJev(tmp, 'post snapshot only', {
  manifest: sharedManifest,
  enabled: true,
  client: fakeClient(),
  env: {},
})
assert.equal(snapshotRoute.matched_notes.some((note) => note.path === 'kb/post-snapshot.md'), false)

const rollbackBeforeGraphMutation = fs.readFileSync(path.join(kb, 'rollback-recovery.md'), 'utf8')
const graphSnapshotContext = await contextPackWithJev(tmp, 'failed delivery recovery evidence', {
  manifest: sharedManifest,
  maxTokens: 1200,
  enabled: true,
  client: fakeClient({
    mutate(result) {
      fs.writeFileSync(path.join(kb, 'rollback-recovery.md'), `${rollbackBeforeGraphMutation}\n\n[[graph-snapshot-neighbor]]\n`)
      return result
    },
  }),
  env: {},
})
assert.equal(graphSnapshotContext.results.some((result) => result.path === 'kb/graph-snapshot-neighbor.md'), false)
fs.writeFileSync(path.join(kb, 'rollback-recovery.md'), rollbackBeforeGraphMutation)

const manifestWithoutL0 = sharedManifest.filter((note) => note.path !== 'ref/critical-facts.md')
const missingSnapshotL0 = await contextPackWithJev(tmp, 'failed delivery recovery evidence', {
  manifest: manifestWithoutL0,
  maxTokens: 1200,
  l0: true,
  enabled: true,
  client: fakeClient(),
  env: {},
})
assert.equal(missingSnapshotL0.l0.pinned, false)
assert.equal(missingSnapshotL0.l0.reason, 'missing')

const replacementMarker = `sk-${'z'.repeat(30)}`
const rollbackPath = path.join(kb, 'rollback-recovery.md')
const rollbackSnapshot = fs.readFileSync(rollbackPath, 'utf8')
const l0Path = path.join(ref, 'critical-facts.md')
const l0Snapshot = fs.readFileSync(l0Path, 'utf8')
fs.writeFileSync(rollbackPath, `# Replaced after snapshot\n\n${replacementMarker}\n`)
fs.writeFileSync(l0Path, `# Replaced L0 after snapshot\n\n${replacementMarker}\n`)
const snapshotContext = await contextPackWithJev(tmp, 'failed delivery recovery evidence', {
  manifest: sharedManifest,
  maxTokens: 1200,
  l0: true,
  enabled: true,
  client: fakeClient(),
  env: {},
})
assert.equal(snapshotContext.retrieval.semantic.available, true)
assert.equal(JSON.stringify(snapshotContext).includes(replacementMarker), false)
assert.ok(snapshotContext.l0.excerpt.includes('Original L0 snapshot content'))
fs.writeFileSync(rollbackPath, rollbackSnapshot)
fs.writeFileSync(l0Path, l0Snapshot)

const timeoutClient = { async systemOne() { throw new APITimeoutError(1_000) } }
const failedSession = {
  context: await contextPackWithJev(tmp, routePrompt, { manifest: sharedManifest, maxTokens: 1200, enabled: true, client: timeoutClient, env: {} }),
  route: await routeVaultWithJev(tmp, routePrompt, { manifest: sharedManifest, enabled: true, client: timeoutClient, env: {} }),
}
assert.equal(failedSession.route.semantic.reason, 'timeout')
const lexicalSessionCandidates = queryVault(tmp, routePrompt, { limit: 8, manifest: sharedManifest })
const lexicalSessionContext = contextPack(tmp, routePrompt, { maxTokens: 1200, manifest: sharedManifest, durableResults: lexicalSessionCandidates })
assert.deepEqual(failedSession.context.results, lexicalSessionContext.results)
assert.deepEqual(failedSession.route.matched_notes, routeVaultKnowledge(tmp, routePrompt, { manifest: sharedManifest }).matched_notes)

const missingClient = topicClient((labels) => spread(labels, 'no_match', 0.95))
const missingQuery = await queryVaultWithJev(tmp, 'zzzxqv unmatched', { manifest: sharedManifest, enabled: true, client: missingClient, env: {} })
const missingContext = await contextPackWithJev(tmp, 'zzzxqv unmatched', { manifest: sharedManifest, maxTokens: 512, enabled: true, client: missingClient, env: {} })
const missingRoute = await routeVaultWithJev(tmp, 'zzzxqv unmatched', { manifest: sharedManifest, enabled: true, client: missingClient, env: {} })
assert.deepEqual(missingQuery.results, [])
assert.equal(missingQuery.semantic.decision, 'no_match')
assert.equal(missingContext.abstained, true)
assert.equal(missingRoute.abstained, true)
assert.equal(missingClient.calls, 3)

const expansionOnlyClient = fakeClient({
  mutate(result, request) {
    if (request.questions.topic) {
      const labels = Object.keys(request.questions.topic.criteria)
      const probabilities = spread(labels, 'delivery', 0.9)
      return { ...result, answers: { topic: { type: 'choice', choice: 'delivery', confidence: 0.9, probabilities } } }
    }
    return { ...result, answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, { ...answer, noul: id.startsWith('instruction_') ? 0.02 : 0.2 }])) }
  },
})
const gatedExpansion = await queryVaultWithJev(tmp, 'zzzxqv unmatched', { manifest: sharedManifest, enabled: true, client: expansionOnlyClient, env: {} })
assert.deepEqual(gatedExpansion.results, [], 'expansion-only candidates must pass the semantic relevance floor')
assert.equal(expansionOnlyClient.calls, 2)

const unreadableClient = fakeClient()
const unreadable = await rerankVaultResults(tmp, 'delivery recovery', [{ ...lexical[0], path: 'kb/missing.md' }], {
  manifest: sharedManifest,
  enabled: true,
  client: unreadableClient,
  env: {},
})
assert.equal(unreadable.semantic.reason, 'candidate_read_failed')
assert.equal(unreadableClient.calls, 0)

for (const value of [queryVault(tmp, 'delivery'), contextPack(tmp, 'delivery', { maxTokens: 512 }), routeVaultKnowledge(tmp, 'delivery')]) {
  assert.notEqual(typeof value?.then, 'function', 'existing lexical exports must remain synchronous')
}

const cliAudit = path.join(tmp, 'cli-provider-audit.jsonl')
const cliState = path.join(tmp, 'cli-state')
fs.mkdirSync(cliState, { recursive: true })
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../alambic.mjs')
const { TYPESAFE_API_KEY: ignoredTypesafeKey, ...environmentWithoutTypesafeKey } = process.env
void ignoredTypesafeKey
for (const command of [
  ['query', '--json', 'delivery recovery'],
  ['context', '--json', '--max-tokens', '512', 'delivery recovery'],
  ['session', '--json', '--max-tokens', '512', 'delivery recovery'],
  ['route', '--json', 'delivery recovery'],
]) {
  const run = spawnSync(process.execPath, [cli, ...command], {
    encoding: 'utf8',
    env: { ...environmentWithoutTypesafeKey, ALAMBIC_ROOT: tmp, XDG_STATE_HOME: cliState, ALAMBIC_TYPESAFE_AUDIT_FILE: cliAudit },
  })
  assert.equal(run.status, 0, `${command[0]} default CLI failed: ${run.stderr}`)
  assert.equal(run.stdout.includes('fixture-key'), false)
}
assert.equal(fs.existsSync(cliAudit), false, 'without a credential the default CLI must degrade before any provider call')

const unavailableCli = spawnSync(process.execPath, [cli, 'query', '--explain', '--json', 'failed delivery recovery evidence'], {
  encoding: 'utf8',
  env: { ...environmentWithoutTypesafeKey, ALAMBIC_ROOT: tmp, XDG_STATE_HOME: cliState },
})
assert.equal(unavailableCli.status, 0, `Jev fallback CLI failed: ${unavailableCli.stderr}`)
const unavailableCliResult = JSON.parse(unavailableCli.stdout)
assert.equal(unavailableCliResult.semantic.reason, 'credential_missing')
assert.deepEqual(unavailableCliResult.results.map((result) => result.path), queryVault(tmp, 'failed delivery recovery evidence', { limit: 8 }).slice(0, 5).map((result) => result.path))

const sessionRun = spawnSync(process.execPath, [cli, 'session', '--json', '--max-tokens', '600', 'failed delivery recovery evidence'], {
  encoding: 'utf8',
  env: { ...environmentWithoutTypesafeKey, ALAMBIC_ROOT: tmp, XDG_STATE_HOME: cliState },
})
assert.equal(sessionRun.status, 0, sessionRun.stderr)
assert.ok(Buffer.byteLength(sessionRun.stdout.trim()) / 4 <= 600, 'session output must stay within its whole-envelope token cap')

const enrichRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-enrich-'))
for (const dir of ['kb', 'ref', 'docs', '_meta']) fs.mkdirSync(path.join(enrichRoot, dir), { recursive: true })
fs.copyFileSync(path.join(repoRoot, '_meta/note.schema.json'), path.join(enrichRoot, '_meta/note.schema.json'))
for (const file of ['CLAUDE.md', 'AGENTS.md', 'README.md']) fs.writeFileSync(path.join(enrichRoot, file), '# fixture\n')
fs.copyFileSync(path.join(repoRoot, 'ref/knowledge-health.base'), path.join(enrichRoot, 'ref/knowledge-health.base'))
const enrichNote = (name, tags, body) => fs.writeFileSync(path.join(enrichRoot, 'kb', `${name}.md`), `---\ntype: finding\nstatus: verified\nsummary: "Enrichment fixture ${name}"\nsources:\n  - "https://example.org/${name}"\ncreated: 2026-09-23\nupdated: 2026-09-23\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\n---\n\n# ${name}\n\n${body}\n`)
enrichNote('memory-loop', ['agents'], 'Agent memory across sessions relies on retrieval. [[memory-store]]')
enrichNote('memory-store', ['agent-memory', 'retrieval'], 'Durable store for retrieval.')
fs.writeFileSync(path.join(enrichRoot, 'kb/_index.md'), '# Index\n\n- [[memory-loop]]\n- [[memory-store]]\n')
const loopNote = buildManifest(enrichRoot, false, { fresh: true }).find((note) => note.path === 'kb/memory-loop.md')
assert.deepEqual(candidateTags(loopNote, ['agents', 'agent-memory', 'retrieval'], [{ tags: ['agent-memory', 'retrieval'] }]), ['agent-memory', 'retrieval'])
assert.match(appendTags(loopNote.raw, ['agent-memory']), /tags:\n  - agents\n  - agent-memory\n---/)
const enrichClient = fakeClient({
  mutate(result, request) {
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id], index) => [id, { type: 'noul', noul: index === 0 ? 0.93 : 0.4 }]))
    return { ...result, answers }
  },
})
const dryRun = await enrichVault(enrichRoot, { apply: false, enabled: true, env: {}, client: enrichClient })
assert.equal(dryRun.tags_added, 2)
assert.equal(fs.existsSync(path.join(enrichRoot, '_meta/enrich-ledger.json')), false)
const applied = await enrichVault(enrichRoot, { apply: true, enabled: true, env: {}, client: enrichClient })
assert.equal(applied.notes_changed, 2)
assert.equal(applied.validation.ok, true, JSON.stringify(validateVault(enrichRoot, { strict: true }).errors))
assert.match(fs.readFileSync(path.join(enrichRoot, 'kb/memory-loop.md'), 'utf8'), /  - agent-memory\n/)
const callsAfterApply = enrichClient.calls
const rerun = await enrichVault(enrichRoot, { apply: true, enabled: true, env: {}, client: enrichClient })
assert.equal(rerun.pending, 0, 'ledger must skip notes unchanged since their last enrichment')
assert.equal(enrichClient.calls, callsAfterApply)
const offline = await enrichVault(enrichRoot, { apply: true, max: 5, env: {} })
assert.equal(offline.pending, 0)
fs.rmSync(enrichRoot, { recursive: true, force: true })

fs.rmSync(tmp, { recursive: true, force: true })
process.stdout.write('typesafe tests: ok\n')
