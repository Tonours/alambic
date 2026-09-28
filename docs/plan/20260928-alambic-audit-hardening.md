# Implemented: alambic audit hardening and memory-delivery quick wins

## Metadata
- Archived: 2026-09-28
- Source plan: `PLAN.md` — harden alambic after the 2026-09-28 audit and adopt the research-backed memory-delivery quick wins
- Source plan SHA-256: `f810e897687a9cc0421f94439796bf611ca88dcfebd38e9743829fb21a5b7ce6`
- Status: IMPLEMENTED
- Commit / branch: `fix/alambic-audit-hardening`, cut from `main` at `7774531`; last code commit `91c1af5`; not pushed
- Workflow initiative: `alambic-hardening`

## Outcome
- A1 (`84d314f`): every entry point decodes file URLs with `fileURLToPath`, and retrieval commands refuse a root without `kb/`. `_meta/tests/path-encoding.mjs` proves a vault named `My Vault é` validates, answers `query --json` and spawns the CLI from MCP.
- A2 (`7b459e0`): `init` copies only the publishable set on both the git and the fallback paths: no inbox captures, no `docs/plan/`, no `docs/research/`, no `review-dispatch.yml`.
- A3 (`93955bf`): the suite scrubs `ALAMBIC_*` (except `ALAMBIC_LEAK_*`), the attention tests pin their keychain account and keep an env-override test, and the loop-pulse test runs on a temp vault copy. The live vault stays byte-identical across both suites.
- A4 (`8a0d0f7`): `eval --suite capability` fails on any recorded failure, proven by a temp-root hard-miss fixture; the frozen capability set is unchanged.
- A5 (`9b52bea`): every action is pinned to the SHA of the latest release in its current major, resolved read-only, with a version comment; secrets reach steps through `env:`.
- A6 (`b47d06c`): labels and docs name the local nightly as the scheduled writer; the unlock flag is documented as label-only.
- A7 (`13701ac`): candidates and receipted proposals expire after 7 days, unreceipted proposals after 30, and the purge count goes to stderr.
- A8 (`9b45417`): `npm audit` reports 0 vulnerabilities after in-range updates of three transitive packages.
- A9 (`b3ec1fe`): the distiller child gets no `TYPESAFE_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` or `ALAMBIC_*` variable except the recursion guard.
- A10 (`0cc9053`): the prompt-hook gate opens on the best direct durable hit; graph rows never open it alone; `_meta/evals/hook-gate.json` is unchanged.
- A11 (`2f14fd9`): the README scopes the displaced-copy claim to journaled vault writes.
- A12 (`02678dd`): the dead reddit connector is gone; the `reddit-upvoted` enum stays for the frozen attention eval and is documented as not ingestible.
- A13 and R3 (`f8742c4`, `cf1f9a4`): `--prompt-hook` adds a Claude Code `SessionStart` entry (matcher `compact`) and a Cursor `sessionStart` entry that re-assert the L0 block with a pointer to the vault's own CLI. Setup retires the inert Cursor `beforeSubmitPrompt` entry by fingerprint on apply and on uninstall.
- R1 (`aed476e`, `79e8b39`): `review --inbox` without a decision prints the promotion plan (action, target, reason, bytes) and changes nothing. The byte count comes from the `promotionWrite` builder that the apply also uses.
- R2 (`df9bda2`): a frozen canary suite (25 attacks, 12 benign controls) gates `scanUnsafe` at a 0.6 catch-rate floor and a 0 benign false-positive ceiling; `eval:freeze --only canaries` refuses a lower floor or a higher ceiling.
- R4 (`732d23a`, `9ff95ef`, `91c1af5`): within one session the prompt hook injects a note at most once until it changes or the session compacts, with bounded `0600` state that fails open.
- R5 (`bd1bcaf`): `doctor` reports the inbox draft count, the oldest age and the drafts older than 14 days, as warnings only.
- R6 (`9c5201c`): `SECURITY.md` states the receipt boundary, the filters, a worked poisoning example and the scope of native harness memory.
- R7 (`96fb1df`): the skill description names its triggers in 383 characters, under the 1024-character limit.

## Context
- The Claude plan-ready guard blocks writes and non-read-only shell commands before READY, and blocks mutating shell commands that name the plan file while it is READY.
- The Claude no-comments hook refuses added comment lines in code files, so obsolete comments were deleted rather than reworded.
- The `autonomous-completed` ledger profile needs the review and the code-diff adversary after the last `file_changed`, so the simplification and quality passes ran before the review.
- Node runs a main script from its real path; assertions on paths under a symlinked temp dir compare real paths.

