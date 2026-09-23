---
type: reference
status: verified
summary: "Privacy-first local shadow intake turns explicit technical account signals into a short review queue without automatically writing the vault."
sources:
  - "_meta/technical-attention-policy.json"
  - "_meta/lib/attention/pipeline.mjs"
  - "_meta/lib/attention/stage.mjs"
  - "_meta/lib/attention/compile.mjs"
  - "_meta/skills/alambic-attention-review.md"
  - "_meta/lib/attention/credentials.mjs"
  - "_meta/lib/attention/connectors/manual-browser.mjs"
  - "_meta/lib/attention/providers/youtube-oauth.mjs"
  - "_meta/lib/attention/providers/x-oauth.mjs"
  - "https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup"
  - "_meta/lib/attention/state.mjs"
  - "_meta/bin/attention-daily-grok.sh"
  - "_meta/prompts/attention-daily-grok.md"
  - "_meta/tests/attention.mjs"
  - ".github/workflows/alambic-sidekick-daily.yml"
  - "_meta/automation-contract.json"
  - "https://developers.google.com/youtube/v3/docs/videos/list"
  - "https://developers.reddit.com/docs/capabilities/server/reddit-api"
  - "https://docs.x.com/x-api/posts/bookmarks/introduction"
created: 2026-09-23
updated: 2026-09-23
tags:
  - attention
  - capture
  - privacy
  - technical-sources
  - grok-orchestrator
---

# Technical Attention Intake

`_meta/alambic attention` is a local *shadow* queue for deliberate technical
signals: YouTube likes, Reddit saved/upvoted items, X bookmarks, and an optional
Chrome-history source. It is deliberately narrower than browser surveillance:
there is no Android app, accessibility capture, cookie/session scraping,
clipboard capture, Google-activity scraping, or automatic promotion to the
vault.

## Safety contract

- All sources are disabled by default. Without an explicitly provisioned
  credential/key boundary, collection reports `blocked-auth`; Chrome reports
  multi-device foreign originators (local sync cache_guid excluded) once crypto keys exist.
- Provider responses, page tokens, upstream IDs, account IDs, cookies,
  credentials, full history, and rejected text stay only in process memory.
- A deterministic local policy filters before persistence. Ambiguous,
  shopping, sensitive-query, secret-pattern, and prompt-injection inputs are
  discarded. A retail shopping candidate is a required negative canary.
- The only accepted persistence is an encrypted, seven-day candidate under
  `$XDG_STATE_HOME/alambic/attention/`, plus content-free HMAC replay digests,
  aggregate metrics, capabilities, and immutable review receipts.
- State refuses paths inside this repository, an `ALAMBIC_OBSIDIAN_ROOT`, or
  configured `ALAMBIC_SYNCTHING_ROOTS`; directory/file modes are `0700`/`0600`
  and receipts are `0400`.
- `attention review` records only a content-free decision receipt. It cannot
  write durable `kb/` or `ref/` notes.
- `attention stage` may write a **draft** promote-candidate batch under
  `docs/inbox/ai/` (gitignored digests). It never writes `kb/` or `ref/`.
- `attention promote --confirm` stages a single draft under `docs/inbox/ai/`
  only; elevating into durable `kb/` remains a separate human workflow.
  apply-auto stays DISABLED.

## Provider status

| Source | Fixture status | Live status | Gate |
| --- | --- | --- | --- |
| YouTube liked | `fixture-green` | `scheduled-ready` | OAuth read-only; technical filter uses **title + snippet description** (not channel name alone). CI collect when YouTube secrets set; else local `_meta/bin/attention-daily-grok.sh` or `attention collect`. |
| Reddit saved | `fixture-green` | `manual-browser-ready` | Use only visible, accessible Saved cards through the forced-dry-run ingest path; API OAuth remains separately blocked. |
| Reddit upvoted | `fixture-green` | `blocked-auth` | Explicit human OAuth checkpoint and a read-only dry probe. |
| X bookmarks | `fixture-green` | **API-ready when `ALAMBIC_X_*` set**; else manual/drop | Official X API v2 `GET /2/users/:id/bookmarks` (OAuth 2.0 user-context, scopes `bookmark.read` `tweet.read` `users.read`). Env: `ALAMBIC_X_CLIENT_ID` + `ALAMBIC_X_REFRESH_TOKEN` (optional secret / static access token). Crypto keys still required. Drop-folder NDJSON remains as supplement. |
| Chrome history | `fixture-green` | **multi-device live** when local sync `cache_guid` resolves and foreign originators exist | Local SQLite History copy; only visits with `originator_cache_guid` ≠ this machine’s sync cache_guid. Not Android-labelled — multi-device foreign only. Crypto keys `ALAMBIC_ATTENTION_CHROME_HISTORY_{DATA,HMAC}_KEY`. |

