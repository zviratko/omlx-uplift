# SPDX-License-Identifier: Apache-2.0
"""Skin system tests (design v1 section 9).

Covers: extraction idempotence, never-overwrite, file-wins-over-crate-map,
malformed YAML skip + reason, unknown keys ignored, skin_version gate,
traversal rejection (names, '..', symlink), value-shape validation,
theme.css ETag/304, resource content-type matrix + nosniff, stale listing
flags, classic mapping incl. bg-luminance default, CLI round-trip byte
equality of resources.
"""
import base64
import os
import re
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import omlx.server  # noqa: F401 - same import-order convention as other API tests
from omlx_uplift import skins
from omlx_uplift import router as up

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

CRATE = """skin_version: 1
label: "Night Watch"
classic:
  theme: dark
  enhanced: false
tokens:
  bg: "#14151a"
  card: "#1c1d24"
  accent: "#57e38a"
icons:
  caret.png: "%s"
css: |
  .badge.Complete { border-style: double; }
""" % base64.b64encode(PNG_1PX).decode()


@pytest.fixture(autouse=True)
def _no_cache():
    skins.invalidate_caches()
    yield
    skins.invalidate_caches()


@pytest.fixture
def root(tmp_path):
    d = tmp_path / "skins"
    d.mkdir()
    return d


def drop(root, name, text=None, mtime=None):
    p = root / f"{name}.yml"
    p.write_text(text if text is not None else CRATE, encoding="utf-8")
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


# --------------------------------------------------------------- extraction

def test_extraction_creates_dir_and_is_idempotent(root):
    drop(root, "night", mtime=1_762_070_400)
    entries = skins.list_skins(root)
    d = root / "night-1762070400"
    assert d.is_dir()
    assert (d / "skin.yml").read_text() == CRATE
    assert (d / "overlay.css").read_text().strip() == \
        ".badge.Complete { border-style: double; }"
    assert (d / "icons" / "caret.png").read_bytes() == PNG_1PX
    # second scan changes nothing
    first = {p: p.stat().st_mtime_ns for p in sorted(d.rglob("*"))}
    time.sleep(0.01)
    skins.list_skins(root)
    after = {p: p.stat().st_mtime_ns for p in sorted(d.rglob("*"))}
    assert first == after
    assert [e["name"] for e in skins.list_skins(root)] == ["night"]


def test_never_overwrite_existing_dir(root):
    drop(root, "night", mtime=1_762_070_400)
    skins.list_skins(root)
    d = root / "night-1762070400"
    (d / "icons" / "caret.png").write_bytes(b"HAND_EDITED")
    # same mtime again: dir must survive untouched (hand-edit protection)
    skins.list_skins(root)
    assert (d / "icons" / "caret.png").read_bytes() == b"HAND_EDITED"


def test_file_wins_over_crate_map(root):
    # yml_newer flag points at the situation; serving reads the DIR files
    drop(root, "night", mtime=1_762_070_400)
    skins.list_skins(root)
    d = root / "night-1762070400"
    (d / "overlay.css").write_text(".hand { color: red; }")
    css, _ = skins.theme_css(root, skins.list_skins(root)[0])
    assert b".hand { color: red; }" in css
    assert b"badge.Complete" not in css  # crate value NOT merged back in


def test_mtimes_stable_base_name_newest_wins(root):
    drop(root, "night", mtime=1_700_000_000)
    skins.list_skins(root)
    drop(root, "night", mtime=1_700_000_500)
    entries = skins.list_skins(root)
    by_dir = {e["dir"]: e for e in entries}
    assert by_dir["night-1700000000"]["name"] == "night-1700000000"
    assert by_dir["night-1700000000"]["stale"] is True
    assert by_dir["night-1700000500"]["name"] == "night"
    assert by_dir["night-1700000500"]["stale"] is False


def test_yml_newer_than_dirs_flagged(root):
    drop(root, "night", mtime=1_700_000_000)
    skins.list_skins(root)
    # touch() bumps mtime -> list flags yml_newer and does NOT re-extract
    time.sleep(0.01)
    (root / "night.yml").touch()
    new_mt = int((root / "night.yml").stat().st_mtime)
    entries = skins.list_skins(root)
    fresh = [e for e in entries if e["dir"] == f"night-{new_mt}"]
    assert fresh and fresh[0]["name"] == "night"
    old = [e for e in entries if e["dir"] == "night-1700000000"][0]
    assert old["stale"] is True


