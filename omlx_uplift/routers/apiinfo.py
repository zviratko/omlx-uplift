"""Identity + i18n (SPLIT-1): /identity, /locale and the locale
catalog loading (classic catalog merged with the uplift overlay).
load_locale is imported by viewer.py — keep it reachable."""

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
                   _require_settings_manager, STATIC_DIR, _no_api_cache)
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
    return {"lang": lang, "strings": await asyncio.to_thread(load_locale, lang)}
