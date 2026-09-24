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
const { displacedEdits, moveChecked } = await import(path.join(root, '_meta/lib/write-journal.mjs'))
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
  const judgedDup = fs.readFileSync(dup, 'utf8')
  fs.writeFileSync(`${dup}.save`, `${judgedDup}\nCorrection saved after the judge ran.\n`)
  fs.renameSync(`${dup}.save`, dup)
  assert.equal(judge.archiveNoop(vault, noop).error, 'changed-since-judged', 'a draft saved after its noop judgment is not archived')
  assert.match(fs.readFileSync(dup, 'utf8'), /Correction saved after the judge ran/)
  fs.writeFileSync(dup, judgedDup)
  const targetFile = path.join(vault, noop.update_target)
  const targetText = fs.readFileSync(targetFile, 'utf8')
  fs.writeFileSync(targetFile, targetText.replace(/Zyxwv[\s\S]*$/, 'Rewritten by a human.\n'))
  assert.equal(judge.archiveNoop(vault, noop).error, 'target-changed-since-judged', 'a noop whose target changed since the judgment is not archived')
  assert.equal(fs.readFileSync(dup, 'utf8'), judgedDup)
  fs.writeFileSync(targetFile, targetText)
  const { writeFileSync: plainWrite } = fs
  fs.writeFileSync = (dest, ...rest) => { if (String(dest).includes('processed/noop-')) plainWrite(targetFile, 'Rewritten during the archive.\n'); return plainWrite(dest, ...rest) }
  try { assert.equal(judge.archiveNoop(vault, noop).error, 'target-changed-since-judged', 'a target changed during the archive puts the draft back') } finally { fs.writeFileSync = plainWrite }
  assert.equal(fs.readFileSync(dup, 'utf8'), judgedDup)
  assert.deepEqual(fs.readdirSync(path.join(vault, 'docs/inbox/ai/processed')).filter((name) => name.includes('codex-s2')), [], 'the undone noop leaves no archive')
  fs.writeFileSync(targetFile, targetText)
  const partial = inbox('harvest-2026-09-24-codex-s3.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades', text: `${body} However the rule no longer holds after version 4 because the cache format changed.` })
  assert.notEqual(judge.judgeFreeformNote(vault, partial).decision, 'noop', 'a note that adds a correction is not a noop')
  fs.rmSync(partial)
  const flipped = inbox('harvest-2026-09-24-codex-s4.md', { summary: 'Zyxwv quorble retention rule keeps the frobnicator warm between upgrades', text: body.replaceAll('.', ' != ') })
  assert.notEqual(judge.judgeFreeformNote(vault, flipped).decision, 'noop', 'punctuation and operators count for coverage')
  fs.rmSync(flipped)

  const escaping = inbox('harvest-2026-09-24-pi-p8.md', { summary: 'Session note whose archive directory points into the compiled wiki' })
  const processedDir = path.join(vault, 'docs/inbox/ai/processed')
  const parked = `${processedDir}.parked`
  if (fs.existsSync(processedDir)) fs.renameSync(processedDir, parked)
  fs.symlinkSync(path.join(vault, 'kb'), processedDir)
  const kbBefore = fs.readdirSync(path.join(vault, 'kb')).sort()
  assert.throws(() => judge.reviewInbox(vault, rel(escaping), { decision: 'reject', reason: 'not durable' }), /real directory inside the vault/)
  assert.throws(() => judge.archiveNoop(vault, { ...noop, path: rel(escaping), sha256: judge.sha256(fs.readFileSync(escaping, 'utf8')) }), /real directory inside the vault/)
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb')).sort(), kbBefore, 'a symlinked archive never moves a draft into kb')
  assert.equal(fs.existsSync(escaping), true)
  fs.unlinkSync(processedDir)
  if (fs.existsSync(parked)) fs.renameSync(parked, processedDir)
  const displacedLink = path.join(vault, 'displaced-link')
  fs.symlinkSync(path.join(vault, 'kb'), displacedLink)
  process.env.ALAMBIC_DISPLACED_DIR = displacedLink
  try { assert.throws(() => judge.reviewInbox(vault, rel(escaping), { decision: 'reject', reason: 'not durable' }), /displaced directory must be a real directory/) } finally { delete process.env.ALAMBIC_DISPLACED_DIR }
  assert.deepEqual(fs.readdirSync(path.join(vault, 'kb')).sort(), kbBefore, 'a symlinked displaced directory never moves a draft into kb')
  assert.equal(fs.existsSync(escaping), true)
  fs.unlinkSync(displacedLink)
  fs.rmSync(escaping)

  const raced = inbox('harvest-2026-09-24-pi-p9.md', { summary: 'Session note replaced by an atomic save before its archive' })
  const judged = fs.readFileSync(raced, 'utf8')
  const saved = `${judged}\nSaved by the editor.\n`
  fs.writeFileSync(`${raced}.save`, saved)
  fs.renameSync(`${raced}.save`, raced)
  fs.mkdirSync(processedDir, { recursive: true })
  const racedDest = path.join(processedDir, 'rejected-p9.md')
  assert.equal(moveChecked(raced, [racedDest], judge.sha256(judged)), null)
  assert.equal(fs.readFileSync(raced, 'utf8'), saved, 'an atomic save before the archive stays in the inbox')
  assert.deepEqual(fs.readdirSync(processedDir).filter((name) => name.includes('p9')), [], 'a refused archive leaves no copy')
  fs.writeFileSync(racedDest, 'taken\n')
  assert.throws(() => moveChecked(raced, [racedDest], judge.sha256(saved)), /no free archive name/)
  assert.equal(fs.readFileSync(raced, 'utf8'), saved, 'an archive with no free name restores the source')
  const reservedDir = path.join(state, 'displaced')
  const archived = path.join(processedDir, 'rejected-p9-1.md')
  const { writeFileSync, copyFileSync } = fs
  const failing = (dest) => { if (dest === archived) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }) }
  fs.writeFileSync = (dest, ...rest) => { failing(dest); return writeFileSync(dest, ...rest) }
  fs.copyFileSync = (source, dest, ...rest) => { failing(dest); return copyFileSync(source, dest, ...rest) }
  try { assert.throws(() => moveChecked(raced, [archived], judge.sha256(saved)), /no space left/) } finally { Object.assign(fs, { writeFileSync, copyFileSync }) }
  assert.equal(fs.readFileSync(raced, 'utf8'), saved, 'a failed archive write restores the source')
  assert.equal(fs.existsSync(archived), false)
  fs.chmodSync(raced, 0o600)
  const reservedCopy = () => fs.readdirSync(reservedDir).find((name) => name.startsWith(judge.sha256(saved)))
  const lateWrite = (dest) => { if (dest === archived) fs.appendFileSync(path.join(reservedDir, reservedCopy()), 'Late write through an open descriptor.\n') }
  fs.writeFileSync = (dest, ...rest) => { lateWrite(dest); return writeFileSync(dest, ...rest) }
  fs.copyFileSync = (source, dest, ...rest) => { lateWrite(dest); return copyFileSync(source, dest, ...rest) }
  try { assert.equal(moveChecked(raced, [racedDest, archived], judge.sha256(saved)), archived) } finally { Object.assign(fs, { writeFileSync, copyFileSync }) }
  assert.equal(fs.existsSync(raced), false)
  assert.deepEqual(fs.readdirSync(processedDir).filter((name) => name.includes('p9')).sort(), ['rejected-p9-1.md', 'rejected-p9.md'], 'the archive keeps no reserved copy')
  assert.equal(fs.readFileSync(archived, 'utf8'), saved, 'the archive holds the checked bytes even when the inode changes before the copy')
  assert.equal(fs.statSync(archived).mode & 0o077, 0, 'the archive keeps the draft permissions')
  assert.deepEqual(displacedEdits(reservedDir), [path.join(reservedDir, reservedCopy())], 'a write through an open descriptor is kept and flagged')
  fs.rmSync(path.join(reservedDir, reservedCopy()))
  for (const name of ['rejected-p9.md', 'rejected-p9-1.md']) fs.rmSync(path.join(processedDir, name))

  const rejectMe = inbox('harvest-2026-09-24-pi-p9.md', { summary: 'Vague chit chat about lunch that should never reach the wiki pages' })
  assert.equal(judge.reviewInbox(vault, rel(rejectMe), { decision: 'reject', reason: 'not durable' }).archived, 'docs/inbox/ai/processed/rejected-harvest-2026-09-24-pi-p9.md')
  const editedReject = inbox('harvest-2026-09-24-pi-p10.md', { summary: 'Session note edited while its rejection moves it to the archive' })
  const { renameSync } = fs
  fs.renameSync = (from, to) => { if (from === editedReject) fs.appendFileSync(from, 'Edited during the reject.\n'); return renameSync(from, to) }
  let editedReport
  try { editedReport = judge.reviewInbox(vault, rel(editedReject), { decision: 'reject', reason: 'not durable' }) } finally { fs.renameSync = renameSync }
  assert.equal(editedReport.archived, null, 'a refused archive is reported, not claimed')
  assert.match(fs.readFileSync(editedReject, 'utf8'), /Edited during the reject/)
  fs.rmSync(editedReject)
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
