#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCES="$ROOT/_meta/youtube-knowledge-sources.tsv"
DAYS=10
MAX_VIDEOS=50
PER_CHANNEL=8
DRY_RUN=0
RUN_DATE=$(date +%F)

usage() {
  cat <<'EOF'
Usage: _meta/youtube-weekly-collector.sh [options]

Options:
  --days N           Keep videos published in the last N days (default: 10)
  --max-videos N     Maximum new candidates to inspect (default: 50)
  --per-channel N    Latest feed entries inspected per channel (default: 8)
  --run-date DATE    Output date in YYYY-MM-DD format (default: today)
  --dry-run          Resolve and deduplicate candidates without downloading captions
  --help             Show this help

The collector writes source material only. It never edits kb/, ref/, Git state,
Obsidian, automation configuration, or external systems.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --days) DAYS=${2:?missing value}; shift 2 ;;
    --max-videos) MAX_VIDEOS=${2:?missing value}; shift 2 ;;
    --per-channel) PER_CHANNEL=${2:?missing value}; shift 2 ;;
    --run-date) RUN_DATE=${2:?missing value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$DAYS:$MAX_VIDEOS:$PER_CHANNEL" in
  *[!0-9:]*|0:*|*:0:*|*:0) echo "numeric options must be positive integers" >&2; exit 2 ;;
esac

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi
if [ ! -f "$SOURCES" ]; then
  echo "missing source catalog: $SOURCES" >&2
  exit 1
fi

