#!/bin/bash
# CI-GUARD watcher (corrected form — see references/ci-guard.md for why).
# Usage: ci-watch.sh [sha] [or: <repo> [sha]]   exit 0 green / 1 red / 3 never appeared / 4 query error
# Arg parsing is by SHAPE (the 2026-10-19 false 'QUERY FAILED' was a bare
# SHA landing in $1=REPO): a positional carrying non-hex characters is the
# repo, a pure-hex one of >=7 chars is the SHA.
set -u
REPO="zviratko/omlx-uplift"
SHA=""
for a in "$@"; do
  case "$a" in
    *[!0-9a-fA-F]*) REPO="$a" ;;          # owner/repo: has / or -
    *) [ ${#a} -ge 7 ] && SHA="$a" ;;     # bare hex: a commit SHA
  esac
done
SHA="${SHA:-$(git rev-parse HEAD)}"
for i in $(seq 1 90); do
  # startswith: accepts short AND full SHAs (gh reports 40-char headSha;
  # an exact compare against a 7-char abbreviation matched nothing and
  # the loop would have lied 'NO RUN')
  J=$(gh run list -R "$REPO" -L 15 --json headSha,status,conclusion \
        --jq "[.[] | select(.headSha | startswith(\"$SHA\"))]" 2>/dev/null)
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
