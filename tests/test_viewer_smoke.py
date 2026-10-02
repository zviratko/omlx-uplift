"""VIEWER-1 regression: standalone viewer static routes returned 500.

SPLIT-1 changed _static_file(request, path) but viewer.py kept calling it
with one arg, so GET /uplift/ crashed with TypeError on the DMG-user
surface — and nothing tested build_viewer_app at all. These smoke checks
pin the seam: build the app, hit the page, one asset, one traversal, and
the 304 revalidation path (which also needs the request object).
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from omlx_uplift.viewer import build_viewer_app


def _client():
    return TestClient(build_viewer_app())


def test_viewer_index_serves_ui():
    r = _client().get("/uplift/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_viewer_static_asset_and_revalidation():
    c = _client()
    r = c.get("/uplift/uplift.js")
    assert r.status_code == 200
    etag = r.headers.get("etag")
    assert etag, "static assets must advertise an ETag"
    r2 = c.get("/uplift/uplift.js", headers={"if-none-match": etag})
    assert r2.status_code == 304  # CACHE-1 honoured on the viewer too


def test_viewer_static_missing_is_404_not_500():
    assert _client().get("/uplift/definitely-missing.xyz").status_code == 404


def test_viewer_static_traversal_is_404_not_500():
    # _static_file refuses anything outside STATIC_DIR; the viewer must
    # surface that as 404, never as a crash or a leaked parent path.
    r = _client().get("/uplift/..%2fsettings.json")
    assert r.status_code in (400, 404)