Fixture success proves the sanitizer, storage, pagination boundary, and review
workflow. It does **not** by itself prove a provider is live or authorize
consent, credentials, provider-app creation, token storage, revocation, or
scheduling. The YouTube row is the narrow exception: its separate OAuth/dry-run
proof plus an explicit owner decision authorize CI collect (when secrets are set)
or an optional local helper run. GitHub Actions is the kb writer; this
intake never writes `kb/` or `ref/`.

## Operations

```sh
_meta/alambic attention status --json
_meta/alambic attention env-check --json
_meta/alambic attention env-template
_meta/alambic attention auth-check --source youtube-liked --json
_meta/alambic attention authorize --source youtube-liked
_meta/alambic attention collect --source youtube-liked --dry-run --summary --json
_meta/alambic attention ingest --source x-bookmarks --stdin --dry-run --summary --json
_meta/alambic attention ingest --source x-bookmarks --stdin --persist --confirm --summary --json
_meta/alambic attention ingest --source reddit-saved --stdin --dry-run --summary --json
_meta/alambic attention digest --json
_meta/alambic attention stage --dry-run --json
_meta/alambic attention stage --json
_meta/alambic attention compile --dry-run --json
_meta/alambic attention compile --json
_meta/alambic attention promote-suggest --json          # refuses vault writes without --confirm
_meta/alambic attention promote-suggest --confirm --json  # inbox drafts only
_meta/alambic attention session-pack --max-tokens 2500 --json
_meta/alambic session --attention --json --max-tokens 2500
_meta/alambic attention promote --source youtube-liked --candidate DIGEST --json   # refuses without --confirm
_meta/alambic attention drop-list --source x-bookmarks --json
_meta/alambic attention receipt --status ok --note daily-run --json
_meta/alambic attention disconnect --source youtube-liked --dry-run --json
```

`collect --enabled` is intentionally a no-op while the tracked policy has no
enabled source. Do not enable a source until its exact read-only scopes and
non-identifying account alias have been verified by the human.

### Secrets: environment variables (primary)

**Preferred backend is environment variables** (typically exported from
your shell profile). The optional local wrapper `_meta/bin/attention-daily-grok.sh`
also sources `~/.zshrc` when that file exists. macOS Keychain is **off by default**;
set `ALAMBIC_ATTENTION_ALLOW_KEYCHAIN=1` only if you intentionally want
Keychain fallback.

```sh
# presence only (never prints secret values)
_meta/alambic attention env-check --json

# generate a paste-ready block with fresh data/hmac keys + OAuth placeholders
# (do not regenerate data/hmac keys if you already have encrypted candidates)
_meta/alambic attention env-template
```

Required exports for unattended YouTube:

| Variable | Role |
| --- | --- |
| `ALAMBIC_YOUTUBE_CLIENT_ID` | Google OAuth client id |
| `ALAMBIC_YOUTUBE_CLIENT_SECRET` | Google OAuth client secret |
| `ALAMBIC_YOUTUBE_REFRESH_TOKEN` | Refresh token (`authorize` copies to clipboard → paste here) |
| `ALAMBIC_ATTENTION_YOUTUBE_LIKED_DATA_KEY` | 32-byte base64url AES key for candidates |
| `ALAMBIC_ATTENTION_YOUTUBE_LIKED_HMAC_KEY` | 32-byte base64url HMAC key for digests |

For X bookmarks (crypto + API):

| Variable | Role |
| --- | --- |
| `ALAMBIC_ATTENTION_X_BOOKMARKS_DATA_KEY` | AES key for candidates |
| `ALAMBIC_ATTENTION_X_BOOKMARKS_HMAC_KEY` | HMAC key for digests |
| `ALAMBIC_X_CLIENT_ID` | X OAuth 2.0 client id |
| `ALAMBIC_X_CLIENT_SECRET` | Optional (confidential clients) |
| `ALAMBIC_X_REFRESH_TOKEN` | User-context refresh token (preferred daily path) |
| `ALAMBIC_X_ACCESS_TOKEN` | Optional short-lived access token (tests / emergency) |

X developer app must enable OAuth 2.0 with **read** scopes only:
`bookmark.read`, `tweet.read`, `users.read`. No write scopes.

```sh
_meta/alambic attention collect --source x-bookmarks --dry-run --summary --json
_meta/alambic attention collect --source x-bookmarks --summary --json
```

Chrome multi-device (no OAuth — local profile files):

