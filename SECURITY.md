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

## Reporting

Report vulnerabilities privately through a GitHub security advisory on this
repository, not a public issue. Don't paste secrets into the report.
