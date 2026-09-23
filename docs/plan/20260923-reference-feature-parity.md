# PLAN.md

## Meta
- Subject: alambic feature parity with the private reference vault (Jev, sidekick, loop, attention, enrich) without private data
- Status: DONE
- Last revised: 2026-09-23
- Archive: docs/plan/20260923-reference-feature-parity.md (sanitized: reference vault name redacted)

## Goal

alambic (open-source engine, public-bound) exposes the same CLI, MCP, eval and
CI feature set as the private reference vault HEAD (`36c06da`), including Jev
(TypeSafe) semantic judgments, while shipping zero private data: no private
notes, corpus, personal eval queries, identities, hosts or machine paths.

## Workflow Contract
- Route: `plan-implement`
- Pattern: planner-builder-evaluator
- Role: planner → implementer → verifier → reporter (reviewers/adversary via fresh subagents)
- Tier: high-risk (multi-surface port + publication leak boundary)
- Goal verifier: parity script (CLI command set, eval suite set, lib module set, npm scripts) + `npm test` + leak scan with local private patterns
- Operational budget: one port pass + at most 3 fix iterations per red check; no-progress stop per contract
- Context reset: `PLAN.md` + `.workflow/reference-feature-parity/events.jsonl`
- Escalation: stop `blocked` if Jev parity requires private data or a provider contract change
- Stop condition: all Checks green, review + code-diff adversary GO, plan archived, root `PLAN.md` removed; nothing committed or pushed
- Required evidence: command outputs listed in Checks, parity diff empty (except documented exclusions), leak scan clean, reviewer + adversary verdicts

