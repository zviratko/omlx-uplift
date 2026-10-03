#!/bin/bash
# QA-2: proof that a deploy actually landed, as one exit code.
# Catches the failure modes we actually hit (2026-10-03):
#   - keg rebuilt from an old tap checkout (stale SHA served as "deployed")
#   - QA server having persisted port 8099 into production settings.json
#   - service running but serving stale static bytes (old process alive)
#
#   scripts/verify-deploy.sh [port] [expected-sha]
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

PORT="${1:-8011}"
HOST="http://127.0.0.1:$PORT"
REPO="${QA2_REPO:-$HOME/git/omlx-uplift-repo}"
SETTINGS="$HOME/.omlx/settings.json"
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

# 2. production settings port is the port we are verifying
p="$(python3 -c "import json;print(json.load(open('$SETTINGS'))['server']['port'])" 2>/dev/null)"
if [ "$p" = "$PORT" ]; then ok settings-port "$p"; else bad settings-port "$p (want $PORT)"; fi

# 3. login for the byte checks (cookie jar, key never printed)
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
key="$(python3 -c "import json;print(json.load(open('$SETTINGS'))['auth']['api_key'])")"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$HOST/uplift/login" \
  -H 'Content-Type: application/json' -d "{\"api_key\":\"$key\"}")
if [ "$code" = "200" ]; then ok login "$code"; else bad login "$code"; fi

# 4. served static bytes == repo tree at EXPECTED (proves keg content AND
#    that the running process actually serves that keg)
for f in uplift.css uplift_mmeditor.js uplift_dirty.js uplift.js; do
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
