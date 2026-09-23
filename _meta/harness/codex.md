# Codex

Run `_meta/alambic setup --harness codex` once from the vault: skill in
`~/.agents/skills`, MCP via `codex mcp add`, and with `--prompt-hook` a
`UserPromptSubmit` hook in `$CODEX_HOME/hooks.json`. Approve the hook in
Codex `/hooks`; until then `setup --status` reports `pending-trust`.

Inside the vault, use `AGENTS.md`:

```bash
_meta/alambic context --json --max-tokens 2500 "<question>"
```
