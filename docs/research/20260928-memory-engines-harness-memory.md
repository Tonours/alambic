# Memory engines and harness memory delivery: research for alambic

Date: 2026-09-28. Baseline: HEAD `7774531`. Status: research. This is not an implementation plan: any adoption goes through a root `PLAN.md` with `Status: READY`.

This note complements two earlier private studies without repeating them:
- a harness-landscape study (2026-09-28), which covered workflow harnesses, the Mem0 LOCOMO table, compaction strategies and Claude Code auto memory;
- a vault synthesis (2026-09-04), which covered the LLM-wiki pattern, LangMem, Graphiti on LongMemEval, vectorless retrieval and the instruction-file budget.

Labels:
- `confirmed`: a primary source states it;
- `verified`: checked by the author (source code, raw docs, `gh api`, or a local run);
- `inferred`: reasoned from confirmed facts;
- `not verified`: secondary sources only.

Three research passes produced Parts 1–3. The parent re-checked the decisive claims and corrected four of them (see the verification log).

## Conclusion

1. **The human gate is alambic's differentiator, and it is the part the security literature says matters.**
   - None of the 22 comparable projects in Part 1 puts a sha256-bound human accept between capture and durable memory.
   - Every memory-poisoning attack reviewed in Part 3 assumes a memory that writes without a human gate:
     - AgentPoison: over 80% attack success at under 0.1% poison rate;
     - MemGhost: one email, 87.5% success against OpenClaw/GPT-5.4 and 71.4% against a Claude Code SDK agent on Sonnet 4.6 (`verified`);
     - Cisco's "MemoryTrap": a real compromise of Claude Code's own `MEMORY.md` through an npm `postinstall` hook, published 2026-04-01 and mitigated in Claude Code v2.1.50 by removing user memories from the system prompt (`verified`).
   - The gate's weak spot is what the reviewer sees. `review --inbox` shows the draft, but not what promotion will do with it (`verified`, `_meta/lib/promotion-judge.mjs:249-262`).
2. **Memory does not pay for itself by default.** VibeMemBench (arXiv 2609.23570, 2026-09-20, `verified`) ran 111 real repository tasks:
   - injecting a pre-verified experience helps, by +1.1 to +4.5 points;
   - yet 11 of 12 solver/memory-system pairings fail to beat the memory-off baseline once the memory system has to retrieve by itself.

   alambic measures nothing beyond its frozen starter-note evals. The cheapest honest signals are:
   - recall@3 on questions mined from real sessions;
   - precision and abstention ratios derived from feedback counts;
   - a within-subject comparison of the hook switched on and off (Part 3 §3.2).
3. **Always-loaded context beats on-demand retrieval for recall, but it accumulates.**
   - Vercel (2026-01-27, `verified`): an 8 KB always-loaded `AGENTS.md` index scored 100%. A default skill scored 53%, because it was never invoked in 56% of cases; with explicit instructions it reached 79%.
   - In Claude Code, hook `additionalContext` is capped at 10,000 characters, spills to a file beyond that, and is saved in the transcript and replayed on resume (`verified`, hooks doc).
   - Consequence: the per-prompt hook adds up to ~1,200 tokens for every prompt that triggers it, for the rest of the session, even when it injects the same notes again.
   - Other harnesses handle this better. Codex deduplicates unchanged additional context by key (Part 2 §3.2, `confirmed`, delegated source read). Pi keeps only the latest injected block in model context.
4. **Compaction boundaries are the ungoverned moment.**
   - Claude Code runs `SessionStart` again after a compaction (`verified`, hooks doc), so re-asserting a short L0 pointer there is cheap.
   - Codex `PreCompact`/`PostCompact` and Cursor `preCompact` cannot inject anything (Part 2).
5. **Rewrite less, invalidate more.**
   - ACE (arXiv 2510.04618) names context collapse and brevity bias as the failure modes of full rewrites, and fixes them with incremental delta updates: +10.6% on agents, +8.6% on finance.
   - Graphiti invalidates superseded facts instead of deleting them.
   - mem0 switched in 2026 to ADD-only extraction, where "nothing is overwritten" (`verified`, README).
   - alambic's UPDATE path and note-level status cannot express one superseded claim inside an otherwise verified note.
6. **The ecosystem churns; plain Markdown in git is a hedge.** Each of these is `verified` via `gh api` and READMEs:
   - the Roo Code repository has been archived since 2026-05-15;
   - byterover-cli is archived;
   - Zep's self-hosted edition is deprecated.
7. **Where alambic lags.**
   - It has no local semantic layer, while qmd, Cognee and Smart Connections ship keyless local embeddings.
   - It has no fact-level validity marker.
   - It publishes no portable benchmark number.
   - Its Cursor per-prompt hook cannot inject anything, which is a defect. Cursor's `beforeSubmitPrompt` output only accepts `continue` and `user_message`; only `sessionStart` and `postToolUse` take `additional_context` (`verified`, cursor.com/docs/hooks). alambic registers it on `beforeSubmitPrompt` (`_meta/lib/setup.mjs:424`) and returns `additional_context` (`_meta/hooks/prompt-context.mjs:49`).

## Adoption backlog

Rows R1–R7 enter the current hardening plan. Rows F1–F12 are follow-ups, each needing its own measurement or owner decision first.

| ID | Change | Evidence | Cost | Acceptance or measure | Surface |
| --- | --- | --- | --- | --- | --- |
| R1 | `review --inbox` prints the promotion plan before recording a decision: action (create/update/noop), target, reason and diff size. | Part 3 §4.1, §5.1; `promotion-judge.mjs:249-262` | S | The review-gate test asserts the plan fields for create and update drafts, and that no write happens before the decision. | `_meta/lib/promotion-judge.mjs`, review branch of `_meta/alambic.mjs` |
| R2 | A frozen adversarial canary suite for `scanUnsafe`: ≥20 attack payloads and ≥10 benign controls, with a catch-rate floor that can only rise. | Part 3 §4.2–4.3 | M | `eval --suite canaries` in `run.sh`, sha256-frozen; it fails below the floor or above the benign false-positive ceiling. | `_meta/evals/`, `_meta/tests/eval.mjs` |
| R3 | A Claude Code `SessionStart` hook with matcher `compact` that re-asserts the L0 pointer (bounded, marked untrusted). Cursor `sessionStart` reuses the same block. | Part 2 §3.1, §6.3; Claude Code hooks doc; Cursor hooks doc | S–M | A hook test on `source: "compact"`; setup tests with a fake HOME; uninstall removes the entries. | `_meta/hooks/`, `_meta/lib/setup.mjs`, `_meta/harness/` |
| R4 | Per-session dedupe in the per-prompt hook: a note already injected in the session is not injected again. The state keeps note path + sha per session id only (mode 0600, TTL), never prompt text. | Claude Code hooks doc (10,000-char cap, replay on resume); Part 2 §6.2 | M | Prompt-hook tests: same session gives no repeat, a new session injects, and the state file holds no prompt text. | `_meta/hooks/prompt-context.mjs`, `SECURITY.md` |
| R5 | `doctor` reports inbox size and age (oldest, count older than 14 days) as warnings, not failures. | Part 1 §6.4 (Anthropic memory-tool guidance, Copilot Memory 28-day expiry) | S | New `doctor --json` fields, with a fixture test. | doctor branch of `_meta/alambic.mjs` |
| R6 | `SECURITY.md` threat model: the receipt is the boundary; labels and `scanUnsafe` are filters. It adds a worked poisoning example and states that native harness memories sit outside the quarantine. | Part 3 §4.3; Part 2 §6.10; Part 1 §6.5 | S | Doc review; leak-scan green. | `SECURITY.md`, `_meta/harness/*.md` |
| R7 | A trigger-oriented skill description within the strictest cross-harness limit (≤1,024 characters). | Vercel eval; Part 2 §6.8 | S | A test asserts the description length and the presence of a when-to-use clause. | `_meta/harness/skill/SKILL.md` |
| F1 | A local, keyless semantic fallback (qmd-style BM25 + vectors). | Part 1 §6.1. It conflicts with the earlier non-adoption at ~250 notes. | L | First measure the recall gap on paraphrase-only queries, keyless. | new module |
| F2 | A fact-level validity marker inside notes, plus a lint rule. | Part 1 §6.2; Part 3 §5.4 | M | A lint count of dated sub-claims past a threshold. | kb schema, lint |
| F3 | A supersession/invalidate outcome distinct from UPDATE. | Part 3 §5.4 | M | Share of UPDATE receipts replacing more than 80% of a body. | promotion judge |
| F4 | A scheduled staleness re-check: source liveness and a stale ratio per note. | Part 3 §5.5 | M | `stale / (hit + stale)` per note. | lint |
| F5 | recall@3 probes mined from sessions, labelled by a human at review time. | Part 3 §5.7 | M | recall@3 tracked per release. | `_meta/evals/` |
| F6 | A within-subject A/B of the hook switched on and off. | Part 3 §5.8 | S–M | Change in the feedback mix over several weeks. | setup toggle |
| F7 | Datamarking or encoding of injected context (Spotlighting), measured with a model-in-the-loop canary harness. | Part 3 §4.2, §5.3 | M | Instruction-follow rate with and without the transform. | hook rendering |
| F8 | Pointer survival through opencode `experimental.session.compacting` and Pi `session_before_compact`. | Part 2 §6.4 | M | Forced-compaction check. | harness adapters |
| F9 | A Gemini CLI adapter using the `SessionStart` + `BeforeAgent` split. | Part 2 §3.6, §6.5 | S–M | Transcript count of injected blocks. | new adapter |
| F10 | A portable benchmark slice (LongMemEval- or LoCoMo-style), labelled self-run. | Part 1 §6.3 | M | Score per release. | `_meta/evals/`, README |
| F11 | An owner decision on native memories: Claude auto memory, Codex Memories, Gemini auto memory. | Part 2 §6.10; MemoryTrap | trivial | Owner decision. | setup, doctor |
| F12 | A harvest ROI line (distill calls per accepted note). | Part 3 §5.6; VibeMemBench | S | Existing counters. | `harvest status` |

## Parent verification log

**Re-fetched or re-run by the parent on 2026-09-28:**
- arXiv 2609.23570 (VibeMemBench): 111 targets, 90 repositories, 3,634 trajectories, +1.1–4.5 points, 11/12 pairings.
- arXiv 2607.05189 (MemGhost): 87.5% / 71.4%, 56 held-out cases.
- The Cisco MemoryTrap post: published 2026-04-01; the v2.1.50 mitigation.
- The Vercel eval post: 53 / 53 / 79 / 100%, 56% of cases never invoked, a 40 KB index compressed to 8 KB, dated 2026-01-27.
- The Claude Code hooks doc (raw markdown): the 10,000-character cap with file spill, the transcript replay on resume, `SessionStart` firing again after compaction.
- The Claude Code `/goal` doc.
- The Cursor hooks doc: `beforeSubmitPrompt` output fields.
- The Gemini CLI memory doc.
- The mem0 README: LoCoMo 92.5 and LongMemEval 94.4 on the managed platform, ADD-only extraction.
- `gh api` for Roo Code, claude-mem, beads, qmd, mem0, Basic Memory, byterover-cli and Zep.

**Corrections applied in the parts:**
- claude-mem search is hybrid (SQLite FTS5 + Chroma), not lexical-only.
- The Gemini CLI `save_memory` tool is superseded by direct `GEMINI.md` edits.
- Roo Code's archive status is upgraded to `verified`.
- The MemoryTrap date is 2026-04-01.

**Not re-checked by the parent:** the source-level Codex details (hook event list, 2,500-token additional-context cap, key+value dedupe, Memories pipeline). They stay `confirmed` only as delegated source reads.

**Open gap:** no controlled public measurement compares per-prompt memory injection with tool-based retrieval in coding agents (Part 2 §4.9).

---

## Part 1: Comparable memory engines



Research only. No claims here are applied to the alambic repository; no repo
files outside this research output were changed.

### 1. Scope & method

Alambic (context, not re-derived below) is a local-first compiled Markdown
wiki for coding agents: `docs/` sources + inbox staging
(`docs/inbox/{manual,ai}`), `kb/` compiled notes (one idea per note, typed
frontmatter — `type`/`status`/`summary`/`sources`/`created`/`updated`/`tags`,
statuses `verified|stale|accepted|superseded|draft`), `ref/` entrypoints,
`_meta/` (CLI, validator, evals, a stdio MCP server exposing 4 read tools —
`vault_search`, `vault_context`, `vault_read`, `vault_health` — and 2 staging
tools — `vault_capture`, `vault_feedback` — that never write `kb/`/`ref/`).
Retrieval is a lexical index plus derived wikilink-graph expansion, producing
token-capped cited context packs with abstention; an optional external
semantic rerank ("Jev", via TypeSafe) activates only with an API key, reranks
≤8 lexical candidates, and falls back to lexical on any failure. Delivery
targets Claude Code, Codex, Cursor, opencode, and Pi via skill file + MCP
entry + CLI shim + an optional per-prompt lexical hook (≤3 verified/accepted
notes, ≤1200 tokens, marked untrusted, never calls the external reranker).
Write path: a Claude `SessionEnd` hook queues transcripts locally → `harvest
scan` scores sessions without reading the vault → `harvest distill` (external
`claude -p`, no tools) turns queued excerpts into gitignored
`docs/inbox/ai/harvest-*.md` drafts → a human `review --inbox` decision bound
to the draft's sha256 is the only path into `kb/`, except duplicate drafts
auto-archived as `noop-*` → a single daily `nightly --push` (one machine, one
LaunchAgent) is the only scheduled writer to `kb/`/`ref/`, gated on
validate/lint/leak-scan/eval suites all green, fail-closed on a dirty tree.

Method: primary sources only (official repo README/docs/source, first-party
blogs, papers) per project, plus `gh api repos/<owner>/<repo>` for maturity
(stars, `pushed_at`, license), fetched read-only on 2026-09-28. Every claim is
labeled `confirmed` (primary source states it, URL given), `verified` (source
read at a commit or run locally), `inferred` (reasoning, no direct statement),
or `not verified` (secondary source / search snippet only, or a primary source
that itself left the point unstated). No invented numbers; vendor benchmarks
are marked vendor-run even when the vendor open-sourced the eval code.

Not re-derived here (see prior studies instead): the 2026-09-28
harness-landscape study's coverage of spec-kit, superpowers,
compound-engineering, BMAD, HumanLayer ACE, Kiro *hooks* (as opposed to
steering, which this report does cover), tdd-guard, ruler, wshobson/agents,
claude-flow, agent-stuff, Pi, Amp, opencode, the Mem0 LOCOMO table as it stood
then, the Zep-vs-Mem0 benchmark methodology dispute, and Claude Code's native
auto-memory basics; and the 2026-09-04 vault-synthesis study's coverage of the
Karpathy LLM-wiki gist, eugeniughelbur/obsidian-second-brain, LangMem,
Zep/Graphiti bi-temporal LongMemEval numbers as they stood then, vectorless
retrieval under ~1000 pages, and the CLAUDE.md <200-line budget.

### 2. Comparison table

Cells are intentionally terse; full detail and citations are in §3.

| Project | Storage | Retrieval | Write path | Provenance | Freshness/supersession | Harness surfaces | Local/cloud | Evals | Security posture | Maturity |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-mem | SQLite (+ FTS5) and a Chroma vector store | Hybrid keyword (FTS5) + vector search, "progressive disclosure" layers (corrected by parent, README) | Automatic, hook-driven, no human gate | Citations to observation IDs | None documented beyond DB rows | 7 lifecycle hooks, MCP, works beyond Claude Code (OpenCode, Grok Bot, Antigravity, OpenClaw) | Hybrid: local by default, growing cloud tier (CMEM Pro / cmem.ai) | None found | `<private>` tag opt-out; no untrusted-data framing found | 94.8k★, pushed 2026-09-27, Apache-2.0 |
| Basic Memory | Plain Markdown on disk | Lexical + semantic (optional cross-encoder rerank) | Two-way: human and AI edit the same files directly, no formal accept gate | Wikilinks + "observations"; no mandatory source field | None documented (no status enum) | MCP-native (Claude, Codex, Cursor, ChatGPT); Obsidian-compatible files | Local-first by default; optional paid cloud sync/Teams | None found | Not documented | 4.1k★, pushed 2026-09-26, AGPL-3.0 (+ proprietary cloud tier) |
| Letta (framework) | Memory blocks (in-context) + archival memory (vector-searchable DB) | Blocks always-visible; archival is on-demand semantic search | Agent/"sleep-time agent" writes automatically; no human gate | Not emphasized in docs found | Sleep-time agents asynchronously rewrite/consolidate blocks | Letta Agent SDK, Letta Cloud, Letta Code app, Slack/Telegram/Discord channels | OSS framework (Apache-2.0) + optional Letta Cloud | Vendor LoCoMo post (§3) | Not documented | 24.9k★ (letta-ai/letta), pushed 2026-09-10, Apache-2.0; active code now in letta-ai/letta-code, 3.4k★, pushed 2026-09-27 |
| qmd | Local index (BM25 + GGUF embeddings via node-llama-cpp) | Hybrid: BM25 + vector + HyDE query expansion, RRF fusion, local LLM rerank | Manual (`qmd embed`/CLI); no autonomous write-back to source docs | Doc path/docid; no citation graph | None documented | MCP (stdio/HTTP), Claude Code plugin, Claude Desktop | Fully local, no API key, no network call required | None found | Not documented | 30.1k★, pushed 2026-09-09, MIT |
| Memory Bank pattern (Cline; formerly Roo Code) | 6 fixed Markdown files (`projectbrief.md`, etc.) | Full-file read by the agent, no indexing | Manual only — user must say "update memory bank" | None | None documented; explicitly no conflict handling | Custom instructions / `.clinerules`; forked widely (Roo, Kilo, others) | Fully local | None | **Zero security guidance found** (confirmed absence) | Cline: 69.4k★ active; community roo-code-memory-bank repo: 1.7k★, pushed 2025-05-15 (stale); Roo Code itself shut down May 2026 (archived) |
| Kilo Memory (Kilo Code, successor system) | Per-project dir under `$XDG_DATA_HOME/kilo/memory/<project>-<hash>/` | Semantic search over an append-only journal | Automatic + self-editing (agent has dedicated read/write tools) | Not documented | Survives context compaction; append-only journal (no explicit expiry found) | Built into Kilo Code (VS Code extension) | Local | None found | Not documented | 27.4k★, pushed 2026-09-27, MIT |
| mem0 | Vector store (+ optional graph) | Multi-signal: semantic + BM25 + entity linking, fused; "temporal reasoning" ranking | Automatic, single-pass ADD-only extraction (agentic or API call) | Not emphasized | Old algorithm allowed UPDATE/DELETE; new (Apr 2026) algorithm is ADD-only, never overwrites | Library / self-hosted server / cloud platform; OpenMemory MCP for local use | Tiered: library, self-hosted (docker), cloud; best benchmark numbers are cloud-only per vendor's own caveat | Vendor: LoCoMo 92.5, LongMemEval 94.4, BEAM 1M/10M 64.1/48.6 (Apr 2026 algorithm); eval code open-sourced | Not documented | 66.1k★, pushed 2026-09-25, Apache-2.0 |
| OpenMemory MCP (mem0) | SQLite/vector store, local server on `localhost:8765` | Same mem0 retrieval, served locally | MCP tool calls from any MCP client | Not emphasized | Same as mem0 | MCP (Claude, Cursor, any MCP client), local UI | Local server, "local and secure" per vendor | None found specific to OpenMemory | Not documented | (subdir of mem0ai/mem0, see above) |
| Zep (product) | N/A — repo is now examples/integrations only | N/A | N/A | N/A | N/A | SDKs (Python/TS/Go), framework integrations | **Cloud-only**: Community (self-hosted) edition deprecated/unsupported, moved to `legacy/` | Vendor `zep-eval-harness` (LoCoMo, LongMemEval) — dispute already covered by prior study | Not documented in this repo | 4.9k★ (examples repo), pushed 2026-09-18, Apache-2.0 |
| Graphiti (OSS engine behind Zep) | Graph DB (Neo4j/FalkorDB/Kuzu — backend choice per docs, not independently verified here) | Hybrid: semantic + keyword + graph traversal | Autonomous ingestion from "episodes" (raw data) into the graph | Strong: every derived fact traces back to its source episode | Bi-temporal: each fact/edge has a validity window (when true, when superseded) | Python framework, MCP server exists per repo ecosystem | Self-hostable OSS | Same eval-harness note as Zep | Not documented | 31.2k★, pushed 2026-09-27, Apache-2.0 |
| Cognee | Graph store + vector store (self-hosted) | Ontology-guided graph + vector retrieval | Explicit pipeline calls (`add`/`cognify`-style); not autonomous mid-session | Paper describes graph/LLM interface; provenance mechanics not confirmed in README excerpt | Not confirmed | MCP mentioned by ecosystem, primarily a Python library | **Local by default, free, CPU-only models, no API key required** | Vendor/self-published paper (arXiv:2505.24478); no independent eval found | Not documented | 31.1k★, pushed 2026-09-27, Apache-2.0 |
| Serena (memories) | Plain Markdown files, one per memory, project-scoped or global `.serena/memories/` | Agent-invoked `list_memories`/`read_memory` (MCP tools or CLI) | Agent-invoked `write_memory`; no human gate found | Not documented | Not documented (append/overwrite semantics unclear from sources found) | MCP (Claude Code, Cursor, Codex, JetBrains, etc.) | Fully local | Serena publishes its own agent-satisfaction quotes (vendor, qualitative, not a benchmark) | Not documented | 29.8k★, pushed 2026-09-24, GPL-3.0-or-later (README) / NOASSERTION (GitHub detector) |
| beads | Dolt (versioned SQL database) — not plain files | CLI queries (`bd ready`, `bd show`) + `bd prime` context injection | Agent-invoked CLI (`bd create`, `bd remember`); no human gate documented | `bd show` exposes an "audit trail"; Dolt itself is version-controlled | `supersedes` graph-link type; "compaction" = semantic decay summarizing old closed tasks | CLI-first; `bd setup` wires Claude/Codex/Cursor/Factory/mux via AGENTS.md and hooks | Local-first (Dolt), git-like push/pull to remotes | None found | Not documented | 27.5k★ (org transferred from steveyegge to gastownhall), pushed 2026-09-27, MIT |
| Byterover / Cipher (now byterover-cli) | Not fully confirmed; product describes a "context tree" | MCP-exposed retrieval; "24 built-in agent tools" per vendor | MCP tool calls; "cloud sync" optional | Not documented | Not documented | MCP across ~10 IDEs/CLIs (Cursor, Windsurf, Claude Code, Cline, Gemini CLI, Kiro, VS Code, Roo Code, Trae, Amp, Warp) | Hybrid: local CLI + optional cloud sync | None found | Not documented | GitHub shows repo **archived** as of 2026-09-28 despite npm publish ~2 months prior (unresolved discrepancy); license shown as NOASSERTION on GitHub, one secondary source states Elastic License 2.0 (not independently verified) |
| Smart Connections (Obsidian) | Local embeddings in a `.smart-env`-style local store (exact format not confirmed) | Local semantic search, bundled local embedding model | Read/chat only; does not write back into the vault | Cites source notes in chat (not independently verified in excerpt) | Re-embeds on file change (mechanism not detailed in excerpt) | Obsidian plugin only | **Local-first by design**, "private and offline by default"; described as "source available core" (license nuance, see §3) | None found | Not documented | 5.5k★, pushed 2026-09-24, NOASSERTION on GitHub / "source available" per README |
| Copilot for Obsidian | Local vector index (backend not confirmed in excerpt) | Hybrid retrieval via agent (opencode/Claude Code/Codex adapters) | Agent-mediated; can create Obsidian files ("Agent" mode) | Not confirmed in excerpt | Not confirmed | Obsidian plugin, wraps opencode/Claude Code/Codex as agents | Local core + paid hosted "Copilot-hosted" model tier | None found | Not documented | 7.8k★, pushed 2026-09-27, AGPL-3.0 (+ commercial plans) |
| Khoj | Server-side index over docs/notes (Markdown, PDF, Notion, etc.) | "Advanced semantic search" (own description); hybrid not confirmed in excerpt | Read/chat-oriented; agent-creation feature is user-configured, not autonomous memory write | Not confirmed in excerpt | Not confirmed | Own UI/CLI, browser, Obsidian, Emacs, WhatsApp; no MCP confirmed in excerpt | Self-hostable free; Khoj Cloud and Khoj Enterprise (on-prem/hybrid) also offered | Vendor blog claims of "excellent performance" on unnamed benchmarks (not independently verified) | Not documented | 37.5k★, pushed 2026-08-02, AGPL-3.0 |
| GitHub Copilot Memory | Not disclosed (server vs local unstated by vendor) | Citation-anchored fact retrieval, revalidated against current branch before use | **Fully automatic**, repo-scoped, no human gate for creation | **Strong**: facts stored "with citations pointing to the code that supports them" | Sliding 28-day expiry; timer resets on successful validated use | Native to Copilot (VS Code, JetBrains, CLI, agentic autofix) | Presumed server-side (inferred from org-wide bulk admin controls); not confirmed | None found (product telemetry, not published) | **No explicit untrusted-data / prompt-injection guidance found**, despite citation-validation being a de facto mitigation | N/A (product feature, not a repo) |
| Cursor Memories | Not confirmed (separate from the well-documented, local, GA "Rules" system) | Not confirmed in detail | Automatic capture of "short preference strings" per secondary source | Not confirmed | Not confirmed | Cursor IDE, Settings → Rules panel | Not confirmed; Cursor's separate Rules system is local (`.cursor/rules/*.mdc`) | None found | Not confirmed | N/A; still beta as of the sources found |
| Windsurf Memories | Per-workspace store (not shared globally) per secondary sources only | Not confirmed | Automatic ("what Cascade learns"), user can review/edit in UI | Not confirmed | Not confirmed | Windsurf/Cascade IDE | Not confirmed (no primary windsurf.com/docs page found in this pass) | None found | Not confirmed | N/A; **no primary vendor source located** for Memories specifically (Rules system is separately documented) |
| Gemini CLI (`save_memory` / GEMINI.md) | Single Markdown file, `~/.gemini/GEMINI.md`, under a fixed "## Gemini Added Memories" heading | File is loaded whole as context each session; no indexing | Agent-invoked tool call (`save_memory({fact})`), fully automatic, no human gate | None (flat fact list) | None (append-only, no expiry, no dedup documented) | Native Gemini CLI tool | Fully local file | None found | Not documented | 107.2k★, pushed 2026-09-26, Apache-2.0 |
| OpenAI Codex (AGENTS.md + memory) | AGENTS.md: static Markdown, 32 KiB cap with silent truncation | Static file load at session start | Human-authored (AGENTS.md); a separately-mentioned "dynamic memory system" is not characterized by a primary OpenAI source found | N/A for AGENTS.md | N/A for AGENTS.md | Native to Codex CLI/IDE/desktop | Local file for AGENTS.md; storage of any "dynamic" memory not confirmed | None found | Not documented | N/A (product feature) |
| Kiro steering files | Markdown files, `.kiro/steering/` (workspace) or `~/.kiro/steering/` (global) | Always/conditional/manual inclusion rules; conditional triggers on file access | **Human-authored (or agent-initialized once), static** — no evidence found of autonomous agent write-back | N/A | Workspace steering overrides global on conflict; no time-based expiry documented | Native to Kiro IDE | Local files | None found | Not documented | N/A (proprietary AWS product; no public repo for the IDE) |

