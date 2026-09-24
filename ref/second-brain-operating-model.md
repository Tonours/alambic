---
type: reference
status: verified
summary: "Canonical operating loop for capturing, distilling, linking, querying, validating, and refreshing an alambic vault."
created: 2026-08-19
updated: 2026-09-24
sources:
  - "CLAUDE.md"
  - "kb/llm-wiki-second-brain-architecture.md"
tags:
  - second-brain
  - operating-model
  - hybrid
---

# Second Brain Operating Model

## Loop

1. Capture into `docs/` or `docs/inbox/{manual,ai}/`. Session harvest adds
   gitignored `harvest-*.md` drafts when a distiller is available.
2. Review session drafts with `review --inbox` in an interactive terminal.
   Agents never run it. Nothing session-derived reaches `kb/` before this.
3. Distill only durable, sourced knowledge into `kb/` after [[obsidian-hybrid-workflow]].
4. Link related notes with wikilinks.
5. Update `kb/_index.md`.
6. Keep project execution in its source repo; `ref/current-work.md` tracks this vault's work.
7. Query with `_meta/alambic query` or `_meta/alambic context`, then record `feedback`.
8. Let the nightly run heal and promote. Run `_meta/validate-kb.sh` and
   `_meta/alambic lint --check` before claiming health.

## Roles

- Human: curates what matters and approves writes into `kb/`.
- Agent: searches, drafts, deduplicates, links, validates.
- Scripts: schema, secrets hygiene, duplicate basenames, unresolved wikilinks.

## Related

- [[llm-wiki-second-brain-architecture]]
- [[alambic-multi-harness-access]]
- [[shadow-apply-gate]]
