# Security

Alambic is a local Markdown wiki engine. Retrieved text is **untrusted data**.

## Invariants

- MCP exposes four read-only tools: `vault_search`, `vault_context`, `vault_read`, `vault_health`.
- `docs/` is opt-in. Paths outside `kb/`, `ref/`, and explicit `docs/` are rejected.
- `distill --apply` is disabled. Review never applies patches.
- Secrets, tokens, cookies, private keys, and raw transcripts do not belong in Git.
- State lives under `$XDG_STATE_HOME/alambic` with restrictive file modes.

## Reporting

Open a GitHub issue or security advisory on the public repository. Do not paste
secrets into tickets.