### 3. Per-project notes

#### claude-mem
Automatic, hook-driven "persistent memory compression system built for Claude
Code" (`confirmed`, README). Storage is SQLite with FTS5 full-text search plus a Chroma vector
database for hybrid semantic + keyword search (`verified` by the parent:
the README lists "SQLite schema & FTS5 search" and "Hybrid search with
Chroma vector database"; an earlier draft of this note called it
lexical-only, which was wrong). Seven lifecycle hooks capture "tool usage
observations," generate "semantic summaries" via an LLM pass, and inject them
into future sessions with **zero manual intervention** (`confirmed`, README:
"Automatic Operation - No manual intervention required"). A "Worker Service"
(Bun-managed HTTP API) does the write-side processing; "Progressive
Disclosure" governs how much context is surfaced with visible token cost.
Provenance exists as citations to observation IDs (`confirmed`). A `<private>`
tag lets a user exclude content from storage — the only documented
privacy/security control found (`confirmed`). No freshness/staleness/
supersession mechanism is documented. Harness reach now extends well past
Claude Code: OpenCode, Grok Bot (chat-log watcher, no native hooks), Antigravity
CLI, and an "OpenClaw" gateway integration with real-time observation feeds to
Telegram/Discord/Slack (`confirmed`, README). Commercial layer: a hosted
"claude-mem observer" (CMEM Pro) is offered at sign-up via magic link, free
for 30 days then falling back to the user's own Anthropic plan or a paid
subscription; "Cloud Sync" backs memories up to cmem.ai (`confirmed`, README).
Local-only operation remains possible (`--provider host`, own OpenRouter/
Gemini key, or `CLAUDE_MEM_ONLINE_OPTIN=false`) but is not the default flow.
No published evals found. Maturity: 94.8k★, pushed 2026-09-27, Apache-2.0
(`verified`, `gh api`).

#### Basic Memory
Local-first Markdown files that both a human and an AI edit **directly, in
place** — there is no staging/accept step comparable to alambic's inbox
(`confirmed`, README: "Two-way. AI and humans write to the same files; sync
keeps them in step"). Retrieval combines lexical/graph traversal (wikilinks,
"observations") with semantic search and an optional cross-encoder rerank for
higher-quality hybrid results (`confirmed`). MCP-native across "every major AI
client and IDE," with tools tagged for behavior hints (read-only, destructive,
idempotent) to aid tool selection under "progressive tool discovery"
(`confirmed`) — a UX idea alambic's closed-schema, purpose-split MCP tools
achieve differently (via tool separation rather than hints). AGPL-3.0 for the
local product; a proprietary cloud tier (Basic Memory Teams, $15/mo) adds
shared real-time editing and cross-device sync (`confirmed`, README pricing
section). No published evals found. Postgres+Milvus is offered as a scale-out
option for the vector index (`confirmed`). Maturity: 4.1k★, pushed
2026-09-26.

#### Letta / MemGPT (framework) and Letta Code
Three distinct memory primitives, each `confirmed` via docs.letta.com pages
found through search (not independently re-fetched in full, so treated as
high-confidence but not `verified`): **memory blocks** (core memory) are
labeled, char-limited sections of the context window, always visible with no
retrieval step, and shareable across agents; **archival memory** is a
semantically-searchable database queried on demand, the opposite trade-off
(cheap context, retrieval latency) from blocks; **sleep-time agents** are
background agents that share a primary agent's memory blocks and
asynchronously rewrite/consolidate them, a distinct multi-agent-as-memory-
maintenance pattern. Separately, Letta's own blog ran a vendor benchmark,
**"Benchmarking AI Agent Memory: Is a Filesystem All You Need?"**
(`confirmed`, letta.com/blog, Aug 2025): a minimally-tuned agent with four file
ops (grep/search_files/open/close) scored **74.0% on LoCoMo using GPT-4o
mini**, ahead of a **68.5%** figure the post attributes to "Mem0 (graph
variant)." The post itself cautions that LoCoMo-style benchmarks evaluate
retrieval, not "agentic memory" holistically, and argues results depend on
agent architecture + tools + model together. *Vintage warning*: that 68.5%
Mem0 figure predates Mem0's own April 2026 algorithm update, which reports
92.5% on the same benchmark (see mem0 below) — the two numbers are 8+ months
apart and not comparable as-is, which is itself a small illustration of the
freshness problem this whole survey is about. Separately, **Letta Code**
(launched April 2026, `confirmed` via search of letta.com/blog) is a
memory-first coding-agent harness: `/init` bootstraps an agent's memory from
existing code *and* past Claude Code/Codex session history, periodic "memory
subagents" review sessions to rewrite/refine context, `/doctor` cleans up and
reorganizes memory, and the agent's memory/identity is decoupled from the
underlying model provider (switchable mid-session). The main `letta-ai/letta`
repo now states plainly that active development moved to `letta-ai/letta-code`
(`confirmed`, README); the old V1 API server is retired to an `archive`
branch. Both repos remain Apache-2.0 (`verified`, `gh api`). No independent
(non-Letta) evals found.

#### qmd
A single-developer, fully local hybrid search CLI (`confirmed`, README):
BM25 full-text + vector search via **on-device GGUF models run through
node-llama-cpp** + an LLM reranker, combined through query expansion (typed
`lex`/`vec`/`hyde` sub-queries) and Reciprocal Rank Fusion. No cloud call is
required at any point (`confirmed`). Ships an MCP server (stdio by default,
optional long-lived HTTP transport to avoid repeated model loading) with four
tools: `query`, `get`, `multi_get`, `status` (`confirmed`). Write path is
manual (`qmd embed`, `qmd collection add`); qmd does not write back into the
source documents it indexes, and has no notion of promotion, review, or
staleness (`confirmed` by omission — the README describes indexing and
retrieval only). One secondary source (a marketing blog, `not verified`)
claims the author is Shopify's CEO; not confirmed against a primary source
and not load-bearing for the technical comparison. MIT license, 30.1k★,
pushed 2026-09-09 (`verified`, `gh api`).

#### Memory Bank pattern (Cline; formerly Roo Code; forked widely)
This is a **prompt-engineering convention**, not dedicated infrastructure
(`confirmed`, docs.cline.bot/features/memory-bank, fetched directly): six
fixed Markdown files (`projectbrief.md`, `productContext.md`,
`activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md`) that
the agent reads in full via custom instructions / `.clinerules`. Updates are
**manual only** — the docs state plainly that the agent does not update files
automatically; a user must say "update memory bank" (`confirmed`, direct
fetch). No freshness, staleness, or conflict-resolution protocol is
documented, and — significant for this survey — **the docs contain zero
guidance treating memory-bank content as untrusted or requiring validation**
(`confirmed` absence, direct fetch). The pattern was popularized/forked
heavily around Roo Code (a Cline fork); the community
`GreatScottyMac/roo-code-memory-bank` add-on repo is now stale (last push
2025-05-15). Roo Code itself was **discontinued in May 2026**: the team
announced a shutdown (April 21, 2026), archived the GitHub repo (final push
May 15, 2026), and pivoted entirely to "Roomote," a Slack-first operational
agent, arguing IDEs are not the future of coding (`not verified` — found only
via secondary aggregator coverage, e.g. wetheflywheel.com and
localaimaster.com, no primary roocode.com announcement URL located). Roo
Code's official migration recommendation was Cline; Kilo Code ships a Roo
fork preserving `.roomodes`/`.roo/rules/`; a community "Zoo Code" was
published as an unofficial successor on the VS Code Marketplace
(`not verified`, same secondary sources).

#### Kilo Memory (Kilo Code)
Materially different from — and positioned as the successor to — Kilo Code's
own now-deprecated static Memory Bank (`confirmed`, GitHub PR #14304 title
"docs: document the Kilo Memory feature"; blog.kilo.ai/p/introducing-kilo-memory).
Persists across sessions **and across context compaction**, is shared across
sessions, supports **self-editing** (the agent has dedicated tools to read
and modify its own memory), and includes an append-only journal with semantic
search for insights/decisions/discoveries (`confirmed`, search snippets of
the Kilo blog/docs). Storage path: `$XDG_DATA_HOME/kilo/memory/<project>-
<hash>/`, i.e. local, per-project, hash-scoped (`confirmed`). The legacy
file-based Memory Bank "has been deprecated in favor of AGENTS.md, though
existing memory bank rules will continue to work" (`confirmed`, search
snippet of Kilo docs) — so Kilo Code now runs two generations of the pattern
side by side: a retired static-file convention and a new dynamic, agent-tool-
driven system. No security or freshness/expiry documentation found. MIT,
27.4k★, pushed 2026-09-27.

#### mem0
Multi-tier product (library / self-hosted server / cloud platform)
(`confirmed`, README table). April 2026 brought a new memory algorithm the
vendor itself frames as a large jump: **LoCoMo 71.4→92.5, LongMemEval
67.8→94.4, plus new BEAM-at-scale numbers (64.1 at 1M tokens, 48.6 at 10M)**
(`confirmed`, mem0ai/mem0 README, vendor-run). Mem0's own README states the
important caveat explicitly: *"Scores reflect Mem0's managed platform, which
includes proprietary optimizations not available in the open-source SDK;
open-source users should expect directionally similar gains but not identical
numbers"* — a rare, notably honest vendor disclosure of an OSS/cloud
capability gap. The eval framework itself is open-sourced
(`github.com/mem0ai/memory-benchmarks`), which at least makes the
methodology inspectable even though the vendor ran the numbers. Architecture
change: the new algorithm is **single-pass, ADD-only** — one LLM call, no
UPDATE/DELETE, so memories accumulate and nothing is silently overwritten
(reversing the older mem0 design, which did LLM-mediated update/delete)
(`confirmed`). Retrieval fuses semantic + BM25 + entity-linking signals, plus
a "temporal reasoning" pass that ranks the dated instance relevant to the
query (current state vs. past vs. upcoming) (`confirmed`). One notable and
slightly unusual pattern: an agent can self-register for a working API key
with zero human involvement (`mem0 init --agent`), with the human owner able
to claim the account later — worth flagging as a governance-relevant write-
path detail distinct from the memory mechanism itself (`confirmed`, README
quickstart). Apache-2.0, 66.1k★, pushed 2026-09-25, Y Combinator S24-backed.

#### OpenMemory MCP (mem0)
The local/self-hosted MCP surface for mem0: a server on `localhost:8765` (with
`/docs` for its API) plus a local UI, explicitly pitched as "local and secure
memory management" for making memory "portable, private, and interoperable
across AI systems" (`confirmed`, mem0.ai/blog/introducing-openmemory-mcp,
`github.com/mem0ai/mem0/tree/main/openmemory`). It reuses mem0's core
retrieval/extraction rather than defining a separate architecture. No
OpenMemory-specific evals or security documentation found beyond mem0's own.

#### Zep (product) vs Graphiti (OSS engine)
These are no longer the same thing operationally, which the getzep/zep
README states outright (`confirmed`, fetched directly): the `getzep/zep` repo
is now explicitly **"not Zep's product or service"** but only examples,
integration packages, and an ingestion pipeline for **Zep Cloud**, a managed
SaaS. **Zep Community Edition (the self-hosted server) is deprecated and
unsupported**, its code moved to a `legacy/` folder, per "Announcing a New
Direction for Zep's Open Source Strategy" (`confirmed`, linked from the
README). The repo does retain a `zep-eval-harness/` and `benchmarks/` folder
covering LoCoMo and LongMemEval — the Zep-vs-Mem0 dispute over these numbers
is already covered by the prior harness-landscape study and not re-derived
here. The actual comparable **open-source engine** is **Graphiti**
(`getzep/graphiti`, Apache-2.0, very active — 31.2k★, pushed 2026-09-27,
arXiv:2501.13956), which remains self-hostable and is what genuinely competes
architecturally with alambic/Cognee/mem0. Graphiti's model (`confirmed`,
README, fetched directly): a **temporal context graph** where entities are
nodes with time-evolving summaries, facts/relationships are edges with
explicit **validity windows** ("when it became true, and when (if ever) it
was superseded"), and every derived fact traces back to an **episode** (raw
ingested data) — i.e., provenance and bi-temporal freshness are both
first-class, schema-level concepts, not conventions layered on top. Retrieval
is hybrid: semantic + keyword + graph traversal. Ingestion is autonomous
("continuously integrates user interactions, structured and unstructured...
data... into a coherent, queryable graph") with no human gate documented.

#### Cognee
"The Free Open-Source AI Memory Platform for Agents" (`confirmed`, README),
explicitly local-first and free by design: **"Runs locally for free — no API
key required. We rely on free small models that use your CPU"**
(`confirmed`). Turns documents/code/conversations into a self-hosted
knowledge graph combined with a vector store, with custom data models/
ontologies for grounding memory in domain-specific entities and relationships
(`confirmed`). Backed by a self-published paper, "Optimizing the Interface
Between Knowledge Graphs and LLMs for Complex Reasoning" (arXiv:2505.24478,
Markovic et al., 2025) — an arXiv preprint, so treated as vendor/self-run
research rather than independently peer-reviewed evidence (`confirmed` that
the paper exists and is cited by the project; `not verified` whether it
underwent independent peer review). Write path (`cognee.add()`/`cognify()`-
style pipeline calls) and MCP surface were not confirmed in the fetched
excerpt — flagged as `not verified` rather than guessed. Apache-2.0, 31.1k★,
pushed 2026-09-27.

#### Serena (memories feature)
Best-known for LSP-backed semantic code tools ("The IDE for Your Coding
Agent"), with a **separate, secondary** memories feature (`confirmed`, search
of oraios.github.io/serena/02-usage/045_memories.html): plain Markdown files
in `.serena/memories/` (project-scoped) or a global directory, forming "a
persistent, project-scoped and global key-value store" the agent reads and
writes via MCP tools (`list_memories`, `read_memory`, `write_memory`) or
equivalent CLI commands. The stated primary use case is **onboarding**: on a
first conversation the agent explores a codebase and writes memories
describing its structure so later sessions skip re-analysis (`confirmed`).
No freshness, supersession, or security/untrusted-content guidance was found
in the sources reached — flagged `not verified` rather than assumed absent,
since Serena's fuller docs site was not exhaustively crawled. License is
GPL-3.0-or-later per the README's own badge (`confirmed`), though GitHub's
own license detector reports NOASSERTION — the README is the more
authoritative source here. 29.8k★, pushed 2026-09-24.

#### beads
Positions itself explicitly against plain-Markdown task tracking: **"It
replaces messy markdown plans with a dependency-aware graph"**
(`confirmed`, README, fetched directly) — a direct, useful counterpoint to
alambic's own bet on plain Markdown. Storage is **Dolt**, a version-controlled
SQL database with cell-level merge and native branching/remotes — i.e.
git-like semantics but a real relational database, not files (`confirmed`).
The CLI (`bd`) exposes issue-tracker verbs (`bd create`, `bd ready`, `bd
update --claim`, `bd close`) plus a **distinct memory primitive**: `bd
remember "insight"` stores a note that `bd prime` injects into an agent's
context later (`confirmed`) — narrower and lower-friction than full note
authoring, and worth comparing to alambic's `vault_capture` staging tool (see
§6). Provenance: `bd show <id>` exposes "task details and audit trail"
(`confirmed`); Dolt's own versioning adds a further layer not fully explored
here. Freshness/supersession: an explicit `supersedes` graph-link type, plus
a **"compaction"** feature described as "semantic 'memory decay' summarizes
old closed tasks to save context window" (`confirmed`) — a genuine, named
decay mechanism, unusual in this survey. `bd init`/`bd setup` writes or
updates `AGENTS.md` and wires hooks for Codex, Claude Code, Cursor, Factory.ai
Droid, and others (`confirmed`). The GitHub org transferred from
`steveyegge` (the project's original author, who has written and spoken
publicly about treating issue trackers as agent memory — rationale not
independently re-verified here beyond the README) to `gastownhall`
(`verified`, `gh api` redirect); some badges (Go Report Card) still point at
the old path, suggesting the transfer is recent. MIT, 27.5k★, pushed
2026-09-27. No evals found.

#### Byterover / Cipher (now byterover-cli)
An open-source "memory layer" for coding agents, MCP-compatible with roughly
ten IDEs/CLIs (Cursor, Windsurf, Claude Code, Cline, Claude Desktop, Gemini
CLI, Kiro, VS Code, Roo Code, Trae, Amp, Warp) (`confirmed`, multiple GitHub
repo descriptions found via search). Renamed from **Cipher** to **ByteRover
CLI** (`brv`) on April 1, 2026, per the project's own tracking issue,
"Cipher is now ByteRover CLI" (`confirmed`,
`github.com/campfirein/byterover-cli/issues/301`); the original codebase is
preserved on a `legacy-cipher` branch. Vendor description claims a "Dual
Memory Layer" (System 1: programming concepts/business logic/past
interaction; System 2: the model's own reasoning steps) (`not verified` —
found only in a secondary GitHub-description mirror, not the primary README
itself). **Unresolved discrepancy**: `gh api repos/campfirein/byterover-cli`
reports `archived: true` with `pushed_at` 2026-06-25, roughly three months
stale as of this report, yet a separate search found the npm package
`byterover-cli` at version 3.16.1 "last published 2 months ago" and an active-
looking Issues/PRs/Commits history. This report could not resolve whether
development continued somewhere else (a further rename, a private fork) or
whether the repo was deliberately frozen while remaining the npm publish
source — flagged as an open question (§7) rather than guessed. License shows
NOASSERTION on GitHub; one secondary source states Elastic License 2.0 (a
source-available, not OSI-approved-permissive, license) — `not verified`
against the LICENSE file directly.

#### Obsidian-side AI: Smart Connections and Copilot for Obsidian
**Smart Connections** (`confirmed`, README, fetched directly): ships a local
embedding model "that just works" with **zero setup**, is explicitly "private
and offline by default," and works on mobile — a strong local-first
commitment among peers in this survey. The README describes the license
posture as **"source available core, local-first data"** — language that
reads as deliberately distinct from a standard OSS license, consistent with
GitHub's own NOASSERTION license detection; not independently confirmed
against the LICENSE file. 5.5k★, pushed 2026-09-24. **Copilot for Obsidian**
has shifted from a pure retrieval-chat plugin toward an **agent host**:
version 4 embeds opencode, Claude Code, or Codex directly inside Obsidian for
multi-step "Agent" work, including creating Obsidian files, alongside a more
traditional "Quick Chat"/"Quick Ask" mode (`confirmed`, README, fetched
directly). This makes it less a standalone memory engine than a wrapper that
lets three external agent harnesses (two of which — Claude Code and Codex —
alambic already targets) operate inside a vault. AGPL-3.0 core with a paid
hosted model tier ("Copilot-hosted"); 7.8k★, pushed 2026-09-27. Neither
plugin's precise vector backend, citation mechanics, or freshness handling
were confirmed beyond what's quoted above — flagged `not verified` rather
than guessed.

#### Khoj
A broader personal-AI product that happens to index Markdown/Obsidian vaults
among many other sources (PDF, Notion, Word, org-mode) (`confirmed`, README,
fetched directly). Explicitly "open-source, self-hostable. Always," with a
free cloud option (`app.khoj.dev`, no setup) and a separate Enterprise tier
(on-prem/hybrid) (`confirmed`). Describes "advanced semantic search" and
claims strong results on unnamed "modern retrieval and reasoning benchmarks"
via its own blog (`not verified` — vendor claim, no specific number or
dataset found in the excerpt fetched). AGPL-3.0, 37.5k★, last pushed
2026-08-02 — the least recently active repo of the well-known projects in
this survey, worth noting as a mild freshness flag on the project itself.

#### GitHub Copilot Memory
The most thoroughly *specified* automatic memory system found in this survey,
via GitHub's own docs, fetched directly (`confirmed` throughout this
paragraph unless noted): repo-scoped facts (coding conventions, architectural
decisions, build commands, project-specific rules) and user-scoped
preferences are captured automatically, each **stored with citations** — to
supporting code for repo facts, to direct user quotes for preferences. Before
use, "Copilot checks those citations against the current branch to confirm
the information is still accurate. Only validated facts are used" — i.e.
citation-anchored revalidation at read time, not just at write time. Expiry
is a **sliding 28-day window**: unused facts/preferences are deleted after 28
days, and the timer resets on successful validated use. Controls: repo
owners can review/delete repo-level facts; individual users manage their own
preferences; Enterprise/Business admins can bulk-export or bulk-delete.
Rolled out incrementally through 2026: public preview (Jan 2026), on-by-
default for Pro/Pro+ (Mar 2026), added deletion/scope/CLI controls (May
2026), extended into agentic autofix (Sep 2026). Two gaps remain even in this
otherwise strong design: **where the data is stored is never stated**
(GitHub's own docs page is silent on server-side vs local; centralized
org-wide bulk-admin controls make server-side storage likely but this is
`inferred`, not `confirmed`), and **no explicit prompt-injection/untrusted-
content guidance is given**, despite citation-revalidation acting as a partial,
implicit mitigation.

#### Cursor Memories (distinct from Cursor Rules)
Two different Cursor features are easy to conflate. **Rules** is mature,
general-availability, fully local, and well documented: `.mdc` files in
`.cursor/rules/` (project), settings-stored user rules, glob/description-based
matching, manual `/create-rule` or sidebar authoring, no automatic creation,
no expiry (`confirmed`, cursor.com docs, fetched directly — though the
fetched page describes Rules, not Memories specifically, so this paragraph
keeps the two separate rather than assuming Memories inherits Rules'
properties). **Memories** is the automatic, learned counterpart: per an
independent comparison source (`not verified` — no primary cursor.com page
about Memories specifically was reached in this pass), it is still in beta,
enabled from Settings → Rules, and stores "short preference strings" rather
than full searchable notes. Storage location, write gating, provenance, and
security posture for Memories specifically are all `not verified`.

#### Windsurf Memories
Multiple independent third-party sources (mer.vin, paulmduvall.com,
qaskills.sh, memories.sh — all `not verified` against a primary
windsurf.com/docs page, which this pass did not locate) converge on the same
description: Windsurf runs a dual system where **Rules** are developer-
authored and static (`.windsurf/rules/` or `.windsurfrules`, 6,000-character
cap per file, global or workspace scope) while **Memories** are auto-generated
by the Cascade agent from session behavior, reviewable/editable in the
Windsurf UI, and stored **per workspace** (not shared globally). Given the
consistent convergence across sources this is plausibly accurate, but per
this report's labeling rules it stays `not verified` until a primary source
is found.

#### Gemini CLI: `save_memory` and GEMINI.md

> **Parent correction (2026-09-28):** the current `docs/tools/memory.md`, re-fetched
> directly, no longer mentions a `save_memory` tool: memories are persisted by
> editing `GEMINI.md` with `write_file`/`replace`. The description below is
> historical; Part 2 §3.6 has the current mechanism.
The simplest mechanism in this survey (`confirmed`,
`github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md`,
fetched via search with direct quotes): a single tool, `save_memory`, takes
one parameter (`fact`, a self-contained natural-language string) and appends
it to `~/.gemini/GEMINI.md` under a fixed `## Gemini Added Memories` heading.
That file is loaded whole as context on every subsequent session. Fully
agent-driven (the model decides when to call the tool) and fully automatic —
no human gate, no size cap documented, no dedup, no expiry. GEMINI.md itself
also supports the more general hierarchical-static-context pattern common to
this whole product category (project/user/global files merged at startup),
separate from the memory *tool*. Apache-2.0, 107.2k★, pushed 2026-09-26 —
the single most active/starred repo in this entire survey.

