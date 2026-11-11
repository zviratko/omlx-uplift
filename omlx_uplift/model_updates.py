"""UP-64: Hub update check for downloaded models, with ignore rules.

Classic has a one-shot "Check for updates" button (upstream #4949,
``POST /admin/api/hf/updates``). Uplift keeps the result so the dashboard
can show a menu badge without a click:

- The check itself is the engine's ``HFDownloader.check_updates``: one Hub
  ``model_info`` call per downloaded repo (measured on the devbox: 30 repos
  in about 1 s). Repos without hub download records are skipped by the
  engine, so a hand-copied folder never shows an update.
- A read of the state starts a background check when the last one is older
  than ``INTERVAL_S``. No timer runs while no dashboard is open.
- Ignore rules: ``version`` hides the update the Hub has now (keyed by the
  Hub commit sha; a newer commit shows again), ``model`` hides every update
  of that repo and skips its Hub call.

State is one JSON file in the uplift store. It holds repo ids, sizes and
Hub commit ids only, never a token.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from pathlib import Path

_log = logging.getLogger("omlx_uplift.model_updates")

INTERVAL_S = 6 * 3600
IGNORE_MODES = ("version", "model")

_LOCK = threading.Lock()
_task: asyncio.Task | None = None


def state_path() -> Path:
    from . import paths
    return paths.uplift_store_dir() / "model_updates.json"


def _empty() -> dict:
    return {"checked_at": None, "checked": 0, "updates": {}, "failed": [],
            "ignored": {}, "error": None}


def load() -> dict:
    p = state_path()
    try:
        raw = json.loads(p.read_text())
    except FileNotFoundError:
        return _empty()
    except (OSError, ValueError) as e:
        _log.warning("model update state unreadable (%s): %s", p, e)
        return _empty()
    st = _empty()
    if not isinstance(raw, dict):
        return st
    kinds = {"checked_at": (int, float), "checked": int, "updates": dict,
             "failed": list, "ignored": dict, "error": str}
    for k, kind in kinds.items():
        if isinstance(raw.get(k), kind):
            st[k] = raw[k]
    return st


def _save(st: dict) -> None:
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False))
    tmp.replace(p)


def is_ignored(st: dict, repo_id: str, sha: str | None) -> str | None:
    """The ignore mode that hides this update now, or None."""
    rule = (st.get("ignored") or {}).get(repo_id)
    if not isinstance(rule, dict):
        return None
    if rule.get("mode") == "model":
        return "model"
    if rule.get("mode") == "version" and sha and rule.get("sha") == sha:
        return "version"
    return None


def _downloader():
    try:
        from omlx.admin import routes as admin_routes
    except Exception as e:  # no engine (CI) or a moved module
        _log.debug("engine admin routes unavailable: %s", e)
        return None
    return getattr(admin_routes, "_hf_downloader", None)


def _local_repo_ids(model_dir: Path) -> list[str]:
    """``owner/name`` folders under the download dir (the engine filters
    out folders it did not download itself)."""
    out = []
    try:
        for owner in sorted(model_dir.iterdir()):
            if not owner.is_dir() or owner.name.startswith("."):
                continue
            for repo in sorted(owner.iterdir()):
                if repo.is_dir() and not repo.name.startswith("."):
                    out.append(f"{owner.name}/{repo.name}")
    except OSError as e:
        _log.warning("cannot list the model dir %s: %s", model_dir, e)
    return out


def _hub_sha(repo_id: str, token: str) -> str | None:
    try:
        from omlx.admin.hf_downloader import _HF_API_TIMEOUT, _get_hf_api
        api, _ = _get_hf_api()
        info = api.model_info(repo_id, token=token or None, timeout=_HF_API_TIMEOUT)
        return getattr(info, "sha", None)
    except Exception as e:
        _log.debug("Hub sha lookup failed for %s: %s", repo_id, e)
        return None


def _stale(st: dict, dl) -> bool:
    at = st.get("checked_at")
    if not at or time.time() - at > INTERVAL_S:
        return True
    # an update finished after the check: the listed row is out of date
    tasks = getattr(dl, "_tasks", None) or {}
    pending = st.get("updates") or {}
    for t in list(tasks.values()):
        if getattr(t, "repo_id", None) in pending and \
                (getattr(t, "completed_at", 0) or 0) > at:
            return True
    return False


async def run_check(token: str = "") -> dict:
    dl = _downloader()
    if dl is None:
        with _LOCK:
            st = load()
            st["error"] = "downloader not ready"
            return st
    with _LOCK:
        ignored = dict(load().get("ignored") or {})
    ids = [r for r in _local_repo_ids(Path(dl.model_dir))
           if (ignored.get(r) or {}).get("mode") != "model"]
    error = None
    try:
        res = await dl.check_updates(ids, token)
    except Exception as e:
        _log.warning("model update check failed: %s", e)
        res, error = {"updates": {}, "checked": 0, "failed": []}, str(e)[:300]
    updates = {}
    for repo, row in (res.get("updates") or {}).items():
        sha = await asyncio.to_thread(_hub_sha, repo, token)
        updates[repo] = {"files": int(row.get("files") or 0),
                         "size": int(row.get("size") or 0), "sha": sha}
    with _LOCK:
        st = load()
        if error is None or not st.get("checked_at"):
            st.update({"checked_at": time.time(), "checked": int(res.get("checked") or 0),
                       "updates": updates, "failed": list(res.get("failed") or [])})
        st["error"] = error
        _save(st)
        return st


def running() -> bool:
    return _task is not None and not _task.done()


def ensure_check(force: bool = False, token: str = "") -> asyncio.Task | None:
    """Start a background check when due (or forced); reuse a running one."""
    global _task
    if running():
        return _task
    dl = _downloader()
    if dl is None:
        return None
    with _LOCK:
        st = load()
    if not force and not _stale(st, dl):
        return None
    _task = asyncio.get_running_loop().create_task(run_check(token))
    return _task


def set_ignore(repo_id: str, mode: str | None) -> dict:
    with _LOCK:
        st = load()
        ign = st.setdefault("ignored", {})
        if mode in (None, "", "none"):
            ign.pop(repo_id, None)
        elif mode == "version":
            sha = ((st.get("updates") or {}).get(repo_id) or {}).get("sha")
            if not sha:
                raise ValueError("no current update to ignore for this model")
            ign[repo_id] = {"mode": "version", "sha": sha, "at": time.time()}
        elif mode == "model":
            ign[repo_id] = {"mode": "model", "at": time.time()}
        else:
            raise ValueError("mode must be version, model or none")
        _save(st)
        return st


def view(st: dict) -> dict:
    dl = _downloader()
    rows = []
    for repo, u in sorted((st.get("updates") or {}).items()):
        busy = False
        try:
            busy = bool(dl and dl.has_unfinished_download(repo))
        except Exception:
            _log.debug("unfinished-download probe failed for %s", repo, exc_info=True)
        rows.append({"repo_id": repo, "files": u.get("files", 0), "size": u.get("size", 0),
                     "sha": u.get("sha"), "ignored": is_ignored(st, repo, u.get("sha")),
                     "downloading": busy})
    ignored_models = sorted(r for r, v in (st.get("ignored") or {}).items()
                            if isinstance(v, dict) and v.get("mode") == "model")
    return {"checked_at": st.get("checked_at"), "checked": st.get("checked", 0),
            "running": running(), "error": st.get("error"),
            "failed": st.get("failed") or [], "updates": rows,
            "pending": sum(1 for r in rows if not r["ignored"]),
            "ignored_models": ignored_models, "interval_s": INTERVAL_S,
            "available": dl is not None}
