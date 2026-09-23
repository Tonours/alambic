# Pi

`_meta/alambic setup --harness pi` installs the skill in `~/.agents/skills`.
Pi has no MCP. With `--prompt-hook`, setup adds the extension
`$PI_CODING_AGENT_DIR/extensions/alambic-context.ts` (template in `pi/`): it adds
matching notes before each prompt as a hidden session message and keeps only the
latest one in model context.