#### OpenAI Codex: AGENTS.md and a "dynamic memory system"
Well confirmed for the static half: **AGENTS.md** is a human-authored,
hierarchical Markdown file Codex reads at the start of every session, with a
hard **32 KiB cap and silent truncation** past it (`confirmed` insofar as
multiple independent guides state the same figure, though no direct OpenAI
docs page was reached in this pass — kept as `not verified` per the labeling
rule against a primary source, despite consistent secondary agreement). One
regulatory detail surfaced repeatedly: **EEA/UK/Switzerland users reportedly
get AGENTS.md only at launch**, with no announced timeline to add the
dynamic layer there (`not verified`, secondary sources only). Several
secondary sources (mem0's own competitor-comparison blog among them — a
conflict-of-interest flag worth naming explicitly) refer to a separate
"dynamic memory system" alongside AGENTS.md, but none of the sources reached
in this pass characterize its storage, retrieval, or write path precisely
enough to include as more than a placeholder — this is the least-verified
row in the whole table and should not be treated as settled.

#### Kiro steering files
Static, human-facing project context, not an autonomous memory system
(`confirmed`, kiro.dev/docs/steering/): Markdown files under `.kiro/steering/`
(workspace) or `~/.kiro/steering/` (global, cross-workspace), with three core
files (`product.md`, `tech.md`, `structure.md`) plus free-form additions.
Inclusion can be **always** (every interaction), **conditional** (triggered
by matching file access), or **manual** (explicitly @-referenced in chat) —
a more granular activation model than most of this survey's static-file
approaches. Workspace steering overrides global steering on conflict. No
evidence was found, in this pass, of any agent-driven write-back into
steering files after initial generation — this is a `not verified` negative
claim (absence of evidence), not a confirmed limitation, since Kiro's fuller
docs were not exhaustively crawled.

### 4. Cross-cutting patterns

1. **The Markdown-substrate bet is contested, not settled.** Alambic, Basic
   Memory, Serena, the Cline/Roo/Kilo Memory Bank lineage, Anthropic's memory
   tool (`/memories/*.xml` or `.txt` files in the worked examples), Gemini
   CLI's GEMINI.md, and Kiro's steering files all bet on plain files. beads
   explicitly argues against this ("replaces messy markdown plans with a
   dependency-aware graph"), and Graphiti/Cognee/mem0 bet on graph or vector
   stores instead. No consensus exists; the split roughly tracks whether the
   project cares more about human readability/git-diffability (files) or
   queryable structure at scale (graph/vector/SQL).

2. **Write-path automation is a spectrum, and alambic sits at the
   conservative end almost alone.** Fully automatic with no human gate:
   claude-mem, mem0, Cognee (pipeline-triggered but not human-reviewed),
   GitHub Copilot Memory, Gemini CLI, Windsurf Memories, Graphiti ingestion.
   Agent-invoked but ungated: Serena `write_memory`, Letta memory
   blocks/archival, beads `bd remember`, Kilo Memory. Two-way, no formal
   accept step either way: Basic Memory. **Human accept receipt required
   before anything becomes durable/queryable**: alambic (`review --inbox`
   bound to sha256) is the only project found in this survey with that
   property; Cline's Memory Bank is manually *triggered* but not *reviewed*
   (the user says "update," the agent then writes without further check),
   which is a different kind of manual.

3. **Freshness/supersession handling ranges from absent to schema-level.**
   Absent: Cline/Roo/Kilo legacy Memory Bank (confirmed absence), most
   Obsidian plugins, qmd, Serena (not verified either way), beads issues
   themselves (though `bd remember` has a decay feature). Time-boxed:
   GitHub Copilot Memory (sliding 28-day expiry with revalidation). Fact-
   level bi-temporal: Graphiti (`valid_at`/`invalid_at` per edge). Note-level
   status enum: alambic (`verified|stale|accepted|superseded|draft`). No
   project found combines fact-level temporal validity **and** a human-
   readable status vocabulary the way alambic's implication #2 (§6) proposes.

4. **This ecosystem churns fast, which is itself evidence for
   plain-file/git-native portability.** Roo Code shut down entirely (May
   2026); Zep dropped its self-hosted Community Edition and went cloud-only,
   spinning the OSS engine out as standalone Graphiti; Cipher rebranded to
   byterover-cli and the new name's repo now reads as archived on GitHub
   despite recent npm publishes; Kilo Code deprecated its own static Memory
   Bank in favor of AGENTS.md, then shipped a new, unrelated dynamic "Kilo
   Memory"; Letta folded its primary repo into `letta-code`. A vault of plain
   Markdown files under a vault owner's own git history (alambic, Basic
   Memory, Serena's `.serena/memories/`) has nothing to migrate away from
   when any single vendor pivots.

5. **Provenance ranges from schema-mandatory to entirely absent**, and it
   correlates loosely with how seriously a project takes freshness. Strong:
   Graphiti (episodes), alambic (`sources:` frontmatter field), GitHub
   Copilot Memory (citations checked against the current branch),
   claude-mem (citations to observation IDs). Weak or unconfirmed: most
   Obsidian plugins, Serena, beads' issue memory (though issue *history*
   itself is auditable via Dolt/git). Explicitly absent: Cline Memory Bank.

6. **Security/prompt-injection guidance is the sharpest, most consistent gap
   in this survey**, and it splits cleanly along a line: projects with
   closed-schema or explicitly-scoped write surfaces tend to document the
   threat; open, freeform ones tend not to. Anthropic's memory tool docs are
   the most explicit found anywhere in this survey (a worked path-traversal
   attack example, sensitive-data stripping, size caps, expiration — all
   framed as *the developer's* responsibility since the tool is client-side).
   Alambic's own posture (closed MCP input schemas, untrusted-data framing,
   reads restricted to `kb/`/`ref/`/opt-in `docs/`) is architecturally
   similar in spirit. By contrast, this report *confirmed the explicit
   absence* of any such guidance for Cline's Memory Bank, and found none
   documented for GitHub Copilot Memory (despite its citation-revalidation
   being a partial implicit mitigation), Serena, beads, qmd, or any Obsidian
   plugin.

