"""VOICE-15: audio-engine activity on the dashboard.

Problem: the status feed's "model is doing something" signal comes only from
the batched LLM/VLM schedulers (``_build_active_models_data`` reads scheduler
snapshots + ``get_activity_snapshot``). STT/TTS/STS engines have no
scheduler, take no pool lease (audio routes call ``get_engine`` WITHOUT
``_lease``), and vanilla's classic web page shows "realtime transcription"
only from a CLIENT-side label — so while the server transcribed or
synthesized, the dashboard card showed the model Idle.

Fix shape (same doctrine as instrument.py — in-memory wraps, vanilla files
stay byte-identical, every failure degrades to "no observability", never to
a serving error):

* Wrap the engines' work methods at class level:
  STTEngine.transcribe / .transcribe_stream (async generator),
  TTSEngine.synthesize, STSEngine.process. The wrap lives for the WHOLE
  call — file upload handling and model compute included — which is exactly
  what "the model is doing something" means to a watcher. Covers EVERY
  caller: vanilla /v1/audio/*, the classic web page, uplift's /voices seams
  (they run in-process through these same methods).
* Realtime sessions are NOT counted through transcribe (one session spans
  many small decodes; a flickering per-chunk row would lie about the thing
  that is actually happening). Vanilla already keeps the honest flag —
  STTEngine._realtime_active, set by create_realtime_session and cleared by
  session.release() — so the merge step just READS it (peek, no wrap).
* Attribution by engine OBJECT IDENTITY: the wrap stashes a weakref to the
  engine; the merge walks the pool once per tick (a handful of entries) and
  resolves id(engine) -> pool model id, so a busy row lands on the very row
  the status card renders. No name matching, no multipart body sniffing,
  no path tables, no response wrapping.
* merge_stats() runs on BOTH stats tiers (the fast 2 Hz rebuild reuses the
  slow composite cache — audio must not wait up to 15 s for the slow walk).
  It never mutates the cached payload: rows that gain audio data are
  replaced with fresh dicts, the models list and the active_models dict are
  rebuilt shallow.
"""

from __future__ import annotations

import functools
import logging
import threading
import time
import weakref
from typing import Any, Dict, Iterable, Optional, Tuple

log = logging.getLogger("omlx_uplift.audio_activity")

# kind -> (pool engine classes are irrelevant; label lives on the row)
KINDS = ("stt", "tts", "sts", "realtime")


class _Busy:
    """One live call: engine identity + kind + birth time."""

    __slots__ = ("kind", "engine_ref", "fallback_name", "started")

    def __init__(self, kind: str, engine: Any, fallback_name: str):
        self.kind = kind
        try:
            self.engine_ref = weakref.ref(engine)
        except TypeError:                    # uncollectable engine object
            self.engine_ref = None
        self.fallback_name = fallback_name
        self.started = time.monotonic()


class AudioRegistry:
    """Thread-safe set of live audio calls (the engine methods run on the
    event loop but the merge reads from a worker thread)."""

    STALE_S = 1800.0    # a call older than 30 min is a leaked entry, not
                        # a transcription — drop it rather than pin the row

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._busy: list[_Busy] = []

    def begin(self, kind: str, engine: Any) -> Optional[_Busy]:
        entry = _Busy(kind, engine, _engine_name(engine))
        with self._lock:
            self._busy.append(entry)
        return entry

    def end(self, entry: Optional[_Busy]) -> None:
        if entry is None:
            return
        with self._lock:
            try:
                self._busy.remove(entry)
            except ValueError:
                pass

    def snapshot(self) -> list[dict]:
        """One row per (kind, engine identity): count + elapsed of the
        OLDEST live call (that is what 'doing something for' means)."""
        now = time.monotonic()
        grouped: Dict[Tuple[str, int], dict] = {}
        with self._lock:
            live = [b for b in self._busy if now - b.started <= self.STALE_S]
            self._busy[:] = live
            for b in live:
                engine = b.engine_ref() if b.engine_ref is not None else None
                key = (b.kind, id(engine) if engine is not None
                       else hash(b.fallback_name))
                g = grouped.get(key)
                if g is None:
                    grouped[key] = g = {"kind": b.kind, "count": 0,
                                        "elapsed": now - b.started,
                                        "_engine": engine,
                                        "_name": b.fallback_name}
                g["count"] += 1
        return list(grouped.values())

    def count(self) -> int:
        with self._lock:
            return len(self._busy)


