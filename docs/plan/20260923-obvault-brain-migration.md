# Implemented: migrate obvault and brain onto the alambic engine, multi-vault setup

## Meta
- Subject: alambic becomes the upstream engine of obvault (full engine) and brain (vendored light engine); `setup --name/--vault` installs one skill/MCP/shim per vault on this Mac and on macbook-work
- Type: migration
- Status: IMPLEMENTED
- Source plan: `PLAN.md`
- Source plan SHA-256: `a1a2cbae75a0597770a6c23ebb2b290913bf116ef7688c40e6ae613cd11d91a1`
- Source: user request "mettre a jour les projets obvault et brain avec alambic ... reporte ça egalement dans ssh macbook-work (brain + obvault) avec le setup des skills"; choices "Migrer le moteur", "Ajouter --name à setup"
- Last revised: 2026-09-23
- Archive: docs/plan/20260923-obvault-brain-migration.md

## Goal
Stop maintaining three diverging copies of the vault engine. alambic owns the
engine; obvault carries it verbatim, brain vendors the light subset from it,
and every harness on both machines reaches each vault through a named alambic
setup (`alambic-obvault`, `alambic-brain`) with isolated runtime state.

## Workflow Contract
- Router decision: plan-implement, high risk (multi-repo, two machines, user harness configs)
- Role: single writer (this session); reviewer (Logic, Spec) + adversary before each push
- Pattern: sequential slices, each ends green before the next
- Goal verifier: `npm test` green in alambic, obvault, brain; `alambic-<name> doctor` and `setup --status --name <name>` clean on both machines
- Operational budget: 6 slices, one repair loop per failing check, then stop and report
- Context reset threshold: after slice 2 if context is tight; PLAN.md Handoff State is the restart point
- Escalation: force-push, history rewrite, deleting remote data, or any change to repo visibility/secrets values → stop and ask
- Planner output: this file
- Challenger focus: backward compatibility of default `setup`, state isolation, harness-config consumers of `_meta/obvault`, remote divergence on brain
- Implementer boundaries: no edits to `ref/review-effectiveness-log.md` in the local brain checkout; brain work happens in a fresh clone; no secrets printed or committed; no code comments
- Verifier checks: see Validation Plan
- Reporter artifact: final French answer + archived plan
- Stop conditions: all AC checked, or a blocked step reported with evidence
- Required evidence: test output tails, setup status output, commit SHAs per repo

## Acceptance Criteria
- [x] alambic: `setup` with no `--name` produces byte-identical items/fingerprints to today (existing test fixtures unchanged)
- [x] alambic: `setup --name <slug>` installs `alambic-<slug>` skill dir, MCP entry, shim, manifest `setup-<slug>.json`; `--status`/`--uninstall` scoped to that name; `--prompt-hook` with `--name` is refused
- [x] alambic: `setup --vault <path>` (requires `--name`) wires engine = current checkout, content = `<path>` via `ALAMBIC_ROOT` in MCP env, shim and skill CLI
- [x] alambic: `ALAMBIC_STATE_DIR` overrides the state dir everywhere the engine writes state (CLI, loop-pulse, sidekick, promotion-judge, attention state, shell collectors); named setups pin `$XDG_STATE_HOME/alambic-<slug>`
- [x] alambic: `doctor` finds the manifest whose `vault` matches the current root (default or named)
- [x] alambic: leak-scan secret regex has a word boundary (regression test), init test accepts a gitignore superset, hook-gate hash lives in a freeze file refreshed by `eval:freeze`, prompt-hook test uses a measured quiet negative, `lib/probe-eval.mjs` shipped and used by `tests/eval.mjs`
- [x] obvault: engine = alambic `_meta` verbatim except vault data; `npm test` green; `_meta/obvault` compat shim keeps harness-config resolver and terminal plugin working
- [ ] brain: engine-sync pulls from alambic (`ALAMBIC_ENGINE_SOURCE`, lock `source: "alambic"`), `note.schema.json` vendored; `npm test` green — met except `note.schema.json` (see Decision Log)
- [x] this Mac: `alambic-obvault` and `alambic-brain` installed for detected harnesses, status clean, obvault state migrated, LaunchAgent env renamed and still loads
- [x] macbook-work: alambic cloned + `npm ci`, obvault/brain pulled (brain divergence resolved without force-push), both named setups installed, status clean, brain cron/consolidate scripts still run

