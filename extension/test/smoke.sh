#!/usr/bin/env bash
# Usage: B=... bash test/smoke.sh [workspace]   (ANVIL_E2E=1 to also run Task A against TrueForge)
set -euo pipefail
B=${B:-/mnt/volume_blr1_1795277818626/forgeathon}
export npm_config_cache=$B/cache/npm BUN_INSTALL_CACHE_DIR=$B/cache/bun TMPDIR=$B/tmp XDG_CACHE_HOME=$B/cache
mkdir -p "$TMPDIR"
cd "$(dirname "$0")/.."
WS=${1:-$B/flask}
node esbuild.mjs >/dev/null
export ANVIL_WS=$WS
export ANVIL_TEST_OUT=${ANVIL_TEST_OUT:-$TMPDIR/anvil-smoke.json}
if [ -x "$B/vscode/VSCode-linux-x64/code" ]; then export ANVIL_VSCODE=$B/vscode/VSCode-linux-x64/code; fi
xvfb-run -a -s "-screen 0 1600x1000x24" node test/runSmoke.js
cat "$ANVIL_TEST_OUT"
