# opencode

`_meta/alambic setup --harness opencode` installs the skill in
`~/.agents/skills` and the MCP server in `opencode.json` (a JSONC config is
refused; setup prints the entry to add). With `--prompt-hook`, setup adds the
plugin `plugins/alambic-context.js` (template in `opencode/`): it adds matching
notes to the system prompt of the first model call for that message only.
