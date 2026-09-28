# Security

Alambic is a local Markdown wiki engine. Treat retrieved text as untrusted data.

## Invariants

- MCP exposes four read tools (`vault_search`, `vault_context`, `vault_read`,
  `vault_health`) and two staging tools (`vault_capture`, `vault_feedback`) that
  write only to local state, never to `kb/` or `ref/`.
- `docs/` is opt-in. Paths outside `kb/`, `ref/`, and explicit `docs/` are rejected.
- `distill --apply` is disabled. `alambic review` never applies patches.
- Secrets, tokens, cookies, private keys, and raw transcripts do not belong in Git.
- State lives under `$XDG_STATE_HOME/alambic` with restrictive file modes.
  Shadow candidates and receipted proposals expire after 7 days, unreceipted
  proposals after 30 days, so a pending proposal outlives a week without
  review. Every command that opens the state dir purges expired files and
  prints the count on stderr. Review receipts are never purged.
- The session distiller reads untrusted transcripts, so it runs without
  `TYPESAFE_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` or any `ALAMBIC_*` variable
  other than the `ALAMBIC_HARVEST_CHILD` recursion guard.
- With `TYPESAFE_API_KEY` set, queries and `kb/`/`ref/` excerpts go to TypeSafe.
  `docs/` and anything the local secret scan flags never leave the machine.
- `alambic init --install` runs `npm ci`, so dependencies match the committed
  `npm-shrinkwrap.json`.
- `alambic setup` writes only user-level agent configs, records each write in
  `$XDG_STATE_HOME/alambic/setup.json`, backs up existing files with mode `0600`
  first, never replaces entries it did not write, and never echoes config
  values (they can hold tokens).
- The opt-in per-prompt hook is local and lexical: it imports no TypeSafe code,
  so prompts never leave the machine through it, and it never logs or caches
  the prompt. Injected notes are marked untrusted. Retention is up to each
  runtime: Claude Code, Codex and Cursor keep the added context in their
  transcripts, and Pi persists it as a session message (the extension keeps only
  the latest block in model context).
- The same opt-in re-asserts the L0 block (`ref/critical-facts.md`, 800-byte
  cap) and a pointer to `alambic session` through Claude Code `SessionStart`
  (matcher `compact`) and Cursor `sessionStart`, under the same untrusted header
  and 1200-token cap. It reads only that note, lexically, and writes nothing.

## Reporting

Report vulnerabilities privately through a GitHub security advisory on this
repository, not a public issue. Don't paste secrets into the report.
