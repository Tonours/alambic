import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { topicVocabulary } from './semantic-vault.mjs'
import { askJev, noul } from './typesafe-judge.mjs'
import { buildKnowledgeGraph, buildManifest, validateVault } from './vault.mjs'
import { writeChecked } from './write-journal.mjs'

const LEDGER = '_meta/enrich-ledger.json'
const MAX_CANDIDATE_TAGS = 12
const MAX_ADDED_TAGS = 3
const TAG_PROBABILITY_MIN = 0.85
const MAX_EXCERPT_BYTES = 1_500
const CONCURRENCY = 4
const ACTIVE = new Set(['verified', 'accepted'])

function readLedger(root) {
  const file = path.join(root, LEDGER)
  if (!fs.existsSync(file)) return { version: 1, notes: {}, raw: null }
  const raw = fs.readFileSync(file, 'utf8')
  const ledger = JSON.parse(raw)
  if (ledger.version !== 1 || typeof ledger.notes !== 'object') throw new Error(`${LEDGER} has an unsupported shape`)
  return { ...ledger, raw }
}

function writeLedger(root, ledger) {
  const sorted = Object.fromEntries(Object.entries(ledger.notes).sort(([a], [b]) => a.localeCompare(b)))
  if (!writeChecked(path.join(root, LEDGER), ledger.raw, `${JSON.stringify({ version: 1, notes: sorted }, null, 2)}\n`)) throw new Error(`${LEDGER} changed during enrich`)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function excerpt(raw) {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
  const bytes = Buffer.from(body, 'utf8')
  return bytes.length <= MAX_EXCERPT_BYTES ? body : bytes.subarray(0, MAX_EXCERPT_BYTES).toString('utf8').replace(/\uFFFD$/, '')
}

export function candidateTags(note, vocabulary, neighbors) {
  const own = new Set(note.tags)
  const votes = new Map()
  for (const neighbor of neighbors) {
    for (const tag of neighbor.tags) if (!own.has(tag)) votes.set(tag, (votes.get(tag) || 0) + 1)
  }
  for (const tag of vocabulary) {
    if (own.has(tag)) continue
    if (note.search.body.includes(tag.replace(/[-_]+/g, ' ')) || note.search.body.includes(tag)) votes.set(tag, (votes.get(tag) || 0) + 1)
  }
  return [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_CANDIDATE_TAGS).map(([tag]) => tag)
}

function tagQuestions(candidates) {
  return Object.fromEntries(candidates.map((_, index) => [`tag_${index}`, noul(`Is \`candidate_tags[${index}]\` an accurate topic label for \`note\`?`, {
    true: 'The note is substantially about this topic; a reader searching the topic should find this note.',
    false: 'The topic is absent, only mentioned in passing, or unrelated to the note.',
  })]))
}

async function judgeNote(note, candidates, options) {
  const judged = await askJev({
    state: { note: { title: note.title, summary: note.summary, tags: note.tags, excerpt: excerpt(note.raw) }, candidate_tags: candidates },
    questions: tagQuestions(candidates),
  }, options)
  if (!judged.available) return { added: [], semantic: judged }
  const added = candidates
    .map((tag, index) => ({ tag, probability: judged.answers[`tag_${index}`].noul }))
    .filter((entry) => entry.probability >= TAG_PROBABILITY_MIN)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_ADDED_TAGS)
  return { added, semantic: { available: true, latency_ms: judged.latency_ms, input_tokens: judged.usage.input_tokens } }
}

export function appendTags(raw, tags) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error('note has no frontmatter')
  const lines = match[1].split('\n')
  const start = lines.findIndex((line) => line === 'tags:')
  if (start < 0) throw new Error('note has no tags list')
  let end = start + 1
  while (end < lines.length && /^\s+- /.test(lines[end])) end += 1
  lines.splice(end, 0, ...tags.map((tag) => `  - ${tag}`))
  return `---\n${lines.join('\n')}\n---\n${raw.slice(match[0].length)}`
}

async function mapPool(items, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index])
    }
  }))
  return results
}

export async function enrichVault(root, { apply = false, max = 25, ...options } = {}) {
  const manifest = buildManifest(root, false, { fresh: true })
  const vocabulary = topicVocabulary(manifest)
  const graph = buildKnowledgeGraph(root)
  const ledger = readLedger(root)
  const pending = manifest
    .filter((note) => note.path.startsWith('kb/') && note.path !== 'kb/_index.md' && ACTIVE.has(note.status))
    .filter((note) => ledger.notes[note.path] !== note.sha256)
    .slice(0, Math.max(0, max))
  const byPath = new Map(manifest.map((note) => [note.path, note]))
  const judged = await mapPool(pending, async (note) => {
    const neighbors = [...(graph.adjacency.get(note.path) || [])].map((neighborPath) => byPath.get(neighborPath)).filter((neighbor) => neighbor && ACTIVE.has(neighbor.status))
    const candidates = candidateTags(note, vocabulary, neighbors)
    if (!candidates.length) return { note, added: [], semantic: { available: false, reason: 'no_candidates' } }
    return { note, ...(await judgeNote(note, candidates, options)) }
  })

  const report = { apply, vocabulary: vocabulary.length, pending: pending.length, judged: 0, provider_failures: 0, notes_changed: 0, tags_added: 0, concurrent_edits: 0, input_tokens: 0, changes: [] }
  for (const { note, added, semantic } of judged) {
    if (semantic.available) {
      report.judged += 1
      report.input_tokens += semantic.input_tokens
    } else if (semantic.reason !== 'no_candidates') {
      report.provider_failures += 1
      report.failure_reason = semantic.reason
      continue
    }
    if (added.length) {
      report.changes.push({ path: note.path, added: added.map((entry) => entry.tag) })
      report.tags_added += added.length
    }
    if (!apply) continue
    const next = added.length ? appendTags(note.raw, added.map((entry) => entry.tag)) : note.raw
    if (added.length) {
      if (!writeChecked(path.join(root, note.path), note.raw, next)) { report.concurrent_edits += 1; continue }
      report.notes_changed += 1
    }
    ledger.notes[note.path] = sha256(next)
  }
  if (apply) {
    writeLedger(root, ledger)
    const validation = validateVault(root, { strict: true })
    report.validation = { ok: validation.ok, errors: validation.errors.length }
  }
  return report
}
