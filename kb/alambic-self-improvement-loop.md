---
type: finding
status: verified
summary: "Closed self-improvement loop for alambic: harness miss → inbox or shadow proposal → oracle or human review → promote/update durable note → executable check → aggregate feedback; never silent auto-apply."
created: 2026-09-23
updated: 2026-09-24
verified_at: 2026-09-24
confidence: high
sources:
  - "ref/shadow-apply-gate.md"
  - "kb/source-grounded-answer-quality.md"
  - "_meta/lib/nightly.mjs"
  - "_meta/lib/harvest.mjs"
  - "_meta/automation-contract.json"
  - "_meta/lib/promotion-judge.mjs"
  - "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
tags:
  - alambic
  - self-improvement
  - harness
  - agent-memory
  - automation
  - second-brain
aliases:
  - boucle self-improvement alambic
  - miss review promote check
  - amélioration continue second brain
claims:
  - "alambic self-improvement | loop | miss review promote check feedback | multi-harness"
  - "alambic self-improvement | apply default | disabled until numeric gate | shadow"
  - "alambic living loop | CI role | hygiene pulse not human receipts | apply gate"
---

# alambic self-improvement loop

## Behavior / Cause

Second brains die under maintenance, or rot when agents dump memory
append-only. What keeps them useful is lifecycle, supersession, forgetting and
measurement, not bigger dumps. The LLM-wiki pattern adds: the agent maintains
the wiki between sessions; the human curates sources and owns the gates.

## Closed loop (sidekick + harness)

```text
1. PULSE   — sidekick / CI: validate, graph, lint
2. JUDGE   — deterministic oracles (promotion-judge); no LLM required
3. APPLY   — structural heals + stale→successor + budgeted freeform promote
4. RECEIPT — oracle-labeled accept receipts for measurement
5. CAPTURE — inbox freeform auto-promotes only when freeform oracles pass;
              session drafts also need a human accept receipt
6. CHECK   — re-validate after apply; abort further applies if red
7. LEARN   — denser graph + promoted notes → better context/route next session
```

Optional Jev (TypeSafe) judgments only rerank or dedupe when
`TYPESAFE_API_KEY` is set; oracles stay deterministic without it.

## What “learning” is not

- Not auto-apply of conversation patches.
- Not embedding every chat into a vector store.
- Not mirroring ticket trackers into `kb/`.

## Layers

| Layer | Owner | What | Counts toward freeform distill gate? |
| --- | --- | --- | --- |
| Sidekick structural + freeform | `sidekick` / local `nightly` LaunchAgent | wikilinks, stale→successor, index, budgeted inbox promote | Oracle receipts yes |
| Hygiene pulse | CI / `loop --ci` | validate, lint, graph, pulse artifact | Health only |
| Eval feedback | optional | aggregate `feedback` counts | No |

- Arbitrary `distill --apply` stays off until the [[shadow-apply-gate]] unlock.
- `alambic nightly --push`, scheduled by `setup --schedule` on the machine that
  owns the vault, is the only kb writer; see
  [[adr-alambic-local-session-harvest]]. Other machines stay on dry-run.

## Agent checklist

1. `_meta/alambic context --max-tokens 2500 "…"`
2. On a miss: `feedback --status miss`, then stage a sourced inbox draft.
3. Let the nightly sidekick promote when oracles pass, or update an existing note
   yourself. Local `npm run sidekick` is dry-run only.
4. Never claim the wiki is healthy without doctor/lint green.

## Related

- [[alambic-multi-harness-access]]
- [[capture-quarantine-before-kb]]
- [[source-grounded-answer-quality]]
