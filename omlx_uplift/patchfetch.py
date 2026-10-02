"""BE-3 step 1 (pure move): the fetch layer of the patch pipeline.

Advisory warnings, PR-ref parsing and every HTTP/TLS/PR-meta path, moved
verbatim out of patchsource.py so 'how does a patch body reach us' has one
home. patchsource re-exports these names (seam compatibility: tests and
curated.py monkeypatch/import patchsource.fetch_pr / fetch_url /
fetch_bytes — the re-export keeps those seams pointing at the same
objects; call sites INSIDE patchsource resolve the bare names through the
module globals, i.e. the patched copies, exactly as before).

Stdlib only (urllib) — usable from the router AND the .pth startup path.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

SIZE_CAP = 2 * 1024 * 1024  # 2 MB per design

_PR_URL_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)/?$")


# --------------------------------------------------------------------------
# Advisory warnings (never block, PAT-0 user policy)
# --------------------------------------------------------------------------

def url_advisories(url: str) -> list[str]:
    """Non-blocking warnings shown inline on the add/preview form."""
    out = []
    if url.startswith("http://"):
        out.append("Scheme is http:// — patch content travels in plaintext.")
    if re.match(r"^[a-zA-Z][\w+.-]*://[^/@]*:[^/@]*@", url):
        out.append("URL carries embedded credentials; the full URL including "
                   "the password is stored in plaintext in patches.json and "
                   "shown on the PATCHES card. Consider a URL that "
                   "authenticates out-of-band.")
    return out


def parse_pr_ref(url_or_repo: str, pr: int | None = None) -> tuple[str, int] | None:
    """Accept a PR web URL or repo + number; return (repo, pr) or None."""
    if pr is not None:
        if re.fullmatch(r"[\w.-]+/[\w.-]+", url_or_repo or ""):
            return url_or_repo, int(pr)
        return None
    m = _PR_URL_RE.match((url_or_repo or "").strip())
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}", int(m.group(3))


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def _opener(insecure_tls: bool):
    if not insecure_tls:
        return urllib.request.build_opener()
    # Deliberate, per-user opt-in (PAT-0 design: "ignore SSL/TLS errors"
    # checkbox, stored as source.insecure_tls). Verification is disabled for
    # THIS fetch only; the user accepts MITM risk for their own patch source.
    import ssl

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


def fetch_bytes(url: str, insecure_tls: bool = False) -> dict:
    """GET url. NO explicit socket timeout (HTTP client / OS defaults are
    generous by nature — PAT-0). Returns {ok, data?, status?, reason?}."""
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "reason": "only http(s) schemes are supported"}
    req = urllib.request.Request(
        url, headers={"User-Agent": "omlx-uplift/patch-carrier",
                      "Accept": "*/*"})
    try:
        opener = _opener(insecure_tls)
        with opener.open(req) as resp:  # noqa: S310 (scheme checked above)
            status = getattr(resp, "status", resp.getcode())
            data = resp.read(SIZE_CAP + 1)
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": exc.code,
                "reason": f"HTTP {exc.code} from {url}"}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"ok": False, "reason": f"fetch failed: {exc}"}
    if not (200 <= status < 300):
        return {"ok": False, "status": status, "reason": f"HTTP {status} from {url}"}
    if len(data) > SIZE_CAP:
        return {"ok": False, "reason": f"patch larger than {SIZE_CAP} bytes"}
    if not data.strip():
        return {"ok": False, "reason": "empty response body"}
    return {"ok": True, "data": data, "status": status}


def fetch_pr(repo: str, pr: int, insecure_tls: bool = False) -> dict:
    """Public PR diff via github.com/.../pull/N.diff — no auth needed.
    Also tries to extract the PR head SHA from the .patch preamble
    (From <sha> line); api.github.com is tried only as a fallback and any
    failure there degrades to content-hash identity, never fails the fetch."""
    r = fetch_bytes(f"https://github.com/{repo}/pull/{pr}.diff", insecure_tls)
    if not r["ok"]:
        return r
    data = r["data"]
    head = _head_sha_from_patch(repo, pr, insecure_tls)
    return {"ok": True, "data": data, "source_head_sha": head,
            "url": f"https://github.com/{repo}/pull/{pr}.diff"}


def _head_sha_from_patch(repo: str, pr: int, insecure_tls: bool) -> str | None:
    """Cheap path: the .patch (mbox) first line is 'From <sha> ...'.
    Fallback: api.github.com. Degrades to None (content hash identity)."""
    r = fetch_bytes(f"https://github.com/{repo}/pull/{pr}.patch", insecure_tls)
    if r["ok"]:
        first = r["data"][:80].split(b"\n", 1)[0]
        m = re.match(rb"From ([0-9a-f]{40}) ", first)
        if m:
            return m.group(1).decode()
    try:
        api = fetch_bytes(f"https://api.github.com/repos/{repo}/pulls/{pr}",
                          insecure_tls)
        if api["ok"]:
            sha = json.loads(api["data"]).get("head", {}).get("sha")
            if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha):
                return sha
    except (ValueError, KeyError):
        pass
    return None


def fetch_url(url: str, insecure_tls: bool = False) -> dict:
    r = fetch_bytes(url, insecure_tls)
    if not r["ok"]:
        return r
    return {"ok": True, "data": r["data"], "source_head_sha": None, "url": url}


def accept_upload(data: bytes) -> dict:
    """Multipart upload path: validate size only; parsing is the gate's job."""
    if len(data) > SIZE_CAP:
        return {"ok": False, "reason": f"patch larger than {SIZE_CAP} bytes"}
    if not data.strip():
        return {"ok": False, "reason": "empty upload"}
    return {"ok": True, "data": data, "source_head_sha": None, "url": None}
