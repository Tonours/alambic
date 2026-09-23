#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
unset TYPESAFE_API_KEY

"$ROOT/_meta/alambic" validate --mode strict
"$ROOT/_meta/alambic" sources --check
node "$ROOT/_meta/tests/schema.mjs" "$ROOT"
node "$ROOT/_meta/tests/manifest-integrity.mjs" "$ROOT"
node "$ROOT/_meta/tests/attention.mjs" "$ROOT"
node "$ROOT/_meta/tests/hybrid-obsidian.mjs" "$ROOT"
node "$ROOT/_meta/tests/multi-harness.mjs" "$ROOT"
node "$ROOT/_meta/tests/graph.mjs" "$ROOT"
"$ROOT/_meta/tests/leak-scan.sh" "$ROOT"
"$ROOT/_meta/tests/leak-allow.sh"
node "$ROOT/_meta/tests/state-dir.mjs" "$ROOT"
node "$ROOT/_meta/tests/lexical-cache.mjs" "$ROOT"
node "$ROOT/_meta/tests/loop-pulse.mjs" "$ROOT"
node "$ROOT/_meta/tests/sidekick.mjs" "$ROOT"
node "$ROOT/_meta/tests/harvest.mjs" "$ROOT"
node "$ROOT/_meta/tests/review-gate.mjs" "$ROOT"
node "$ROOT/_meta/tests/nightly.mjs" "$ROOT"
node "$ROOT/_meta/tests/l0-fresh.mjs" "$ROOT"
node "$ROOT/_meta/tests/typesafe.mjs" "$ROOT"
node "$ROOT/_meta/tests/init.mjs" "$ROOT"
node "$ROOT/_meta/tests/setup.mjs" "$ROOT"
node "$ROOT/_meta/tests/prompt-hook.mjs" "$ROOT"
node "$ROOT/_meta/tests/hook-adapters.mjs" "$ROOT"
python3 "$ROOT/_meta/tests/checkbox-pty.py" "$ROOT"
"$ROOT/_meta/alambic" eval --suite attention-ranking
"$ROOT/_meta/alambic" eval --suite attention-compile
"$ROOT/_meta/alambic" eval --suite lint
"$ROOT/_meta/alambic" eval --suite retrieval
"$ROOT/_meta/alambic" eval --suite context
"$ROOT/_meta/alambic" eval --suite retrieval-semantic
"$ROOT/_meta/alambic" eval --suite typesafe-semantic
"$ROOT/_meta/alambic" eval --suite graph-retrieval
"$ROOT/_meta/alambic" eval --suite graph-engineering
"$ROOT/_meta/alambic" eval --suite retrieval-fusion
"$ROOT/_meta/alambic" eval --suite mcp-security
"$ROOT/_meta/alambic" eval --suite rag-contract
"$ROOT/_meta/alambic" eval --suite security
"$ROOT/_meta/alambic" eval --suite distillation
"$ROOT/_meta/alambic" eval --suite routing
"$ROOT/_meta/alambic" eval --suite probes-v2
"$ROOT/_meta/alambic" eval --suite tuning
"$ROOT/_meta/alambic" eval --suite capability
"$ROOT/_meta/alambic" eval --suite regression

first="$("$ROOT/_meta/alambic" query --json 'second brain architecture')"
second="$("$ROOT/_meta/alambic" query --json 'second brain architecture')"
test "$first" = "$second"

first_lint="$("$ROOT/_meta/alambic" lint --json)"
second_lint="$("$ROOT/_meta/alambic" lint --json)"
test "$first_lint" = "$second_lint"

context_json="$("$ROOT/_meta/alambic" context --json --max-tokens 512 'second brain architecture')"
tokens="$(printf '%s' "$context_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["estimated_tokens"])')"
results_len="$(printf '%s' "$context_json" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["results"]))')"
test "$tokens" -le 512
test "$results_len" -ge 1

session_json="$("$ROOT/_meta/alambic" session --json --max-tokens 2500 'second brain architecture')"
session_bytes="$(printf '%s' "$session_json" | wc -c | tr -d ' ')"
test $(( (session_bytes + 3) / 4 )) -le 2500

prompt="$("$ROOT/_meta/alambic" refresh agent-prompt)"
printf '%s' "$prompt" | grep -q 'docs/inbox'
printf '%s' "$prompt" | grep -q 'obsidian-hybrid-workflow'

if ! ALAMBIC_STAGED="$ROOT/docs/inbox/missing-dir-$$" "$ROOT/_meta/alambic" refresh staged >/dev/null 2>&1; then
  :
else
  printf 'expected invalid ALAMBIC_STAGED to fail\n' >&2
  exit 1
fi

printf 'alambic tests: ok\n'
