---
created: {{date}}
lane: manual
status: staging
tags:
  - inbox
---

# {{title}}

## Source

- url / session / repo:

## Notes brutes

-

## Candidat durable ?

- [ ] réutilisable entre sessions
- [ ] source inspectable
- [ ] pas déjà couvert dans `kb/`
- [ ] implication claire

## Promotion

If yes:

1. Prefer update of an existing `kb/` note.
2. Use template *durable-kb-note* only for genuinely new durable claims.
3. Set `promoted_from` to this inbox path when useful.
4. Set `reviewed_by` / `reviewed_at` if an agent drafted the durable text.
5. Update `kb/_index.md`, run `_meta/validate-kb.sh`, then archive/delete this draft.

If no: leave here, move under `docs/` as corpus, or delete.
