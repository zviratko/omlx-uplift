"""PROCESS-LOG-1 (user 2026-10-18: 'the patch process log does not contain
any information about successful patches, only useless past information').

Pins:
  1. the full milestone stream — header, clone/origin, per-patch apply with
     method + file count + commit sha, brew exit line — lands in
     dev-install.log, not only on the console;
  2. enabled RUNTIME-scope patches are named in the build log with their
     reason for absence (the 'three patches? one commit?' confusion);
  3. the previous build rotates to dev-install.log.1 (the file describes
     the build that just happened);
  4. _sanitize strips the terminal escape junk brew leaks into piped
     stdout ([?1000;2$y-style mode queries/responses).
"""
import os

import pytest

from omlx_uplift import devsrc, patches as patches_mod


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path / "uplift"))
    return tmp_path


def _cfg(tmp_path, monkeypatch, **over):
    cfg = {"src_path": str(tmp_path / "dev-src"), "sync_ref": "origin/main",
           "formula_branch": "uplift-dev", "origin": "file:///fake/omlx.git"}
    cfg.update(over)
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: dict(cfg))
    return cfg


def _pipeline(home, monkeypatch, commits=None, manifest=None):
    """run_dev_build with the git/patch steps stubbed to a successful
    materialize — what is under test is the LOG, not git."""
    _cfg(home, monkeypatch)
    (home / "dev-src" / ".git").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
    monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda cfg: None)
    from omlx_uplift import patchsource, curated
    monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
    monkeypatch.setattr(patchsource, "enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(patchsource, "mark_upstreamed_if_merged",
                        lambda store, c: {})
    monkeypatch.setattr(patchsource, "mark_dev_applied",
                        lambda store, commits, **kw: None)
    # regate reads stored diffs — out of scope for a log test
    monkeypatch.setattr(devsrc, "_build_patches_from_commits",
                        lambda commits, ps: [])
    monkeypatch.setattr(devsrc, "recheck_build_patches",
                        lambda gated: {})

    class _Store:
        def load(self_inner):
            return {"patches": (manifest or {}).get("patches", [])}
    monkeypatch.setattr(patches_mod, "PatchStore", lambda *a, **k: _Store())
    monkeypatch.setattr(
        devsrc, "materialize",
        lambda patches, cfg, **kw: {"ok": True, "tip": "e" * 40,
                                    "base": "b" * 40,
                                    "branch": "uplift-dev",
                                    "commits": commits if commits is not None
                                    else [{"id": "p-x", "v": 1,
                                           "files": 2, "sha": "a" * 40}]})


def test_milestones_reach_the_log(home, monkeypatch):
    _pipeline(home, monkeypatch)
    r = devsrc.run_dev_build(dry_run=True)
    assert r.ok, r.lines
    text = open(r.log_path).read()
    assert "=== omlx-uplift dev build" in text
    assert "trigger cli" in text
    assert "dev-src clone:" in text and "file:///fake/omlx.git" in text
    assert "branch uplift-dev re-cut from bbbbbbbbbbbb" in text
    # WHAT landed: patch, version, mechanism, file count, resulting commit
    assert "APPLIED p-x v1" in text
    assert "patch -p1-style apply" in text
    assert "2 file(s) -> commit aaaaaaaaaaaa" in text
    # the file is self-describing about its own location
    assert "patch process log:" in text


def test_runtime_scope_absence_is_explained(home, monkeypatch):
    manifest = {"patches": [
        {"id": "ctx-probe-above-native", "enabled": True, "scope": "omlx"},
        {"id": "quiet-disabled", "enabled": False, "scope": "omlx"},
    ]}
    _pipeline(home, monkeypatch, commits=[], manifest=manifest)
    r = devsrc.run_dev_build(dry_run=True)
    text = open(r.log_path).read()
    assert ("ctx-probe-above-native [omlx]: runtime patch" in text
            and "never part of the omlx-dev build" in text)
    # KEG-VERSIONED visibility (user 2026-10-20): the note names the LIVE
    # state — an entry with no applied record on the active tree must say
    # so instead of the vague 'mounts at server start'.
    assert any(s == "out"
               and "runtime patch — not yet mounted; lands at the next "
                   "server start" in t
               for s, t in r.lines)
    assert "quiet-disabled" not in text


def test_runtime_patch_applied_in_active_keg_says_so(home, monkeypatch):
    from omlx_uplift import brewutil, patches as patches_mod

    kid = "site-packages:cafebabe00000000"
    monkeypatch.setattr(brewutil, "keg_site_packages", lambda f: "/tmp/sp")
    monkeypatch.setattr(patches_mod, "keg_id", lambda p: kid)
    manifest = {"patches": [{
        "id": "bench-force-tg", "enabled": True, "scope": "omlx",
        "versions": [{"v": 1, "kegs": {kid: {"status": "applied"}}}],
    }]}
    _pipeline(home, monkeypatch, commits=[], manifest=manifest)
    r = devsrc.run_dev_build(dry_run=True)
    assert any(s == "out" and "bench-force-tg [omlx]: runtime patch — "
                              "APPLIED in the active keg" in t
               for s, t in r.lines), r.lines


def test_upstreamed_build_patch_is_announced(home, monkeypatch):
    # user report 2026-10-19: a patch the drift check proved upstream now
    # carries (state obsolete) left the build set BEFORE materialize and the
    # console said nothing — the '+1 commit' header looked like a lost patch.
    manifest = {"patches": [
        {"id": "qwen4-mtpfix", "enabled": True, "scope": "both",
         "state": "obsolete"},
        {"id": "no-version", "enabled": True, "scope": "dev",
         "state": "pending"},
    ]}
    _pipeline(home, monkeypatch, commits=[], manifest=manifest)
    r = devsrc.run_dev_build(dry_run=True)
    text = open(r.log_path).read()
    out_lines = [t for s, t in r.lines if s == "out"]
    assert any("qwen4-mtpfix [both]: UPSTREAMED" in t
               and "NOT rebuilt into this branch" in t
               and "marked obsolete" in t for t in out_lines), out_lines
    assert any("no-version [dev]: enabled build patch absent" in t
               for t in out_lines), out_lines
    assert "UPSTREAMED" in text and "no-version" in text


def test_previous_build_rotates_out_of_the_way(home, monkeypatch):
    _pipeline(home, monkeypatch)
    r1 = devsrc.run_dev_build(dry_run=True)
    first = open(r1.log_path).read()
    r2 = devsrc.run_dev_build(dry_run=True)
    current = open(r2.log_path).read()
    prev = r1.log_path + ".1"
    assert os.path.exists(prev)
    assert current.count("=== omlx-uplift dev build") == 1, \
        "the log must describe THIS build, history goes to .1"
    assert first.count("=== omlx-uplift dev build") == 1


def test_sanitize_strips_brew_escape_junk():
    raw = ("==> Reinstalling zviratko/uplift/omlx-dev --with-custom-kernel "
           "\x1b[?1000;2$y\x1b[?64;1;2;4;6;17;18;21;22;52cwith-grammar")
    out = devsrc._sanitize(raw)
    assert "\x1b" not in out
    assert out.endswith("with-grammar")
    assert "--with-custom-kernel" in out
