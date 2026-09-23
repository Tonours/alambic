#!/bin/bash
set -euo pipefail
SCAN="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/leak-scan.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir "$T/vault"
printf 'acme\n' > "$T/patterns"
printf '# public slug\ngithub:acme/x\n' > "$T/vault/.leak-allow"
scan() { GIT_CEILING_DIRECTORIES="$T" ALAMBIC_LEAK_PATTERNS_FILE="$T/patterns" "$SCAN" "$T/vault" >/dev/null 2>&1; }
fail() { printf 'leak-allow: %s\n' "$1" >&2; exit 1; }
printf 'npx github:acme/x init\n' > "$T/vault/a.md"
scan || fail 'allowed string was flagged'
printf 'npx github:acme/x by Acme\n' > "$T/vault/a.md"
scan && fail 'marker next to an allowed string passed'
printf 'npx github:acme/x\n' > "$T/vault/a.md"
printf 'hello acme\n' > "$T/vault/b.md"
scan && fail 'marker in another file passed'
rm "$T/vault/b.md" "$T/vault/.leak-allow"
scan && fail 'allowed string passed without .leak-allow'
rm "$T/vault/a.md"
tail=$(printf 'a%.0s' {1..24})
printf 'task-%s desk-%s\n' "$tail" "$tail" > "$T/vault/c.md"
scan || fail 'word ending in sk- was flagged as a secret'
printf 'key sk-%s\n' "$tail" > "$T/vault/c.md"
scan && fail 'standalone sk- token passed'
printf 'key=gh''p_%s\n' "$tail" > "$T/vault/c.md"
scan && fail 'gh token after = passed'
printf 'leak-allow: ok\n'
