#!/bin/bash
# CI-GUARD watcher (corrected form — see references/ci-guard.md for why).
# Usage: ci-watch.sh <repo> [sha]   exit 0 green / 1 red / 3 never appeared
set -u
REPO="${1:-zviratko/omlx-uplift}"
SHA="${2:-$(git rev-parse HEAD)}"
for i in $(seq 1 90); do
  J=$(gh run list -R "$REPO" -L 15 --json headSha,status,conclusion \
        --jq "[.[] | select(.headSha==\"$SHA\")]" 2>/dev/null)
  N=$(printf '%s' "$J" | jq 'length' 2>/dev/null)
  case "${N:-}" in ''|*[!0-9]*)
    echo "QUERY FAILED for ${SHA:0:7} (gh/jq error, not a CI failure)" >&2
    exit 4 ;;
  esac
  if [ "$N" -gt 0 ]; then
    D=$(printf '%s' "$J" | jq '[.[]|select(.status=="completed")]|length')
    B=$(printf '%s' "$J" | jq '[.[]|select(.status=="completed" and .conclusion!="success")]|length')
    if [ "$D" = "$N" ]; then
      echo "CI for ${SHA:0:7}: $D/$N runs completed, $B failed"
      [ "$B" = 0 ] && exit 0 || exit 1
    fi
  elif [ "$i" -gt 30 ]; then   # 10 min and no run ever appeared
    echo "NO RUN for ${SHA:0:7} after $((i * 20))s — push may not have triggered CI" >&2
    exit 3
  fi
  sleep 20
done
echo "CI TIMEOUT for $SHA"; exit 2
