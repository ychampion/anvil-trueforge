#!/usr/bin/env bash
# Waits until the Modal endpoint in the secrets file actually serves GET /models, then re-runs setup.mjs so
# provider "modal" (and "modal-fallback") point at it instead of the stub.
# Usage: wait-for-modal.sh [secrets-file]   (default $B/secrets/modal.env)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
F="${1:-${B:-/mnt/volume_blr1_1795277818626/forgeathon}/secrets/modal.env}"
while true; do
  if [ -s "$F" ]; then
    set -a; . "$F"; set +a
    code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${MODAL_LLM_API_KEY:-}" "${MODAL_LLM_BASE_URL%/}/models" || true)
    if [ "$code" = "200" ]; then break; fi
  fi
  sleep 30
done
echo "$(date) $MODAL_LLM_BASE_URL is live, running setup.mjs"
ANVIL_SECRETS_FILE="$F" node "$HERE/setup.mjs"
# End-to-end check on the real model: an anvil-coder turn must reach a gated edit_file approval.
# Results: $B/spike/out-real/allow.summary.json (approvals[] non-empty = pass). The MCP on 7391 should be read-only.
if [ -d "$HERE/spike/node_modules" ]; then
  cd "$HERE/spike" && SPIKE_OUT="${B:-/mnt/volume_blr1_1795277818626/forgeathon}/spike/out-real" \
    SPIKE_PROMPT="In src/flask/helpers.py, add a one-line docstring to the function get_debug_flag if it lacks one, otherwise improve its docstring wording. Use edit_file." \
    timeout 900 node approval-spike.mjs allow
fi
