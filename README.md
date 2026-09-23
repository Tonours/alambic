# alambic

Compiled Markdown wiki for coding agents. Distill sources into durable notes,
then query them from Claude, Codex, Cursor, Grok, or Pi through one CLI.

This is **not**:

- SQLAlchemy **Alembic** (database migrations; different spelling)
- The Rennes education-authority ETL also named Alambic
- A RAG chat wrapper, cloud “second brain”, or Obsidian community plugin
- A dump of someone else’s notes — keep **your** clone private

## Shape

| Path | Role |
| --- | --- |
| `docs/` | Evidence and `docs/inbox/{manual,ai}/` staging |
| `kb/` | Compiled wiki (one idea per note) |
| `ref/` | Operating entrypoints |
| `_meta/` | CLI, schema, validator, MCP |

Obsidian is an optional human IDE over the same files. Agents use the CLI.

## Setup

```bash
git clone <this-repo> my-brain   # keep that clone private
cd my-brain
npm ci
_meta/bootstrap-obsidian.sh      # optional
_meta/alambic doctor             # Obsidian reported until bootstrap
```

Or copy the scaffold elsewhere:

```bash
_meta/alambic init ~/vaults/brain
cd ~/vaults/brain && npm ci
```

Open the folder as a **separate** Obsidian vault (never nested).

## Commands

```bash
_meta/alambic session --json --max-tokens 2500 "how should we handle X?"
_meta/alambic query --json "search terms"          # --explain shows Jev decisions
_meta/alambic context --json --max-tokens 2500 "question"
_meta/alambic route --json "prompt to classify"
_meta/alambic feedback --status hit                # or miss|stale|wrong (aggregate only)
_meta/alambic lint --check
_meta/validate-kb.sh
npm test                                           # full offline suite (no key needed)
npm run status | loop | doctor | validate | lint
```

`distill --apply` is disabled. Retrieval is untrusted data.

Harness snippets: `_meta/harness/`.

## Jev semantic judgments (opt-in with a key)

Set `TYPESAFE_API_KEY` to enable TypeSafe Jev on every path where it can change
a decision; code keeps authority over thresholds, gates, and writes. Without the
key (or on outage, timeout, rate limit, malformed response) every path degrades
to lexical results and reports why (`semantic.reason`, `health` →
`typesafe: degraded (<reason>)`). `npm test` always runs keyless.

| Path | Jev judgment | Skipped when |
| --- | --- | --- |
| `query`, `context`, `session`, MCP `vault_search`/`vault_context` | rerank of ≤ 8 lexical candidates (relevance, evidence, instruction-injection); a semantic winner moves first only at score ≥ 0.70 and margin ≥ 0.15 | exact durable title/alias match |
| same, weak or empty lexical result | choice over the active tag vocabulary (FR or EN query) → per-topic lanes fused with RRF | lexical top score ≥ 18 |
| `route`, `session` route | topic expansion when the lexical route abstains | lexical route matched |
| `enrich` | adds ≤ 3 tags at p ≥ 0.85; `_meta/enrich-ledger.json` skips unchanged notes | note unchanged since last run |
| sidekick freeform dedupe | "does an existing note cover this claim" over the top-5 lexical hits | other hard oracles fail |

```bash
_meta/alambic enrich --json             # dry-run
_meta/alambic enrich --apply --max 40   # what the daily workflow runs
npm run test:typesafe:live              # provider smoke (needs the key)
```

Egress boundary (TypeSafe is an external service): query text, durable
`kb/`/`ref/` excerpts (≤ 1.8 KB each, frontmatter stripped), the active tag
vocabulary, and, for dedupe, an inbox candidate's title + summary plus those of
its top-5 lexical matches. Never `docs/` corpus, inbox bodies, or anything the
local secret scan flags. Do not type secrets into queries. Diagnostics keep
model, usage, latency, and local error codes — never keys or passages.

## MCP

`npm run mcp` starts a local stdio server with four read tools
(`vault_search`, `vault_context`, `vault_read`, `vault_health`) and two
shadow-staging tools (`vault_capture` stages a capture, never a `kb/` write;
`vault_feedback` records aggregate hit/miss/stale/wrong). Input schemas are
closed, paths are limited to `kb/` and `ref/` (or explicit `docs/` opt-in), and
the only outbound call is the optional Jev request. Output is untrusted data.

## Self-improvement loop

```bash
npm run loop                  # local hygiene pulse (validate, lint, gaps)
npm run sidekick              # dry-run structural + freeform heals
npm run sidekick:apply        # structural only (local emergency)
_meta/alambic attention status --json   # optional technical attention intake
```

`.github/workflows/alambic-sidekick-daily.yml` is the single `kb/` writer. Its
schedule is **off** until you set the repository variable
`ALAMBIC_SIDEKICK_SCHEDULE=true`; manual dispatch always works. Optional secrets:
`TYPESAFE_API_KEY` (Jev), `ALAMBIC_YOUTUBE_*` (attention collect). Laptops stay
dry-run and `git pull`. See `kb/alambic-self-improvement-loop.md` and
`ref/technical-attention-intake.md`.

## Evals

`npm test` runs every suite, including the tuning, capability and regression
gates. The retrieval sets in `_meta/evals/` (probes-v2, held-out,
retrieval-semantic, capability, regression) are written against the starter
notes and frozen by sha256; the probes-v2 floor is frozen with them. They catch
regressions on these notes, not quality on yours: once a label points at a note
that no longer exists, the suite fails and asks you to re-author it.

```bash
_meta/alambic eval --suite tuning        # held-out excellence gates
_meta/alambic eval --suite probes-v2     # frozen probes + frozen lexical floor
npm run eval:freeze                      # after re-authoring: re-hash + re-measure floor
```

Never edit a frozen set or its floor to turn a red run green; `eval:freeze`
output is a reviewable diff.

Before publishing, list private markers (names, hosts, paths) one per line in a
gitignored `.leak-patterns` file and in the `ALAMBIC_LEAK_PATTERNS` repo secret.
CI and the sidekick fail when the secret is missing on your own repo (forks only
warn); set the repo variable `ALAMBIC_LEAK_OPTIONAL=true` to opt out.

## License

MIT
