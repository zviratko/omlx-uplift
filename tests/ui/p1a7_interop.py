#!/usr/bin/env python3
"""P1A-7 interop test: a Uplift-style global-settings round-trip through
the real oMLX admin API must not change the persisted settings file.

Flow (mirrors what the Uplift dashboard does in live mode):
  1. read ~/.omlx/settings.json, or ~/.omlx-dev/settings.json on a dev-only box
  2. POST /admin/api/login with the admin api_key -> session cookie
  3. GET  /admin/api/global-settings
  4. POST /admin/api/global-settings with the GET payload UNCHANGED
     (this is exactly what Uplift sends when the user saves without
     editing; masked api_key must survive)
  5. read the same settings file (after); semantic equality required.

The test only rewrites settings.json with its own content via the API.
On any post-save failure or mismatch it restores the original bytes and
reports changed section names only, never setting values or credentials.

Usage: p1a7_interop.py [--base URL] [--settings PATH]
Defaults: base http://127.0.0.1:<server.port from the settings file>,
settings ~/.omlx/settings.json, falling back to ~/.omlx-dev/settings.json.
Exit: 0 pass, 2 skipped (server unreachable - e.g. CI without oMLX), 1 fail.
"""
import argparse, json, sys, urllib.request, urllib.error, pathlib, http.cookiejar


def default_settings(home=None):
    """Prefer a vanilla config, but run the real check on a dev-only box."""
    home = pathlib.Path.home() if home is None else pathlib.Path(home)
    vanilla = home / ".omlx/settings.json"
    return vanilla if vanilla.exists() else home / ".omlx-dev/settings.json"


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
    ap.add_argument("--settings", default=None)
    args = ap.parse_args()
    spath = (pathlib.Path(args.settings).expanduser() if args.settings
             else default_settings())
    if not spath.exists():
        print(f"SKIP: settings file {spath} not found"); return 2

    before_raw = spath.read_bytes()
    before = json.loads(before_raw)
    if args.base is None:
        # R12-1: oMLX owns the port; read it from its own settings.
        port = before.get("server", {}).get("port", 8000)
        args.base = f"http://127.0.0.1:{port}"
    key = before.get("auth", {}).get("api_key") or ""

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    posted = False
    passed = False
    try:
        try:
            r = req(opener, f"{args.base}/admin/api/login", {"api_key": key})
            if r.status != 200:
                print(f"SKIP: login returned {r.status} (no oMLX at {args.base}?)"); return 2
            got = json.load(req(opener, f"{args.base}/admin/api/global-settings"))
            posted = True
            r = req(opener, f"{args.base}/admin/api/global-settings", got)
            if r.status != 200:
                print(f"FAIL: settings POST returned {r.status}"); return 1
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                print(f"SKIP: auth rejected ({e.code}) - wrong api_key or different box"); return 2
            print(f"FAIL: HTTP {e.code}"); return 1
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            print(f"SKIP: server unreachable at {args.base}: {e}"); return 2

        after = json.loads(spath.read_text())
        if norm(before) == norm(after):
            passed = True
            print("PASS: round-trip left settings.json semantically identical")
            return 0
        changed = [k for k in sorted(set(before) | set(after))
                   if norm(before.get(k)) != norm(after.get(k))]
        print("FAIL: settings.json changed after unchanged round-trip; original bytes restored")
        print("  changed sections:", ", ".join(changed))
        return 1
    finally:
        if posted and not passed:
            try:
                spath.write_bytes(before_raw)
            except OSError as exc:
                print(f"ERROR: could not restore {spath}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
