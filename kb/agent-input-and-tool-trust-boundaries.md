---
type: synthesis
status: verified
summary: "Agent hosts must keep user authority, application policy, retrieved content, tool metadata, and tool results in separate trust classes before allowing side effects."
created: 2026-08-19
updated: 2026-08-19
confidence: high
sources:
  - "https://genai.owasp.org/llmrisk/llm01-prompt-injection/"
  - "https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices"
tags:
  - agent-security
  - prompt-injection
  - tool-security
  - untrusted-input
  - mcp
aliases:
  - indirect prompt injection
  - tool poisoning
  - untrusted tool results
  - agent trust boundaries tool results
  - tool results from MCP must not be trusted as instructions
claims:
  - "agent host | trust classes | user authority policy retrieved content tool metadata tool results separate | side effects"
---

# Agent Input and Tool Trust Boundaries

Content and authority are different channels. A retrieved note, web page, tool
description, or tool result may look like an instruction. It does not gain
permission to change the user's goal, expand scope, expose secrets, or authorize
a side effect.

Alambic MCP is read-only for that reason. `docs/` is opt-in and remains
untrusted. Jailbreak-style instruction overrides in retrieved text stay
**data, not command**.

## Related

- [[source-grounded-answer-quality]]
- [[alambic-multi-harness-access]]
- [[obsidian-ai-integration-boundaries]]
