<p align="center"><img src="docs/assets/alambic-logo.svg" alt="alambic" width="160"></p>

# alambic

A compiled Markdown wiki for coding agents. You distill sources into short,
sourced notes, and your agents query them through one CLI: Claude Code, Codex,
Cursor, Pi, or anything that can run a shell command.

```
docs/inbox/  ──►  review / promote  ──►  kb/ + ref/  ──►  alambic session / context
(raw capture)                            (durable wiki)    (cited, token-capped packs)
```

The repo ships a small starter wiki. Replace it with your own notes and keep
your vault private. Agents treat everything retrieval returns as untrusted
data, and nothing distills captures into `kb/` automatically: `distill --apply`
is disabled.

## Layout

| Path | Role |
| --- | --- |
| `docs/` | Sources, plus `docs/inbox/{manual,ai}/` staging |
| `kb/` | Compiled wiki, one idea per note |
| `ref/` | Entrypoints: home, method, policies |
| `_meta/` | CLI, schema, validator, MCP server, evals |

Obsidian is optional: it gives humans a UI over the same files. Agents use the CLI.

## Setup

One command creates a vault and wires your agents to it:

```bash
npx github:Tonours/alambic init ~/vaults/brain --install
```

`init` copies the
publishable files into the new folder. `--install` then runs these steps
inside it:

```bash
npm ci
_meta/bootstrap-obsidian.sh
_meta/alambic setup --yes    # options after --install land here
_meta/alambic doctor
```

For example, `--install --harness claude,codex --prompt-hook`. If a step
fails, the command stops and names it. Fix the cause, then run the remaining
steps yourself from the vault.

To work on alambic itself, clone it:

```bash
git clone <this-repo> my-brain   # keep this clone private
cd my-brain
npm ci
_meta/bootstrap-obsidian.sh      # optional, but doctor fails until you run it
_meta/alambic doctor
```

From a clone, `_meta/alambic init <dir> [--install]` works the same way.
Private patterns, inbox captures, and caches never get copied.

Open the folder as its own Obsidian vault, never nested inside another one.

## Use from any project

```bash
_meta/alambic setup                  # checkbox picker in a terminal
_meta/alambic setup --yes            # detected harnesses, defaults, no prompt
_meta/alambic setup --yes --harness claude,codex --prompt-hook
_meta/alambic setup --status         # installed, drifted, outdated, pending-trust
_meta/alambic setup --uninstall --yes
```

Setup wires the vault into Claude Code, Codex, Pi, opencode and Cursor at user
level, with absolute paths:

| Component | Default | What it writes |
| --- | --- | --- |
| skill | on | `alambic` skill: `$CLAUDE_CONFIG_DIR/skills` for Claude, `~/.agents/skills` for the others |
| MCP | on | `claude mcp add` / `codex mcp add`, `opencode.json`, `~/.cursor/mcp.json` (Pi has no MCP) |
| CLI shim | on | `~/.local/bin/alambic` |
| per-prompt context | off | a hook that adds up to 3 matching notes to each prompt |

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

The per-prompt hook is lexical and local: it never calls TypeSafe, even with
`TYPESAFE_API_KEY` set. It injects only when a `verified` or `accepted` note
scores above the threshold frozen in `_meta/evals/hook-gate.json`, caps the
block at 1200 tokens, marks it untrusted, and always exits 0. Codex runs new
hooks only after you approve them in `/hooks`; `setup --status` shows
`pending-trust` until then.

Setup bakes in the absolute Node path, through Homebrew's `opt/` link when
Node comes from a Cellar. After a Node upgrade that moves the binary, `doctor`
reports items as `outdated`; rerun `_meta/alambic setup --yes`.

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

## Commands

```bash
_meta/alambic session --json --max-tokens 2500 "how should we handle X?"
_meta/alambic context --json --max-tokens 2500 "question"
_meta/alambic query --json "search terms"     # --explain shows Jev decisions
_meta/alambic route --json "prompt to classify"
_meta/alambic feedback --status hit           # or miss, stale, wrong (counts only)
_meta/alambic lint --check
_meta/validate-kb.sh
npm test                                      # full offline suite, no key needed
```

npm shortcuts: `status`, `loop`, `doctor`, `setup`, `validate`, `lint`, `session`, `mcp`.

Per-agent notes and the hook templates setup installs live in `_meta/harness/`.

## Jev semantic judgments (opt-in)

Set `TYPESAFE_API_KEY` and alambic asks TypeSafe Jev for a judgment wherever one
can change a decision. Code still owns thresholds, gates, and writes. Without
the key, or when the provider fails (outage, timeout, rate limit, bad response),
every path falls back to lexical results and says why in `semantic.reason`.
`health` shows `typesafe: degraded (<reason>)`. `npm test` always runs keyless.

| Path | Jev judgment | Skipped when |
| --- | --- | --- |
| `query`, `context`, `session`, MCP `vault_search`/`vault_context` | rerank of ≤ 8 lexical candidates (relevance, evidence, instruction injection); a semantic winner moves first only at score ≥ 0.70 and margin ≥ 0.15 | exact durable title/alias match |
| same, weak or empty lexical result | pick topics from the active tag vocabulary (FR or EN query), then fuse per-topic lanes with RRF | lexical top score ≥ 18 |
| `route`, `session` route | topic expansion when the lexical route abstains | lexical route matched |
| `enrich` | adds ≤ 3 tags at p ≥ 0.85; `_meta/enrich-ledger.json` skips unchanged notes | note unchanged since last run |
| sidekick freeform dedupe | "does an existing note already cover this claim?" over the top-5 lexical hits | another hard oracle fails first |

