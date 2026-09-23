#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '.')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-review-gate-'))
const vault = path.join(temp, 'vault')
const state = path.join(temp, 'state')
process.env.ALAMBIC_STATE_DIR = state
process.env.ALAMBIC_TYPESAFE_AUDIT_FILE = path.join(temp, 'typesafe-audit.jsonl')
delete process.env.XDG_STATE_HOME
delete process.env.TYPESAFE_API_KEY

const judge = await import(path.join(root, '_meta/lib/promotion-judge.mjs'))
const { dedupeCanChange, runSidekick, semanticDedupe } = await import(path.join(root, '_meta/lib/sidekick.mjs'))
const { harvestStatus } = await import(path.join(root, '_meta/lib/harvest.mjs'))
const cli = (argv) => spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, ALAMBIC_ROOT: vault } })

const body = 'The lexical cache must keep raw fields and sources because stale entries crash queries after an upgrade. '.repeat(3)
const kbNote = (name, text) => fs.writeFileSync(path.join(vault, 'kb', name), `---\ntype: finding\nstatus: verified\nsummary: "${name} durable note for the review gate tests"\nsources:\n  - "https://docs.example.org/${name}"\ncreated: 2026-09-01\nupdated: 2026-09-01\ntags:\n  - retrieval\n---\n\n# ${name}\n\n${text}\n`)
const inbox = (name, { summary, text = body, origin = true, sources = ['codex:s1', 'https://docs.example.org/cache'] }) => {
  const file = path.join(vault, 'docs/inbox/ai', name)
  fs.writeFileSync(file, `---\ntype: finding\nstatus: draft\nsummary: "${summary}"\nsources:\n${sources.map((source) => `  - "${source}"`).join('\n')}\n${origin ? 'origin: session-harvest\ntrust: untrusted-session-data\n' : ''}created: 2026-09-24\nupdated: 2026-09-24\ntags:\n  - retrieval\n---\n\n# ${summary.slice(0, 40)}\n\n${text}\n`)
  return file
}
const rel = (file) => path.relative(vault, file)

