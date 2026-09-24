#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyFreeformPromote,
  applyStructuralWikilink,
  extractSupersessionTarget,
  judgeFreeformNote,
  judgeStaleSuccessor,
  judgeStructuralLink,
} from '../lib/promotion-judge.mjs'
import { dedupeCanChange, isNoop, runSidekick, semanticDedupe } from '../lib/sidekick.mjs'

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`sidekick tests: ${message}\n`)
    process.exitCode = 1
  }
}

function writeNote(dir, name, { title, status = 'verified', tags = [], body = 'x'.repeat(80), links = [] }) {
  const related = links.map((l) => `- [[${l}]]`).join('\n')
  fs.writeFileSync(path.join(dir, name), `---
type: finding
status: ${status}
summary: "${title} summary for oracle testing purposes here"
sources:
  - "https://example.com/sidekick-test"
created: 2026-07-28
updated: 2026-07-28
tags:
${tags.map((t) => `  - ${t}`).join('\n')}
---

# ${title}

${body}

## Related

${related}
`)
}

const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-sidekick-xdg-'))
process.env.XDG_STATE_HOME = xdg
delete process.env.TYPESAFE_API_KEY
process.env.ALAMBIC_TYPESAFE_AUDIT_FILE = path.join(xdg, 'typesafe-audit.jsonl')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-sidekick-'))
const kb = path.join(tmp, 'kb')
const ref = path.join(tmp, 'ref')
const meta = path.join(tmp, '_meta')
fs.mkdirSync(kb)
fs.mkdirSync(ref)
fs.mkdirSync(meta)
fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# t\n')
fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# t\n')
fs.writeFileSync(path.join(tmp, 'README.md'), '# t\n')
fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n')
fs.mkdirSync(path.join(tmp, 'docs'))
fs.writeFileSync(path.join(kb, '_index.md'), `---
type: reference
status: verified
updated: 2026-07-28
tags:
  - index
---

# Index

## Active durable notes

`)

// Two active notes sharing 3 tags, no link → auto_apply
writeNote(kb, 'alpha-side.md', {
  title: 'Alpha side',
  tags: ['css', 'frontend', 'tokens', 'design-tokens'],
  body: 'Alpha side content about design tokens and progressive CSS systems for components.',
})
writeNote(kb, 'beta-side.md', {
  title: 'Beta side',
  tags: ['css', 'frontend', 'tokens', 'design-tokens'],
  body: 'Beta side content about design tokens and progressive CSS systems for components.',
})

const judgment = judgeStructuralLink(tmp, {
  sourcePath: 'kb/alpha-side.md',
  targetPath: 'kb/beta-side.md',
  sharedTags: ['css', 'frontend', 'tokens', 'design-tokens'],
})
assert(judgment.decision === 'auto_apply', `expected auto_apply got ${judgment.decision} ${JSON.stringify(judgment.oracles)}`)

