---
type: synthesis
status: verified
summary: "Choose Obsidian AI access through explicit runtime, data-flow, permission, and recovery boundaries rather than treating plugins, CLI, Headless, filesystem skills, and MCP as interchangeable."
created: 2026-08-19
updated: 2026-08-19
verified_at: 2026-08-19
confidence: high
sources:
  - "https://help.obsidian.md/cli"
  - "https://help.obsidian.md/plugin-security"
  - "https://github.com/kepano/obsidian-skills"
tags:
  - obsidian
  - second-brain
  - agent-integration
  - mcp
aliases:
  - Obsidian AI plugins
  - Obsidian CLI agent
  - frontières intégration IA Obsidian
---

# Obsidian AI Integration Boundaries

An agent does not need the most powerful Obsidian integration. It needs the
smallest interface that supplies the required evidence.

| Lane | Use when |
| --- | --- |
| Filesystem + CLI (`_meta/alambic`) | Default for coding agents |
| Read-only MCP | Hosts that speak MCP stdio |
| Official Obsidian CLI | A running desktop app must expose search or Bases |
| Community AI plugin | Only if in-vault chat is genuinely required |

Alambic defaults install **no** community plugins. Open this repository as a
**separate** Obsidian vault, never nested inside another vault.

## Related

- [[llm-wiki-second-brain-architecture]]
- [[alambic-multi-harness-access]]
- [[agent-input-and-tool-trust-boundaries]]