try {
  fs.mkdirSync(path.join(vault, 'kb'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'ref'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'docs/inbox/ai'), { recursive: true })
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true })
  fs.copyFileSync(path.join(root, '_meta/note.schema.json'), path.join(vault, '_meta/note.schema.json'))
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'README.md']) fs.writeFileSync(path.join(vault, file), '# t\n')
  fs.writeFileSync(path.join(vault, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(vault, 'kb/_index.md'), '---\ntype: reference\nstatus: verified\nupdated: 2026-09-01\ntags:\n  - index\n---\n\n# Index\n\n## Active durable notes\n\n- [[unrelated-topic]]\n- [[capture-quarantine-before-kb]]\n- [[adr-alambic-autonomous-oracle-sidekick]]\n')
  fs.copyFileSync(path.join(root, 'ref/knowledge-health.base'), path.join(vault, 'ref/knowledge-health.base'))
  kbNote('capture-quarantine-before-kb.md', 'Capture goes to the inbox first and waits for the judge before any durable write. '.repeat(2))
  kbNote('adr-alambic-autonomous-oracle-sidekick.md', 'The sidekick applies only oracle-gated changes with a daily budget and receipts. '.repeat(2))
  kbNote('unrelated-topic.md', 'Gardening notes about tomatoes and watering schedules in summer. '.repeat(3))

  const session = inbox('harvest-2026-09-24-codex-s1.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades' })
  const pending = judge.judgeFreeformNote(vault, session, { freeformBudgetRemaining: 3 })
  assert.equal(pending.decision, 'review_required', JSON.stringify(pending.oracles))
  assert.equal(pending.session_origin, true)
  assert.equal(dedupeCanChange(pending), false, 'Jev is never asked about a pending session note')
  const forced = await semanticDedupe(vault, { ...pending, decision: 'auto_apply', mode: 'create' }, { enabled: true, env: {}, client: { async systemOne(request) { return { model: 'jev', usage: {}, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.1 }])) } } } })
  assert.equal(judge.reviewGate(forced, fs.readFileSync(session, 'utf8')).decision, 'review_required', 're-gate after Jev keeps review_required')
  assert.equal(judge.applyFreeformPromote(vault, { ...pending, decision: 'auto_apply', mode: 'create' }).error, 'review-required', 'apply refuses a forged auto_apply')

  const renamed = inbox('plain-name.md', { summary: 'Qwerty plonk rule for the zanzibar cache warmer path', sources: ['https://docs.example.org/x'], origin: false })
  assert.notEqual(judge.judgeFreeformNote(vault, renamed).decision, 'review_required', 'a note without session markers keeps the normal path')
  fs.rmSync(renamed)
  const sourceOnly = inbox('sourced.md', { summary: 'Blorp rule for the zanzibar cache warmer path again', origin: false })
  assert.equal(judge.judgeFreeformNote(vault, sourceOnly).decision, 'review_required', 'a claude:/codex:/pi: source alone marks session origin')
  assert.equal(judge.isSessionOrigin({}, 'docs/inbox/ai/harvest-x.md'), true, 'harvest- basename marks session origin')

  assert.throws(() => judge.reviewInbox(vault, rel(session), { decision: 'accept', reason: 'looks right' }), /interactive terminal/)
  const refused = cli(['review', '--inbox', rel(session), '--decision', 'accept', '--reason', 'ok', '--json'])
  assert.notEqual(refused.status, 0, 'CLI accept without a TTY is refused')
  assert.throws(() => judge.reviewInbox(vault, '../outside.md', { decision: 'reject', reason: 'x' }), /expects docs\/inbox/)

  const accepted = judge.reviewInbox(vault, rel(session), { decision: 'accept', reason: 'verified the retention rule', tty: true })
  assert.equal(accepted.receipt.reviewer, 'human:alambic-review')
  assert.equal(judge.reviewInbox(vault, rel(session), { decision: 'accept', reason: 'again', tty: true }).idempotent, true)
  assert.throws(() => judge.reviewInbox(vault, rel(session), { decision: 'reject', reason: 'changed my mind' }), /immutable/)
  const receiptFile = path.join(state, 'reviews', `inbox-${accepted.receipt.inbox_sha256}.json`)
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o400)

  const unlocked = judge.judgeFreeformNote(vault, session)
  assert.equal(unlocked.decision, 'auto_apply', JSON.stringify(unlocked))
  fs.appendFileSync(session, '\nEdited after review.\n')
  assert.equal(judge.judgeFreeformNote(vault, session).decision, 'review_required', 'an edit after accept needs a new receipt')
  assert.equal(judge.applyFreeformPromote(vault, { ...unlocked }).error, 'review-required', 'apply re-checks the bytes it reads')
  const original = fs.readFileSync(session, 'utf8').replace('\nEdited after review.\n', '')
  fs.writeFileSync(session, original)

  const applied = judge.applyFreeformPromote(vault, judge.judgeFreeformNote(vault, session))
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const created = fs.readFileSync(path.join(vault, applied.path), 'utf8')
  assert.match(created, /^reviewed_by: human:alambic-review$/m)
  assert.match(created, new RegExp(`^reviewed_at: ${accepted.receipt.reviewed_at.slice(0, 10)}$`, 'm'))
  assert.equal(fs.existsSync(session), false, 'promoted source leaves the inbox')

  const target = path.basename(applied.path)
  const dup = inbox('harvest-2026-09-24-codex-s2.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades' })
  const noop = judge.judgeFreeformNote(vault, dup)
  assert.equal(noop.decision, 'noop', `${noop.decision} ${noop.reason}`)
  assert.equal(noop.update_target, `kb/${target}`)
  const partial = inbox('harvest-2026-09-24-codex-s3.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades', text: `${body} However the rule no longer holds after version 4 because the cache format changed.` })
  assert.notEqual(judge.judgeFreeformNote(vault, partial).decision, 'noop', 'a note that adds a correction is not a noop')
  fs.rmSync(partial)
  const flipped = inbox('harvest-2026-09-24-codex-s4.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades', text: body.replaceAll('.', ' != ') })
  assert.notEqual(judge.judgeFreeformNote(vault, flipped).decision, 'noop', 'punctuation and operators count for coverage')
  fs.rmSync(flipped)

  const rejectMe = inbox('harvest-2026-09-24-pi-p9.md', { summary: 'Vague chit chat about lunch that should never reach the wiki pages' })
  judge.reviewInbox(vault, rel(rejectMe), { decision: 'reject', reason: 'not durable' })
  assert.equal(fs.existsSync(path.join(vault, 'docs/inbox/ai/processed/rejected-harvest-2026-09-24-pi-p9.md')), true)

  const viaTty = inbox('harvest-2026-09-24-claude-t1.md', { summary: 'Plumbus rule for the dinglebop cache warmer path accepted through a terminal' })
  const pty = spawnSync('python3', ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, path.join(root, '_meta/alambic.mjs'), 'review', '--inbox', rel(viaTty), '--decision', 'accept', '--reason', 'checked in a terminal'], { encoding: 'utf8', input: '', env: { ...process.env, ALAMBIC_ROOT: vault } })
  assert.equal(pty.status, 0, pty.stdout + pty.stderr)
  assert.match(pty.stdout, /reviewer: human:alambic-review/)
  const viaPipe = inbox('harvest-2026-09-24-claude-t2.md', { summary: 'Another pipe rejected note about the dinglebop cache warmer path' })
  assert.equal(cli(['review', '--inbox', rel(viaPipe), '--decision', 'reject', '--reason', 'duplicate', '--json']).status, 0)
  assert.deepEqual([harvestStatus(vault).metrics.accepted, harvestStatus(vault).metrics.rejected, harvestStatus(vault).review_acceptance_rate], [1, 1, 0.5])

  const updater = inbox('harvest-2026-09-24-codex-u1.md', { summary: 'Tomato watering rule refined from a session about the garden notes' })
  const updaterReview = judge.reviewInbox(vault, rel(updater), { decision: 'accept', reason: 'checked the watering rule', tty: true })
  const updated = judge.applyFreeformPromote(vault, { decision: 'auto_apply', mode: 'update', update_target: 'kb/unrelated-topic.md', path: rel(updater) })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  const updatedText = fs.readFileSync(path.join(vault, 'kb/unrelated-topic.md'), 'utf8')
  assert.match(updatedText, /^reviewed_by: human:alambic-review$/m, 'an accepted update records the human reviewer')
  assert.match(updatedText, new RegExp(`^reviewed_at: ${updaterReview.receipt.reviewed_at.slice(0, 10)}$`, 'm'))
  for (let index = 0; index < 32; index += 1) inbox(`harvest-2026-09-25-claude-z${String(index).padStart(2, '0')}.md`, { summary: `Pending session note number ${index} waiting for a human review decision` })
  const { validateVault } = await import(path.join(root, '_meta/lib/vault.mjs'))
  const pre = validateVault(vault, { strict: true })
  assert.ok(pre.ok, JSON.stringify(pre.errors))
  const run = await runSidekick(vault, { dryRun: false, applyFreeform: true, applyStructural: false, seedProposals: false, writePulse: false })
  assert.equal(run.counts.review_required, 33, JSON.stringify(run.counts))
  assert.equal(fs.existsSync(dup), false, 'apply mode archives the noop')
  assert.equal(fs.existsSync(path.join(vault, 'docs/inbox/ai/processed/noop-harvest-2026-09-24-codex-s2.md')), true)
  assert.equal(fs.readFileSync(path.join(vault, applied.path), 'utf8'), created, 'noop never touches kb')
  const metrics = harvestStatus(vault).metrics
  assert.equal(metrics.noop, 1)
  console.log('review-gate: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
