#!/usr/bin/env bash
# Start TrueForge in local (standalone, SQLite) mode for Anvil.
# Usage: ./start-local.sh            (foreground)
#        ./start-local.sh --daemon   (background in tmux session "trueforge", survives logout; waits until ready)
# Env:   TF_DATA_DIR  where SQLite + app data live   (default: ./.trueforge-data next to this script)
#        TF_PORT      listen port                    (default: 8790, bound to 127.0.0.1)
#        TF_VERSION   pinned TrueForge npm version   (default: 0.185.1)
# Then:  node setup.mjs   (registers model providers, the anvil-editor MCP connector and the saved agents)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_VERSION="${TF_VERSION:-0.185.1}"
TF_PORT="${TF_PORT:-8790}"
TF_DATA_DIR="${TF_DATA_DIR:-$HERE/.trueforge-data}"
mkdir -p "$TF_DATA_DIR/home" "$TF_DATA_DIR/cache"

if [[ "${1:-}" == "--daemon" ]]; then
  LOG="$TF_DATA_DIR/trueforge.log"
  tmux kill-session -t trueforge 2>/dev/null || true
  tmux new-session -d -s trueforge \
    "exec env TF_VERSION='$TF_VERSION' TF_PORT='$TF_PORT' TF_DATA_DIR='$TF_DATA_DIR' bash '$HERE/start-local.sh' >> '$LOG' 2>&1"
  echo "TrueForge $TF_VERSION starting in tmux session 'trueforge' on http://127.0.0.1:$TF_PORT (log: $LOG)"
  for _ in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$TF_PORT/api/v1/capabilities" >/dev/null; then echo "ready"; exit 0; fi
    sleep 2
  done
  echo "not ready after 180 s; see $LOG" >&2; exit 1
fi

export SQLITE_PATH="$TF_DATA_DIR/trueforge.sqlite"
export PORT="$TF_PORT" HOST=127.0.0.1
# The model endpoint stub, the broken endpoint (Task C) and the Anvil MCP server all live on loopback;
# TrueForge's outbound URL guard blocks loopback/private hosts unless they are allow-listed.
export OUTBOUND_URL_ALLOWED_HOSTS="${OUTBOUND_URL_ALLOWED_HOSTS:-[\"127.0.0.1\",\"localhost\"]}"
# Model calls: Modal can cold-start, so allow up to 3 min for response headers; 2 internal retries (TrueForge default).
export MODEL_HTTP_CONNECT_TIMEOUT_MS="${MODEL_HTTP_CONNECT_TIMEOUT_MS:-5000}"
export MODEL_HTTP_HEADERS_TIMEOUT_MS="${MODEL_HTTP_HEADERS_TIMEOUT_MS:-180000}"
export MODEL_HTTP_MAX_RETRIES="${MODEL_HTTP_MAX_RETRIES:-2}"
# MCP tool calls can wait on the per-hunk review in the editor and on test runs: allow 10 min.
export MCP_REQUEST_TIMEOUT_MS="${MCP_REQUEST_TIMEOUT_MS:-600000}"
# Keep every write (npm cache, XDG app data) inside the data dir. TMPDIR stays short: TrueForge's
# code-mode unix socket path must be <= 65 bytes.
export HOME="$TF_DATA_DIR/home" XDG_DATA_HOME="$TF_DATA_DIR/home/.local/share" \
       XDG_CONFIG_HOME="$TF_DATA_DIR/home/.config" XDG_CACHE_HOME="$TF_DATA_DIR/cache" \
       npm_config_cache="${npm_config_cache:-$TF_DATA_DIR/cache/npm}"
export TMPDIR="${TF_TMPDIR:-/tmp}"

exec npx -y "@truefoundry/trueforge@$TF_VERSION" --port "$TF_PORT"
