---
type: adr
status: accepted
summary: "Agent sessions feed each vault from the machine that owns it: a local nightly LaunchAgent harvests, distills and heals, and session drafts reach kb only with a human accept receipt."
created: 2026-09-24
updated: 2026-09-24
sources:
  - "_meta/lib/harvest.mjs"
  - "_meta/lib/nightly.mjs"
  - "_meta/lib/promotion-judge.mjs"
  - "_meta/lib/setup.mjs"
  - "_meta/hooks/harvest-hook.mjs"
tags:
  - alambic
  - capture
  - automation
  - knowledge-promotion
aliases:
  - session harvest
  - nightly local alambic
  - récolte des sessions
claims:
  - "alambic session harvest | kb gate | human accept receipt bound to sha256 | session-origin drafts"
  - "alambic nightly | scheduler | local LaunchAgent per vault owner | not GitHub Actions"
---

# ADR: local session harvest and nightly run

## Context

Knowledge from daily agent sessions never reached the vault without a copy-paste
step. The daily sidekick ran on GitHub Actions, away from the machine that holds
the session files, and the freeform judge treated `claude:`, `codex:` and `pi:`
sources as inspectable, so a session-derived inbox note would have auto-applied.

## Decision

- `harvest scan` reads Claude, Codex and Pi sessions, scores them without
  reading the vault and queues unsafe-filtered excerpts in local state only.
- `harvest distill` asks an external command for JSON; alambic renders the
  frontmatter as `status: draft`, `origin: session-harvest`, so the model cannot
  set review fields. Drafts stay in gitignored `docs/inbox/ai/harvest-*.md`.
- A session-origin note never auto-applies without an accept receipt matching
  its current sha256; the judge, the post-Jev re-gate and the promote step each
  check it. A note whose title and body are already in the update target is a
  NOOP.
- `nightly --push` runs on the vault owner's machine from a LaunchAgent that
  `setup --schedule` installs. It commits only top-level `kb/` and `ref/` files,
  the enrich ledger and inbox deletions, and only content its own steps wrote,
  then pushes that one commit SHA with every gate green. Secrets stay in the login
  env, never in the plist.
- A vault with its own capture agent consumes `harvest digest` and acks it
  after its push.

## Alternatives rejected

- Running the sidekick from the `SessionEnd` hook: exit latency and concurrent
  writers. The hook only queues the transcript in a detached process.
- Writing drafts straight to `kb/` as `status: draft`: pollutes retrieval and
  skips review.
- Keeping the GitHub schedule: the runner never sees local sessions.

## Consequences

- `harvest status` reports `review_acceptance_rate = accepted / (accepted +
  rejected)`, a review acceptance rate, not a measure of knowledge accuracy.
- A red gate leaves the tree dirty and the next run refuses at preflight until a
  human resolves it (fail-closed).
- Existing inbox notes citing session sources now wait for review.
- The TTY check on `review --inbox --decision accept` is a procedural guard,
  not proof of a human: any same-user process that opens a pseudo-terminal can
  write a receipt. Agents must never run it; the receipt only binds the exact
  bytes that were reviewed.
- Nightly snapshots the publishable tree before validate, lint and leak-scan,
  and commits that exact tree; an edit landing during the gates aborts the run.
- Enrich and the promotion writers re-check each file's sha256 before they
  rename over it, refuse the write when it changed since they read it, and
  journal preimage and result (`ALAMBIC_WRITE_JOURNAL`). Nightly commits a path
  only when its staged blob ends an unbroken chain of journaled writes starting
  at the HEAD blob, so a human edit made during the run is never published.
  Every checked write (nightly, sidekick or enrich run by hand) moves the old
  file into `.git/alambic-displaced/` (the state dir outside git) before
  the new one is linked; a copy that changed after the check is kept and
  blocks until a human resolves it (see below for which run), so no edit is
  lost. Nightly never deletes a displaced copy; an intact copy is a backup and
  does not block. The displaced directory must be a real directory, never a
  symlink.
- Validate, lint and leak-scan run on an export of the snapshot tree, and
  nightly resumes only the unpushed commit SHA it recorded itself. A relative
  `ALAMBIC_LEAK_PATTERNS_FILE` resolves against the vault; a configured file
  that is missing, or a present default (dangling link included) that is not a
  readable file, refuses the run, and leak-scan refuses it again when it
  reads the rules.
- Nightly commits to, and resumes on, the branch ref preflight validated and
  refuses when HEAD points elsewhere. Only committing runs check the snapshot
  export, written from raw blobs so no checkout filter changes what the gates
  read; a dry run checks the live checkout.
- A displaced copy that changes before nightly checks the copies blocks that
  commit; one that changes later blocks the next run.
- Nightly holds `.git/index.lock` from its index check to the index refresh,
  and refreshes only the committed paths, so the user's index is never
  clobbered.
- Promotion archives only into a real `docs/inbox/ai/processed/` directory
  inside the vault and never overwrites an existing archive. It renames the
  draft to a reserved name first and archives it only when its bytes still
  match what the judge read (NOOP included), so a save landing before the
  archive stays in the inbox. The archive is written from the verified buffer;
  the original inode stays displaced, so a write through an open descriptor
  blocks the next run. A NOOP also needs its update target unchanged since the
  judgment, checked again after the move; a change puts the draft back. A
  rejected draft that changed is not archived, and the review says so. A failed
  archive write, cleanup or journal append restores the source, and an archive
  directory swapped during the write undoes the archive: the written copy is
  removed by inode and the source comes back from the displaced inode; when a
  new source already took its place, the displaced copy stays as the backup.
- A displaced directory that exists but cannot be read blocks the run.
- Nightly also commits deletions under `docs/inbox/`, so a tracked inbox note
  archived by promotion or NOOP leaves a clean tree.

## Related

- [[capture-quarantine-before-kb]]
- [[alambic-self-improvement-loop]]
- [[shadow-apply-gate]]
