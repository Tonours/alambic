# Operator guide

Details behind the [README](../README.md): setup internals, the nightly
writer, session harvest, semantic judgments, MCP, evals and the leak scan.

## Setup

`init` copies only the publishable files into the new folder. Private
patterns, inbox captures, caches, the maintainer's `docs/plan/` and
`docs/research/`, and the maintainer-only `review-dispatch.yml` workflow never
get copied, whether the source is a git checkout or a plain copy. From a
clone, `_meta/alambic init <dir> [--install]` works the same way.

`--install` then runs, inside the new vault:

```bash
npm ci
_meta/bootstrap-obsidian.sh
_meta/alambic setup --yes    # options after --install land here
_meta/alambic doctor
```

If a step fails, the command stops and names it. Fix the cause, then run the
remaining steps yourself from the vault.

`doctor` also reports inbox hygiene: how many drafts wait under `docs/inbox/`
(archived `processed/` copies excluded), the oldest one's age in days, and how
many are older than 14 days. A stale inbox is a warning, never a failure.

### What setup writes

```bash
_meta/alambic setup                  # checkbox picker in a terminal
_meta/alambic setup --yes            # detected harnesses, defaults, no prompt
_meta/alambic setup --yes --harness claude,codex --prompt-hook
_meta/alambic setup --status         # installed, drifted, outdated, pending-trust
_meta/alambic setup --uninstall --yes
```

| Component | Default | What it writes |
| --- | --- | --- |
| skill | on | `alambic` skill: `$CLAUDE_CONFIG_DIR/skills` for Claude, `~/.agents/skills` for the others |
| MCP | on | `claude mcp add` / `codex mcp add`, `opencode.json`, `~/.cursor/mcp.json` (Pi has no MCP) |
| CLI shim | on | `~/.local/bin/alambic` |
| per-prompt context | off | a hook that adds up to 3 matching notes to each prompt, plus the L0 block after a Claude Code compaction and at Cursor session start |

Without a terminal and without `--yes`, setup only prints its plan. Rerunning
it is safe: unchanged items stay untouched.

- Every write is recorded in `$XDG_STATE_HOME/alambic/setup.json`. Existing
  files get a `0600` backup first.
- Setup never replaces an entry it did not write. It reports a collision and
  leaves it alone.
- JSONC configs are refused. Setup prints the snippet to add yourself.
- Uninstall removes only what still matches what setup wrote. An identical
  entry that existed before setup stays, and config files setup created stay
  behind, emptied.
- Setup bakes in the absolute Node path, through Homebrew's `opt/` link when
  Node comes from a Cellar. After a Node upgrade that moves the binary,
  `doctor` reports items as `outdated`; rerun `_meta/alambic setup --yes`.

Per-agent notes and the hook templates live in `_meta/harness/`.

### Per-prompt hook

The hook is lexical and local: it never calls TypeSafe, even with
`TYPESAFE_API_KEY` set. It injects only when a `verified` or `accepted` note
scores above the threshold frozen in `_meta/evals/hook-gate.json`, caps the
block at 1200 tokens, marks it untrusted, and always exits 0.

- Within one session (when the runtime sends a `session_id`), a note is
  injected at most once until it changes or the session compacts. The hook
  keeps only note paths and content hashes, as `SECURITY.md` describes.
- The same opt-in adds a session-start entry that re-asserts the L0 block
  (`ref/critical-facts.md`, capped at 800 bytes) and a pointer to
  `alambic session`: Claude Code gets it from a `SessionStart` hook with
  matcher `compact`, Cursor from `sessionStart`.
- Cursor has no per-prompt entry, because its `beforeSubmitPrompt` output
  cannot add context. Rerunning setup removes a `beforeSubmitPrompt` entry
  that an older setup wrote, and leaves your own entries alone.
- Codex runs new hooks only after you approve them in `/hooks`;
  `setup --status` shows `pending-trust` until then.

### Several vaults

```bash
_meta/alambic setup --yes --name work                        # this vault as alambic-work
_meta/alambic setup --yes --name brain --vault ~/work/brain  # this engine, another vault
_meta/alambic setup --status --name brain
```

