# Contributing

This repository is both the engine and a starter vault.

1. Keep personal data out. No machine paths, account names, or private corpora.
2. Tests must pass on the starter wiki: `npm ci && npm test`, plus
   `_meta/tests/leak-scan.sh` with your `.leak-patterns`.
3. Don't edit frozen eval sets to green a change. Re-author them, then
   `npm run eval:freeze`.
4. MCP tools never write to `kb/` or `ref/`. A new write tool stages into local
   state, like `vault_capture`.
5. Don't enable `distill --apply` by default.
6. New durable notes go through the inbox → promotion gate described in `CLAUDE.md`.
7. `alambic setup` tests run against a fake HOME with stub CLIs only. Never let
   a test touch real agent configs or run a real `claude`/`codex` binary.
8. The prompt hook stays lexical: `_meta/tests/prompt-hook.mjs` fails if its
   import graph reaches the TypeSafe modules. Changing the retrieval engine
   means re-measuring `_meta/evals/hook-gate.json`.
