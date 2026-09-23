---
type: finding
status: verified
summary: "Sentence-window retrieval keeps short scored spans but re-expands surrounding context before answering so local relevance does not lose document coherence."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "https://arxiv.org/abs/2004.04906"
  - "https://arxiv.org/abs/2212.10496"
  - "kb/compiled-wiki-vs-rag-complement.md"
tags:
  - retrieval
  - rag
  - context-engineering
aliases:
  - fenêtre de phrases
  - conserver le contexte autour du passage
  - conserver le contexte autour du passage pertinent après découpage
  - sentence window retrieval
claims:
  - "sentence window retrieval | expands | surrounding context after scoring short spans | advanced rag"
---

# Sentence-window retrieval

Score short spans for relevance, then expand surrounding sentences (or the
parent heading block) before answering. Alambic `context` follows the same
idea: cite a heading and line range in the canonical Markdown instead of
returning an orphaned fragment.

French operational form: **conserver le contexte autour du passage pertinent
après découpage**.

## Related

- [[compiled-wiki-vs-rag-complement]]
- [[source-grounded-answer-quality]]
