---
type: finding
status: verified
summary: "Compiled wikis accumulate synthesis; RAG rediscovers fragments. Production memory systems usually need both."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
  - "https://arxiv.org/abs/2005.11401"
  - "kb/llm-wiki-second-brain-architecture.md"
tags:
  - second-brain
  - rag
  - compiled-wiki
aliases:
  - wiki compilé et RAG complémentaires
  - rag is not dead complement compiled wiki
claims:
  - "memory systems | architecture | compiled wiki plus rag | production memory"
---

# Compiled wiki vs RAG complement

Compiled wikis accumulate synthesis. RAG rediscovers fragments from a corpus.
A local second brain should compile durable claims into `kb/` and keep raw
evidence in `docs/` for long-tail lookup.

Do not treat a larger context window as a substitute for compiling notes.
Do not treat naive RAG as a substitute for an indexed, sourced wiki.

## Related

- [[llm-wiki-second-brain-architecture]]
- [[source-grounded-answer-quality]]
- [[sentence-window-retrieval-pattern]]
