# Cursor

Run `_meta/alambic setup --harness cursor` once from the vault: skill in
`~/.agents/skills`, opt-in MCP with `--mcp` in `~/.cursor/mcp.json`, and with `--prompt-hook` a
`sessionStart` hook in `~/.cursor/hooks.json` that adds the L0 block and a
pointer to `alambic session` as `additional_context`. Cursor gets no per-prompt
hook: `beforeSubmitPrompt` output accepts only `continue` and `user_message`.
Rerunning setup removes a `beforeSubmitPrompt` entry that an older setup wrote.
Runtime behavior in a live Cursor session is not verified by the test suite.

Inside the vault, use `AGENTS.md`:

```bash
_meta/alambic session --json --max-tokens 2500 "<question>"
```
