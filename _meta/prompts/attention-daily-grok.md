# Daily technical-attention orchestrator (Grok headless)

You are running the **scheduled 05:15 UTC** technical-attention job for the alambic
repository (cwd is already `$ALAMBIC_ROOT`).

## Hard rules

1. Never print, log, or write secrets, tokens, cookies, Keychain values, or `.env` contents.
2. Never write durable `kb/` or `ref/` notes in this run. apply-auto is DISABLED.
3. Never scrape browser sessions, CDP, cookies, or Chrome History raw URLs to force a source on.
4. Prefer count-only / `--summary --json` for collect/ingest output in logs.
5. Cap work: run the steps below and stop. Do not start unrelated refactors.

## Steps (in order)

1. Run:
   ```sh
   ./_meta/alambic attention status --json
   ```
2. Collect **scheduled-ready** YouTube likes (summary only):
   ```sh
   ./_meta/alambic attention collect --source youtube-liked --summary --json
   ```
   If status is `blocked-auth`, record that and continue — do not invent credentials.
3. **X bookmarks** via official X API v2 when env credentials exist:
   ```sh
   ./_meta/alambic attention collect --source x-bookmarks --summary --json
   ```
   If status is `blocked-auth`, do not invent tokens. Optionally process drop-folder NDJSON:
   ```sh
   # if docs/inbox/ai/attention-drop/x-bookmarks/*.ndjson exist
   ./_meta/alambic attention ingest --source x-bookmarks --stdin --persist --confirm --summary --json < FILE
   ```
   Do **not** scrape browser sessions or cookies.
4. Chrome multi-device (foreign originators ≠ local sync cache_guid):
   ```sh
   ./_meta/alambic attention collect --source chrome-history --summary --json
   ```
   If `unsupported`, continue — do not scrape full local history or bypass browser security.
5. Stage promote candidates under `docs/inbox/ai/` (never kb):
   ```sh
   ./_meta/alambic attention stage --json
   ```
6. Compile high-signal synthesis for LLM context (inbox only):
   ```sh
   ./_meta/alambic attention compile --json
   ```
7. Append a content-free receipt:
   ```sh
   ./_meta/alambic attention receipt --status ok --note daily-grok --json
   ```

## Output

Print a short final summary with only: source statuses, accepted/rejected/replayed counts,
stage path if any, and residual blockers (X blocked, Chrome unsupported). No titles required.
