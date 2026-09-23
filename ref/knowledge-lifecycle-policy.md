---
type: reference
status: verified
summary: "review_after, stale, and supersession policy for alambic notes."
created: 2026-08-19
updated: 2026-09-23
sources:
  - "CLAUDE.md"
  - "ref/second-brain-operating-model.md"
tags:
  - second-brain
  - knowledge-lifecycle
---

# Knowledge lifecycle policy

| Family | Default review_after |
| --- | --- |
| security, mcp, trust | 90 days |
| harness, retrieval, second-brain | 120 days |
| product hypotheses | 180 days |

Status:

- `verified` / `accepted` → `stale` when a live check falsifies a claim, or `review_after` passed without re-verification.
- Replace a note by marking it `superseded`, naming `superseded_by`, and linking the
  successor in the body (example: [[rag-alone-is-enough-for-agent-memory]]).
- `draft` notes do not route.

Lint: orphans are warnings; conflicting active `claims` fail `lint --check` as review candidates. Tools never auto-edit.

## Related

- [[second-brain-operating-model]]
- [[source-grounded-answer-quality]]
