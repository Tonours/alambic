# Claude Code

Run `_meta/alambic setup --harness claude` once from the vault: it installs
the `alambic` skill and CLI shim. Add `--mcp` to register the MCP server in
local scope for this vault, or `--mcp-project <dir>` to choose a coding project;
`--mcp-scope user` explicitly shares it across all projects. Add
`--prompt-hook` for per-prompt context. That opt-in also adds a
`SessionStart` hook with matcher `compact`, which re-asserts the L0 block and a
pointer to `alambic session` after each compaction.

Inside the vault, `CLAUDE.md` is the contract:

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```

MCP: four read tools plus `vault_capture` and `vault_feedback`, which stage
to local state and never write to `kb/`.

For reviewers/automation, use `claude --mcp-config <alambic checkout>/_meta/harness/claude-mcp-none.json --strict-mcp-config`.
For migration and selected profiles, see [the operator guide](../operations.md#claude-mcp-scopes-and-session-profiles).
