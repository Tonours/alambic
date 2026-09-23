---
type: reference
status: verified
summary: "Canonical operating loop for capturing, distilling, linking, querying, validating, and refreshing an alambic vault."
created: 2026-08-19
updated: 2026-08-19
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

1. Capture into `docs/` or `docs/inbox/{manual,ai}/`.
2. Distill only durable, sourced knowledge into `kb/` after [[obsidian-hybrid-workflow]].
3. Link related notes with wikilinks.
4. Update `kb/_index.md`.
5. Keep project execution in its source repo; `ref/current-work.md` tracks this vault's work.
6. Query with `_meta/alambic query` or `_meta/alambic context`.
7. Run `_meta/validate-kb.sh` and `_meta/alambic lint --check` before claiming health.

## Roles

- Human: curates what matters and approves writes into `kb/`.
- Agent: searches, drafts, deduplicates, links, validates.
- Scripts: schema, secrets hygiene, duplicate basenames, unresolved wikilinks.

## Related

- [[llm-wiki-second-brain-architecture]]
- [[alambic-multi-harness-access]]
- [[shadow-apply-gate]]
