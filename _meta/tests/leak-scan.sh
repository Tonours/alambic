#!/bin/bash
# Public leak scan. Identity markers are never hardcoded here (publishing them
# would leak what we hunt): supply them per line in a gitignored file
# ($ALAMBIC_LEAK_PATTERNS_FILE, default .leak-patterns) and/or as newline-
# separated extended regexes in $ALAMBIC_LEAK_PATTERNS (e.g. a CI secret).
# ALAMBIC_LEAK_REQUIRED=true turns "no patterns" into a failure.
set -euo pipefail
ROOT="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
cd "$ROOT"
fail=0
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.obsidian --exclude-dir=.workflow --exclude-dir=.pi)

patterns=$(mktemp)
hits=$(mktemp)
trap 'rm -f "$patterns" "$hits"' EXIT
file="${ALAMBIC_LEAK_PATTERNS_FILE:-$ROOT/.leak-patterns}"
[ -f "$file" ] && grep -vE '^\s*(#|$)' "$file" >> "$patterns" || true
[ -n "${ALAMBIC_LEAK_PATTERNS:-}" ] && printf '%s\n' "$ALAMBIC_LEAK_PATTERNS" | grep -vE '^\s*(#|$)' >> "$patterns" || true
count=$(wc -l < "$patterns" | tr -d ' ')

if [ "$count" -gt 0 ]; then
  # A malformed pattern makes grep exit 2 (silently disabling the scan): fail loud.
  if grep -qEi -f "$patterns" /dev/null 2>/dev/null || [ $? -eq 2 ]; then
    printf 'leak-scan: invalid private pattern (grep -E rejected it)\n' >&2
    exit 1
  fi
  # Publishable set: tracked + untracked-not-ignored files (gitignored runtime
  # artifacts never ship). Outside a git checkout, scan the whole tree.
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    scan() { git ls-files -z -co --exclude-standard | grep -zv -e '^node_modules/' | xargs -0 grep -InEi -f "$patterns" -- 2>/dev/null; }
  else
    scan() { grep -RInEi -f "$patterns" "${EXCLUDES[@]}" --exclude="$(basename "$file")" . 2>/dev/null; }
  fi
  # Judge by output, not exit status (xargs batches mask per-batch matches).
  scan > "$hits" || true
  allow="$ROOT/.leak-allow"
  if [ -s "$hits" ] && [ -f "$allow" ]; then
    awk 'NR == FNR { if ($0 !~ /^[[:space:]]*(#|$)/) keep[++n] = $0; next }
      { for (i = 1; i <= n; i++) while ((p = index($0, keep[i])) > 0) $0 = substr($0, 1, p - 1) substr($0, p + length(keep[i])); print }' \
      "$allow" "$hits" | { grep -Ei -f "$patterns" || true; } > "$hits.masked"
    mv "$hits.masked" "$hits"
  fi
  if [ -s "$hits" ]; then
    # file:line only: echoing the matched text would publish the marker in CI logs.
    printf 'leak-scan: private marker found:\n' >&2
    cut -d: -f1,2 "$hits" >&2
    fail=1
  fi
elif [ "${ALAMBIC_LEAK_REQUIRED:-}" = true ]; then
  printf 'leak-scan: no private patterns configured but ALAMBIC_LEAK_REQUIRED=true (set the ALAMBIC_LEAK_PATTERNS secret, or repo variable ALAMBIC_LEAK_OPTIONAL=true)\n' >&2
  exit 1
elif [ -n "${CI:-}" ]; then
  printf '::warning title=Leak scan::no private patterns configured (set the ALAMBIC_LEAK_PATTERNS secret); only generic checks ran\n'
fi

# Machine home paths in knowledge/docs/contracts (engine regexes may mention Users as a class).
if grep -RInE '/(Users|home)/[A-Za-z0-9._-]+([/"'"'"'`[:space:]]|$)' kb ref docs AGENTS.md CLAUDE.md README.md LICENSE SECURITY.md CONTRIBUTING.md _meta/*.md _meta/harness _meta/skills _meta/templates _meta/prompts _meta/obsidian 2>/dev/null; then
  printf 'leak-scan: absolute home path in user-facing files\n' >&2
  fail=1
fi

if grep -RInE 'BEGIN [A-Z ]*PRIVATE KEY|(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -v '_meta/lib/vault.mjs' | grep -v '_meta/tests/eval.mjs' | grep -v '_meta/tests/leak-scan.sh'; then
  printf 'leak-scan: secret-like token found outside security fixtures\n' >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
printf 'leak-scan: ok (private patterns: %s)\n' "$count"
