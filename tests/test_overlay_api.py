# SPDX-License-Identifier: Apache-2.0
"""Tests for the Uplift overlay API (model-settings-index, prune, GET/DELETE
model settings) — package-local, vanilla routes.py no longer hosts these.

pytest asyncio_mode=auto collects these bare async tests.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

import omlx.server  # noqa: F401 - ensure server module is imported first
from omlx_uplift import router as up
from omlx.model_settings import ModelSettings


def _mgr(settings: dict):
    mgr = MagicMock()
    mgr.get_all_settings.return_value = settings
    mgr.delete_settings.side_effect = lambda mid: settings.pop(mid, None) is not None
    return mgr


def _pool(model_ids):
    pool = MagicMock()
    pool.get_model_ids.return_value = list(model_ids)
    pool.get_entry.side_effect = lambda mid: (
        MagicMock() if mid in model_ids else None
    )
    return pool


def _ms(mid, alias=None):
    s = ModelSettings()
    s.model_alias = alias
    return s


async def test_index_reports_orphans_and_aliases():
    settings = {
        "live-model": _ms("live-model", alias="alias-target"),
        "gone-model": _ms("gone-model"),
        "alias-target": _ms("alias-target"),  # referenced by live-model's alias
    }
    with patch.object(up, "settings_manager", return_value=_mgr(settings)), \
         patch.object(up, "engine_pool", return_value=_pool(["live-model"])):
        out = await up.model_settings_index(is_admin=True)
    assert out["stored"] == 3
    assert out["known"] == 1
    # gone-model is an orphan; alias-target is kept by live-model's alias
    assert out["orphans"] == ["gone-model"]
    assert {"id": "live-model", "alias": "alias-target"} in out["entries"]


async def test_index_requires_pool():
    with patch.object(up, "settings_manager", return_value=_mgr({})), \
         patch.object(up, "engine_pool", return_value=None):
        with pytest.raises(HTTPException) as ei:
            await up.model_settings_index(is_admin=True)
    assert ei.value.status_code == 503


async def test_prune_deletes_only_listed_existing_ids():
    settings = {
        "a": _ms("a"),
        "b": _ms("b"),
    }
    mgr = _mgr(settings)
    with patch.object(up, "settings_manager", return_value=mgr):
        out = await up.prune_model_settings(
            up.PruneModelSettingsRequest(ids=["a", "a", "ghost"]),
            is_admin=True,
        )
    assert out["removed"] == ["a"]
    assert out["removed_templates"] == []
    assert "b" in settings


async def test_prune_requires_ids():
    with patch.object(up, "settings_manager", return_value=_mgr({})):
        with pytest.raises(HTTPException) as ei:
            await up.prune_model_settings(
                up.PruneModelSettingsRequest(ids=[]), is_admin=True
            )
    assert ei.value.status_code == 400


async def test_get_model_settings_shape():
    mgr = MagicMock()
    s = ModelSettings()
    s.temperature = 0.42
    mgr.get_settings.return_value = s
    with patch.object(up, "settings_manager", return_value=mgr), \
         patch.object(up, "engine_pool", return_value=_pool(["m1"])):
        out = await up.get_model_settings("m1", is_admin=True)
    assert out["id"] == "m1"
    assert out["settings"]["temperature"] == 0.42


async def test_get_model_settings_unknown_404():
    with patch.object(up, "settings_manager", return_value=MagicMock()), \
         patch.object(up, "engine_pool", return_value=_pool(["other"])):
        with pytest.raises(HTTPException) as ei:
            await up.get_model_settings("ghost", is_admin=True)
    assert ei.value.status_code == 404


async def test_delete_model_settings():
    settings = {"a": _ms("a")}
    mgr = _mgr(settings)
    with patch.object(up, "settings_manager", return_value=mgr):
        out = await up.delete_model_settings_route("a", is_admin=True)
    assert out == {"deleted": "a"}
    with patch.object(up, "settings_manager", return_value=_mgr({})):
        with pytest.raises(HTTPException) as ei:
            await up.delete_model_settings_route("ghost", is_admin=True)
    assert ei.value.status_code == 404


def test_locale_overlays_key_sync():
    """Overlay key discipline, two families:
    - UI keys (shell/toast/feed): every locale must carry the full set.
    - uplift.gs.* / uplift.se.* labels: subset allowed (documented
      EN-fallback design mirroring classic's partial catalogs), but
      placeholders must match wherever a key IS present."""
    import re
    from omlx_uplift.router import _PACKAGE_LOCALES

    en = json.loads((_PACKAGE_LOCALES / "en.json").read_text(encoding="utf-8"))
    assert en, "en overlay must not be empty"
    FALLBACK_FAMILIES = ("uplift.gs.", "uplift.se.", "uplift.ui.", "uplift.mode.")
    ui_en = {k: v for k, v in en.items() if not k.startswith(FALLBACK_FAMILIES)}
    langs = {"zh", "zh-TW", "ja", "ko", "ru", "es", "fr", "pt-BR"}
    for lang in langs:
        data = json.loads(((_PACKAGE_LOCALES / f"{lang}.json")).read_text(encoding="utf-8"))
        assert set(ui_en) <= set(data), f"{lang} missing UI keys: {sorted(set(ui_en) - set(data))[:5]}"
        for k, v in en.items():
            if k not in data:
                assert k.startswith(FALLBACK_FAMILIES), f"{lang}:{k} missing but not a fallback-family key"
                continue
            src = set(re.findall(r"\{(\w+)\}", v))
            got = set(re.findall(r"\{(\w+)\}", data[k]))
            assert src == got, f"{lang}:{k} placeholders {got} != en {src}"


# ---------------------------------------------------------------------------
# SSE-SPLIT-1: every open stream connection must observe every transition;
# the shared destructive drain previously handed each tick's rows to only
# the first consumer.
# ---------------------------------------------------------------------------

class _FakeTracker:
    def __init__(self):
        self.rows = {}

    def add(self, rid, state="active", **kw):
        row = {"id": rid, "model": "m", "state": state, "origin": "real",
               "prompt_tokens": 1, "completion_tokens": 0, "tps": None,
               "error": None, "finish": None, "ts_start": 1.0, "ts_end": 2.0,
               "ts": 2.0, "loop_hint": False}
        row.update(kw)
        self.rows[rid] = row

    def sample(self, pool):        # no-op: rows mutate directly
        pass

    def list_rows(self, limit=30):
        return sorted(self.rows.values(), key=lambda r: r["ts"], reverse=True)


async def _pull(it, timeout=3.0):
    import asyncio
    return await asyncio.wait_for(it.__anext__(), timeout=timeout)


async def test_sse_every_consumer_sees_every_transition():
    import asyncio
    from unittest.mock import MagicMock
    tracker = _FakeTracker()
    tracker.add("r1")
    with patch.object(up, "get_request_tracker", return_value=tracker), \
         patch.object(up, "engine_pool", return_value=MagicMock()):
        resp_a = await up.stream_requests(is_admin=True)
        resp_b = await up.stream_requests(is_admin=True)
        it_a, it_b = resp_a.body_iterator, resp_b.body_iterator

        # drive both to their seed pass (they are started concurrently)
        resp_c = await up.stream_requests(is_admin=True)
        it_c = resp_c.body_iterator

        pa = asyncio.create_task(_pull(it_a))
        pb = asyncio.create_task(_pull(it_b))
        await asyncio.sleep(0.2)          # let generators seed their view

        # transition happens AFTER both connections opened
        tracker.rows["r1"].update(state="complete", completion_tokens=9)
        fa, fb = await pa, await pb
        import json as _json
        ea = _json.loads(fa.split("data: ", 1)[1])
        eb = _json.loads(fb.split("data: ", 1)[1])
        assert ea["id"] == eb["id"] == "r1"
        assert ea["state"] == eb["state"] == "complete"
        assert ea["completion"] == eb["completion"] == 9

        # seed contract: a connection opened AFTER r1 completed must
        # stream only NEW transitions. Start C first (it seeds r1 into its
        # watermark on entry), THEN create traffic: first frame is r2,
        # never an r1 replay.
        pc = asyncio.create_task(_pull(it_c))
        await asyncio.sleep(0.3)          # let C enter its tick loop
        tracker.add("r2", state="complete", completion_tokens=3)
        fc = await pc
        ec = _json.loads(fc.split("data: ", 1)[1])
        assert ec["id"] == "r2", f"fresh connection replayed {ec['id']}"
        for it in (it_a, it_b, it_c):
            try:
                await it.aclose()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CACHE-1: static revalidation — ETag/If-None-Match and
# If-Modified-Since must produce 304 with no body, while a plain GET
# still answers the full file with the cache headers intact.
# ---------------------------------------------------------------------------

def _req(headers: dict):
    scope = {
        "type": "http", "method": "GET", "path": "/uplift/uplift.js",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "query_string": b"", "scheme": "http", "server": ("test", 80),
        "client": ("127.0.0.1", 1234), "root_path": "",
    }
    from starlette.requests import Request
    return Request(scope)


def test_static_etag_matches_file_response_formula(tmp_path):
    import os, hashlib
    from email.utils import formatdate
    f = tmp_path / "x.js"
    f.write_text("hello")
    st = f.stat()
    expect = '"%s"' % hashlib.md5(
        f"{st.st_mtime}-{st.st_size}".encode(), usedforsecurity=False
    ).hexdigest()
    assert up._static_etag(st) == expect


def test_static_conditional_get_304_and_plain_200():
    from starlette.responses import FileResponse
    etag = None
    # first: plain GET through the real route machinery shape — we can
    # call the file helper directly with an empty-validator request
    plain = up._static_file(_req({}), "uplift.js")
    assert isinstance(plain, FileResponse)
    # derive the live etag from the file itself
    st = (up.STATIC_DIR / "uplift.js").stat()
    etag = up._static_etag(st)
    assert up._not_modified(_req({"if-none-match": etag}), etag, st.st_mtime)
    assert up._not_modified(_req({"if-none-match": 'W/"zz", ' + etag}),
                            etag, st.st_mtime)
    assert not up._not_modified(_req({"if-none-match": '"deadbeef"'}),
                                etag, st.st_mtime)
    # If-Modified-Since in the future -> 304; in the past -> must re-serve
    from email.utils import formatdate
    future = formatdate(st.st_mtime + 3600, usegmt=True)
    past = formatdate(st.st_mtime - 3600, usegmt=True)
    assert up._not_modified(_req({"if-modified-since": future}), etag,
                            st.st_mtime)
    assert not up._not_modified(_req({"if-modified-since": past}), etag,
                                st.st_mtime)
    # malformed header must not crash into 304
    assert not up._not_modified(_req({"if-modified-since": "garbage"}),
                                etag, st.st_mtime)


def test_static_file_serves_304_with_no_body():
    # route wrapper (gate/auth) is covered by E2E; here: the response the
    # wrapper returns for a matching validator must be a bodyless 304
    st = (up.STATIC_DIR / "uplift.js").stat()
    etag = up._static_etag(st)
    resp = up._static_file(_req({"if-none-match": etag}), "uplift.js")
    assert resp.status_code == 304
    assert resp.body == b""
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["etag"] == etag
    # html keeps no-store on its 304s too
    sti = (up.STATIC_DIR / "index.html").stat()
    etagi = up._static_etag(sti)
    r2 = up._static_file(_req({"if-none-match": etagi}), "index.html")
    assert r2.status_code == 304 and r2.headers["cache-control"] == "no-store"
