# PLAN.md

## Meta
- Subject: `alambic setup`, a one-command user-level installer for coding agents
- Type: feature
- Status: DONE
- Source:
  - user request 2026-09-23 ("automatiser le setup au complet ... codex, claude, pi, opencode etc.. ... plug automatiquement sur tous ses prompts ... installation optin avec une case à sélectionner");
  - an external installer/hook pattern source;
  - installed runtime binaries and docs;
  - adversarial review by gpt-6-astra xhigh (verdict BLOCK, 15 findings), all folded in below.
- Last revised: 2026-09-23 (rev 4, obvault sync e519c60)
- Archive: pending until implemented and validated

## Goal
One command, `_meta/alambic setup` (also `npm run setup`), wires the vault into
every installed coding agent: Claude Code, Codex, Pi, opencode and Cursor. It
installs an `alambic` skill, optionally registers the MCP server and a CLI shim,
and offers an opt-in per-prompt context hook. An interactive checkbox picker
drives it, with a non-interactive flag mode for scripts. Every write is owned,
guarded against concurrent change, reversible (`--uninstall`) and visible in
`doctor`.

## Workflow Contract
- Router decision: `plan-loop`, then adversary pass (rev 2); implementation continues under `plan-implement` from this READY plan
- Role: planner + challenger now; implementer, verifier and reporter later
- Pattern: vertical slices, each landing with its own offline test; live runtime checks are bounded experiments with an observable oracle
- Goal verifier: `env -u TYPESAFE_API_KEY npm test` (includes `_meta/tests/setup.mjs`, `_meta/tests/prompt-hook.mjs` and `_meta/tests/hook-adapters.mjs`) plus the live smoke matrix
- Operational budget:
  - 6 slices;
  - live smoke: at most 3 attempts per runtime row, about 12 model calls in total, each a one-line prompt.
- Runtime hook outcome taxonomy (each hook row ends in exactly one state):
  - `verified`: the canary oracle passed.
  - `pending-trust`: the runtime requires a user trust step (Codex `/hooks`). Setup reports it; the smoke used the runtime's own bypass flag in an isolated home to verify injection.
  - `unsupported`: the runtime contract is absent or contradicts the plan. Requires binary/doc evidence, not just failed attempts.
  - `blocked-test`: the test could not run (auth or network). Reported with its cause. Not allowed as a final state for a runtime whose contract is otherwise untested; the plan stays open and the user is told what to run.
- Context reset threshold: after Slice 3
- Escalation: `blocked-test` on auth (the user must log in); nothing else expected
- Planner output: this file
- Challenger focus: ownership, config corruption, symlinks, concurrency, secret-bearing backups, egress, hook blocking, Node resolution
- Implementer boundaries:
  - may touch `_meta/**`, `package.json`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `_meta/harness/**`;
  - no new npm dependencies;
  - automated tests never execute real runtime binaries and never see real config dirs;
  - live smoke never runs `setup` against real configs.
- Verifier checks: see Validation Plan
- Reporter artifact: final answer plus archived plan under `docs/plan/`
- Stop conditions: all ACs checked with evidence and every smoke row `verified`, `pending-trust` (with bypass-verified injection) or `unsupported` (with contract evidence)
- Required evidence: green `npm test`, `validate`, `lint`, `leak-scan`; filled smoke matrix; real-config tripwire hashes unchanged

## Acceptance Criteria
- [x] AC1: picker. `_meta/alambic setup` with stdin and stdout both TTY shows a checkbox picker:
  - rows: one per harness (pre-checked when detected) and per component (skill, MCP, CLI shim, per-prompt context);
  - per-prompt context is unchecked by default;
  - keys: Space toggles, arrows move, `a` toggles all, Enter confirms, `q`, Ctrl-C and SIGINT abort without writing;
  - raw mode and echo are restored in `finally` and on signal.
