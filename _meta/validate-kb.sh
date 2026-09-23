#!/bin/bash
set -euo pipefail

if [ -n "${ALAMBIC_ROOT:-}" ]; then
  ROOT="$ALAMBIC_ROOT"
else
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi

cd "$ROOT"

if command -v node >/dev/null 2>&1 && [ -f "$ROOT/_meta/alambic.mjs" ]; then
  exec "$ROOT/_meta/alambic" validate --mode "${ALAMBIC_VALIDATION_MODE:-strict}"
fi

fail=0
err() {
  printf 'validate-kb: %s\n' "$*" >&2
  fail=1
}

required_dirs=(kb ref docs _meta)
for dir in "${required_dirs[@]}"; do
  [ -d "$dir" ] || err "missing required directory: $dir"
done

required_files=(CLAUDE.md AGENTS.md README.md kb/_index.md ref/current-work.md ref/method.md)
for file in "${required_files[@]}"; do
  [ -f "$file" ] || err "missing required file: $file"
done

frontmatter_body() {
  awk '
    NR == 1 && $0 != "---" { exit 2 }
    NR > 1 && $0 == "---" { exit 0 }
    NR > 1 { print }
  ' "$1"
}

while IFS= read -r -d '' file; do
  first_line="$(sed -n '1p' "$file")"
  if [ "$first_line" != "---" ]; then
    err "$file: missing opening frontmatter"
    continue
  fi
  fm_count="$(grep -c '^---$' "$file" || true)"
  if [ "$fm_count" -lt 2 ]; then
    err "$file: missing closing frontmatter"
    continue
  fi

  header="$(frontmatter_body "$file" || true)"
  printf '%s\n' "$header" | grep -Eq '^type: ' || err "$file: missing type"
  printf '%s\n' "$header" | grep -Eq '^status: ' || err "$file: missing status"
  printf '%s\n' "$header" | grep -Eq '^updated: [0-9]{4}-[0-9]{2}-[0-9]{2}' || err "$file: missing updated date"

  type="$(printf '%s\n' "$header" | awk -F': *' '/^type:/{print $2; exit}')"
  case "$type" in
    finding|incident|adr|synthesis)
      printf '%s\n' "$header" | grep -Eq '^sources:' || err "$file: $type note missing sources"
      ;;
    reference|'')
      ;;
    *)
      err "$file: unsupported type '$type'"
      ;;
  esac
done < <(find kb ref -maxdepth 1 -type f -name '*.md' -print0)

duplicates="$(find kb ref -maxdepth 1 -type f -name '*.md' -exec basename {} .md \; | sort | uniq -d || true)"
if [ -n "$duplicates" ]; then
  err "duplicate kb/ref basenames: $(printf '%s' "$duplicates" | tr '\n' ' ')"
fi

valid_targets="$(find kb ref docs -type f -name '*.md' -exec basename {} .md \; | sort -u)"
links="$(grep -Roh '\[\[[^]]*\]\]' kb ref 2>/dev/null | sed -E 's/^\[\[//; s/\]\]$//; s/[|#].*$//' | sort -u || true)"
if [ -n "$links" ]; then
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    printf '%s\n' "$valid_targets" | grep -Fxq "$link" || err "unresolved wikilink: [[$link]]"
  done <<EOF
$links
EOF
fi

secret_hits="$(grep -RInE '(/Users/[^/ ]+/\.(codex|claude|pi).*(sessions|projects|transcripts)|/home/[^/ ]+/\.(codex|claude|pi).*(sessions|projects|transcripts)|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|[A-Z0-9_]{8,}=(secret|token|password))' kb ref docs AGENTS.md CLAUDE.md README.md _meta/*.md 2>/dev/null || true)"
if [ -n "$secret_hits" ]; then
  err "possible secret or raw transcript path found:"
  printf '%s\n' "$secret_hits" >&2
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

printf 'validate-kb: ok\n'
