"""Uplift HTTP surface — page gate, static files, and uplift API routes.

Every route lives in THIS module; omlx/admin/routes.py stays vanilla.
Auth reuses omlx.admin.auth.require_admin (session cookie) so a login at
/admin also unlocks /uplift and vice versa — same token, httponly cookie.

Route map (register() mounts api_router under /uplift/api AND /admin/api):
  GET  /uplift                     -> 307 /uplift/
  GET  /uplift/                    -> index.html (session-gated)
  GET  /uplift/login               -> uplift login page (no auth needed)
  POST /uplift/login               -> validate key, mint session cookie
                                      (NOT /uplift/api/login: a literal
                                      under /uplift/api/ outranks the API
                                      router in FastAPI>=0.141 matching)
  GET  /uplift/{path}              -> static asset (auth-gated)
  GET  /admin/uplift[/...]         -> legacy aliases of the three above
  GET  /uplift/api/models          -> vanilla model list + used_by overlay
  GET  /uplift/api/requests        -> live request feed (sampled)
  GET  /uplift/api/requests/stream -> SSE lifecycle feed
  POST /uplift/api/requests/{id}/cancel
  GET  /uplift/api/model-settings-index
  POST /uplift/api/prune-model-settings
  GET  /uplift/api/models/{id}/settings
  DELETE /uplift/api/models/{id}/settings
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

try:  # normal runtime: we are importable inside omlx's environment
    from omlx.admin.auth import _RedirectToLogin, require_admin
except ImportError:  # pragma: no cover
    # Standalone viewer mode on a machine WITHOUT omlx (DMG users): the
    # router is imported only for its static/login helpers; endpoints
    # that actually need auth are unreachable because the viewer mounts
    # its own handlers. Keep the import soft and raise only on use.
    class _RedirectToLogin(Exception):  # placeholder for isinstance checks
        pass

    def require_admin(request):  # type: ignore
        raise RuntimeError(
            "omlx-uplift router mounted without omlx: run `omlx-uplift "
            "serve` inside the oMLX environment, or the standalone viewer"
        )

from .request_log import get_request_tracker
from .collector import get_collector

STATIC_DIR = Path(__file__).resolve().parent / "static"

page_router = APIRouter()
api_router = APIRouter()


# --------------------------------------------------------------------------
# Server-state access (same DI convention as omlx.admin.routes)
# --------------------------------------------------------------------------

def engine_pool():
    from omlx.server import _server_state

    return _server_state.engine_pool


def settings_manager():
    from omlx.server import _server_state

    return _server_state.settings_manager


def global_settings():
    from omlx.server import _server_state

    return _server_state.global_settings


def _require_settings_manager():
    mgr = settings_manager()
    if mgr is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    return mgr


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


def _static_file(path: str) -> FileResponse:
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
        headers = {"Cache-Control": "no-store"}
    else:
        headers = {"Cache-Control": "no-cache"}
    return FileResponse(file_path, media_type=media_type, headers=headers)


# --------------------------------------------------------------------------
# Session gate + login page
# --------------------------------------------------------------------------

def _safe_next(request: Request) -> str:
    """Validate an optional ?next= target: same-origin path under /uplift or
    /admin only (never an absolute URL — no open redirect)."""
    nxt = request.query_params.get("next", "")
    if not isinstance(nxt, str):  # test doubles / malformed multiparams
        return ""
    if (nxt.startswith("/uplift") or nxt.startswith("/admin/")) and "//" not in nxt[:9]:
        return nxt
    return ""


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


_LOGIN_HTML = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - Uplift</title>
<link rel="icon" href="/admin/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="./uplift.css?v=BUILD">
<style>
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
</style></head>
<body class="top-glyphs"><div class="login-card">
<h1>Uplift &mdash; Admin Login</h1>
<form id="f"><input id="k" type="password" placeholder="API key" autocomplete="current-password">
<button type="submit">LOG IN</button></form>
<div class="err" id="e"></div>
<div class="hint">Same API key as the classic dashboard; the session is shared.</div>
</div><script>
const qp = new URLSearchParams(location.search);
let next = qp.get('next') || '/uplift/';
if (!next.startsWith('/') || next.startsWith('//')) next = '/uplift/';
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
</script></body></html>"""


