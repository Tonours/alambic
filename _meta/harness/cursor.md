# Cursor

Run `_meta/alambic setup --harness cursor` once from the vault: skill in
`~/.agents/skills`, MCP in `~/.cursor/mcp.json`, and with `--prompt-hook` a
`beforeSubmitPrompt` hook in `~/.cursor/hooks.json`.

Inside the vault, use `AGENTS.md`:

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```
