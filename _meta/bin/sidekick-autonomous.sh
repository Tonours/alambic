#!/usr/bin/env bash
# Local sidekick helper. Default is dry-run so a laptop cannot race the
# GitHub Actions writer (`alambic-sidekick-daily`).
# Opt-in local apply: ALAMBIC_SIDEKICK_APPLY=1 (emergency only).
# Never prints secrets. Never freeform-creates kb notes. Never pushes.

set -euo pipefail

ROOT="${ALAMBIC_ROOT:-$(cd -- "$(dirname -- "$0")/../.." && pwd -P)}"
cd "$ROOT"

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
export ALAMBIC_STATE_DIR="${ALAMBIC_STATE_DIR:-${XDG_STATE_HOME}/alambic}"

LOG_PREFIX="[sidekick]"
MAX_ACTIONS="${ALAMBIC_SIDEKICK_MAX:-8}"
MAX_FREEFORM="${ALAMBIC_SIDEKICK_MAX_FREEFORM:-3}"
APPLY="${ALAMBIC_SIDEKICK_APPLY:-0}"
# 0 = dry-run (default); 1 = structural+freeform oracle promote (races CI)
MODE="${ALAMBIC_SIDEKICK_MODE:-all}"

obv() {
  "${ROOT}/_meta/alambic" "$@"
}

# Distinct from obv(): materialize must not permanently shadow the CLI wrapper.
# Later sidekick / validate / lint / graph calls need the unprefixed command.
obv_attention() {
  "${ROOT}/_meta/alambic" attention "$@"
}

mkdir -p "${ALAMBIC_STATE_DIR}/sidekick"

echo "${LOG_PREFIX} start $(date -u +%Y-%m-%dT%H:%M:%SZ) root=${ROOT} mode=${MODE}"

# 1) Health first — refuse apply when red
if ! obv validate --mode strict >/dev/null; then
  echo "${LOG_PREFIX} validate red — abort apply; writing dry-run report only"
  obv sidekick run --dry-run --json --max "${MAX_ACTIONS}" >"${ALAMBIC_STATE_DIR}/sidekick/last-dry.json" 2>/dev/null || true
  exit 1
fi

# 2) Attention → materialize promote-ready (best-effort). Full collect needs local OAuth.
#    Set ALAMBIC_SIDEKICK_ATTENTION=1 to run collect+stage+compile+materialize first.
#    Set ALAMBIC_SIDEKICK_ATTENTION=materialize to only promote-suggest --confirm from existing queue.
if [[ "${ALAMBIC_SIDEKICK_ATTENTION:-0}" == "1" ]]; then
  if [[ -x "${ROOT}/_meta/bin/attention-daily-grok.sh" ]]; then
    echo "${LOG_PREFIX} attention full pipeline (collect → materialize → will sidekick after)"
    # Prevent nested sidekick inside attention-daily (we run sidekick below).
    ALAMBIC_ATTENTION_SIDEKICK=0 "${ROOT}/_meta/bin/attention-daily-grok.sh" \
      || echo "${LOG_PREFIX} attention non-fatal fail"
  fi
elif [[ "${ALAMBIC_SIDEKICK_ATTENTION:-0}" == "materialize" ]]; then
  echo "${LOG_PREFIX} attention materialize only (existing queue → promote-ready)"
  obv_attention promote-suggest --confirm --json || echo "${LOG_PREFIX} materialize non-fatal fail"
fi

# 3) Autonomy apply
if [[ "${APPLY}" != "1" ]]; then
  echo "${LOG_PREFIX} dry-run only (ALAMBIC_SIDEKICK_APPLY=0)"
  obv sidekick run --dry-run --max "${MAX_ACTIONS}" --json \
    | tee "${ALAMBIC_STATE_DIR}/sidekick/last-run.json" \
    | head -c 4000
  echo
elif [[ "${MODE}" == "structural" ]]; then
  echo "${LOG_PREFIX} apply-structural max=${MAX_ACTIONS}"
  obv sidekick run --apply-structural --max "${MAX_ACTIONS}" --json \
    | tee "${ALAMBIC_STATE_DIR}/sidekick/last-run.json" \
    | head -c 4000
  echo
else
  echo "${LOG_PREFIX} apply-all (structural+freeform) max=${MAX_ACTIONS} freeform=${MAX_FREEFORM}"
  obv sidekick run --apply-all --max "${MAX_ACTIONS}" --max-freeform "${MAX_FREEFORM}" --json \
    | tee "${ALAMBIC_STATE_DIR}/sidekick/last-run.json" \
    | head -c 4000
  echo
fi

# 4) Final health
obv validate --mode strict
obv lint --check >/dev/null || echo "${LOG_PREFIX} lint warnings present (non-fatal for orphans/gaps)"
obv graph --force >/dev/null || true

echo "${LOG_PREFIX} done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