def _login_page() -> HTMLResponse:
    return HTMLResponse(_LOGIN_HTML, headers={"Cache-Control": "no-store"})


class LoginRequest(BaseModel):
    api_key: str
    remember: bool = False


@page_router.post("/uplift/login", include_in_schema=False)
async def uplift_login(request: Request):
    """Validate the admin API key and mint the shared session cookie.

    Same token format as vanilla (omlx.admin.auth.create_session_token)
    and cookie path '/' so /admin and /uplift share one session.

    NOTE: served at /uplift/login (NOT /uplift/api/login) — a literal
    page route under /uplift/api/ outranks the API router's dynamic
    routes in FastAPI>=0.141 candidate matching and swallows them."""
    from omlx.admin.auth import (
        SESSION_COOKIE_NAME,
        SESSION_MAX_AGE,
        REMEMBER_ME_MAX_AGE,
        create_session_token,
    )

    body = await request.json()
    api_key = (body or {}).get("api_key", "")
    gs = global_settings()
    expected = gs.auth.api_key if gs and gs.auth.api_key else None
    if not expected or api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")
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


# --------------------------------------------------------------------------
# Pages (canonical /uplift + legacy /admin/uplift aliases)
# --------------------------------------------------------------------------


@page_router.get("/uplift", include_in_schema=False)
async def uplift_root():
    return RedirectResponse(url="/uplift/", status_code=307)


@page_router.get("/admin/uplift", include_in_schema=False)
async def uplift_root_legacy():
    return RedirectResponse(url="/uplift/", status_code=307)


@page_router.get("/uplift/login", include_in_schema=False)
async def uplift_login_page():
    return _login_page()


async def _serve_index(request: Request):
    redirect = await _gate(request, "/uplift/login")
    if redirect is not None:
        return redirect
    return _static_file("index.html")


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
    else:
        await require_admin(request)
    return _static_file(path or "index.html")


@page_router.get("/admin/uplift/{path:path}", include_in_schema=False)
async def uplift_static_legacy(path: str, request: Request):
    return await uplift_static(path, request)


# --------------------------------------------------------------------------
# i18n: merged locale catalog for the uplift UI
#   layer 1: classic's omlx/admin/i18n/<lang>.json (READ-ONLY via import;
#            same English-fallback semantics as classic's _load_locale)
#   layer 2: our own locales/<lang>.json additive keys (uplift-only
#            strings). Classic wins on collision is WRONG for uplift-owned
#            words, so overlay wins — uplift keys use the `uplift.*`
#            namespace by convention, collisions are a bug either way.
# --------------------------------------------------------------------------

_PACKAGE_LOCALES = Path(__file__).resolve().parent / "locales"
_LANG_RE = __import__("re").compile(r"^[a-zA-Z-]{2,10}$")


def _safe_lang(lang: str) -> str:
    lang = (lang or "en").strip()
    return lang if _LANG_RE.match(lang) else "en"