`--name <slug>` installs a separate set: skill, MCP entry and shim are named
`alambic-<slug>`, the manifest is `$XDG_STATE_HOME/alambic/setup-<slug>.json`,
and runtime state is pinned to `$XDG_STATE_HOME/alambic-<slug>` through
`ALAMBIC_STATE_DIR`. `--vault` points it at another vault's content (it needs
a `kb/`) while running this checkout's engine. Named sets never touch the
default `alambic` one. `--prompt-hook` stays with the default set only.
`doctor` checks every set recorded for the vault it runs in.

## Who writes what

| Run | Where | When | Writes to `kb/` |
| --- | --- | --- | --- |
| `nightly --push` | LaunchAgent on the vault owner's machine | daily, 05:15 by default | yes, the only scheduled writer |
| harvest hook | Claude `SessionEnd` hook | at each session end | no, queues the ended session for a scored scan |
| `loop --ci` / CI workflow | GitHub Actions | on push and PR | no, hygiene checks only |
| `alambic-sidekick-daily.yml` | GitHub Actions, manual dispatch | on demand | yes, one-off fallback heal |
| attention collect | local helper or CI step | on demand | no, stages inbox drafts only |

More in `kb/alambic-self-improvement-loop.md`,
`kb/adr-alambic-local-session-harvest.md` and
`ref/technical-attention-intake.md`.

## Nightly, the scheduled writer

`alambic nightly --push` runs on the machine that owns the vault, from a
LaunchAgent that `setup --schedule` installs. Other machines stay on dry-run
and pull.

```bash
_meta/alambic setup --yes --name work --schedule 05:15 --harvest-hook
npm run nightly:dry   # partial preview: enrich skipped, sidekick dry-run, gates on the live checkout
```

A green dry-run does not guarantee the next push. It skips enrich, never
applies sidekick writes, and checks the live checkout instead of an exported
snapshot, without the default-branch and upstream checks.

One run:

1. holds the harvest lock and checks a clean tree on the default branch equal
   to `origin`;
2. runs harvest scan, distill, enrich (when `TYPESAFE_API_KEY` is in the login
   env), sidekick, validate, lint, leak-scan and the eval suites listed in
   `_meta/tests/run.sh`, keyless and on their own state dir. An unreadable
   `run.sh`, a file with no suite, or a `--suite` flag the gate cannot parse
   turns the gate red;
3. when every gate is green, commits only top-level `kb/` and `ref/` files,
   `_meta/enrich-ledger.json` and the deletion of inbox notes it promoted. It
   commits exactly the tree the gates checked, on top of the HEAD preflight
   validated, and pushes that one commit. Any red gate means no commit.

### Your edits are never overwritten

A file you edit during the run is never overwritten. The run refuses it, or
keeps your copy in `.git/alambic-displaced/` and stops until you resolve it.
Outside git the copies land in `displaced/` under the alambic state dir. No
environment variable moves them, and a failed git lookup refuses the write.

Every write to vault content (`kb/`, `ref/` and inbox drafts) that enrich,
harvest, the sidekick or a promotion makes, in nightly or by hand, keeps the
replaced file there. The living-loop pulse (`_meta/loop-pulse.latest.json`)
and the `docs/inbox/ai/loop-queue-*.md` cards are gitignored artifacts,
rewritten in place without a copy.

Copies that still match the sha in their name are backups; delete them when
you like. Alambic never deletes a file it cannot verify: a stray copy left
under `kb/` or `ref/` blocks the next run until you remove it. A copy still
named `inflight-...` belongs to a swap or archive that never finished; moving
it back to its original path restores the draft. Switching branch during the
run cancels the commit.

### Secrets and platform

The plist holds paths, never secrets. Export `TYPESAFE_API_KEY` from
`~/.zprofile`: the agent runs through `zsh -lc`, which reads the login profile
and skips `~/.zshrc`. Without the key in that env, enrich reports skipped and
dedupe stays lexical. macOS only; the `alambic-sidekick-daily.yml` workflow
stays for manual dispatch. `ALAMBIC_YOUTUBE_*` secrets feed attention collect.