_registry = AudioRegistry()


def get_registry() -> AudioRegistry:
    return _registry


def _engine_name(engine: Any) -> str:
    for attr in ("model_name", "_model_name"):
        v = getattr(engine, attr, None)
        if isinstance(v, str) and v:
            return v
    return "?"


# --------------------------------------------------------------------------
# the wraps
# --------------------------------------------------------------------------

def _wrap_async(orig, kind: str):
    @functools.wraps(orig)
    async def wrapper(self, *args, **kwargs):
        token = _safe_begin(kind, self)
        try:
            return await orig(self, *args, **kwargs)
        finally:
            _safe_end(token)
    wrapper._uplift_hook = True
    return wrapper


def _wrap_asyncgen(orig, kind: str):
    @functools.wraps(orig)
    async def wrapper(self, *args, **kwargs):
        token = _safe_begin(kind, self)
        try:
            async for chunk in orig(self, *args, **kwargs):
                yield chunk
        finally:
            # covers normal end, client abort (GeneratorExit) and errors —
            # an aborted stream must not leave a phantom busy row.
            _safe_end(token)
    wrapper._uplift_hook = True
    return wrapper


def _safe_begin(kind: str, engine: Any) -> Optional[_Busy]:
    try:
        return _registry.begin(kind, engine)
    except Exception:
        log.debug("audio begin failed", exc_info=True)
        return None


def _safe_end(token: Optional[_Busy]) -> None:
    try:
        _registry.end(token)
    except Exception:
        log.debug("audio end failed", exc_info=True)


def _wrap_method(cls, name: str, kind: str, asyncgen: bool = False) -> bool:
    orig = getattr(cls, name, None)
    if orig is None or getattr(orig, "_uplift_hook", False):
        return False
    setattr(cls, name,
            _wrap_asyncgen(orig, kind) if asyncgen else _wrap_async(orig, kind))
    return True


_installed = False


def install() -> None:
    """Wrap the audio engines' work methods (idempotent; each import is
    independently optional so an omlx layout that lacks one engine class
    just lacks that label — same drift tolerance as instrument.py)."""
    global _installed
    if _installed:
        return
    _installed = True

    try:
        from omlx.engine.stt import STTEngine
        _wrap_method(STTEngine, "transcribe", "stt")
        _wrap_method(STTEngine, "transcribe_stream", "stt", asyncgen=True)
    except Exception:
        log.debug("stt engine wrap skipped", exc_info=True)

    try:
        from omlx.engine.tts import TTSEngine
        _wrap_method(TTSEngine, "synthesize", "tts")
    except Exception:
        log.debug("tts engine wrap skipped", exc_info=True)

    try:
        from omlx.engine.sts import STSEngine
        _wrap_method(STSEngine, "process", "sts")
    except Exception:
        log.debug("sts engine wrap skipped", exc_info=True)


def reset_for_tests() -> None:
    """Re-arm install() after tests replaced sys.modules entries."""
    global _installed
    _installed = False


# --------------------------------------------------------------------------
# realtime peek + payload merge (the stats_feed seam)
# --------------------------------------------------------------------------

def _pool():
    try:
        from omlx.admin import routes as admin_routes
        getter = getattr(admin_routes, "_get_engine_pool", None)
        return getter() if callable(getter) else None
    except Exception:
        return None


