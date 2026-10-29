#!/bin/bash
# QA-2: proof that a deploy actually landed, as one exit code.
# Catches the failure modes we actually hit (2026-10-03):
#   - keg rebuilt from an old tap checkout (stale SHA served as "deployed")
#   - QA server having persisted port 8099 into production settings.json
#   - service running but serving stale static bytes (old process alive)
#
#   scripts/verify-deploy.sh [port] [expected-sha]
#   With no port: the board whose settings.json exists (.omlx, then .omlx-dev),
#   on the port that file declares. UPLIFT_VERIFY_SETTINGS points it at a
#   specific file; a deploy gate names the port explicitly.
# Default expected-sha = the INSTALLED keg's revision: the standing
# question is "is the running service serving what is installed" (a
# service can be alive on old bytes after a partial reinstall, and the
# QA incidents proved the port can drift). Nightly runs it this way, so
# it stays green between merge and deploy. A deploy gate passes the sha
# EXPLICITLY (verify-deploy.sh 8011 "$(git rev-parse --short=7 HEAD)")
# to demand the newest code. The api_key is substituted from
# settings.json by the shell; it never appears in output. Static routes
# require the session cookie, so all byte comparisons run authenticated
# against the LIVE service — served bytes must equal the git tree at the
# expected revision. Exit 0 = all checks passed.
set -uo pipefail

# Which board to verify: the one whose settings exist. DEC-1 (2026-10) left this
# box dev-only, and this script went on asking for a vanilla settings.json and a
# server on 8011 that no longer exist - six nights of ok:false from a stage that
# never actually reached the running board. Vanilla stays first (historic box),
# the dev keg second, and an explicit path wins over both.
REPO="${QA2_REPO:-$HOME/git/omlx-uplift-repo}"
SETTINGS="${UPLIFT_VERIFY_SETTINGS:-}"
if [ -z "$SETTINGS" ]; then
    for cand in "$HOME/.omlx/settings.json" "$HOME/.omlx-dev/settings.json"; do
        [ -f "$cand" ] && SETTINGS="$cand" && break
    done
fi
if [ -z "$SETTINGS" ]; then
    echo "FAIL no board to verify (neither ~/.omlx nor ~/.omlx-dev has a settings.json)"
    exit 1
fi
# The port comes from that file unless the caller names one: a stale port written
# into settings must not be able to hide the check behind a default.
SETTINGS_PORT="$(python3 -c "import json;print(json.load(open('$SETTINGS'))['server']['port'])" 2>/dev/null)"
PORT="${1:-$SETTINGS_PORT}"
if [ -z "$PORT" ]; then
    echo "FAIL $SETTINGS carries no server.port and no port was passed"
    exit 1
fi
HOST="http://127.0.0.1:$PORT"
INSTALLED="$(brew list --versions omlx-uplift | awk '{print $2}')"
EXPECTED="${2:-${INSTALLED#HEAD-}}"
fail=0
ok()  { printf 'PASS %-28s %s\n' "$1" "$2"; }
bad() { printf 'FAIL %-28s %s\n' "$1" "$2"; fail=1; }

# 1. installed keg is at the expected revision
case "$INSTALLED" in
  *"$EXPECTED") ok keg-revision "$INSTALLED" ;;
  *) bad keg-revision "$INSTALLED (want *$EXPECTED)" ;;
esac

# 2. the settings file agrees with the port being verified (the QA2 incident
#    class: a test server's port persisted into production settings)
if [ "$SETTINGS_PORT" = "$PORT" ]; then
    ok settings-port "$PORT ($(basename "$(dirname "$SETTINGS")"))"
else
    bad settings-port "$SETTINGS_PORT in $SETTINGS, verifying $PORT"
fi

# 3. login for the byte checks (cookie jar, key never printed)
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
key="$(python3 -c "import json;print(json.load(open('$SETTINGS'))['auth']['api_key'])")"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$HOST/uplift/login" \
  -H 'Content-Type: application/json' -d "{\"api_key\":\"$key\"}")
if [ "$code" = "200" ]; then ok login "$code"; else bad login "$code"; fi

# 4. served static bytes == repo tree at EXPECTED (proves keg content AND
#    that the running process actually serves that keg)
for f in uplift.css uplift_mmeditor.js uplift_dirty.js uplift_gsys.js uplift.js; do
  served=$(curl -s -b "$JAR" "$HOST/uplift/$f" | shasum -a 256 | cut -d' ' -f1)
  want=$(git -C "$REPO" show "$EXPECTED:omlx_uplift/static/$f" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  if [ -z "$served" ] || [ "$served" != "$want" ]; then
    bad "static $f" "served != $EXPECTED tree"
  else
    ok "static $f" "matches $EXPECTED"
  fi
done

[ "$fail" = 0 ] && echo "deploy verified: $HOST @ $EXPECTED" || echo "DEPLOY NOT VERIFIED"
exit "$fail"