### Is it running

```bash
_meta/alambic setup --status --name work                        # schedule item installed and loaded
launchctl print gui/$UID/dev.alambic.alambic-work.nightly       # macOS agent state
alambic-work harvest status                                     # queue moving, reviews accepted
tail -n 40 ~/Library/Logs/alambic-work.nightly.log              # last run output
```

When a run wrote files and a gate turned red, the tree stays dirty and the
next run refuses at preflight until a human resolves it. That refusal is
fail-closed. Inspect `git status`, commit or discard what the run wrote, then
rerun `npm run nightly:dry` before the next scheduled pass. A dry-run also
refuses on a dirty tree, so it cannot serve as the cleanup step.

## Session harvest and review

```bash
npm run harvest:scan   # preview: Claude, Codex, Pi sessions
npm run harvest        # counters, acceptance rate, pending drafts
_meta/alambic review --inbox docs/inbox/ai/harvest-....md   # promotion plan only
_meta/alambic review --inbox docs/inbox/ai/harvest-....md --decision accept --reason "..."
```

`--harvest-hook` adds a Claude `SessionEnd` hook that queues the ended
transcript in local state and returns at once. `harvest scan` scores new
sessions without reading the vault; `harvest distill` turns queued excerpts
into gitignored `docs/inbox/ai/harvest-*.md` drafts through an external
distiller (`ALAMBIC_HARVEST_DISTILLER`, default `claude -p` with no tools). The
distiller gets no `TYPESAFE_API_KEY`, GitHub token or `ALAMBIC_*` variable. An
entry that fails three times moves, excerpt included, to
`$STATE/harvest/processed/`; move it back to `harvest/queue/` to retry it.

`review --inbox` prints the promotion plan the freeform judge would follow:
the action (`create`, `update` or `noop`), the target note, the judge's reason
and the number of bytes the promotion would write to `kb/`, computed by the
same code that applies it.

- Without `--decision`, it changes nothing and plans for an accept today.
- With `--decision`, the plan follows the decision being recorded: a reject,
  or a draft already rejected, plans `noop`.
- An accept writes a receipt; the next `sidekick --apply-freeform` (nightly)
  promotes the draft. When the judge would promote nothing (unsafe, too thin,
  already covered), the command says so instead of announcing a promotion.

Session drafts never reach `kb/` without an accept receipt from an interactive
`review`, bound to the file's sha256. The TTY check keeps scripts out, not a
determined local process: never let an agent run `review --inbox`. A draft the
target note already contains is archived as `noop-*` instead of waiting for
review. The exact match rule is narrower than it sounds (prose bodies match as
whole lines, code and quoted lines match byte for byte); the precise conditions
live in `kb/adr-alambic-local-session-harvest.md`. `harvest digest --out` and
`harvest ack --digest` hand the queue to another writer (a vault with its own
capture agent) and clear it only after that writer pushed.

With a named vault, run harvest and review through the named shim, so queue
counters and receipts land in the state dir the nightly reads:

```bash
alambic-work harvest status
alambic-work review --inbox docs/inbox/ai/harvest-....md --decision accept --reason "..."
```

Raw `_meta/alambic` uses the default state dir. The named nightly never reads
it, so a receipt written there would never unlock a promotion.

## Jev semantic judgments (opt-in)

Set `TYPESAFE_API_KEY` and alambic asks TypeSafe Jev for a judgment wherever
one can change a decision. Code still owns thresholds, gates, and writes.
Without the key, or when the provider fails (outage, timeout, rate limit, bad
response), every path falls back to lexical results and says why in
`semantic.reason`. `health` shows `typesafe: degraded (<reason>)`. `npm test`
always runs keyless.