- [x] AC2: action list. After confirmation, setup prints the action list (writes, merges, CLI calls, each with its status) and applies it. `--dry-run` writes nothing. If stdin or stdout is not a TTY and `--yes` is absent, setup behaves as `--dry-run`.
- [x] AC3: flag mode. `setup --yes [--harness claude,codex,pi,opencode,cursor|all|detected] [--prompt-hook] [--no-mcp] [--no-shim] [--json]` equals the picker result. `--yes` without `--harness` means `detected`.
- [x] AC3b: detection. A harness is `detected` when its binary (`claude`, `codex`, `pi`, `opencode`, `cursor-agent`) resolves on PATH or its config dir exists. All config paths honor `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and `XDG_*`.
- [x] AC4: skills. Each selected runtime gets exactly one discoverable `alambic` skill, with the absolute vault path baked in:
  - target set comes from the verified discovery matrix (Slice 2), with baseline `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/alambic/` for Claude and `~/.agents/skills/alambic/` for Codex, Pi, opencode and Cursor;
  - an existing `alambic` skill not owned by setup triggers a collision refusal, never a backup-and-replace.
- [x] AC5: MCP. The server is registered as `alambic` with an absolute Node path and `ALAMBIC_ROOT=<vault>`:
  - Claude: `claude mcp add -s user alambic -e ALAMBIC_ROOT=<vault> -- <node> <vault>/_meta/mcp/server.mjs` (name before the variadic `-e`);
  - Codex: `codex mcp add alambic --env ALAMBIC_ROOT=<vault> -- <node> …`;
  - opencode: strict-JSON merge of `mcp.alambic`;
  - Cursor: merge of `mcp.json`;
  - Pi: not offered.
  - Before any add, setup reads the current entry (`mcp get` or the config file). States: absent means `create`; equal to our fingerprint means `unchanged`; owned and changed means `update` (remove, then add); anything else is a `collision` and is refused. Codex `add` silently replaces, so this check is mandatory.
- [x] AC5b: CLI shim. `~/.local/bin/alambic`, a 0755 sh script running `exec '<node>' '<vault>/_meta/alambic.mjs' "$@"`. An existing file not owned by setup is a collision. Setup warns when `~/.local/bin` is not on PATH and never edits shell rc files.
- [x] AC6: prompt hook wiring (opt-in):
  - Claude: `settings.json` `hooks.UserPromptSubmit`;
  - Codex: `${CODEX_HOME:-~/.codex}/hooks.json` `UserPromptSubmit`, with no TOML edit. If `codex features list` reports hooks disabled, setup reports it and prints the instruction. Status `pending-trust` until the user approves in `/hooks`;
  - Pi: extension `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/alambic-context.ts`;
  - opencode: plugin `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/alambic-context.js` (XDG honoring checked in Slice 1, A7);
  - Cursor: `~/.cursor/hooks.json` `beforeSubmitPrompt`.
  - Commands use the absolute Node path from setup time and shell-quoted absolute paths.
  - Claude entries set `timeout: 5` (field observed in the user's settings.json); Codex and Cursor get the same field only if their schema accepts it (A8), else the script's own 3 s limit applies.
- [x] AC7: the hook never blocks a prompt:
  - the script only ever exits 0, catches every error, and self-limits to 3 s;
  - a crash or timeout lets the prompt continue in every runtime; exit 2 is never produced;
  - the in-process adapters (Pi, opencode) guard every callback and clear state on error;
  - injection happens only when the lexical gate passes (see AC15), capped at 1200 tokens, marked untrusted, with citations.
- [x] AC8: hook privacy:
  - the hook imports only `_meta/lib/vault.mjs` (and its lexical deps); a static import-graph test forbids `retrieval-cli.mjs`, `semantic-vault.mjs` and `typesafe-judge.mjs`;
  - a transport-call counter proves 0 provider calls with `TYPESAFE_API_KEY=dummy`, in match, abstain, cold-cache and warm-cache cases;
  - a canary prompt never appears in stderr, logs, caches or state files;
  - there is no semantic hook mode (non-goal); the hook stays lexical by construction.
- [x] AC9: config writes:
  - `lstat` first; a symlinked file is written atomically at its resolved real path, so the link is kept;
  - the preimage (sha256) is re-read right before each write; a mismatch aborts that action (`changed-during-setup`) and the rest continues;
  - foreign keys, hooks and entries are preserved; file mode is kept;
  - each touched file is backed up once per run to `<path>.bak.<timestamp>`, created exclusive (`wx`) with mode 0600 before any bytes;
  - JSONC or unknown formats trigger a refusal plus a printed snippet;
  - backups are never used to auto-restore a shared file.
- [x] AC10: idempotency. A second identical run reports `unchanged` for every item and changes no bytes.
- [x] AC11: manifest. `$XDG_STATE_HOME/alambic/setup.json` (0600) is a journal, updated after each successful action:
  - per-item fields: harness, kind, target, entry path (for merged keys), fingerprint of what setup wrote, and pre-state (`absent` or `existing-owned`);
  - it never stores foreign values;
  - a partial failure leaves the manifest listing exactly the actions that were applied;
  - `setup --status` reports installed, drifted, missing or collision per item.
- [x] AC12: uninstall. `setup --uninstall` removes an item only when its current value equals the recorded fingerprint:
  - files: hash match;
  - merged entries: entry-level match, neighbour keys untouched;
  - MCP: `mcp get` match, then `mcp remove`.
  - Drifted items are kept and reported. Foreign content stays byte-identical.
- [x] AC13: `doctor` adds a `setup` section: `not installed` counts as ok (info); drift, collision, pending-trust or a manifest pointing to another vault count as warnings.
- [x] AC14: offline tests cover every AC:
  - hermetic env built by allowlist (HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_DATA_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR all under a temp root; PATH is the stub dir plus the Node dir only);
  - stub `claude` and `codex` binaries record argv and fail on unexpected calls; stub `pi`, `opencode` and `cursor-agent` exist for detection only;
  - each test asserts every resolved target path lies under the temp root.
- [x] AC15: the hook gate is measured, not assumed:
  - a frozen labeled set of at least 8 positives (FR and EN paraphrases of starter notes) and at least 8 negatives (unrelated coding prompts) lives in `_meta/evals/hook-gate.json`;
  - the gate (lexical `contextPack` top result score and durable status, not `route` abstention alone) must inject on at least 6 of 8 positives and on 0 of 8 negatives;
  - warm p95 under 500 ms over 20 runs; cold-cache time measured and reported;
  - thresholds are measured on the post-sync engine (obvault `e519c60`); any later engine sync re-runs this eval.
- [x] AC16: docs:
  - README gains "Use from any project" (about 10 lines);
  - SECURITY gains the hook bullet (local, lexical by default, retention per runtime);
  - `_meta/harness/*` points to `setup`;
  - `_meta/harness/mcp.json` is removed.

## Problem
- Current behavior: wiring a project to the vault is manual. `_meta/harness/mcp.json` uses relative paths that break outside the vault. No skill is installed and no prompt hook exists.
- Expected behavior: one guided command, reversible and re-runnable after `git pull`.
- User impact: without it, agents in other repos never query the vault.

## Repos
- Owner: this repo (alambic)
- Satellite: none. The external workflow repo is only a pattern source.

## Scope
### In scope
- `setup` subcommand: picker, flags, dry-run, status, uninstall, manifest journal.
- Skill template, hook script, Pi extension and opencode plugin templates, JSON merge helpers.
- CLI-based MCP registration with ownership checks.
- `doctor` setup check, hook-gate eval set, tests, docs.

### Out of scope / Non-goals
- Multi-vault installs. One vault per user; a run from vault B sees vault-A entries as owned (same manifest) and re-points them, or as collisions if the manifest is absent.
- Editing global instruction files, `curl | sh`, npm publish, Windows, IDE extensions, other agents, project-level installs.
- Codex TOML edits (hooks are stable and on by default in 0.156.1) and writing Codex trust state.
- Any semantic (Jev) hook mode.
- Shell rc edits for the shim.

## Facts And Assumptions
### Observed Facts
- Versions: Claude Code 2.1.280, codex-cli 0.156.1, pi 0.87.0, opencode 1.18.32, cursor-agent 2026.09.10.
- Env on this machine: `CLAUDE_CONFIG_DIR=<custom config dir>` and `CODEX_HOME=<custom codex home>`. Pi honors `PI_CODING_AGENT_DIR` (`pi dist/config.js:421`). Changing HOME alone isolates nothing (adversary #1).
- Claude:
  - `UserPromptSubmit` stdout `hookSpecificOutput.additionalContext` is injected; exit 2 blocks the prompt;
  - `-e/--env` is variadic, so the name must precede it;
  - `mcp add` refuses an existing name ("already exists in user config");
  - with `CLAUDE_CONFIG_DIR` the global config lives in that dir;
  - `claude mcp get <name>` exists and health-checks the server.
- Codex:
  - `hooks.json` uses the same shape as Claude and embeds a `UserPromptSubmit` `additionalContext` schema;
  - `codex features list` gives `hooks stable true` by default;
  - new hooks are ignored until trusted in `/hooks`, and `--dangerously-bypass-hook-trust` exists;
  - `mcp add` replaces an existing entry (`servers.insert`, `codex-rs/cli/src/mcp_cmd.rs` at rust-v0.156.1);
  - `codex mcp get <name>` exists.
- Cursor: `beforeSubmitPrompt` stdin has `prompt` and the response field is `additional_context` (`cursor-agent index.js:414`); exit 2 blocks.
- Pi:
  - `before_agent_start` gets `prompt` and may return `message`;
  - custom messages become model `user` messages and are persisted (`dist/core/messages.js:89`, `agent-session.js:583`);
  - the `context` event (`types.d.ts:521`) can rewrite `messages` before each LLM call;
  - skills are read from `~/.pi/agent/skills` and `~/.agents/skills`; extensions from `~/.pi/agent/extensions/*.ts`.
- opencode:
  - `chat.message` fires before the message is saved, with the prompt in `output.parts`;
  - `experimental.chat.system.transform` gets `{sessionID, model}` and a mutable `{system: string[]}` on each model call; one agent-generation call has no `sessionID`;
  - `Plugin.trigger` does not catch callback rejections;
  - skills are read from `~/.config/opencode/skill(s)`, `~/.claude/skills` and `~/.agents/skills`, de-duplicated by name with a warning;
  - `opencode mcp add` is interactive.
- Claude reads user skills from a custom `CLAUDE_CONFIG_DIR`: this session loads skills from `<custom config dir>/skills/`.
- Claude `settings.json` hook entries accept `timeout` (seconds); observed in the user's settings.
- Repo: `validate` allows new `_meta/` subdirs (only top-level dirs are allowlisted); `init` ships the git-listed set, so new tracked files ship automatically; nothing references `_meta/harness/mcp.json`; `docs/plan/` exists; `stateDir()` (`alambic.mjs:39`) gives `$XDG_STATE_HOME/alambic`, reused for the manifest (without `ensureState`, which creates unrelated cursors); `atomicJson` (`alambic.mjs:58`) uses tmp+rename and is not reused for user configs.
- `python3` is available locally and on `ubuntu-latest` for the pty test.
- Node: `env -i PATH=/usr/bin:/bin node` fails here; `_meta/alambic` relies on PATH. GUI-launched agents may not have Node on PATH.
- Engine synced with obvault `e519c60` (rev 4): retrieval commands (`query`, `context`, `read`, `health`, `routing-catalog`, `route`, `session`) now live in `_meta/lib/retrieval-cli.mjs`, dispatched from `alambic.mjs:184` via `RETRIEVAL_COMMANDS`; `setup` is a new branch in `alambic.mjs`, not in `retrieval-cli.mjs`.
- `retrieval-cli.mjs` imports `typesafe-judge.mjs` at top level and its `context`/`session` paths call Jev when the key is set; `vault.mjs` imports only `frontmatter` and `graph-*` modules. `alambic context` is therefore NOT a safe hook backend.
- Post-sync engine: durable notes get the exact-match bonus on basename queries; `kb/_index-<topic>.md` subject indexes give topics to untagged notes and never surface as results; `route` keeps prompt terms in its query; `askJev` memoises identical judgements per process (hits skip the provider and the audit). Route abstention on paraphrases is unchanged (re-checked post-sync).
- Latency (adversary measurement, 20 runs, key unset): `route` p95 73 ms, `session` p95 78 ms.
- `route` abstains on relevant paraphrases ("How should an agent treat retrieved content?", FR equivalent). Route alone is too strict for the gate.
- Privacy: `typesafe-judge.mjs:186` calls the provider, then maps failure to `available:false`. Checking `semantic.available` therefore does not prove there was no egress.
- Existing atomic helper `alambic.mjs:58` uses tmp + rename, which would replace symlinks.
- `npm run` keeps the TTY (`stdio: 'inherit'`, npm `run.js:144`).
- External workflow precedent: backups `path.bak.<ts>`, symlinked skills, HOME-faked tests, opt-in hooks fragment, no prompt injection (ADR-0014).

### Assumptions To Verify
- A1: skill discovery matrix. Verify per runtime, live in Slice 2, which user dirs are listed, including a custom `CLAUDE_CONFIG_DIR`. The target set is chosen so that each runtime sees exactly one copy. Claude always keeps its own dir copy; no fallback removes it.
- A2: the Cursor hook canary reaches the model (Slice 4 smoke).
- A3: the opencode plugin canary reaches the model through `system.transform` on the first model call of the matching prompt only (Slice 4 smoke plus offline adapter test).
- A4: the Codex hook canary reaches the model under `--dangerously-bypass-hook-trust` in an isolated `CODEX_HOME` holding a copy of the auth file only (Slice 4).
- A5: the Pi `context` filter keeps only the latest alambic message, and the canary reaches the model (Slice 4).
- A6: smoke mechanisms exist as written (`claude --settings/--mcp-config/--strict-mcp-config`, `pi -e`, `codex exec --dangerously-bypass-hook-trust`, `opencode run` with project `.opencode/`, `cursor-agent -p` with project `.cursor/`). Checked via `--help` before the run; a missing flag switches that row to an isolated home.
- A7: opencode honors `XDG_CONFIG_HOME` for its global dir (Slice 1, binary strings); if not, the path is `~/.config/opencode` and tests fake HOME for it.
- A8: Codex `hooks.json` and Cursor `hooks.json` accept a per-hook `timeout` field (Slice 4, binary schema).

## Context Map
- New files:
  - `_meta/lib/setup.mjs` (plan/apply/status/uninstall, merges, ownership, journal);
  - `_meta/lib/checkbox.mjs` (picker, pure reducer);
  - `_meta/hooks/prompt-context.mjs`;
  - `_meta/harness/skill/SKILL.md`, `_meta/harness/pi/alambic-context.ts`, `_meta/harness/opencode/alambic-context.js`;
  - `_meta/evals/hook-gate.json`;
  - tests `setup.mjs`, `prompt-hook.mjs`, `hook-adapters.mjs`, `checkbox-pty.py`.
- Edited files: `_meta/alambic.mjs` (`setup` branch, doctor; retrieval commands stay in `_meta/lib/retrieval-cli.mjs`), `package.json`, `_meta/tests/run.sh`, docs.
- Base for the skill body: `_meta/skills/alambic-dev-workflow.md`.

## Requirement Trace
| Requirement / source | Observed state | Gap / ambiguity | Decision | Step / expected evidence |
| --- | --- | --- | --- | --- |
| One command installs everything | Manual | No installer | `setup` + `npm run setup` | S1-S5 |
| codex, claude, pi, opencode, "etc." | Contracts verified (Facts) | "etc." open-ended | Five installed runtimes; others are a non-goal | S2-S4 |
| Checkbox opt-in | No readline, no deps | TTY edge cases | Raw-mode picker, restore in `finally`/signal, pty test via python3 `pty` | S1 (AC1) |
| Auto-plug on every prompt | Contracts per runtime; ADR-0014 precedent | Noise, blocking, retention | Opt-in, measured gate, only exit 0, adapters guarded, Pi retention filter, opencode per-session state | S3-S4 (AC6-8, AC15) |
| Hook egress (adv #11) | Provider failure hidden as `available:false` | Old test could pass after egress | Lexical-only imports + transport counter + canary scan | S3 (AC8) |
| Ownership (adv #2) | Name/marker only | Uninstall could delete user entries | Entry fingerprints, collision refusal, match-before-remove | S2, S5 (AC4, AC5, AC11, AC12) |
| Symlinked configs (adv #3) | tmp+rename replaces links | Dotfiles break | `lstat` + write at realpath | S2 (AC9) |
| Concurrency and partial install (adv #4) | Plan/apply split | Lost writes, orphan state | Preimage re-check, per-action journal | S2 (AC9, AC11) |
| Backup secrecy (adv #5) | `~/.claude.json` is 0644 | Readable backups | `wx` 0600 backups | S2 (AC9) |
| MCP argv/idempotency (adv #6) | Claude refuses dupes, Codex replaces | Wrong argv, silent replace | Fixed argv, `mcp get` pre-check, state machine | S2 (AC5) |
| Node path and blocking (adv #7) | Node missing from minimal PATH | Silent failure in GUI apps | Absolute `process.execPath`, validated, quoted; only exit 0 | S2-S4 (AC5-7) |
| Codex TOML (adv #8) | Hooks on by default | Needless risk | TOML edit dropped; `pending-trust` state | S4 (AC6) |
| opencode state (adv #9) | Multiple model calls, no catch | Cross-session leaks, crashes | Per-session+message state, cleared on abstain/error, no `sessionID` means no-op | S4 (AC7, adapters test) |
| Pi retention (adv #10) | Custom messages persist | Context accumulates | `context` filter keeps the latest block only; persistence documented | S4 (AC7, AC16) |
| Smoke closure (adv #12) | 2 fails meant unsupported | False closure | 4-state taxonomy, canary oracle, auth prerequisites | S4 |
| Skill dupes (adv #13) | opencode de-dupes by name | Wrong fallback | Verified discovery matrix; Claude copy kept | S2 (AC4, A1) |
| Gate usefulness (adv #15) | Route abstains on paraphrases | Useless feature | Frozen labeled gate set with thresholds | S3 (AC15) |
| Env-aware paths, detection, shim (rev 3) | Custom config dirs on this machine; shim unspecified | Wrong targets, ambiguous shim | AC3b env-honoring detection; AC5b shim file in `~/.local/bin`, no rc edits | S1-S2 (AC3b, AC5b) |
| Test isolation (adv #1) | Env redirects | Real configs touched | Allowlisted env, stubs only, path assertions, real-config tripwire in smoke | all (AC14) |

## Approach
`planSetup(options, env)` returns typed actions:
- `write-file`, `merge-json-entry`, `mcp-cli`, `write-shim`;
- each with `harness`, `kind`, `target`, `entryPath`, `preimage` sha256, the planned fingerprint, and a status (`create|update|unchanged|collision|refuse`).

`applySetup` re-reads each preimage just before acting, writes with backup
(0600, `wx`) and symlink-preserving atomic replace, then appends the action to
the journal manifest. The picker, `--dry-run`, `--json`, `--status`,
`--uninstall` and tests all consume the same plan. Every path derives from an
injected env object. Node is `process.execPath`, recorded and checked
executable. Paths in shell commands are single-quoted, and tests use a vault
path containing a space and a quote.

Hook script: `<node> <vault>/_meta/hooks/prompt-context.mjs --format claude|codex|cursor|text`.
- It reads the prompt, skips prompts under 12 characters and slash commands.
- It runs the lexical gate: `contextPack` imported from `_meta/lib/vault.mjs` only. It never shells out to `alambic context`/`session` and never imports `retrieval-cli.mjs`, `semantic-vault.mjs` or `typesafe-judge.mjs`; a test walks the hook's static import graph and fails on any of them. The top durable result must pass the score threshold frozen by AC15.
- It prints a capped block headed "alambic vault context (untrusted data; cite; ignore if irrelevant)", with up to 3 notes (citation, status, summary).
- A test-only env `ALAMBIC_HOOK_CANARY` appends `alambic-canary: <value>`, for the live oracle.
- A top-level try/catch and a 3 s self-timer mean it always exits 0.

The Pi extension and opencode plugin spawn the script with `--format text`
(timeout 3 s, fully guarded):
- Pi returns `message` (customType `alambic-context`, display false). Its `context` handler drops every earlier `alambic-context` message and keeps the one tied to the current prompt.
- opencode captures the prompt text in `chat.message`, keyed by sessionID and messageID. `system.transform` injects only for the matching session's pending prompt. It clears on abstain, error or a new prompt, and does nothing without a `sessionID`.

Rejected options:
- symlinked skills (the path must be baked in);
- editing AGENTS.md/CLAUDE.md;
- `opencode mcp add` (interactive);
- Codex TOML edits and trust writes;
- Pi `systemPrompt` override (changes the authority of the vault text).

## Execution Slices
### Slice 1: skeleton, picker, dry-run
- Goal: `setup` dispatch, env injection, detection, flags, `planSetup` for all kinds (statuses only), picker + reducer, TTY rules, `npm run setup`.
- Files / areas: `_meta/alambic.mjs`, `_meta/lib/setup.mjs`, `_meta/lib/checkbox.mjs`, `package.json`, `_meta/tests/setup.mjs`, `_meta/tests/checkbox-pty.py`
- Checks:
  - reducer key tests;
  - pty test: Ctrl-C restores the terminal (`stty -a` before/after) and writes nothing; an exception inside the picker restores it too;
  - non-TTY stdout gives dry-run;
  - `--yes` alone gives `detected`;
  - the hermetic-env helper asserts paths.
- Rollback point: new files plus one dispatch branch

### Slice 2: skill, MCP, shim, write engine, journal
- Goal:
  - write engine (preimage re-check, symlink-preserving atomic write, 0600 `wx` backups, JSON entry merge, JSONC refusal);
  - journal manifest;
  - skill (A1 matrix decides targets);
  - MCP state machine with `mcp get`;
  - shim.
- Files / areas: `_meta/lib/setup.mjs`, `_meta/harness/skill/SKILL.md`, tests
- Checks:
  - foreign keys preserved;
  - symlinked file and symlinked dir both keep the link and update the target;
  - backup mode 0600 when the source was 0644;
  - a concurrent write between plan and apply gives `changed-during-setup` and preserves the foreign write;
  - if the second action fails, the journal lists only the first;
  - Claude stub argv has the name before `-e`;
  - Codex existing foreign entry gives `collision` and no add call;
  - owned changed entry gives remove then add;
  - collision on a foreign `alambic` skill;
  - canary secret in foreign config never appears in stdout, the manifest or error text;
  - second run is all `unchanged`.
- Rollback point: Slice 1

### Slice 3: hook script, gate eval, privacy
- Goal: `_meta/hooks/prompt-context.mjs`, lexical gate with a frozen threshold, `_meta/evals/hook-gate.json`, formats, caps, exit-0 guarantee.
- Files / areas: `_meta/hooks/prompt-context.mjs`, `_meta/evals/hook-gate.json`, `_meta/tests/prompt-hook.mjs`
- Checks:
  - gate hits at least 6 of 8 positives and 0 of 8 negatives;
  - every format emits valid JSON with a citation, under the cap;
  - garbage stdin, a thrown error and a forced slow path all give exit 0 and empty output within 3.2 s;
  - transport counter stays at 0 with a dummy key across match/abstain × cold/warm cache;
  - canary prompt absent from stderr and the files written under the temp root;
  - warm p95 under 500 ms; cold time reported.
- Rollback point: Slice 2

### Slice 4: hook wiring, adapters, live smoke
- Goal: Claude/Codex/Cursor hook merges; Pi extension and opencode plugin templates; offline adapter tests; live smoke matrix.
- Files / areas: `_meta/lib/setup.mjs`, `_meta/harness/pi/alambic-context.ts`, `_meta/harness/opencode/alambic-context.js`, `_meta/tests/hook-adapters.mjs`
- Checks:
  - hook entries merged beside foreign hooks and idempotent;
  - no Codex TOML write;
  - Codex `pending-trust` reported;
  - adapters test (fake events): Pi keeps only the latest block across 3 prompts including one abstention;
  - opencode handles two interleaved sessions, two model calls for one prompt (inject on the call tied to the pending prompt, no leak to the other session), clears on abstain, does nothing without a `sessionID`, and survives a spawn throw;
  - live matrix below.
- Rollback point: Slice 3

### Slice 5: status, uninstall, doctor
- Goal: `--status`, fingerprint-matched `--uninstall`, doctor section.
- Files / areas: `_meta/lib/setup.mjs`, `_meta/alambic.mjs`, tests
- Checks:
  - install, then the user edits a neighbour key and one managed entry, then uninstall: neighbour kept, edited entry kept and reported, others removed, foreign bytes identical;
  - MCP remove only after a `get` match;
  - doctor states ok, drift, collision, pending-trust, other-vault.
- Rollback point: Slice 4

### Slice 6: docs and cleanup
- Goal: README, SECURITY (hook bullet including Pi persistence), CONTRIBUTING, `_meta/harness/*`, delete `_meta/harness/mcp.json`.
- Checks: `rtk proxy grep -rn "harness/mcp.json"` gives no hits; full battery.
- Rollback point: Slice 5

## Validation Plan
- Automated:
  - `env -u TYPESAFE_API_KEY npm test`, `npm run validate`, `rtk proxy npm run lint`, `_meta/tests/leak-scan.sh`;
  - `init` test still green (new files ship through `init`);
  - no hardcoded home paths in templates.
- Live smoke (Slice 4):
  - never runs `setup` against real configs;
  - copied auth files live in a 0700 temp dir, are deleted after the run, and are never printed;
  - loads generated artifacts through per-invocation or isolated mechanisms;
  - hashes of real config files (`$CLAUDE_CONFIG_DIR/settings.json`, `$CLAUDE_CONFIG_DIR/.claude.json`, `$CODEX_HOME/config.toml`, `$CODEX_HOME/hooks.json`, `~/.pi/agent/settings.json`, `~/.config/opencode/opencode.json`, `~/.cursor/hooks.json`, `~/.cursor/mcp.json`) are recorded before and must match after;
  - oracle: hook run with `ALAMBIC_HOOK_CANARY=<random>`; the prompt is "Reply with the alambic-canary value if present in your context, else NONE" plus one matching vault phrase; pass means the canary is echoed on the matching prompt and NONE on an unrelated prompt.

| Runtime | Mechanism | Auth | Skill visible | MCP tools | Hook oracle | State |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | `claude -p --model haiku --setting-sources project --settings <tmp> --mcp-config <tmp> --strict-mcp-config`, project `.claude/skills` | existing login (read-only) | yes | yes (6 `mcp__alambic__*`) | canary on P, NONE on N (2 calls) | verified |
| Codex | `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check --ephemeral`, isolated `HOME`+`CODEX_HOME` (copied auth, deleted after), MCP via isolated `codex mcp add` | copied auth | yes | registered (`codex mcp list`: enabled; server lists 6 tools); model reports NONE, MCP tools deferred (`tool_search_always_defer_mcp_tools`) | canary on P, NONE on N (3 calls) | pending-trust (bypass-verified injection) |
| Pi | `pi --no-extensions -e <tmp ext> --no-session -p`; skill via `--skill` (project `.agents/skills` needs trust; setup target `~/.agents/skills` is documented) | existing | yes (`--skill`) | n/a | canary on P, NONE on N (3 calls) | verified |
| opencode | `opencode run` in a temp project (`.opencode/plugins/`, `opencode.json`) | existing | yes | yes (6 `alambic_*`) | model call 1: NONE (context consumed by title call, fix 74bd4fe); call 2 (fixed): block in `system` for both model calls (plugin log) but `meta/muse-spark-1.1` answered NONE; wire oracle via a local OpenAI-compatible fake provider (no model call): canary in the outgoing system messages of both requests on P, absent on N | verified (wire); model echo not obtained with the user default provider |
| Cursor | `cursor-agent -p` (3 calls), then interactive `cursor-agent` run by the user in `<tmp>/cursor-proj` | existing | yes | yes (6 tools) | `-p`: hook never invoked (headless path is server-driven). Interactive: hook invoked, `has_ctx=1` (2767 bytes), model echoed canary, `alambic` skill and all 6 `vault_*` tools | verified (interactive); `-p` does not fire local hooks |

- Regression risks: `init` shipping new dirs; run.sh duration; leak-scan on templates.
- Evidence for done: all ACs checked; matrix complete per the taxonomy; tripwire hashes equal; battery green.

## Progress Log
- 2026-09-23: research done (3 scouts plus binary/doc checks); rev 1 READY.
- 2026-09-23: adversary (gpt-6-astra xhigh) returned BLOCK with 15 findings; all dispositioned in rev 2; READY.
- 2026-09-23: rev 4 after syncing obvault `e519c60` into alambic (retrieval-cli split, basename exact match, subject indexes, Jev memo): line refs updated, hook import boundary made explicit, gate measured post-sync; READY.
- 2026-09-23: rev 3 readiness check against code: env-aware paths, detection rule, shim spec, semantic hook mode dropped, hook timeout field, A6-A8 added; READY.

## Progress Log (implementation)
- 2026-09-23: slices 1-6 committed (756fb0d, 6ebcf2f, 06a66ad, 74bd4fe, f412d50); battery green (test, validate, lint, leak-scan).
- 2026-09-23: 12b `simplify: removed 6` (7f5ce5f); 12c quality: done against sibling modules.
- 2026-09-23: logic review BLOCK (2 fixed in 6ab336d, 1 rejected: AC13 warnings); spec review all ACs done, 4 low/medium findings fixed in bfedd23.
- 2026-09-23: cross-model adversary (codex gpt-6-astra xhigh, frozen at 7f5ce5f): 8 findings plus 3 from the wrapping agent. Fixed in 6927e03, each mutation-checked: F1 identical preexisting entry recorded `preexisting`, left on uninstall; F3 file replaced by a symlink is kept; F4 codex settings edited after add (enabled, tool lists, timeouts, cwd, env_vars) count as drift; F5 failed MCP update re-adds the previous entry; F7 template renderer no longer expands `$&`/`$'`; hook ignores stdout EPIPE. Rejected: F8 (interactive Cursor run proved `additional_context` reaches the model); F2 (ms window between re-check and rename, no lock exists against foreign writers; plan-to-apply race covered); F6 (sync work cannot be pre-empted; every harness entry now carries `timeout: 5`); backups beside a symlinked dotfile (AC9 fixes `<path>.bak.<ts>`, external workflow precedent); doctor spawning `codex mcp get` (read-only, bounded by the CLI timeout).
- 2026-09-23: comment cleanup at the user's request: comments and docstrings removed from the feature code, including the "Managed by" header of generated files.
- 2026-09-23: live smoke run: 14 model calls plus zero-cost wire checks; tripwire: every config the smoke could touch is unchanged; `~/.claude.json` and `~/.claude/settings.json` changed from an unrelated Claude session (another project, default config dir), no `alambic` key in either.

## Decision Log
- 2026-09-23 (impl): Cursor `blocked-test` cleared by an interactive run from the user: `beforeSubmitPrompt` fired, context reached the model. Headless `cursor-agent -p` never runs local hooks; documented as a limitation, not a defect.
- 2026-09-23 (impl, spec review): A8 holds for Cursor too (cursor-agent bundle reads a per-hook `timeout` in seconds; `failClosed` defaults to false). The `beforeSubmitPrompt` entry now carries `timeout: 5` like Claude/Codex (bfedd23).
- 2026-09-23 (impl, spec review): AC14 test PATH is `<stub dir>:/usr/bin:/bin`, wider than "stub dir plus Node dir": `/bin/sh` is needed to run the rendered hook command and shim. Real runtimes still never resolve (stubs shadow them, no user bin dirs on PATH).
- 2026-09-23 (impl, logic review): `setup --status` without `--harness` now re-renders recorded items and flags `outdated` like doctor, pending-trust included (6ab336d). Doctor exit code stays 0 on setup warnings (AC13 defines them as warnings).
- 2026-09-23 (impl): A3 falsified by the smoke: opencode runs two `system.transform` calls per prompt (title, then main), so first-call-only lost the context. The plugin now injects on every model call of the turn; the next prompt replaces or clears it (74bd4fe, adapter test updated).
- 2026-09-23 (impl): the gate uses `contextPack` (lexical) as planned; frozen set is 12 positives / 12 negatives (not 8/8), measured 11/12 and 0/12, cold ~42 ms, warm p95 ~42 ms.
- 2026-09-23: prompt hook is opt-in, off by default, lexical-only by construction (external workflow precedent, privacy).
- 2026-09-23: skills are copied with an absolute path; targets come from the verified discovery matrix; collisions are refused, never replaced.
- 2026-09-23: MCP via official CLIs (Claude, Codex) behind a `get` pre-check; JSON entry merge for Cursor and strict-JSON opencode; no Pi MCP.
- 2026-09-23 (rev 2): drop the Codex TOML edit (hooks on by default; trust stays the user's); add the `pending-trust` state.
- 2026-09-23 (rev 2): ownership is per entry via fingerprint; uninstall is match-before-remove; backups never auto-restore.
- 2026-09-23 (rev 2): symlinked configs are written at their realpath; preimage re-checked before each write; journal manifest.
- 2026-09-23 (rev 2): absolute Node path everywhere; the hook only exits 0; adapters guarded.
- 2026-09-23 (rev 2): the gate uses a lexical `contextPack` score with a frozen labeled set, since `route` alone is too strict.
- 2026-09-23 (rev 4): the hook imports `vault.mjs` directly; `retrieval-cli.mjs` is off-limits because it loads the TypeSafe module.
- 2026-09-23 (rev 3): no semantic hook mode (contradicted the lexical-by-construction privacy guarantee); shim is a file in `~/.local/bin`, no rc edits.
- 2026-09-23 (rev 2): smoke outcomes use the 4-state taxonomy with a canary oracle; failed attempts alone never justify `unsupported`.

## Handoff State
- Current state: done. Slices 1-6, reviews and adversary fixes committed locally (see `git log`). Nothing pushed.
- Last validated state: after the comment cleanup, battery green (npm test, validate, lint exit 0, leak-scan).
- Known failures: none. Limitations: headless `cursor-agent -p` never runs local hooks; Codex MCP tools are deferred so models do not list them unprompted; Codex hook trust detection is heuristic; recorded Node path goes `outdated` after a Node upgrade (rerun setup).
- Next action: push when the user says so.

## Risks
- Risk: config corruption or lost concurrent writes.
  - Impact: high.
  - Mitigation: preimage re-check, symlink-aware atomic writes, entry-level merges, refusal on unknown formats, tests.
- Risk: secret exposure through backups or output.
  - Impact: high.
  - Mitigation: 0600 `wx` backups, never echo foreign values, canary tests.
- Risk: deleting user-owned entries.
  - Impact: high.
  - Mitigation: fingerprints, collision refusal, match-before-remove.
- Risk: the hook blocks or slows prompts.
  - Impact: medium.
  - Mitigation: exit-0-only, 3 s self-limit, guarded adapters, p95 check.
- Risk: noise or prompt injection from vault content.
  - Impact: medium.
  - Mitigation: measured gate, 0/8 negatives, untrusted header, cap, Pi retention filter.
- Risk: runtime contract drift.
  - Impact: medium.
  - Mitigation: versions recorded in the matrix; `doctor` warns; per-runtime degradation to skill-only.
- Risk: auth unavailable for the live smoke.
  - Impact: low.
  - Mitigation: `blocked-test` keeps the plan open with an explicit user action.

## Open Questions
- None blocking. Defaults: prompt hook off, MCP on, shim on, skill on, detected harnesses pre-checked.

## Ready Gate
- [x] Goal and acceptance criteria are concrete
- [x] Scope and non-goals are bounded
- [x] Observed facts are separated from assumptions
- [x] Steps/slices are executable in order
- [x] Checks are named and proportionate
- [x] Risks are identified or explicitly none
- [x] No blocking open questions remain

## Notes / Handoff
- Skills used: none (no domain suite matches); plan-loop contract; adversary pass via `codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh -s read-only`; full review kept at `/tmp/alambic-adv-review.md`.
- `PLAN.md` is gitignored here; it stays local until archived to `docs/plan/`.
