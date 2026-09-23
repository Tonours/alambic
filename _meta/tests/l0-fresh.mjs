#!/usr/bin/env node
// L0 pin flag + FRESH aged-stamp oracle. Fixture vault (strict-valid) for
// missing/truncation/FRESH integration; live ROOT for default-path pins.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { judgeFreshStamp } from '../lib/promotion-judge.mjs'
import { runSidekick } from '../lib/sidekick.mjs'
import { contextPack } from '../lib/vault.mjs'

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`l0-fresh tests: ${message}\n`)
    process.exitCode = 1
  }
}

const ROOT = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const CLI = path.join(ROOT, '_meta/alambic.mjs')

// ---- L0 on live vault (default path must stay bit-identical) ----
const plain = contextPack(ROOT, 'second brain architecture', { maxTokens: 2500 })
assert(!Object.hasOwn(plain, 'l0'), 'default pack must not carry an l0 key')

const pinned = contextPack(ROOT, 'second brain architecture', { maxTokens: 2500, l0: true })
assert(pinned.l0?.pinned === true, 'l0 should pin')
assert(pinned.l0?.path === 'ref/critical-facts.md', 'l0 path')
assert(typeof pinned.l0?.excerpt === 'string' && pinned.l0.excerpt.length > 0, 'l0 excerpt non-empty')
assert(pinned.l0.included_bytes <= 800, `l0 excerpt bounded, got ${pinned.l0.included_bytes}`)
assert(pinned.estimated_tokens <= pinned.max_tokens, 'l0 pack honors budget')
assert(pinned.results.length >= 1, 'l0 pack keeps retrieval rows at 2500')

let threw = ''
let minimal = null
try {
  minimal = contextPack(ROOT, 'second brain architecture', { maxTokens: 512, l0: true })
} catch (error) {
  threw = error.message
}
assert(minimal ? minimal.results.length >= 1 && minimal.estimated_tokens <= 512 : /too small for the L0 pin/.test(threw), `512+l0 must either fit a retrieval row or fail fast, got: ${threw || JSON.stringify(minimal?.results?.length)}`)

const floorPack = contextPack(ROOT, 'second brain architecture', { maxTokens: 320 })
assert(floorPack.results.length >= 1 && floorPack.estimated_tokens <= 320, 'the 320-token floor still fits one durable excerpt')

const roomy = contextPack(ROOT, 'second brain architecture', { maxTokens: 768, l0: true })
assert(roomy.l0?.pinned === true && roomy.results.length >= 1, '768+l0 fits pin plus rows')

const abstain = contextPack(ROOT, 'purple aardvark quantum bananas', { maxTokens: 2500, l0: true })
assert(abstain.abstained === true, 'abstention stays results-based with l0')
assert(abstain.l0?.pinned === true, 'l0 pins even when retrieval abstains')

// ---- CLI wiring (both commands pass the flag through) ----
for (const cmd of ['context', 'session']) {
  const run = spawnSync('node', [CLI, cmd, '--json', '--max-tokens', '2500', '--l0', 'second brain architecture'], { encoding: 'utf8' })
  assert(run.status === 0, `${cmd} --l0 exits 0: ${run.stderr.slice(0, 200)}`)
  const pack = cmd === 'session' ? JSON.parse(run.stdout).pack : JSON.parse(run.stdout)
  assert(pack.l0?.pinned === true, `${cmd} --l0 pins`)
}
const clash = spawnSync('node', [CLI, 'session', '--json', '--attention', '--l0', 'x'], { encoding: 'utf8' })
assert(clash.status !== 0 && /--attention/.test(clash.stderr), `--attention --l0 must fail fast, got: ${clash.stderr.slice(0, 160)}`)

// ---- Fixture vault: missing + truncation + FRESH integration ----
const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-l0fresh-xdg-'))
process.env.XDG_STATE_HOME = xdg
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-l0fresh-'))
for (const dir of ['kb', 'ref', 'docs', '_meta']) fs.mkdirSync(path.join(tmp, dir))
for (const file of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'package.json']) fs.writeFileSync(path.join(tmp, file), '{}\n')
fs.copyFileSync(path.join(ROOT, '_meta/note.schema.json'), path.join(tmp, '_meta/note.schema.json'))
fs.copyFileSync(path.join(ROOT, 'ref/knowledge-health.base'), path.join(tmp, 'ref/knowledge-health.base'))

function writeNote(dir, name, { status = 'verified', tags = ['t'], body, supersededBy = '' }) {
  fs.writeFileSync(path.join(tmp, dir, name), `---
type: finding
status: ${status}
${supersededBy ? `superseded_by: ${supersededBy}\n` : ''}summary: "l0-fresh fixture note for oracle testing purposes here"
sources:
  - "https://example.org/l0-fresh-fixture"
created: 2026-09-04
updated: 2026-09-04
tags:
${tags.map((t) => `  - ${t}`).join('\n')}
---

# Fixture

${body}
`)
}

writeNote('kb', 'retrieval-target.md', { body: 'alpha beta gamma delta epsilon zeta eta theta fixture retrieval prose' })