def _engine_key_map(pool) -> Dict[int, str]:
    """id(engine) -> pool model id, for the handful of loaded entries."""
    out: Dict[int, str] = {}
    try:
        for key, entry in getattr(pool, "_entries", {}).items():
            eng = getattr(entry, "engine", None)
            if eng is not None:
                out[id(eng)] = key
    except RuntimeError:      # dict resized mid-request
        pass
    return out


def _realtime_rows(pool) -> list[dict]:
    """Loaded STT engines whose vanilla _realtime_active flag is set —
    the honest 'a realtime session is open right now' source."""
    rows = []
    try:
        items = list(getattr(pool, "_entries", {}).items())
    except Exception:
        return rows
    for key, entry in items:
        eng = getattr(entry, "engine", None)
        if eng is not None and getattr(eng, "_realtime_active", False) is True:
            rows.append({"kind": "realtime", "count": 1, "elapsed": None,
                         "_engine": eng, "_name": _engine_name(eng),
                         "_id": key})
    return rows


def _row_ids(models: Iterable[dict]) -> list[str]:
    return [str(m.get("id") or "") for m in models]


def merge_stats(payload: Optional[dict]) -> Optional[dict]:
    """Attach per-row 'audio' activity to an active_models payload.

    Safe on both stats tiers; never mutates the input objects (the feed
    caches the slow composite and reuses it between ticks). Any failure
    returns the payload exactly as it came."""
    try:
        return _merge_stats(payload)
    except Exception:
        log.debug("audio merge failed", exc_info=True)
        return payload


def _merge_stats(payload: Optional[dict]) -> Optional[dict]:
    if not isinstance(payload, dict):
        return payload
    am = payload.get("active_models")
    if not isinstance(am, dict) or not isinstance(am.get("models"), list):
        return payload
    models = am["models"]

    pool = _pool()
    keymap = _engine_key_map(pool) if pool is not None else {}
    rows = _row_ids(models)

    activities = []
    for b in _registry.snapshot():
        b["model_id"] = keymap.get(id(b["_engine"])) if b["_engine"] is not None else None
        activities.append(b)
    activities.extend(_realtime_rows(pool) if pool is not None else [])
    if not activities:
        return payload

    # Attribution: engine identity first, then the single-loaded-model
    # fallback (a busy audio call with no resolvable row belongs to the
    # only audio model the board has — the common case; inventing rows
    # for genuinely unknown models would be noisier than honest silence).
    by_id: Dict[str, list] = {}
    leftover = []
    for a in activities:
        mid = a.get("model_id") or a.get("_id")
        if mid and mid in rows:
            by_id.setdefault(mid, []).append(a)
        elif len(rows) == 1:
            by_id.setdefault(rows[0], []).append(a)
        else:
            leftover.append(a)
    if leftover:
        log.debug("audio activity unattributed: %s",
                  [(a["kind"], a.get("_name")) for a in leftover])

    if not by_id:
        return payload

    attached = 0
    new_models = []
    for m in models:
        acts = by_id.get(str(m.get("id") or ""))
        if not acts:
            new_models.append(m)
            continue
        audio = [{"kind": a["kind"], "count": a["count"],
                  "elapsed": (round(a["elapsed"], 1) if a.get("elapsed") is not None
                              else None)}
                 for a in sorted(
                     acts,
                     key=lambda x: KINDS.index(x["kind"])
                     if x["kind"] in KINDS else len(KINDS))]
        n = sum(a["count"] for a in acts)
        attached += n
        m2 = dict(m)
        m2["audio"] = audio
        m2["active_requests"] = int(m.get("active_requests") or 0) + n
        new_models.append(m2)

    am2 = dict(am)
    am2["models"] = new_models
    am2["total_active_requests"] = int(am.get("total_active_requests") or 0) + attached
    p2 = dict(payload)
    p2["active_models"] = am2
    return p2
