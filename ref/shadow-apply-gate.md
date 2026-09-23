---
type: reference
status: verified
summary: "Automated distill --apply stays disabled; shadow proposals require a human review receipt."
created: 2026-08-19
updated: 2026-08-19
sources:
  - "CLAUDE.md"
  - "ref/second-brain-operating-model.md"
tags:
  - alambic
  - automation
  - shadow-gate
  - second-brain
aliases:
  - apply-auto disabled
---

# Shadow apply gate

All automatic writes into `kb/` are **off**.

- `alambic distill --apply` errors.
- `alambic review` records accept/reject receipts and never applies patches.
- MCP has no write tools.

To experiment later, keep the gate explicit in `ref/current-work.md` and do not
ship apply-on-by-default to other people.

## Related

- [[alambic-multi-harness-access]]
- [[capture-quarantine-before-kb]]
