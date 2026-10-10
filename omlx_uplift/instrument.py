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
import logging
import weakref

log = logging.getLogger("omlx_uplift.instrument")

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
        log.debug("engine match probe failed", exc_info=True)
    if model:                      # don't cache misses (model loads later)
        _model_cache[core] = model
    return model


def _request_obj(core, rid):
    sched = _scheduler_for(core)
    try:
        return sched.requests.get(rid) if sched else None
    except Exception:  # noqa: BLE001
        return None


def _decode_birth(core, rid) -> None:
    """BE-decode: start the request's decode row at zero (birth hook).

    Best-effort like every wrapper here: a failure only costs this row's
    birth marker — the tick walk still baselines it, and the departure
    flush still counts a sub-tick generation.
    """
    try:
        from .decode_sampler import get_decode_sampler
        get_decode_sampler().note_birth(f"{_model_for_core(core)}\x00{rid}")
    except Exception:  # noqa: BLE001
        log.debug("decode note_birth failed", exc_info=True)


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
                    log.debug("finish_reason probe failed", exc_info=True)
                snap["finish_reason"] = str(fr or "")
        except Exception:  # noqa: BLE001
            log.debug("finish_reason probe failed", exc_info=True)
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
            log.debug("error_code capture failed", exc_info=True)
    try:
        sp = getattr(req, "sampling_params", None) if req is not None else None
        if sp is not None:
            from .request_log import PARAM_FIELDS
            params = {f: getattr(sp, f) for f in PARAM_FIELDS
                      if hasattr(sp, f)}
            if params:
                snap["params"] = json.dumps(params, default=str)
    except Exception:  # noqa: BLE001
        log.debug("params json dump failed", exc_info=True)
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
                log.debug("note_birth (add_request) failed", exc_info=True)
            _decode_birth(self, rid)
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
                log.debug("note_birth failed", exc_info=True)
            _decode_birth(self, rid)
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
                log.debug("note_finalize failed", exc_info=True)
            try:
                # BE-decode: flush the tail a sub-tick generation never
                # showed the tick walk (born AND finished inside one 5 s
                # window). Same model-qualified key the collector builds;
                # note_end is idempotent against tokens a tick credited.
                from .decode_sampler import get_decode_sampler
                get_decode_sampler().note_end(
                    f"{_model_for_core(self)}\x00{request_id}",
                    snap.get("completion_tokens"))
            except Exception:  # noqa: BLE001
                log.debug("decode note_end failed", exc_info=True)
        _cleanup_request._uplift_hook = True
        EngineCore._cleanup_request = _cleanup_request


def install_prefill_tracker() -> None:
    """BE-prefill: wrap the prefill progress tracker's update/remove.

    The tracker is the exact source of computed-prefill work — update()
    fires per chunk with cumulative counts, remove() fires on completion
    AND on every abort path. Wrapping the CLASS covers every scheduler
    instance; any failure degrades to a flat 0 line, never to a serving
    error. *args-tolerant: an upstream signature change passes through to
    the real method untouched; our note only reads the first four
    positionals (rid, processed, total, model) + phase."""
    try:
        from omlx.prefill_progress import PrefillProgressTracker
    except Exception:  # noqa: BLE001 — omlx layout changed; key stays absent
        log.debug("prefill tracker import failed", exc_info=True)
        return
    orig_upd = PrefillProgressTracker.update
    if not getattr(orig_upd, "_uplift_hook", False):
        @functools.wraps(orig_upd)
        def update(self, request_id, processed, total, model_id="",
                   *args, **kwargs):
            orig_upd(self, request_id, processed, total, model_id,
                     *args, **kwargs)
            try:
                from .prefill_sampler import get_prefill_sampler
                # upstream signature: (rid, processed, total, model, phase,
                # ...) — phase is normally a kwarg (draft.py) but tolerate
                # it positionally too.
                phase = kwargs.get("phase") or \
                    (args[0] if args else "prefill")
                get_prefill_sampler().note_chunk(
                    request_id, processed, total, model_id, phase)
            except Exception:  # noqa: BLE001
                log.debug("prefill note_chunk failed", exc_info=True)
        update._uplift_hook = True
        PrefillProgressTracker.update = update

    orig_rm = PrefillProgressTracker.remove
    if not getattr(orig_rm, "_uplift_hook", False):
        @functools.wraps(orig_rm)
        def remove(self, request_id):
            orig_rm(self, request_id)
            try:
                from .prefill_sampler import get_prefill_sampler
                get_prefill_sampler().note_end(request_id)
            except Exception:  # noqa: BLE001
                log.debug("prefill note_end failed", exc_info=True)
        remove._uplift_hook = True
        PrefillProgressTracker.remove = remove


