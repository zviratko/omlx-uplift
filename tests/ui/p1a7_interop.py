#!/usr/bin/env python3
"""P1A-7 interop test: a Uplift-style global-settings round-trip through
the real oMLX admin API must not change the persisted settings file.

Flow (mirrors what the Uplift dashboard does in live mode):
  1. read ~/.omlx/settings.json (before)
  2. POST /admin/api/login with the admin api_key -> session cookie
  3. GET  /admin/api/global-settings
  4. POST /admin/api/global-settings with the GET payload UNCHANGED
     (this is exactly what Uplift sends when the user saves without
     editing; masked api_key must survive)
  5. read ~/.omlx/settings.json (after); semantic equality required.

The test only rewrites settings.json with its own content via the API,
so a pass is provably a no-op; on mismatch the file content is reported
section by section and exit code is 1 (restore manually from the printed
path if needed - the script itself never writes the file).

Usage: p1a7_interop.py [--base URL] [--settings PATH]
Defaults: base http://127.0.0.1:<server.port from the settings file>,
settings ~/.omlx/settings.json (R12-1: the port is oMLX's config, not ours).
Exit: 0 pass, 2 skipped (server unreachable - e.g. CI without oMLX), 1 fail.
"""
import argparse, json, sys, urllib.request, urllib.error, pathlib, http.cookiejar, os


def req(opener, url, data=None, headers=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method or ("POST" if data is not None else "GET"))
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    return opener.open(r, timeout=15)


def norm(x):
    return json.dumps(x, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=None)
    ap.add_argument("--settings", default=str(pathlib.Path.home() / ".omlx/settings.json"))
    args = ap.parse_args()
    spath = pathlib.Path(args.settings).expanduser()
    if not spath.exists():
        print(f"SKIP: settings file {spath} not found"); return 2

    before = json.loads(spath.read_text())
    if args.base is None:
        # R12-1: oMLX owns the port; read it from its own settings.
        port = before.get("server", {}).get("port", 8000)
        args.base = f"http://127.0.0.1:{port}"
    key = before.get("auth", {}).get("api_key") or ""

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    try:
        r = req(opener, f"{args.base}/admin/api/login", {"api_key": key})
        if r.status != 200:
            print(f"SKIP: login returned {r.status} (no oMLX at {args.base}?)"); return 2
        got = json.load(req(opener, f"{args.base}/admin/api/global-settings"))
        r = req(opener, f"{args.base}/admin/api/global-settings", got)
        if r.status != 200:
            print(f"FAIL: settings POST returned {r.status}: {r.read()[:200]}"); return 1
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"SKIP: auth rejected ({e.code}) - wrong api_key or different box"); return 2
        print(f"FAIL: HTTP {e.code} {e.read()[:200]}"); return 1
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        print(f"SKIP: server unreachable at {args.base}: {e}"); return 2

    after = json.loads(spath.read_text())
    if norm(before) == norm(after):
        print("PASS: round-trip left settings.json semantically identical")
        return 0
    print("FAIL: settings.json changed after unchanged round-trip:")
    for k in sorted(set(before) | set(after)):
        if norm(before.get(k)) != norm(after.get(k)):
            print(f"  section '{k}': before={norm(before.get(k))[:120]} after={norm(after.get(k))[:120]}")
    print(f"  restore manually: cp with {spath} from before-content saved in this run's stdout")
    print("  BEFORE was:", norm(before)[:400])
    return 1


if __name__ == "__main__":
    sys.exit(main())
