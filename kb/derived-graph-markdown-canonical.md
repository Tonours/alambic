---
type: finding
status: verified
summary: "A derived knowledge graph may index relationships for retrieval, but Markdown files remain the canonical source of truth—never replace notes with opaque graph-only storage."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "kb/llm-wiki-second-brain-architecture.md"
  - "_meta/lib/graph-builder.mjs"
  - "https://www.inkandswitch.com/essay/local-first/"
tags:
  - second-brain
  - retrieval
  - knowledge-architecture
  - graph
aliases:
  - derived graph markdown source of truth
  - graphe dérivé markdown canonique
claims:
  - "knowledge graph | canonicity | markdown remains source of truth | alambic"
---

# Derived graph, Markdown canonical

A derived graph may index wikilinks, claims, and PageRank for retrieval. It
must not replace the Markdown files.

| Layer | Role |
| --- | --- |
| Canon | `kb/` + `ref/` Markdown + Git |
| Builder | `_meta/alambic graph` |
| Cache | `_meta/derived-graph.json` gitignored; rebuild with `graph --force` |
| Retrieve | lexical seed, then at most two graph neighbours in `context` |
| Lint | warnings, never auto-edits |

Query text must not be logged into graph distillers. Use aggregate
`feedback --status` only.

## Related

- [[llm-wiki-second-brain-architecture]]
- [[compiled-wiki-vs-rag-complement]]
