#!/bin/bash
# QA-2 harness: isolated QA dashboard + staging HTTP for the layout suite.
# The suite itself is tests/qa/layout_suite.py, executed inside the Hermes
# browser harness (browser_exec) — this script only provides what the
# browser cannot reach otherwise: the QA server and a LAN staging dir.
#
#   scripts/qa-suite.sh start   # serve --qa (isolated base) + staging :8797
#   scripts/qa-suite.sh stop
#   scripts/qa-suite.sh status
#
# Staging dir contents (regenerated on start, world-readable ON THE LAN):
#   layout_suite.py   the suite source (fetched + exec'd by the browser)
#   qa_manifest.json  {base_url, qa_key} — qa_key is the RANDOM key of the
#                     throwaway QA instance, never the production one.
set -euo pipefail

REPO="${QA2_REPO:-$HOME/git/omlx-uplift-repo}"
PORT="${QA2_PORT:-8099}"
STAGE_PORT="${QA2_STAGE_PORT:-8797}"
STAGE="$HOME/hermes/TMP/qa2-staging"
QA_PY="/opt/homebrew/opt/omlx/libexec/bin/python"
LOG="$HOME/hermes/TMP/qa2-serve.log"
PIDF="$HOME/hermes/TMP/qa2.pids"

ip() { ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1; }

status() {
  local qa stage
  qa=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/uplift/" || true)
  stage=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$STAGE_PORT/layout_suite.py" || true)
  echo "qa :$PORT -> $qa | staging :$STAGE_PORT -> $stage"
}

stop() {
  if [ -f "$PIDF" ]; then
    while read -r pid name; do
      kill "$pid" 2>/dev/null && echo "stopped $name ($pid)" || true
    done < "$PIDF"
    rm -f "$PIDF"
  fi
}

case "${1:-}" in
  start)
    mkdir -p "$STAGE"
    cp "$REPO/tests/qa/layout_suite.py" "$STAGE/layout_suite.py"
    # (re)start the isolated QA server; seeding happens inside --qa and is
    # a no-op once ~/.omlx-qa/settings.json exists
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/uplift/" || true)" != "401" ]; then
      # exec inside the subshell: otherwise $! is the wrapper and stop
      # leaves the python child orphaned on the port (observed QA-2)
      (cd "$REPO" && exec env PYTHONPATH=. "$QA_PY" -m omlx_uplift.cli serve --qa --port "$PORT") \
        > "$LOG" 2>&1 &
      echo "$! qa-server" >> "$PIDF.tmp"
      for _ in $(seq 1 30); do
        [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/uplift/" || true)" = "401" ] && break
        sleep 1
      done
    fi
    # manifest: key read locally from the QA settings (never printed)
    "$QA_PY" - "$PORT" "$STAGE/qa_manifest.json" <<'PYEOF'
import json, sys
from pathlib import Path
port, out = int(sys.argv[1]), sys.argv[2]
s = json.loads((Path.home() / ".omlx-qa/settings.json").read_text())
Path(out).write_text(json.dumps({
    "base_url": f"http://{__import__('subprocess').run(['ipconfig','getifaddr','en0'],capture_output=True,text=True).stdout.strip() or '127.0.0.1'}:{port}",
    "qa_key": s["auth"]["api_key"]}))
PYEOF
    python3 -m http.server "$STAGE_PORT" --bind 0.0.0.0 --directory "$STAGE" \
      > "$HOME/hermes/TMP/qa2-stage.log" 2>&1 &
    echo "$! staging-http" >> "$HOME/hermes/TMP/qa2.pids"
    [ -f "$PIDF.tmp" ] && { cat "$PIDF.tmp" >> "$PIDF"; rm -f "$PIDF.tmp"; }
    status
    ;;
  stop) stop; status ;;
  sync) cp "$REPO/tests/qa/layout_suite.py" "$STAGE/layout_suite.py"
        echo "staged $(wc -c < "$STAGE/layout_suite.py") bytes (suite v?)" ;;
  status) status ;;
  *) echo "usage: qa-suite.sh start|sync|stop|status" >&2; exit 2 ;;
esac
