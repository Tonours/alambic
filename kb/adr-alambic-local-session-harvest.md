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
  check it. A note whose body is already in the update target is a NOOP.
- `nightly --push` runs on the vault owner's machine from a LaunchAgent that
  `setup --schedule` installs. It commits only `kb/`, `ref/` and the enrich
  ledger, and pushes one commit with every gate green. Secrets stay in the login
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
  rejected)` as the write-precision metric.
- A red gate leaves the tree dirty and the next run refuses at preflight until a
  human resolves it (fail-closed).
- Existing inbox notes citing session sources now wait for review.
- The TTY check on `review --inbox --decision accept` is a procedural guard,
  not proof of a human: any same-user process that opens a pseudo-terminal can
  write a receipt. Agents must never run it; the receipt only binds the exact
  bytes that were reviewed.
- Nightly snapshots the publishable tree before validate, lint and leak-scan,
  and commits that exact tree; an edit landing during the gates aborts the run.
- Nightly also commits deletions under `docs/inbox/`, so a tracked inbox note
  archived by promotion or NOOP leaves a clean tree.

## Related

- [[capture-quarantine-before-kb]]
- [[alambic-self-improvement-loop]]
- [[shadow-apply-gate]]