## Acceptance Criteria
- AC1: every reference-vault CLI command (`attention`, `sidekick`, `status`, `loop`, `enrich`, `session --l0/--attention`, `query --explain`, `feedback`, all others) exists in `_meta/alambic` with the same behavior; alambic keeps `init`.
- AC2: `_meta/lib/**` module set equals the reference set (typesafe-judge, semantic-vault, enrich, sidekick, promotion-judge, loop-pulse, attention/**); Jev runs whenever `TYPESAFE_API_KEY` is set and degrades to lexical otherwise, same thresholds.
- AC3: MCP exposes the same 6 tools (4 read + `vault_capture`, `vault_feedback`).
- AC4: every reference eval suite runs in alambic (`retrieval`, `retrieval-semantic`, `typesafe-semantic`, `attention-ranking`, `attention-compile`, `probes-v2`, `tuning`, `capability`, `regression`, plus existing ones) against alambic-owned data written for the starter wiki; `npm test` runs the same suite list as the reference `run.sh`.
- AC5: CI parity: hygiene workflow with loop pulse; sidekick daily writer workflow shipped with its schedule gated behind a repository variable (manual dispatch always available). Personal review-dispatch workflow is not shipped.
- AC6: no private marker anywhere in the tracked tree: leak scan with the local private pattern file returns clean; the public leak-scan script itself contains no personal identifiers.
- AC7: `alambic init <dir>` scaffold passes `npm test` in the new directory.
- AC8: docs (README, CLAUDE.md, AGENTS.md, skills, harness snippets) describe the new features generically, including the Jev egress boundary.

## Repos
- Owner: alambic (this repo)
- Satellite: reference vault — read-only source; not modified

## Scope
### In
- Port all reference `_meta/`, `.github/`, `package.json` tooling changes since fork base `594627d` plus files alambic dropped (attention, sidekick, loop, promotion-judge, bench, collectors).
- Rename `reference`→`alambic` in code, env vars (`REFERENCE_*`→`ALAMBIC_*`), XDG state dir, workflow/skill names.
- Author alambic eval datasets for the starter wiki; recompute freezes and the probes-v2 floor from alambic's own measured baseline.
- New starter notes required by code/tests: `ref/critical-facts.md` (L0 template), `ref/technical-attention-intake.md`, `kb/alambic-self-improvement-loop.md`; update `kb/_index.md`.
- Leak-scan hardening (identity patterns from gitignored `.leak-patterns` or `ALAMBIC_LEAK_PATTERNS`).

### Out
- Migrating the reference vault to consume alambic as upstream (touches its live CI writer; separate plan).
- Commit, push, publishing the repo, creating GitHub variables/secrets.
- Private artifacts: reference `kb/` (239 notes), `docs/`, `ideas/`, `enrich-ledger.json` state, personal eval sets, `rtk-commands.md`, deprecated `cron-prompt.md`, `review-dispatch.yml`, personal YouTube channel list.

## Facts And Assumptions
### Observed Facts
- alambic = reference fork at `594627d` (2026-08-21) with renames; its own deltas: `init`, harness snippets, leak-scan, LICENSE/SECURITY/CONTRIBUTING, starter notes, anchors in `_meta/lib/graph-router.mjs:5-9`, schema `$id` urns, portable path regexes (`_meta/lib/vault.mjs:21`, `_meta/validate-kb.sh:87`).
- Reference drift since base: `_meta/lib/vault.mjs` 589 changed lines, `_meta/reference.mjs` 144, `mcp/server.mjs` 65, `note.schema.json` 69, `tests/eval.mjs` 138; 17 files added (typesafe, enrich, semantic-vault, bench, l0-fresh, probes-v2…).
- Runtime code pins notes: L0 `ref/critical-facts.md` (`vault.mjs:1046`), router anchor `ref/technical-attention-intake.md`, compile links `[[technical-attention-intake]]`, tests require `kb/*-self-improvement-loop.md`.
- Eval datasets reference ~170 private notes and personal queries → not portable; `typesafe-semantic.json`, `attention-ranking.json` are synthetic.
- Private markers inside reference tooling: private schema `$id` host, owner home path in validate regex, Obsidian excludes naming private corpus folders, a retailer canary in attention fixtures, an owner-name comment in `vault.mjs`, sidekick tests asserting absence of owner paths, personal terms/domains in attention policy.
- Both repos: `npm test` green today. `TYPESAFE_API_KEY` is present locally (live smoke possible).

### Assumptions
- Setting `TYPESAFE_API_KEY` is the explicit opt-in for Jev egress; identical code behavior to reference is acceptable for OSS once documented (verifiable: README egress section).
- Starter-wiki eval sets can meet reference thresholds on 9–12 notes (verifiable by running suites; if a threshold is unreachable, the floor is the measured alambic baseline recorded in the freeze, never a weakened reference gate).

## Requirement Trace
| Requirement / source | Observed state | Gap / ambiguity | Decision | Step / expected evidence |
| --- | --- | --- | --- | --- |
| "iso niveau feature (jev)" | Jev absent in alambic | port typesafe-judge, semantic-vault, enrich, sidekick dedupe | in-scope | S2–S4; parity script, typesafe tests |
| No private data (OSS) | alambic leak-scan contains identities | public script leaks what it hunts | in-scope correction | S8; leak scan w/ local patterns |
| Eval parity | datasets private | need alambic datasets | in-scope; author new | S6; suites green |
| Sidekick CI writer in a template | reference cron commits daily | unsafe default for adopters | gate schedule behind repo var | S7; workflow review |
| Reference consumes alambic | not requested explicitly now | touches live writer | justified non-goal | Notes / Handoff |
| Attention personal config | channel list, blocked domains | personal taste | ship generic example | S4 |

## Steps
1. Ledger: activate `.workflow/reference-feature-parity/`; record route/plan events.
2. Port (scratch script outside repo): for files present in base and alambic, `git merge-file alambic base' head'` (`'` = renamed); for reference-only files copy renamed; `_meta/reference.mjs`→`_meta/alambic.mjs` from HEAD renamed, then re-apply `init`/`copyScaffold`/usage.
3. Resolve merge conflicts keeping alambic deltas (portable regexes, urn ids, anchors, starter thresholds, python3 JSON checks in `run.sh` instead of reference `jq` to avoid an extra dependency).
4. Scrub: schema ids → `urn:alambic:*`; Obsidian excludes → generic (`docs/inbox/ai/**` etc.); attention policy personal terms/domains → generic; `youtube-knowledge-sources.tsv` → header + example rows; drop `rtk-commands.md` ref; comments with personal names/paths; tests asserting personal paths rewritten generically; `manifest-integrity` keeps alambic version.
5. Starter notes: `ref/critical-facts.md`, `ref/technical-attention-intake.md`, `kb/alambic-self-improvement-loop.md`, `_index.md`, `ref/home.md` links as needed.
6. Evals: author `retrieval-semantic.tsv`, `attention-compile.tsv`, `probes-v2.jsonl` (+freeze), `held-out.jsonl` (≥48 cases, ≥20 adversarial; +freeze), `capability.jsonl`, `regression.jsonl`; set probes-v2 floor from alambic baseline measured with key unset (deterministic lexical).
7. CI: `ci.yml` gains loop pulse step; add `alambic-sidekick-daily.yml` from reference HEAD final shape (top-level `permissions: contents: read`, write token only on the push step, laptop default dry-run per `automation-contract.json`), schedule gated `vars.ALAMBIC_SIDEKICK_SCHEDULE == 'true'`; no `pull_request_target` anywhere; YouTube OAuth secrets renamed `ALAMBIC_*` and optional.
8. Leak-scan: generic public patterns + private patterns from `.leak-patterns` (gitignored) / `ALAMBIC_LEAK_PATTERNS`; create local `.leak-patterns` (not tracked). Whole-tree scan (incl. `_meta/evals/*`, state files, fixtures) stays; drop public patterns that collide with shipped feature names (`chrome-history-`, `x-bookmarks-` match attention connectors).
9. `package.json`: scripts parity (+`init` bin kept), dep `@typesafe-ai/sdk@0.6.0`; `npm install` updates lockfile.
10. Docs: README, CLAUDE.md, AGENTS.md, `_meta/skills/*`, harness snippets.
11. Validate (Checks), simplify 12b, quality 12c, review, code-diff adversary, archive, delete `PLAN.md`.

## Checks
- command: `env -u TYPESAFE_API_KEY npm test`
  - expected: `alambic tests: ok`
  - last run: not run
- command: `npm run validate && npm run lint`
  - expected: exit 0
  - last run: not run
- command: `ALAMBIC_LEAK_PATTERNS_FILE=.leak-patterns _meta/tests/leak-scan.sh`
  - expected: `leak-scan: ok` with private patterns loaded (count > 0 reported)
  - last run: not run
- command: parity script `/tmp/alambic-parity.sh` (CLI commands from usage/dispatch, eval suites, lib module list, npm scripts, MCP tool names: reference vs alambic after rename)
  - expected: only documented exclusions differ
  - last run: not run
- command: `npm run test:typesafe:live` (key present)
  - expected: provider smoke ok, or reported degraded reason
  - last run: not run
- command: `_meta/alambic eval --suite tuning` / `capability` / `regression`
  - expected: exit 0
  - last run: not run
- command: `_meta/alambic init /tmp/alambic-init-check && (cd /tmp/alambic-init-check && ln -s <repo>/node_modules && env -u TYPESAFE_API_KEY npm test)`
  - expected: `alambic tests: ok`
  - last run: not run
- command: `git grep -nIiE '<private markers>'` over tracked + untracked files
  - expected: no hits outside `.leak-patterns` (untracked, gitignored)
  - last run: not run

## Risks
- Private marker slips through via ported comment/fixture → mitigated by pattern scan over whole tree incl. untracked files.
- 3-way merge silently keeps a reference-only personal line → scrub list + scan.
- Starter-wiki evals too easy to be meaningful → accepted; thresholds kept at reference values, datasets include paraphrase FR/EN, multi-hop, abstention.
- Sidekick workflow in adopters' repos writes to main → schedule gated off by default.
- Jev egress to non-ZDR provider → documented; only with user-provided key.
- Reference eval fixtures leak the private note inventory by filename (e.g. `probes-v2.jsonl` expected paths) → never copied; port script DROP list excludes every personal eval file; re-authored against starter notes.
- `typesafe-live.mjs` throws without key → stays out of `run.sh` (separate `test:typesafe:live` script), as in reference.

## Decision Log
- 2026-09-23: Jev behavior kept identical (key presence = opt-in) instead of a new flag — iso with reference, no divergent code path.
- 2026-09-23: keep 9 starter notes as demo + eval substrate (user did not choose; reversible).
- 2026-09-23: reference migration to upstream model deferred (out of scope).

- 2026-09-23: plan adversary (same-family Sonnet fallback; no cross-model runtime exposed) — accepted: sidekick workflow least-privilege shape, leak-scan collision/coverage, eval filename leak (already in scope), typesafe-live gating (already reference behavior); rejected: none. Adversary did not read PLAN.md by design.

## Open Questions
- None blocking.

## Notes / Handoff
- Skills used: none (no domain suite matches).
- Nothing is committed or pushed; work stays on branch `feat/reference-feature-parity`.

## Outcome (2026-09-23)
- Parity: CLI, npm scripts, eval suites, run.sh suites, lib/bin/prompts/skills/templates/mcp files and MCP tools match the reference (alambic-only extras: `init`, `leak-scan.sh`).
- Checks green: keyless `npm test`, validate (21 notes strict), lint, leak-scan, tuning/capability/regression, `test:typesafe:live`; probes-v2 hit@5 0.714 lexical floor, 0.905 with Jev.
- Reviews: Logic / Spec / adversary all GO WITH NOTES; accepted findings fixed (attention.mjs wired, init fallback inbox skeleton + empty-listing guard, leak-scan fail-loud/output-based/file:line-only/CI warning, sidekick leak-scan before push, home-path boundary).
- Caveat: held-out and probe sets were authored against the starter wiki before freezing; they guard regressions, not generalization.
