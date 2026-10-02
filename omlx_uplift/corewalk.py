"""BE-2: the one scheduler-walk helper.

The hop entry.engine -> (_engine async core) -> engine -> scheduler was
reimplemented FIVE times across collector.py and request_log.py (plus a
reverse-direction cousin in instrument.py); every new consumer just copied
the four getattr lines and the set grew. One helper now; the walk shape is
classic's admin stats route (AsyncEngineCore, else DFlash).

instrument.py is deliberately NOT migrated: _scheduler_for there maps a
CORE (async or sync) back through the pool — a different direction; its
comment says so. Keep it that way rather than inventing a second
'direction' parameter nobody calls.
"""

from __future__ import annotations

from typing import Any

import logging

log = logging.getLogger("omlx_uplift.corewalk")


def async_core_for(entry: Any) -> Any:
    """The AsyncEngineCore under an engine-pool entry (None if absent)."""
    try:
        eng = getattr(entry, "engine", None)
        return getattr(eng, "_engine", None) if eng is not None else None
    except Exception:  # noqa: BLE001 — probing foreign objects, never fatal
        return None


def sync_core_for(entry: Any) -> Any:
    """The sync core: async core's .engine, or the engine itself when the
    model runs DFlash (no async wrapper)."""
    a = async_core_for(entry)
    if a is not None:
        return getattr(a, "engine", None)
    try:
        return getattr(entry, "engine", None)
    except Exception:  # noqa: BLE001
        return None


def scheduler_for(entry: Any) -> Any:
    """The scheduler behind a pool entry — the exact walk the admin stats
    route uses. None when the entry or its engine is missing. DFlash
    entries (scheduler on the engine itself) resolve here too."""
    if entry is None or getattr(entry, "engine", None) is None:
        return None
    core = sync_core_for(entry)
    return getattr(core, "scheduler", None) if core is not None else None


def output_collectors_for(entry: Any) -> dict:
    """AsyncEngineCore's per-request output collectors (same walk). Holder
    objects expose `.output` — a cumulative RequestOutput whose
    output_text/finish_reason update as tokens decode."""
    try:
        a = async_core_for(entry)
        core = getattr(a, "engine", None) if a is not None else None
        return (getattr(core, "_output_collectors", {}) or {}) if core else {}
    except Exception:  # noqa: BLE001
        return {}
