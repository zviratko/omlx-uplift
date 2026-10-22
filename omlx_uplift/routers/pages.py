"""Uplift page surface (SPLIT-1): static files with ETag/304, the
login gate + throttle, login routes and the /uplift page tree (plus the
legacy /admin/uplift aliases). Login POST stays at /uplift/login, NOT
/uplift/api/login — a literal under /uplift/api/ outranks the API
router's dynamic routes in FastAPI>=0.141 candidate matching."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request
from starlette.responses import Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .base import (api_router, page_router, require_admin, _RedirectToLogin,
                   engine_pool, settings_manager, global_settings,
                   _require_settings_manager, STATIC_DIR, _no_api_cache,
                   GZIP_MIN_BYTES)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector


# --------------------------------------------------------------------------
# Static file serving with traversal guard
# --------------------------------------------------------------------------

_MEDIA_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json",
}


def _static_etag(st: os.stat_result) -> str:
    # same formula Starlette's FileResponse emits (mtime+size md5), so
    # validators stay continuous whether our 304 path or FileResponse
    # answers the request
    base = f"{st.st_mtime}-{st.st_size}".encode()
    return f'"{hashlib.md5(base, usedforsecurity=False).hexdigest()}"'


def _not_modified(request: Request, etag: str, mtime: float) -> bool:
    inm = request.headers.get("if-none-match")
    if inm:
        return etag in [t.strip() for t in inm.split(",")] or "*" in [
            t.strip() for t in inm.split(",")
        ]
    ims = request.headers.get("if-modified-since")
    if ims:
        try:
            since = parsedate_to_datetime(ims)
            mt = datetime.fromtimestamp(mtime, tz=timezone.utc)
            return mt.replace(microsecond=0) <= since
        except (TypeError, ValueError):
            return False  # malformed header -> answer normally (RFC 9110)
    return False


# GZIP-1 (PERF-1, user 2026-10-21): text assets ship gzipped when the
# client accepts it (a ~150 KB CSS bundle and the monolith JS load
# 6-8x smaller; first paint and every ?v= refetch stop saturating the
# browser's ~6-per-origin pool). Compressed once per (path, mtime,
# size): revalidations and repeat loads cost a dict hit, never a
# re-compress. Binary types (woff2/png/…) are already compressed —
# gzipping them wastes CPU and gains nothing. index.html is NOT in the
# set: it is served post-substitution (NAT-3 token + VSTAMP) and gzips
# itself in _serve_index_flagged — a pre-compressed answer here would
# strand the unsubstituted placeholders.
_GZIPABLE = {".css", ".js", ".json", ".svg"}
_GZIP_CACHE: dict[tuple[str, int, int], bytes] = {}


def _gzip_ok(request: Request, path: Path, st) -> bool:
    if path.suffix not in _GZIPABLE or st.st_size < GZIP_MIN_BYTES:
        return False
    ae = request.headers.get("accept-encoding", "")
    return "gzip" in (ae or "").lower()


def _static_file(request: Request, path: str) -> Response:
    file_path = STATIC_DIR / path
    if not file_path.is_file() or not file_path.resolve().is_relative_to(
        STATIC_DIR.resolve()
    ):
        raise HTTPException(status_code=404, detail="Uplift file not found")
    media_type = _MEDIA_TYPES.get(file_path.suffix, "application/octet-stream")
    # html: never cached (entry point). JS/CSS/vendor: revalidate every
    # load — pip-installed packages have no deploy-time ?v= stamping,
    # and heuristic caching resurrected the 'stale cache looks like a
    # failed deploy' trap. Assets are local; 304 revalidation is free.
    if file_path.suffix == ".html":
        cache_control = "no-store"
    elif request.query_params.get("v"):
        cache_control = "public, max-age=31536000, immutable"
    else:
        cache_control = "no-cache"
    # CACHE-1: FileResponse advertises ETag/Last-Modified but does NOT
    # evaluate If-None-Match/If-Modified-Since (no StaticFiles middleware
    # on this auth-gated catch-all), so every revalidation re-sent the
    # full body. Honour the validators here -> 304 with no body.
    st = file_path.stat()
    etag = _static_etag(st)
    if _not_modified(request, etag, st.st_mtime):
        return Response(
            status_code=304,
            headers={
                "Cache-Control": cache_control,
                "ETag": etag,
                "Last-Modified": formatdate(st.st_mtime, usegmt=True),
            },
        )
    # GZIP-1 (PERF-1, user 2026-10-21): text assets ship gzipped when the
    # client accepts it (a ~150 KB CSS bundle and the monolith JS load
    # 6-8x smaller; first paint and every ?v= refetch stop saturating the
    # browser's ~6-per-origin pool). Compressed once per (path, mtime,
    # size): revalidations and repeat loads cost a dict hit, never a
    # re-compress.
    if _gzip_ok(request, file_path, st):
        key = (path, st.st_mtime_ns, st.st_size)
        gz = _GZIP_CACHE.get(key)
        if gz is None:
            if len(_GZIP_CACHE) >= 48:      # bounded (~few MB)
                _GZIP_CACHE.clear()
            gz = gzip.compress(file_path.read_bytes(), 6)
            _GZIP_CACHE[key] = gz
        return Response(
            gz, media_type=media_type, status_code=200,
            headers={"Content-Encoding": "gzip",
                    "Cache-Control": cache_control,
                    "ETag": etag,
                    "Last-Modified": formatdate(st.st_mtime, usegmt=True),
                    "Vary": "Accept-Encoding"},
        )
    return FileResponse(
        file_path, media_type=media_type,
        headers={"Cache-Control": cache_control},
    )


# --------------------------------------------------------------------------
# Session gate + login page
# --------------------------------------------------------------------------

async def _gate(request: Request, back_base: str) -> Optional[RedirectResponse]:
    """HTML navigation without a valid session redirects to the Uplift
    login page carrying ?next=. API fetches get a plain 401 — a redirect
    would hand fetch an HTML body. back_base is the login path to send
    them to ('/uplift/login')."""
    try:
        await require_admin(request)
    except Exception as exc:  # _RedirectToLogin (HTTP-ish) or 401
        if not isinstance(exc, _RedirectToLogin):
            raise
        target = request.url.path
        if request.url.query:
            target = f"{target}?{request.url.query}"
        return RedirectResponse(
            url=f"{back_base}?next={quote(target, safe='')}", status_code=302
        )
    return None


_LOGIN_STYLE = """
body { display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
.login-card { width:min(360px, 90vw); border:1px solid var(--ink); background:var(--card); padding:28px; }
.login-card h1 { font:500 13px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; margin:0 0 20px; }
.login-card input { width:100%; box-sizing:border-box; background:var(--field); border:1px solid var(--edge);
  color:var(--ink); font:400 13px/1 var(--mono); padding:10px; }
.login-card button { width:100%; margin-top:12px; padding:10px; background:var(--ink); color:var(--bg);
  border:1px solid var(--ink); font:500 11px/1 var(--mono); letter-spacing:.1em; cursor:pointer; }
.login-card button:hover { background:transparent; color:var(--ink); }
.err { color:var(--red); font:400 11px/1.4 var(--mono); min-height:14px; margin-top:10px; }
.hint { color:var(--dim); font:300 10px/1.5 var(--sans); margin-top:14px; }
"""

# shared redirect/query handling; the body differs between the two modes
_LOGIN_NEXT_JS = """
const qp = new URLSearchParams(location.search);
let next = qp.get('next') || '/uplift/';
if (!next.startsWith('/') || next.startsWith('//')) next = '/uplift/';
"""


def _login_doc(title: str, body: str, script: str) -> str:
    return ("<!doctype html>\n<html lang=\"en\"><head>\n"
            "<meta charset=\"utf-8\"><meta name=\"viewport\" "
            "content=\"width=device-width, initial-scale=1\">\n"
            f"<title>{title} - Uplift</title>\n"
            "<link rel=\"icon\" href=\"/admin/static/favicon.svg\" "
            "type=\"image/svg+xml\">\n"
            "<link rel=\"stylesheet\" href=\"./uplift.css?v=BUILD\">\n"
            f"<style>{_LOGIN_STYLE}</style></head>\n"
            f"<body class=\"top-glyphs\"><div class=\"login-card\">{body}</div>"
            f"<script>{_LOGIN_NEXT_JS}{script}</script></body></html>")


_LOGIN_HTML = _login_doc(
    "Login",
    """<h1>Uplift &mdash; Admin Login</h1>
<form id="f"><input id="k" type="password" placeholder="API key" autocomplete="current-password">
<button type="submit">LOG IN</button></form>
<div class="err" id="e"></div>
<div class="hint">Same API key as the classic dashboard; the session is shared.</div>""",
    """
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'); e.textContent = '';
  try {
    const r = await fetch('/uplift/login', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({api_key: document.getElementById('k').value})});
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success !== true) throw new Error(d.detail || ('http ' + r.status));
    location.href = next;
  } catch (err) { e.textContent = String(err.message || err); }
};
""")

# AUTH-SETUP (SYNC-1 2026-10-22): fresh server with no key configured —
# the login card would answer 'Invalid API key' to everything forever.
# Mirror the classic first-run flow instead: the form posts straight to
# vanilla's /admin/api/setup-api-key (loopback-only, one-time; it
# validates, persists and mints the SHARED session cookie), then walks
# on to ?next= already logged in. No uplift-side key storage.
_SETUP_HTML = _login_doc(
    "Set up",
    """<h1>Uplift &mdash; Set Up API Key</h1>