def _read_json_dict(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_locale(lang: str) -> dict:
    """Merged catalog for LANG. Classic JSON read through classic's own
    loader when available (its fallback chain is the reference), then our
    overlay on top; without omlx (viewer mode) our files alone."""
    lang = _safe_lang(lang)
    base: dict = {}
    try:
        from omlx.admin.routes import _load_locale, _i18n_dir  # read-only reuse

        base = _load_locale(lang)
    except Exception:
        # viewer / no omlx: our own dir replicates the same fallback shape
        base = _read_json_dict(_PACKAGE_LOCALES / "en.json")
        if lang != "en":
            base.update(_read_json_dict(_PACKAGE_LOCALES / f"{lang}.json"))
        return base
    # current server language not needed — we serve whatever lang was asked
    overlay = _read_json_dict(_PACKAGE_LOCALES / f"{lang}.json")
    if lang != "en":
        en_overlay = _read_json_dict(_PACKAGE_LOCALES / "en.json")
        merged_overlay = {**en_overlay, **overlay}
    else:
        merged_overlay = overlay
    _ = _i18n_dir  # referenced only to prove the import path exists
    return {**base, **merged_overlay}


@api_router.get("/locale")
async def locale_catalog(lang: Optional[str] = None):
    """Merged i18n catalog for the uplift UI (classic keys + uplift
    overlay). No lang given -> the server's configured ui.language, same
    source classic templates use. Public: mirrors classic, whose login
    page renders locale strings before authentication."""
    if not lang:
        try:
            lang = global_settings().ui.language
        except Exception:
            lang = "en"
    lang = _safe_lang(lang)
    return {"lang": lang, "strings": await asyncio.to_thread(load_locale, lang)}


# --------------------------------------------------------------------------
# Models overlay: vanilla response + used_by (helper consumers reverse map)
# --------------------------------------------------------------------------


@api_router.get("/models")
async def models_overlay(is_admin: bool = Depends(require_admin)):
    """Vanilla GET /api/models verbatim, with a 'used_by' key per row.

    Delegates to the real omlx route function (no duplication, no drift):
    the drafter reference fields in stored settings are re-read here to
    build drafter -> [consumer ids], so the Helper page can show WHO uses
    a drafter instead of a meaningless load button.
    """
    from omlx.admin import routes as admin_routes

    data = await admin_routes.list_models(is_admin=True)
    mgr = settings_manager()
    helper_users: dict[str, set] = {}
    if mgr is not None:
        for _mid, _ms in mgr.get_all_settings().items():
            for _ref in (
                getattr(_ms, "specprefill_draft_model", None),
                getattr(_ms, "dflash_draft_model", None),
                getattr(_ms, "vlm_mtp_draft_model", None),
            ):
                if _ref:
                    helper_users.setdefault(_ref, set()).add(_mid)
    for row in data.get("models", []):
        users = set(helper_users.get(row.get("id"), set()))
        users |= helper_users.get(row.get("model_path") or "", set())
        users |= helper_users.get(row.get("source_repo_id") or "", set())
        users.discard(row.get("id"))
        row["used_by"] = sorted(users)
    return data


# --------------------------------------------------------------------------
# Model settings: GET / DELETE + index + prune (additive surface)
# --------------------------------------------------------------------------


@api_router.get("/models/{model_id}/settings")
async def get_model_settings(
    model_id: str, is_admin: bool = Depends(require_admin)
):
    """Stored settings for one model: {id, settings} (to_dict strips None)."""
    mgr = _require_settings_manager()
    pool = engine_pool()
    if pool is not None and pool.get_entry(model_id) is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    settings = mgr.get_settings(model_id)
    return {"id": model_id, "settings": settings.to_dict()}


@api_router.delete("/models/{model_id}/settings")
async def delete_model_settings_route(
    model_id: str, is_admin: bool = Depends(require_admin)
):
    """Clear stored settings for one model (reset to defaults)."""
    mgr = _require_settings_manager()
    if mgr.delete_settings(model_id):
        return {"deleted": model_id}
    raise HTTPException(status_code=404, detail=f"No stored settings: {model_id}")


@api_router.get("/model-settings-index")
async def model_settings_index(is_admin: bool = Depends(require_admin)):
    """Stored model-settings ids vs models discovered on disk.

    Powers the Models manager 'stored/missing' counts and the prune
    dialog: {stored, known, orphans, entries:[{id, alias}]}.
    """
    mgr = _require_settings_manager()
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    all_settings = mgr.get_all_settings()
    known = set(pool.get_model_ids())
    alias_of = {
        mid: ms.model_alias
        for mid, ms in all_settings.items()
        if getattr(ms, "model_alias", None)
    }
    orphans = sorted(set(all_settings) - known - set(alias_of.values()))
    entries = sorted(
        ({"id": mid, "alias": alias_of.get(mid)} for mid in all_settings),
        key=lambda e: e["id"],
    )
    return {
        "stored": len(all_settings),
        "known": len(known),
        "orphans": orphans,
        "entries": entries,
    }


class PruneModelSettingsRequest(BaseModel):
    ids: list[str]


@api_router.post("/prune-model-settings")
async def prune_model_settings(
    req: PruneModelSettingsRequest, is_admin: bool = Depends(require_admin)
):
    """Delete stored settings for the listed model ids. Templates are
    left alone (conservative)."""
    mgr = _require_settings_manager()
    if not req.ids:
        raise HTTPException(status_code=400, detail="ids required")
    removed = [mid for mid in dict.fromkeys(req.ids) if mgr.delete_settings(mid)]
    return {"removed": removed, "removed_templates": []}


# --------------------------------------------------------------------------
# Persistent metrics: merge uplift's sub-hour samples with vanilla's
# hourly rollups (~/.omlx/usage.sqlite3, opened READ-ONLY — we never write
# it). Points carry res='fine'|'hourly' so the UI can label the resolution
# boundary honestly instead of pretending one uniform series.
# --------------------------------------------------------------------------

# uplift sample key -> derivation from a model_usage_hourly aggregate row
_HOURLY_DERIVE = {
    "rate.prompt_tokens_s":   lambda r: r["prompt_tokens"] / 3600.0,
    "rate.completion_tokens_s": lambda r: r["completion_tokens"] / 3600.0,
    "rate.requests_s":        lambda r: r["requests"] / 3600.0,
    "cache_efficiency":       lambda r: (r["cached_tokens"] / r["prompt_tokens"])
                                        if r["prompt_tokens"] else None,
    "avg_prefill_tps":        lambda r: (r["prompt_tokens"] / r["prefill_seconds"])
                                        if r["prefill_seconds"] else None,
    "avg_generation_tps":     lambda r: (r["completion_tokens"] / r["generation_seconds"])
                                        if r["generation_seconds"] else None,
}

# usage columns needed by the derivations above
_USAGE_COLS = ("requests", "prompt_tokens", "completion_tokens",
               "cached_tokens", "prefill_seconds", "generation_seconds")


MAX_SERIES_POINTS = 2000


def _downsample(points: list[dict], max_pts: int = MAX_SERIES_POINTS):
    """Average into equal-width buckets so a 30d pull is ~thousands of
    points, not hundreds of thousands. Buckets align to wall-clock
    multiples of bucket_s; each output point carries the bucket START and
    res='avg' (plus the true resolution inside: 'hourly' stays hourly if
    the whole bucket came from coarse rollups). Returns (points, bucket_s)
    or (points, 0) when no downsampling was needed."""
    if len(points) <= max_pts:
        return points, 0
    span = points[-1]["ts"] - points[0]["ts"] or 1.0
    # Next power of 10 that fits the cap; 60 s is the honest floor (never
    # advertise sub-minute averages). The pow-of-10 step guarantees the
    # 60 s clamp cannot overshoot the cap (raw < 60 => span/60 < max_pts).
    bucket_s = max(60.0, 10.0 ** math.ceil(math.log10(span / max_pts)))
    buckets: dict[int, list[dict]] = {}
    for p in points:
        buckets.setdefault(int(p["ts"] // bucket_s), []).append(p)
    out = []
    for b in sorted(buckets):
        rows = buckets[b]
        vals = [r["v"] for r in rows if r["v"] is not None]
        if not vals:
            continue
        res = "hourly" if all(r["res"] == "hourly" for r in rows) else "avg"
        out.append({"ts": b * bucket_s, "v": sum(vals) / len(vals), "res": res})
    return out, bucket_s


@api_router.get("/metrics/series")
async def metrics_series(
    key: str = "",
    keys: str = "",
    window: str = "1h",
    is_admin: bool = Depends(require_admin),
):
    """Series over WINDOW (5m..30d) for KEY, or for every key in
    comma-separated KEYS (multi-metric explorer: one request, one merged
    per-key response in `series_map`). Long windows are averaged down to
    ~MAX_SERIES_POINTS points and say so (res='avg', bucket_s)."""
    import asyncio

    wanted = [k.strip() for k in (keys or key).split(",") if k.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="key or keys required")
    window_s = _parse_window(window)
    store = get_collector().store

    async def one(k: str):
        fine = await asyncio.to_thread(store.series, k, window_s)
        for p in fine:
            p["res"] = "fine"
        hourly = []
        derive = _HOURLY_DERIVE.get(k)
        if derive is not None:
            hourly = await asyncio.to_thread(_hourly_points, derive, window_s)
        # Fine points win where both exist (dedupe by hour bucket).
        fine_hours = {int(p["ts"] // 3600) for p in fine}
        merged = fine + [p for p in hourly if int(p["ts"] // 3600) not in fine_hours]
        merged.sort(key=lambda p: p["ts"])
        return _downsample(merged)

    results = await asyncio.gather(*(one(k) for k in wanted))
    series_map, bucket = {}, 0
    for k, (pts, b) in zip(wanted, results):
        series_map[k] = pts
        bucket = max(bucket, b)
    if key and not keys:
        pts = series_map.get(key, [])
        return {"key": key, "window": window, "window_s": window_s,
                "bucket_s": bucket, "series": pts}
    return {"keys": wanted, "window": window, "window_s": window_s,
            "bucket_s": bucket, "series_map": series_map}


def _parse_window(window: str) -> float:
    units = {"m": 60, "h": 3600, "d": 86400}
    w = (window or "1h").strip().lower()
    if w[-1] in units and w[:-1].isdigit():
        return int(w[:-1]) * units[w[-1]]
    raise HTTPException(status_code=400,
                        detail=f"bad window '{window}' (use e.g. 15m/1h/6h/24h/7d)")


def _hourly_points(derive, window_s: float) -> list[dict]:
    """Coarse history from vanilla's usage.sqlite3, READ-ONLY. Rows are
    per (hour, model) — aggregate to per-hour totals BEFORE deriving, so
    one rate = one point per hour (a server-wide chart, not per-model)."""
    from .store import open_usage_ro

    try:
        conn = open_usage_ro()
    except Exception:
        return []  # DB missing/locked — fine layer alone is honest
    try:
        t0 = time.time() - window_s
        sums = ", ".join(f"SUM({c}) AS {c}" for c in _USAGE_COLS)
        cur = conn.execute(
            f"SELECT timestamp_hour, {sums} FROM model_usage_hourly "
            "WHERE timestamp_hour >= ? GROUP BY timestamp_hour "
            "ORDER BY timestamp_hour",
            (int(t0),),
        )
        out = []
        for row in cur.fetchall():
            agg = dict(zip(("timestamp_hour",) + _USAGE_COLS, row))
            ts = agg.pop("timestamp_hour")
            agg = {k: (v or 0) for k, v in agg.items()}
            try:
                v = derive(agg)
            except Exception:
                continue
            if v is not None:
                out.append({"ts": float(ts), "v": float(v), "res": "hourly"})
        return out
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Live request feed — sampled from scheduler admin snapshots; no hot-path
# hooks. Each poll/SSE tick merges omlx_uplift/request_log.py sampling.
# --------------------------------------------------------------------------


@api_router.get("/requests")
async def list_requests(
    limit: int = 30, is_admin: bool = Depends(require_admin)
):
    """Live + recently finished requests, newest first."""
    import asyncio

    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    tracker = get_request_tracker()
    await asyncio.to_thread(tracker.sample, pool)
    return {"requests": tracker.list_rows(limit=limit), "enabled": True}


@api_router.get("/requests/stream")
async def stream_requests(is_admin: bool = Depends(require_admin)):
    """SSE feed of request lifecycle transitions (1 s sampling tick)."""
    import asyncio

    tracker = get_request_tracker()

    async def event_generator():
        try:
            while True:
                pool = engine_pool()
                if pool is not None:
                    await asyncio.to_thread(tracker.sample, pool)
                for row in tracker.drain_dirty():
                    ev = {
                        "type": "request",
                        "id": row["id"],
                        "state": row["state"],
                        "model": row.get("model", ""),
                        "origin": row.get("origin", "real"),
                    }
                    yield f"data: {json.dumps(ev)}\n\n"
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@api_router.post("/requests/{request_id}/cancel")
async def cancel_request(
    request_id: str, is_admin: bool = Depends(require_admin)
):
    """Abort an in-flight request (goes through AsyncEngineCore.abort_request
    inside the tracker — the raw scheduler abort would hang the client)."""
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    if await get_request_tracker().cancel(pool, request_id):
        return {"cancelled": request_id}
    raise HTTPException(status_code=404, detail=f"Request not found: {request_id}")


# --------------------------------------------------------------------------
# Retention policy (RL-0) — uplift-owned data policy, NOT vanilla settings.
# GET reports resolved values + which layer wins; POST persists into the
# store's meta table (takes effect at the next daily purge pass).
# --------------------------------------------------------------------------


class RetentionRequest(BaseModel):
    metrics_days: int | None = None
    log_days: int | None = None


@api_router.get("/retention")
async def get_retention(is_admin: bool = Depends(require_admin)):
    from .store import get_store

    return get_store().retention()


@api_router.post("/retention")
async def set_retention(
    req: RetentionRequest, is_admin: bool = Depends(require_admin)
):
    from .store import get_store

    return get_store().set_retention(req.metrics_days, req.log_days)