7. **Published evals are overwhelmingly vendor-run, on a shrinking set of
   shared benchmarks (LoCoMo, LongMemEval, and mem0's own BEAM), and rarely
   comparable across vendors even when they cite the same benchmark name**,
   because model choice, single-pass vs. agentic-loop retrieval, and
   OSS-vs-managed-platform gaps all move the number independently (mem0's
   April 2026 jump and Letta's Aug 2025 filesystem post use different models
   and different mem0 generations, three-plus benchmark "editions" apart).
   Alambic's own `_meta/evals/` are frozen against its own starter notes and
   explicitly disclaim generalizing to a user's real vault — which means
   alambic is not an outlier in lacking a portable number, just unusually
   candid about it.

8. **MCP has become the near-universal harness-integration surface** (mem0/
   OpenMemory, Zep's building-with-zep plugin, Serena, beads, qmd, Basic
   Memory, Byterover/Cipher, alambic itself), but the *shape* of the exposed
   tools still varies a lot: some expose raw file CRUD (Anthropic's memory
   tool, conceptually, though it is not literally MCP), some expose
   search/retrieve only with a separate staging tier for writes (alambic,
   qmd), and some expose a single combined read/write surface with no staging
   tier at all (Serena, beads).

### 5. Where alambic leads / where it lags

**Leads:**
- Human-accept, sha256-bound promotion gate before anything becomes durable
  and agent-queryable — the only project in this survey with that exact
  property (§4.2). The closest analog, Basic Memory, still lets AI write
  files directly with no accept step.
- A note-level, human-readable lifecycle vocabulary
  (`verified|stale|accepted|superseded|draft`) that most peers either lack
  entirely (Cline Memory Bank, qmd, Serena) or encode only as an opaque
  time-boxed expiry with no semantic status (GitHub Copilot Memory's 28-day
  timer).
- Mandatory, schema-level provenance (`sources:`), matched in strength only
  by Graphiti's episode-tracing among everything surveyed.
- A closed-schema, purpose-split MCP surface (4 read tools, 2 staging tools,
  neither able to write `kb/`/`ref/`) — more conservative than Anthropic's
  own memory tool (full CRUD, path-traversal defense left to the
  implementer), Serena (direct `write_memory`), or Letta (direct block/
  archival writes).
- Documented, narrow, opt-in egress (Jev/TypeSafe: query text + capped
  `kb/`/`ref/` excerpts only, never `docs/`) versus most peers, which are
  cloud-first or cloud-only by default (Zep now exclusively so; mem0 reserves
  its best numbers for the managed platform; claude-mem's default flow nudges
  toward a hosted "observer"; GitHub Copilot Memory's storage location is not
  even disclosed).
- Git-native, humanly-diffable, portable storage with no proprietary
  database — relevant given how much of this ecosystem churned within the
  last two years (§4.4).

**Lags:**
- **No local embedding/vector layer at all.** Purely lexical + wikilink
  graph, with semantic rerank gated behind a paid external API. Nearly every
  peer surveyed ships local embeddings by default, several fully offline
  (qmd via node-llama-cpp/GGUF, Cognee via free CPU models, Smart Connections'
  bundled model) — alambic's "no local semantic layer" stance now reads as an
  outlier rather than a simplicity choice.
- **No fact-level temporal validity.** Status is per-note, not per-claim;
  Graphiti's bi-temporal edges and GitHub Copilot Memory's citation-anchored
  revalidation both catch partial staleness inside an otherwise "verified"
  document that alambic's schema cannot.
- **No zero-touch automatic capture-to-apply loop.** This is a deliberate
  safety trade-off (§4.2), but it does mean alambic's daily cadence cannot
  compete on freshness with systems that update mid-session (claude-mem,
  mem0, GitHub Copilot Memory).
- **No portable, shared-benchmark number.** Every other project with any
  published evaluation at all (however vendor-run) cites at least one
  recognizable external benchmark name; alambic's frozen probes-v2 suite is
  scoped only to its own starter notes.
- **No always-visible, guaranteed-context injection comparable to Letta's
  memory blocks.** Alambic's per-prompt hook is capped and opt-in by design;
  worth naming as a explicit, named trade-off (context-token cost vs.
  guaranteed visibility) rather than leaving it implicit.

### 6. Implications for alambic

1. **Add an optional, fully local embedding/vector fallback for semantic
   search when no `TYPESAFE_API_KEY` is set.**
   Evidence: qmd README (BM25 + vector + LLM rerank, 100% local via
   node-llama-cpp/GGUF); Cognee README ("Runs locally for free... free small
   models that use your CPU"); Smart Connections README ("ships with a local
   embedding model that just works"). See §4.1, §5 "lags."
   Benefit: closes alambic's most consistently-cited gap in this survey —
   recall on paraphrased/non-lexical-overlap queries without any egress.
   Measure: `_meta/alambic eval --suite probes-v2` recall@k on a
   paraphrase-only query subset, before/after, with the key unset; also
   `node _meta/tests/mcp-bench.mjs . _meta/evals/probes-v2.jsonl --runs 3`
   run keyless to see the local-semantic-on-vs-off delta directly.
   Cost: **L** (new local model runtime, index format, fallback wiring
   through `query`/`context`/`session`/MCP).
   Surface: new module under `_meta/` (embedding index + fallback), wired
   into the existing query/context/session/MCP paths; `_meta/evals/`.

2. **Add a fact/claim-level temporal-validity marker inside a note**,
   distinct from the existing note-level `status` field.
   Evidence: getzep/graphiti README (each fact has "a validity window: when
   it became true, and when... it was superseded"); docs.github.com Copilot
   Memory page ("checks those citations against the current branch...
   Only validated facts are used," 28-day sliding expiry). See §4.3.
   Benefit: catches partial staleness inside an otherwise `verified` note
   (one dated sub-claim goes stale while the rest holds), which the current
   note-level enum cannot express.
   Measure: a new `_meta/alambic lint` check counting `verified` notes
   containing at least one dated sub-claim older than a configurable
   threshold; track the count trending down after adoption.
   Cost: **M** (additive/optional frontmatter or inline convention; lint +
   validator changes only, no engine rewrite).
   Surface: `kb/*.md` (new optional convention), `_meta/validate-kb.sh`,
   `_meta/alambic lint`.

3. **Publish one small, portable benchmark result** (even a modest
   LongMemEval- or LoCoMo-style slice adapted to alambic's context-pack
   shape), clearly labeled self-run, alongside the existing frozen
   probes-v2 suite.
   Evidence: alambic's own README states its evals "say nothing about
   quality on yours"; every peer surveyed with any published number cites a
   recognizable external benchmark (mem0's LoCoMo/LongMemEval/BEAM table,
   Letta's LoCoMo blog post, Zep's own eval-harness folder). See §4.7, §5
   "lags."
   Benefit: gives a prospective adopter one comparable number instead of
   zero — currently the only project in this survey with literally no
   externally-recognizable benchmark result.
   Measure: the new suite's score itself, re-run each release; report
   alongside probes-v2 in the README "Evals" section.
   Cost: **M** (dataset adaptation to alambic's pack format; no engine
   change).
   Surface: `_meta/evals/` (new suite file), README "Evals" section.

4. **Add an inbox/vault growth and staleness-by-neglect check**, modeled on
   Anthropic's memory-tool security guidance (file-size caps, "periodically
   delete memory files that haven't been accessed in a long time") and
   GitHub Copilot Memory's sliding expiry.
   Evidence: platform.claude.com memory-tool docs, "Security
   considerations" section; docs.github.com Copilot Memory 28-day sliding
   expiry. See §4.3, §4.6.
   Benefit: bounds inbox/vault growth automatically rather than relying
   solely on human review cadence; surfaces silent accumulation before it
   becomes a review backlog.
   Measure: `_meta/alambic doctor` reports an inbox-age histogram; track
   max age and count-above-threshold trending down after the check ships.
   Cost: **S** (a doctor/lint check plus a documented threshold; no new
   storage engine).
   Surface: `_meta/alambic doctor`, `docs/inbox/`.

5. **Make alambic's security posture as example-driven as Anthropic's
   memory-tool docs** (a worked attack example, explicit "this is your
   responsibility" framing), since this survey found that most peers
   (confirmed for Cline's Memory Bank; not documented for GitHub Copilot
   Memory, Serena, beads, qmd, most Obsidian plugins) give no such guidance
   at all, and alambic already has the stronger invariants but a thinner
   narrative.
   Evidence: docs.cline.bot/features/memory-bank, confirmed zero security
   guidance (§3, §4.6); alambic's own `SECURITY.md` states invariants
   without a worked example.
   Benefit: makes an already-strong posture legible to new contributors/
   auditors faster; near-zero risk since it's documentation-only.
   Measure: none needed beyond a review checklist item; qualitative.
   Cost: **S** (doc-only).
   Surface: `SECURITY.md`.

6. **Consider a narrow, agent-invocable "remember one fact now" primitive**,
   distinct from full note authoring, as a lower-friction on-ramp into
   `docs/inbox/` than waiting for the nightly harvest/distill cycle.
   Evidence: gastownhall/beads `bd remember "insight"` / `bd prime`
   (confirmed, README); Anthropic's memory tool's lightweight `create`/
   `str_replace` ops. See §3 (beads), §4.8.
   Benefit: captures short-lived, high-value facts that would otherwise
   wait for the next harvest scan/distill pass or be lost entirely.
   Measure: count of `vault_capture` calls per week originating from this
   new entry point vs. the harvest pipeline; inbox acceptance rate for each
   source, compared over time.
   Cost: **S/M** (the MCP `vault_capture` staging tool already exists and
   already never writes `kb/` directly; this is mostly a thinner CLI/skill
   wrapper plus documentation, not a new write path).
   Surface: `_meta/alambic` CLI (new subcommand), existing MCP
   `vault_capture` tool (reused, not changed).

7. **State the ecosystem-churn argument for plain-git-Markdown explicitly**,
   as a one-paragraph positioning note, not a technical change.
   Evidence: Roo Code shutdown (May 2026; archive status `verified` by the parent:
   `gh api repos/RooCodeInc/Roo-Code` reports archived, last push 2026-05-15); Zep Community Edition deprecation (`confirmed`,
   getzep/zep README); Cipher→byterover-cli rename with the renamed repo now
   showing archived (`confirmed`/`verified` via `gh api` + GitHub issue
   #301); Letta's repo consolidation into `letta-code` (`confirmed`, README).
   See §4.4.
   Benefit: positioning clarity for a prospective adopter weighing
   portability/lock-in risk; no functional change.
   Measure: none (positioning only).
   Cost: **S** (doc-only, one paragraph).
   Surface: a short self-referential `kb/` note, or the README's framing
   section if one exists for "why alambic."

### 7. Open questions

- Whether Windsurf's Rules/Memories split, as described consistently across
  several third-party sources, matches Windsurf's own primary documentation —
  no `windsurf.com`/`docs.windsurf.com` page describing "Memories"
  specifically was reached in this pass.
- Whether Cursor Memories has moved past beta, and what its actual storage
  location and provenance model are — the page reached in this pass
  documented Cursor's separate "Rules" feature, not Memories.
- What OpenAI Codex's "dynamic memory system" (mentioned only by third-party
  guides, one of them a mem0 competitor-comparison blog) actually consists of
  technically; no primary OpenAI documentation of it was found.
- Whether `campfirein/byterover-cli` being GitHub-archived while npm shows a
  recent publish reflects a deliberate freeze, an undisclosed further
  migration, or a GitHub API/UI inconsistency.
- Whether Kilo Code's new "Kilo Memory" fully replaces the deprecated
  file-based Memory Bank for existing users, or the two coexist indefinitely
  (community discussion threads flagged documentation inconsistencies here).
- Whether Serena's memories have any freshness/expiry mechanism at all — this
  report found no statement either way, not a confirmed absence.
- Where GitHub Copilot Memory data physically lives (GitHub's servers vs.
  something local) — GitHub's own docs page does not say, despite otherwise
  being the most precisely specified automatic memory system in this survey.
- Whether independent (non-vendor) evaluation of any of these systems exists
  anywhere at meaningful scale — this pass found essentially none; the field
  runs almost entirely on vendor-published numbers using different models,
  retrieval strategies, and (for mem0) different product tiers, which limits
  how much any single number here should be trusted at face value, alambic's
  own included.

### 8. Sources

- https://github.com/thedotmack/claude-mem — claude-mem README — accessed 2026-09-28 — confirmed (raw fetch)
- https://docs.claude-mem.ai/architecture/database — claude-mem docs (Database: SQLite/FTS5) link, referenced from README — accessed 2026-09-28 — confirmed (URL cited by primary source; page itself not independently re-fetched)
- https://github.com/basicmachines-co/basic-memory — Basic Memory README — accessed 2026-09-28 — confirmed (raw fetch)
- https://github.com/letta-ai/letta — Letta README (points to letta-code as active source) — accessed 2026-09-28 — confirmed (raw fetch)
- https://github.com/letta-ai/letta-code — Letta Code repo (maturity) — accessed 2026-09-28 — verified (`gh api`)
- https://docs.letta.com/guides/agents/memory-blocks/ — Letta docs, memory blocks — accessed 2026-09-28 — confirmed (via search snippet with direct quotes)
- https://docs.letta.com/guides/agents/archival-memory/ — Letta docs, archival memory — accessed 2026-09-28 — confirmed (via search snippet)
- https://docs.letta.com/guides/agents/architectures/sleeptime/ — Letta docs, sleep-time agents — accessed 2026-09-28 — confirmed (via search snippet)
- https://www.letta.com/blog/benchmarking-ai-agent-memory/ — "Benchmarking AI Agent Memory: Is a Filesystem All You Need?" — accessed 2026-09-28 — confirmed (direct fetch)
- https://www.letta.com/blog/introducing-the-letta-code-app/ — Letta Code announcement — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.com/tobi/qmd — qmd README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://docs.cline.bot/features/memory-bank — Cline Memory Bank docs — accessed 2026-09-28 — confirmed (direct fetch)
- https://github.com/GreatScottyMac/roo-code-memory-bank — community Memory Bank add-on — accessed 2026-09-28 — verified (`gh api`, stale since 2025-05-15)
- https://github.com/RooCodeInc/Roo-Code — Roo Code repo, now archived — accessed 2026-09-28 — verified (`gh api`)
- https://wetheflywheel.com/en/comparisons/opencode-vs-roo-code-vs-cline/ — Roo Code shutdown coverage — accessed 2026-09-28 — not verified (secondary aggregator)
- https://localaimaster.com/blog/roo-code-shutdown-local-alternative — Roo Code shutdown coverage — accessed 2026-09-28 — not verified (secondary aggregator)
- https://github.com/Kilo-Org/kilocode — Kilo Code repo — accessed 2026-09-28 — verified (`gh api`)
- https://github.com/Kilo-Org/kilocode/pull/14304 — "docs: document the Kilo Memory feature" — accessed 2026-09-28 — confirmed (PR title/existence via search)
- https://blog.kilo.ai/p/introducing-kilo-memory — Kilo Memory announcement — accessed 2026-09-28 — confirmed (via search snippet)
- https://kilo.ai/docs/customize/context/memory — Kilo Memory docs — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.com/mem0ai/mem0 — mem0 README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://mem0.ai/research — mem0 research page, referenced from README — accessed 2026-09-28 — confirmed (cited by primary source; not independently re-fetched)
- https://github.com/mem0ai/memory-benchmarks — mem0's open-sourced eval framework — accessed 2026-09-28 — confirmed (cited by primary source; not independently re-fetched)
- https://mem0.ai/blog/introducing-openmemory-mcp — OpenMemory MCP announcement — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.com/mem0ai/mem0/blob/main/openmemory/README.md — OpenMemory README — accessed 2026-09-28 — confirmed (via search snippet; not independently re-fetched in full)
- https://github.com/oraios/serena — Serena README — accessed 2026-09-28 — confirmed (raw fetch + verified license badge)
- https://oraios.github.io/serena/02-usage/045_memories.html — Serena memories docs — accessed 2026-09-28 — confirmed (via search snippet with direct quotes)
- https://github.com/gastownhall/beads — beads README (org transferred from steveyegge) — accessed 2026-09-28 — confirmed (raw fetch) + verified (`gh api` redirect)
- https://github.com/topoteretes/cognee — Cognee README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://arxiv.org/abs/2505.24478 — "Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning" — accessed 2026-09-28 — confirmed (existence/citation via README); not verified (peer-review status)
- https://github.com/getzep/zep — Zep repo (now examples/integrations only) — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/ — Zep OSS strategy change — accessed 2026-09-28 — confirmed (cited by primary README; not independently re-fetched)
- https://github.com/getzep/graphiti — Graphiti README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://github.com/campfirein/byterover-cli — ByteRover CLI (formerly Cipher) — accessed 2026-09-28 — verified (`gh api`, archived:true) + confirmed (README/search)
- https://github.com/campfirein/byterover-cli/issues/301 — "Cipher is now ByteRover CLI" — accessed 2026-09-28 — confirmed (via search snippet)
- https://www.npmjs.com/package/byterover-cli — npm package, version/publish recency — accessed 2026-09-28 — not verified (search-snippet paraphrase, not independently opened)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool — Anthropic Claude memory tool docs — accessed 2026-09-28 — confirmed (direct fetch, extensive)
- https://github.com/brianpetro/obsidian-smart-connections — Smart Connections README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://github.com/logancyang/obsidian-copilot — Copilot for Obsidian README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://github.com/khoj-ai/khoj — Khoj README — accessed 2026-09-28 — confirmed (raw fetch + verified via `gh api`)
- https://docs.github.com/en/copilot/concepts/agents/copilot-memory — GitHub Copilot Memory docs — accessed 2026-09-28 — confirmed (direct fetch)
- https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/ — Copilot Memory public preview — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/ — Copilot Memory on-by-default — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/ — Copilot Memory controls — accessed 2026-09-28 — confirmed (via search snippet)
- https://github.blog/changelog/2026-09-25-agentic-autofix-now-uses-copilot-memory/ — Copilot Memory + autofix — accessed 2026-09-28 — confirmed (via search snippet)
- https://cursor.com/changelog/1-0 — Cursor 1.0 changelog (Memories beta mention) — accessed 2026-09-28 — not verified (search-snippet paraphrase; page itself describes Bugbot/Background Agent, Memories link not independently confirmed on this page)
- https://cursor.com/docs/context/memories — fetched, but returned Cursor's "Rules" documentation content, not Memories specifically — accessed 2026-09-28 — not verified (URL/content mismatch, kept as Rules evidence only, see §3)
- https://mer.vin/2025/12/windsurf-memory-rules-deep-dive/ — Windsurf Memory/Rules deep dive — accessed 2026-09-28 — not verified (secondary)
- https://www.paulmduvall.com/using-windsurf-rules-workflows-and-memories/ — Windsurf Rules/Memories guide — accessed 2026-09-28 — not verified (secondary)
- https://qaskills.sh/blog/windsurf-rules-and-memories-guide — Windsurf Rules/Memories guide — accessed 2026-09-28 — not verified (secondary)
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md — Gemini CLI save_memory docs — accessed 2026-09-28 — confirmed (via search snippet with direct quotes) + verified (`gh api` for license/stars)
- https://kiro.dev/docs/steering/ — Kiro steering docs — accessed 2026-09-28 — confirmed (via search snippet with direct quotes)
- https://blakecrosley.com/guides/codex — Codex CLI guide (AGENTS.md 32 KiB cap, EEA limitation) — accessed 2026-09-28 — not verified (secondary)
- https://mem0.ai/blog/how-memory-works-in-codex-cli — mem0's own comparison blog re: Codex memory — accessed 2026-09-28 — not verified (secondary, competitor source, conflict of interest noted)

---

## Part 2: Harness memory delivery


Research date / access date for all sources: 2026-09-28. Status: complete draft.

### 1. Scope & method

- Question: what is the most token-efficient and reliable way for a local memory
  engine (alambic) to deliver memory into each major coding harness in 2026 —
  exact mechanics, limits and costs per harness.
- Harnesses covered: Claude Code, OpenAI Codex CLI, Cursor (agent/CLI), opencode,
  Pi (`earendil-works/pi`, formerly `badlogic/pi-mono`), Gemini CLI.
- Method: primary sources only — official docs, source code, first-party
  engineering posts. Work was delegated to five parallel research passes (one
  per harness pair/topic), then cross-checked by the author with two direct
  re-fetches where two passes disagreed (noted inline). Access date for every
  source below: 2026-09-28.
- Labels used on every claim:
  - `confirmed` — a primary source states it; URL given.
  - `verified` — source code checked at a commit (path/commit cited).
  - `inferred` — reasoned from confirmed/verified facts, not stated directly.
  - `not verified` — could not find or confirm; stated as an open gap, not
    invented.
- A prior study (cited here only as "prior study", never by local path) already
  covers and is **not** repeated here except where this report adds a new exact
  fact: NoLiMa, Context-Folding, ACON; the Amp compaction reversal; HumanLayer's
  40-60%-of-window compaction guidance; Claude Code auto memory basics
  (`MEMORY.md`, 200 lines/25KB cap, `autoMemoryEnabled`); the existence of
  Claude's `PreCompact`/`PostCompact`/`SessionStart` matchers; Pi's 180k forced
  compaction. This report corrects one part of that last item (§3.5): the 180k
  figure is not Pi's own default.
- alambic's current delivery surfaces, read directly from the repo (not run),
  used as the baseline this report evaluates against each harness's native
  surfaces: a shared skill template (name + description + body, rendered per
  harness); a 6-tool stdio MCP server (`vault_search`, `vault_context`,
  `vault_read`, `vault_health` read; `vault_capture`, `vault_feedback`
  stage-only, never write `kb/`); a CLI shim; an opt-in per-prompt lexical hook
  (≤3 `verified`/`accepted` notes, top lexical score ≥20, hard-capped at 4800
  bytes ≈1200 tokens, always exits 0, output marked untrusted, 3s
  self-imposed subprocess timeout); and per-harness adapters — Claude/Codex/
  Cursor get hook JSON on stdin/stdout, opencode gets a plugin using
  `chat.message` + `experimental.chat.system.transform`, Pi gets an extension
  using `before_agent_start` + `context` events that keeps only the latest
  injected message in model-facing context (but the JSONL session file keeps
  every one).

### 2. Per-harness surface table

| Harness | Instruction file + cap | Skills model | Context-injecting hooks (event · field · cap) | MCP (cost · deferral · output cap) | Compaction (trigger · hooks) | Native memory |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** | `CLAUDE.md` 4-tier (managed/user/project/local) + subdir on-demand; `@import` depth ≤4; target <200 lines/file, skip >4MiB; `AGENTS.md` also read (v2.1.277+) | Name+description resident at startup (≤1,536 chars/skill, listing budget ≈1% of context window); full body loads on invoke and **persists** across turns | `hookSpecificOutput.additionalContext`, 10,000-char cap; `UserPromptSubmit`/`SessionStart`/others; **saved in transcript and replayed (not re-run) on `--resume`** for mid-session events | Tool Search default-on (Sonnet/Haiku/Opus 4.5+); `ENABLE_TOOL_SEARCH=auto` defers once deferred defs would exceed ~10% of context (fork-sourced, not independently re-confirmed); `MAX_MCP_OUTPUT_TOKENS`=25,000, warns at 10,000 (self-verified) | Env-var % or 100k–1M absolute-token override; bare vendor default % **not documented**; `/compact` reloads `CLAUDE.md`/memory/MCP + up to 5 recently-modified files + invoked skills (not the listing) | `MEMORY.md` + topic files, 200 ln/25KB cap, excluded from transcript-retention sweep, subagents don't inherit (except `fork`) |
| **Codex CLI** | `AGENTS.md` global + root→cwd walk, `AGENTS.override.md` variant; `project_doc_max_bytes` default **32 KiB**, silent truncation past cap | Name+description at startup (~100 tok/skill, third-party estimate); full body on invoke (verified in source) | Only **5 of 11** hook events can emit `additionalContext` (`SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`); cap **2,500 tokens**, overflow spills to a temp file; `kind: untrusted\|application` trust tag; **deduped by key+value** (unchanged content isn't re-appended) | `config.toml` `mcp_servers`; no documented per-definition token cost or deferral/tool-search mechanism; `tool_output_token_limit` / 10,000-byte fallback truncation | `model_auto_compact_token_limit` vs a **95%** `effective_context_window_percent` fallback (verified); `PreCompact`/`PostCompact` exist but **cannot** inject `additionalContext` | Full native **Memories** pipeline (2026, off by default): `memory_summary.md` injected at the **start of every new session**, capped at **2,500 tokens** |
| **Cursor** | Team → Project (`.cursor/rules/*.mdc`) → User, plus nested `AGENTS.md` (more-specific wins); "keep rules under 500 lines" | Open Agent Skills standard (same shape as Claude); name+description resident, body on demand (no token number documented) | `additional_context` documented **only** on `postToolUse`/`postToolUseFailure`/`sessionStart` — **not** on `beforeSubmitPrompt`; `preCompact` is **observational-only** | `~/.cursor/mcp.json`; no documented cost, deferral, output cap, or tool-count limit | Trigger % undocumented; Composer "self-summarization" (RL-trained) compresses ~5,000→~1,000 tokens, **−50% compaction error**, evaluated at 80k/40k-token triggers | Cursor Memories (beta→GA per changelog aggregation); project + personal scope; explicitly not versioned/repo-stored |
| **opencode** | `AGENTS.md` local-upward → global → Claude-Code-`CLAUDE.md` fallback; `opencode.json` `instructions` (local/glob/remote URL, 5s timeout); no size guidance | Confirmed **absent** — no progressive disclosure; `agent` definitions stand in instead | `chat.message` + `experimental.chat.system.transform` (no prompt text passed to the latter; confirmed fragile to plugin load-order per open issue); no documented size cap or timeout; **no trust/approval gate** (auto-loaded) | `opencode.json` `mcp.servers`; no documented cost, output cap, count limit, or deferral | `buffer` default **10% of limit**, `keep.tokens` default **≈15,000 tokens** verbatim; `experimental.session.compacting` can **rewrite the compaction step's own input** | Confirmed absent natively; only third-party plugins (Mem0, opencode-mem, Supermemory) |
| **Pi** | `AGENTS.md`/`CLAUDE.md` concatenated across agent-dir + cwd + **all** parent dirs; no `@import`, no documented size limit | Agent Skills standard; name+description+path at startup; body on trigger/forced; name ≤64 / description ≤1024 chars | `before_agent_start` (message **persists** in the JSONL session) + `context` (per-call view filter, keeps **only the latest** injected block in model-facing context); in-process TS extensions — **no runtime-imposed timeout or size cap** | Confirmed **absent** | Native default `reserveTokens`=**16,384** / `keepRecentTokens`=**20,000** tokens, per-model overridable — **the "180k" figure is a project-specific extension default, not Pi's own** | Confirmed absent natively; extension-managed state only |
| **Gemini CLI** | `GEMINI.md` 3-tier incl. a **just-in-time per-directory** tier loaded when a tool touches that directory; `@file.md` import; `context.fileName` can alias to `AGENTS.md`; no size cap documented | Agent Skills standard, 4-tier precedence; **activation requires an `activate_skill` tool call plus a user consent prompt** (stricter than every other harness surveyed) | Most granular spec found: `additionalContext` on `SessionStart` (persists, interactive mode only) / `BeforeAgent` (**per-turn only**, doesn't persist as a separate entry) / `AfterTool`; default timeout **60,000 ms**; `PreCompress` is advisory-only | `settings.json` `mcpServers`; only static `includeTools`/`excludeTools`; no documented cost, deferral, output cap, or count limit | `model.compressionThreshold` default **0.5** (fraction of context usage, verified in source); a verification/regeneration LLM pass produces a `<state_snapshot>`; can force-preserve an "approved plan" file's content | `save_memory` tool **removed** — model edits `GEMINI.md`/`MEMORY.md` directly; new experimental **Auto Memory** mines idle sessions into a patch + skill-draft review inbox |

### 3. Per-harness notes

#### 3.1 Claude Code

**Instruction files.** Discovery order, broadest→narrowest, later overrides earlier in context: Managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` macOS, `/etc/claude-code/CLAUDE.md` Linux/WSL, `C:\Program Files\ClaudeCode\CLAUDE.md` Windows) → User (`~/.claude/CLAUDE.md`) → Project (`./CLAUDE.md` or `./.claude/CLAUDE.md`) → Local (`./CLAUDE.local.md`, gitignored). `CLAUDE.md`/`CLAUDE.local.md` in directories **above** cwd load at launch; subdirectory `CLAUDE.md` loads on demand when Claude reads a file there. `@path/to/import`: relative to the importing file, not cwd; recursive, **max depth 4 hops**; backticks keep a reference literal; imports resolving outside cwd trigger a one-time approval dialog (user-scope files trusted without it, except Cowork desktop sessions). Size: **target under 200 lines** — "Longer files consume more context and reduce adherence" — and files **over 4 MiB are skipped** outright; imports still fully load at launch (they aid organization, not context cost). `AGENTS.md` is readable directly since v2.1.277+; `/config` → `agents-md` controls precedence (default: each directory's `CLAUDE.md` then its `AGENTS.md`; `managed-only` suppresses everything but org policy + auto memory). `.claude/rules/*.md` supports `paths:`-scoped modular files. HTML comments are stripped before injection (zero token cost). `confirmed` — https://code.claude.com/docs/en/memory.

**Skills.** Startup-resident: name + description only (self-verified: the dedicated skills doc gives no token number here, but the `code.claude.com/docs/en/mcp` doc I re-fetched directly confirms the general on-demand-loading philosophy is real). `description`+`when_to_use` capped at **1,536 characters** (`skillListingMaxDescChars`); listing budget scales at **~1% of the model's context window** (`skillListingBudgetFraction`, or a fixed `SLASH_COMMAND_TOOL_CHAR_BUDGET`); overflow drops least-invoked descriptions first, down to name-only. Full `SKILL.md` body loads only on invocation and then persists across later turns without re-costing. Nested files never auto-load (must be explicitly referenced); `disable-model-invocation: true` costs zero context until explicit `/name` invoke. Post-compaction: the skill **listing is not re-injected**; only invoked-skill bodies are re-attached, capped at **5,000 tokens each**, **25,000 tokens combined**, filled from most-recently-invoked. `confirmed` — https://code.claude.com/docs/en/skills.

**Hooks that inject context.** Full lifecycle (abbreviated): `SessionStart → UserPromptSubmit/UserPromptExpansion → (PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, TaskCreated/Completed) → Stop/StopFailure → PreCompact → PostCompact → SessionEnd`, plus async events (`Notification`, `ConfigChange`, `PreModelSwitch`/`PostModelSwitch`, etc.). Context field: `hookSpecificOutput.additionalContext` on all context-capable events; only `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch` also accept raw stdout directly. **Hard cap: 10,000 characters** per string, per hook invocation. Timeouts: 600s default; **30s** on `UserPromptSubmit`/`PreModelSwitch`/`PostModelSwitch`; **10s** `MessageDisplay`; **1.5s** (configurable to 60s) `SessionEnd`. Exit code `2` always blocks; `0`+valid JSON honored; anything else is a non-blocking error shown as a hook-error notice. **Key finding**: Claude Code **saves the injected text in the session transcript**, and for mid-session events (`PostToolUse`, `UserPromptSubmit`) a `--continue`/`--resume` **replays the saved text rather than re-running the hook** — injected context is effectively permanent and accumulates turn over turn for these events. `SessionStart` differs: it **re-runs** on resume/fork rather than replaying. `PreCompact` can block compaction (input: `trigger: manual|auto`, `custom_instructions`); `PostCompact` cannot, discards `systemMessage`/`continue`, and receives `compact_summary` as input (usable to log, not to inject). `confirmed` — https://code.claude.com/docs/en/hooks.

**MCP.** Tool Search is on by default for Sonnet 4.5/Haiku 4.5/Opus 4.5+: only tool names + server instructions load at session start, no fixed per-server tool cap (the practical limit is the context budget). `ENABLE_TOOL_SEARCH`: unset (default) = deferred + on-demand; `true` = force deferred; `auto` = threshold mode described by one research pass as deferring once total deferred-tool definitions would exceed **~10% of the context window** — **I re-fetched `code.claude.com/docs/en/env-vars` myself and could not independently confirm this specific 10% figure or the full variable description; it is carried here as fork-sourced, not self-verified.** Per-server `"alwaysLoad": true` escape hatch exists. `MAX_MCP_OUTPUT_TOKENS`: **self-verified by direct fetch** — default **25,000 tokens**, warning at **10,000 tokens**, configurable via `export MAX_MCP_OUTPUT_TOKENS=50000`. No documented tool-count limit. `confirmed` — https://code.claude.com/docs/en/mcp, https://code.claude.com/docs/en/env-vars.
  - **Correction from a direct spot-check**: one research pass additionally reported a worked example ("50+ MCP tools: ~72K tokens upfront → ~8.7K tokens with search, ≈85% reduction" and "tool definitions consume 134K tokens before optimization"), attributed loosely to Claude Code's own MCP doc. I re-fetched `code.claude.com/docs/en/mcp` directly and **found no such worked example or numbers** in it. Treat the 72K/8.7K/134K figures as **not verified** (likely a conflation with the separate Anthropic engineering-blog numbers below, or an error). The only numbers I could independently stand behind for Claude Code's own docs are the `MAX_MCP_OUTPUT_TOKENS` ones above.
  - The genuinely primary-sourced Tool Search numbers, direct-fetched from Anthropic's engineering blog (not Claude-Code-specific, but the same mechanism Claude Code exposes): "Tool Search Tool preserves 191,300 tokens of context compared to 122,800 with Claude's traditional approach" — an **85% reduction** — with accuracy improving alongside it: "Opus 4 improved from 49% to 74%" and "Opus 4.5 improved from 79.5% to 88.1%" on MCP evaluations. `confirmed` — https://www.anthropic.com/engineering/advanced-tool-use (see also §4, item 6).

**Compaction.** Two independent env-var controls: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100, percentage of the auto-compact window; **self-verified exact wording**: "the variable can't raise the threshold, so values above the default percentage are ignored"; applies to main conversation and subagents) and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (absolute tokens, 100,000–1,000,000, integer only, takes precedence over `/autocompact`/`--autocompact`/the `autoCompactWindow` settings key). `DISABLE_AUTO_COMPACT=1` disables auto-compaction entirely (manual `/compact` still works). **The bare vendor-default percentage itself is not stated as a number in either doc I could load or re-fetch** — only that the override "can't raise" it; treat the exact default as `not verified` (secondary/anecdotal GitHub-issue reports suggest a low-to-mid 80–95% range, not verified here). No "microcompact" feature name was found. What survives `/compact` (`confirmed`, direct quote): "Compaction replaces the conversation with a structured summary. System prompt, CLAUDE.md, memory, and MCP tools reload automatically. Claude Code also re-reads up to five of the files modified most recently and re-injects the skills you invoked. The skill listing does not reload." This is a Claude-Code-specific "5 recently-modified files" re-read — the mirror-image absence was independently confirmed for Codex (§3.2). `confirmed` — https://code.claude.com/docs/en/context-window.

**Native memory (new facts only).** Directory `~/.claude/projects/<project>/memory/`: a `MEMORY.md` index plus one topic file per memory; `<project>` derives from the git repo root, so all worktrees/subdirectories of one repo **share a single memory directory**; non-git dirs use the project root. Topic files are **never loaded at startup** — read on demand via normal file tools only. A write-time check reminds Claude to shorten `MEMORY.md` near the 200-line/25KB limit; over the limit the write still succeeds but Claude Code returns an error telling Claude to rewrite the index (content past the limit is silently dropped on next load). Memory files are **excluded** from the `cleanupPeriodDays` transcript-retention sweep — they persist indefinitely until edited/deleted. `/memory` toggles `autoMemoryEnabled` in `settings.json`, subject to workspace trust; `permissions.blockReadsOutsideWorkingDirectories` also blocks auto-memory load/save for a repo-controlled directory. Subagents **do not** inherit the main conversation's auto memory (exception: a `fork`, which inherits the parent wholesale); a subagent's own memory (via its `memory` field) lives in its own separate directory. `confirmed` — https://code.claude.com/docs/en/memory.

**Prompt-caching interplay.** Hook-injected context does **not** break the cached prefix — it is a pure append. Direct quote: "New content is appended at the end, which means most of each request is identical to the one before it," and specifically: "Claude Code never invalidates the cache for a plugin's skills, commands, agents, hooks, monitors, or themes. It appends their content after the existing conversation, so the next request pays for that content and still reads everything before it from the cache." So a per-prompt hook's `additionalContext` is cache-safe by construction — at the cost of becoming permanent transcript content (§ hooks, above) rather than transient. What **does** invalidate the cache: system-prompt changes, tool-definition-set changes when loaded into the prefix (not deferred), `/compact` and `/clear` (by design), model/effort-level switches, version upgrades; `CLAUDE.md` itself only reloads on `/clear`/`/compact`/restart (mid-session edits don't apply and don't invalidate). Compaction's own summarization request reads the old prefix from cache first, so "a mid-session `/compact` costs a fraction of what the context size suggests." Platform-level mechanics (generic Anthropic API, applies to any Claude Code request): up to **4 cache breakpoints**/request; order always `tools → system → messages`; minimum cacheable length is **tier-dependent** (512 / 1,024 / 2,048 / 4,096 tokens depending on model generation); default TTL **5 min**, optional **1h at 2× base input price**; a **20-content-block lookback window** per breakpoint. `confirmed` — https://code.claude.com/docs/en/prompt-caching, https://platform.claude.com/docs/en/build-with-claude/prompt-caching.

**Not verified / gaps (Claude Code)**: the bare default percentage/token value the auto-compact override can't exceed; whether "microcompact" exists under another name; the exact `ENABLE_TOOL_SEARCH=auto` 10%-of-context threshold (fork-sourced only, my own re-fetch was inconclusive rather than confirmatory).

#### 3.2 OpenAI Codex CLI

**Instruction files.** `AGENTS.md` discovery: `~/.codex/AGENTS.override.md` (if present) else `~/.codex/AGENTS.md` globally; then walking repo root → cwd, checking each directory for `AGENTS.override.md` then `AGENTS.md`; files concatenate root-downward, closer directories override. `project_doc_max_bytes` default **32 KiB**; Codex stops adding files once the combined size hits the cap — silent truncation, no warning (matches a known upstream issue). A related key, `project_doc_fallback_filenames`, lists extra filenames to try when `AGENTS.md` is absent at a directory level. A secondary-sourced real-world failure mode (anecdotal, not spec): roughly 30 rule files generating an 857 KB `AGENTS.md`, with only ~4.6% of it actually reaching the model. `confirmed` — https://learn.chatgpt.com/docs/agent-configuration/agents-md, https://learn.chatgpt.com/docs/config-file/config-advanced.

**Skills.** Same progressive-disclosure shape as Claude Code: only name + description resident at startup (~100 tokens/skill, third-party estimate); full `SKILL.md` body loads only when invoked; bundled `scripts/`/`references/`/`assets/` load only when explicitly referenced. `confirmed` (https://developers.openai.com/codex/skills) + `verified` directly in source (`codex-rs/ext/skills/src/catalog_prompt.rs` builds the startup catalog from name+description+source-locator only; `codex-rs/skills/src/loader/*` and `parser.rs` parse `SKILL.md` frontmatter). Per-model config flags gate whether a usage-instructions preamble is added at all: `include_skills_usage_instructions`, `include_plugin_usage_instructions`, `include_apps_usage_instructions` (`verified`, `codex-rs/models-manager/src/model_info.rs`).

**Hooks that inject context.** Full event list (`verified` against source): `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `Interrupt`. **Only 5 of these 11 can emit `additionalContext`**: `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` — confirmed both by the generated JSON schemas (only these 5 have an `additionalContext` field) and by an explicit source-level warning: `"ignoring additionalContextLimit for {event_name} hook in {}: this event cannot emit additionalContext"`. **`PreCompact`/`PostCompact` cannot inject context** — materially different from Claude Code, where `SessionStart`'s `compact` matcher can. Field: `hookSpecificOutput.additionalContext` (string, `verified` via an `output_parser.rs` test fixture). Size cap: **`DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2,500` tokens** (exact constant, `codex-rs/hooks/src/output_spill.rs`), configurable per-hook via `additionalContextLimit` (`0` disables spilling). Beyond the limit, Codex **spills** the full text to `<temp_dir>/hook_outputs/<thread_id>/<uuid>.txt` and gives the model a head/tail preview plus the file path, rather than truncating in place. Timeout: 600s default; `SessionEnd`/`Interrupt` default 1s, max 3s. Exit `0`+no output = success; exit `2`+stderr = block/deny for the permission-relevant events. Trust: Codex hashes each hook file; new/changed hooks are marked for review and **skipped** until trusted via `/hooks`; managed (policy-source) hooks are pre-trusted; plugin-bundled hooks are never auto-trusted. **New, not documented anywhere outside source**: injected context carries `kind: "untrusted" | "application"` (`AdditionalContextKind`) — `Untrusted` renders as a **user-role** fragment, `Application` as a **developer-role** fragment (`verified`, `codex-rs/core/src/state/additional_context.rs`) — a native, first-class trust-tagging mechanism directly analogous to what alambic does manually by prefixing its own hook output with an untrusted header. **Persistence, precisely** (`verified`, undocumented elsewhere): `AdditionalContextStore::merge` is keyed and **deduplicates by key+value** — a fragment is only appended to the conversation when the value for that key *changes* from the previous turn. So injected context persists and accumulates as history grows, but repeated identical hook output under the same key is **not** re-inserted turn over turn — a materially better accumulation profile than Claude Code's (§3.1), provided the injected content is tagged with a stable key. `confirmed`/`verified` — https://learn.chatgpt.com/docs/hooks, `codex-rs/hooks/src/*`, `codex-rs/core/src/state/additional_context.rs`.

**MCP.** Config: `[mcp_servers.<name>]` tables in `~/.codex/config.toml` (global) or `.codex/config.toml` (project, trusted-only); fields include `command`/`url`, `enabled_tools`/`disabled_tools`, `default_tools_approval_mode`. Output cap: **no MCP-specific env var found** (no `MAX_MCP_OUTPUT_TOKENS` equivalent); the general mechanism is `tools.<tool>.output_token_limit` (a positive token budget per tool, before a standard 20% serialization allowance). Fallback-model default truncation: **10,000 bytes** per tool-call output (`verified`, `codex-rs/models-manager/src/model_info.rs`), overridable to a token-based policy via `tool_output_token_limit`. `mcp_optional_startup_grace_ms` defaults to **1,000 ms** — how long Codex waits for optional MCP servers before finalizing the initial tool catalog. **Not found**: any documented per-tool-definition token-cost model, and no tool-search/deferral mechanism analogous to Claude Code's — flagged as a real gap, not an oversight, since the docs are explicit about output truncation but silent on discovery-time cost. `confirmed` — https://learn.chatgpt.com/docs/extend/mcp.

**Compaction.** `model_auto_compact_token_limit` (per-model/config override) is compared against a computed "auto-compact scope" token count (`verified`, `codex-rs/core/src/session/context_window.rs`). Fallback default: absent an explicit override, compaction eligibility is computed against **95%** (`effective_context_window_percent`, verified in source) of the model's context window — not a fixed token number. A web claim of "cannot raise above 90% of context window, silently ignored above that" for a manual override **could not be independently verified in source** this pass — treat as `not verified`. Scope toggle `model_auto_compact_token_limit_scope` = `Total` or `BodyAfterPrefix` (`verified`, `codex-rs/protocol/src/config_types.rs`) — the latter avoids forcing compaction just because a large cached system prompt exists. A separate turn-end soft threshold, `model_post_turn_compact_threshold_percent`, is checked at the end of each turn independent of the hard limit (`verified`). Manual `/compact` exists (`confirmed` via community/secondary sources, not re-verified in source this pass). Mechanism: a model writes a "handoff summary" replacing history; a claim that "up to 20,000 tokens of the most recent user messages are preserved verbatim" comes from secondary sources only (codex-community blogs) and **could not be verified against the actual Rust compaction implementation** this pass — treat as `not verified`. `PreCompact`/`PostCompact` exist as events but cannot inject `additionalContext` (§ hooks above), so nothing hook-based can re-inject state right after compaction today. **The "5-file automatic re-read after compaction" claim a prior study already flagged as unconfirmed was actively searched for in `openai/codex` source and issues, and found nowhere — confirmed absent**, reinforcing the prior study's retraction of that claim and contrasting directly with Claude Code, which does have such a mechanism (§3.1).

**Native memory.** Codex CLI ships a full native **Memories** pipeline — clearly a 2026 addition, more elaborate than anything else surveyed. Off by default globally; enabled via Settings or `memories = true` under `[features]` in `~/.codex/config.toml`. Two independent switches: `memories.use_memories` (inject existing memories into new sessions) and generation gated separately; `memories.disable_on_external_context` excludes chats that used MCP/web-search/tool-search from memory generation. `/memories` controls per-chat read/write eligibility. Storage: `~/.codex/memories/`, its **own git-baselined directory**. Files: `MEMORY.md` (a searchable registry the model queries progressively, not dumped wholesale), `memory_summary.md` — **verbatim confirmed**: "`memory_summary.md` will be injected at the beginning of every new session" — plus `raw_memories.md`, `rollout_summaries/*`, and even a generated `skills/` directory (consolidation can promote memory into new skills). Injection cap: **`MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT = 2,500` tokens** (exact constant, `codex-rs/ext/memories/src/lib.rs`). Generation is a two-phase, asynchronous, background pipeline: Phase 1 (per-thread) extracts a structured `raw_memory` + `rollout_summary` from eligible idle rollouts via a model; Phase 2 (global, single-locked) consolidates into the filesystem artifacts above via a dedicated consolidation sub-agent run with no approvals, no network, local-write-only, and collab disabled (no recursive delegation). Governance: ranks memories by `usage_count` then recency for consolidation, drops memories unused past `max_unused_days`, redacts secrets from generated fields, skips ephemeral/sub-agent sessions. `verified` — `codex-rs/memories/README.md`; `confirmed` — https://learn.chatgpt.com/docs/customization/memories.

**Prompt-caching interplay.** General OpenAI mechanism (`confirmed`): automatic exact-prefix-match caching for prompts ≥1,024 tokens, cache hits in 128-token increments; reduces TTFT up to 80% and input-token cost up to 90% (marketing-page numbers). Codex-specific interplay is `inferred`, not stated by any Codex doc: `memory_summary.md` and the skill listing are injected once at session start as part of the developer/system prefix (cache-friendly, precedes growing turn history); hook-sourced `additionalContext` is appended as new `ResponseItem`s keyed by `AdditionalContextStore` — a new/changed fragment becomes new tokens appended for that turn, which doesn't itself invalidate the earlier cached prefix (per OpenAI's exact-prefix-match model) but isn't cached on its own first occurrence either. `confirmed` — https://developers.openai.com/api/docs/guides/prompt-caching.

**Not verified / gaps (Codex)**: the exact 90%-of-context-window ceiling on a manual override; the "20,000 tokens preserved verbatim" compaction figure; whether Codex has any tool-search/deferral mechanism for MCP (searched, found nothing — likely genuinely absent, stated as a gap not a confirmed absence).

#### 3.3 Cursor

**Instruction files.** Precedence, direct quote: "Rules are applied in this order: Team Rules → Project Rules → User Rules." Sources: Project Rules (`.cursor/rules/*.mdc`), `AGENTS.md` (project root or nested subdirectories, combined with parent directories — more specific wins), User Rules (global), Team Rules (org dashboard). Size guidance: **"Keep rules under 500 lines,"** split larger rules into composable files. No legacy `.cursorrules` mentioned on the current docs page (dropped). `confirmed` — https://cursor.com/docs/rules.

**Skills.** Cursor **does** have skills — this corrects an assumption it might not. Direct quote: "Agent Skills is an open standard... works across any agent that supports the Agent Skills standard" — same `SKILL.md`+YAML shape as Claude Code. "Skills load resources on demand, keeping context usage efficient" — progressive disclosure; Cursor auto-discovers skill folders at startup, name+description resident, body on demand (no exact token number documented). Manual invoke via `/skill-name` (single message) or pin for the session via Custom Mode. Nested/subdirectory skills auto-scope to files under that directory, same mechanic as glob-scoped rules. Ships built-in skills (e.g. `/automate`). `confirmed` — https://cursor.com/docs/skills.md.

**Hooks that inject context.** Full event list (`confirmed`, direct fetch): `sessionStart`/`sessionEnd`, `preToolUse`/`postToolUse`/`postToolUseFailure`, `subagentStart`/`subagentStop`, `beforeShellExecution`/`afterShellExecution`, `beforeMCPExecution`/`afterMCPExecution`, `beforeReadFile`/`afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`/`afterAgentThought`, `beforeTabFileRead`/`afterTabFileEdit` (Tab), `workspaceOpen` (app lifecycle). **Load-bearing correction**: `beforeSubmitPrompt`'s documented output schema is **only `{ continue: boolean, user_message?: string }`** — "Called right after user hits send but before backend request. Can prevent submission." There is **no `additional_context` field on this event**. `additional_context` is documented **only** for `postToolUse`, `postToolUseFailure` ("Extra context injected into the conversation after the tool result / failed tool result") and `sessionStart` ("Additional context to add to the conversation's initial system context"). This means a per-prompt Cursor adapter that sends `{ continue: true, additional_context: text }` on `beforeSubmitPrompt` **does not match any field Cursor's own reference documents for that event** — such an adapter is likely a silent no-op today; the only officially context-injecting, once-per-session hook is `sessionStart`. `preCompact` is **observational only** — cannot block or modify compaction; input includes `trigger`, `context_usage_percent` (0-100), `context_tokens`, `context_window_size`, `message_count`, `messages_to_compact`, `is_first_compaction`; output is `user_message` only (shown to the human, not the model). `stop`/`subagentStop` output a `followup_message` auto-submitted as the next user turn, gated by `loop_count`/`loop_limit` (default **5**, `null` = uncapped). Exit code `2` always blocks ("matches Claude Code behavior for compatibility"); other non-zero/crash/timeout **fail open by default** (`failClosed: true` opts a hook into fail-closed). Trust: project hooks require a trusted workspace; user-level/enterprise hooks load automatically with no per-hook approval; cloud agents run command-based hooks only. Whether `additional_context` persists across turns in the transcript is **not explicitly documented either way** — `not verified`, inferred likely persistent since it's described as being added "to the conversation." `confirmed` — https://cursor.com/docs/hooks.md.

**MCP.** Config: project `.cursor/mcp.json`, global `~/.cursor/mcp.json`. No documented tool-definition token cost, no tool-search/deferral mechanism, no output-size cap, no tool-count limit; only qualitative guidance that users can disable tools "to prevent tools from appearing in chat." `confirmed` — https://cursor.com/docs/context/mcp.

**Compaction.** The `preCompact` input schema proves usage is tracked at runtime by percentage, but the trigger percentage itself isn't documented (the hook is observational only). Cursor's own engineering blog describes Composer as RL-trained with "compaction-in-the-loop" ("self-summarization"), tested in two eval environments with **80k-token and 40k-token triggers**. Baseline compacted context averaged "more than 5,000 tokens"; Composer's self-summaries averaged "only around 1,000 tokens." Self-summarization "consistently reduces the error from compaction by 50%" vs. baseline while "using one-fifth of the tokens." Demonstrated on a 170-turn task, with one case compressing "more than 100,000 tokens down to the 1,000 it believed would most help." `confirmed` — https://cursor.com/blog/self-summarization.

**Native memory — Cursor Memories.** Status confirmed only via changelog/forum aggregation, not one stable fetchable primary URL (flag as weaker sourcing): rolled out beta, later GA, with "user approvals for background-generated memories to preserve trust" added. Short sentence facts, created either by Cursor proposing them in the background or by explicit "remember this"; project-scoped **and** personal ("your teammates never see them"); managed under Settings → Rules; explicitly **not versioned, not repo-stored** (unlike Rules). `docs.cursor.com/context/memories` exists but renders as a client-side SPA with no static/`.md` variant reachable by fetch, and is not present in Cursor's own `llms.txt` sitemap.

**Prompt-caching interplay.** `not found` — no Cursor documentation addresses how hook-injected or Memories-injected context interacts with prompt-cache reuse; Cursor proxies multiple model providers, so this is plausibly provider-dependent and simply undocumented.

#### 3.4 opencode

**Instruction files.** Discovery order: local files first (traverses upward from cwd: `AGENTS.md`, then `CLAUDE.md`) → global `~/.config/opencode/AGENTS.md` → Claude Code fallback `~/.claude/CLAUDE.md` (disable-able via env var). `/init` scans the repo and creates/improves `AGENTS.md` in place. `opencode.json`'s `"instructions"` field accepts local paths, glob patterns (monorepo sharing), or remote URLs with a **5-second timeout**; all combine with `AGENTS.md`. No size guidance documented. `confirmed` — https://opencode.ai/docs/rules/.

**Skills.** Confirmed **absence** of progressive disclosure: no name+description-first/body-on-demand model. "Agents"/subagents are instead defined via `opencode.json`'s `"agent"` object or Markdown files in `~/.config/opencode/agents/` (global) / `.opencode/agents/` (project) — filename becomes the agent name. No documentation of token/context cost for having many agents defined. `confirmed` — https://opencode.ai/docs/agents/.

**Plugins (context-injecting hooks).** Full documented event list: `command.executed`; `file.edited`, `file.watcher.updated`; `installation.updated`; `lsp.client.diagnostics`, `lsp.updated`; `message.part.removed/updated`, `message.removed/updated`; `permission.asked/replied`; `server.connected`; `session.created/compacted/deleted/diff/error/idle/status/updated`; `todo.updated`; `shell.env`; `tool.execute.before/after`; `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`; `experimental.session.compacting`. `chat.message` and `experimental.chat.system.transform` (used by alambic's own adapter) are real SDK hooks — confirmed via multiple GitHub issues against `@opencode-ai/plugin`. Exact signature: `"experimental.chat.system.transform"?: (input: {sessionID?, model}, output: {system: string[]}) => Promise<void>`. **Known limitation** (open issue): the hook **receives no user-message text**, only `sessionID`+`model` — exactly why alambic's own adapter caches the prompt text from a prior `chat.message` firing, keyed by `sessionID`, then pushes it in `system.transform`. A bug report claiming total mutation-discard was **closed as a false alarm** ("this is due to interference from another plugin on my side") — so the hook does work, but is confirmed **fragile to plugin load-order/interaction** (the same issue flags `tool.execute.after` as possibly sharing this fragility, unverified). Trust model: confirmed **no approval/allowlist** — local plugin dirs and npm-configured plugins "are automatically loaded/installed... at startup." No documented size caps or timeouts for plugin hook execution. `confirmed` — https://opencode.ai/docs/plugins/ + GitHub issues on `anomalyco/opencode`.

**MCP.** `mcp.servers.<name>` with `type: "local"|"remote"`; local needs `command` (+ optional `cwd`/`environment`/`disabled`/`codemode`/`timeout`); remote needs `url` (+ `headers`/`oauth`/`disabled`/`codemode`/`timeout`). Tool naming `<server>_<tool>`. Docs state "MCP tools consume model context, so enable only the servers you need" but give **no numeric token cost, no output cap, no tool-count limit, no deferral/tool-search mechanism** (all not found). `confirmed` — https://dev.opencode.ai/v2/docs/mcp-servers/, https://opencode.ai/docs/config/.

**Compaction.** Triggers "when a session approaches the model's context limit." Two config keys: `buffer` (default **"10% of the limit"**) and `keep.tokens` (default **"about 15,000 tokens"** retained verbatim). Older conversation is summarized into a structured note — "objective and requirements, decisions, completed and active work, blockers and next moves, and relevant files" — placed ahead of the retained recent window; later compactions **update the same summary** rather than restart. Manual trigger: `POST /api/session/{id}/compact`; configurable via `opencode.jsonc`'s `"compaction"` key. **`experimental.session.compacting` fires before the LLM generates the continuation summary and can modify `output.context` or replace `output.prompt`** — unlike Cursor's observation-only `preCompact`, this lets a plugin actively reshape what the compaction step itself sees, a stronger pre-compaction surface than what's documented for Claude Code's `PreCompact`. `confirmed` — https://opencode.ai/v2/docs/compaction/.

**Native memory.** Confirmed absence: no first-party memory feature; all persistence is third-party plugins (Mem0 SDK integration, `opencode-mem` local vector DB, Supermemory).

**Prompt-caching interplay.** Partially confirmed: `provider.<name>.options.setCacheKey` exists ("Ensure a cache key is always set for designated provider"). Caching is on by default (`cache: "auto"`) per community/issue evidence, TTL following provider defaults (e.g. Anthropic's 5-minute ephemeral cache) — this specific default/TTL claim is sourced from GitHub issue discussion rather than a primary docs statement, so label it `not verified` at doc-authority level even though `setCacheKey` itself is confirmed. Documented failure mode: caching silently drops to 0% hit-rate when routing Anthropic models through a custom/proxy provider name.

#### 3.5 Pi (`earendil-works/pi`, formerly `badlogic/pi-mono`)

Both repos in this research were fetched at HEAD on 2026-09-28 (Pi at a specific commit, cited per file below).

**Instruction files.** Context files: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`, loaded from the agent directory (`~/.pi/agent` by default, overridable via `PI_CODING_AGENT_DIR`), the working directory, and **all parent directories** — applies to any directory Pi runs in or below, and discovery does **not** require project trust (unlike extensions/skills/settings). `AGENTS.override.md` replaces `AGENTS.md`/`CLAUDE.md` only in the *same* directory; it doesn't suppress files from other directories, so multiple context files concatenate across the directory chain. Separately, `SYSTEM.md`/`APPEND_SYSTEM.md` (agent-dir or project `.pi/`) replace/append to Pi's own system prompt — a distinct mechanism; a trusted project file wins over an agent-dir file of the same name. No `@import` syntax and no documented size limit — `not verified`/absent, in contrast to Claude Code and Gemini CLI, which both have import syntax. `confirmed` — `docs/configuration.md`.

**Skills.** Pi implements the open Agent Skills spec. At startup Pi scans configured skill locations and adds only **name + description + path** to the system prompt — not the body; the full `SKILL.md` loads only when the model decides the task matches, or is forced via `/skill:name`. Locations include user/project skill dirs, **plus the interoperable Agent Skills paths `~/.agents/skills/` and `.agents/skills/`** — the same paths alambic's own setup already targets for non-Claude harnesses. Frontmatter caps: `name` ≤64 chars, `description` ≤1024 chars; malformed/description-less files aren't loaded; name collisions keep the first discovered and warn. `confirmed` — `docs/skills.md`, same commit.

**Extensions that inject context.** Pi has no subprocess/JSON-stdin-stdout hook contract like Claude/Codex/Cursor — extensions are **TypeScript modules loaded in-process**, so there is **no built-in per-handler timeout and no documented byte/token size cap**; both are entirely the extension author's responsibility. This is why alambic's own Pi adapter manually spawns a subprocess with its own 3,000 ms timeout — Pi's runtime doesn't provide one. `before_agent_start` exposes the prompt and structured `systemPromptOptions`; returning a `message` lets Pi "append a transcript delta" — recorded as a real, **persisted session entry**, not a transient view. `context` "transforms conversation messages without prompt and tool system messages; Pi restores that state afterward" — a **request-local, per-call view transform** that does not delete or rewrite the persisted session, only what's sent to the model for that one request. This precisely confirms alambic's own SECURITY.md phrasing ("Pi persists it as a session message; the extension keeps only the latest block in model context"): every injected block accumulates in the persisted JSONL session, but only the latest survives in the model-facing context because the extension's `context` handler filters down to the latest each call. `context_with_system` is a stricter sibling for transforms that need to own the whole transcript including the system message. No `PreCompact`/`PostCompact`-named events exist, but Pi's real equivalents are `session_before_compact` (can cancel or supply a custom summary; `reason: "manual"|"threshold"|"overflow"`) and `session_compact_failed` (failure/abort telemetry). No documented "after successful compaction" hook was found. `confirmed`/`verified` — `docs/extensions.md`, same commit; cross-checked against alambic's own Pi adapter.

**MCP.** Verified absence: no `mcp.md` in the docs listing, zero hits for "MCP" across the configuration/settings/how-pi-works/compaction/extensions/skills docs, and a GitHub code search across the repo returned zero results (checked 2026-09-28). alambic's own claim that "Pi has no MCP" still holds.

**Compaction — important correction to a figure already in circulation.** Pi's own native/default auto-compaction trigger is `contextTokens > contextWindow - reserveTokens`, with `compaction.reserveTokens` defaulting to **16,384 tokens** and `compaction.keepRecentTokens` defaulting to **20,000 tokens** (kept verbatim, not summarized). Both are configurable in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`, and overridable **per model** via `compaction.modelOverrides` (e.g. a 1M-context model can be told to compact above 600K instead). **The "180,000 tokens forced compaction" figure that this and a prior study attribute to Pi is not a Pi default** — it lives in a project-specific custom extension (`DEFAULT_HARD_TOKENS = 180_000`), i.e. it is a workflow's own hard ceiling layered on top of Pi's native mechanism via the extension API, not something `earendil-works/pi` ships. What survives by default: a structured Markdown summary (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context, plus read/modified-file lists), generated by an LLM call that uses the previous summary as iterative context; cut points only at user/assistant/`BashExecution`/custom messages, never at tool results; tool-result text is truncated to 2,000 characters before being fed to the summarizer. A second, separate summarization path exists for branch summarization on `/tree` navigation. `confirmed` — `docs/compaction.md`, `docs/settings.md`, same commit.

**Native memory.** Verified absence: no memory-tool/persistent-memory feature beyond `AGENTS.md`/`CLAUDE.md` + skills + extension-managed state (`pi.appendEntry()` for durable non-context data) — zero "memory" hits across the docs fetched. Persistent facts are a documentation/extension-author responsibility, not a built-in feature.

**Prompt-caching interplay.** Unusually well specified for a CLI harness. `cacheWarming` setting: `"off"|"streaming"|"idle"`, default `"streaming"` — runs only when the model declares a cache lifetime (`promptCache: {short, long}` seconds, per-model metadata) and Pi estimates ≥$0.05 in avoided cache-miss cost; extensions can override via a `cache_warming_decision` event. Directly on the injection question: "Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix." So a context injection that's a plain message append (what alambic's adapter does) is cache-safe on providers supporting incremental transcript deltas; changes altering the tool set/prompt structure risk a full checkpoint and cache invalidation depending on provider. Summarization requests (compaction/branch-summary) explicitly disable prompt-cache writes. `confirmed` — `docs/settings.md`, `docs/models.md#prompt-cache-lifetimes`, `docs/extensions.md`.

**Not verified / gaps (Pi)**: any documented size cap or timeout on extension-injected context (architecturally there is none, by design); a native "after successful compaction" event.

#### 3.6 Gemini CLI (`google-gemini/gemini-cli`)

Fetched at a specific commit on 2026-09-28.

**Instruction files.** Default filename `GEMINI.md`, three-tier hierarchy, all **concatenated** and sent with every prompt: (a) global `~/.gemini/GEMINI.md`; (b) workspace tier — searches configured workspace dirs and their parents; (c) a **just-in-time (JIT) tier** — when a tool touches a file/directory, Gemini CLI scans that directory and its ancestors (up to a trusted root) for a `GEMINI.md` and loads it **then**, not at session start. This JIT tier has no equivalent documented for Claude Code, Codex, or Pi. Import syntax `@file.md` is documented (Memory Import Processor) but its exact page wasn't fetched this pass — presence only confirmed. Customizable filename via `settings.json` → `context.fileName` (string or array, e.g. `["AGENTS.md","CONTEXT.md","GEMINI.md"]`) — Gemini CLI can literally read `AGENTS.md` if configured. `/memory show`/`/memory reload` commands exist. No documented size cap/recommendation was found. `confirmed` — `docs/cli/gemini-md.md`.

**Skills.** Agent Skills spec, same open standard as Pi/Claude/Cursor. Startup: name+description only, injected into the system prompt, across 4 precedence tiers low→high: built-in < extension < user (`~/.gemini/skills/` or alias `~/.agents/skills/`) < workspace (`.gemini/skills/` or alias `.agents/skills/`). **Activation requires an explicit tool call, `activate_skill`, and a user-facing consent prompt** (shows name, purpose, and the directory path it will gain read access to) before the `SKILL.md` body enters conversation history — stricter/more visible than Claude Code's or Pi's silent on-demand loading: a skill can be discovered but the user can decline activation. `confirmed` — `docs/cli/skills.md`.

**Hooks that inject context.** The most granular hook spec found across any harness in this research. Full event list, context-relevant: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. Communication is stdin JSON in, stdout JSON out (stray stdout text before the JSON breaks parsing; the CLI silently falls back to "Allow" and treats the polluted output as a `systemMessage`); stderr is for logs/debug only. **Default timeout: 60,000 ms (60s)** per hook — far larger than typical Claude/Codex hook timeouts. Exit `0` = parse stdout as JSON (including intentional blocks via `decision:"deny"`); `2` = System Block (stderr becomes the rejection reason); anything else = non-fatal Warning, proceeds with original params. Matchers: regex for `BeforeTool`/`AfterTool` (including MCP tools named `mcp_<server>_<tool>`); exact string for lifecycle events; `"*"`/`""` wildcard. Config precedence: project `.gemini/settings.json` > user `~/.gemini/settings.json` > system `/etc/gemini-cli/settings.json` > extension-declared hooks. Context-injection fields, precisely: **`SessionStart` → `hookSpecificOutput.additionalContext`**: in interactive mode, injected as the *first turn in history* — persists and accumulates like any other transcript entry across the whole session; in non-interactive/print mode, merely prepended to that single prompt (transient). **`BeforeAgent` → `hookSpecificOutput.additionalContext`**: "appended to the prompt **for this turn only**" — per-turn, not a separate persisted entry. `AfterTool` → `hookSpecificOutput.additionalContext`: appended to that tool's result. `AfterAgent` → `hookSpecificOutput.clearContext: true` can clear conversation history/LLM memory while keeping the UI transcript intact — a manual, hook-triggered wipe distinct from compaction. Trust: hooks are **fingerprinted**; if a project-level hook's name or command changes (e.g. via `git pull`), Gemini CLI treats it as new/untrusted and warns before running — functionally equivalent to Codex's pending-trust gate. Managed via `/hooks panel` and `/hooks enable-all|disable-all|enable <name>|disable <name>`. `PreCompress` is the `PreCompact` equivalent but is **advisory-only, async, and cannot block or modify compression**; no "PostCompress" event was found. `confirmed` — `docs/hooks/index.md`, `docs/hooks/reference.md`.

**MCP.** Config via `settings.json`'s `mcpServers` (`command`/`url`/`httpUrl`). Tools get an unconditional fully-qualified name `mcp_{serverName}_{toolName}` (names >63 chars middle-truncated). Only **static** filtering exists — `includeTools`/`excludeTools` per server (`excludeTools` wins) — there is **no documented tool-search/deferral mechanism** for many MCP tools, and **no documented output-size cap** or tool-count limit; all discovered tool schemas appear to load upfront. `confirmed` — `docs/tools/mcp-server.md`.

**Compaction.** Exact field name **`model.compressionThreshold`**, default **`0.5`** — "the fraction of context usage at which to trigger context compression" (cross-checked against `chatCompressionService.ts`). Manual trigger: `/compress`. `model.maxSessionTurns` (default `-1`, unlimited) is a separate hard cap on turns. What survives: an LLM call **with a verification/regeneration pass** — a second LLM call re-derives/confirms the summary before it's accepted — produces a `<state_snapshot>` XML block with at minimum `<overall_goal>` and `<active_constraints>` tags. If a Gemini CLI "approved plan" file path is set, the compression system prompt **explicitly forces preservation of that plan file's content** in the snapshot — a documented, built-in analogue to "re-inject plan status after compaction." The compression system prompt itself contains an explicit prompt-injection defense, instructing the summarizer to treat chat history purely as data and ignore any embedded instructions found within it. `confirmed` — `docs/cli/settings.md`, `packages/core/src/prompts/snippets.ts` (`getCompressionPrompt`).

**Native memory — correction to the brief's premise.** `save_memory` **no longer exists as a tool.** Current system-prompt source, verbatim: "You persist long-lived project context by editing markdown files directly with `edit`/`write_file`. There is no `save_memory` tool. The current contents of all loaded `GEMINI.md` files and the private project `MEMORY.md` index are already in your context — do not re-read them before editing." (`packages/core/src/prompts/snippets.ts`, same sentence duplicated in `snippets.legacy.ts`.) Three tiers, model picks exactly one per fact: shared project `./GEMINI.md` (committed), private per-project memory (an index `MEMORY.md` + sibling notes, gitignored), global personal `~/.gemini/GEMINI.md`. **"Auto Memory"** is a new, off-by-default experimental (`experimental.autoMemory: true`) background feature that mines idle local session transcripts (≥10 user messages, idle ≥3h) using a "preview Gemini Flash model," and proposes **both** memory-file patches (unified diff) **and** new/updated `SKILL.md` drafts into a review inbox (`/memory inbox`); nothing is auto-applied — the user must promote/apply/discard each candidate. `verified`/`confirmed` — `docs/cli/auto-memory.md`, `packages/core/src/prompts/snippets.ts`.

**Prompt-caching interplay.** Gemini CLI's own doc: automatic token caching ("reuses previous system instructions and context") is available only for **API-key and Vertex AI auth**, **not** for OAuth (Google Personal/Enterprise account) users — "the Code Assist API does not support cached content creation at this time," visible via `/stats`. Official Gemini API docs: implicit caching is on by default for Gemini 2.5+ models; minimum cacheable input is **2,048 tokens** for Gemini 2.5 Flash/Pro, **4,096 tokens** for Gemini 3.x/3.1 Pro Preview models; guidance explicitly says to "put large and common contents at the beginning of your prompt." `confirmed` — `docs/cli/token-caching.md`, https://ai.google.dev/gemini-api/docs/caching.

**Not verified / gaps (Gemini CLI)**: exact `GEMINI.md` size recommendation; full `<state_snapshot>` tag list beyond `<overall_goal>`/`<active_constraints>`; MCP tool-definition token cost, deferral mechanism, and output-size cap (likely genuinely absent, given how detailed the rest of the docs are).

### 4. Delivery-strategy evidence, with numbers

1. **Anthropic, "Effective context engineering for AI agents" (2025).** `confirmed` — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents. "Right altitude": instructions "specific enough to guide behavior effectively, yet flexible enough to provide the model with strong heuristics." Just-in-time vs. pre-fetched: maintain lightweight identifiers and dynamically load data at runtime via tools, rather than pre-processing everything; explicit tradeoff acknowledged (runtime exploration is slower); hybrid recommended. Numbers are sparse: compaction summaries typically "1,000-2,000 tokens"; sub-agents may explore with "tens of thousands of tokens or more" but return only a condensed summary.

2. **Anthropic, "Managing context on the Claude Developer Platform."** `confirmed` — https://claude.com/blog/context-management, https://platform.claude.com/docs/en/build-with-claude/context-editing, https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool. Exact quotes: "Context editing alone delivered a 29% improvement" over baseline; "combining the memory tool with context editing improved performance by 39% over baseline." "In a 100-turn web search evaluation, context editing enabled agents to complete workflows that would otherwise fail due to context exhaustion — while reducing token consumption by **84%**." The memory tool gets "prescient warnings before content is cleared" from context editing so it can proactively persist first — the two features are designed to compose.

3. **Anthropic, "Effective harnesses for long-running agents."** `confirmed` — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents. A `claude-progress.txt` written by an "initializer agent," read at the start of each new session so agents don't rely on in-context memory of recent work — paired with git commits: "eliminated the need for an agent to have to guess at what had happened." A separate structured checkpoint: a JSON feature list tracking 200+ features with a `passes` field, edited only by flipping that field — a machine-readable, low-token-cost checkpoint that survives context resets independent of compaction.

4. **Anthropic, "Equipping agents for the real world with Agent Skills."** `confirmed` — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills. Explicit three-tier progressive disclosure: (1) "the agent pre-loads the `name` and `description` of every installed skill into its system prompt" at startup; (2) if relevant, "it will load the skill by reading its full `SKILL.md` into context"; (3) bundled supplementary files loaded only on demand. **No specific token-count numbers are given anywhere in the post for any tier** — a real gap in Anthropic's own public account of the mechanism.

5. **Anthropic, "Code execution with MCP."** `confirmed` — https://www.anthropic.com/engineering/code-execution-with-mcp. Exact quote: "This reduces the token usage from 150,000 tokens to 2,000 tokens — a time and cost saving of **98.7%**," for one worked example contrasting upfront tool-definition/result loading against discovering and loading only what's needed via code execution.

6. **Anthropic, "Introducing advanced tool use" (Tool Search Tool).** `confirmed`, direct-fetched — https://www.anthropic.com/engineering/advanced-tool-use (announced 2025-11-24). Exact quote: "Tool Search Tool preserves 191,300 tokens of context compared to 122,800 with Claude's traditional approach" — "an **85%** reduction in token usage while maintaining access to your full tool library." Accuracy: "Opus 4 improved from 49% to 74%" and "Opus 4.5 improved from 79.5% to 88.1%" with Tool Search Tool enabled — the context reduction did not cost accuracy, it improved it. Mechanism: tools tagged `defer_loading: true` are excluded from context until the model searches for them. (A separate "50+ tools, 72K→8.7K tokens" figure surfaced by one research pass could not be reproduced from this primary page or from Claude Code's own MCP doc on a direct re-fetch — see §3.1's correction; treat only the 191,300/122,800/85% figures as solid.)

7. **Vercel, "AGENTS.md outperforms skills in our agent evals."** `confirmed`, direct-fetched — https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals. Setup: four conditions on Next.js 16 API tasks using features absent from model training data (`'use cache'`, `connection()`, `forbidden()`, `cacheLife()`, etc.) — baseline (no docs), Skill (default), Skill with explicit invocation instructions, AGENTS.md docs index (an 8KB index pointing to relevant doc files, not the full docs inline). Exact pass rates: **baseline 53%, Skill (default) 53%, Skill with explicit instructions 79%, AGENTS.md index 100%** (100% across Build/Lint/Test breakdown). Root cause named explicitly: "In 56% of eval cases, the skill was never invoked" — "Zero improvement. The skill existed, the agent could use it, and the agent chose not to." The exact task count (N) is not stated in the fetched content — a minor gap.

8. **Manus, "Context Engineering for AI Agents: Lessons from Building Manus."** `confirmed`, direct-fetched — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus. KV-cache cost multiplier, exact quote: "with Claude Sonnet, for instance, cached input tokens cost 0.30 USD/MTok, while uncached ones cost 3 USD/MTok — a **10x** difference"; Manus's own input:output ratio is ~100:1, which is why they call KV-cache hit rate "the single most important metric" for a production agent. File-system-as-memory: "we treat the file system as the ultimate context in Manus: unlimited in size, persistent by nature, and directly operable by the agent itself." Recitation (`todo.md` rewriting): "By constantly rewriting the todo list, Manus is reciting its objectives into the end of the context. This pushes the global plan into the model's recent attention span, avoiding 'lost-in-the-middle' issues and reducing goal misalignment" — a deliberate recency-bias exploitation, not just note-taking. Adjacent, in-scope: Manus avoids dynamically adding/removing tools mid-task because it breaks the KV-cache prefix, masking tool availability via logit manipulation instead — directly relevant to "does injected context break the cached prefix" (§3, all harnesses).

9. **Controlled measurement of per-prompt injection vs. tool-based retrieval, specifically in coding agents.** `not verified` — the only lead found was a Medium post claiming "the first controlled benchmark of AI memory in coding agents," reporting "15-28% savings" and framing MCP retrieval as "the heaviest option" versus lighter direct pre-injection; the content itself returned HTTP 403 on fetch and Medium is not a first-party engineering source or peer-reviewed venue regardless — its numbers are **not cited as confirmed**. A search of arXiv:2602.21611 ("Structurally Aligned Subtask-Level Memory for Software Engineering Agents") found it addresses memory *organization*, not an injection-vs-pull-retrieval comparison — not a match. This remains a genuine open gap in the literature.

### 5. Recommended delivery design for alambic, per harness

For every harness, alambic's existing shape — a cheap always-resident pointer (skill name+description, or a CLAUDE.md/AGENTS.md snippet), a bounded per-prompt push (the lexical hook, ≤1200 tokens), and pull tools (MCP/CLI) for anything larger — maps onto a real native slot. What changes per harness is *which* native slot, and whether the current adapter code actually lands in it.

- **Claude Code.** L0 pin: keep the existing `CLAUDE.md`-based skill pointer — cheap, cached, and (per §3.1) never invalidates the cache. Per-prompt push: keep `UserPromptSubmit`, but budget for **accumulation, not just per-shot cost** — injected `additionalContext` is saved and replayed on resume, so a long session's real cost is `(qualifying prompts) × ≤1200 tokens`, not a flat ≤1200. Post-compaction: add a `SessionStart` hook on the `compact` matcher to re-assert a short pointer, since `SessionStart` *re-runs* (rather than replays) after compaction — today nothing does this. Leave broader retrieval to the skill + MCP tools (Tool Search already defers the MCP definitions automatically). Cache-friendliness: no change needed — append-only hook output is already cache-safe by construction.
- **Codex CLI.** L0 pin: `AGENTS.md` (32 KiB cap, alambic's snippet is trivially under it). Per-prompt push: `UserPromptSubmit` works and is well under the 2,500-token hook cap; tag the injected block with a **stable key** so Codex's key+value dedup collapses repeats of an unchanged note instead of re-appending it every turn — a real accumulation advantage over Claude Code. Post-compaction: nothing to hook (`PreCompact`/`PostCompact` can't inject) — accept the gap, or investigate piggybacking on the native Memories' `memory_summary.md` slot instead. Pull: keep the MCP tool count minimal since Codex has no deferral mechanism — all defined tools cost context every session.
- **Cursor.** The current per-prompt hook design targets `beforeSubmitPrompt`, which **does not support `additional_context`** per Cursor's own docs — this needs empirical verification (does the injected block actually reach the model today?) before being trusted further. If it's a no-op, the only working push surface is `sessionStart` (once per session) — treat that as the L0 pin, equivalent to Claude's CLAUDE.md, and rely on the skill + MCP for everything else. Post-compaction: `preCompact` is observational-only, so nothing can re-inject after Composer's self-summarization; whether `sessionStart` re-fires after an in-session compaction is unconfirmed (§7).
- **opencode.** Keep `chat.message`+`experimental.chat.system.transform` as-is, but treat it as best-effort given the documented plugin-ordering fragility (defensive `try`/`catch` is already present). New opportunity: `experimental.session.compacting` can rewrite the compaction step's own input — hook this to guarantee alambic's pointer survives compaction by construction, a capability neither Claude Code nor Cursor cleanly offers. Budget: `keep.tokens` defaults to ~15,000 tokens verbatim plus a 10%-of-limit buffer, so the existing ≤1200-token injection is a rounding error against it.
- **Pi.** Design is already well-matched: the `context` handler's latest-only filter means repeated injection does not compound model-facing cost the way it does on Claude Code, and the adapter's own 3s subprocess timeout correctly compensates for Pi's runtime providing none. Correct internal capacity planning: Pi's *native* compaction trigger is `reserveTokens`=16,384/`keepRecentTokens`=20,000 (much earlier than the oft-cited 180k, which is a separate workflow extension's ceiling) — plan around the native default unless that extension is confirmed present. New opportunity: use `session_before_compact` to inject/refresh a pointer into the generated summary itself, similar to opencode's compacting hook.
- **Gemini CLI.** The harness offers the cleanest match to alambic's actual intent: use `SessionStart`'s `additionalContext` for the persistent L0 pointer (it persists as real history) and `BeforeAgent`'s `additionalContext` for the transient per-turn push (it does *not* persist as a separate entry, so it cannot accumulate) — this two-tier split avoids the Claude Code accumulation problem by construction. No documented size cap was found for hook `additionalContext` here, so keep the existing ≤1200-token budget as a self-imposed ceiling. Note the skill-activation consent prompt (`activate_skill`) as a real UX cost specific to this harness — every skill invocation interrupts the user once, unlike Claude Code/Pi's silent on-demand loading.

### 6. Implications for alambic

1. **Verify (or fix) the Cursor per-prompt hook.** `beforeSubmitPrompt` doesn't document an `additional_context` field — only `postToolUse`/`postToolUseFailure`/`sessionStart` do (evidence: §3.3, cursor.com/docs/hooks.md). Expected benefit: either the hook starts genuinely reaching the model (moved to `sessionStart`), or a false sense of coverage gets removed from the setup matrix. Measure: run a scratch Cursor session with the existing adapter wired and inspect whether the model's context actually contains the injected block (docs alone don't prove today's wiring is dead or alive). Cost: **S**. Surface: `_meta/harness/cursor.md`, `_meta/hooks/prompt-context.mjs` (the `cursor` format branch), `_meta/lib/setup.mjs`.

2. **Bound the Claude Code accumulation risk.** Hook-injected `additionalContext` on `UserPromptSubmit` is saved permanently and *replayed* (not re-run) on resume, so alambic's per-prompt push compounds linearly with qualifying-prompt count over a long session — unlike Pi (latest-only filter) or opencode (documented replace/clear per message) (evidence: §3.1, code.claude.com/docs/en/hooks). Expected benefit: a bounded worst-case token cost from the hook across a long Claude Code session instead of unbounded linear growth. Measure: count injected blocks in a real transcript (grep the injected header string in a session's stored JSONL/transcript) and multiply by ≈1200 tokens. Cost: **M** — needs either a lower injection cadence, a stable dedup key (if Claude Code ever exposes one; today it doesn't, unlike Codex), or explicitly documenting/accepting the cost. Surface: `_meta/hooks/prompt-context.mjs`, `_meta/harness/claude.md`.

3. **Add a Claude Code post-compaction re-assertion hook.** Nothing today re-injects alambic's pointer after `/compact` — Claude reloads `CLAUDE.md`/memory/MCP/5-recent-files/invoked-skills only (evidence: §3.1, code.claude.com/docs/en/context-window). Expected benefit: memory continuity across the exact boundary the prior study flagged as ungoverned, using the specific mechanism this report identifies (`SessionStart`'s `compact` matcher re-runs rather than replays). Measure: after a manual `/compact` in a scratch session, check whether the pointer reappears without a fresh qualifying prompt. Cost: **S**. Surface: a new Claude hook entry (`SessionStart`, matcher `compact`); `_meta/harness/claude.md`.

4. **Use opencode's and Pi's compaction-input hooks to guarantee survival by construction.** `experimental.session.compacting` (opencode) and `session_before_compact` (Pi) can inject content directly into what the compaction step itself summarizes — a capability Claude Code (no compaction-input-editing hook at all) and Cursor (`preCompact` is observational-only) don't cleanly offer (evidence: §3.4, §3.5). Expected benefit: alambic content that survives compaction by construction rather than by fragile after-the-fact re-injection. Measure: force a compaction in each harness and check whether the generated summary mentions the pointer. Cost: **M** — new adapter code in both `_meta/harness/opencode/alambic-context.js` and `_meta/harness/pi/alambic-context.ts`.

5. **Build the Gemini CLI adapter around its two-tier hook split.** `BeforeAgent` (per-turn, non-persistent) plus `SessionStart` (persistent, first-turn) is structurally closer to alambic's actual intent (bounded, non-accumulating per-prompt context) than any single-hook harness offers (evidence: §3.6). Expected benefit: a Gemini CLI adapter that avoids the Claude-style accumulation problem by design, not by discipline. Measure: same transcript-count approach as implication 2, run against a Gemini CLI session. Cost: **S** — a new small adapter analogous to the existing Pi/opencode ones.

6. **Treat Claude Code's MCP Tool Search as a health check, not an assumption.** Tool Search defers MCP tool definitions once they exceed a documented (fork-reported, not independently confirmed) share of the context window; alambic's own 6-tool server is small today but the threshold behavior isn't something to assume stays true as tools/skills grow (evidence: §3.1, code.claude.com/docs/en/mcp — re-fetched directly, confirms `MAX_MCP_OUTPUT_TOKENS`=25,000/warn-10,000 but not the deferral threshold itself). Expected benefit: confidence alambic's MCP definitions aren't silently paying a deferred-search tax nor approaching a ceiling. Measure: inspect a live Claude Code session's `/context` output with alambic's MCP server loaded alongside others. Cost: **S**. Surface: `_meta/mcp/server.mjs` (tool count/description length).

7. **Correct the internal mental model of Pi's compaction default.** The oft-cited "180k" is a workflow-specific extension ceiling, not Pi's own default (`reserveTokens`=16,384/`keepRecentTokens`=20,000, per-model overridable) — Pi's native engine compacts considerably sooner on a typical context window than "180k" implies (evidence: §3.5, `docs/compaction.md`/`docs/settings.md`). Expected benefit: accurate capacity planning for how much of a Pi session alambic's injected block realistically survives before native compaction. Measure: none needed beyond the doc correction; optionally confirm `compaction.reserveTokens`/`keepRecentTokens` in a live `settings.json`. Cost: **trivial** (doc-only). Surface: any alambic note currently stating "Pi compacts at 180k" as if it were Pi's own default.

8. **Prioritize skill-description quality over hook coverage.** Vercel's finding — 56% of skill-eligible cases never invoked the skill at all, versus a pinned AGENTS.md-style index scoring 100% (evidence: §4 item 7) — supports alambic's existing bias toward an always-resident pointer, but also implies the skill's `description`/`when_to_use` wording is the single highest-leverage lever for every harness that gates retrieval behind invocation (Codex, Cursor, Pi, Gemini CLI all use invocation-gated skills; Gemini CLI additionally gates on user consent). Expected benefit: higher recall without raising the per-prompt hook's accumulation cost (implication 2). Measure: `feedback --status miss` rate before/after a description rewrite, or a small held-out prompt set that should trigger the skill. Cost: **S**. Surface: `_meta/harness/skill/SKILL.md` (the `description` field).

9. **Manus's cache argument confirms, but doesn't change, alambic's current design.** The 10x cached-vs-uncached cost multiplier and the "don't mutate the tool list mid-session" guidance (evidence: §4 item 8) both already match alambic's static 6-tool MCP server and append-only hook adapters. Expected benefit: none required — this is a confirming data point, documenting *why* the current shape is right rather than prompting a change. Cost: **none**. Surface: none (rationale note only, e.g. in `SECURITY.md` or the README's design notes).

10. **Name the parallel-memory governance gap that now exists on three harnesses, not one.** The prior study already flagged Claude Code's ungoverned auto-memory relative to alambic's quarantine model; this report finds the same class of risk on Codex CLI (native Memories, `memory_summary.md` injected every session, off by default today) and Gemini CLI (experimental Auto Memory, off by default, converges structurally with alambic's own harvest→inbox→review pipeline) (evidence: §3.2, §3.6). Expected benefit: one explicit governance decision — leave these off as shipped, or document the interaction — instead of three unnoticed parallel memory systems accumulating independently of alambic's untrusted/quarantine labeling. Measure: none (governance decision). Cost: **trivial**. Surface: `_meta/harness/codex.md`, a new note for Gemini CLI (no adapter file exists yet for it in `_meta/harness/`).

### 7. Open questions

- The bare default percentage/token value that Claude Code's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` ceiling can't exceed is not stated as a number in the docs I could load or re-fetch directly.
- Whether Cursor's `sessionStart` hook re-fires after an in-session Composer self-summarization (i.e., whether a session-start-only injection survives Cursor's own compaction) is unconfirmed.
- The two different Claude Code/Anthropic tool-search token examples (191,300 vs. 122,800 tokens, confirmed via direct fetch of the engineering post, vs. a separately reported "72K→8.7K tokens, 134K before optimization" that a direct re-fetch of Claude Code's own MCP doc could not reproduce) were not reconciled — the second set of numbers should be treated as suspect until traced to an actual source.
- Codex's claimed 90%-of-context-window ceiling on a manual compaction override, and the "20,000 tokens preserved verbatim" compaction figure, come from secondary sources only and were not checked against the actual Rust compaction implementation.
- Neither Pi's `AGENTS.md`/`CLAUDE.md` nor Gemini CLI's `GEMINI.md` documents a size limit, unlike Claude Code (200 lines) and Cursor (500 lines) — whether this is a real gap or simply undocumented is unknown.
- No controlled, coding-agent-specific benchmark of push vs. pull memory delivery exists in the literature accessible during this research (§4 item 9); alambic's own `feedback --status hit|miss|stale|wrong` counters may be the best available proxy today, which raises the question of whether that feedback loop should be instrumented more rigorously.
- Whether Gemini CLI's "approved plan file" compaction-preservation mechanism could be repurposed to guarantee an alambic pointer's survival across compaction is untested.
- The `ENABLE_TOOL_SEARCH=auto` "10% of context window" deferral threshold for Claude Code is fork-reported only; my own direct re-fetch of the env-vars doc was inconclusive (the summarizing fetch tool may simply have dropped it) rather than a denial.

### 8. Sources

- https://code.claude.com/docs/en/memory — Claude Code memory (CLAUDE.md discovery/imports, auto memory) — accessed 2026-09-28 — confirmed
- https://code.claude.com/docs/en/skills — Claude Code skills — accessed 2026-09-28 — confirmed
- https://code.claude.com/docs/en/hooks — Claude Code hooks — accessed 2026-09-28 — confirmed
- https://code.claude.com/docs/en/mcp — Claude Code MCP — accessed 2026-09-28 — confirmed (self re-fetched directly)
- https://code.claude.com/docs/en/env-vars — Claude Code environment variables — accessed 2026-09-28 — confirmed (self re-fetched directly; `ENABLE_TOOL_SEARCH` full description and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` not found in the fetched excerpt)
- https://code.claude.com/docs/en/context-window — Claude Code context window / compaction — accessed 2026-09-28 — confirmed
- https://code.claude.com/docs/en/prompt-caching — Claude Code prompt caching — accessed 2026-09-28 — confirmed
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching — Anthropic platform prompt caching — accessed 2026-09-28 — confirmed
- https://www.anthropic.com/engineering/advanced-tool-use — Advanced tool use / Tool Search Tool — accessed 2026-09-28 — confirmed (direct fetch)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — accessed 2026-09-28 — confirmed
- https://claude.com/blog/context-management — Managing context on the Claude Developer Platform — accessed 2026-09-28 — confirmed
- https://platform.claude.com/docs/en/build-with-claude/context-editing — accessed 2026-09-28 — confirmed
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool — accessed 2026-09-28 — confirmed
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — accessed 2026-09-28 — confirmed
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills — accessed 2026-09-28 — confirmed
- https://www.anthropic.com/engineering/code-execution-with-mcp — accessed 2026-09-28 — confirmed
- https://learn.chatgpt.com/docs/agent-configuration/agents-md — Codex AGENTS.md — accessed 2026-09-28 — confirmed
- https://learn.chatgpt.com/docs/config-file/config-advanced — Codex advanced config — accessed 2026-09-28 — confirmed
- https://developers.openai.com/codex/skills — Codex skills — accessed 2026-09-28 — confirmed
- https://learn.chatgpt.com/docs/hooks — Codex hooks — accessed 2026-09-28 — confirmed
- https://learn.chatgpt.com/docs/extend/mcp — Codex MCP — accessed 2026-09-28 — confirmed
- https://learn.chatgpt.com/docs/customization/memories — Codex Memories — accessed 2026-09-28 — confirmed
- `openai/codex` source: `codex-rs/hooks/src/*`, `codex-rs/core/src/state/additional_context.rs`, `codex-rs/core/src/session/context_window.rs`, `codex-rs/protocol/src/config_types.rs`, `codex-rs/models-manager/src/model_info.rs`, `codex-rs/memories/*`, `codex-rs/ext/skills/*`, `codex-rs/skills/*` — accessed 2026-09-28 — verified
- https://developers.openai.com/api/docs/guides/prompt-caching — OpenAI prompt caching — accessed 2026-09-28 — confirmed
- https://cursor.com/docs/rules — Cursor rules — accessed 2026-09-28 — confirmed
- https://cursor.com/docs/skills.md — Cursor skills — accessed 2026-09-28 — confirmed
- https://cursor.com/docs/hooks.md — Cursor hooks — accessed 2026-09-28 — confirmed
- https://cursor.com/docs/context/mcp — Cursor MCP — accessed 2026-09-28 — confirmed
- https://cursor.com/blog/self-summarization — Cursor Composer self-summarization — accessed 2026-09-28 — confirmed
- `docs.cursor.com/context/memories` — Cursor Memories — accessed 2026-09-28 — not verified (client-side SPA, unfetchable; status via aggregated secondary sources)
- https://opencode.ai/docs/rules/ — opencode rules — accessed 2026-09-28 — confirmed
- https://opencode.ai/docs/agents/ — opencode agents — accessed 2026-09-28 — confirmed
- https://opencode.ai/docs/plugins/ — opencode plugins — accessed 2026-09-28 — confirmed
- `anomalyco/opencode` GitHub issues (plugin hook behavior, caching) — accessed 2026-09-28 — confirmed
- https://dev.opencode.ai/v2/docs/mcp-servers/ — opencode MCP — accessed 2026-09-28 — confirmed
- https://opencode.ai/docs/config/ — opencode config — accessed 2026-09-28 — confirmed
- https://opencode.ai/v2/docs/compaction/ — opencode compaction — accessed 2026-09-28 — confirmed
- `earendil-works/pi` `packages/coding-agent/docs/configuration.md`, `docs/skills.md`, `docs/extensions.md`, `docs/compaction.md`, `docs/settings.md`, `docs/models.md` (commit fetched 2026-09-28) — confirmed/verified
- `google-gemini/gemini-cli` `docs/cli/gemini-md.md`, `docs/cli/skills.md`, `docs/hooks/index.md`, `docs/hooks/reference.md`, `docs/tools/mcp-server.md`, `docs/cli/settings.md`, `docs/cli/auto-memory.md`, `docs/cli/token-caching.md`, `packages/core/src/prompts/snippets.ts`, `packages/core/src/context/chatCompressionService.ts` (commit fetched 2026-09-28) — confirmed/verified
- https://ai.google.dev/gemini-api/docs/caching — Gemini API caching — accessed 2026-09-28 — confirmed
- https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals — accessed 2026-09-28 — confirmed (direct fetch)
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus — accessed 2026-09-28 — confirmed (direct fetch)
- Medium, "The First Controlled Benchmark of AI Memory in Coding Agents" — accessed 2026-09-28 — not verified (HTTP 403, not a first-party/peer-reviewed source; numbers not cited)
- arXiv:2602.21611 — Structurally Aligned Subtask-Level Memory for Software Engineering Agents — accessed 2026-09-28 — not a match for the Part-B item-9 question

---

## Part 3: Consolidation, evaluation and security



> Every claim is labelled `confirmed` (a primary source states it — URL
> given), `verified` (checked directly against the source), `inferred`
> (reasoned from confirmed facts, not stated outright), or `not verified`
> (could not confirm in the time available).

### 1. Scope & method

This note answers three questions for `alambic`, a local-first Markdown wiki
engine for coding agents with a human-gated write path (quarantine inbox →
sha256-bound accept receipt → nightly promotion with validate/lint/leak-scan/eval
gates):

1. How to form and consolidate agent memory well (extraction, dedupe/merge,
   rewriting vs appending, forgetting, temporal validity).
2. How to evaluate memory usefulness cheaply for a single-user, 20-300-note
   vault.
3. How to defend memory against poisoning and prompt injection.

Method: primary sources only — arXiv abstracts/bodies, official repos, vendor
engineering posts treated as vendor-run (not independent), first-party security
advisories (OWASP, Microsoft, Palo Alto Unit 42). No claim without a source
check; numbers quoted with their exact setup (model, dataset, baseline).
A companion study (harness-landscape-memory-context, 2026-09-28) already
covers the Mem0 LOCOMO table, Zep's DMR 94.8% claim, and the Zep/Mem0
`getzep/zep-papers#5` dispute — not repeated here except by reference.

### 2. Consolidation: findings table + failure modes

#### 2.1 Findings table

| System | Mechanism | Headline result (exact setup) | Label |
| --- | --- | --- | --- |
| **ACE** — Agentic Context Engineering (arXiv 2510.04618) | Treats context as an evolving "playbook": incremental, structured delta updates rather than full-context rewriting. Explicitly names two failure modes it targets: **brevity bias** ("drops domain insights for concise summaries") and **context collapse** ("iterative rewriting erodes details over time") | **+10.6%** on agent benchmarks, **+8.6%** in the finance domain, both vs baselines; matches a top-ranked production agent's overall AppWorld average and **beats it on the harder test-challenge split** despite a smaller open-source model; also cuts adaptation latency and rollout cost, from natural execution feedback with no labels | `confirmed` (arXiv 2510.04618) |
| **Dynamic Cheatsheet** (arXiv 2504.07952) | A persistent, evolving memory of strategies/code/insights, reused at inference time on top of a black-box LM; no fine-tuning | Claude 3.5 Sonnet's AIME accuracy "more than doubled" once it retained algebraic insights across questions; GPT-4o's Game-of-24 success rate rose **10% → 99%** after discovering and reusing one Python-based solution; **+9%** on GPQA-Diamond and **+8%** on MMLU-Pro for Claude; on equation balancing, models "reached near-perfect accuracy by recalling previously validated code, whereas their baselines stagnated around 50%" | `confirmed` (arXiv 2504.07952) |
| **ReasoningBank** (arXiv 2509.25140) | Distills generalizable reasoning *strategies* (not raw trajectories, and from both successes and self-judged failures) into memory items; adds memory-aware test-time scaling (MaTTS) that trades extra rollout compute for richer contrastive signal | "Consistently outperforms existing memory mechanisms" on web-browsing and software-engineering benchmarks; exact %s not in the abstract | `confirmed` (mechanism) / `not verified` (exact numbers — abstract only) |
| **AWM** — Agent Workflow Memory (arXiv 2409.07429) | Induces reusable "workflows" from past trajectories and selectively supplies them to guide future generations; applies both offline and online | **+51.1% relative success rate on WebArena** — this closes the prior study's `not verified` flag; abstract gives only the relative figure, not the absolute baseline rate | `confirmed` (arXiv 2409.07429) |
| **A-MEM** (arXiv 2502.12110) | Zettelkasten-style: every new memory becomes an atomic note (context, keywords, tags); the system links it to related historical memories and can retroactively revise their attributes as the network evolves | "Superior improvement against existing SOTA baselines" across six foundation models; no numeric figure given in the abstract | `confirmed` (mechanism) / `not verified` (exact numbers) |
| **Letta sleep-time compute** (arXiv 2504.13171) | Shifts compute from inference-time to an offline/background phase that anticipates likely queries and pre-computes reusable context | ~**5x** test-time compute reduction for equal accuracy (Stateful GSM-Symbolic, Stateful AIME); up to **+13%/+18%** accuracy from scaling sleep-time compute on the same two; **2.5x** average per-query cost reduction when queries share context (Multi-Query GSM-Symbolic); benefit scales with how predictable the query pattern is | `confirmed` (arXiv 2504.13171) |
| **Generative Agents** (Park et al., arXiv 2304.03442) | Memory stream (full natural-language experience log) → periodic **reflection** synthesizes higher-level abstractions → retrieval scores by recency/importance/relevance → feeds planning | A single seeded idea ("host a Valentine's Day party") propagated into autonomous invitations, new acquaintances, coordinated dates, and simultaneous arrival; an ablation confirms observation, planning, *and* reflection are each independently necessary for believability | `confirmed` (arXiv 2304.03442) |
| **ExpeL** (arXiv 2308.10144) | Builds an experience pool from trial-and-error rollouts, then extracts cross-task insights with no weight update, layered onto a ReAct-style planner | HotpotQA **39%** vs ReAct **28%**; ALFWorld **59%** vs ReAct **40%**; WebShop **0.701** vs ReAct **0.665** mean reward; FEVER transfer **70%** vs ReAct **63%**; matches/beats Reflexion on ALFWorld (**59%** vs Reflexion's **39–40%** at round 3) | `confirmed` (arXiv 2308.10144, body/tables) |
| **Reflexion** (arXiv 2303.11366) | Verbal reinforcement learning: reflects in natural language on task feedback, stores the reflection in an episodic memory buffer, no weight updates | **91% pass@1 on HumanEval**, vs GPT-4's reported **80%** | `confirmed` (arXiv 2303.11366) |
| **Voyager** (arXiv 2305.16291) | An ever-growing library of executable code skills — temporally extended, interpretable, composable — explicitly framed as alleviating catastrophic forgetting | **3.3x** more unique items obtained, **2.3x** longer exploration distances, tech-tree milestones unlocked up to **15.3x** faster than prior SOTA (Minecraft) | `confirmed` (arXiv 2305.16291) |
| **mem0 ADD/UPDATE/DELETE/NOOP** (arXiv 2504.19413) | Retrieves semantically similar existing memories by vector similarity, then an LLM — via function/tool-calling, not a rule-based classifier — picks one of: **ADD** ("no semantically equivalent memory exists"), **UPDATE** ("complementary information"), **DELETE** ("contradicted by new information"), **NOOP** ("requires no modification") | Mechanism confirmed from the paper body; the LOCOMO comparative table is already covered by the companion study and not repeated here | `confirmed` (mechanism, arXiv 2504.19413) |
| **Graphiti** bi-temporal model (github.com/getzep/graphiti, blog.getzep.com) | Distinct from mem0's flat ADD/UPDATE/DELETE: tracks **two** timelines per fact — when it was true in the world (`valid_at`/`invalid_at`) and when the system learned it (`created_at`/`expired_at`). Contradictions trigger **edge invalidation, never deletion**, so history stays queryable and non-lossy; avoids full-graph recomputation on every update | Mechanism confirmed via the official repo/blog; the LongMemEval 63.8%/49.0% figure is already covered by the companion study and intentionally not repeated | `confirmed` (mechanism) |
| **HippoRAG** (arXiv 2405.14831) and **HippoRAG 2** (arXiv 2502.14802) | HippoRAG: LLM-extracted relational triples build a knowledge graph; Personalized PageRank over it mimics hippocampal "pattern completion" for **single-step** multi-hop retrieval. HippoRAG 2 (confirmed as the direct follow-up, ICML 2025): adds deeper passage integration, a dual passage/phrase-node graph, and LLM-based triple filtering, unifying dense and sparse retrieval | HippoRAG: up to **20%** over prior SOTA on multi-hop QA, **10–30x cheaper** and **6–13x faster** than iterative IRCoT retrieval. HippoRAG 2: **+7%** over the best embedding model specifically on associative-memory tasks, while avoiding the 5–10 F1-point regression on simple QA that other structure-based methods (RAPTOR, GraphRAG, LightRAG, original HippoRAG) show | `confirmed` (both headline figures, direct abstracts) |
| **2026 forgetting/bloat work** | "When to Forget" (arXiv 2604.12007) proposes **Memory Worth (MW)**: a two-counter per-memory signal tracking co-occurrence with success vs failure, converging to an estimate of p(success \| memory retrieved) — explicitly positioned against "static importance scores or LLM judgment" as the status quo, and cheap enough to "add to architectures that already log retrievals and episode outcomes." **FSFM** (arXiv 2604.20300) proposes a four-way taxonomy: passive decay-based, active deletion-based, safety-triggered, adaptive reinforcement-based. Several further 2026 arXiv titles surfaced by search but not read beyond title (AdaMem, Oblivion, MemRefine, ScrapMem, "Control-Plane Placement Shapes Forgetting," "Forget to Improve," "Rate-Distortion Framework for Agent Memory") indicate this is now an active subfield, not an isolated result | MW: Spearman **ρ = 0.89 ± 0.02** correlation with true memory utility after 10,000 episodes, vs **ρ = 0.00** for a non-updating baseline | `confirmed` (When to Forget MW metric and number, FSFM taxonomy) / `not verified` (the remaining titles, abstract unread) |

#### 2.2 Recurring failure modes

- **Context collapse from repeated full-context rewriting.** Named explicitly by ACE: an LLM that rewrites its own accumulated context on every update erodes detail over successive passes, rather than converging. Delta-update / incremental-edit designs (ACE itself, A-MEM's "update existing note attributes on new-note insertion," Graphiti's invalidate-don't-delete) are the documented fix.
- **Brevity bias.** Also named by ACE: optimizing an editor step for concise summaries silently drops domain-specific detail that later matters, even when the rewrite "looks" like a faithful compression.
- **Duplicate / near-duplicate accumulation.** The reason mem0's operation set includes an explicit NOOP path (and A-MEM's dynamic-linking step revises related notes instead of appending next to them): without a merge/no-op decision at write time, semantically-repeated memories multiply and dilute retrieval.
- **Stale facts that are never invalidated.** Graphiti's whole bi-temporal design exists because a naive additive memory keeps superseded facts alongside contradicting new ones unless something explicitly marks the edge invalid; mem0's DELETE operation is the flat (non-temporal) equivalent for systems that don't track valid-time separately from ingestion-time.
- **Unbounded growth with no forgetting policy.** The entire 2026 subfield found here is a direct response to this gap — as "When to Forget" states, systems "lack a principled operational metric for memory quality governance — deciding which memories to trust, suppress, or deprecate as the agent's task distribution shifts."
- **Catastrophic forgetting under naive parametric approaches** — sidestepped by construction across this whole non-parametric family (ExpeL, Reflexion, Voyager, ACE, Dynamic Cheatsheet, ReasoningBank, mem0, A-MEM, Graphiti, HippoRAG all avoid weight updates entirely). Voyager is explicit that its code-skill library "alleviates catastrophic forgetting" specifically because skills are stored externally and composably rather than baked into parameters.
- **The operation-selection step is itself an LLM judgment call, hence an attack surface.** mem0's ADD/UPDATE/DELETE/NOOP choice is made by an LLM reasoning over retrieved neighbors and the candidate fact, not a deterministic rule — a design the paper frames as flexibility, but which is exactly the decision point AgentPoison, MINJA and MemGhost (§4) target: whichever text reaches that classification call can bias it toward a wrong ADD/UPDATE. This is the direct bridge between the consolidation and security literatures: a consolidation mechanism's quality and its attack surface are often the same step.

What could not be verified in this section: exact numeric results for ReasoningBank and A-MEM (both abstracts stop at qualitative superiority claims); the 9M-vs-115M-token HippoRAG 2 indexing-cost comparison (secondary source only); the content of the AdaMem/Oblivion/MemRefine/ScrapMem 2026 papers beyond their titles.

### 3. Evaluation: benchmarks table + cheap eval designs for alambic

#### 3.1 Benchmarks and critiques

| Benchmark / critique | What it tests | Headline result (exact setup) | Label |
| --- | --- | --- | --- |
| **LongMemEval** (arXiv 2410.10813) | Five core long-term memory abilities of chat assistants: **information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention**. 500 curated questions; 164 user attributes across 5 categories; LongMemEval-S ≈115k tokens/question, LongMemEval-M ≈500 sessions/question (≈1.5M tokens), up to 6 evidence sessions per question at varying depths | **ChatGPT+GPT-4o: 57.73%** with full history vs **91.84%** offline-reading-only baseline (**37% relative drop**); **Coze+GPT-4o: 32.99%** vs the same 91.84% baseline (**64% relative drop**). On LongMemEval-S (full history vs oracle-evidence-only): **GPT-4o −30.3%**, **Llama-3.1-70B −55.1%**, **Llama-3.1-8B −36.1%**, **Phi-3-128k −45.9%**. With retrieval optimizations (top-5 + fact expansion, LongMemEval-M): GPT-4o rises to 65.7%. Authors self-report **>97% agreement** between their LLM evaluator and human judges (self-reported, not independently audited) | `confirmed` (arXiv 2410.10813, body) — closes the prior study's `not verified` flag |
| **LoCoMo** (arXiv 2402.17753) | Very long-term open-domain conversation: avg. **300 turns / 9K tokens**, up to **35 sessions**. Three task types: question answering, event summarization, multi-modal dialogue generation | LLMs struggle with long-range temporal/causal dynamics; long-context LLMs and RAG both improve results but "still substantially lag behind human performance" (no single headline %, a qualitative gap claim in the paper's own abstract — the Mem0-on-LoCoMo numeric table is covered by the companion study, not repeated here) | `confirmed` (arXiv 2402.17753) — closes the prior study's `not verified` flag |
| **MemoryAgentBench** (Hu et al., arXiv 2507.05257) | Organizes evaluation around **four competencies**: accurate retrieval, test-time learning, long-range understanding, selective forgetting. Transforms existing long-context datasets plus new ones into multi-turn, incremental-accumulation format (closer to how a real memory agent actually receives information) — evaluates in-context, RAG, external-memory, and tool-use agents alike | "Current methods fall short of mastering all four competencies" — no single system wins across the board | `confirmed` (arXiv 2507.05257) |
| **VibeMemBench** (arXiv 2609.23570, 2026) — coding-agent-specific | Isolates a memory system's actual contribution on **real repository coding tasks**: 111 targets across 90 SWE-rebench V2 repos, 3,634 history trajectories. Injects a frozen, pre-verified "reference experience" directly, confirms it helps in a controlled setting, then checks whether each memory system can *itself* retrieve/reconstruct that same benefit for five held-out solvers | Direct experience injection improves resolution by **1.1–4.5 percentage points** on four solvers (proving the experience *is* useful) — but **11 of 12 solver/memory-system pairings fail to exceed the matched memory-off baseline** once the memory system has to do the retrieval itself | `confirmed` (arXiv 2609.23570) — the single most important number in this section: today's coding-agent memory systems mostly don't pay for themselves even when the underlying knowledge is genuinely useful |
| **LLM-judge critiques — memory-specific** | **Locomo-Plus** (arXiv 2602.10715, "Beyond-Factual Cognitive Memory Evaluation Framework for LLM Agents," `confirmed`, fetched directly): argues LoCoMo-style evaluation targets explicit factual recall, not the *implicit* constraints (user state, goals, values) real memory use requires, and that "conventional string-matching metrics and explicit task-type prompting are misaligned with such scenarios" — i.e. telling the judge the task type in advance, and scoring by string/BLEU-style overlap, both bias the measurement; proposes a "constraint consistency" framework instead. **Independent technical audit** (Penfield Labs, Substack, 2026-04-08, methodology public at `github.com/dial481/locomo-audit`, `confirmed` as to what it claims, not peer-reviewed): of LoCoMo's 1,540 questions, **99 (6.4%) have a score-corrupting error** in the answer key itself (hallucinated facts, wrong temporal reasoning, 24 cases of speaker misattribution); separately, its own re-run of a GPT-4o-mini judge **accepted intentionally-wrong-but-topically-adjacent answers 62.81% of the time** while catching concrete factual errors (wrong name/date) ~89% of the time — i.e. the judge is far better at rejecting specific falsehoods than vague non-answers, and there is no standardized judge prompt across published LoCoMo results, so scores are not straightforwardly comparable across papers | **General LLM-judge critiques (not memory-specific):** "Benchmarking LLM-as-a-Judge for Long-Form Output Evaluation" (arXiv 2606.01629, `confirmed`): "current LLM judges remain unstable across scenarios, and rubrics or references are helpful but not always sufficient." "Evaluating Scoring Bias in LLM-as-a-Judge" (arXiv 2506.22316, `confirmed`): **rubric-order bias**, **score-ID bias**, **reference-answer-score bias** — "even the most advanced LLMs suffer from these substantial scoring biases." Self-preference/position bias are widely reported elsewhere but not pinned to one fetched primary source here | `confirmed` for all named findings above; the 6.4%/99-question and 62.81% figures come from a non-peer-reviewed but methodology-public independent audit, not an academic paper — treat as a strong secondary source, not equivalent to a refereed result |

VibeMemBench's finding is worth restating plainly because it reframes the whole evaluation question for alambic: the risk is not only "does the vault answer questions" but "does the vault's actual write/retrieve pipeline outperform just not having one," and most published coding-memory systems currently fail that bar once you stop hand-feeding them the right experience.

#### 3.2 Cheap online-evaluation designs for alambic

Alambic's actual situation — a single user, local, 20–300 Markdown notes, a CLI/MCP with `vault_search`/`vault_context`/`vault_read` (read) and `vault_capture`/`vault_feedback` (staging, counts only), and frozen sha256-pinned eval sets under `_meta/evals/` gated by `eval --suite tuning|probes-v2` — rules out an LLM-judge pipeline (no budget, and §3.1's bias critiques apply) and rules out academic-scale benchmarks (n=1, no thousands of sessions). Five designs, each grounded in the literature above:

1. **Recall@k mined from real sessions**, informed by LongMemEval's five-ability taxonomy and MemoryAgentBench's "accurate retrieval" competency. Mine question-like turns directly from the same session transcripts `harvest scan` already reads, pair each with the note path a later human `review --inbox --decision accept` receipt actually promoted for that topic (ground truth is a byproduct of the existing review step, not new labeling work), and check whether `alambic query`/`context` returns that note path in the top *k* — set **k = 3** to match the per-prompt hook's own injection cap, so the eval measures exactly what the hook can actually deliver. Because alambic retrieves whole notes, not extracted spans, "hit" is note-ID-in-top-k, which sidesteps needing any LLM judge and slots into the existing frozen-set machinery: append labeled mined questions to `_meta/evals/probes-v2.jsonl` and let the existing sha256-freeze and floor-gate in `_meta/alambic eval --suite probes-v2` absorb them like any other probe.
2. **Abstention quality**, informed directly by LongMemEval's "abstention" ability and MemoryAgentBench's "selective forgetting" competency. Alambic already exits 0 and injects nothing below the frozen hook-gate threshold, and already collects `feedback --status hit|miss|stale|wrong` counts — no new subsystem needed, only two ratios computed from existing counters over a rolling window (e.g. 30 days): **precision-when-answering** = `hit / (hit + wrong)`, and **false-abstention rate** = `miss / (hit + miss)`. A rising `wrong`-share is the signal that the hook is answering when it should abstain; a rising `miss`-share is the opposite failure. Both are free — no LLM call, just arithmetic over counts alambic already logs.
3. **Staleness detection without an LLM judge**, informed by the fact that none of §2's consolidation systems has a *cheap* non-LLM staleness detector (mem0's DELETE and Graphiti's invalidation are both themselves LLM decisions) and by "When to Forget"'s Memory Worth design (a cheap two-counter signal, no LLM, built only from data already logged). Three deterministic layers for alambic: (a) an HTTP HEAD/liveness check on every `sources:` URL in `kb/`/`ref/` frontmatter, run at `lint`-time, flagging 404/410/redirect-to-different-domain as a staleness signal; (b) a lexical-overlap heuristic at lint-time — two notes sharing ≥N tags or an explicit wikilink, with high lexical overlap but different `updated` dates beyond some threshold, flagged as a "possible supersession, needs human look" pair, mirroring Graphiti's invalidate-don't-delete idea but computed with existing lexical tooling instead of a graph; (c) a per-note Memory-Worth-style ratio using feedback counts already collected: `stale / (hit + stale)` rising over a window flags a candidate for review, the same "two-counter, no LLM" shape as arXiv 2604.12007 but reusing counters alambic already has rather than adding new instrumentation.
4. **Hook on/off A/B on real tasks**, sized correctly for n=1: none of LongMemEval/LoCoMo/MemoryAgentBench are designed for a single continuously-running user, so the right analogue is a **within-subject, time-sliced** A/B (alternate the per-prompt hook on/off by day or by session, logged locally) rather than a between-subject RCT. Compare, per session, signals alambic already computes: session length to completion (visible in the same transcript `harvest scan` reads), the hit/miss/wrong feedback mix recorded on hook-on vs hook-off days, and — reusing `harvest scan`'s own session-value scorer rather than building a second evaluator — whether hook-on sessions score higher (fewer corrections, less re-explaining prior context). This is a repurposing of instrumentation that already runs daily, not a new pipeline.
5. **Cost per successful task**, sized for "no ground-truth judge budget": not $/query (a vendor-benchmark framing, e.g. Mem0's own p95-latency/token table from the companion study), but **tokens spent per accepted note**, i.e. metered distiller + enrich token usage (only non-zero when `TYPESAFE_API_KEY` is set) divided by the count of drafts that reach an `accept` receipt over a rolling window — both numbers `harvest status` and the enrich ledger already track. VibeMemBench's headline result is the concrete reason this metric matters: it is entirely possible to run a real, metered pipeline that does not pay for itself, and nothing in alambic's current output surfaces that risk directly today.

What could not be verified in this section: the Penfield Labs LoCoMo audit's 6.4%/62.81% figures are from a non-peer-reviewed source with public methodology, not an independently re-run or refereed number; whether MemoryAgentBench or VibeMemBench have been independently reproduced outside their own paper; MemoryAgentBench's often-quoted "22 systems / 5 backbone models" scope figure (seen only in secondary coverage, not in the fetched abstract itself).

### 4. Security: attacks table + mitigation-to-alambic-control matrix

#### 4.1 Attacks (success rate, mechanism, preconditions)

| Attack | Source | Mechanism | Success rate / poison rate | Preconditions |
| --- | --- | --- | --- | --- |
| **AgentPoison** | arXiv 2407.12784 (`confirmed`, abstract) | Optimizes a backdoor trigger as a constrained-optimization problem that maps poisoned instances into a unique embedding region, so any query containing the trigger retrieves attacker-chosen demonstrations from the agent's memory/KB with high probability; needs no model training or fine-tuning | avg **ASR > 80%**, poison rate **< 0.1%** of the memory/KB, benign-performance drop **< 1%** | Attacker inserts a small number of poisoned demonstrations into the RAG memory or knowledge base (tested on a RAG-based autonomous-driving agent, a knowledge-intensive QA agent, and EHRAgent) |
| **MINJA** (Memory INJection Attack) | arXiv 2503.03704 (`confirmed`, body Table 1) | Attacker interacts only as a normal user across multiple turns: plants a malicious record with "bridging steps" plus an explicit "indication prompt", then progressively strips the indication prompt across further turns so the malicious record becomes retrievable under unrelated future queries without any explicit trigger | Injection succeeds nearly every time (Inject Success Rate 95.6–100% across agents/datasets); the harder downstream metric, Attack Success Rate (does the injected record actually trigger the malicious reasoning later) — **EHRAgent/MIMIC-III 57.0±10.3%, EHRAgent/eICU 90.0±3.5%, RAP/Webshop-GPT-4 77.4±14.5%, RAP/Webshop-GPT-4o 98.9±2.2%, QA Agent/MMLU 68.9±19.1%** — using only 10 (MMLU) to 15 (others) attacker queries per victim-target pair, shuffled among benign queries | Explicitly **no direct memory-write access** — only standard query/observation interaction, "any user can influence agent memory" |
| **MemGhost** / "When Claws Remember but Do Not Tell" (2026) | arXiv 2607.05189 (`confirmed`, abstract) | Single malicious email; an RL-trained attacker policy crafts a payload that makes the agent's own file tools write a false memory while the visible reply stays silent about the write (stealth is an explicit optimization objective, alongside a new 108-case "WhisperBench" benchmark) | **87.5%** end-to-end success (56 held-out cases) against OpenClaw/GPT-5.4; **71.4%** against a Claude Code SDK agent on Sonnet 4.6; reported robust against input-, model-, and system-level defenses tested, and transfers across agent architectures (NanoClaw and another open agent framework) and memory backends (filesystem and vector-based Mem0) | One inbound email/document; no memory-write access or runtime feedback needed |
| **Cisco "MemoryTrap"** (Claude Code) | Cisco Blogs, 2026-04-01, first-party-adjacent disclosure + Anthropic fix (`confirmed`, fetched directly) | An npm `postinstall` lifecycle hook writes into Claude Code's memory files (global `~/.claude/projects/*/memory/MEMORY.md`) and `~/.claude/settings.json`. Because the first 200 lines of memory files were loaded directly into Claude Code's system prompt as "high-authority" instructions, and the payload also touched shell config (`.zshrc`/`.bashrc`) and hooks config, the poison persisted across sessions and projects | Disclosed proof-of-concept chain, not a %ASR paper | Victim runs `npm install` on one malicious package once; the memory channel does the rest |
| Rehberger — ChatGPT memory hacking | embracethered.com, 2024-05-22 (`confirmed`) | Prompt injection via a referenced Google Doc/OneDrive file, an uploaded image with hidden instructions, or (partially, via tool-chaining/delayed multi-turn triggers) web browsing, writes persistent false memories through ChatGPT's own memory tool | PoC, no ASR% given; OpenAI closed the report as a "Model Safety Issue," patched browsing only, and "these remain not 100% effective" per the author | User must reference/open an attacker-controlled document, or browse an attacker page, inside a chat |
| Rehberger — **SpAIware** | embracethered.com, 2024-09-20 (`confirmed`) | Same memory-write primitive, chained into continuous exfiltration: the injected memory instructs ChatGPT to render an invisible markdown image to an attacker server on every future turn, with conversation content embedded as query parameters | PoC; fixed in ChatGPT macOS **v1.2024.247** via a `url_safe` check — author notes it "still allows for some information to be leaked," and the underlying memory-injection primitive itself was not fixed (manual memory review still required) | Same as above; persists indefinitely until memory is manually cleaned |
| Rehberger — **Claude Opus 4.7 memory hijack** (the documented Claude-specific case the task asked for) | embracethered.com, 2026-04-17, "Breaking Opus 4.7 with ChatGPT" (`confirmed`, fetched directly) | A ChatGPT-generated adversarial image (a "puzzle," text hidden in a way not obvious to a casual viewer) is uploaded to Claude; Opus 4.7 solves the embedded social-engineering puzzle and calls its own memory tool to persist fabricated biographical facts about the user (fake name, job, employer) | **5/10 trials** succeeded; worked more reliably against an empty memory store; notably, "every single time, Opus either detected potential prompt injection or highlighted if it's appropriate to store these memories... but in the end it still got hijacked" — detection fired without enforcement stopping the write. The specific adversarial image **stopped working within ~24h of publication** (ASR fell to 0%), consistent with a live classifier/mitigation update, cause not confirmed by the author | Victim needs only to upload one attacker-crafted image to a chat with memory enabled |
| Unit 42 — Bedrock Agent memory poisoning | unit42.paloaltonetworks.com (`confirmed`) | Indirect prompt injection from a compromised webpage manipulates the agent's session-summarization step (using forged XML tags and positioning outside `<conversation>` blocks) so forged content is stored as a "conversation summary" in long-term memory, then re-injected into the orchestration prompt every subsequent session | PoC on Amazon Bedrock Agents (Nova Premier v1, default templates); cites the separate Agent Security Bench's own figure of up to **84.30% ASR** across 27 attack/defense combinations as general context, not this PoC's own number | Agent must browse/consume attacker content once, with memory retention enabled |
| Claude.ai hidden-HTML exfiltration | Oasis Security blog, 2026-03-18 (`confirmed`) | Invisible HTML tags embedded in the `claude.ai/new?q=...` URL parameter are stripped from the visible chat box but still fully processed by Claude on Enter; the hidden prompt embeds an attacker API key and instructs Claude to search conversation history/memory and upload matches via the built-in Files API — "no integrations or external tools needed" | Disclosed through Anthropic's responsible-disclosure program; "Anthropic has fixed the prompt injection vulnerability" per the researchers, some related issues were still being addressed at publication | Victim needs only to click an attacker-crafted link |

#### 4.2 Defensive mechanisms (primary sources)

- **Microsoft Spotlighting** (arXiv 2403.14720, `confirmed`): three variants, not one — **delimiting** (boundary tokens, "easy to accomplish... only modest defense"), **datamarking** (interleaving a marker character throughout the text, e.g. replacing whitespace with `^`), and **encoding** (e.g. base64, "the most effective variant," requires a high-capacity model to implicitly decode). Reported numbers: baseline ASR ~60% (GPT-3.5-Turbo) / ~40% (text-davinci-003); delimiting ~30%; **datamarking < 3%** (0% on text-003); **encoding ~0–1.8%** (0% on text-003) — all with minimal task-efficacy impact. The paper's own headline line: "spotlighting reduces the attack success rate from greater than 50% to below 2%."
- **CaMeL** (arXiv 2503.18813, `confirmed`): a concrete Dual-LLM instantiation. A **Privileged LLM (P-LLM)** sees only the user's natural-language query and emits Python code expressing intent; it never sees tool outputs or the Q-LLM's output. A **Quarantined LLM (Q-LLM)** parses untrusted data into structured schemas and cannot talk back to the P-LLM (that channel would itself be an injection vector). A capability system tags every value with provenance (user literal / CaMeL transform / specific tool) and allowed readers, and the interpreter's data-flow graph guarantees "untrusted data retrieved by the LLM can never impact the program flow." On AgentDojo: **77% task-success with provable security vs 84% undefended** (headline); with no security policy, CaMeL still cuts successful attacks from 300 (baseline) to **0** for Gemini 2.5 Pro, vs 8 residual for the next-best defense (tool filter); costs **2.82× input tokens / 2.73× output tokens** vs native tool-calling.
- **"Design Patterns for Securing LLM Agents against Prompt Injections"** (arXiv 2506.08837, `confirmed`): six named patterns, each with a utility/security trade-off — **Action-Selector** (LLM only picks from a fixed action set — trivial immunity, low flexibility), **Plan-Then-Execute** (fixed plan formed before any untrusted data arrives — control-flow integrity, but parameters can still be corrupted), **LLM-Map-Reduce** (isolated sub-agents each process one untrusted item, then aggregate — contains blast radius, needs decomposable tasks), **Dual LLM** (privileged + quarantined LLM, symbolic handling of quarantined output — as in CaMeL, but the returned values still need constraints enforced on them), **Code-Then-Execute** (agent writes an explicit program that calls tools/spawns unprivileged LLMs, then the program runs — reasoned-about control flow, less dynamic), **Context-Minimization** (strip content, especially the user prompt, from context after it has driven the initial action but before results are processed — blocks user-side injection of the response step, at the cost of reactivity).
- **OWASP Top 10 for Agentic Applications** (genai.owasp.org, `confirmed` for ID/title/one-line description; mitigation bullets below are `not verified` verbatim — pieced together from secondary sources quoting the taxonomy, not read directly from the primary PDF/table): **ASI06 — Memory & Context Poisoning** ("memory poisoning reshaped behaviour long after the initial interaction"; example cited: "Gemini Memory Attack"). Full ASI01–ASI10 list confirmed from the same announcement post: ASI01 Agent Goal Hijack, ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse, ASI04 Agentic Supply Chain Vulnerabilities, ASI05 Unexpected Code Execution, ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Communication, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents. Mitigation themes recurring across secondary summaries of ASI06 (`not verified` against the primary taxonomy text itself): provenance metadata on every memory write, tenancy separation, deliberate forgetting windows, periodic evaluation against ground truth, and inline detectors (prompt injection, PII/secret leakage, key tampering, hash-based integrity checks, size-anomaly detection) on every memory read/write. One secondary source (arturmarkus.com, `not verified`, not cross-checked against a benchmark paper) claims such detectors "miss 66% of poisoned entries" — flagged here as an unverified but directionally important caution against over-trusting inline detection alone.

#### 4.3 Mitigation-to-alambic-control matrix

| Mitigation (source) | What it does | Alambic's control | Verdict |
| --- | --- | --- | --- |
| Datamarking / encoding (Spotlighting, arXiv 2403.14720) | Transform untrusted text itself so the model can distinguish instructions from data, not just a label | MCP responses carry `content_trust: untrusted-retrieved-content`; retrieved `kb/`/`ref/` content is always labelled untrusted at read time (`SECURITY.md`) | **Partial.** Alambic marks untrusted content with a trust tag — closer to *delimiting* than to *datamarking/encoding*. A label is metadata the calling agent must honor; nothing transforms the note body itself the way datamarking/encoding do, and Spotlighting's own numbers show delimiting is the weakest of the three variants (~30% residual ASR vs <3%/<2% for the other two). |
| Dual-LLM / quarantined LLM (CaMeL; Design Patterns pattern 4) | Split the LLM that decides intent from the LLM that touches untrusted data; untrusted data never drives control flow | `harvest distill`'s external distiller (`claude -p`, **no tools**) reads only fenced session excerpts and returns JSON; it cannot execute anything or write to `kb/` directly. The ADD/UPDATE/NOOP judge (code, not an LLM) and the sha256-bound human `review --inbox` sit between the distiller's output and any write | **Strong match**, arguably stronger than CaMeL's own Q-LLM boundary because the human-in-the-loop gate is not itself an LLM at all. Gap: the distiller's JSON is still adversarially reachable (a crafted transcript could bias its proposed ADD/UPDATE framing); the only backstop against a misleading-but-well-formed draft is the human reading it, so the security property rests entirely on that one human step having no automated symbolic sanity-check comparable to CaMeL's capability tags. |
| Action-Selector / Plan-Then-Execute (Design Patterns patterns 1–2) | Fix the action set / plan before untrusted data arrives, so it cannot add new steps | Nightly's pipeline order (harvest → distill → enrich → sidekick → validate → lint → leak-scan → commit) is fixed code, not re-planned from any note's content | **Strong match** structurally: no untrusted excerpt can insert a pipeline step. The mapping is coarser than an LLM's per-call action selection, but the guarantee (fixed control flow, data cannot alter it) is the same. |
| Context-Minimization (Design Patterns pattern 6) | Strip content once its job is done, so it cannot bias later generation | The per-prompt hook caps injected context at 1200 tokens and always exits 0 | **Partial.** This bounds size, it does not strip content — a full injection payload fits comfortably under 1200 tokens. Minimization in the paper's sense (removing the *content*, not just capping length) is not implemented here. |
| Generic memory-poisoning mitigations (OWASP ASI06 themes; Unit 42; MemGhost paper) — provenance on every write, tenancy separation, forgetting windows, periodic re-evaluation against ground truth, integrity hashing | Standard defense-in-depth list for RAG/memory poisoning | sha256-bound accept receipts give per-file integrity/provenance; `scanUnsafe` blocks secrets and instruction-like text before a draft is even queued; the frozen, sha256-pinned `_meta/evals/` sets with a lexical floor are a form of "periodic evaluation against ground truth"; the write-journal plus displaced-file mechanism (ADR) detects any write that diverges from the checked chain | **Strong match on provenance/integrity and periodic re-evaluation.** Clear **gap on "deliberate forgetting windows"**: nothing in the described pipeline re-checks or expires an old note on a schedule — staleness surfaces only through accumulated `feedback --status stale` counts or an ad hoc human review, not a time-boxed re-verification trigger. |
| Cisco MemoryTrap lesson: memory content must not acquire "system-prompt authority" merely by being present | Don't let stored memory silently override the model's actual instructions | Alambic itself has no system prompt — it is a CLI/MCP server returning data to a calling agent, not the agent loop | **Structurally alambic dodges this specific failure mode** (it doesn't compile its own system prompt), but the *identical* failure mode is possible one layer up, in the calling harness: this Cisco disclosure is primary-source, dated (2026-04-01) confirmation that Claude Code itself gave memory files exactly this "high-authority" status until v2.1.50. The prior study's "Brèche" line — Claude's auto-memory writes outside alambic's quarantine and reloads every session, `inferred` — is no longer merely inferred: MemoryTrap is direct evidence that this class of channel (an agent's own native memory file, outside any vault's quarantine) is real, disclosed, and was exploited before Anthropic patched the *system-prompt* side of it. Alambic's per-prompt hook already marks its injections untrusted and caps them; Claude Code's own `memory.md` channel is outside alambic's reach entirely, so this is a gap in the ecosystem, not in alambic's own code. |
| Inline poisoning detectors alone are insufficient (directional caution, `not verified` numeric claim) | — | `scanUnsafe` (secrets + instruction-like text) is exactly this class of inline detector | **Gap**: alambic has no measured false-negative rate for `scanUnsafe` against adversarial (rather than accidental) payloads. Given the unverified-but-plausible claim that such detectors commonly miss a majority of adversarial entries, `scanUnsafe` should be treated as a filter that reduces volume, not a security boundary — the sha256-bound human read remains the actual boundary, which matches how alambic's own ADR already frames the TTY check ("a procedural guard, not proof of a human"). |

What could not be verified in this section: Unit 42's own PoC-specific ASR number (its post gives no single figure for its own Bedrock experiment; the 84.30% belongs to a different benchmark, Agent Security Bench, cited only as context — MINJA's ASR, by contrast, was confirmed directly from its body's Table 1, see §4.1); the OWASP ASI06 mitigation list verbatim from the primary taxonomy document itself (only paraphrased via secondary sources — the primary announcement post gave the ID/title/example but not the full mitigation bullets); the "66% miss rate" detector claim (single secondary blog, no primary benchmark located, and explicitly not found on Unit 42's own page when fetched directly).

### 5. Implications for alambic

Numbered by the requested priority — security first, then consolidation, then evaluation.

1. **Flag the distiller's ADD/UPDATE/NOOP judgment as reviewer-visible risk, not silent routing.** Evidence: AgentPoison, MINJA, and MemGhost (§4.1) all target exactly the classification step that decides what a memory system does with new text; mem0's own operation choice is an LLM call over retrieved neighbors (§2.1), i.e. the same class of decision point. Expected benefit: today `review --inbox` shows a human the proposed draft, but nothing highlights *why* the judge chose UPDATE/ADD over NOOP, so a subtly-steered proposal looks like any other. Surfacing the judge's reasoning/diff prominently turns the sha256-bound accept from a rubber stamp into an informed check. How to measure: track reviewer reject-rate and time-to-decision before/after the change (cheap, from existing review receipts). Cost: **S** (CLI output change only). Surface: `_meta/lib/promotion-judge.mjs`, `review --inbox` CLI rendering.
2. **Add a frozen adversarial-canary suite alongside `probes-v2`.** Evidence: the recurring "detectors miss most poisoned entries" caution (§4.2) and the fact that `scanUnsafe` has never been measured against adversarial (as opposed to accidental) payloads. Expected benefit: a concrete, repeatable number instead of an assumption about how much `scanUnsafe` actually blocks. How to measure: canary-catch-rate = canaries blocked / canaries injected, frozen and sha256-pinned exactly like `probes-v2.jsonl`. Cost: **M** (writing realistic adversarial fixtures is the real work; the harness to run them already exists). Surface: new `_meta/evals/canaries.jsonl`, `_meta/tests/leak-scan.sh` / the `scanUnsafe` module, wired into `npm test`.
3. **Move the untrusted-content signal from a label toward a transform.** Evidence: Spotlighting's own numbers (§4.2) show delimiting-style marking (which is what `content_trust: untrusted-retrieved-content` structurally is) residually leaves ~30% ASR, vs <3% for datamarking and ~0–1.8% for encoding. Expected benefit: a stronger floor under the trust label, independent of whether the calling harness chooses to honor metadata. How to measure: an internal canary test (reuse implication 2's fixtures) run once with the current label-only behavior and once with a transform applied, comparing whether a controlled test harness "follows" an embedded instruction in each case. Cost: **S** for the transform itself, **M** to build the test harness that measures its effect. Surface: `_meta/harness/` hook templates that render injected context, `SECURITY.md`.
4. **Give superseded notes an explicit invalidate path distinct from UPDATE.** Evidence: Graphiti invalidates edges rather than deleting or silently overwriting them (§2.1); alambic's own promotion path is currently ADD/UPDATE/NOOP only (per the ADR), with no distinct "this contradicts and replaces" outcome — an UPDATE can silently drop a prior claim with no trace. Expected benefit: preserves the audit trail Graphiti's design is built around, and matches the "provenance on every write" mitigation theme from OWASP ASI06 (§4.2) more literally than a plain overwrite does. How to measure: count of UPDATE receipts that replace a large fraction (e.g. >80%) of a note's prior body — a proxy for "this was actually a contradiction, not a complement" — before and after adding the explicit path. Cost: **M** (schema change: a `status: superseded` note kept alongside the new one, plus judge logic to propose it). Surface: `_meta/lib/promotion-judge.mjs`, `kb/` frontmatter schema (`status` enum).
5. **Add a scheduled staleness re-check instead of relying only on accumulated feedback.** Evidence: this is the one mitigation theme from §4.2/§4.3 with no current alambic equivalent at all ("deliberate forgetting windows"); it is also the entire premise of the 2026 forgetting subfield (§2.1 — "When to Forget," FSFM). Expected benefit: catches a stale note before enough real queries accumulate `stale` feedback to notice it organically — relevant precisely because a 20–300-note single-user vault may go a long time between queries that touch any one note. How to measure: the staleness-ratio design in §3.2(3) — `stale / (hit + stale)` per note over a rolling window, plus the cheap deterministic layers (source-URL liveness, lexical-overlap/date-gap heuristic). Cost: **M**. Surface: `_meta/validate-kb.sh` or a new lint pass, `_meta/lib/` staleness module.
6. **Surface "tokens spent per accepted note" in `harvest status`.** Evidence: VibeMemBench's headline result (§3.1) — 11 of 12 real coding-memory-system/solver pairings failed to beat a memory-off baseline even when the underlying experience was genuinely useful. Expected benefit: turns an invisible risk (a metered pipeline that doesn't pay for itself) into a number the vault owner sees on every `harvest status` run. How to measure: (distiller + enrich metered tokens) / (drafts reaching an accept receipt) over a rolling 30-day window — both already tracked. Cost: **S** (arithmetic over existing counters). Surface: `_meta/lib/harvest.mjs` (or wherever `harvest status` aggregates), `npm run harvest`.
7. **Mine `recall@k` probes from real sessions into the frozen eval set.** Evidence: LongMemEval's ability taxonomy and MemoryAgentBench's "accurate retrieval" competency (§3.1) both test exactly this, and alambic's own README already flags that `_meta/evals/` sets are "labeled against the starter notes" — i.e., synthetic, not grounded in this vault owner's real question distribution. Expected benefit: closes that named gap directly, using k=3 to match the per-prompt hook's own cap so the eval measures what the hook can actually deliver. How to measure: recall@3 on the mined set, tracked over time via `_meta/alambic eval --suite probes-v2`. Cost: **M** (one mining script plus a one-time human labeling pass per new question — reuses the existing `review --inbox` step as the labeling moment). Surface: `_meta/evals/probes-v2.jsonl`, `npm run eval:freeze`.
8. **Run the per-prompt hook's on/off A/B as a real within-subject trial before trusting the frozen threshold.** Evidence: none of LongMemEval/LoCoMo/MemoryAgentBench/VibeMemBench validate an n=1 continuously-running setup (§3), so `_meta/evals/hook-gate.json`'s threshold currently rests only on a synthetic frozen gate. Expected benefit: direct, cheap evidence the hook helps (or doesn't) for this specific user, reusing `harvest scan`'s own session-value scoring rather than building a second evaluator. How to measure: session-length and hit/miss/wrong feedback-mix delta between hook-on and hook-off days over a multi-week toggle. Cost: **S** (toggle + comparison script) to **M** (waiting long enough for signal). Surface: `_meta/evals/hook-gate.json`, the setup hook toggle in `_meta/lib/setup.mjs`.

### 6. Open questions

1. What does OWASP's own **primary** Top 10 for Agentic Applications document (the actual taxonomy PDF/table, not the announcement blog) say verbatim for ASI06's mitigations? This pass confirmed the ID, title, and one-line description directly, but the mitigation bullets are pieced together from secondary sources quoting the taxonomy.
2. ~~Is there a primary-source, quantified critique of LLM-as-judge scoring aimed specifically at memory/long-context benchmarks?~~ **Resolved in this pass**: Locomo-Plus (arXiv 2602.10715) targets LoCoMo's methodology directly (task-disclosure and string-matching-metric bias), and the Penfield Labs independent audit quantifies a 6.4% answer-key error rate and 62.81% false-acceptance rate for a GPT-4o-mini judge on LoCoMo specifically (§3.1) — though the latter is a non-peer-reviewed source, so treat its exact percentages as strong-but-unrefereed evidence, not a settled academic figure.
3. Does alambic's own `scanUnsafe` catch rate against adversarial (not accidental) payloads match or fall short of the unverified "detectors miss most poisoned entries" caution (§4.2)? No internal red-team measurement exists yet; implication 2 (§5) proposes building one.
4. What are ReasoningBank's and A-MEM's exact numeric results? Re-checked directly against both abstracts in this pass and confirmed both genuinely stop at qualitative superiority claims ("consistently outperforms," "superior improvement... across six foundation models") with no percentage given — the full papers' bodies/tables were not fetched and likely contain the numbers that would sharpen or weaken their entries in §2.1.
5. Has anyone published a memory-poisoning attack specifically against a **local, human-gated, quarantine-inbox** architecture like alambic's, as opposed to the always-write, no-human-gate systems AgentPoison/MINJA/MemGhost all assume? If alambic's core defense (a sha256-bound human accept receipt) already sits outside the threat model every reviewed attack targets, that is worth stating as a design strength rather than leaving implicit.
6. Would applying a Spotlighting-style datamarking/encoding transform (implication 3, §5) to note bodies conflict with Markdown/Obsidian legibility for the human reader who also uses the vault directly? Not resolved here — an implementation-level tension between the security gain and the "compiled Markdown wiki for humans and agents" framing in the README.
7. How independently reproducible are MemoryAgentBench's and VibeMemBench's own headline numbers — both are 2025/2026 single-paper results, and the companion study's Zep/Mem0 dispute (`getzep/zep-papers#5`) is a reminder that memory-benchmark claims in this literature have previously been publicly contested.

### 7. Sources

Security:
- https://arxiv.org/abs/2407.12784 — AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2503.03704 — MINJA: Memory Injection Attack on LLM Agents — accessed 2026-09-28 — confirmed
- https://arxiv.org/html/2403.14720 — Defending Against Indirect Prompt Injection Attacks With Spotlighting (Microsoft) — accessed 2026-09-28 — confirmed
- https://arxiv.org/html/2503.18813 — CaMeL: Defeating Prompt Injections by Design — accessed 2026-09-28 — confirmed
- https://arxiv.org/html/2506.08837 — Design Patterns for Securing LLM Agents against Prompt Injections — accessed 2026-09-28 — confirmed
- https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/ — When AI Remembers Too Much (Unit 42) — accessed 2026-09-28 — confirmed
- https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ — OWASP Top 10 for Agentic Applications — accessed 2026-09-28 — confirmed (ID/title/example); not verified (full mitigation bullets, verbatim)
- https://embracethered.com/blog/posts/2024/chatgpt-hacking-memories/ — ChatGPT: Hacking Memories with Prompt Injection — accessed 2026-09-28 — confirmed
- https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/ — Spyware Injection Into Your ChatGPT's Long-Term Memory (SpAIware) — accessed 2026-09-28 — confirmed
- https://embracethered.com/blog/posts/2026/breaking-opus-4.7-with-chatgpt/ — Breaking Opus 4.7 with ChatGPT (Hacking Claude's Memory) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2607.05189 — When Claws Remember but Do Not Tell: Stealthy Memory Injection in Persistent Personal Agents (MemGhost) — accessed 2026-09-28 — confirmed
- https://www.oasis.security/blog/claude-ai-prompt-injection-data-exfiltration-vulnerability — Claude.ai Prompt Injection / Data Exfiltration Vulnerability (Oasis Security) — accessed 2026-09-28 — confirmed
- https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code — Identifying and Remediating a Persistent Memory Compromise in Claude Code (Cisco, "MemoryTrap", 2026-04-01) — accessed 2026-09-28 — confirmed

Consolidation:
- https://arxiv.org/abs/2510.04618 — Agentic Context Engineering (ACE) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2509.25140 — ReasoningBank — accessed 2026-09-28 — confirmed (mechanism); not verified (exact numbers)
- https://arxiv.org/abs/2409.07429 — Agent Workflow Memory (AWM) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2502.12110 — A-MEM: Agentic Memory for LLM Agents — accessed 2026-09-28 — confirmed (mechanism); not verified (exact numbers)
- https://arxiv.org/abs/2504.13171 — Sleep-time Compute (Letta) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2504.07952 — Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory — accessed 2026-09-28 — confirmed
- https://arxiv.org/html/2308.10144v2 — ExpeL: LLM Agents Are Experiential Learners — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2303.11366 — Reflexion: Language Agents with Verbal Reinforcement Learning — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2305.16291 — Voyager: An Open-Ended Embodied Agent with Large Language Models — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2304.03442 — Generative Agents: Interactive Simulacra of Human Behavior — accessed 2026-09-28 — confirmed
- https://arxiv.org/html/2504.19413 — Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory — accessed 2026-09-28 — confirmed
- https://blog.getzep.com/beyond-static-knowledge-graphs/ — Beyond Static Graphs: Engineering Evolving Relationships (Graphiti/Zep) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2405.14831 — HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2502.14802 — From RAG to Memory: Non-Parametric Continual Learning for LLMs (HippoRAG 2) — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2604.12007 — When to Forget: A Memory Governance Primitive — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2604.20300 — FSFM: A Biologically-Inspired Framework for Selective Forgetting of Agent Memory — accessed 2026-09-28 — confirmed

Evaluation:
- https://arxiv.org/abs/2410.10813 — LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2402.17753 — LoCoMo: Evaluating Very Long-Term Conversational Memory — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2507.05257 — MemoryAgentBench — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2609.23570 — VibeMemBench: Evaluating Memory Systems for Coding Agents on Real Repository Coding Tasks — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2606.01629 — Benchmarking LLM-as-a-Judge for Long-Form Output Evaluation — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2506.22316 — Evaluating Scoring Bias in LLM-as-a-Judge — accessed 2026-09-28 — confirmed
- https://arxiv.org/abs/2602.10715 — Locomo-Plus: Beyond-Factual Cognitive Memory Evaluation Framework for LLM Agents — accessed 2026-09-28 — confirmed
- https://github.com/dial481/locomo-audit (via Penfield Labs Substack, 2026-04-08) — independent audit of LoCoMo's answer-key error rate and judge behavior — accessed 2026-09-28 — confirmed (as to what the audit claims; not peer-reviewed)

Companion study (not repeated here, cross-referenced only):
- Prior harness-landscape-memory-context study, §3.4/§3.6 — Mem0 LOCOMO table, Zep DMR 94.8%, `getzep/zep-papers#5` dispute — internal, already reviewed by this team
