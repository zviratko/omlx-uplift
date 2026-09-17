"""Standalone Uplift viewer — same UI for installs that can't load Python.

Serves the packaged UI and proxies API traffic to a remote/local vanilla
oMLX over plain HTTP, relaying the admin session cookie. Nothing is
written to the oMLX install; the optional usage.sqlite3 history read is
read-only and only when the file is reachable locally.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from .router import _LOGIN_HTML, _static_file


def build_viewer_app(api_base: str = "") -> FastAPI:
    app = FastAPI(title="Uplift viewer", docs_url=None, redoc=None)
    base = api_base.rstrip("/")

    def _proxy(path: str, request: Request) -> Response:
        if not base:
            return JSONResponse(
                {"detail": "viewer started without --api"}, status_code=502
            )
        url = f"{base}{path}"
        if request.url.query:
            url = f"{url}?{request.url.query}"
        body = None if request.method in ("GET", "HEAD") else (
            request.__dict__.get("_body") or b"")
        req = urllib.request.Request(url, data=body or None, method=request.method)
        for h in ("Content-Type", "Accept", "Cookie"):
            v = request.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                out = Response(content=data, status_code=resp.status,
                               media_type=resp.headers.get("Content-Type"))
                for cookie in resp.headers.get_all("Set-Cookie") or []:
                    out.headers.append("Set-Cookie", cookie)
                return out
        except urllib.error.HTTPError as e:
            data = e.read()
            out = Response(content=data, status_code=e.code,
                           media_type=e.headers.get("Content-Type")
                           if e.headers else None)
            for cookie in (e.headers.get_all("Set-Cookie") if e.headers else None) or []:
                out.headers.append("Set-Cookie", cookie)
            return out
        except Exception as e:  # unreachable upstream — honest, retryable
            return JSONResponse({"detail": f"upstream unreachable: {e}"},
                                status_code=502)

    @app.get("/", include_in_schema=False)
    async def root():
        from fastapi.responses import RedirectResponse

        return RedirectResponse("/uplift/", status_code=307)

    @app.get("/uplift", include_in_schema=False)
    async def u_root():
        from fastapi.responses import RedirectResponse

        return RedirectResponse("/uplift/", status_code=307)

    @app.get("/uplift/login", include_in_schema=False)
    async def login_page():
        return HTMLResponse(_LOGIN_HTML, headers={"Cache-Control": "no-store"})

    @app.post("/uplift/login", include_in_schema=False)
    async def login(request: Request):
        # Mirror the packaged router's login endpoint path (see
        # router.uplift_login for why it is not /uplift/api/login).
        request.__dict__["_body"] = await request.body()
        out = _proxy("/admin/api/login", request)
        # Upstream sets its cookie pathless (browser scopes it to the
        # request URL) — force Path=/ so /admin/api AND /uplift/api calls
        # from the browser both carry it through this proxy.
        cookies = out.headers.get_list("set-cookie") if hasattr(out.headers, "get_list") else []
        if cookies:
            for k in list(out.headers.keys()):
                if k.lower() == "set-cookie":
                    del out.headers[k]
            for c in cookies:
                if "path=" not in c.lower():
                    c += "; Path=/"
            for c in cookies:
                out.headers.append("set-cookie", c)
        return out

    @app.get("/uplift/", include_in_schema=False)
    async def index():
        return _static_file("index.html")

    # API surface BEFORE the static catch-all (FastAPI matches in
    # registration order). /admin/api/* and /uplift/api/* both proxy
    # upstream. Vanilla's 404 on /admin/api/requests is forwarded verbatim
    # — the UI capability-probes it and hides live-feed features.
    @app.api_route("/admin/api/{path:path}",
                   methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
    async def api_admin(path: str, request: Request):
        request.__dict__["_body"] = await request.body()
        return _proxy(f"/admin/api/{path}", request)

    @app.api_route("/uplift/api/{path:path}",
                   methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
    async def api_uplift(path: str, request: Request):
        request.__dict__["_body"] = await request.body()
        if path.startswith("metrics/"):
            return _metrics_local(path)
        return _proxy(f"/admin/api/{path}", request)

    @app.get("/uplift/{path:path}", include_in_schema=False)
    async def static(path: str):
        return _static_file(path or "index.html")

    def _metrics_local(path: str) -> Response:
        """Read-only history from a locally reachable usage.sqlite3."""
        from .store import default_db_path, open_usage_ro

        usage_path = default_db_path().parent.parent / "usage.sqlite3"
        if not usage_path.exists():
            return JSONResponse({"origin": "none", "series": []})
        try:
            conn = open_usage_ro(usage_path)
            rows = conn.execute(
                "SELECT timestamp_hour, model_id, requests, prompt_tokens,"
                " completion_tokens, cached_tokens, request_seconds"
                " FROM model_usage_hourly ORDER BY timestamp_hour DESC LIMIT ?",
                (int(path.rsplit("hours=", 1)[1]) if "hours=" in path else 168,),
            ).fetchall()
            conn.close()
            return JSONResponse({"origin": "usage.sqlite3", "rows": [dict(r) for r in rows]})
        except Exception as e:
            return JSONResponse({"origin": "error", "detail": str(e), "series": []})

    return app