## Decisions
### Cursor hook migration
- Context: Cursor's `beforeSubmitPrompt` output accepts only `continue` and `user_message`.
- Choice: new `claude:session` and `cursor:session` ids under `--prompt-hook`, and a `RETIRED` list that removes the recorded `cursor:hook` entry through `removeAction`.
- Rejected options: reusing the `cursor:hook` id with a new entry path, which would orphan the old entry outside the manifest.
- Rationale: setup only removes what its manifest recorded, so user entries stay.
- Consequences: the setup golden was re-pinned in S9 and S19, each time with the golden-item diff printed.

### State purge policy
- Context: the purge ran on every state command and ignored receipts.
- Choice: 7 days for candidates and receipted proposals, 30 days for unreceipted proposals.
- Rejected options: purging a proposal as soon as it is receipted.
- Rationale: that would make the distillation conflict and tamper evals pass for the wrong reason.
- Consequences: documented in `SECURITY.md`.

### Canary freeze
- Context: the full `eval:freeze` rewrites the held-out and probes-v2 freeze entries.
- Choice: a separate `canaries.freeze.json` written by `eval:freeze --only canaries`, with a digest binding the floor and the ceiling.
- Rejected options: re-freezing every set to add the canaries.
- Rationale: the freeze diff stays one new file, and no other frozen set moves.
- Consequences: the payloads are stored as split `parts` so no scanner sees a working secret in the tree.

### Review budget
- Context: the previous harvest run needed 31 review rounds.
- Choice: one reviewer (Axis: Logic) and one adversary per pass, untagged rounds, at most two fix rounds, then high findings only.
- Rejected options: the tagged T/D/F round machine, which forces an extra full pass after a clean first tour.
- Rationale: the goal set the budget.
- Consequences: three passes and two fix rounds; the final pass closed as GO WITH NOTES with no high finding.

## Accepted Drift
- Original plan/spec: the adversary contract prefers a cross-family plan pass.
- Implemented reality: two same-family plan passes, labeled as such.
- Why accepted: the goal scoped the run to same-family review.
- Original plan/spec: one commit per step.
- Implemented reality: S9 carries R3 and A13 in one commit, and the review added separate fix commits for R1, R3 and R4.
- Why accepted: the plan bundled R3 with A13, and each review fix is its own behavior.

## Validation Evidence
- command: `npm test` in the owner's shell with `ALAMBIC_*` exported
  - result: exit 0, `alambic tests: ok` on `91c1af5`
- command: `env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" npm test`
  - result: exit 0, `alambic tests: ok`
- command: `ls -la docs/inbox/ai` and `shasum -a 256 _meta/loop-pulse.latest.json` before and after both suites, then `diff`
  - result: identical captures, exit 0
- command: `_meta/validate-kb.sh`
  - result: `alambic validate: ok (strict, 22 notes)`
- command: `_meta/alambic lint --check`
  - result: exit 0
- command: `_meta/tests/leak-scan.sh`
  - result: `leak-scan: ok`
- command: `npm audit --audit-level=high`
  - result: exit 0, `found 0 vulnerabilities`
- command: the A1, A5 and A6 `git grep` checks
  - result: no output, exit 0
- command: `node _meta/tests/path-encoding.mjs .`
  - result: `path-encoding tests: ok`
- command: `_meta/alambic eval --suite canaries`
  - result: exit 0; catch rate 0.6 at the frozen floor, benign false-positive rate 0 at the frozen ceiling
- command: `workflow-event validate alambic-hardening --profile autonomous-completed`
  - result: run once after `completed`, recorded in the ledger

## Follow-up State
- Remaining risks: a live Cursor `sessionStart` run, the real `claude -p` distiller authentication and the `session_id` behavior after `/clear` are not verified.
- Parking lot:
  - fixed after archiving (`e0e6e1a`): the review plan now follows the decision being recorded and any existing receipt;
  - fixed after archiving (`435e107`): an accept on a draft the judge rejects no longer claims a promotion;
  - move the distiller environment from a denylist to an allowlist;
  - decide whether `init` should ship `docs/research/` when a kb note cites it;
  - split plan `noop` into covered and failing drafts;
  - ratchet canaries per caught id rather than on a rate, then widen `scanUnsafe` to the ten missed attacks;
  - let the prompt hook honor `ALAMBIC_ROOT`;
  - lock the read-modify-write of `hook-sessions.json` if the lost-update cost matters.
- Superseded docs/specs: none.
- Next links: `docs/research/20260928-memory-engines-harness-memory.md` (adoption backlog and follow-ups F1–F12).
