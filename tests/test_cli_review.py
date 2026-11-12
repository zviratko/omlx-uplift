"""CLI-REVIEW (user 2026-11-12): plain-word output for the patch and dev
verbs (raw JSON behind --json), short argparse errors, complete help, no em
dashes in the help text, unfinished builds marked in `dev kegs`."""
import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import pytest

from omlx_uplift import cli, cliview, help as helpmod


def _cap(fn, *a, **k):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = fn(*a, **k)
    return rc, out.getvalue(), err.getvalue()


def test_bad_action_is_one_short_error(monkeypatch):
    with pytest.raises(SystemExit) as ex:
        _cap(cli.cmd_patches, ["bogus"])
    assert ex.value.code == 2
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err), \
            pytest.raises(SystemExit):
        cli.cmd_dev(["bogus"])
    text = err.getvalue()
    assert "unknown action 'bogus'" in text
    assert "see: omlx-uplift help dev" in text
    assert "--with-custom-kernel" not in text        # no usage wall
    assert len(text.splitlines()) == 2


def test_help_lists_every_patch_and_dev_action():
    import re
    src = open(cli.__file__, encoding="utf-8").read()
    for cmd in ("patch", "dev"):
        m = re.search(r'_Parser\(prog="omlx-uplift %s"\).*?choices=\[(.*?)\]'
                      % cmd, src, re.S)
        verbs = set(re.findall(r'"([a-z-]+)"', m.group(1)))
        verbs -= {"auto-build"}              # internal: the boot hook's worker
        usage = helpmod.COMMAND_USAGE[cmd]
        missing = {v for v in verbs if v not in usage}
        assert not missing, f"help {cmd} omits {sorted(missing)}"


def test_help_text_has_no_em_dash():
    blob = "\n".join(d for _, d in helpmod.COMMANDS)
    blob += "\n".join(helpmod.COMMAND_USAGE.values())
    assert "\u2014" not in blob


def test_action_ok_and_failure_words():
    rc, out, err = _cap(cliview.action, "promote", "p1",
                        {"ok": True, "state": "pending",
                         "desired_version": 3})
    assert rc == 0 and "p1: now uses the newest stored version" in out
    assert "v3" in out and not err
    gate = {"ok": False, "stage": "gate", "reason": "one or more files failed",
            "files": [{"path": "a.py", "status": "fail",
                       "reason": "context mismatch — strict"},
                      {"path": "b.py", "status": "already"}]}
    rc, out, err = _cap(cliview.action, "update", "p1", gate)
    assert rc == 1 and not out
    assert "p1: update failed" in err
    assert "FAIL  a.py  context mismatch" in err
    assert "1 other file(s) already contain these changes" in err


def test_check_report_words():
    payload = {"target": "dev", "reports": {
        "a": {"check": "up_to_date"},
        "b": {"check": "update_available", "v": 2, "promoted": True},
        "c": {"check": "update_available", "v": 4, "promoted": False,
              "reason": "v4 is stored but not in use - press Promote"},
        "d": {"check": "error", "reason": "one or more files failed",
              "files": [{"path": "x.py", "status": "fail",
                         "reason": "context mismatch"}]}}}
    rc, out, _ = _cap(cliview.check_reports, "patch check", payload)
    assert rc == 1
    assert "UP TO DATE" in out and "UPDATE v2" in out and "adopted" in out
    assert "press Promote" in out and "x.py" in out


def test_patch_verb_json_flag_keeps_the_raw_payload(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path))
    monkeypatch.setattr(cli, "_patch_targets",
                        lambda store, t: ("omlx", [], ["omlx"]))
    rc, out, _ = _cap(cli.cmd_patches, ["promote", "ghost", "--json"])
    assert rc == 1 and json.loads(out)["ok"] is False
    rc, out, err = _cap(cli.cmd_patches, ["promote", "ghost"])
    assert rc == 1 and not out and "ghost: promote failed" in err


def test_dev_kegs_marks_an_unfinished_build(monkeypatch):
    from omlx_uplift import kegstash
    rows = [{"name": "20261112.195030.675ebdf", "cellar_name":
             "20261112.195030.675ebdf", "stashed_at": "", "bytes": 0,
             "source": "cellar"},
            {"name": "20261112.174511.81b89f1", "cellar_name":
             "20261112.174511.81b89f1",
             "stashed_at": "2026-11-12T17:49:53+00:00", "bytes": 2**31,
             "source": "cellar"}]
    monkeypatch.setattr(kegstash, "list_builds", lambda: rows)
    monkeypatch.setattr(kegstash, "active_keg",
                        lambda: "20261112.174511.81b89f1")
    rc, out, _ = _cap(cli.cmd_dev, ["kegs"])
    assert rc == 0
    lines = out.splitlines()
    assert "unfinished" in lines[1]
    assert "2026-11-12 17:49" in lines[2] and "running build" in lines[2]
    rc, out, _ = _cap(cli.cmd_dev, ["kegs", "--json"])
    assert [r["active"] for r in json.loads(out)] == [False, True]


def test_dev_status_words_and_json(monkeypatch):
    from omlx_uplift import devsrc, kegstash, patchsource
    cfg = {"built_sha": "a" * 40, "port": 8001}
    st = {"installed": True, "tip": "a" * 40, "base": "b" * 40,
          "sync_ref": "upstream/main", "ahead": 1, "behind": 0,
          "patch_commits": [{"id": "p1", "v": 2, "sha": "a" * 40}],
          "drift": {"drift": False}}
    monkeypatch.setattr(devsrc, "load_config", lambda *a: cfg)
    monkeypatch.setattr(devsrc, "status", lambda *a, **k: st)
    monkeypatch.setattr(patchsource, "enabled_build_patches",
                        lambda *a, **k: [])
    monkeypatch.setattr(patchsource, "build_residue_pool",
                        lambda *a, **k: [])
    monkeypatch.setattr(kegstash, "active_keg", lambda: "BUILD-X")
    rc, out, _ = _cap(cli.cmd_dev, ["status"])
    assert rc == 0
    assert "current (BUILD-X)" in out and "p1" in out and "next:" not in out
    rc, out, _ = _cap(cli.cmd_dev, ["status", "--json"])
    assert json.loads(out)["tip"] == "a" * 40
    monkeypatch.setattr(devsrc, "load_config", lambda *a: None)
    rc, out, err = _cap(cli.cmd_dev, ["status"])
    assert rc == 1 and "omlx-uplift dev install" in err


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))
