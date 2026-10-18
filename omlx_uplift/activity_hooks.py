"""VOICE-15 hooks: wake the stats feed when tracked engine work starts/ends.

Vanilla's BaseEngine already brackets every non-scheduler operation
(transcribing, realtime sessions, speech synthesis, audio processing,
embedding, reranking, deciding) with ``_begin_activity`` /
``_end_activity``. Those two are the single choke point for ALL of it, so
wrapping exactly them (class-level, in-memory, same drift-tolerant
doctrine as instrument.py) tells the dashboard "a row just changed under
the hood — rebuild now" instead of waiting for the next 2 Hz tick. That
difference is what makes a 0.8-second transcription visible at all: the
work otherwise fits entirely between two builds.

Both wraps are total: the original semantics (return value, RuntimeError
from a double-ended activity) pass through untouched; a notify failure can
never become a serving error.
"""

from __future__ import annotations

import functools
import logging

log = logging.getLogger("omlx_uplift.activity_hooks")

_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    try:
        from omlx.engine.base import BaseEngine
    except Exception:  # noqa: BLE001 — omlx layout changed; rows just age 2 Hz
        log.debug("BaseEngine import failed; activity hooks not installed",
                  exc_info=True)
        return
    from . import stats_feed

    for name in ("_begin_activity", "_end_activity"):
        orig = getattr(BaseEngine, name, None)
        if orig is None or getattr(orig, "_uplift_hook", False):
            continue

        def make(f):
            @functools.wraps(f)
            def wrapper(self, *args, **kwargs):
                out = f(self, *args, **kwargs)   # raises -> no notify, no change
                try:
                    stats_feed.notify_activity()
                except Exception:  # noqa: BLE001
                    log.debug("activity notify failed", exc_info=True)
                return out
            wrapper._uplift_hook = True
            return wrapper

        setattr(BaseEngine, name, make(orig))
    _installed = True


def reset_for_tests() -> None:
    global _installed
    _installed = False