def test_touch_preserved_mtime_maps_back(root):
    drop(root, "night", mtime=1_700_000_000)
    skins.list_skins(root)
    # a cp -p restored crate with the SAME old mtime maps onto the dir
    drop(root, "night", text=CRATE + "\n", mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert [e["dir"] for e in entries] == ["night-1700000000"]
    assert entries[0]["yml_newer"] is False


def test_malformed_yaml_skips_with_reason(root):
    drop(root, "night", text="tokens: [this is: not\n  valid: yaml:\n")
    entries = skins.list_skins(root)
    assert len(entries) == 1
    assert entries[0]["dir"] is None
    assert "malformed YAML" in entries[0]["reason"]
    assert not list(root.glob("night-*"))


def test_skin_version_too_new_skips(root):
    drop(root, "night", text="skin_version: 99\ntokens:\n  bg: \"#000000\"\n")
    entries = skins.list_skins(root)
    assert entries[0]["dir"] is None
    assert "newer than supported" in entries[0]["reason"]


def test_unknown_keys_ignored(root):
    drop(root, "night", text=(
        "skin_version: 1\ntokens:\n  bg: \"#000000\"\n"
        "totally_new_feature:\n  a: 1\nfuture_flag: true\n"))
    skins.list_skins(root)
    d = root / "night-1762070400" if (root / "night-1762070400").exists() \
        else next(root.glob("night-*"))
    meta = skins._load_dir_meta(d / "skin.yml")
    assert meta["tokens"] == {"bg": "#000000"}
    assert "totally_new_feature" not in meta


def test_unknown_token_and_icon_names_ignored(root):
    crate = ("tokens:\n  bg: \"#101010\"\n  made_up_token: \"#fff\"\n"
             "icons:\n  caret.png: \"%s\"\n  made_up.png: \"%s\"\n"
             % (base64.b64encode(PNG_1PX).decode(), "not-base64!!"))
    drop(root, "night", text=crate, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"
    css, _ = skins.theme_css(root, entries[0])
    assert b"--bg: #101010;" in css
    assert b"made_up_token" not in css
    assert b"--icon-caret:" in css
    assert b"made_up" not in css


def test_icon_decode_failure_warns_and_skips_only_that_icon(root):
    crate = ("tokens:\n  bg: \"#101010\"\n"
             "icons:\n  caret.png: \"not base64 at all!!\"\n")
    drop(root, "night", text=crate, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"
    # non-b64 text value is kept verbatim as a (broken) file; the CSS only
    # references files that exist. Delete the file -> variable disappears.
    (root / "night-1700000000" / "icons" / "caret.png").unlink()
    skins.invalidate_caches()
    css, _ = skins.theme_css(root, entries[0])
    assert b"--icon-caret" not in css
    assert b"--bg: #101010;" in css


# -------------------------------------------------------------- traversal

def test_name_and_dir_regexes_reject_traversal(root):
    assert not skins.NAME_RE.match("../evil")
    assert not skins.NAME_RE.match("Evil")
    assert not skins.NAME_RE.match("a..b")
    assert skins.DIR_RE.match("night-1762070400")
    # spec regex allows hyphens in the base part, so 'night-99' matches as a
    # plain dir name; only the 10-digit suffix marks a version
    assert skins.DIR_RE.match("night-99")
    assert skins.DIR_RE.match("night-176207")  # digits are legal in base part
    assert not skins.DIR_RE.match("night_1762070400")  # underscore: no
    assert not skins.DIR_RE.match("../night-1762070400")
    assert skins.RES_RE.match("icons/caret.png")
    assert not skins.RES_RE.match("icons/../skin.yml")
    assert not skins.RES_RE.match("../etc/passwd")
    assert not skins.RES_RE.match("icons/sub/deep.png")
    # spec-literal icons regex: uppercase first char allowed
    assert skins.RES_RE.match("icons/Caret.png")
    assert not skins.RES_RE.match("icons/.hidden")


def test_dot_dot_dirs_are_ignored_in_scan(root):
    (root / "..evil-1700000000").mkdir()  # regex rejects: never listed
    drop(root, "night", mtime=1_700_000_000)
    names = [e["dir"] for e in skins.list_skins(root)]
    assert "..evil-1700000000" not in names


def test_symlink_escape_not_followed(root, tmp_path):
    drop(root, "night", mtime=1_700_000_000)
    d = root / "night-1700000000"
    # a symlinked top-level dir is not a working copy
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (root / "link-1700000000").symlink_to(outside)
    names = [e["dir"] for e in skins.list_skins(root)]
    assert "link-1700000000" not in names
    # and inside icons/, _safe_child refuses escapes
    esc = d / "icons"
    esc.mkdir(exist_ok=True)
    (esc / "escape").symlink_to(tmp_path / "secret.txt")
    # symlink to a target OUTSIDE the skin dir is refused outright
    assert skins._safe_child(d, "icons/escape") is None
    # '..' walks out of the dir: also refused (resolve + is_relative_to)
    assert skins._safe_child(d, "icons/../../../outside") is None


# ---------------------------------------------------- value-shape validation

@pytest.mark.parametrize("key,value,ok", [
    ("bg", "#14151a", True),
    ("bg", "#abc", True),
    ("bg", "rgb(20 21 26)", True),
    ("bg", "hsl(120, 10%, 5%)", True),
    ("bg", "transparent", True),
    ("bg", "red; } body { display:none", False),
    ("bg", "#12345", False),
    ("accent", "expression(alert(1))", False),
    ("mono", '"IBM Plex Mono", monospace', True),
    ("mono", "x; } html { display:none", False),
    ("hdr-weight", "700", True),
    ("hdr-weight", "bold", True),
    ("hdr-weight", "drop-shadow(1px)", False),
])
def test_token_value_shapes(key, value, ok):
    assert skins._valid_token(key, value) is ok


def test_bad_values_skipped_skin_still_loads(root):
    drop(root, "night", text=(
        "tokens:\n  bg: \"#101010\"\n  ink: \"evil; } x {\"\n"),
        mtime=1_700_000_000)
    entries = skins.list_skins(root)
    css, etag = skins.theme_css(root, entries[0])
    assert b"--bg: #101010;" in css
    assert b"--ink" not in css
    assert etag.startswith('"')


# ------------------------------------------------------- motion governance
# SPARK-2: an ungated animation/transition in a crate keeps moving after the
# user turns motion off. The validator WARNS (sidecar + picker) and the skin
# still loads — forward-compat rule outranks governance.

MOTION_GATED = (
    'skin_version: 1\nlabel: "Gated"\ntokens:\n  bg: "#101010"\ncss: |\n'
    '  .logo .dot { box-shadow: 0 0 4px red; }\n'
    '  :root:not([data-motion="off"]) .logo .dot {\n'
    '      animation: g-pulse 3s ease-in-out infinite;\n'
    '  }\n'
    '  @keyframes g-pulse { 50% { box-shadow: 0 0 11px red; } }\n')

MOTION_UNGATED = (
    'skin_version: 1\nlabel: "Ungated"\ntokens:\n  bg: "#101010"\ncss: |\n'
    '  .logo .dot { box-shadow: 0 0 4px red; }\n'
    '  .logo .dot { animation: u-pulse 3s ease-in-out infinite; }\n'
    '  .card { transition: border-color .2s; }\n'
    '  @keyframes u-pulse { 50% { box-shadow: 0 0 11px red; } }\n')


@pytest.mark.parametrize("css,want", [
    (".card { animation: x 1s infinite; }", 1),
    (".card { transition: color .2s; }", 1),
    (".card { animation-name: spin; }", 1),
    (".card { -webkit-animation: x 1s; }", 1),
    ('@media (hover:hover){:root:not([data-motion="off"]) .card'
     '{animation:x 1s}}', 0),
    ("@keyframes x { from { opacity: 0 } }", 0),          # defines, not plays
    (".card { animation: none; }", 0),                    # inert
    ("/* .card { animation: x 1s } */ .a { color: red }", 0),  # commented
    ('.cur { cursor: url("data:image/svg+xml;base64,AA==");'
     ' animation: x 1s; }', 1),                           # ; and {} in string
    ("", 0),
    (".card { color: red; padding: 4px }", 0),
])
def test_motion_warnings_detect_ungated_motion(css, want):
    assert len(skins.motion_warnings(css)) == want


def test_motion_warning_names_property_and_selector():
    w = skins.motion_warnings(".rqchip { transition: box-shadow .2s; }")
    assert len(w) == 1
    assert "transition" in w[0] and ".rqchip" in w[0]
    assert 'data-motion' in w[0]        # the message says how to fix it


def test_ungated_animation_warns_and_skin_still_loads(root):
    drop(root, "night", text=MOTION_UNGATED, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"   # NOT rejected
    css, _ = skins.theme_css(root, entries[0])
    assert b"--bg: #101010;" in css                  # tokens still compile
    warns = entries[0]["warnings"]
    assert any("ungated animation" in w for w in warns)
    assert any("ungated transition" in w for w in warns)
    # the warning survives a repeat scan via the sidecar
    (root / "night-1700000000" / ".extract-warnings").write_text(
        "\n".join(warns), encoding="utf-8")
    skins.invalidate_caches()
    again = skins.list_skins(root)
    assert any("ungated animation" in w for w in again[0]["warnings"])


def test_gated_animation_emits_no_warning(root):
    drop(root, "night", text=MOTION_GATED, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"
    assert not any("ungated" in w for w in entries[0]["warnings"])


def test_hand_edited_overlay_is_rechecked_on_scan(root):
    # a crate ships clean, then overlay.css is hand-edited to add motion.
    # Extraction is never re-run (never-overwrite), so the scan must
    # re-derive motion warnings from the file that ACTUALLY SERVES.
    drop(root, "night", text=MOTION_GATED, mtime=1_700_000_000)
    assert not any("ungated" in w for w in skins.list_skins(root)[0]["warnings"])
    ov = root / "night-1700000000" / "overlay.css"
    ov.write_text(ov.read_text(encoding="utf-8")
                  + "\n.badge { animation: slide-in .3s; }\n", encoding="utf-8")
    skins.invalidate_caches()
    warns = skins.list_skins(root)[0]["warnings"]
    assert any("ungated animation" in w for w in warns)


def test_every_bundled_crate_is_motion_clean():
    """SPARK-2 acceptance: no shipped crate warns under the new rule."""
    d = skins.bundled_package_dir()
    offenders = {}
    for p in sorted(d.glob("*.yml")):
        crate, reason = skins.parse_crate(p.read_bytes())
        assert crate is not None, f"{p.name}: {reason}"
        w = skins.motion_warnings(crate["css"])
        if w:
            offenders[p.name] = w
    assert not offenders, offenders


def test_bundled_crates_only_reference_resources_they_ship():
    """A typo'd res/ path renders NOTHING — an invisible icon is not an error
    anywhere in the pipeline, so the crate must be self-consistent by test."""
    bad = {}
    for p in sorted(skins.bundled_package_dir().glob("*.yml")):
        crate, reason = skins.parse_crate(p.read_bytes())
        assert crate is not None, f"{p.name}: {reason}"
        shipped = set()
        for subdir, mapping in (("icons", crate["icons"]), ("fonts", crate["fonts"])):
            for res_name in mapping:
                rel = skins._res_target(subdir, res_name)
                if rel:
                    shipped.add(rel)
        refs = set(re.findall(r"url\(['\"]?res/([^'\")]+)['\"]?\)", crate["css"]))
        missing = sorted(refs - shipped)
        if missing:
            bad[p.name] = missing
    assert not bad, bad


def test_bundled_fonts_ship_their_licence():
    """OFL redistribution requires the licence to travel WITH the font, and a
    crate is the unit that travels: sync_bundled unpacks one crate to one
    working copy, and a user dir holds just that dir. So every binary font a
    crate ships must be accompanied, in the SAME crate, by a licence text
    resource. shodan shipped two JetBrains Mono woff2 blobs with no licence
    anywhere in the repo (SPARK-4 finding 2026-10-01) — invisible to every
    other check, because a missing licence breaks nothing at runtime."""
    FONT_EXT = (".woff2", ".woff", ".ttf", ".otf")
    LICENCE_HINTS = ("ofl", "licen", "copyright", "mit", "apache")
    bad = {}
    for p in sorted(skins.bundled_package_dir().glob("*.yml")):
        crate, reason = skins.parse_crate(p.read_bytes())
        assert crate is not None, f"{p.name}: {reason}"
        fonts = [n for n in crate["fonts"] if n.lower().endswith(FONT_EXT)]
        if not fonts:
            continue
        texts = [n for n in crate["fonts"]
                 if n.lower().endswith(".txt")
                 and any(h in n.lower() for h in LICENCE_HINTS)]
        if not texts:
            bad[p.name] = f"ships {fonts} with no licence .txt in fonts:"
            continue
        # and it must be a real licence, not an empty placeholder
        blob, err = skins._decode_resource(crate["fonts"][texts[0]], 0)
        if blob is None or len(blob) < 200:
            bad[p.name] = f"{texts[0]} is not a licence text ({err or len(blob or b'')}B)"
    assert not bad, bad


# ------------------------------------------------------------ classic map

def test_classic_mapping_declared_wins():
    assert skins.classic_mapping({"classic": {"theme": "light",
                                              "enhanced": True},
                                  "tokens": {"bg": "#000000"}}) == \
        {"theme": "light", "enhanced": True}


def test_classic_mapping_bg_luminance_default():
    dark = skins.classic_mapping({"tokens": {"bg": "#14151a"}})
    assert dark == {"theme": "dark", "enhanced": False}
    light = skins.classic_mapping({"tokens": {"bg": "#f5f5f0"}})
    assert light == {"theme": "light", "enhanced": False}
    # unusable bg -> dark is the safe default
    assert skins.classic_mapping({"tokens": {"bg": "red"}})["theme"] == "dark"
    assert skins.classic_mapping({})["theme"] == "dark"


def test_luminance_helper():
    assert skins._luminance("#000000") == pytest.approx(0.0)
    assert skins._luminance("#ffffff") == pytest.approx(1.0)
    assert skins._luminance("rgb(255, 255, 255)") == pytest.approx(1.0)
    assert skins._luminance("hsl(0,0%,50%)") is None


# ---------------------------------------------------------------- CSS/ETag

def test_theme_css_scoped_to_resolved_dir(root):
    drop(root, "night", mtime=1_700_000_000)
    e = skins.list_skins(root)[0]
    css, etag = skins.theme_css(root, e)
    assert b':root[data-theme="night-1700000000"]' in css
    assert b"--icon-caret: url(/uplift/api/skins/night-1700000000/res/icons/caret.png);" in css
    # stable ETag while nothing changes
    css2, etag2 = skins.theme_css(root, e)
    assert (css2, etag2) == (css, etag)


def test_theme_css_cache_invalidates_on_overlay_edit(root):
    drop(root, "night", mtime=1_700_000_000)
    e = skins.list_skins(root)[0]
    _css, etag1 = skins.theme_css(root, e)
    time.sleep(0.01)
    (root / "night-1700000000" / "overlay.css").write_text(".edited {}")
    _css2, etag2 = skins.theme_css(root, e)
    assert etag1 != etag2


# ------------------------------------------------------------------- routes

@pytest.fixture
def client(monkeypatch, root):
    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")

    async def _admin_true():
        return True

    from omlx_uplift.router import require_admin
    app.dependency_overrides[require_admin] = _admin_true
    monkeypatch.setattr(skins, "skins_root", lambda base=None: root)
    return TestClient(app)


def test_route_listing(client, root):
    drop(root, "night", mtime=1_700_000_000)
    r = client.get("/uplift/api/skins")
    assert r.status_code == 200
    row = r.json()["skins"][0]
    assert row["name"] == "night"
    assert row["label"] == "Night Watch"
    assert row["ts"] == 1_700_000_000
    assert row["stale"] is False and row["yml_newer"] is False
    assert row["classic"] == {"theme": "dark", "enhanced": False}


def test_route_theme_css_etag_304(client, root):
    drop(root, "night", mtime=1_700_000_000)
    url = "/uplift/api/skins/night/theme.css"
    r = client.get(url)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")
    assert r.headers["x-content-type-options"] == "nosniff"
    etag = r.headers["etag"]
    r2 = client.get(url, headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""


def test_route_res_content_type_matrix_and_nosniff(client, root):
    drop(root, "night", mtime=1_700_000_000)
    client.get("/uplift/api/skins")  # trigger extraction
    d = root / "night-1700000000"
    (d / "icons" / "x.svg").write_text("<svg/>")
    (d / "icons" / "f.woff2").write_bytes(b"wOF2")
    (d / "icons" / "weird.xyz").write_text("<script>alert(1)</script>")
    (d / "icons" / "skin.yml").write_text("smuggled")  # same name as meta!
    base = "/uplift/api/skins/night/res/icons/"
    for fn, ct in (("caret.png", "image/png"), ("x.svg", "image/svg+xml"),
                   ("f.woff2", "font/woff2"), ("weird.xyz", "application/octet-stream"),
                   ("skin.yml", "application/octet-stream")):
        r = client.get(base + fn)
        assert r.status_code == 200, fn
        assert r.headers["content-type"].startswith(ct), (fn, r.headers["content-type"])
        assert r.headers["x-content-type-options"] == "nosniff"


def test_route_res_traversal_and_whitelist(client, root):
    drop(root, "night", mtime=1_700_000_000)
    r = client.get("/uplift/api/skins/night/res/icons/../skin.yml")
    assert r.status_code == 404  # whitelisted shape first, always
    r = client.get("/uplift/api/skins/night/res/icons/sub/x.png")
    assert r.status_code == 404
    r = client.get("/uplift/api/skins/nosuch/res/icons/caret.png")
    assert r.status_code == 404
    r = client.get("/uplift/api/skins/night/theme.css/../res")
    assert r.status_code in (404, 405)


def test_route_unknown_skin_404_never_500(client):
    assert client.get("/uplift/api/skins/ghost/theme.css").status_code == 404
    assert client.get("/uplift/api/skins/%2e%2e/theme.css").status_code == 404


# --------------------------------------------------------------------- CLI

def test_cli_round_trip_resources_byte_identical(root, tmp_path):
    drop(root, "night", mtime=1_700_000_000)
    skins.list_skins(root)
    d = root / "night-1700000000"
    (d / "icons" / "caret.png").write_bytes(PNG_1PX + b"hand-edit")
    text = skins.compile_dir(d)
    # deterministic: identical input -> byte-identical output
    assert skins.compile_dir(d) == text

    out = tmp_path / "other"
    out.mkdir()
    crate = out / "night.yml"
    crate.write_text(text, encoding="utf-8")
    os.utime(crate, (1_700_000_000, 1_700_000_000))
    dir_name = skins.decompile_crate(crate, out)
    assert dir_name == "night-1700000000"
    assert (out / dir_name / "icons" / "caret.png").read_bytes() == \
        PNG_1PX + b"hand-edit"
    assert (out / dir_name / "overlay.css").read_text().strip() == \
        ".badge.Complete { border-style: double; }"


def test_cli_compile_is_deterministic_block_scalar(root):
    drop(root, "night", mtime=1_700_000_000)
    skins.list_skins(root)
    text = skins.compile_dir(root / "night-1700000000")
    assert text.startswith("skin_version: 1\n")
    assert "css: |-\n  .badge.Complete { border-style: double; }\n" in text
    # re-importable: canonical text parses back to the same data
    parsed, reason = skins.parse_crate(text)
    assert reason is None
    assert parsed["tokens"] == {"bg": "#14151a", "card": "#1c1d24",
                                "accent": "#57e38a"}
    assert parsed["icons"]["caret.png"]  # single-line base64
    assert "label: \"Night Watch\"" in text


def test_cli_compile_svg_icons_stay_readable_block_scalars(root):
    """Design 2.2/8: text resources survive compile as readable YAML block
    scalars (SVG icons must not be forced to base64); binary stays b64."""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">\n'
           '<path d="M0 0h4v4z"/>\n</svg>\n')
    crate = ("tokens:\n  bg: \"#101010\"\n"
             "icons:\n  caret.svg: \"\"\n  logo-dot.png: \"%s\"\n"
             % base64.b64encode(PNG_1PX).decode())
    drop(root, "night", text=crate, mtime=1_700_000_000)
    skins.list_skins(root)
    d = root / "night-1700000000"
    (d / "icons" / "caret.svg").write_text(svg)
    text = skins.compile_dir(d)
    # SVG's trailing newline => keep-style block scalar (byte-exact choice)
    assert "  \"caret.svg\": |\n" in text
    assert "<path d=\"M0 0h4v4z\"/>" in text            # readable, not b64
    assert base64.b64encode(PNG_1PX).decode() in text  # binary still b64
    # byte-exact round trip of the SVG through decompile
    out = root / "out"
    out.mkdir()
    (out / "night.yml").write_text(text)
    os.utime(out / "night.yml", (1_700_000_000, 1_700_000_000))
    dn = skins.decompile_crate(out / "night.yml", out)
    assert (out / dn / "icons" / "caret.svg").read_text() == svg
    assert (out / dn / "icons" / "logo-dot.png").read_bytes() == PNG_1PX


def _fonts_crate():
    blob = b"wOF2" + b"\x00" * 60          # fake but bytes-exact woff2 payload
    return ("tokens:\n  bg: \"#101010\"\n"
            "icons:\n  grip.svg: \"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\"\n"
            "    viewBox=\\\"0 0 2 2\\\"><path d=\\\"M0 1h2\\\"/></svg>\"\n"
            "fonts:\n  \"mono.woff2\": \"%s\"\n" % base64.b64encode(blob).decode()), blob


def test_extract_fonts_slot_byte_identical(root):
    """fonts: is a second resource map under fonts/ (same rules as icons:);
    the grip name from the v1 vocabulary gets its CSS variable."""
    crate, blob = _fonts_crate()
    drop(root, "night", text=crate, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"
    d = root / "night-1700000000"
    assert (d / "fonts" / "mono.woff2").read_bytes() == blob
    assert (d / "icons" / "grip.svg").is_file()
    css, _ = skins.theme_css(root, entries[0])
    assert b"--icon-grip: url(/uplift/api/skins/night-1700000000/res/icons/grip.svg);" in css


def test_compile_round_trip_fonts_byte_identical(root):
    crate, blob = _fonts_crate()
    drop(root, "night", text=crate, mtime=1_700_000_000)
    skins.list_skins(root)
    d = root / "night-1700000000"
    text = skins.compile_dir(d)
    assert "fonts:" in text
    out = root / "out"
    out.mkdir()
    (out / "night.yml").write_text(text)
    dn = skins.decompile_crate(out / "night.yml", out)
    assert (out / dn / "fonts" / "mono.woff2").read_bytes() == blob
    assert (out / dn / "icons" / "grip.svg").is_file()


def test_route_res_serves_fonts(client, root):
    crate, blob = _fonts_crate()
    drop(root, "night", text=crate, mtime=1_700_000_000)
    r = client.get("/uplift/api/skins/night/res/fonts/mono.woff2")
    assert r.status_code == 200
    assert r.content == blob
    assert r.headers["content-type"] == "font/woff2"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_route_res_rejects_font_traversal(client, root):
    """Encoded '..' segments survive to the handler; RES_RE is the gate."""
    drop(root, "night", mtime=1_700_000_000)
    r = client.get("/uplift/api/skins/night/res/fonts/%2e%2e/icons/caret.png")
    assert r.status_code == 404


def test_cli_size_caps(root):
    big = base64.b64encode(b"x" * (skins.MAX_RESOURCE_BYTES + 1)).decode()
    crate = f"icons:\n  caret.png: \"{big}\"\n"
    drop(root, "night", text=crate, mtime=1_700_000_000)
    entries = skins.list_skins(root)
    assert entries[0]["dir"] == "night-1700000000"
    assert not (root / "night-1700000000" / "icons" / "caret.png").exists()
    # the extraction-time warning surfaced on this scan
    assert any("larger" in w for w in entries[0]["warnings"])
    # and persists for repeat scans (sidecar)
    entries = skins.list_skins(root)
    assert any("larger" in w for w in entries[0]["warnings"])


def test_crate_size_cap_skips(root):
    drop(root, "night", text="css: \"" + "x" * (skins.MAX_CRATE_BYTES + 10))
    entries = skins.list_skins(root)
    assert entries[0]["dir"] is None
    assert "larger" in entries[0]["reason"]
