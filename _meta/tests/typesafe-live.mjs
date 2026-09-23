#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { choice, noul, score } from '@typesafe-ai/sdk'
import { expandTopics, queryVaultWithJev } from '../lib/semantic-vault.mjs'
import { askJev } from '../lib/typesafe-judge.mjs'
import { buildManifest } from '../lib/vault.mjs'

if (!process.env.TYPESAFE_API_KEY) {
  process.stderr.write('typesafe live: TYPESAFE_API_KEY is required; configure it outside Git and rerun\n')
  process.exit(2)
}

function writeNote(dir, name, title, summary, body) {
  fs.writeFileSync(path.join(dir, name), `---
type: finding
status: verified
summary: "${summary}"
sources:
  - "https://docs.example.org/typesafe-live-fixture"
created: 2026-09-18
updated: 2026-09-18
tags:
  - synthetic-live
  - recovery
---

# ${title}

${body}
`)
}

const direct = await askJev({
  state: { message: 'A synthetic deployment failed, then rollback restored service.' },
  questions: {
    failed: noul('Did the synthetic deployment fail?', { true: 'Failure occurred.', false: 'No failure occurred.' }),
    state: choice('What is the current synthetic operational state?', {
      recovered: 'Failure occurred and recovery completed.',
      failing: 'Failure is ongoing.',
      healthy: 'No failure occurred.',
      unknown: 'The state is not stated.',
    }),
    impact: score('How severe is the current synthetic operational impact?', ['No current impact', 'Limited current impact', 'Major ongoing impact']),
  },
}, { enabled: true })

if (!direct.available) throw new Error(`typesafe live primitive smoke failed: ${direct.reason}`)
if (direct.answers.failed.noul < 0.8
  || direct.answers.state.choice !== 'recovered'
  || direct.answers.state.confidence < 0.7
  || direct.answers.impact.score > 0.75) {
  throw new Error('typesafe live primitive judgments contradicted the explicit synthetic state')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-typesafe-live-'))
try {
  const kb = path.join(tmp, 'kb')
  fs.mkdirSync(kb, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'ref'), { recursive: true })
  fs.mkdirSync(path.join(tmp, '_meta'), { recursive: true })
  fs.writeFileSync(path.join(kb, '_index.md'), '# Index\n')
  writeNote(kb, 'adjacent.md', 'Synthetic failure guidance A', 'A synthetic deployment failure reference that mentions rollback and terminal verification but contains no recovery procedure.', 'Synthetic deployment failure, rollback, and terminal verification are glossary entries only; this note gives no recovery steps.')
  writeNote(kb, 'recovery.md', 'Synthetic failure guidance B', 'A synthetic deployment failure procedure that uses rollback and terminal verification to restore service.', 'After a synthetic deployment failure, execute rollback, confirm restored service, and complete terminal verification.')

  const query = await queryVaultWithJev(tmp, 'synthetic deployment failure rollback terminal verification', { enabled: true, limit: 2 })
  if (!query.semantic.available) throw new Error(`typesafe live query wrapper failed: ${query.semantic.reason}`)
  if (query.results[0]?.path !== 'kb/recovery.md' || query.results[0]?.semantic?.score <= query.results[1]?.semantic?.score) {
    throw new Error('typesafe live query wrapper did not rank the explicit recovery procedure first')
  }
  const expansion = await expandTopics('comment récupérer après un déploiement raté', buildManifest(tmp, false, { fresh: true }), { enabled: true })
  if (!expansion.semantic.available) throw new Error(`typesafe live topic expansion failed: ${expansion.semantic.reason}`)
  if (!expansion.topics.includes('recovery')) throw new Error(`typesafe live topic expansion missed the French recovery topic: ${JSON.stringify(expansion.topics)}`)

  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../alambic.mjs')
  const sessionRun = spawnSync(process.execPath, [cli, 'session', '--json', '--max-tokens', '1200', 'synthetic deployment failure rollback terminal verification'], {
    encoding: 'utf8',
    env: { ...process.env, ALAMBIC_ROOT: tmp, XDG_STATE_HOME: path.join(tmp, 'state') },
  })
  if (sessionRun.status !== 0) throw new Error(`typesafe live session CLI failed: ${String(sessionRun.stderr || '').trim()}`)
  const session = JSON.parse(sessionRun.stdout)
  if (!session.pack?.retrieval?.semantic?.available || session.pack?.results?.[0]?.path !== 'kb/recovery.md') {
    throw new Error('typesafe live session CLI did not preserve the semantic context ranking')
  }

  process.stdout.write(`${JSON.stringify({
    model: direct.model,
    primitive_types: Object.fromEntries(Object.entries(direct.answers).map(([id, answer]) => [id, answer.type])),
    direct_usage: direct.usage,
    query: {
      model: query.semantic.model,
      candidates: query.semantic.candidates,
      ranking: query.results.map((result) => ({ path: result.path, semantic: result.semantic })),
      usage: query.semantic.usage,
    },
    expansion: { topics: expansion.topics, latency_ms: expansion.semantic.latency_ms, usage: expansion.semantic.usage },
    session: {
      first_path: session.pack.results[0].path,
      semantic: session.pack.retrieval.semantic,
      route: session.route,
      output_tokens: Math.ceil(Buffer.byteLength(sessionRun.stdout.trim()) / 4),
    },
  }, null, 2)}\n`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