const applied = applyStructuralWikilink(tmp, 'kb/alpha-side.md', 'beta-side')
assert(applied.ok && applied.changed, 'link should apply')
const raw = fs.readFileSync(path.join(kb, 'alpha-side.md'), 'utf8')
assert(raw.includes('[[beta-side]]'), 'wikilink missing after apply')
assert(applyStructuralWikilink(tmp, 'kb/alpha-side.md', 'gamma-side').changed, 'second link should apply')
const relinked = fs.readFileSync(path.join(kb, 'alpha-side.md'), 'utf8')
assert(/## Related\n\n- \[\[gamma-side\]\]\n- \[\[beta-side\]\]\n/.test(relinked) && !relinked.includes('\n\n\n'), 'each related link adds no blank line')
writeNote(kb, 'crlf-side.md', { title: 'Crlf side' })
const crlfFile = path.join(kb, 'crlf-side.md')
const crlfText = fs.readFileSync(crlfFile, 'utf8')
const crlfHead = crlfText.indexOf('\n# ')
fs.writeFileSync(crlfFile, crlfText.slice(0, crlfHead) + crlfText.slice(crlfHead).replace(/\n/g, '\r\n'))
assert(applyStructuralWikilink(tmp, 'kb/crlf-side.md', 'beta-side').changed, 'crlf related link should apply')
assert(fs.readFileSync(crlfFile, 'utf8').includes('## Related\r\n\r\n- [[beta-side]]\r\n'), 'a crlf related section receives the link')
writeNote(kb, 'eof-side.md', { title: 'Eof side' })
const eofFile = path.join(kb, 'eof-side.md')
fs.writeFileSync(eofFile, fs.readFileSync(eofFile, 'utf8').replace(/## Related\s*$/, '## Related'))
assert(applyStructuralWikilink(tmp, 'kb/eof-side.md', 'beta-side').changed, 'eof related link should apply')
assert(fs.readFileSync(eofFile, 'utf8').endsWith('## Related\n\n- [[beta-side]]\n'), 'a trailing related heading receives the link')

// Secret freeform reject
const bad = path.join(tmp, 'docs', 'bad.md')
fs.mkdirSync(path.join(tmp, 'docs', 'inbox', 'ai'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'docs', 'inbox', 'ai', 'bad.md'), `---
type: finding
status: verified
summary: "this looks like a durable note but embeds a secret token"
sources:
  - "https://example.com"
created: 2026-07-28
updated: 2026-07-28
tags:
  - security
---

# Bad

sk-${'a'.repeat(30)}

More body text here to pass length checks if secrets were not scanned properly.
`)
const free = judgeFreeformNote(tmp, path.join(tmp, 'docs', 'inbox', 'ai', 'bad.md'))
assert(free.decision === 'reject', 'secret freeform must reject')
assert(free.oracles.no_secrets === false, 'no_secrets oracle must fail')

// Good freeform candidate → auto_apply create (unique summary)
const goodPath = path.join(tmp, 'docs', 'inbox', 'ai', 'good-promote.md')
const uniqueSummary = `Unique freeform promote signal ${Date.now()} for sidekick oracle testing path`
fs.writeFileSync(goodPath, `---
type: finding
status: draft
summary: "${uniqueSummary}"
sources:
  - "https://docs.example.org/sidekick-freeform-promote"
created: 2026-07-28
updated: 2026-07-28
tags:
  - automation
  - sidekick
---

# Unique Freeform Promote Signal

${'Durable reusable finding body for freeform oracle promote. '.repeat(12)}

## Practical Implication

Agents should promote only when oracles pass.

## Related

- [[capture-quarantine-before-kb]]
`)
// Fix source to non-placeholder domain - example.org might fail PLACEHOLDER? only example.com
// already using docs.example.org - PLACEHOLDER is example.com and example.invalid
const good = judgeFreeformNote(tmp, goodPath, { freeformBudgetRemaining: 3 })
// sources_inspectable requires https OK
assert(good.decision === 'auto_apply', `good freeform should auto_apply got ${good.decision} ${JSON.stringify(good.oracles)}`)
assert(good.mode === 'create', 'unique note should create')

assert(isNoop({ class: 'stale_successor', oracles: { verified_active: true, missing_successor_link: false } }), 'successor link already present is a no-op')
assert(isNoop({ class: 'structural_link', oracles: { both_active: false, shared_tags: true } }), 'inactive endpoint is a no-op')
assert(!isNoop({ class: 'freeform_note', oracles: { sources_inspectable: false } }), 'freeform failures stay actionable rejections')
assert(!isNoop({ class: 'stale_successor', oracles: { has_successor: false, missing_successor_link: false } }), 'mixed failures stay actionable')

assert(!dedupeCanChange({ mode: 'update', oracles: { parse_ok: true, update_or_unique: true } }), 'a lexical update is never re-decided by Jev')
assert(dedupeCanChange({ mode: 'create', oracles: { parse_ok: true, update_or_unique: true } }), 'a lexical create may be upgraded to update by Jev')
assert(dedupeCanChange({ mode: 'create', oracles: { parse_ok: true, update_or_unique: false } }), 'an undecided dedupe goes to Jev')
assert(!dedupeCanChange({ mode: 'create', oracles: { sources_inspectable: false, update_or_unique: true } }), 'other hard failures skip Jev')

// Jev dedupe: coverage decides update vs create; outage keeps the lexical judgment
const coverClient = (probability) => ({
  calls: 0,
  async systemOne(request) {
    this.calls += 1
    return {
      model: 'jev-1.13.0',
      usage: { input_tokens: 50, output_tokens: 5 },
      answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id, { type: 'noul', noul: index === 0 ? probability : 0.1 }])),
    }
  },
})
writeNote(kb, 'dedupe-neighbor.md', { title: 'Dedupe neighbor', tags: ['dedupe'], body: `${uniqueSummary} Existing durable coverage of the same claim.` })
const covered = await semanticDedupe(tmp, good, { enabled: true, env: {}, client: coverClient(0.92) })
assert(covered.mode === 'update' && covered.update_target?.startsWith('kb/'), `high coverage must update, got ${covered.mode} ${JSON.stringify(covered.semantic)}`)
const distinct = await semanticDedupe(tmp, good, { enabled: true, env: {}, client: coverClient(0.2) })
assert(distinct.mode === 'create' && distinct.decision === 'auto_apply', `low coverage must create, got ${distinct.mode}`)
const outage = await semanticDedupe(tmp, good, { enabled: true, env: {}, client: { async systemOne() { throw new Error('connection reset') } } })
const undecided = { ...good, data: { ...good.data, summary: 'zzqxv qqwrtk plooff' }, oracles: { ...good.oracles, update_or_unique: false }, decision: 'quarantine_ready' }
const keptLexical = await semanticDedupe(tmp, undecided, { enabled: true, env: {}, client: coverClient(0.99) })
assert(keptLexical.decision === 'quarantine_ready' && keptLexical.oracles.update_or_unique === false, 'no active dedupe candidate keeps the lexical decision')
assert(outage.mode === good.mode && outage.semantic?.available === false, 'provider outage keeps the lexical dedupe decision')

