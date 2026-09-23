# Claude Code / Claude Desktop

Open this vault as the project root. `CLAUDE.md` is the contract.

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```

Optional MCP over stdio: `npm run mcp`. Read tools: `vault_search`,
`vault_context`, `vault_read`, `vault_health`. Staging tools: `vault_capture`,
`vault_feedback`; they write to local state, never to `kb/`.
