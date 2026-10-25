"""Identity + i18n (SPLIT-1): /identity, /locale and the locale
catalog loading (classic catalog merged with the uplift overlay).
load_locale is imported by viewer.py — keep it reachable.

ABOUT-1 added the admin-only /about environment card to this module: like
/identity, its whole point is to answer from the SERVING process."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .base import (api_router, page_router, require_admin, _RedirectToLogin,
                   engine_pool, settings_manager, global_settings,
                   _require_settings_manager, STATIC_DIR, _no_api_cache,
                   gzip_or_json)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector


# --------------------------------------------------------------------------
# i18n: merged locale catalog for the uplift UI
#   layer 1: classic's omlx/admin/i18n/<lang>.json (READ-ONLY via import;
#            same English-fallback semantics as classic's _load_locale)
#   layer 2: our own locales/<lang>.json additive keys (uplift-only
#            strings). Classic wins on collision is WRONG for uplift-owned
#            words, so overlay wins — uplift keys use the `uplift.*`
#            namespace by convention, collisions are a bug either way.
# --------------------------------------------------------------------------

_PACKAGE_LOCALES = Path(__file__).resolve().parent.parent / "locales"


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


def _classic_i18n():
    """Classic's own locale loader + dir, across layouts.

    #4359 (upstream 0b07e88) moved the web UI from omlx.admin.routes to the
    new omlx_web.routes package; the loader name and fallback chain are
    identical. Try the old import first (every keg before the split), then
    the new one; None when neither exists (viewer mode)."""
    for mod in ("omlx.admin.routes", "omlx_web.routes"):
        try:
            m = __import__(mod, fromlist=["_load_locale"])
            return m._load_locale, m._i18n_dir
        except (ImportError, AttributeError):
            continue
    return None, None


def load_locale(lang: str) -> dict:
    """Merged catalog for LANG. Classic JSON read through classic's own
    loader when available (its fallback chain is the reference), then our
    overlay on top; without omlx (viewer mode) our files alone."""
    lang = _safe_lang(lang)
    base: dict = {}
    _loader, _ = _classic_i18n()  # read-only reuse
    if _loader is not None:
        try:
            base = _loader(lang)
        except Exception:
            _loader = None
    if _loader is None:
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
    # the classic-import existence proof moved into _classic_i18n() itself
    # (#4359: two layouts can satisfy it now, so a bare name check is stale)
    return {**base, **merged_overlay}


# PERF-1 (user 2026-10-21): process-local catalog cache. The merged catalog
# is ~250 KB parsed per request per board tab and its contents cannot
# change under a running process (files ship with the package; config edits
# to ui.language only change WHICH cached dict answers, never their bytes).
# A 5-minute TTL keeps the answer honest even for someone hot-editing the
# overlay files; the gzip answer makes the re-pull cheap on the wire.
_CATALOG_TTL_S = 300.0
_catalog_cache: dict[str, tuple[float, dict]] = {}


def _load_locale_cached(lang: str) -> dict:
    now = time.monotonic()
    ent = _catalog_cache.get(lang)
    if ent and ent[0] > now:
        return ent[1]
    d = load_locale(lang)
    if len(_catalog_cache) > 32:      # bounded: langs are finite
        _catalog_cache.clear()
    _catalog_cache[lang] = (now + _CATALOG_TTL_S, d)
    return d


@api_router.get("/identity")
async def serving_identity():
    """Which keg is serving this dashboard (U10). The answer MUST come from
    the serving process itself — dev.json exists on disk even when the
    vanilla keg is the one answering. The uplift .pth runs inside whichever
    omlx server mounted us, so its own sys.prefix/sys.executable name the
    keg: '/omlx-dev/' appears exactly when the omlx-dev formula's keg is
    serving. Public: the header paints before login.

    ENV-4: the ladder moved into paths.is_dev_prefix so that this badge and
    the env-override dev gate answer from ONE definition — a UI that offered
    editing on a server that would 403 the write is the failure mode avoided.
    Public route: no keg path in the response (it carries the username);
    the header only needs the dev flag. Admin surface shows the keg."""
    import sys

    from .. import __version__ as _v
    from .. import paths as _paths

    return {"dev": bool(_paths.is_dev_prefix(sys.prefix, sys.executable)),
            "version": _v}


@api_router.get("/locale")
async def locale_catalog(request: Request, lang: Optional[str] = None):
    """Merged i18n catalog for the uplift UI (classic keys + uplift
    overlay). No lang given -> the server's configured ui.language, same
    source classic templates use. Public: mirrors classic, whose login
    page renders locale strings before authentication.

    PERF-1: the merged catalog is ~250 KB uncompressed per fetch and every
    board tab pulls it at boot — gzipped when accepted (one-time, it is
    cacheable by the browser under no-cache + ETag-less validators: keep
    no-store here, the gzip path just makes the re-pull cheap)."""
    if not lang:
        try:
            lang = global_settings().ui.language
        except Exception:
            lang = "en"
    lang = _safe_lang(lang)
    # UP-5 (minor): an unshipped locale (e.g. ?lang=de) serves English
    # strings via fallback, but the echo used to say 'de' — the UI then set
    # document.documentElement.lang='de' over English content (screen-reader
    # voice mismatch). Echo what is actually rendered: a catalog counts as
    # shipped when EITHER layer (classic base or uplift overlay) has it.
    shipped = (_PACKAGE_LOCALES / f"{lang}.json").exists()
    if not shipped:
        _, _dir = _classic_i18n()
        if _dir is not None:
            shipped = (_dir / f"{lang}.json").exists()
    if not shipped:
        lang = "en"
    strings = await asyncio.to_thread(_load_locale_cached, lang)
    # gzip when accepted (same doctrine as the metrics payloads)
    return await asyncio.to_thread(
        gzip_or_json, {"lang": lang, "strings": strings}, request)


# --------------------------------------------------------------------------
# ABOUT-1: /about — the admin-only environment card.
#   Same rule as /identity and BUILD-1: every answer comes from THIS serving
#   process (the uplift .pth runs inside whichever omlx keg mounted us), never
#   from a file on disk or from whatever board the browser last talked to.
#   ADMIN-GATED on purpose: `keg` and `model_dir` are absolute paths and the
#   keg spells out the username — /identity stays public and carries only the
#   dev flag, the admin surface is allowed to name the prefix.
#   HARDWARE PROBES: sysctl/system_profiler are subprocesses; they must never
#   touch the event loop and must never re-run per request. They execute in a
#   worker thread under a hard timeout, successful answers are cached for the
#   process lifetime, and a failure/timeout answers null (a null chip line is
#   an honest hole in the card; a 500 or a frozen loop is not).
#   No secrets here: nothing from settings.json, no api_key, no serials.
# --------------------------------------------------------------------------

_HW_CACHE: dict = {}                     # {"chip": str, "ram_bytes": int}
_HW_CACHE_LOCK = threading.Lock()        # guards _HW_CACHE reads/writes
_HW_PROBE_LOCK = threading.Lock()        # one probe at a time; waiters reuse it
_HW_PROBE_TIMEOUT_S = 6.0                # hard ceiling for the whole probe leg


def _probe_binary(name: str) -> str:
    """Absolute path of a macOS probe binary ('' when absent).

    Launchd services do not guarantee /usr/sbin on PATH, and the Linux CI
    runner has neither binary — the caller must treat '' as 'no answer'."""
    import shutil

    found = shutil.which(name)
    if found:
        return found
    for cand in (f"/usr/sbin/{name}", f"/bin/{name}"):
        if Path(cand).exists():
            return cand
    return ""


def _probe_text(argv: list, timeout: float = 5.0) -> str:
    """stdout of a probe command, trimmed; '' on ANY failure (missing
    binary, non-zero exit, timeout, no output). Never raises."""
    import subprocess

    if not argv[0]:
        return ""
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return ""
    if out.returncode != 0:
        return ""
    return (out.stdout or "").strip()


def _chip_sync() -> Optional[str]:
    """Apple chip name, e.g. 'Apple M1 Max'.

    Ladder runs cheap-first: `sysctl machdep.cpu.brand_string` answers in
    milliseconds and IS the marketing chip name on Apple Silicon; the
    documented `system_profiler SPHardwareDataType -json` source (chip_type)
    is the fallback and costs ~0.1-2 s. NOTE: the JSON row's `_name` is the
    section id ('hardware_overview'), not the chip — a real trap."""
    sysctl = _probe_binary("sysctl")
    brand = _probe_text([sysctl, "-n", "machdep.cpu.brand_string"]) if sysctl else ""
    if brand:
        return brand
    sp = _probe_binary("system_profiler")
    if not sp:
        return None
    raw = _probe_text([sp, "-json", "SPHardwareDataType"], timeout=8.0)
    if not raw:
        return None
    try:
        rows = json.loads(raw).get("SPHardwareDataType") or []
    except Exception:
        return None
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("chip_type", "chip"):
            value = str(row.get(key) or "").strip()
            if value:
                return value
    return None


def _ram_bytes_sync() -> Optional[int]:
    """Physical memory in bytes from `sysctl -n hw.memsize`; None when the
    probe is unavailable or answers junk (never a guessed number)."""
    sysctl = _probe_binary("sysctl")
    raw = _probe_text([sysctl, "-n", "hw.memsize"]) if sysctl else ""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


# Call through the module globals (indirection on purpose): a test can
# monkeypatch _chip_sync/_ram_bytes_sync and the route sees the stub.
_HW_PROBES = {
    "chip": lambda: _chip_sync(),
    "ram_bytes": lambda: _ram_bytes_sync(),
}


def _probe_hardware(keys: list) -> None:
    """Fill _HW_CACHE for the missing keys. Runs in a WORKER THREAD only.

    Serialized on _HW_PROBE_LOCK and re-checked after acquiring it, so N
    concurrent first requests still mean ONE system_profiler."""
    with _HW_PROBE_LOCK:
        for key in keys:
            with _HW_CACHE_LOCK:
                if key in _HW_CACHE:
                    continue
            try:
                value = _HW_PROBES[key]()
            except Exception:
                value = None
            if value is None:
                continue        # uncached: a failed probe may be retried later
            with _HW_CACHE_LOCK:
                _HW_CACHE[key] = value


async def _hardware_facts() -> tuple:
    """(chip, ram_bytes) — probed off the event loop, cached for the process.

    Timeout/crash answers (None, None) rather than failing the request; the
    uncached keys simply get another chance on the next call."""
    with _HW_CACHE_LOCK:
        missing = [k for k in _HW_PROBES if k not in _HW_CACHE]
    if missing:
        try:
            await asyncio.wait_for(asyncio.to_thread(_probe_hardware, missing),
                                   timeout=_HW_PROBE_TIMEOUT_S)
        except Exception:
            pass
    with _HW_CACHE_LOCK:
        return _HW_CACHE.get("chip"), _HW_CACHE.get("ram_bytes")


def _model_dir_sync() -> Optional[str]:
    """Where the RUNNING server keeps its models.

    Prefer classic's own resolver (`GlobalSettings.model.get_model_dirs`,
    which honours a configured `model_dirs` list), then base_path/models, then
    the paths.py family-A ladder ($OMLX_BASE_PATH -> ~/.omlx) so a viewer run
    without omlx still answers honestly instead of null."""
    gs = None
    try:
        gs = global_settings()          # imports omlx.server INSIDE the helper
    except Exception:
        gs = None
    base = getattr(gs, "base_path", None) if gs is not None else None
    if gs is not None:
        try:
            dirs = gs.model.get_model_dirs(base)
            if dirs:
                return str(dirs[0])
        except Exception:
            pass
    if base:
        return str(Path(base) / "models")
    try:
        from .. import paths as _paths

        return str(_paths.server_base_dir() / "models")
    except Exception:
        return None


@api_router.get("/about")
async def about(is_admin: bool = Depends(require_admin)):
    """Environment facts of the process serving this dashboard (ABOUT-1).

    Contract consumed by the About panel — key set and types are frozen:
      omlx_version   str|None  the omlx package THIS process imports (BUILD-1:
                               importlib.metadata, never a file on disk)
      uplift_version str       our own package version
      dev            bool      serving prefix is the omlx-dev keg
      keg            str|None  sys.prefix — carries the username => admin-only
      python_version str       e.g. '3.11.17'
      macos_version  str       e.g. '26.1' ('' off macOS, i.e. in CI)
      arch           str       e.g. 'arm64'
      chip           str|None  e.g. 'Apple M1 Max' (probed once, off-loop)
      ram_bytes      int|None  physical memory
      model_dir      str|None  e.g. '~/.omlx/models' resolved absolute
    """
    import platform
    import sys

    from .. import __version__ as _v
    from .. import paths as _paths

    # REUSE the BUILD-1 probe; imported inside the handler so this module (and
    # CI without omlx) never pays for it at import time.
    try:
        from .dev import _omlx_running_version

        omlx_version = _omlx_running_version()
    except Exception:
        omlx_version = None

    chip, ram_bytes = await _hardware_facts()
    return {
        "omlx_version": omlx_version,
        "uplift_version": _v,
        "dev": bool(_paths.is_dev_prefix(sys.prefix, sys.executable)),
        "keg": sys.prefix,
        "python_version": platform.python_version(),
        "macos_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "chip": chip,
        "ram_bytes": ram_bytes,
        "model_dir": _model_dir_sync(),
    }
