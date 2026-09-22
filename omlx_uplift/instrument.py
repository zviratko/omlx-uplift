"""Event-driven request capture (RL3-GAP1) — zero vanilla edits.

The tick-based tracker sample can never see requests that are born and
finish between two polls (sub-tick requests vanished from ring AND db:
finding RL3-GAP1). The engine core itself knows the exact birth and
departure moments, so we wrap two of its methods:

  AsyncEngineCore.add_request     -> tracker.note_birth(...)
  AsyncEngineCore._cleanup_request -> tracker.note_finalize(...)

Wrapping happens on the CLASS at mount time (register()), so every engine
instance — existing or created later — is covered. Vanilla stays
byte-identical on disk: we only replace class attributes in memory after
import, the same technique the mount itself uses for the lifespan. Both
wrappers are total: any failure degrades to the tick path, never to a
server error.

Departure harvest reads the output collector BEFORE vanilla pops it — the
collector carries the exact final text/token counts even when a streaming
consumer already drained the scheduler-side state.
"""

from __future__ import annotations

import functools
import json
import weakref

_installed = False
_model_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _scheduler_for(core):
    """Scheduler reachable from either the async or the sync core."""
    try:
        eng = getattr(core, "engine", None)          # async -> sync core
        sched = getattr(core, "scheduler", None) or \
            getattr(eng, "scheduler", None)
        return sched
    except Exception:  # noqa: BLE001
        return None


def _model_for_core(core) -> str:
    """Resolve the model id a core (async OR sync) belongs to — reverse
    pool scan, cached per core instance. '' when unresolvable: honest
    blank, never a guess."""
    try:
        return _model_cache[core]
    except KeyError:
        pass
    model = ""
    try:
        from .router import engine_pool

        pool = engine_pool()
        if pool is not None:
            for mid in pool.get_loaded_model_ids():
                try:
                    eng = getattr(pool.get_entry(mid), "engine", None)
                    a = getattr(eng, "_engine", None)      # async core
                    if a is core or getattr(a, "engine", None) is core:
                        model = mid
                        break
                except Exception:  # noqa: BLE001
                    continue
    except Exception:  # noqa: BLE001
        pass
    if model:                      # don't cache misses (model loads later)
        _model_cache[core] = model
    return model


def _request_obj(core, rid):
    sched = _scheduler_for(core)
    try:
        return sched.requests.get(rid) if sched else None
    except Exception:  # noqa: BLE001
        return None


def _harvest(core, rid) -> dict:
    """Final snapshot at departure. Two sources, best first:
    1. the scheduler Request (output_text/finish land exactly at
       finalize; removal is deferred, so it usually still sits there);
    2. the output collector BEFORE vanilla pops it — only useful when
       nobody streamed (get_nowait zeroes .output for consumers)."""
    snap = {"has_output": False, "output_text": "", "completion_tokens": 0,
            "finish_reason": "", "params": ""}
    req = _request_obj(core, rid)
    if req is not None:
        try:
            text = getattr(req, "output_text", "") or ""
            n_out = int(getattr(req, "num_output_tokens", 0) or 0)
            if text or n_out:
                snap.update(has_output=True, output_text=text,
                            completion_tokens=n_out)
                fr = None
                try:
                    fr = req.get_finish_reason()
                except Exception:  # noqa: BLE001
                    pass
                snap["finish_reason"] = str(fr or "")
        except Exception:  # noqa: BLE001
            pass
    if not snap["has_output"]:
        try:
            collector = (getattr(core, "_output_collectors", None) or {}).get(rid)
            out = getattr(collector, "output", None) if collector else None
            if out is not None:
                snap["has_output"] = True
                snap["output_text"] = getattr(out, "output_text", "") or ""
                snap["completion_tokens"] = int(
                    getattr(out, "completion_tokens", 0) or 0)
                snap["finish_reason"] = str(
                    getattr(out, "finish_reason", "") or "")
                # memory-guard refusals: machine-readable code rides on the
                # output (finish_reason alone is just 'error')
                ec = getattr(out, "error_code", None)
                if ec:
                    snap["error_code"] = str(ec)
        except Exception:  # noqa: BLE001
            pass
    try:
        sp = getattr(req, "sampling_params", None) if req is not None else None
        if sp is not None:
            from .request_log import PARAM_FIELDS
            params = {f: getattr(sp, f) for f in PARAM_FIELDS
                      if hasattr(sp, f)}
            if params:
                snap["params"] = json.dumps(params, default=str)
    except Exception:  # noqa: BLE001
        pass
    return snap


def install() -> None:
    """Wrap birth (AsyncEngineCore.add_request — every HTTP request's
    path) and departure (EngineCore._cleanup_request — where vanilla pops
    the collector, sync core). Idempotent, best-effort."""
    global _installed
    if _installed:
        return
    try:
        from omlx.engine_core import AsyncEngineCore, EngineCore
    except Exception:  # noqa: BLE001 — omlx layout changed; tick path alone
        return
    _installed = True

    orig_add = AsyncEngineCore.add_request
    if not getattr(orig_add, "_uplift_hook", False):
        @functools.wraps(orig_add)
        async def add_request(self, *args, **kwargs):
            rid = await orig_add(self, *args, **kwargs)
            try:
                from .request_log import get_request_tracker
                get_request_tracker().note_birth(
                    rid, _model_for_core(self), _request_obj(self, rid))
            except Exception:  # noqa: BLE001
                pass
            return rid
        add_request._uplift_hook = True
        AsyncEngineCore.add_request = add_request

    # Non-streaming handlers can enter through the sync core directly;
    # note_birth is an idempotent merge, so double-fire (async -> sync)
    # is harmless and single-fire coverage is complete.
    orig_sync_add = EngineCore.add_request
    if not getattr(orig_sync_add, "_uplift_hook", False):
        @functools.wraps(orig_sync_add)
        async def sync_add_request(self, *args, **kwargs):
            rid = await orig_sync_add(self, *args, **kwargs)
            try:
                from .request_log import get_request_tracker
                get_request_tracker().note_birth(
                    rid, _model_for_core(self), _request_obj(self, rid))
            except Exception:  # noqa: BLE001
                pass
            return rid
        sync_add_request._uplift_hook = True
        EngineCore.add_request = sync_add_request

    orig_cleanup = EngineCore._cleanup_request
    if not getattr(orig_cleanup, "_uplift_hook", False):
        @functools.wraps(orig_cleanup)
        def _cleanup_request(self, request_id):
            snap = _harvest(self, request_id)
            orig_cleanup(self, request_id)
            try:
                from .request_log import get_request_tracker
                get_request_tracker().note_finalize(
                    request_id, _model_for_core(self), snap)
            except Exception:  # noqa: BLE001
                pass
        _cleanup_request._uplift_hook = True
        EngineCore._cleanup_request = _cleanup_request
