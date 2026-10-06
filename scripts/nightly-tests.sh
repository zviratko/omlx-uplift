#!/bin/sh
# CI-2: nightly full-suite run for omlx-uplift on kocour — plain launchd,
# zero LLM involvement (design constraint 2026-10-02: nothing runs the
# laptop inference unattended). Runs the README 'Development' recipe:
# keg-python pytest (clone BEFORE keg on PYTHONPATH) + node --check +
# node --test, then appends one JSON line per night to
# ~/.omlx/uplift/reports/nightly.jsonl. Last failing run keeps its full
# output in nightly-last-failure.log next to it.
#
# Manual:  scripts/nightly-tests.sh
# Install: launchctl load ~/Library/LaunchAgents/sh.zviratko.uplift-nightly.plist
set -u

REPO="${UPLIFT_NIGHTLY_REPO:-$HOME/git/omlx-uplift-repo}"
REPORT_DIR="$HOME/.omlx/uplift/reports"
JSONL="$REPORT_DIR/nightly.jsonl"
FAILLOG="$REPORT_DIR/nightly-last-failure.log"
PYLIBS="$HOME/hermes/TMP/pylibs"
KEG_PY="/opt/homebrew/opt/omlx/libexec/bin/python"
LOG=$(mktemp /tmp/uplift-nightly.XXXXXX)

mkdir -p "$REPORT_DIR"
cd "$REPO" || { echo "cd $REPO failed" >>"$JSONL.failures"; exit 1; }

updated=no
if git fetch -q origin 2>>"$LOG"; then
    before=$(git rev-parse HEAD)
    if git pull --ff-only -q origin main >>"$LOG" 2>&1; then
        after=$(git rev-parse HEAD)
        [ "$before" != "$after" ] && updated=yes
    else
        echo "WARN: git pull --ff-only failed (diverged? offline?); testing local HEAD" >>"$LOG"
    fi
else
    echo "WARN: git fetch failed (offline?); testing local HEAD" >>"$LOG"
fi

# one-time helper libs (system python3 lacks pytest); keg pip if missing
if ! "$KEG_PY" -c "import pytest" 2>/dev/null; then
    PYTHONPATH="$PYLIBS" "$KEG_PY" -c "import pytest" 2>/dev/null || \
        /opt/homebrew/opt/omlx/libexec/bin/pip install -q --target "$PYLIBS" \
        pytest pytest-asyncio >>"$LOG" 2>&1
fi

pytest_out=$(PYTHONPATH="$PYLIBS:$REPO" "$KEG_PY" -m pytest tests -q 2>&1)
rc_pytest=$?
# SYNC-1: the settings-drift gate needs a classic checkout. Keep a plain
# upstream mirror fresh (best-effort ff; offline keeps the last snapshot)
# and point OMLX_SRC at it so globalspec.test.cjs runs INSTEAD OF SKIPPING —
# upstream adding a settings key raises ok:false, not a silent skip:3.
UPSTREAM="$HOME/git/omlx-upstream"
if [ -d "$UPSTREAM/.git" ]; then
    git -C "$UPSTREAM" fetch -q origin main 2>/dev/null \
        && git -C "$UPSTREAM" merge -q --ff-only FETCH_HEAD 2>/dev/null \
        || echo "WARN: omlx-upstream ff failed; drift gate uses last snapshot" >&2
    export OMLX_SRC="$UPSTREAM"
fi
# NOTE: `node --check a.js b.js` checks ONLY THE FIRST FILE (verified on
# node v26: a syntax error in the second file still exits 0). The
# globbing form the README used before was a silent no-op for everything
# after core.js — loop explicitly.
rc_check=0
check_out=""
for f in omlx_uplift/static/*.js; do
    out=$(node --check "$f" 2>&1) || { rc_check=1; check_out="$check_out$f: $out\n"; }
done
node_out=$(node --test tests/*.cjs 2>&1)
rc_node=$?
[ $rc_check -ne 0 ] && node_out="$check_out\n$node_out"

# QA-2 C: production drift check — is the RUNNING service serving what is
# INSTALLED, on the right port? Default expected-sha mode (the installed
# keg itself), so a merge without a deploy does not raise a nightly
# alarm; port drift, dead service, or old bytes in a live process do.
verify_out=$(bash scripts/verify-deploy.sh 2>&1)
rc_verify=$?

# KEGID-2: tree census — installed omlx files vs the wheel RECORD. Catches
# the corruption class verify-deploy cannot see (verify proves the SERVER
# serves what the KEG holds; it never checks the keg against its own
# manifest). Read-only hashing, zero inference (CI-3 rule).
doctor_out=$(PYTHONPATH="$REPO" "$KEG_PY" -m omlx_uplift.cli doctor 2>&1)
rc_doctor=$?

# counts: pytest tail line '544 passed, 2 warnings in 29s' style;
# node --test summary 'ℹ tests N / pass N / fail N / skipped N'
p_pass=$(printf '%s' "$pytest_out" | grep -oE '[0-9]+ passed' | tail -1 | cut -d' ' -f1)
p_fail=$(printf '%s' "$pytest_out" | grep -oE '[0-9]+ failed' | tail -1 | cut -d' ' -f1)
p_skip=$(printf '%s' "$pytest_out" | grep -oE '[0-9]+ skipped' | tail -1 | cut -d' ' -f1)
n_pass=$(printf '%s' "$node_out" | grep -E '^ℹ pass' | tail -1 | awk '{print $3}')
n_fail=$(printf '%s' "$node_out" | grep -E '^ℹ fail' | tail -1 | awk '{print $3}')
n_skip=$(printf '%s' "$node_out" | grep -E '^ℹ skipped' | tail -1 | awk '{print $3}')
: "${p_pass:=0}" "${p_fail:=0}" "${p_skip:=0}" "${n_pass:=0}" "${n_fail:=0}" "${n_skip:=0}"

ok=true
[ "$rc_pytest" -ne 0 ] && ok=false
[ "$rc_node" -ne 0 ] && ok=false
[ "$rc_check" -ne 0 ] && ok=false
[ "$rc_verify" -ne 0 ] && ok=false
[ "$rc_doctor" -ne 0 ] && ok=false
sha=$(git rev-parse --short HEAD)
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)

upd_bool=false; [ "$updated" = yes ] && upd_bool=true
line="{\"date\":\"$date\",\"sha\":\"$sha\",\"updated\":$upd_bool,\"ok\":$ok,\"rc_pytest\":$rc_pytest,\"rc_check\":$rc_check,\"rc_node\":$rc_node,\"rc_verify\":$rc_verify,\"rc_doctor\":$rc_doctor,\"pytest\":{\"pass\":$p_pass,\"fail\":$p_fail,\"skip\":$p_skip},\"node\":{\"pass\":$n_pass,\"fail\":$n_fail,\"skip\":$n_skip}}"
printf '%s\n' "$line" >>"$JSONL"

if [ "$ok" != true ]; then
    {
        echo "=== $date sha=$sha ==="
        echo "--- pytest ---"; printf '%s\n' "$pytest_out"
        echo "--- node ---"; printf '%s\n' "$node_out"
        echo "--- verify-deploy ---"; printf '%s\n' "$verify_out"
        echo "--- doctor ---"; printf '%s\n' "$doctor_out"
    } >"$FAILLOG"
fi
rm -f "$LOG"
$ok