const missing = contextPack(tmp, 'alpha beta gamma', { maxTokens: 2500, l0: true })
assert(missing.l0?.pinned === false && missing.l0?.reason === 'missing', 'missing L0 degrades gracefully')

fs.writeFileSync(path.join(tmp, 'ref/critical-facts.md'), `---
type: reference
status: verified
summary: "fixture L0"
created: 2026-09-04
updated: 2026-09-04
tags:
  - profile
---

# Critical facts

${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '.repeat(20)}
`)
const trunc = contextPack(tmp, 'alpha beta gamma', { maxTokens: 2500, l0: true })
assert(trunc.l0?.pinned === true && trunc.l0?.truncated === true, 'long L0 truncates')
assert(trunc.l0.included_bytes <= 800, `truncated L0 bounded, got ${trunc.l0.included_bytes}`)

// ---- FRESH judge unit + sidekick integration ----
const aged = judgeFreshStamp(tmp, { notePath: 'kb/retrieval-target.md', line: 3, stamp: '2020-01-01', today: '2026-09-04' })
assert(aged.decision === 'review' && aged.age_days > 90, `aged stamp reviews, got ${aged.decision}`)
const fresh = judgeFreshStamp(tmp, { notePath: 'kb/retrieval-target.md', line: 3, stamp: '2026-09-04', today: '2026-09-04' })
assert(fresh.decision === 'skip', `fresh stamp skips, got ${fresh.decision}`)
const badStamp = judgeFreshStamp(tmp, { notePath: 'kb/retrieval-target.md', line: 3, stamp: 'not-a-date', today: '2026-09-04' })
assert(badStamp.decision === 'skip', 'malformed stamp skips')

for (let i = 1; i <= 5; i += 1) {
  writeNote('kb', `aged-${i}.md`, { body: `streak multi-week (as of 2020-01-0${i}) fixture` })
}
writeNote('kb', 'backtick-doc.md', { body: 'example `(as of 2020-01-01)` inside code span stays silent' })
writeNote('kb', 'frozen-stub.md', { status: 'superseded', supersededBy: 'retrieval-target', body: '**Superseded** by [[retrieval-target]].\n\nold (as of 2020-01-01) stays silent' })
const basenames = fs.readdirSync(path.join(tmp, 'kb')).filter((f) => f.endsWith('.md') && f !== '_index.md' && f !== 'frozen-stub.md').map((f) => f.replace(/\.md$/, ''))
fs.writeFileSync(path.join(tmp, 'kb/_index.md'), `---
type: reference
status: verified
updated: 2026-09-04
tags:
  - index
---

# Index

${basenames.map((b) => `- [[${b}]]`).join('\n')}
`)

const run1 = await runSidekick(tmp, { dryRun: true, seedProposals: true, writePulse: false, maxActions: 8 })
const fresh1 = run1.actions.filter((a) => a.type === 'fresh_review')
assert(fresh1.length === 3, `cap 3 fresh actions, got ${fresh1.length}`)
assert(fresh1.every((a) => a.applied === false && a.seeded === true), 'fresh actions never apply, all seeded')
assert(fresh1[0].judgment.stamp <= fresh1[2].judgment.stamp, 'oldest-first order')
const proposals = fs.readdirSync(path.join(xdg, 'alambic/proposals')).filter((f) => f.endsWith('.json'))
assert(proposals.length === 3, `3 pending proposals, got ${proposals.length}`)
const stored = JSON.parse(fs.readFileSync(path.join(xdg, 'alambic/proposals', proposals[0]), 'utf8'))
assert(stored.action === 'noop' && stored.mode === 'shadow', 'seeded noop shadow proposal')
assert(!/ age \d+d/.test(stored.rationale), 'seeded rationale stable across days (no age)')
assert(!fs.existsSync(path.join(xdg, 'alambic/reviews')) || fs.readdirSync(path.join(xdg, 'alambic/reviews')).length === 0, 'no receipts for fresh findings')

const run2 = await runSidekick(tmp, { dryRun: true, seedProposals: true, writePulse: false, maxActions: 8 })
const fresh2 = run2.actions.filter((a) => a.type === 'fresh_review')
assert(fresh2.every((a) => a.seeded === false), 'rerun dedupes by content hash')

fs.rmSync(path.join(xdg, 'alambic/proposals'), { recursive: true, force: true })
const run3 = await runSidekick(tmp, { dryRun: true, seedProposals: false, writePulse: false, maxActions: 8 })
const fresh3 = run3.actions.filter((a) => a.type === 'fresh_review')
assert(fresh3.length === 3 && fresh3.every((a) => a.seeded === false), 'seedProposals:false reports without writing')
assert(!fs.existsSync(path.join(xdg, 'alambic/proposals')) || fs.readdirSync(path.join(xdg, 'alambic/proposals')).length === 0, 'no proposal files when seeding off')

fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(xdg, { recursive: true, force: true })
if (!process.exitCode) process.stdout.write('l0-fresh tests: ok\n')
