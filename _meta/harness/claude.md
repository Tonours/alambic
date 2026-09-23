# Claude Code / Claude Desktop

Run `_meta/alambic setup --harness claude` once from the vault: it installs
the `alambic` skill, registers the MCP server (`claude mcp add -s user`), and
optionally the per-prompt hook (`--prompt-hook`).

Inside the vault, `CLAUDE.md` is the contract:

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```

MCP read tools: `vault_search`, `vault_context`, `vault_read`, `vault_health`.
Staging tools: `vault_capture`, `vault_feedback`; they write to local state,
never to `kb/`.