## Problem
- Current behavior: obvault runs its own engine (`_meta/obvault.mjs`, `OBVAULT_*`), brain vendors a subset from obvault, alambic is a third copy; setup installs only one `alambic` skill/MCP/shim, and all vaults share `$XDG_STATE_HOME/alambic`.
- Expected behavior: one engine upstream (alambic), per-vault harness wiring and state.
- User impact: fixes land once; agents on both machines query obvault and brain through the same tooling without state cross-talk.

## Repos
- Owner: alambic (engine + setup)
- Satellite: obvault — engine swap, docs, workflows, repo variables
- Satellite: brain — engine-sync source switch
- Satellite: machine config (this Mac, macbook-work) — harness skills/MCP/shims, LaunchAgent, state dirs
- Not changed: harness-config (resolver keeps `_meta/obvault`; MCP templates point at brain's own light server)

## Scope
### In scope
- Slices 1-6 below.

### Out of scope / Non-goals
- Enabling the prompt hook on any vault (gate fails on obvault, see Facts).
- Renaming the obvault/brain repos or the harness-config `obvault-*` resolver/skill names.
- Merging brain onto the full engine.
- harness-config CLI topic-resolver routing to brain: it needs `<brain>/_meta/obvault`, present on origin but missing in the stale local checkout; unchanged by this plan (brain stays MCP/skill-reachable through `alambic-brain`).
- Rewriting obvault notes beyond engine path/name references.

## Facts And Assumptions
### Observed Facts
- `_meta/alambic.mjs:30` ROOT honors `ALAMBIC_ROOT`; `mcp/server.mjs:14` too.
- State dir hardcoded `…/alambic` in `alambic.mjs:39`, `lib/loop-pulse.mjs:18`, `lib/sidekick.mjs:26`, `lib/promotion-judge.mjs:290`, `lib/attention/state.mjs:14`, `bin/sidekick-autonomous.sh:32-74`, `youtube-weekly-collector.sh:58`, documented in `automation-contract.json:63`.
- `lib/setup.mjs`: names `alambic` hardcoded for skill dir, MCP key/CLI name, shim, manifest `alambic/setup.json`, skill-dir cleanup (`removeAction`), PATH warning.
- `harness/skill/SKILL.md` frontmatter `name: alambic` hardcoded.
- No `alambic` setup manifest on this Mac; no vault skill/MCP in `$CLAUDE_CONFIG_DIR`, `~/.agents/skills`, codex config.
- Prototype `/tmp/mig/ov-try` (obvault + alambic engine + fixes a-c) passes `npm test`; brain with `ALAMBIC_ENGINE_SOURCE=/tmp/mig/al` (alambic + probe-eval) passes `npm test`.
- obvault hook-gate on its own notes: 3 negatives fire, 1/12 positives missed → `max_negative_hits: 3` baseline, hook stays off.
- probes-v2 on obvault after re-freeze: hit@5 0.905, abstain 0.833.
- harness-config `workflow/runtime/obvault-topic-resolver.mjs:85` requires `<root>/_meta/obvault`; spawns with `OBVAULT_ROOT` (l. 265, 308). terminal plugin `harness-config-obvault/scripts/obvault.mjs:15` same.
- harness-config MCP templates point at `~/work/brain/_meta/mcp/server.mjs` with `OBVAULT_ROOT` (brain-local server, not vendored).
- A local LaunchAgent runs the vault attention script with `OBVAULT_ATTENTION_*` env.
- State: this Mac `~/.local/state/obvault` 5.1 MB, `~/.local/state/alambic` 16 KB (empty-ish scaffolding); macbook-work `~/.local/state/obvault` 116 KB.
- macbook-work brain: local commit 4f20c4f not on origin, origin has 53defb0 not local.
- obvault and brain repos are private; obvault secrets exist, no repo variables.

### Assumptions To Verify
- obvault's old state subdirectories match alambic's layout (same engine lineage) → verify by listing before the move.
- macbook-work brain worktree is clean apart from 4f20c4f → `git status` before rebase.
- macbook-work harness binaries (claude, codex, opencode, pi) on PATH in a non-interactive ssh shell → check `command -v`.

## Context Map
- Product areas: engine CLI, setup installer, eval/test harness, CI workflows
- Likely files: `_meta/lib/setup.mjs`, `_meta/harness/skill/SKILL.md`, `_meta/alambic.mjs`, `_meta/lib/{loop-pulse,sidekick,promotion-judge,attention/state,probe-eval}.mjs`, `_meta/bin/sidekick-autonomous.sh`, `_meta/youtube-weekly-collector.sh`, `_meta/tests/{setup,init,prompt-hook,eval}.mjs`, `_meta/tests/leak-scan.sh`, `_meta/bin/eval-freeze.mjs`, docs (`README.md`, setup docs)
- Existing docs / source of truth: alambic `README.md`, `_meta/automation-contract.json`
- Commands: `npm test`, `npm run eval:freeze`, `_meta/alambic setup …`, `_meta/engine-sync.sh` (brain)

## Requirement Trace
| Requirement / source | Observed state | Gap / ambiguity | Decision | Step / expected evidence |
| --- | --- | --- | --- | --- |
| Migrate engine (user choice) | 3 engines | obvault data vs engine files | recipe from ov-try, data regex kept | S3, obvault `npm test` |
| brain on alambic | engine-sync from obvault | brain keeps light CLI | switch source only, add note.schema | S4, brain `npm test` |
| `--name` (user choice) | single `alambic` handle | hook ownership is single | refuse hook with `--name` | S2, setup tests |
| brain via alambic engine | brain has no full engine | needs engine≠content | `--vault` + `ALAMBIC_ROOT` | S2, S5 status |
| no state cross-talk | shared `alambic` state | default must not move | `ALAMBIC_STATE_DIR`, named setups pin `alambic-<slug>` | S1/S2 tests, S5 |
| macbook-work parity | no alambic checkout | brain diverged | clone + rebase, normal push | S6 evidence |

## Approach
- Engine upstream fixes first (S1), then setup features (S2), then consumers.
- Default `setup` stays byte-identical; named setups are additive (handle `alambic-<slug>`).
- State: `ALAMBIC_STATE_DIR` wins over `$XDG_STATE_HOME/alambic`; named setups inject it into MCP env, shim, and skill CLI. obvault's `_meta/obvault` compat shim and LaunchAgent inject `alambic-obvault` too, so direct vault calls and harness calls share one state dir. obvault docs keep `_meta/obvault` as the vault-local entry point (it is the shim), which avoids a 20+ occurrence rename and keeps harness-config working.
- brain content is served by the alambic checkout (`--vault ~/work/brain`), brain's own light CLI/MCP stay for harness-config and cron.
- Rejected: state dir derived from vault basename (moves existing default users' state, generic names collide).

## Execution Slices
### Slice 1 — alambic engine upstream fixes
- Goal: land fixes a-d from the prototype plus `ALAMBIC_STATE_DIR`.
- Files: `_meta/tests/leak-scan.sh` (+ regression case), `_meta/tests/init.mjs`, `_meta/tests/prompt-hook.mjs`, `_meta/bin/eval-freeze.mjs` + freeze file field `hook_gate_sha256`, `_meta/lib/probe-eval.mjs` (+ `tests/eval.mjs` uses it, keeps `floor_sha256`), state helpers listed in Facts, `automation-contract.json`.
- Checks: `npm test` in alambic; new unit check that `ALAMBIC_STATE_DIR` redirects CLI state.
- Rollback point: alambic HEAD d858d42.

### Slice 2 — alambic `setup --name` / `--vault`
- Goal: named, engine-separated installs.
- Files: `_meta/lib/setup.mjs`, `_meta/harness/skill/SKILL.md` (`{{NAME}}`, `{{LABEL}}` placeholders rendering identically by default), `_meta/alambic.mjs` (doctor manifest lookup), `_meta/tests/setup.mjs`, README setup section.
- Doctor lookup: list `$XDG_STATE_HOME/alambic/setup.json` and `setup-*.json`, keep manifests whose `vault` equals the current root, aggregate their warnings; none match → today's behavior (default manifest).
- Rules: slug `^[a-z0-9][a-z0-9-]{0,30}$`; `--vault` needs `--name`, must be an existing dir with `kb/`; `--prompt-hook` + `--name` refused; manifest `alambic/setup-<slug>.json` storing `name`, `vault`, `engine`.
- Checks: `npm test`; default-fingerprint snapshot test; named install/status/uninstall round-trip in temp HOME; `--vault` MCP/shim/skill carry `ALAMBIC_ROOT` + `ALAMBIC_STATE_DIR`.
- Rollback point: end of S1 commit.
- Then: review (Logic, Spec) + adversary on S1+S2 diff, fix, commit(s), push alambic.

### Slice 3 — obvault engine swap
- Goal: apply the ov-try recipe to the real repo.
- Steps: pull obvault; `git rm` old engine/skills; copy alambic `_meta` tracked files except vault data regex; package.json + shrinkwrap; rename 2 kb notes + refs; workflow swap; `.gitignore`; `hook-gate.json` baseline; `_meta/obvault` compat shim (maps `OBVAULT_ROOT`→`ALAMBIC_ROOT`, defaults `ALAMBIC_STATE_DIR` to `alambic-obvault`); docs: old engine command names (`obvault.mjs`, `OBVAULT_*` env) updated; `npm run eval:freeze`; `npm test`.
- Machine: move `~/.local/state/obvault` → `~/.local/state/alambic-obvault` after layout check; LaunchAgent plist env → `ALAMBIC_*` + `ALAMBIC_STATE_DIR`, reload, `launchctl print` ok.
- Repo vars: `ALAMBIC_SIDEKICK_SCHEDULE=true`, `ALAMBIC_LEAK_OPTIONAL=true`.
- Checks: `npm test`; harness-config resolver smoke (`_meta/obvault query --json test`); review + adversary; commit; push.
- Rollback point: obvault origin HEAD before push.

### Slice 4 — brain engine source
- Goal: brain vendors from alambic.
- Steps: fresh clone to `/tmp/mig/brain-apply`; `engine-sync.sh` → `ALAMBIC_ENGINE_SOURCE` default `~/work/alambic`, lock `source: "alambic"`, message; add `_meta/note.schema.json` to FILES; run sync against pushed alambic; `npm test`; review; commit; push. Local `~/work/brain` is 42 commits behind and its uncommitted `ref/review-effectiveness-log.md` conflicts with origin (origin also edits it): do NOT pull, stash or touch it; `alambic-brain` points at `~/work/brain` anyway and the user syncs it.
- Rollback point: brain origin 53defb0.

### Slice 5 — this Mac setup
- Steps: `obvault/_meta/alambic setup --yes --name obvault`; `alambic/_meta/alambic setup --yes --name brain --vault ~/work/brain`; `--status` both; `alambic-obvault doctor`, `alambic-brain query --json …` smoke.
- Rollback: `setup --uninstall --yes --name <slug>`.

### Slice 6 — macbook-work
- Steps: check `git status` in brain/obvault/harness-config; clone `~/work/alambic` + `npm ci`; brain `pull --rebase` then push 4f20c4f; obvault pull + `npm ci`; move `~/.local/state/obvault` → `alambic-obvault`; back up `~/.claude.json` and `~/.codex/config.toml`; both named setups; remove old `brain`/`obvault` MCP entries only after the new ones are verified; run brain `cron-run.sh`/`consolidate-run.sh` dry path or their tests; doctor/status.
- Rollback: restore config backups, `setup --uninstall`.

## Validation Plan
- Automated: `npm test` in alambic, obvault, brain (clean clones); CI on push for alambic and obvault.
- Manual: setup status output both machines; resolver smoke; LaunchAgent loaded.
- Regression risks: default setup fingerprint drift (snapshot test), harness-config resolver (`_meta/obvault` shim), brain cron env, CI secrets/vars on obvault.
- Evidence for done: test tails, status outputs, SHAs.

## Progress Log
- 2026-09-23: recon + prototypes in `/tmp/mig` (ov-try green, brain-on-alambic green).
- 2026-09-23: Spec challenge: doctor lookup specified; local brain divergence recorded; READY.
- 2026-09-23: S1-S2 alambic f73229a..0a30787; S3 obvault 34cbca5, 09ae2d8 (CI green); S4 brain 50e282b; S5 both named setups installed, claude MCP connected.
- 2026-09-23: `alambic-brain query` crashed on the stale local brain: its v1 lexical cache lacked `raw`. Fix alambic 957ae88 (cache v2, stricter shape check, regression test), synced to obvault 5784f90 and brain 6d1e84b.
- 2026-09-23: S6 macbook-work: alambic cloned over https (ssh key not loaded non-interactively), brain rebased to 9c30eee and pushed, obvault 5784f90, state moved, configs backed up in `~/.local/state/cfg-bak-*`, both setups installed and connected, old `brain` MCP removed from claude and codex, doctor/status ok, cron scripts syntax-checked, LaunchAgents last exit 0.

## Decision Log
- 2026-09-23: obvault takes full engine verbatim; brain stays light via engine-sync.
- 2026-09-23: `ALAMBIC_STATE_DIR` override, default unchanged; named setups pin `alambic-<slug>`.
- 2026-09-23: `--prompt-hook` refused with `--name` (hook is single-owner, gate fails on vaults).
- 2026-09-23: obvault keeps `_meta/obvault` as its documented entry point (compat shim).
- 2026-09-23: `note.schema.json` dropped from brain's vendored FILES; brain notes predate its required tags.

## Handoff State
- Current state: DONE, all slices shipped.
- Last validated state: alambic 957ae88, obvault 5784f90, brain 9c30eee.
- Known failures: none.
- Next action: none.

## Risks
- Default setup regression for existing alambic users.
  - Impact: reinstall churn / collisions. Mitigation: snapshot test of default fingerprints.
- State move loses obvault history.
  - Impact: loop metrics reset. Mitigation: layout check, `mv` (reversible), no delete.
- brain remote divergence.
  - Impact: lost cron commit. Mitigation: rebase, no force-push; stop on conflict.
- User harness configs corrupted.
  - Impact: broken agents. Mitigation: setup's own backups + explicit backups on macbook-work before removing old entries.
- obvault CI red after swap (vars/secrets names).
  - Impact: noisy CI. Mitigation: set vars before push; `ALAMBIC_LEAK_OPTIONAL`.

## Open Questions
- None

## Ready Gate
- [x] Goal and acceptance criteria are concrete
- [x] Scope and non-goals are bounded
- [x] Observed facts are separated from assumptions
- [x] Steps/slices are executable in order
- [x] Checks are named and proportionate
- [x] Risks are identified or explicitly none
- [x] No blocking open questions remain
