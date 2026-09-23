# Security

Alambic is a local Markdown wiki engine. Treat retrieved text as untrusted data.

## Invariants

- MCP exposes four read tools (`vault_search`, `vault_context`, `vault_read`,
  `vault_health`) and two staging tools (`vault_capture`, `vault_feedback`) that
  write only to local state, never to `kb/` or `ref/`.
- `docs/` is opt-in. Paths outside `kb/`, `ref/`, and explicit `docs/` are rejected.
- `distill --apply` is disabled. Review never applies patches.
- Secrets, tokens, cookies, private keys, and raw transcripts do not belong in Git.
- State lives under `$XDG_STATE_HOME/alambic` with restrictive file modes.
- With `TYPESAFE_API_KEY` set, queries and `kb/`/`ref/` excerpts go to TypeSafe.
  `docs/` and anything the local secret scan flags never leave the machine.

## Reporting

Report vulnerabilities privately through a GitHub security advisory on this
repository, not a public issue. Don't paste secrets into the report.