| Variable | Role |
| --- | --- |
| `ALAMBIC_ATTENTION_CHROME_HISTORY_DATA_KEY` | AES key for candidates |
| `ALAMBIC_ATTENTION_CHROME_HISTORY_HMAC_KEY` | HMAC key for digests |
| `ALAMBIC_CHROME_PROFILE` | optional, default `Default` |
| `ALAMBIC_CHROME_HISTORY_PATH` | optional override of History DB path |

```sh
_meta/alambic attention collect --source chrome-history --dry-run --summary --json
_meta/alambic attention collect --source chrome-history --summary --json
```

Never commit these values. Never pass them on argv. `env-check` reports only
set/unset (`x_bookmarks_api_ready`).

`attention authorize --source youtube-liked` starts a local loopback OAuth
handoff and copies the authorization URL, then the returned refresh token, to
the macOS clipboard (`storage: clipboard-only`). Paste the refresh token into
`ALAMBIC_YOUTUBE_REFRESH_TOKEN` in your shell profile, reload it, and run a
read-only dry probe. `collect --summary` returns counts and reason codes but
omits candidate titles and URLs. Live OAuth and YouTube requests have a
15-second local timeout; a timeout is a failed probe and never creates or
advances local attention state.

## Local collection helper (not the kb writer)

`_meta/bin/attention-daily-grok.sh` is an optional laptop helper. It is not a
scheduler and not the kb writer. GitHub Actions `alambic-sidekick-daily`
materializes promote-ready (YouTube collect only when repo secrets exist) and
then writes `kb/`. There is no in-repo LaunchAgent.

When invoked, the wrapper:

1. Optionally runs Grok headless with `_meta/prompts/attention-daily-grok.md`
   (`grok --prompt-file … --max-turns 8`), then
2. **Always** runs the deterministic CLI path (YouTube + X + Chrome multi-device
   collect → optional X drop → `attention stage` → **`attention compile`** →
   `promote-suggest --confirm` → receipt) so a successful Grok exit cannot skip
   collect/stage/compile.

The wrapper reads approved local overrides from its environment (and
`~/.zshrc` when present) without echoing secret values. Local sidekick apply stays off
(`ALAMBIC_ATTENTION_SIDEKICK` default `0`) so this helper cannot race CI.

```sh
_meta/bin/attention-daily-grok.sh
ALAMBIC_ATTENTION_USE_GROK=0 _meta/bin/attention-daily-grok.sh   # CLI-only
```

A local run can persist the encrypted seven-day candidate queue and stage a
draft promote-candidate batch under `docs/inbox/ai/` (gitignored). It cannot
silently write durable `kb/` or `ref/`.

**X bookmarks are not unattended** until a proved private-bookmark channel exists
(Grok agent tools do not expose user bookmarks). Drop NDJSON exports into
`docs/inbox/ai/attention-drop/x-bookmarks/` for the helper to ingest, or keep
using supervised `attention ingest --persist --confirm`.

## Supervised browser imports

X Bookmarks and Reddit Saved can also be supplied from a human-visible,
already logged-in Chrome page through a supervised Computer Use session. This
is not a browser scraper, cookie export, extension, scheduler, or provider API:
the agent may use only clearly visible cards and sends a bounded NDJSON batch
to `attention ingest` on stdin. Both sources default to forced
`--dry-run --summary --json`, permit at most 100 events, validate source
permalinks, treat every card as untrusted data, and create ephemeral keys in
process memory. The command summary is count-only; input data must never be
echoed, logged, or stored in this repository.

X alone also supports a deliberate persistent mode:
`--persist --confirm --summary --json`. It requires both flags and the two
already-provisioned local X keys. It writes only the standard encrypted,
seven-day X candidate queue, content-free replay/tombstone data, aggregate
metrics, and a capability record under XDG state; it cannot schedule future X
collection or write to `docs/`, `kb/`, or `ref/`. Reddit has no persistent
manual mode. Omitting either X persistence flag leaves the dry-run behavior in
place.

An explicit confirmed disconnect removes only the named source's XDG directory
and per-source Keychain key handles. It does not revoke a provider grant or
delete an explicit local environment override; remove that local value
separately. Key deletion makes a copied old ciphertext undecryptable, but does
not claim physical deletion from system backups.

## Retention

| State | Retention |
| --- | --- |
| Raw response, credential, page token | Process memory only |
| Rejection tombstone (HMAC + reason) | 7 days |
| Encrypted technical candidate | 7 days from observed time |
| Review receipt | 90 days |
| Aggregate metrics | 90 days |
| Disabled capability record | 30 days |

Related: [[capture-quarantine-before-kb]], [[second-brain-operating-model]],
[[shadow-apply-gate]].
