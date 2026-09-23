---
type: adr
status: accepted
summary: "Use Markdown and Git as the canonical second-brain layer, with docs as evidence, kb as compiled knowledge, and ref as operating entrypoints."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
  - "https://www.inkandswitch.com/essay/local-first/"
  - "CLAUDE.md"
tags:
  - second-brain
  - llm-wiki
  - knowledge-architecture
aliases:
  - wiki compilé local
  - compiled wiki architecture
  - strict second brain architecture
claims:
  - "alambic | canonical layers | docs corpus kb compiled ref entrypoints | local second brain"
  - "alambic | write authority | human promotion gate before durable kb | default"
---

# LLM Wiki Second-Brain Architecture

## Decision

Use alambic as a strict local LLM-wiki:

- `docs/` is the source layer.
- `kb/` is the compiled wiki layer.
- `ref/` is the operational entrypoint layer.
- `CLAUDE.md` and `AGENTS.md` are the schema and agent contract.
- `_meta/validate-kb.sh` is the first mechanical health check.

## Rationale

The useful pattern is not a raw retrieval dump. The agent should compile
reusable knowledge once, then maintain links, summaries, contradictions, and
indexes over time. Exact, metadata, backlink, lexical, and optional semantic
retrieval remain complementary access paths.

Obsidian is the human-facing IDE over the Markdown corpus. The files, Git
history, schema, and validator remain authoritative.

## Rejected options

- Cloud-first memory products: rejected for the first slice because they need
  account and token handling.
- Deep taxonomy: rejected in favor of flat notes and clear wikilinks.
- Raw transcript import: rejected because it weakens trust and risks secrets.

## Related

- [[compiled-wiki-vs-rag-complement]]
- [[capture-quarantine-before-kb]]
- [[second-brain-operating-model]]
