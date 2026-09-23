#!/bin/zsh
# Optional local technical-attention helper. Not a scheduler and not the kb
# writer — GitHub Actions `alambic-sidekick-daily` writes kb/.
# Optional Grok headless orchestration, then ALWAYS the deterministic CLI path
# so YouTube collect + stage cannot be skipped when Grok exits 0 early.
# Never prints secrets, tokens, or cookies.

set -euo pipefail

ROOT="${ALAMBIC_ROOT:-$(cd -- "$(dirname -- "$0")/../.." && pwd -P)}"
cd "$ROOT"

LOG_PREFIX="[attention-daily]"
RECEIPT_NOTE="daily-runner"
GROK_BIN="${GROK_BIN:-$(command -v grok || true)}"
PROMPT_FILE="${ROOT}/_meta/prompts/attention-daily-grok.md"
MAX_TURNS="${ALAMBIC_ATTENTION_GROK_MAX_TURNS:-8}"
USE_GROK="${ALAMBIC_ATTENTION_USE_GROK:-1}"

# Load local credential overrides without echoing them.
if [[ -f "${HOME}/.zshrc" ]]; then
  # shellcheck disable=SC1090
  source "${HOME}/.zshrc" >/dev/null 2>&1 || true
fi

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

obv() {
  "${ROOT}/_meta/alambic" attention "$@"
}

content_free_receipt() {
  local run_status="$1"
  local note="$2"
  obv receipt --status "$run_status" --note "$note" --json >/dev/null 2>&1 || true
}

# Deterministic path: status → YouTube collect → X drop → Chrome dry → stage → receipt.
# Always invoked after optional Grok so collect/stage cannot be skipped.
run_deterministic_pipeline() {
  local note_suffix="${1:-ensure}"
  echo "${LOG_PREFIX} deterministic pipeline (${note_suffix})"
  obv status --json || true

  # Scheduled-ready unattended sources when env OAuth is present.
  if obv collect --source youtube-liked --summary --json; then
    :
  else
    echo "${LOG_PREFIX} youtube collect failed; continuing" >&2
  fi

  # X bookmarks via X API v2 (env ALAMBIC_X_*); falls to blocked-auth if unset.
  if obv collect --source x-bookmarks --summary --json; then
    :
  else
    echo "${LOG_PREFIX} x-bookmarks collect failed or blocked; continuing" >&2
  fi

  # Optional X drop-folder: NDJSON exports placed by human (supplement / fallback).
  local drop_dir="${ROOT}/docs/inbox/ai/attention-drop/x-bookmarks"
  if [[ -d "$drop_dir" ]]; then
    local f
    for f in "$drop_dir"/*.ndjson(N) "$drop_dir"/*.jsonl(N); do
      [[ -f "$f" ]] || continue
      echo "${LOG_PREFIX} x-drop: $(basename "$f")"
      if obv ingest --source x-bookmarks --stdin --persist --confirm --summary --json <"$f"; then
        mkdir -p "${drop_dir}/processed"
        mv "$f" "${drop_dir}/processed/$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$f")"
      else
        echo "${LOG_PREFIX} x-drop ingest failed for $(basename "$f")" >&2
      fi
    done
  fi

  # Chrome multi-device: foreign originator visits only (local cache_guid excluded).
  if obv collect --source chrome-history --summary --json; then
    :
  else
    echo "${LOG_PREFIX} chrome-history collect failed or unsupported; continuing" >&2
  fi

  # Stage promote candidates under docs/inbox/ai/ (never kb/ without oracle sidekick).
  obv stage --json || true

  # Compile high-signal synthesis for LLM session start (inbox only; never kb/).
  if obv compile --json; then
    :
  else
    echo "${LOG_PREFIX} compile failed; continuing" >&2
  fi

  # Materialize freeform-oracle-ready drafts for sidekick (https sources only).
  if obv promote-suggest --confirm --json; then
    :
  else
    echo "${LOG_PREFIX} promote-suggest/materialize failed; continuing" >&2
  fi

  # Default off: GHA `alambic-sidekick-daily` is the kb writer. Local apply races CI.
  if [[ "${ALAMBIC_ATTENTION_SIDEKICK:-0}" == "1" ]]; then
    echo "${LOG_PREFIX} sidekick apply-all after attention materialize (emergency local write)"
    if "${ROOT}/_meta/alambic" sidekick run --apply-all --max 12 --max-freeform 3 --json; then
      :
    else
      echo "${LOG_PREFIX} sidekick after attention non-fatal fail" >&2
    fi
  fi

  content_free_receipt "ok" "${RECEIPT_NOTE}-${note_suffix}"
  echo "${LOG_PREFIX} deterministic pipeline complete (${note_suffix})"
}

run_grok() {
  if [[ -z "$GROK_BIN" || ! -x "$GROK_BIN" ]]; then
    echo "${LOG_PREFIX} grok binary missing; skip headless"
    return 1
  fi
  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "${LOG_PREFIX} prompt missing at ${PROMPT_FILE}; skip headless"
    return 1
  fi
  echo "${LOG_PREFIX} grok headless orchestrator (max-turns=${MAX_TURNS})"
  # --prompt-file alone triggers headless mode; do not combine with empty -p/--single.
  # Do not pass secrets on argv.
  if "$GROK_BIN" --cwd "$ROOT" --max-turns "$MAX_TURNS" --always-approve --prompt-file "$PROMPT_FILE"; then
    content_free_receipt "ok" "${RECEIPT_NOTE}-grok"
    return 0
  fi
  echo "${LOG_PREFIX} grok headless failed" >&2
  return 1
}

main() {
  echo "${LOG_PREFIX} start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local grok_ok=0
  if [[ "$USE_GROK" == "1" ]]; then
    if run_grok; then
      grok_ok=1
      echo "${LOG_PREFIX} grok path exited 0 (still ensuring YouTube+stage)"
    else
      echo "${LOG_PREFIX} grok path skipped or failed; ensuring via CLI"
    fi
  else
    echo "${LOG_PREFIX} USE_GROK=0; CLI-only ensure"
  fi
  # CRITICAL: always ensure collect/stage regardless of Grok exit status.
  if [[ "$grok_ok" -eq 1 ]]; then
    run_deterministic_pipeline "ensure-after-grok"
  else
    run_deterministic_pipeline "fallback"
  fi
}

main "$@"