STATE_ROOT=${ALAMBIC_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/alambic}/youtube-weekly
umask 077
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_ROOT" 2>/dev/null || true
WORK=$(mktemp -d "$STATE_ROOT/collector.XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

INVENTORY="$WORK/inventory.tsv"
ERRORS="$WORK/channel-errors.log"
EXISTING="$WORK/existing-ids.txt"
CANDIDATES="$WORK/candidates.tsv"
SELECTED="$WORK/selected.tsv"
STAGE="$WORK/stage"
mkdir -p "$STAGE"
printf 'category\thandle\ttier\tid\ttitle\n' > "$INVENTORY"
: > "$ERRORS"

tail -n +2 "$SOURCES" | while IFS=$'\t' read -r category handle tier source_status rationale; do
  [ "$source_status" = enabled ] || continue
  format="$category"$'\t'"$handle"$'\t'"$tier"$'\t''%(id)s'$'\t''%(title)s'
  yt-dlp --flat-playlist --playlist-end "$PER_CHANNEL" --no-warnings \
    --print "$format" "https://www.youtube.com/@${handle}/videos" \
    >> "$INVENTORY" 2>> "$ERRORS" || true
done

{
  find "$ROOT/docs" -type f -name manifest.tsv -print0 2>/dev/null \
    | xargs -0 awk -F '\t' 'FNR>1 { print $2 }' 2>/dev/null || true
  find "$ROOT/docs" -type f -name coverage.tsv -print0 2>/dev/null \
    | xargs -0 awk -F '\t' 'FNR>1 && ($7 == "transcribed" || $7 == "existing_corpus") { print $2 }' 2>/dev/null || true
} | sed -E 's#.*(youtu\.be/|v=)([A-Za-z0-9_-]{11}).*#\2#' \
  | awk 'length($0) == 11' | sort -u > "$EXISTING"

awk -F '\t' 'NR==FNR { seen[$1]=1; next }
  FNR>1 && !seen[$4] && !candidate[$4]++ { print }' \
  "$EXISTING" "$INVENTORY" > "$CANDIDATES"

# Inspect primary sources before practitioner/tutorial sources and discovery-only
# channels. Stable sorting preserves catalog order within a tier.
LC_ALL=C sort -s -t $'\t' -k3,3n "$CANDIDATES" | head -n "$MAX_VIDEOS" > "$SELECTED"

inventory_count=$(awk 'END { print NR-1 }' "$INVENTORY")
candidate_count=$(awk 'END { print NR+0 }' "$CANDIDATES")
selected_count=$(awk 'END { print NR+0 }' "$SELECTED")
error_count=$(grep -c '^ERROR:' "$ERRORS" 2>/dev/null || true)

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'status\tdry-run\n'
  printf 'inventory\t%s\nnew_candidates\t%s\nselected\t%s\nchannel_errors\t%s\n' \
    "$inventory_count" "$candidate_count" "$selected_count" "$error_count"
  cat "$SELECTED"
  exit 0
fi

if [ "$selected_count" -eq 0 ]; then
  printf 'status\tno-op\nreason\tno-new-video-ids\ninventory\t%s\nchannel_errors\t%s\n' \
    "$inventory_count" "$error_count"
  exit 0
fi

cut -f4 "$SELECTED" | xargs -n 1 -P 4 sh -c '
  id="$1"
  yt-dlp --skip-download --write-subs --write-auto-subs \
    --sub-langs "en-orig,en" --sub-format json3 --write-info-json \
    --extractor-args "youtube:player_client=android" --no-warnings \
    --ignore-errors -o "'$STAGE'/%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v=$id" >"'$STAGE'/$id.log" 2>&1 || true
' _

if cutoff=$(date -v-"${DAYS}"d +%Y%m%d 2>/dev/null); then :; else
  cutoff=$(date -d "$DAYS days ago" +%Y%m%d)
fi
today=$(date +%Y%m%d)
RUN_PARENT="$ROOT/docs/youtube-weekly-runs"
FINAL="$RUN_PARENT/$RUN_DATE"
if [ -e "$FINAL" ]; then
  echo "run output already exists: $FINAL" >&2
  exit 1
fi
TMP_RUN="$RUN_PARENT/.tmp-${RUN_DATE}-$$"
mkdir -p "$TMP_RUN/txt"

printf 'path\turl\tcategory\thandle\ttier\tresolved_channel\tpublished_at\tacquired_at\tsha256\ttrust\tlicense_retention\n' > "$TMP_RUN/manifest.tsv"
printf 'category\thandle\ttier\tid\tfeed_title\tresolved_channel\tresolved_title\tpublished_at\tstatus\ttranscript_source\n' > "$TMP_RUN/coverage.tsv"
: > "$TMP_RUN/INDEX.txt"

transcribed=0
outside_window=0
unavailable=0
while IFS=$'\t' read -r category handle tier id feed_title; do
  info="$STAGE/$id.info.json"
  resolved_channel=unknown
  resolved_title="$feed_title"
  raw_date=unknown
  if [ -f "$info" ]; then
    resolved_channel=$(jq -r '.channel // "unknown"' "$info" | tr '\t\r\n' '   ')
    resolved_title=$(jq -r '.title // "unknown"' "$info" | tr '\t\r\n' '   ')
    raw_date=$(jq -r '.upload_date // "unknown"' "$info")
  fi
  if echo "$raw_date" | grep -Eq '^[0-9]{8}$'; then
    published_at=$(printf '%s-%s-%s' "${raw_date%????}" "${raw_date#????}" "" | sed -E 's/^([0-9]{4})-([0-9]{2})([0-9]{2})-$/\1-\2-\3/')
  else
    published_at=unknown
  fi
  caption=""
  source_lang=none
  if [ -f "$STAGE/$id.en-orig.json3" ]; then caption="$STAGE/$id.en-orig.json3"; source_lang=en-orig
  elif [ -f "$STAGE/$id.en.json3" ]; then caption="$STAGE/$id.en.json3"; source_lang=en
  fi

  if ! echo "$raw_date" | grep -Eq '^[0-9]{8}$' || [ "$raw_date" -lt "$cutoff" ] || [ "$raw_date" -gt "$today" ]; then
    coverage_state=outside_window
    outside_window=$((outside_window + 1))
  elif [ -z "$caption" ]; then
    coverage_state=unavailable_caption
    unavailable=$((unavailable + 1))
  else
    safe_title=$(printf '%s' "$resolved_title" | sed -E 's#[/\\:*?"<>|]#-#g; s/[[:space:]]+/ /g; s/^ +| +$//g' | cut -c1-150)
    filename="${published_at}_${id}_${safe_title}.txt"
    transcript_file="$TMP_RUN/txt/$filename"
    jq -r '[.events[]? | ([.segs[]?.utf8] | join("") | gsub("\\n"; " ") | gsub("[[:space:]]+"; " ") | select(length > 0))] | join(" ")' "$caption" > "$transcript_file"
    if [ -s "$transcript_file" ]; then
      coverage_state=transcribed
      rel="txt/$filename"
      digest=$(shasum -a 256 "$transcript_file" | awk '{print $1}')
      printf '%s\thttps://www.youtube.com/watch?v=%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tuntrusted-public\tunknown; local-research-only\n' \
        "$rel" "$id" "$category" "$handle" "$tier" "$resolved_channel" "$published_at" "$RUN_DATE" "$digest" >> "$TMP_RUN/manifest.tsv"
      printf '%s\n' "$rel" >> "$TMP_RUN/INDEX.txt"
      transcribed=$((transcribed + 1))
    else
      rm -f "$transcript_file"
      coverage_state=empty_caption
      unavailable=$((unavailable + 1))
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$category" "$handle" "$tier" "$id" "$feed_title" "$resolved_channel" \
    "$resolved_title" "$published_at" "$coverage_state" "$source_lang" >> "$TMP_RUN/coverage.tsv"
done < "$SELECTED"

sort -o "$TMP_RUN/INDEX.txt" "$TMP_RUN/INDEX.txt"
cat > "$TMP_RUN/README.md" <<EOF
# Weekly YouTube knowledge intake — $RUN_DATE

- Window: last $DAYS days
- Feed entries inspected: $inventory_count
- New candidate IDs before cap: $candidate_count
- Candidates inspected after cap: $selected_count
- New transcripts retained: $transcribed
- Candidates outside window after metadata resolution: $outside_window
- Unavailable captions or metadata: $unavailable
- Channel feed errors: $error_count

This directory is untrusted source material. Durable knowledge must be
deduplicated, verified, and compiled separately into kb/.
EOF
if [ -s "$ERRORS" ]; then cp "$ERRORS" "$TMP_RUN/channel-errors.log"; fi

if [ "$transcribed" -eq 0 ]; then
  rm -rf "$TMP_RUN"
  printf 'status\tno-op\nreason\tno-new-transcripts-in-window\ninventory\t%s\nselected\t%s\noutside_window\t%s\nunavailable\t%s\nchannel_errors\t%s\n' \
    "$inventory_count" "$selected_count" "$outside_window" "$unavailable" "$error_count"
  exit 0
fi

mv "$TMP_RUN" "$FINAL"
printf 'status\tcollected\nrun_dir\t%s\ninventory\t%s\nnew_candidates\t%s\nselected\t%s\ntranscribed\t%s\noutside_window\t%s\nunavailable\t%s\nchannel_errors\t%s\n' \
  "$FINAL" "$inventory_count" "$candidate_count" "$selected_count" "$transcribed" \
  "$outside_window" "$unavailable" "$error_count"
