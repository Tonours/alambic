# Claude Code

Run `_meta/alambic setup --harness claude` once from the vault: it installs
the `alambic` skill, registers the MCP server (`claude mcp add -s user`), and
optionally the per-prompt hook (`--prompt-hook`).

Inside the vault, `CLAUDE.md` is the contract:

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```

MCP: four read tools plus `vault_capture` and `vault_feedback`, which stage
to local state and never write to `kb/`.
