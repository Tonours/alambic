---
type: finding
status: verified
summary: "Web clips and AI proposals belong in staging until promotion criteria and validation pass."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "ref/obsidian-hybrid-workflow.md"
  - "CLAUDE.md"
tags:
  - second-brain
  - capture
  - knowledge-promotion
aliases:
  - quarantaine avant kb
  - staging capture obligatoire
  - quarantine captures in inbox
claims:
  - "capture | promotion path | quarantine inbox before kb | hybrid workflow"
---

# Capture quarantine before kb

Clips, agent drafts, and unreviewed imports belong in `docs/inbox/{manual,ai}/`.
They are not durable knowledge until a human promotion gate runs:

1. The claim is reusable across sessions.
2. Sources are inspectable.
3. No near-duplicate already exists in `kb/`.
4. Frontmatter is complete; inbox-sourced verified notes have `reviewed_by` and `reviewed_at`.
5. `_meta/validate-kb.sh` still passes.

Never paste secrets, tokens, or raw agent transcripts into `kb/`.

## Related

- [[obsidian-hybrid-workflow]]
- [[llm-wiki-second-brain-architecture]]
- [[source-grounded-answer-quality]]