| Path | Jev judgment | Skipped when |
| --- | --- | --- |
| `query`, `context`, `session`, MCP `vault_search`/`vault_context` | rerank of ≤ 8 lexical candidates (relevance, evidence, instruction injection); a semantic winner moves first only at score ≥ 0.70 and margin ≥ 0.15 | exact durable title/alias match |
| same, weak or empty lexical result | pick topics from the active tag vocabulary (FR or EN query), then fuse per-topic lanes with RRF | lexical top score ≥ 18 |
| `route`, `session` route | topic expansion when the lexical route abstains | lexical route matched |
| `enrich` | adds ≤ 3 tags at p ≥ 0.85; `_meta/enrich-ledger.json` skips unchanged notes | note unchanged since last run |
| sidekick freeform dedupe | "does an existing note already cover this claim?" over the top-5 lexical hits | another hard oracle fails first |

```bash
_meta/alambic enrich --json             # dry-run
_meta/alambic enrich --apply --max 40   # what the nightly run applies
npm run test:typesafe:live              # provider smoke test (needs the key)
```

What leaves your machine when the key is set: the query text, `kb/` and `ref/`
excerpts (≤ 1.8 KB each, frontmatter stripped), the active tag vocabulary, and
for dedupe an inbox candidate's title and summary plus those of its top-5
matches. `docs/`, inbox bodies, and anything the local secret scan flags stay
local. Don't type secrets into queries. Diagnostics keep model, usage, latency,
and local error codes, never keys or passages.

## MCP

`npm run mcp` starts a local stdio server with six tools:

- read: `vault_search`, `vault_context`, `vault_read`, `vault_health`;
- staging: `vault_capture` stages a capture in local state, `vault_feedback`
  counts hit/miss/stale/wrong. Neither writes to `kb/` or `ref/`.

Input schemas are closed. Reads are limited to `kb/` and `ref/`, plus `docs/`
when you opt in. The only outbound call is the optional Jev request.

## Evals

`npm test` runs every suite. The capability and regression gates fail on any
recorded failure, such as an expected note missing from the top results or an
unexpected abstention; the tuning gate enforces its score thresholds.

```bash
_meta/alambic eval --suite tuning        # held-out excellence gates
_meta/alambic eval --suite probes-v2     # frozen probes + frozen lexical floor
_meta/alambic eval --suite canaries      # scanUnsafe catch rate and false positives
npm run eval:freeze                      # after re-authoring: re-hash, re-measure the floor
node _meta/tests/mcp-bench.mjs . _meta/evals/probes-v2.jsonl --runs 3   # MCP-path latency + quality (needs the key)
```

The retrieval sets in `_meta/evals/` are labeled against the starter notes and
frozen by sha256, together with the probes-v2 floor. They catch regressions on
those notes; they say nothing about quality on yours. Once a label points at a
note you deleted, the suite fails and asks you to re-author the set.

The `canaries` suite measures `scanUnsafe` against 25 attack payloads
(instruction injection, fake system tags, hidden HTML, markdown-image
exfiltration, secret formats) and 12 benign controls. Its catch-rate floor and
benign false-positive ceiling live in `_meta/evals/canaries.freeze.json` under
a digest. `npm run eval:freeze -- --only canaries` re-freezes that set alone
and refuses a lower floor or a higher ceiling. Each payload is stored as
`parts` joined only at scan time, so no line of the tree holds a working
secret or injection. The first freeze (2026-09-28) caught 15 of 25 attacks;
the misses (fake system tags, hidden HTML, image exfiltration, reworded
injections) are the scanner's known gaps.

Don't edit a frozen set or its floor to turn a red run green. `eval:freeze`
produces a diff; review it like code.

## Leak scan

Before you publish anything, list your private markers (names, hosts, paths),
one per line, in a gitignored `.leak-patterns` file and in the
`ALAMBIC_LEAK_PATTERNS` repo secret, then run `_meta/tests/leak-scan.sh`.

- On your own repo, the CI leak-scan step and the sidekick fail when the
  secret is missing; forks only get a warning. Set the repo variable
  `ALAMBIC_LEAK_OPTIONAL=true` to opt out.
- In CI, only the `Leak scan` step receives the secret. The leak-scan inside
  `npm test` runs the generic checks and warns about missing patterns; that
  warning is expected.
- A public string that contains a marker, like the `npx` slug in the README,
  goes in `.leak-allow`, one exact string per line; any other occurrence still
  fails.
- Binary files are scanned too, and a hit prints only `file:line`.