<form id="f">
<input id="k" type="password" placeholder="New API key" autocomplete="new-password">
<input id="kc" type="password" placeholder="Enter API key again" autocomplete="new-password" style="margin-top:10px">
<button id="g" type="button">GENERATE RANDOM KEY</button>
<button type="submit">SET API KEY</button></form>
<div class="err" id="e"></div>
<div class="hint">Min 4 characters, no spaces. This same key logs you in to the
classic dashboard and authorizes API calls. Initial setup works from this
machine only (loopback).</div>""",
    """
document.getElementById('g').onclick = () => {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  const hex = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('k').value = hex;
  document.getElementById('kc').value = hex;
};
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'); e.textContent = '';
  try {
    const r = await fetch('/admin/api/setup-api-key', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({api_key: document.getElementById('k').value,
                           api_key_confirm: document.getElementById('kc').value})});
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success !== true) throw new Error(d.detail || ('http ' + r.status));
    location.href = next;
  } catch (err) { e.textContent = String(err.message || err); }
};
""")


def _admin_key_configured() -> bool:
    """False only when the server is up and NO admin API key exists yet.
    Any uncertainty (no vanilla settings in viewer mode, broken getter)
    keeps the normal login card."""
    try:
        gs = global_settings()
        if gs is None:
            return True     # no vanilla state to read — not our call to make
    except Exception:
        return True
    try:
        return bool(gs is not None and gs.auth.api_key)
    except Exception:
        return True


def _login_page(setup: bool = False) -> HTMLResponse:
    html = _SETUP_HTML if setup else _LOGIN_HTML
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


class LoginRequest(BaseModel):
    api_key: str
    remember: bool = False


# AUTH-1 (SWEEP183 B3): constant-time key compare + a small brute-force
# throttle. compare_keys is vanilla's own helper (secrets.compare_digest
# over UTF-8 bytes, survives non-ASCII input); the soft import keeps the
# viewer/standalone path working where omlx is absent. The throttle is
# deliberately dumb and in-memory: localhost tool, the goal is to make
# scripted guessing pointless, not to run a WAF. Exponential cool-down
# per client IP, reset on success; the dict is capped so a spoofed-source
# flood cannot grow it unboundedly.
LOGIN_FAIL_LIMIT = 5        # failures before the first cool-down


LOGIN_BLOCK_S = 30.0        # first block; doubles per further failure


LOGIN_BLOCK_MAX_S = 900.0


_login_fails: dict[str, list] = {}   # ip -> [fail_count, block_until_ts]


def _compare_keys(provided: str, expected: str) -> bool:
    try:
        from omlx.admin.auth import compare_keys
        return compare_keys(provided, expected)
    except Exception:   # viewer mode / older vanilla without the helper
        import secrets
        try:
            return secrets.compare_digest(
                provided.encode("utf-8", "surrogatepass"),
                expected.encode("utf-8", "surrogatepass"))
        except Exception:
            return False


def _login_blocked(ip: str) -> float:
    """Seconds left of the cool-down for IP (0 = free to try)."""
    ent = _login_fails.get(ip)
    if not ent:
        return 0.0
    return max(0.0, ent[1] - time.time())


def _login_failed(ip: str) -> None:
    if len(_login_fails) > 1024:      # cap: prefer evicting everyone
        _login_fails.clear()
    n = _login_fails.get(ip, [0, 0.0])[0] + 1
    if n >= LOGIN_FAIL_LIMIT:
        block = min(LOGIN_BLOCK_MAX_S,
                    LOGIN_BLOCK_S * (2 ** (n - LOGIN_FAIL_LIMIT)))
        _login_fails[ip] = [n, time.time() + block]
    else:
        _login_fails[ip] = [n, 0.0]


def _login_ok(ip: str) -> None:
    _login_fails.pop(ip, None)


@page_router.post("/uplift/login", include_in_schema=False)
async def uplift_login(request: Request):
    """Validate the admin API key and mint the shared session cookie.

    Same token format as vanilla (omlx.admin.auth.create_session_token)
    and cookie path '/' so /admin and /uplift share one session.

    NOTE: served at /uplift/login (NOT /uplift/api/login) — a literal
    page route under /uplift/api/ outranks the API router's dynamic
    routes in FastAPI>=0.141 candidate matching and swallows them."""
    body = await request.json()
    api_key = str((body or {}).get("api_key", ""))
    ip = request.client.host if request.client else "?"
    wait_s = _login_blocked(ip)
    if wait_s:
        raise HTTPException(
            status_code=429,
            detail=f"too many failed logins — retry in {int(wait_s) + 1}s")
    gs = global_settings()
    expected = gs.auth.api_key if gs and gs.auth.api_key else None
    if not expected:
        # Fresh server: there is no key to match — the GET now renders the
        # setup card, so say that instead of a false 'Invalid API key' and
        # do NOT feed the brute-force throttle for a state error.
        raise HTTPException(
            status_code=400,
            detail="no API key configured yet — reload this page to create one")
    if not _compare_keys(api_key, expected):
        _login_failed(ip)
        raise HTTPException(status_code=401, detail="Invalid API key")
    _login_ok(ip)
    # vanilla imports happen only on the SUCCESS path: a box without omlx
    # must still be able to answer the state errors above
    from omlx.admin.auth import (
        SESSION_COOKIE_NAME,
        SESSION_MAX_AGE,
        REMEMBER_ME_MAX_AGE,
        create_session_token,
    )
    remember = bool((body or {}).get("remember", False))
    token = create_session_token(remember=remember)
    response = {"success": True}
    from fastapi.responses import JSONResponse

    out = JSONResponse(response)
    out.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        path="/",
        httponly=True,
        samesite="lax",
        max_age=REMEMBER_ME_MAX_AGE if remember else SESSION_MAX_AGE,
    )
    return out


@page_router.get("/uplift", include_in_schema=False)
async def uplift_root():
    return RedirectResponse(url="/uplift/", status_code=307)


@page_router.get("/admin/uplift", include_in_schema=False)
async def uplift_root_legacy():
    return RedirectResponse(url="/uplift/", status_code=307)


@page_router.get("/uplift/login", include_in_schema=False)
async def uplift_login_page():
    # first-run parity with classic: with no key configured the card asks
    # to CREATE one (posts to vanilla's /admin/api/setup-api-key)
    return _login_page(setup=not _admin_key_configured())


_ASSET_URL_RE = re.compile(rb'((?:src|href)="\./[^"?]+)(")')
_ASSET_VER: tuple = (0, "", 0)  # (boot mtime_ns, size, stamp)


def _asset_stamp() -> str:
    """Deploy identity of the shipped static bundle. Anchored on
    uplift_boot.js (every deploy rewrites the whole package dir together)
    plus the package version, hashed short. Two stats per request; the
    result is cached on the anchor's (mtime_ns, size)."""
    global _ASSET_VER
    from .. import __version__

    try:
        st = (STATIC_DIR / "uplift_boot.js").stat()
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return "0"
    if _ASSET_VER[0] == key[0] and _ASSET_VER[1] == key[1]:
        return _ASSET_VER[2]
    stamp = hashlib.sha1(
        f"{__version__}:{key[0]}:{key[1]}".encode()).hexdigest()[:12]
    _ASSET_VER = (key[0], key[1], stamp)
    return stamp


