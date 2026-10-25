"""BUILD-1 (user 2026-10-09): the DEV superscript beside the wordmark.

GET /dev/build-info answers what the built omlx-dev keg tracks — the omlx
base commit + version and the enabled build-scope patch ids — from FILE
READS ONLY (no fetch, no worktree replay, no rev-list on the happy path),
because it renders on every dashboard boot.

Contract this test pins:
  * no dev.json            -> {'installed': False} (header shows no badge)
  * any exception          -> {'installed': False}, never a raised 500
  * built_base receipt     -> that sha is the base (cheap path)
  * no built_base          -> falls back to base_sha_of (pin/sync-ref aware)
  * patch list             -> the SAME eligibility rule as materialization
                              (enabled_build_patches, with_bytes=False)
"""
import pytest
import re

from omlx_uplift.routers import dev as dev_mod
from omlx_uplift.routers import patches as patches_mod


def _stub(monkeypatch, cfg, patches=None, base_sha_of=None, omlx_ver="0.7.0"):
    from omlx_uplift import devsrc, patchsource

    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(patches_mod, "patch_store", lambda: object())
    seen = {}

    def fake_patches(store, with_bytes=True):
        seen["with_bytes"] = with_bytes
        return patches or []

    monkeypatch.setattr(patchsource, "enabled_build_patches", fake_patches)
    if base_sha_of is not None:
        monkeypatch.setattr(devsrc, "base_sha_of", lambda c: base_sha_of)
    monkeypatch.setattr(dev_mod, "_omlx_running_version", lambda: omlx_ver)
    return seen


def test_no_config_is_not_installed(monkeypatch):
    from omlx_uplift import devsrc

    monkeypatch.setattr(devsrc, "load_config", lambda: None)
    assert dev_mod._dev_build_info_sync() == {"installed": False}


def test_receipt_base_and_patch_ids(monkeypatch):
    cfg = {"built_base": "0b07e88" + "0" * 33, "built_sha": "fbf19d2" + "0" * 33,
           "sync_ref": "upstream/main",
           "built_at": "2026-10-20T13:30:19+00:00"}
    patches = [{"id": "pr4206-personal", "version": 2}, {"id": "other", "version": 1}]
    seen = _stub(monkeypatch, cfg, patches)
    from omlx_uplift import kegstash

    monkeypatch.setattr(kegstash, "active_keg",
                        lambda *a, **k: "20261020.133019.7240c46")
    out = dev_mod._dev_build_info_sync()
    assert out["installed"] is True
    assert out["base_sha"] == cfg["built_base"]
    assert out["built_sha"] == cfg["built_sha"]
    # KEG-VERSIONED: the badge names the ACTIVE KEG (build stamp + commit)
    # and when it was built — the header line users read to answer
    # 'which binary is this board running?'
    assert out["keg"] == "20261020.133019.7240c46"
    assert out["built_at"] == "2026-10-20T13:30:19+00:00"
    assert out["omlx_version"] == "0.7.0"
    assert [p["id"] for p in out["patches"]] == ["pr4206-personal", "other"]
    # THE cheap contract: enumerate without reading any diff file
    assert seen["with_bytes"] is False


