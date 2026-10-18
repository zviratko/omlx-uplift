"""VERIFY-MOUNT-DEADLOCK (mruu 2026-10-18): the install mount-check probe
must never wedge the parent.

Old shape: subprocess.run(capture_output=True, timeout=...) — when the
importing child left grandchildren holding the capture pipes, run()'s
timeout-kill path blocked in communicate() FOREVER (user saw an
uncancellable hang after both .pth lines had already installed fine).
New shape: pipeless probe — verdict rides UPLIFT_PROBE_FILE, stdio goes to
DEVNULL, timeout kills the whole process group. Tests drive it with fake
'python' executables; no real omlx import needed."""
import os
import stat
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from omlx_uplift.cli import _verify_mount  # noqa: E402

import pytest  # noqa: E402


def _fake_python(tmp_path, body):
    p = tmp_path / "fakepython"
    p.write_text("#!/bin/sh\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def test_verdict_1_passes(tmp_path):
    exe = _fake_python(tmp_path, 'echo 1 > "$UPLIFT_PROBE_FILE"; exit 0')
    assert _verify_mount(exe, timeout=20) == (True, "")


def test_verdict_0_names_the_consequence(tmp_path):
    exe = _fake_python(tmp_path, 'echo 0 > "$UPLIFT_PROBE_FILE"; exit 0')
    ok, detail = _verify_mount(exe, timeout=20)
    assert not ok and "404" in detail


def test_import_blowup_rides_the_file(tmp_path):
    exe = _fake_python(tmp_path,
                       "printf 'E%s' \"RuntimeError('boom')\" "
                       "> \"$UPLIFT_PROBE_FILE\"; exit 0")
    ok, detail = _verify_mount(exe, timeout=20)
    assert not ok and "boom" in detail


def test_no_verdict_is_honest(tmp_path):
    exe = _fake_python(tmp_path, "exit 3")
    ok, detail = _verify_mount(exe, timeout=20)
    assert not ok and "no verdict" in detail and "3" in detail


def test_hanging_probe_times_out_and_kills_the_group(tmp_path):
    # the OLD deadlock shape: a background grandchild that outlives the
    # direct child. Pipeless + killpg => bounded wall time, killed group.
    marker = tmp_path / "grandchild"
    exe = _fake_python(tmp_path,
                       f"( sleep 120 & echo $! > {marker}.pid; "
                       f"trap 'kill $!' EXIT; wait ) &\n"
                       "sleep 120")
    t0 = time.monotonic()
    ok, detail = _verify_mount(exe, timeout=2)
    elapsed = time.monotonic() - t0
    assert not ok and "timed out" in detail
    assert elapsed < 15, f"probe wedged for {elapsed:.1f}s"
    pid_file = str(marker) + ".pid"
    if os.path.exists(pid_file):
        try:
            pid = int(open(pid_file).read().strip())
            os.kill(pid, 0)
            alive = True
        except OSError:
            alive = False
        if alive:
            subprocess.run(["pkill", "-P", str(pid)], capture_output=True)
            # the grandchild may linger only if it escaped the session —
            # start_new_session must have put EVERYTHING in one group:
            pytest.fail("grandchild survived the group kill")