```bash
_meta/alambic enrich --json             # dry-run
_meta/alambic enrich --apply --max 40   # what the daily workflow runs
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

- read: `vault_search`, `vault_context`, `vault_read`, `vault_health`
- staging: `vault_capture` stages a capture in local state, `vault_feedback`
  counts hit/miss/stale/wrong. Neither writes to `kb/` or `ref/`.

Input schemas are closed. Reads are limited to `kb/` and `ref/`, plus `docs/`
when you opt in. The only outbound call is the optional Jev request.

## Self-improvement loop

```bash
npm run loop                            # local pulse: validate, lint, gaps
npm run sidekick                        # dry-run of structural + freeform fixes
npm run sidekick:apply                  # structural only, local emergency
_meta/alambic attention status --json   # optional technical attention intake
```

`alambic nightly --push` is the only automation that writes to `kb/`. It runs
on the machine that owns the vault, from a LaunchAgent that `setup --schedule`
installs:

```bash
_meta/alambic setup --yes --name work --schedule 05:15 --harvest-hook
_meta/alambic nightly --dry-run --json   # what the agent runs, without commit
```

One run holds the harvest lock, checks a clean tree on the default branch equal
to `origin`, then runs harvest scan, distill, enrich (when `TYPESAFE_API_KEY`
is in the login env), sidekick, validate, lint, leak-scan and the eval suites
listed in `_meta/tests/run.sh` as `eval --suite NAME` commands (without the key, on their own state; an unreadable file, no suite or a `--suite` it cannot parse turns the gate red). It commits only
top-level `kb/` and `ref/` files, `_meta/enrich-ledger.json` and the deletion
of inbox notes it promoted, only as its own steps wrote them and exactly as the
gates checked them on an export of that tree, and pushes that one commit, on top of the HEAD preflight validated, when every gate is green. A file you edit during the run is never overwritten: the run refuses it, or keeps your copy in `.git/alambic-displaced/` (always that private 0700 directory, or `displaced/` in the alambic state directory outside git; no environment variable moves it, and a failed git lookup refuses the write) and stops until you resolve it. A copy still named `inflight-…` belongs to a swap or archive that never finished: it blocks the run too, and moving it back to its original path restores the draft. Switching branch during the run cancels the commit. Every write alambic makes, in nightly or by hand, keeps the replaced file there. Copies that still match the sha in their name are backups; delete them when you like. alambic never deletes a file it cannot verify: a stray copy left under `kb/` or `ref/` blocks the next run until you remove it. The plist holds paths, never secrets. macOS only; the
`alambic-sidekick-daily.yml` workflow stays for manual dispatch.
`ALAMBIC_YOUTUBE_*` secrets feed attention collect. Details in
`kb/alambic-self-improvement-loop.md`, `kb/adr-alambic-local-session-harvest.md`
and `ref/technical-attention-intake.md`.

### Session harvest

```bash
_meta/alambic harvest scan --dry-run --json   # Claude, Codex, Pi sessions
_meta/alambic harvest status --json           # counters (reviews counted from their receipts), acceptance rate, pending
_meta/alambic review --inbox docs/inbox/ai/harvest-….md --decision accept --reason "…"
```

`--harvest-hook` adds a Claude `SessionEnd` hook that queues the ended
transcript in local state and returns at once. `harvest scan` scores new
sessions without reading the vault; `harvest distill` turns queued excerpts
into gitignored `docs/inbox/ai/harvest-*.md` drafts through an external
distiller (`ALAMBIC_HARVEST_DISTILLER`, default `claude -p` with no tools).
An entry that fails three times moves, excerpt included, to
`$STATE/harvest/processed/`; move it back to `harvest/queue/` to retry it.
Session drafts never reach `kb/` without an accept receipt from an interactive
`review`, bound to the file's sha256. The TTY check keeps scripts out, not a
determined local process: never let an agent run `review --inbox`. A draft whose title and body an existing
note already contains (whitespace aside for prose; a body with any indented or fenced line must appear byte for byte), or whose exact body an earlier update of that note wrote and left intact (the `alambic-body` comment and its quote), is archived as `noop-*`, only while that note is unchanged
since the check. `harvest digest --out` and
`harvest ack --digest` hand the queue to another writer (a vault with its own
capture agent) and clear it only after that writer pushed.

## Evals

`npm test` runs every suite, tuning, capability, and regression gates included.
The retrieval sets in `_meta/evals/` are labeled against the starter notes and
frozen by sha256, together with the probes-v2 floor. They catch regressions on
those notes; they say nothing about quality on yours. Once a label points at a
note you deleted, the suite fails and asks you to re-author the set.

```bash
_meta/alambic eval --suite tuning        # held-out excellence gates
_meta/alambic eval --suite probes-v2     # frozen probes + frozen lexical floor
npm run eval:freeze                      # after re-authoring: re-hash, re-measure the floor
node _meta/tests/mcp-bench.mjs . _meta/evals/probes-v2.jsonl --runs 3   # MCP-path latency + quality (needs the key)
```

Don't edit a frozen set or its floor to turn a red run green. `eval:freeze`
produces a diff; review it like code.

## Leak scan

Before you publish anything, list your private markers (names, hosts, paths),
one per line, in a gitignored `.leak-patterns` file and in the
`ALAMBIC_LEAK_PATTERNS` repo secret, then run `_meta/tests/leak-scan.sh`. On
your own repo, CI and the sidekick fail when the secret is missing; forks only
get a warning. Set the repo variable `ALAMBIC_LEAK_OPTIONAL=true` to opt out.
A public string that contains a marker, like the `npx` slug above, goes in
`.leak-allow`, one exact string per line; any other occurrence still fails.
Binary files are scanned too, and a hit prints only `file:line`.

## License

MIT
