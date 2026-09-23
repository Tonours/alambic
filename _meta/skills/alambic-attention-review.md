---
name: alambic-attention-review
description: Morning review of technical attention intake: status, digest or synthesis, promote suggestions. Never writes `kb/`.
---

# Review morning attention (alambic)

Use when the user asks to review yesterday's or today's attention capture, morning
knowledge inbox, YouTube/X/Chrome digests, or prepare session context from
attention.

## Hard rules

1. Never print secrets, tokens, cookies, Keychain values, or `.env`.
2. Never write durable `kb/` or `ref/` unless the user explicitly confirms a
   promote after human review. `apply-auto` is disabled.
3. Prefer update-before-create against `kb/_index.md`.
4. Do not dump encrypted candidate ciphertext or full Chrome URL lists into chat.

## Steps

```sh
cd "${ALAMBIC_ROOT:-.}"   # repo root
./_meta/alambic attention status --json
./_meta/alambic attention env-check --json   # presence only
./_meta/alambic session --attention --json --max-tokens 2500
./_meta/alambic attention compile --dry-run --json   # if re-check needed
./_meta/alambic attention promote-suggest --json     # suggestions only
```

1. Open `docs/inbox/ai/attention-synthesis-YYYYMMDD.md`, or the digest when
   there is no synthesis.
2. List at most 7 claims and drop the noise. For each keeper, note whether it
   updates an existing note or needs a new one.
3. Attention is a reading queue. Write each durable, sourced claim to
   `docs/inbox/manual/` so it goes through the normal gate; don't materialize
   drafts.
4. Human files durable notes into `kb/` with full frontmatter + sources.
5. Log feedback: `_meta/alambic feedback --status hit|miss|stale|wrong` if useful.

## Done when

- Session pack `within_budget` is true (≤2500 tokens).
- User has a short prioritized list of claims (or explicit no-op empty day).
- No kb write without explicit human intent.
