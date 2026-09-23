---
created: {{date}}
lane: ai
status: staging
proposed_by: agent
tags:
  - inbox
  - ai-proposal
---

# {{title}}

## Proposed durable claim

One sentence.

## Sources (required)

-
-

## Why durable

-

## Suggested target

- update existing: `kb/...` or new basename:
- type: finding | incident | adr | reference | synthesis

## Human review

- [ ] claim is true and not overfitted
- [ ] sources are inspectable
- [ ] no secret / raw transcript path
- [ ] no near-duplicate of existing note
- [ ] promote / edit / reject

## Decision

- verdict: promote | edit | reject
- reviewed_by:
- reviewed_at:
- promoted_to:
- archived_inbox_path:

<!--
If verdict is promote:
1. Write/update the durable note in kb/ or ref/ with full schema.
2. Copy sources; set promoted_from to this inbox path.
3. Set reviewed_by + reviewed_at on the durable note.
4. Update kb/_index.md when creating a new kb note.
5. Move this file to docs/inbox/ai/archive/ or delete after validate passes.
-->
