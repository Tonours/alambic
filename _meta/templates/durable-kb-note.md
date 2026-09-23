---
type: finding
status: draft
summary: "One sentence describing the reusable knowledge."
sources:
  - "https://example.invalid/replace-me"
created: {{date}}
updated: {{date}}
# Required when any source is under docs/inbox/ and status becomes verified|accepted:
# promoted_from: docs/inbox/ai/your-proposal.md
# reviewed_by: human
# reviewed_at: {{date}}
tags:
  - topic
---

# Titre court

## Behavior / Cause

What is observed, why it happens, and why it is reusable.

## Practical Implication

How this should change a future decision or agent run.

## Related

- [[second-brain-operating-model]]
- [[obsidian-hybrid-workflow]]

<!--
Promotion rules:
1. Prefer updating an existing kb/ note over creating this file.
2. Replace the example source with an inspectable source before verify.
3. If promoted from docs/inbox/, set promoted_from + reviewed_by + reviewed_at.
4. Move or archive the inbox draft after promotion; do not leave a parallel durable claim.
5. Update kb/_index.md and run _meta/validate-kb.sh.
-->
