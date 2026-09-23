---
type: reference
status: verified
summary: "Evidence-gated scorecard for alambic quality; claim scores only from local commands."
created: 2026-08-19
updated: 2026-08-19
sources:
  - "ref/current-work.md"
  - "kb/alambic-multi-harness-access.md"
tags:
  - second-brain
  - scorecard
  - alambic
---

# Second-brain scorecard

Rate only with local evidence (`npm test`, `validate`, `lint`). Marketing stars do not count.

| Dimension | How to prove |
| --- | --- |
| Schema | `npm run validate` |
| Lint | `npm run lint` |
| Retrieval | `npm test` (starter wiki hit/abstain) |
| Apply-auto | remains DISABLED ([[shadow-apply-gate]]) |
| Secrets | `_meta/tests/leak-scan.sh` |

Overall score is the **minimum** dimension, not the average.

## Related

- [[alambic-multi-harness-access]]
- [[shadow-apply-gate]]
