#!/bin/bash
# Install or refresh local .obsidian/ from versioned defaults.
# Local-only state stays gitignored; defaults live under _meta/obsidian/defaults/.
set -euo pipefail

if [ -n "${ALAMBIC_ROOT:-}" ]; then
  ROOT="$ALAMBIC_ROOT"
else
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
fi

DEFAULTS="$ROOT/_meta/obsidian/defaults"
TARGET="$ROOT/.obsidian"
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

if [ ! -d "$DEFAULTS" ]; then
  printf 'bootstrap-obsidian: missing defaults at %s\n' "$DEFAULTS" >&2
  exit 1
fi

mkdir -p "$TARGET"
copied=0
skipped=0
for src in "$DEFAULTS"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dest="$TARGET/$name"
  if [ -f "$dest" ] && [ "$FORCE" -ne 1 ]; then
    skipped=$((skipped + 1))
    continue
  fi
  cp "$src" "$dest"
  copied=$((copied + 1))
done

# Optional theme hook (Omarchy); never required for health.
if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/current/theme/obsidian.css" ]; then
  mkdir -p "$TARGET/themes/Omarchy"
  if [ ! -f "$TARGET/themes/Omarchy/manifest.json" ]; then
    cat >"$TARGET/themes/Omarchy/manifest.json" <<'EOF'
{
  "name": "Omarchy",
  "version": "1.0.0",
  "minAppVersion": "0.16.0",
  "description": "Automatically syncs with your current Omarchy system theme colors and fonts",
  "author": "Omarchy",
  "authorUrl": "https://omarchy.org"
}
EOF
  fi
  cp "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/current/theme/obsidian.css" "$TARGET/themes/Omarchy/theme.css"
fi

printf 'bootstrap-obsidian: copied=%s skipped=%s target=%s\n' "$copied" "$skipped" "$TARGET"
printf 'Open vault: obsidian "obsidian://open?path=%s"\n' "$ROOT"
