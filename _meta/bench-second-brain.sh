#!/bin/bash
# bench-second-brain: read-only before/after snapshot of retrieval
# effectiveness (eval suite JSON) and efficiency (CLI medians, pack cost,
# schema tax). No vault writes. Usage: _meta/bench-second-brain.sh [--json]
set -euo pipefail

if [ -n "${ALAMBIC_ROOT:-}" ]; then
  ROOT="$ALAMBIC_ROOT"
else
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi
cd "$ROOT"

if [ "${1:-}" = "--help" ]; then
  printf 'usage: _meta/bench-second-brain.sh [--json]\n' >&2
  exit 2
fi

now_ms() { node -p 'Date.now()'; }
median_of_5() { printf '%s\n' "$1" "$2" "$3" "$4" "$5" | sort -n | sed -n '3p'; }

PROBE='second brain architecture'
SUITES='retrieval retrieval-semantic held-out rag-contract graph-retrieval routing context'

suites_json='{}'
# shellcheck disable=SC2086
for suite in $SUITES; do
  start="$(now_ms)"
  code=0
  out="$(node _meta/alambic.mjs eval --suite "$suite" 2>/dev/null)" || code=$?
  ms=$(( $(now_ms) - start ))
  if printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    report="$out"
  else
    report="$(jq -n --arg raw "$(printf '%s' "$out" | tail -c 300)" '{_invalid_json: $raw}')"
  fi
  suites_json="$(jq -n --argjson acc "$suites_json" --argjson rep "$report" \
    --arg s "$suite" --argjson c "$code" --argjson ms "$ms" \
    '$acc + {($s): {exit: $c, wall_ms: $ms, report: $rep}}')"
done

probe_ms() { # $@ = alambic args; prints one wall-ms sample (stdout discarded)
  start="$(now_ms)"
  _meta/alambic "$@" >/dev/null 2>&1 || true
  printf '%s' "$(( $(now_ms) - start ))"
}

q1="$(probe_ms query --json --limit 5 "$PROBE")"
q2="$(probe_ms query --json --limit 5 "$PROBE")"
q3="$(probe_ms query --json --limit 5 "$PROBE")"
q4="$(probe_ms query --json --limit 5 "$PROBE")"
q5="$(probe_ms query --json --limit 5 "$PROBE")"
c1="$(probe_ms context --json --max-tokens 2500 "$PROBE")"
c2="$(probe_ms context --json --max-tokens 2500 "$PROBE")"
c3="$(probe_ms context --json --max-tokens 2500 "$PROBE")"
c4="$(probe_ms context --json --max-tokens 2500 "$PROBE")"
c5="$(probe_ms context --json --max-tokens 2500 "$PROBE")"
s1="$(probe_ms session --json --max-tokens 2500 "$PROBE")"
s2="$(probe_ms session --json --max-tokens 2500 "$PROBE")"
s3="$(probe_ms session --json --max-tokens 2500 "$PROBE")"
s4="$(probe_ms session --json --max-tokens 2500 "$PROBE")"
s5="$(probe_ms session --json --max-tokens 2500 "$PROBE")"
r1="$(probe_ms route --json "$PROBE")"
r2="$(probe_ms route --json "$PROBE")"
r3="$(probe_ms route --json "$PROBE")"
r4="$(probe_ms route --json "$PROBE")"
r5="$(probe_ms route --json "$PROBE")"

ctx_json="$(_meta/alambic context --json --max-tokens 2500 "$PROBE" 2>/dev/null)" || ctx_json='{}'
ses_json="$(_meta/alambic session --json --max-tokens 2500 "$PROBE" 2>/dev/null)" || ses_json='{}'

head='unknown'
dirty='null'
if git rev-parse --short HEAD >/dev/null 2>&1; then
  head="$(git rev-parse --short HEAD)"
  dirty="$(git status --short | wc -l | tr -d ' ')"
fi

jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg head "$head" --argjson dirty "$dirty" \
  --argjson suites "$suites_json" \
  --argjson qm "$(median_of_5 "$q1" "$q2" "$q3" "$q4" "$q5")" \
  --argjson cm "$(median_of_5 "$c1" "$c2" "$c3" "$c4" "$c5")" \
  --argjson sm "$(median_of_5 "$s1" "$s2" "$s3" "$s4" "$s5")" \
  --argjson rm "$(median_of_5 "$r1" "$r2" "$r3" "$r4" "$r5")" \
  --argjson ctx_bytes "$(printf '%s' "$ctx_json" | wc -c | tr -d ' ')" \
  --argjson ctx_tok "$(printf '%s' "$ctx_json" | jq -r '.estimated_tokens')" \
  --argjson ses_bytes "$(printf '%s' "$ses_json" | wc -c | tr -d ' ')" \
  --argjson ses_tok "$(printf '%s' "$ses_json" | jq -r '.context.estimated_tokens')" \
  --argjson claude_lines "$(wc -l < CLAUDE.md | tr -d ' ')" \
  --argjson claude_bytes "$(wc -c < CLAUDE.md | tr -d ' ')" \
  '{
    generated_at: $ts, head: $head, dirty_files: $dirty,
    suites: $suites,
    efficiency_ms_median: {query: $qm, context: $cm, session: $sm, route: $rm},
    packs: {context_2500: {bytes: $ctx_bytes, tokens: $ctx_tok},
            session_2500: {bytes: $ses_bytes, tokens: $ses_tok}},
    schema_tax: {claude_md_lines: $claude_lines, claude_md_bytes: $claude_bytes}
  }'