// Stale successor extraction
writeNote(kb, 'old-stub.md', {
  title: 'Old stub',
  status: 'superseded',
  tags: ['memory'],
  body: '**Superseded** by [[beta-side]].\n\nThin stub body for supersession testing content here.',
  links: ['beta-side'],
})
writeNote(kb, 'still-verified.md', {
  title: 'Still verified',
  tags: ['memory', 'retrieval', 'graph'],
  body: 'Verified note that still points at a superseded stub for stale successor heal tests.',
  links: ['old-stub'],
})
const successor = extractSupersessionTarget(tmp, 'kb/old-stub.md')
assert(successor === 'beta-side', `successor extract got ${successor}`)
const staleJ = judgeStaleSuccessor(tmp, { verifiedPath: 'kb/still-verified.md', stalePath: 'kb/old-stub.md' })
assert(staleJ.decision === 'auto_apply', `stale successor auto_apply ${JSON.stringify(staleJ.oracles)}`)

// Live vault dry-run must not throw
const ROOT = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const live = await runSidekick(ROOT, {
  dryRun: true,
  applyStructural: false,
  applyFreeform: false,
  maxActions: 3,
  seedProposals: false,
  writePulse: false,
})
assert(live.kind === 'sidekick-run', 'live dry-run kind')
assert(live.autonomy?.model?.includes('oracle'), 'autonomy model labeled')
assert(String(live.autonomy?.model || '').includes('v2'), 'model is v2')
assert(Number.isInteger(live.counts?.noop) && Number.isInteger(live.counts?.rejected), 'sidekick separates no-op judgments from actionable rejections')
assert(!fs.existsSync(process.env.ALAMBIC_TYPESAFE_AUDIT_FILE), 'without a credential the sidekick must degrade before any provider call')
assert(Array.isArray(live.actions), 'actions array')
assert((live.next || []).some((line) => line.includes('alambic nightly')), 'next names the local nightly writer')
assert(!(live.next || []).some((line) => /GitHub Actions/.test(line)), 'next no longer names GitHub Actions as the writer')
const autonomous = fs.readFileSync(path.join(ROOT, '_meta/bin/sidekick-autonomous.sh'), 'utf8')
assert(/^#!\/usr\/bin\/env bash\b/.test(autonomous), 'autonomous helper uses bash shebang')
assert(!/^#!\/bin\/zsh\b/.test(autonomous), 'autonomous helper is not zsh')
assert(/obv_attention\(\)/.test(autonomous), 'materialize uses distinct attention wrapper')
assert(!/obv\(\)\s*\{[^}]*attention/.test(autonomous), 'obv is not redefined as attention')
assert(/obv sidekick /.test(autonomous), 'post-materialize sidekick still uses obv')
assert(/obv validate /.test(autonomous), 'post-materialize validate still uses obv')
assert(/obv lint /.test(autonomous), 'post-materialize lint still uses obv')
assert(/obv graph /.test(autonomous), 'post-materialize graph still uses obv')
assert(/ALAMBIC_SIDEKICK_APPLY:-0/.test(autonomous), 'laptop APPLY defaults to dry-run')
assert(!/ALAMBIC_SIDEKICK_APPLY:-1/.test(autonomous), 'APPLY must not default to write')
const attentionDaily = fs.readFileSync(path.join(ROOT, '_meta/bin/attention-daily-grok.sh'), 'utf8')
assert(/ALAMBIC_ATTENTION_SIDEKICK:-0/.test(attentionDaily), 'attention chain defaults off kb apply')
assert(!/ALAMBIC_ATTENTION_SIDEKICK:-1/.test(attentionDaily), 'attention must not default to apply-all')
assert(!/\/(?:Users|home)\/[^/\s$]+\//.test(attentionDaily), 'attention helper has no absolute home path')
assert(!/\/Volumes\//.test(attentionDaily), 'attention helper has no mounted-volume path')
assert(!/LaunchAgent/i.test(attentionDaily), 'attention helper does not prescribe LaunchAgent')

const attentionSkill = fs.readFileSync(path.join(ROOT, '_meta/skills/alambic-attention-review.md'), 'utf8')
const attentionPrompt = fs.readFileSync(path.join(ROOT, '_meta/prompts/attention-daily-grok.md'), 'utf8')
const attentionLib = fs.readFileSync(path.join(ROOT, '_meta/lib/attention/index.mjs'), 'utf8')
for (const [rel, text] of [
  ['_meta/skills/alambic-attention-review.md', attentionSkill],
  ['_meta/prompts/attention-daily-grok.md', attentionPrompt],
  ['_meta/lib/attention/index.mjs', attentionLib],
]) {
  assert(!/\/Volumes\//.test(text), `${rel} has no mounted-volume path`)
  assert(!/LaunchAgent/i.test(text), `${rel} does not prescribe LaunchAgent`)
}
assert(/ALAMBIC_ROOT/.test(attentionSkill), 'attention skill uses portable ALAMBIC_ROOT')
assert(/ALAMBIC_ROOT/.test(attentionPrompt), 'attention prompt uses portable ALAMBIC_ROOT')
assert(/05:15/.test(attentionPrompt), 'attention prompt hour matches GHA 05:15 UTC')
assert(!/scheduled 06:00/.test(attentionPrompt), 'attention prompt does not use stale 06:00 hour')

const dailyWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/alambic-sidekick-daily.yml'), 'utf8')
const dailyGitAdd = dailyWorkflow.split('\n').filter((line) => /^\s*git add\b/.test(line)).join('\n')
assert(/git add -u -- docs\/inbox\/ai\/promote-ready/.test(dailyGitAdd), 'daily writer stages promote-ready deletions with git add -u')
assert(!/git add -A docs\/inbox\//.test(dailyGitAdd), 'daily writer must not git add -A docs/inbox/')
assert(!/docs\/inbox\/ai\/processed/.test(dailyGitAdd), 'daily writer must not force-track processed/')

const contract = JSON.parse(fs.readFileSync(path.join(ROOT, '_meta/automation-contract.json'), 'utf8'))
assert(contract.writer?.kind === 'local-launchd', 'contract writer is the local LaunchAgent')
assert(contract.writer?.id === 'alambic-nightly' && contract.writer?.command === 'alambic nightly --push', 'contract writer runs nightly --push')
assert(contract.writer?.manual_fallback === '.github/workflows/alambic-sidekick-daily.yml', 'contract keeps the manual workflow')
assert(!/^\s*schedule:/m.test(dailyWorkflow), 'the GitHub workflow has no schedule trigger')
assert(contract.writer?.laptop_default === 'dry-run', 'contract laptop default is dry-run')
assert(!(contract.legacy_writers || []).some((row) => row.expected_active), 'legacy writers stay inactive')

const liveWriterDocs = [
  'ref/current-work.md',
  'kb/alambic-self-improvement-loop.md',
  'ref/technical-attention-intake.md',
].map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n')
assert(!/sidekick:all/.test(liveWriterDocs), 'live refs do not prescribe sidekick:all')
assert(!/Library\/LaunchAgents/.test(liveWriterDocs), 'live refs have no LaunchAgent machine path')

assert(fs.readFileSync(path.join(kb, 'alpha-side.md'), 'utf8').includes('[[beta-side]]'), 'link persists')

fs.rmSync(tmp, { recursive: true, force: true })
if (!process.exitCode) process.stdout.write('sidekick tests: ok\n')
