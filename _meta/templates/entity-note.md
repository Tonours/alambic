---
type: reference
status: draft
summary: "One sentence: who/what this entity is and why agents need it."
sources:
  - "https://example.invalid/replace-me"
created: {{date}}
updated: {{date}}
# Required when any source is under docs/inbox/ and status becomes verified|accepted:
# promoted_from: docs/inbox/ai/your-proposal.md
# reviewed_by: human
# reviewed_at: {{date}}
tags:
  - entity
---

# Entity name

## Identity

Who or what this is (person, project, system, account). One paragraph max.
Timeless facts only; dated observations go under Observations.

## Current state

Pinned current state, updated in place (profile, not history). Stamp volatile
claims: `value (as of {{date}})` or point at live truth instead.

## Relationships

How this entity links to others (owns, depends on, decides for). Prefer
wikilinks over prose lists.

## Observations

Dated notes, newest last. Each line starts with a date: `2026-09-04: ...`.

## Related

- [[second-brain-operating-model]]
- [[obsidian-hybrid-workflow]]

<!--
Promotion rules:
1. Prefer updating an existing entity note over creating this file.
2. Keep identity timeless; push every dated claim into Observations.
3. Replace the example source with an inspectable source before verify.
4. If promoted from docs/inbox/, set promoted_from + reviewed_by + reviewed_at.
5. Update kb/_index.md only for kb/ entities; ref/ entities link from home.
-->