def test_badge_js_prefers_the_keg_name():
    import os

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = os.path.join(root, "omlx_uplift", "static", "uplift_boot.js")
    src = open(p, encoding="utf-8").read()
    assert "d.keg || d.base_sha" in src.replace("\n", " ").replace("  ", " ") \
        or "!(d.keg || d.base_sha)" in src
    assert "main.textContent = d.keg" in src
    # line 2 of the build column (user 2026-10-20 added it, 2026-10-21 put
    # it right under the keg stamp): built in JS, anchored to the
    # superscript box by the absolute .logo-base rule in CSS
    assert "bl.className = 'logo-base'" in src
    assert "el.append(bl)" in src  # rides the build column, not the logo
    css = open(os.path.join(root, "omlx_uplift", "static", "uplift.css"),
               encoding="utf-8").read()
    assert ".logo .logo-build .logo-base {" in css and "top: calc(100% + 2px)" in css
    # the column's single vertical knob: the whole stamp+version pair is
    # centred on the wordmark line (user 2026-10-21) — moving the box
    # moves both sub-lines with it
    assert "top: calc(-0.5em - 5px)" in css
    # the skin suffix (::after, e.g. artelight's ': WARM') centres on that
    # pair once BOTH lines are painted: JS arms the trigger, CSS lifts the
    # pseudo to the full 16px wordmark line box (specificity 0-2-1 beats a
    # skin's own .logo::after shorthand) and opens a gutter so the tagline
    # cannot sit on the version line (measured 9x7px overlap, 2026-10-25).
    # Pinned by selector + declarations, not the whole line: the pair of
    # declarations is expected to grow, the geometry contract is not.
    assert "classList.add('has-build-lines')" in src
    pair_rule = re.search(r"\.logo\.has-build-lines::after\s*\{([^}]*)\}", css)
    assert pair_rule, "the DEV-pair suffix rule is gone — a skin tagline will " \
        "sit on top of the version line again"
    assert "line-height: 16px" in pair_rule.group(1)
    assert re.search(r"margin-left:\s*(1[0-9]|2[0-9])px", pair_rule.group(1)), \
        "suffix gutter must be >=10px; Chrome's 6px default put the tagline " \
        "9px under the version line"
    # the version line stays clip-capable and JS bounds it to the gutter
    assert "max-width" in re.search(
        r"\.logo \.logo-build \.logo-base\s*\{([^}]*)\}", css).group(1)
    assert "getComputedStyle(el.parentElement, '::after')" in src \
        and "bl.style.maxWidth" in src
    # DEAD CONTRACTS (user 2026-10-21): the 'N patches' header row and the
    # U23 reserved 36px tagline strip must not come back — the tagline is
    # a single nowrap line, patch ids live in the tooltip/patches page
    assert "lb-patches" not in src and "lb-patches" not in css
    assert "has-tagline" not in css
    assert "layoutTaglineBand" not in open(os.path.join(
        root, "omlx_uplift", "static", "uplift.js"), encoding="utf-8").read()


def test_auto_update_label_no_vanilla_tail():
    # the DEV (target) dropdown owns the what-tracks-what story now; the
    # flag label says cause + effect only (user 2026-10-20)
    import glob
    import json as _json
    import os

    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "omlx_uplift", "locales", "*.json")
    key = "uplift.patches.dev_auto_label"
    for f in glob.glob(base):
        v = _json.load(open(f, encoding="utf-8"))[key]
        assert v and "anilla" not in v, f
    en = _json.load(open(os.path.join(os.path.dirname(base.replace('*.json', '')), "en.json"), encoding="utf-8"))
    assert en[key] == "AUTO UPDATE — REBUILD OMLX-DEV WHEN UPSTREAM MOVES"


def test_pin_beats_sync_ref_when_no_receipt(monkeypatch):
    # DEV-7 semantic: base_pin set (personal lane) must be what the badge
    # names, NOT the sync-ref tip — the sync-ref path would show a commit
    # the keg does not track.
    cfg = {"base_pin": "abcd123" + "0" * 33, "sync_ref": "upstream/main"}
    _stub(monkeypatch, cfg, base_sha_of=cfg["base_pin"])
    out = dev_mod._dev_build_info_sync()
    assert out["base_sha"] == cfg["base_pin"]


def test_sync_ref_fallback_used(monkeypatch):
    cfg = {"sync_ref": "upstream/main"}
    _stub(monkeypatch, cfg, base_sha_of="9f9f9f9" + "0" * 33)
    out = dev_mod._dev_build_info_sync()
    assert out["base_sha"] == "9f9f9f9" + "0" * 33


def test_broken_state_never_raises(monkeypatch):
    from omlx_uplift import devsrc

    def boom():
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(devsrc, "load_config", boom)
    assert dev_mod._dev_build_info_sync() == {"installed": False}


def test_omlx_version_probe_survives_missing_package():
    # viewer mode / tests without omlx installed: a version of None is an
    # honest answer, the badge then just omits the version bit
    v = dev_mod._omlx_running_version()
    assert v is None or isinstance(v, str)


def test_route_is_importable_and_admin_gated():
    from omlx_uplift import router

    assert callable(router.dev_build_info)
    # the FastAPI signature keeps the Depends(require_admin) parameter
    import inspect

    params = inspect.signature(router.dev_build_info).parameters
    assert "is_admin" in params