def install_embed_hooks() -> None:
    """Embedding work: wrap MLXEmbeddingModel._embed_batch / .embed.

    Embedding models never touch AsyncEngineCore or the prefill tracker,
    so the two LLM-side instrument paths cannot see them at all — the
    reported bug (Throughput shows nothing for embedding traffic).
    _embed_batch is the exact per-forward unit: its return carries the
    attention-mask token sum for THAT batch (pad-free compute credit).
    The eager non-custom path returns None there, so .embed is wrapped
    too: its EmbeddingOutput.total_tokens is the request's usage-level
    count, and the shortfall over what its batches already credited is
    added at request end (thread-local pairing — the whole batch loop
    runs on one executor thread; see embed_sampler). Both wraps are
    total: any failure degrades to the other path, never to a serving
    error. Independent of install()/install_prefill_tracker()."""
    try:
        from omlx.models.embedding import MLXEmbeddingModel
    except Exception:  # noqa: BLE001 — omlx layout changed; key stays absent
        log.debug("embedding model import failed", exc_info=True)
        return

    orig_batch = MLXEmbeddingModel._embed_batch
    if not getattr(orig_batch, "_uplift_hook", False):
        @functools.wraps(orig_batch)
        def _embed_batch(self, *args, **kwargs):
            out = orig_batch(self, *args, **kwargs)
            try:
                # (embeddings_array, batch_tokens) — count is None on the
                # eager non-custom path; note_batch pairs/credits per rule.
                from .embed_sampler import note_batch
                note_batch(out[1] if isinstance(out, tuple)
                           and len(out) > 1 else None)
            except Exception:  # noqa: BLE001
                log.debug("embed note_batch failed", exc_info=True)
            return out
        _embed_batch._uplift_hook = True
        MLXEmbeddingModel._embed_batch = _embed_batch

    orig_embed = MLXEmbeddingModel.embed
    if not getattr(orig_embed, "_uplift_hook", False):
        @functools.wraps(orig_embed)
        def embed(self, *args, **kwargs):
            try:
                from .embed_sampler import begin_request
                begin_request()
            except Exception:  # noqa: BLE001
                log.debug("embed begin_request failed", exc_info=True)
            # A RAISED embed() never reaches end_request: the batches it
            # already computed kept their exact credits (real work), the
            # unknown-count tail is honestly lost (bounded, documented).
            out = orig_embed(self, *args, **kwargs)
            try:
                from .embed_sampler import end_request
                end_request(getattr(out, "total_tokens", None))
            except Exception:  # noqa: BLE001
                log.debug("embed end_request failed", exc_info=True)
            return out
        embed._uplift_hook = True
        MLXEmbeddingModel.embed = embed


def install_mtp_hooks() -> None:
    """MTP acceptance: wrap the per-sequence finish logger.

    _log_mtp_stats(uid, stats, reason) fires on every way an MTP sequence
    ends (finish, abort, park hand-off) and carries the sequence's full
    _MtpStats. The tick walk in collectors.collect_mtp sees only what is
    attached to a live generation batch, so this is the exact tail flush:
    work born and finished inside one 5 s window still lands. Idempotent
    against the walk (note_finish credits only the delta since the row's
    last snapshot, and _log_mtp_stats fires repeatedly per state).

    Independent of install()/install_prefill_tracker(): any one wrap may
    bail on upstream layout drift without taking the others down. The
    import reaches the uplift-patched mlx_lm module omlx already imports
    itself (scheduler.py), so no new module is pulled into the server."""
    try:
        from omlx.patches.mlx_lm_mtp.batch_generator import _log_mtp_stats
    except Exception:  # noqa: BLE001 — omlx layout changed; walk path alone
        log.debug("mtp finish hook import failed", exc_info=True)
        return
    if getattr(_log_mtp_stats, "_uplift_hook", False):
        return

    @functools.wraps(_log_mtp_stats)
    def _logged(uid, stats, finish_reason, *args, **kwargs):
        result = _log_mtp_stats(uid, stats, finish_reason, *args, **kwargs)
        try:
            from .mtp_sampler import get_mtp_sampler
            get_mtp_sampler().note_finish(stats)
        except Exception:  # noqa: BLE001
            log.debug("mtp note_finish failed", exc_info=True)
        return result
    _logged._uplift_hook = True
    try:
        from omlx.patches.mlx_lm_mtp import batch_generator as _bg
        _bg._log_mtp_stats = _logged
    except Exception:  # noqa: BLE001
        log.debug("mtp finish hook install failed", exc_info=True)
