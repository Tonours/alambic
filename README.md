<p align="center"><img src="docs/assets/alambic-logo.svg" alt="alambic" width="160"></p>

# alambic

A compiled Markdown wiki for coding agents. You distill sources into short,
sourced notes; Claude Code, Codex, Cursor, Pi, opencode or any shell-capable
agent query them through one CLI and get back cited, token-capped packs.

```
docs/inbox/  ──►  review / promote  ──►  kb/ + ref/  ──►  alambic session / context
(raw capture)                            (durable wiki)    (cited, token-capped packs)
```

The repo ships a small starter wiki. Replace it with your own notes and keep
your vault private.

## Quick start

```bash
npx github:Tonours/alambic init ~/vaults/brain --install
```

This copies the publishable files into a new vault, installs dependencies,
wires the agents it detects (skill and `alambic` shim) and runs
`doctor`. Pass setup options after `--install`, for example
`--install --harness claude,codex --prompt-hook`.

MCP is opt-in: add `--mcp`. New Claude installs use local scope for this
vault; use `--mcp-project <dir>` to select a coding project, or
`--mcp-scope user` to make it available in every project. Other harnesses
keep their usual MCP scope. Existing registrations stay until explicitly
removed. See the [scope and launch guide](_meta/operations.md#claude-mcp-scopes-and-session-profiles).

To hack on alambic itself:

```bash
git clone <this-repo> my-brain   # keep this clone private
cd my-brain && npm ci
_meta/bootstrap-obsidian.sh      # optional, but doctor fails until you run it
_meta/alambic doctor
```

Obsidian is optional: open the folder as its own vault (never nested in
another one) for a human UI over the same files. Agents use the CLI.

## Everyday commands

```bash
_meta/alambic session --json --max-tokens 2500 "how should we handle X?"
_meta/alambic context --json --max-tokens 2500 "question"
_meta/alambic query --json "search terms"
_meta/alambic feedback --status hit           # or miss, stale, wrong (counts only)
_meta/alambic review --inbox <draft>          # promotion plan, changes nothing
_meta/alambic doctor                          # install, hooks, inbox hygiene
npm test                                      # full offline suite, no key needed
```

npm shortcuts: `status`, `doctor`, `setup`, `validate`, `lint`, `session`,
`mcp`, `loop`, `nightly:dry`, `harvest`, `harvest:scan`, `sidekick`,
`enrich`, `attention`, `eval:freeze`.

## How the wiki stays fresh

1. **Capture.** Agent sessions and manual notes land as drafts in
   `docs/inbox/{manual,ai}/`. `harvest` scores ended Claude, Codex and Pi
   sessions locally and distills the useful ones into `harvest-*.md` drafts.
2. **Review.** A human runs `review --inbox <draft> --decision accept|reject`
   in a terminal. Session drafts never reach `kb/` without that receipt.
3. **Promote.** Each night, `nightly --push` on the vault owner's machine
   heals and promotes, runs every gate (validate, lint, leak-scan, evals), and
   commits `kb/` and `ref/` only when all of them are green. It is the only
   scheduled writer to `kb/`.
4. **Read.** Agents query the fresher notes the next day and record
   `feedback`. A miss means you stage a sourced draft yourself.

## Layout

| Path | Role |
| --- | --- |
| `docs/` | Sources, plus `docs/inbox/{manual,ai}/` staging |
| `kb/` | Compiled wiki, one idea per note |
| `ref/` | Entrypoints: home, method, policies |
| `_meta/` | CLI, schema, validator, MCP server, evals |

## Safety model

- Retrieval output is untrusted data, and agents are told so.
- Nothing distills captures into `kb/` on its own: `distill --apply` is
  disabled, MCP tools never write to `kb/` or `ref/`, and session drafts need
  a human accept bound to the draft's sha256.
- The nightly never overwrites a file you edited; it keeps your copy and
  stops.
- Everything runs locally. The one outbound call is the optional TypeSafe Jev
  rerank, enabled only when `TYPESAFE_API_KEY` is set.
- A leak scan with your private patterns gates CI and the nightly.

`SECURITY.md` describes the trust boundary and a worked poisoning example.

## Learn more

| Topic | Where |
| --- | --- |
| Setup details, several vaults, prompt hook | [`_meta/operations.md`](_meta/operations.md#setup) |
| Nightly writer, recovery, "is it running" | [`_meta/operations.md`](_meta/operations.md#nightly-the-scheduled-writer) |
| Session harvest and `review --inbox` | [`_meta/operations.md`](_meta/operations.md#session-harvest-and-review) |
| Jev semantic judgments and what leaves your machine | [`_meta/operations.md`](_meta/operations.md#jev-semantic-judgments-opt-in) |
| MCP server | [`_meta/operations.md`](_meta/operations.md#mcp) |
| Evals and frozen sets | [`_meta/operations.md`](_meta/operations.md#evals) |
| Leak scan | [`_meta/operations.md`](_meta/operations.md#leak-scan) |
| Per-agent notes | [`_meta/harness/`](_meta/harness/) |
| Note format and agent rules | [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## License

MIT