def _serve_index_flagged(request: Request) -> Response:
    """NAT-3: index.html carries the literal token NATIVE_SURFACES_TOKEN in
    <html data-native-surfaces="...">. The kill-switch is per-INSTANCE
    config, so it cannot be baked into the shipped file — substitute
    the resolved value at serve time. Index is already Cache-Control:
    no-store (entry point), so the replacement never strands a stale flag;
    the ?native= URL override therefore applies on every fresh load.

    VSTAMP (user doctrine 2026-10-14): every relative asset URL
    (``./uplift_boot.js``, ``./vendor/*.css`` …) is served with
    ``?v=<stamp>``, where the stamp changes whenever the shipped package
    changes. A no-store index plus content-addressed URLs means a browser
    that loads the page AFTER a deploy physically cannot execute the
    PREVIOUS bundle — the failure this kills for good: a reinstall moved
    the Cellar dir under a live board, its asset route 404'd all afternoon,
    and the browsers quietly kept executing the stale cached JS (a 'fixed'
    client that never fixes, not even after a hard reload). 304
    revalidation of a dead URL falls back to cache; a NEW URL cannot.

    GZIP-1: the substituted index is gzipped when accepted, cached by
    (stamp, mode, if-none-match result) — one entry per live combination,
    ~12 KB answers instead of ~57 KB on every tab load."""
    resp = _static_file(request, "index.html")
    from .. import native_surfaces

    mode = native_surfaces.resolve(request.query_params.get("native"))
    if isinstance(resp, FileResponse):
        body = resp.path.read_bytes().replace(
            b"NATIVE_SURFACES_TOKEN", mode.encode()
        )
        stamp = _asset_stamp().encode()
        body = body.replace(
            b"data-native-surfaces=",
            b'data-vstamp="' + stamp + b'" data-native-surfaces=',
            1,
        )
        body = _ASSET_URL_RE.sub(
            lambda m: m.group(1) + b"?v=" + stamp + b'"', body
        )
        headers = dict(resp.headers)
        headers.pop("content-length", None)
        if "gzip" in (request.headers.get("accept-encoding", "") or "").lower():
            key = (stamp, mode)
            gz = _GZIP_CACHE.get(("idx",) + key)
            if gz is None:
                gz = gzip.compress(body, 6)
                if len(_GZIP_CACHE) >= 48:
                    _GZIP_CACHE.clear()
                _GZIP_CACHE[("idx",) + key] = gz
            headers["Content-Encoding"] = "gzip"
            headers["Content-Length"] = str(len(gz))
            headers["Vary"] = "Accept-Encoding"
            return Response(gz, media_type="text/html", status_code=200,
                            headers=headers)
        return HTMLResponse(content=body, status_code=resp.status_code,
                            headers=headers)
    return resp  # 304 etc.


async def _serve_index(request: Request):
    redirect = await _gate(request, "/uplift/login")
    if redirect is not None:
        return redirect
    return _serve_index_flagged(request)


@page_router.get("/uplift/", include_in_schema=False)
async def uplift_index(request: Request):
    return await _serve_index(request)


@page_router.get("/admin/uplift/", include_in_schema=False)
async def uplift_index_legacy(request: Request):
    return await _serve_index(request)


@page_router.get("/uplift/{path:path}", include_in_schema=False)
async def uplift_static(path: str, request: Request):
    if (path or "index.html") == "index.html":
        redirect = await _gate(request, "/uplift/login")
        if redirect is not None:
            return redirect
        return _serve_index_flagged(request)  # NAT-3: token substitution too
    await require_admin(request)
    return _static_file(request, path)


@page_router.get("/admin/uplift/{path:path}", include_in_schema=False)
async def uplift_static_legacy(path: str, request: Request):
    return await uplift_static(path, request)
