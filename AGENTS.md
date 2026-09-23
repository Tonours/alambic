# AGENTS.md: alambic

- Read `CLAUDE.md` before creating or editing notes.
- Query with `_meta/alambic context` or `session` (cited, token-capped).
- Search `kb/` and `ref/` before `docs/`.
- Update existing notes first; do not duplicate nearby notes.
- Do not rename files without scanning inbound `[[wikilinks]]`.
- Do not install community AI plugins by default.
- Do not claim health unless `_meta/validate-kb.sh` passed.
- Optional MCP: `npm run mcp` (four read tools, plus `vault_capture` and
  `vault_feedback`, which stage locally and never write to `kb/`).
- Jev semantic rerank runs only when `TYPESAFE_API_KEY` is set; otherwise
  retrieval is lexical. With the key set, queries go to TypeSafe: never put
  secrets in them.
- After a retrieval, record `_meta/alambic feedback --status hit|miss|stale|wrong`.
- Automated `kb/` writes belong to the sidekick workflow; local sidekick stays dry-run.
