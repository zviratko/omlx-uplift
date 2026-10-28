"""Uplift-native prefill / parallel probe (user item 4: 'longer or custom
prefill length, custom parallelism with longer prefills (with an option to
stagger their starts etc.) — shouldn't interfere with vanilla').

WHY A SEPARATE LANE — the three vanilla bounds this feature cannot ride
through (facts read from the installed dev keg, omlx/admin/benchmark.py;
NOTHING here edits or patches it):

1. `VALID_PROMPT_LENGTHS = [1024, 4096, ..., 200000]` and
   `VALID_BATCH_SIZES = [2, 4, 8]` are pydantic FIELD VALIDATORS on
   `BenchmarkRequest` (benchmark.py:41-44 + :127-143). bench_engine.start()
   builds that model, so any custom length or parallel count 400s before a
   request is ever made. Uplift-side, the same lifting is the U50 precedent
   the context probe already follows: bypass only the request-model
   validator, keep every runner guard, and add our own sanity bound.
2. The classic batch test pins its prompt size to 1024 — `prompts[1024]`
   at benchmark.py:2128-2133 and `prompt_tokens=1024` at :2167. A longer
   prefill under parallel load is simply not expressible.
3. It submits all N requests at once with `asyncio.gather`
   (benchmark.py:1149) and takes no start-offset parameter, so 'stagger
   their starts' has no seam to go through.

WHAT IS REUSED INSTEAD OF RE-IMPLEMENTED (import direction is always
uplift -> omlx, never the reverse; classic's file stays byte-identical):

- `B._generate_prompt(tokenizer, n, profile)` — the exact prompt builder
  classic's own context_benchmark.py imports (line 36 of that file). Its
  unique UUID prefix per call is what makes N parallel prompts miss each
  other's prefix cache, so we call it N TIMES, exactly like classic builds
  `max_batch` distinct prompts for its batch wave.
- `B._get_batch_benchmark_core(engine)` → `add_request` + `stream_outputs`
  — the same live-engine seam classic's `_run_batch_test` uses.
- `B._compute_single_metrics(...)` — classic's metric math for the
  per-request row, INCLUDING its `_MIN_TG_TOKENS` rule (a decode span under
  16 tokens is reported as null, not as a made-up rate).
- `bench_engine.event_stream` — the events/cond/terminal SSE delivery model
  is reproduced on our run object, so the shared generator replays it
  verbatim (same contract classic pins in test_benchmark_sse_replay.py).

WAVE PINS (user fix 2026-10-27: 'make sure they run in parallel, really' +
'ignore concurrency limits set in server for the benchmarks') — two vanilla
behaviours serialised the wave no matter what the panel promised:

* the server's `max_concurrent_requests` setting lands on the scheduler as
  `max_num_seqs` (admission cap) + `completion_batch_size` (decode cap), so a
  wave wider than the cap queues requests instead of overlapping them;
* with `chunked_prefill=False` (the default) a lone long prompt is prefilled
  in ONE executor step, and `add_request` rides the SAME single MLX executor
  (engine_core.py, `run_in_executor`) — so while request 1 prefills, the
  staggered submissions of requests 2..N cannot even reach the scheduler.
  The user sees exactly that: nothing, then request 2 'arrives' when
  request 1's prefill ends, everything else queued.

`_pin_wave` raises the caps and forces the chunked, unthrottled, fairness-free
scheduling mode for the duration of the probe — on the BENCHED ENGINE'S OWN
scheduler only. Every write goes through the same attributes vanilla's live
apply paths use (admin routes write `scheduler._decode_fairness` /
`._prefill_speed_priority` plus the config mirror; engine_pool applies
concurrency as the config pair plus the live BatchGenerator cap), the values
are restored by `_unpin_wave` in the run's finally, the server settings
themselves are never touched, and other engines never see any of it.
What pins CANNOT lift: the preflight memory guard (physical limits) and a
model class that forces serial decode inside `_effective_max_num_seqs`
(llama4 / overflow recovery) — those still shape the wave honestly.

LIVE REPORT (user follow-ups 2-4, 2026-10-27):
- one line per request, as a 'request' event and in the results payload:
  pending -> submitted -> prefilling (processed/total read from the engine's
  PrefillProgressTracker, which the scheduler updates per chunk) ->
  generating (token counts from our own stream) -> done.
- a MEASURED steady-state decode rate (`steady_decode_tps`): the watcher
  samples total completion (with the generating-stream count and whether
  ANY request was prefilling that tick), and the rate is measured over the
  CLEAN windows only — no prefill in flight, at least two streams decoding.
  classic's combined figure is kept byte-for-byte comparable — but at long
  prefills with a stagger it is an approximation, and reading it against
  classic's pp1024 batch rows is comparing different physics (short context
  + clean decode vs long context + sibling-prefill contention), which is
  the ~4x gap the user saw. `steady_streams_avg` says how many streams the
  window averaged, so combined is never mistaken for per-stream.
- a `memory` block in the aggregate: peak device memory over the wave
  (classic's own reset/get peak method), peak process footprint, and the
  scheduler's guard limit/usage/headroom at wave start — what was used AND
  what was available. Anything unmeasurable stays ABSENT, never zero.

NO-CEILING DOCTRINE (U50: when lifting a bound, hunt every clamp so the UI
never promises more than the runner does): `prefill_tokens` accepts ANY
whole number >= 1024 and `parallel` any whole number >= 1; the UI inputs
carry a `min` and NO `max`. The one bound that survives is not a clamp in
this repo — it is the model's own context window inside the engine — and it
fails LOUD: every request compares the engine's reported `prompt_tokens`
against the requested size and ends the run with an error naming both, so a
truncated prefill can never be billed as a full one.

CONTENTION — WHAT IS COVERED, AND THE ONE LIMITATION:
- This lane refuses to START while any other bench owns the engine:
  classic throughput, context probe, ANE tuning, the classic accuracy
  queue, and uplift embed/decision runs are all checked — the same
  bench_queue probe table every native start consults, so the two
  surfaces cannot disagree about who holds the slot.
- The reverse direction IS covered for the NATIVE panels: `prefill` is
  registered in bench_queue.BUSY, so a native throughput/context/embed/
  decision start while a probe runs goes into the global FIFO instead of
  onto the engine.
- NOT covered: classic's OWN admin page (/admin/api/bench/start) checks
  only its own `get_active_run()` registry, which lives inside vanilla's
  module and cannot see an uplift-native run without editing vanilla.
  A throughput bench started from the classic page while a probe is in
  flight will therefore share the engine with it and both sets of numbers
  will be wrong. The panel hint says exactly this.
- This lane also deliberately does NOT unload the model when it finishes
  (classic's throughput run does): the probe is not a leaderboard run, and
  evicting the user's loaded model as a side effect of an option the panel
  labels 'local probe' would be a worse surprise than a warm engine.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

# BadInput/Conflict/NotFound/NotRunning + event_stream are REUSED from the
# throughput mirror on purpose: routers and tests speak one exception
# vocabulary and one SSE generator across every bench surface.
from .bench_engine import (BadInput, Conflict, NotFound, NotRunning,  # noqa: F401
                           event_stream)

logger = logging.getLogger("uplift.bench_prefill")

# ---- the sanity bounds this module owns (floors only; see the docstring) --
MIN_PREFILL_TOKENS = 1024   # classic's own smallest ladder rung: below it a
                            # 'prefill probe' measures mostly decode
MIN_PARALLEL = 1
MIN_GENERATION_TOKENS = 1
MAX_RUNS_KEPT = 10
# Watcher cadence for the live per-request report (user Q3 2026-10-27): the
# engine's prefill tracker updates once per chunk, so 1 s reads everything it
# knows without spamming the SSE. Tests shrink this constant, never the code.
WATCH_S = 1.0
WATCH_S_CLEAN = 0.25   # decode-only regime samples finer: the clean tail of
                       # a wave can be shorter than one slow tick (wide8 sweep
                       # lesson: 1.8 s of true 288 t/s decode fit between two
                       # 1 s samples and steady came back absent)
# Absolute cap on ONE wave's requests. Not a product bound on 'longer
# prefill with custom parallelism' — it exists so a typo cannot open 100k
# concurrent add_request calls on a live server. 256 is already 32x the
# widest batch classic offers.
MAX_PARALLEL = 256


def _engine():
    """Lazy import: this module must stay importable without omlx (CI)."""
    from omlx.admin import benchmark as B
    return B


# ---------------------------------------------------------------------------
# request model (uplift-owned: NO vanilla validator is involved)
# ---------------------------------------------------------------------------

@dataclass
class PrefillRequest:
    model_id: str
    prefill_tokens: int
    parallel: int
    stagger_seconds: float
    generation_tokens: int
    context_profile: str = "code_python"

    def public(self) -> dict:
        return {
            "model_id": self.model_id,
            "prefill_tokens": self.prefill_tokens,
            "parallel": self.parallel,
            "stagger_seconds": self.stagger_seconds,
            "generation_tokens": self.generation_tokens,
            "context_profile": self.context_profile,
        }


def _whole(value: Any, name: str, floor: int, ceiling: Optional[int] = None) -> int:
    """A whole number at or above `floor` (and at or below `ceiling`, when
    this module declares one). bool is rejected — True as 'parallel=1' is a
    bug, not a request."""
    if isinstance(value, bool) or value is None:
        raise BadInput(_bound_text(name, floor, ceiling))
    if isinstance(value, float):
        if not value.is_integer():
            raise BadInput(_bound_text(name, floor, ceiling))
        value = int(value)
    if not isinstance(value, int):
        raise BadInput(_bound_text(name, floor, ceiling))
    if value < floor:
        raise BadInput(_bound_text(name, floor, ceiling))
    if ceiling is not None and value > ceiling:
        raise BadInput(_bound_text(name, floor, ceiling))
    return value


def _bound_text(name: str, floor: int, ceiling: Optional[int]) -> str:
    if ceiling is None:
        return (f"Invalid {name}. Must be a whole number of at least {floor}.")
    return (f"Invalid {name}. Must be a whole number between {floor} "
            f"and {ceiling}.")


def validate_body(body: dict) -> PrefillRequest:
    """Pure shape check — no engine, no pool, no awaits. Routers and the
    bench queue can call it before anything is reserved (embed_engine /
    decision_engine precedent: garbage is a 400, never a claim on the
    engine)."""
    body = body or {}
    model_id = str(body.get("model_id") or "").strip()
    if not model_id:
        raise BadInput("model_id required")
    profile = str(body.get("context_profile") or "code_python")
    try:
        B = _engine()
        # vanilla's keys are BenchmarkContextProfile enum members; a stand-in
        # may use plain strings — read whichever shape the module ships.
        known = {getattr(p, "value", p)
                 for p in (getattr(B, "BENCHMARK_CONTEXT_PROFILES", {}) or {})}
    except Exception:          # no omlx (CI): profile stays a free string,
        known = set()          # the engine's own builder rejects it later
    if known and profile not in known:
        raise BadInput(f"Unknown context profile: {profile}")
    # stagger: seconds, >= 0 (0 = simultaneous, classic's fixed behaviour)
    stagger = body.get("stagger_seconds", 0)
    if isinstance(stagger, bool) or not isinstance(stagger, (int, float)):
        raise BadInput("Invalid stagger_seconds. Must be a number of "
                       "seconds, 0 or more.")
    stagger = float(stagger)
    if stagger < 0:
        raise BadInput("Invalid stagger_seconds. Must be a number of "
                       "seconds, 0 or more.")
    return PrefillRequest(
        model_id=model_id,
        # NO ceiling on prefill_tokens: the only bound is the model's own
        # window, enforced (and reported) by the engine at run time.
        prefill_tokens=_whole(body.get("prefill_tokens"), "prefill_tokens",
                              MIN_PREFILL_TOKENS),
        parallel=_whole(body.get("parallel"), "parallel", MIN_PARALLEL,
                        MAX_PARALLEL),
        generation_tokens=_whole(body.get("generation_tokens"),
                                 "generation_tokens", MIN_GENERATION_TOKENS),
        stagger_seconds=stagger,
        context_profile=profile,
    )


def start_offsets(parallel: int, stagger_seconds: float) -> list:
    """The submit schedule: request i leaves at i * stagger after the wave
    starts. Pure and separate because this arithmetic is the whole feature
    ('stagger their starts') — 0 keeps classic's simultaneous gather."""
    return [round(i * float(stagger_seconds), 6) for i in range(int(parallel))]


def aggregate_metrics(rows: list, *, wall_start: float, wall_end: float,
                      prompt_tokens: int, min_decode_tokens: int = 16) -> dict:
    """Wave totals, same definitions classic's `_run_batch_test` uses
    (benchmark.py:1160-1174) so a 1024-token / N=4 / stagger-0 probe is
    comparable with classic's own batch-4 row:

      combined prefill tok/s = ALL prompt tokens / time until the LAST
                               request finished prefill
      combined decode tok/s  = ALL generated tokens / wall time after that
                               last first-token

    `rows` are the per-request rows produced by `_request` and must carry
    `first_token_abs` / `end_abs` / `completion_tokens` / `prompt_tokens`.
    """
    if not rows:
        raise ValueError("aggregate_metrics needs at least one request row")
    n = len(rows)
    total_prompt = prompt_tokens * n
    wall_time = wall_end - wall_start
    ttfts = [r["ttft_ms"] for r in rows if r.get("ttft_ms") is not None]
    last_prefill = max(r["first_token_abs"] for r in rows)
    prefill_wall = max(last_prefill - wall_start, 1e-9)
    gen_wall = max(wall_end - last_prefill, 0.0)
    total_completion = sum(int(r.get("completion_tokens") or 0) for r in rows)
    # classic's honesty rule, applied to the WAVE: a generation window that
    # short (or empty) is back-to-back emission bursts, not a decode rate.
    decode = (total_completion / gen_wall
              if gen_wall > 1e-9 and total_completion >= max(1, min_decode_tokens)
              else None)
    return {
        "requests": n,
        "prompt_tokens_each": prompt_tokens,
        "total_prompt_tokens": total_prompt,
        "total_completion_tokens": total_completion,
        "wall_time_s": round(wall_time, 3),
        "prefill_wall_s": round(prefill_wall, 3),
        "generation_wall_s": round(gen_wall, 3),
        "combined_prefill_tps": round(total_prompt / prefill_wall, 1),
        "combined_decode_tps": round(decode, 1) if decode is not None else None,
        "avg_ttft_ms": round(sum(ttfts) / len(ttfts), 1) if ttfts else None,
        "max_ttft_ms": round(max(ttfts), 1) if ttfts else None,
        "min_ttft_ms": round(min(ttfts), 1) if ttfts else None,
    }


# ---------------------------------------------------------------------------
# run registry (uplift-side mirror of classic's, same accessor shapes)
# ---------------------------------------------------------------------------

@dataclass
class PrefillRun:
    """Classic's SSE delivery model (append-only `events` under `cond` +
    `terminal`) so `bench_engine.event_stream` reads it unchanged."""

    bench_id: str
    request: PrefillRequest
    status: str = "running"      # running | completed | cancelled | error
    events: list = field(default_factory=list)
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)
    terminal: bool = False
    task: Optional[Any] = None
    phase: str = "prepare"
    progress: float = 0.0
    message: str = ""
    submitted: int = 0             # requests that reached the engine (wave bar
                                   # counts FINISHES; this counts SUBMITS)
    # Live per-request report (user Q3): index -> public state dict
    # {index, phase, submit_s, processed, total, completion}. The watcher
    # owns prefill-side updates (the engine's tracker), the request consumer
    # owns phase changes it can see in its own stream.
    req_state: "dict[int, dict]" = field(default_factory=dict)
    # (perf_counter, summed completion tokens) samples taken by the watcher —
    # what the steady-state decode rate is MEASURED from (user Q2).
    dec_samples: list = field(default_factory=list)
    results: list = field(default_factory=list)
    aggregate: Optional[dict] = None
    error_message: str = ""
    peak_process_bytes: int = 0
    created_at: float = field(default_factory=time.time)


_TERMINAL_TYPES = frozenset({"done", "error"})
_runs: "dict[str, PrefillRun]" = {}


def create_run(request: PrefillRequest) -> PrefillRun:
    run = PrefillRun(bench_id=f"pf-{uuid.uuid4().hex[:12]}", request=request)
    _runs[run.bench_id] = run
    return run


def get_run(bench_id: str) -> Optional[PrefillRun]:
    return _runs.get(bench_id)


def get_active_run() -> Optional[PrefillRun]:
    for run in _runs.values():
        if run.status == "running":
            return run
    return None


def active_run() -> Optional[PrefillRun]:
    """bench_queue.BUSY probe accessor (its table calls it on every
    start/queue decision of every OTHER bench surface)."""
    return get_active_run()


def cleanup_old_runs(max_runs: int = MAX_RUNS_KEPT) -> None:
    """classic's retention rule, our registry: keep the newest N, drop
    settled runs only (a running one is never collected — it is the slot)."""
    if len(_runs) <= max_runs:
        return
    settled = [r for r in _runs.values()
               if r.status != "running"
               and (r.task is None or r.task.done())]
    settled.sort(key=lambda r: r.created_at)     # oldest first
    for run in settled[: len(_runs) - max_runs]:
        _runs.pop(run.bench_id, None)


async def _send_event(run: PrefillRun, event: dict) -> None:
    async with run.cond:
        run.events.append(event)
        if event.get("type") in _TERMINAL_TYPES:
            run.terminal = True
        run.cond.notify_all()


async def _progress(run: PrefillRun, phase: str, message: str,
                    done: int, total: int) -> None:
    run.phase = phase
    run.message = message
    run.progress = round(done / total, 4) if total else 0.0
    await _send_event(run, {"type": "progress", "phase": phase,
                            "message": message, "current": done, "total": total})


# ---------------------------------------------------------------------------
# live per-request report (user Q3: 'each request startup on a new line,
# maybe the state of it, phase (prefill/generation)')
# ---------------------------------------------------------------------------

def _state(run: PrefillRun, index: int) -> dict:
    return run.req_state.setdefault(index, {"index": index, "phase": "pending",
                                            "submit_s": None,
                                            "processed": 0, "total": 0,
                                            "completion": 0})


async def _emit_state(run: PrefillRun, index: int) -> None:
    await _send_event(run, {"type": "request",
                            "data": _public_state(run.req_state[index])})


def _public_state(state: dict) -> dict:
    """Wire shape: the scheduler request id is bookkeeping, not UI."""
    return {k: v for k, v in state.items() if k != "rid"}


def _tracker():
    """The engine's process-wide prefill tracker, or None (CI, or vanilla
    without the module). Read-only here: the scheduler owns its writes."""
    try:
        from omlx.prefill_progress import get_prefill_tracker
        return get_prefill_tracker()
    except Exception:
        return None


def _footprint():
    try:
        from omlx.utils.proc_memory import get_phys_footprint
        return int(get_phys_footprint())
    except Exception:
        return 0


async def _watch_wave(run: PrefillRun) -> None:
    """Tick every WATCH_S while the wave lives: fold the engine's prefill
    tracker into the per-request states, sample the decode total (the
    steady-state rate is MEASURED from these, not inferred from classic's
    window arithmetic), and track the process footprint peak. Emits a
    'request' event only when a line actually changes, and one aggregated
    'progress' line per tick when it moves — the status box and any
    message-only client (old tab, poll fallback) then keep changing during
    the long prefills too (user report: 'progress bar 0% and nothing
    changed while the dashboard showed one generating')."""
    tracker = _tracker()
    peak = {"process": _footprint()}
    last_msg = ""
    try:
        while True:
            states = list(run.req_state.values())
            all_done = bool(states) and all(s["phase"] == "done" for s in states)
            prefill_now = False
            if tracker is not None:
                for s in list(run.req_state.values()):
                    if s["phase"] not in ("submitted", "prefilling"):
                        continue
                    try:
                        entry = tracker.get(s.get("rid") or "")
                    except Exception:
                        entry = None
                    if entry:
                        # entries auto-remove at prefill end: presence here
                        # means the engine is still working through the prompt
                        before = (s["phase"], s["processed"])
                        s["phase"] = "prefilling"
                        s["processed"] = int(entry.get("processed") or 0)
                        s["total"] = int(entry.get("total") or 0)
                        prefill_now = True
                        if before != (s["phase"], s["processed"]):
                            await _emit_state(run, s["index"])
            if any(s["phase"] == "prefilling" for s in run.req_state.values()):
                prefill_now = True      # last chunk: tracker already cleared
            n_gen = sum(1 for s in run.req_state.values()
                        if s["phase"] == "generating")
            total_completion = sum(s["completion"]
                                   for s in run.req_state.values())
            run.dec_samples.append((time.perf_counter(), total_completion,
                                    n_gen, prefill_now))
            fp = _footprint()
            if fp > peak["process"]:
                peak["process"] = fp
            if all_done:
                # terminal sample BEFORE the break: the interval that ends
                # the wave still holds clean decode tokens (its stream
                # average is honestly diluted by the completions)
                break
            msg = _wave_message(run)
            if msg != last_msg:
                last_msg = msg
                run.message = msg
                await _send_event(run, {"type": "progress", "phase": "probe",
                                        "message": msg,
                                        "current": len(run.results),
                                        "total": max(1, run.request.parallel)})
            await asyncio.sleep(
                WATCH_S_CLEAN if (not prefill_now and n_gen >= 2) else WATCH_S)
    except asyncio.CancelledError:
        pass
    finally:
        run.peak_process_bytes = peak["process"]


def _fmt_tokens(n: int) -> str:
    return f"{n:,}"


def _wave_message(run: PrefillRun) -> str:
    """One honest summary line of the wave: '#k prefilling 12,288/32,768'
    style details while they fit, phase counts when they don't."""
    states = sorted(run.req_state.values(), key=lambda s: s["index"])
    if not states:
        return run.message
    groups: "dict[str, list]" = {}
    for s in states:
        groups.setdefault(s["phase"], []).append(s)
    if len(states) <= 6:
        parts = []
        for s in states:
            if s["phase"] == "pending":
                parts.append(f"#{s['index'] + 1} queued")
            elif s["phase"] == "submitted":
                parts.append(f"#{s['index'] + 1} submitted")
            elif s["phase"] == "prefilling":
                parts.append(f"#{s['index'] + 1} prefilling "
                             f"{_fmt_tokens(s['processed'])}/"
                             f"{_fmt_tokens(s['total'])}")
            elif s["phase"] == "generating":
                parts.append(f"#{s['index'] + 1} generating "
                             f"{s['completion']} tok")
            else:
                parts.append(f"#{s['index'] + 1} done")
        return " · ".join(parts)
    words = {"pending": "queued", "submitted": "submitted",
             "prefilling": "prefilling", "generating": "generating",
             "done": "done"}
    return " · ".join(f"{len(groups[p])} {words.get(p, p)}"
                      for p in ("prefilling", "generating", "submitted",
                                "pending", "done") if p in groups)


def steady_decode_tps(samples: list, min_tokens: int = 16):
    """Combined decode tok/s MEASURED over the CLEAN windows of the wave:
    watcher intervals where NO request of the wave was prefilling and at
    least TWO streams were generating. That is the regime the in-flight
    dashboard shows and the user counts as 'reality' — classic's combined
    figure (all tokens / after-the-last-first-token) blurs it with the
    contention phase, which is exactly why it read ~40 against a real ~100.
    Also reports how many streams the window averaged, so the number is
    never mistaken for a per-stream rate. None when no clean window
    produced at least `min_tokens` — reported absent, never guessed."""
    tok = 0.0
    secs = 0.0
    wstreams = 0.0
    for (t0, c0, n0, p0), (t1, c1, n1, p1) in zip(samples, samples[1:]):
        if p0 or p1 or t1 <= t0:
            continue
        n = (n0 + n1) / 2.0
        if n < 2:
            continue
        tok += max(0.0, c1 - c0)
        secs += t1 - t0
        wstreams += n * (t1 - t0)
    if secs <= 0 or tok < max(1, min_tokens):
        return None
    return {"steady_decode_tps": round(tok / secs, 1),
            "steady_streams_avg": round(wstreams / secs, 1),
            "steady_window_s": round(secs, 3)}


# ---------------------------------------------------------------------------
# start / control
# ---------------------------------------------------------------------------

async def _other_bench_busy() -> Optional[str]:
    """Which OTHER bench owns the single engine slot? Reuses bench_queue's
    probe table — the same arbiter every native start consults — so this
    lane and the global FIFO can never disagree about who is busy (and a
    queued run that has not started yet is respected too, instead of being
    jumped). A probe that cannot answer (no omlx) never blocks us."""
    from . import bench_queue
    try:
        return await bench_queue.busy_check()
    except Exception as e:
        logger.debug("prefill probe: bench queue undecidable: %s", e)
        return None


def _claim_checks() -> None:
    """The SYNCHRONOUS part of the contention rule: our own registry, then
    classic's throughput registry, then the context probe. Raising Conflict
    here is what keeps the claim atomic — bench_engine.start's rule is that
    nothing may await between these reads and create_run()."""
    own = get_active_run()
    if own is not None:
        raise Conflict("A custom benchmark is already running "
                       f"(bench_id={own.bench_id}, "
                       f"model_id={own.request.model_id}).")
    B = _engine()
    t = B.get_active_run()
    if t is not None:
        raise Conflict("A throughput benchmark is already running "
                       f"(bench_id={t.bench_id}, model_id={t.request.model_id}).")
    try:
        from omlx.admin import context_benchmark as CTX
        if CTX.get_active_run() is not None:
            raise Conflict("A context benchmark is already running.")
    except ImportError:
        pass


async def start(body: dict, pool: Any) -> dict:
    """Validate + launch one probe. Mirrors the throughput router's
    contract: 409 contention, 404 unknown model, 400 invalid input.

    The queue check has to be awaited (bench_queue.busy_check is async), and
    an await yields the event loop — so the synchronous claim checks run
    AGAIN immediately before create_run, and `create_run` itself registers
    with status 'running', which is exactly what every later reader looks
    for (bench_engine.start's atomicity rule, restored rather than claimed)."""
    req = validate_body(body)
    _claim_checks()
    reason = await _other_bench_busy()
    if reason:
        raise Conflict(f"Cannot start the custom benchmark: {reason}.")
    _claim_checks()

    entry = pool.get_entry(req.model_id)
    if entry is None:
        raise NotFound(f"Model not found: {req.model_id}")
    if getattr(entry, "model_type", None) not in ("llm", "vlm", None):
        raise BadInput(f"Model {req.model_id} is not a supported model "
                       f"(type: {entry.model_type})")

    cleanup_old_runs()
    run = create_run(req)
    try:
        run.task = asyncio.create_task(_probe(run, pool))
    except BaseException as e:
        # a claimed run whose task never launched would block every later
        # probe AND every native bench start (bench_queue probe reads us)
        run.status = "error"
        run.error_message = str(e)
        run.terminal = True
        raise
    logger.info(
        f"uplift prefill probe started: {run.bench_id} model={req.model_id} "
        f"pp={req.prefill_tokens} parallel={req.parallel} "
        f"stagger={req.stagger_seconds}s tg={req.generation_tokens}")
    return {"bench_id": run.bench_id, "status": "started",
            "requests": req.parallel,
            "prefill_tokens": req.prefill_tokens,
            "stagger_seconds": req.stagger_seconds,
            "generation_tokens": req.generation_tokens}


def _sampling_params(B: Any, generation_tokens: int) -> Any:
    """The same non-sampling settings classic's batch test pins
    (benchmark.py:1095-1100): greedy, ignore_eos so the tg budget is the
    measured budget."""
    from omlx.request import SamplingParams
    return SamplingParams(max_tokens=generation_tokens, temperature=0.0,
                          top_p=1.0, ignore_eos=True)


# ---------------------------------------------------------------------------
# wave pins — see the WAVE PINS block of the module docstring
# ---------------------------------------------------------------------------

def _pin_targets(core: Any):
    """(scheduler, config, executor) behind the batch-benchmark core seam.

    The core is the AsyncEngineCore wrapper: scheduler lives on its EngineCore
    (`core.engine.scheduler`), the executor on the wrapper property. A test
    fake may hang `scheduler` straight off the core — both shapes are read."""
    inner = getattr(core, "engine", None) or core
    sched = getattr(inner, "scheduler", None)
    if sched is None:
        return None, None, None
    return sched, getattr(sched, "config", None), getattr(core, "_mlx_executor", None)


def _pin_wave(core: Any, parallel: int) -> Optional[dict]:
    """Pin the benched engine for the wave: caps raised to `parallel`, chunked
    prefill on (bounded executor steps so staggered submissions land), memory
    throttle off (classic's own bench rule: throttled chunks are not
    comparable), decode fairness off (sibling bench traffic must not repay
    fairness debt to each other). Returns the undo map, or None when the core
    exposes no scheduler (fakes, exotic engines) — measurement then simply
    runs under the server's own limits."""
    sched, cfg, executor = _pin_targets(core)
    if sched is None:
        return None
    saved: dict = {}
    if cfg is not None:
        # RAISE only: a wave of 4 on a server capped at 8 keeps the 8.
        for name in ("max_num_seqs", "completion_batch_size"):
            cur = getattr(cfg, name, None)
            if isinstance(cur, int) and not isinstance(cur, bool) \
                    and cur < parallel:
                saved[name] = cur
                setattr(cfg, name, parallel)
        for name, value in (("chunked_prefill", True),
                            ("prefill_speed_priority", True),
                            ("decode_fairness", False)):
            if hasattr(cfg, name):
                saved[name] = getattr(cfg, name)
                setattr(cfg, name, value)
    # cached mirrors: the hot paths read these scheduler attributes, not the
    # config (the scheduler copies them at init; vanilla's live toggles write
    # both — so do we)
    for attr, value in (("_prefill_speed_priority", True),
                        ("_decode_fairness", False)):
        if hasattr(sched, attr):
            saved[attr] = getattr(sched, attr)
            setattr(sched, attr, value)
    if "_decode_fairness" in saved:
        saved["_decode_time_owed_s"] = getattr(sched, "_decode_time_owed_s", 0.0)
        sched._decode_time_owed_s = 0.0     # vanilla's toggle pattern
    # The shared BatchGenerator is created once with the config as it was
    # THEN, so the config write above misses an already-built one (fresh
    # engines are fine — their generator is built after the pin).
    gen = getattr(sched, "batch_generator", None)
    if gen is not None:
        cur = getattr(gen, "completion_batch_size", None)
        if isinstance(cur, int) and not isinstance(cur, bool) and cur < parallel:
            saved["gen_cap"] = cur
            floor = max(parallel, int(getattr(gen, "prefill_batch_size", 1) or 1))
            try:
                if executor is not None:
                    executor.submit(setattr, gen, "completion_batch_size", floor)
                else:
                    gen.completion_batch_size = floor
            except Exception:      # shutting-down executor: the config carries
                logger.debug("prefill probe: live decode cap bump skipped",
                             exc_info=True)
    return saved


def _unpin_wave(core: Any, saved: Optional[dict]) -> None:
    """Restore everything _pin_wave touched (idempotent, never raises out —
    a failed restore would leave the USER's server running the bench's
    settings)."""
    if not saved:
        return
    try:
        sched, cfg, executor = _pin_targets(core)
        for name in ("max_num_seqs", "completion_batch_size", "chunked_prefill",
                     "prefill_speed_priority", "decode_fairness"):
            if name in saved and cfg is not None:
                setattr(cfg, name, saved[name])
        for attr in ("_prefill_speed_priority", "_decode_fairness",
                     "_decode_time_owed_s"):
            if attr in saved and sched is not None:
                setattr(sched, attr, saved[attr])
        if "gen_cap" in saved and sched is not None:
            gen = getattr(sched, "batch_generator", None)
            if gen is not None:
                try:
                    if executor is not None:
                        executor.submit(setattr, gen, "completion_batch_size",
                                        saved["gen_cap"])
                    else:
                        gen.completion_batch_size = saved["gen_cap"]
                except Exception:
                    logger.debug("prefill probe: decode cap restore skipped",
                                 exc_info=True)
    except Exception:
        logger.warning("prefill probe: wave-pin restore failed", exc_info=True)


async def _one_request(run: PrefillRun, B: Any, core: Any, prompt: list,
                       params: Any, *, index: int, offset: float,
                       record: bool = True,
                       wave_t0: Optional[float] = None) -> dict:
    """One measured request of the wave: wait its stagger slot, submit,
    stream, hand the timing to classic's own metric math.

    `record=False` is the warm-up call: same code path, same engine, but no
    result row and no progress event, so a JIT-compile pass never lands in
    the probe's numbers or its table.

    The SUBMIT event is what makes the stagger visible while the wave is in
    flight (user fix 1: 'nothing seems to happen until the first request
    prefills'): the panel shows the wave ENTERING the engine request by
    request, long before any of them finishes, and `submit_s` in the row is
    the REAL leave-time, not the scheduled one."""
    if offset > 0:
        await asyncio.sleep(offset)
    submit = time.perf_counter()
    request_id = await core.add_request(prompt=prompt, sampling_params=params,
                                        skip_cache_store=True)
    if record:
        run.submitted += 1
        st = _state(run, index)
        st.update(phase="submitted", rid=request_id,
                  submit_s=round(submit - wave_t0, 3) if wave_t0 else None)
        await _emit_state(run, index)
        await _send_event(run, {
            "type": "progress", "phase": "probe",
            "message": (f"Request {index + 1}/{run.request.parallel} "
                        f"submitted (+{(submit - (wave_t0 or submit)):.1f}s)"),
            # the bar keeps counting FINISHES: a submit must not move it
            "current": len(run.results),
            "total": max(1, run.request.parallel)})
    first: Optional[float] = None
    prev = 0
    completion = 0
    reported_prompt = 0
    async for output in core.stream_outputs(request_id):
        comp = int(getattr(output, "completion_tokens", 0) or 0)
        if record:
            run.req_state[index]["completion"] = comp
        if first is None and comp > prev:
            first = time.perf_counter()
            if record:
                # the tracker drops its entry at prefill end; say so loudly
                # from our own stream, where we SEE the first token
                st = run.req_state[index]
                if st["phase"] != "generating":
                    st["phase"] = "generating"
                    st["processed"] = st["total"]
                    await _emit_state(run, index)
        prev = comp
        if getattr(output, "finished", False):
            completion = comp
            reported_prompt = int(getattr(output, "prompt_tokens", 0) or 0)
    end = time.perf_counter()
    if first is None:
        first = end
    if record and reported_prompt and reported_prompt != len(prompt):
        # The loud half of the no-ceiling doctrine: the engine cut the
        # prompt (context window / memory guard), so this row is NOT a
        # pp{len(prompt)} measurement and must not be printed as one.
        # The warm-up request is exempt: it is a 32-token pass whose length
        # says nothing about the real probe, and blaming it would point the
        # user at the wrong number.
        raise BadInput(
            f"Request {index + 1}: the engine prefilled {reported_prompt} "
            f"tokens of the {len(prompt)} requested — this model's context "
            "window does not accept that prefill length. Lower the length "
            "or raise the model's context window.")
    metrics = B._compute_single_metrics(
        prompt_tokens=len(prompt),
        completion_tokens=completion,
        start_time=submit,
        first_token_time=first,
        end_time=end,
        peak_memory=0,
        cached_tokens=0,
    )
    metrics.pop("peak_memory_bytes", None)   # not sampled here: absent, not 0
    row = dict(metrics)
    row.update({
        "index": index,
        "start_offset_s": round(offset, 3),
        # the REAL leave-time against the wave clock (submit_s is what the
        # panel's Start (s) column prints; start_offset_s stays the scheduled
        # slot, so a pin failure is visible as a gap between the two)
        "submit_s": round(submit - wave_t0, 3) if wave_t0 else None,
        "first_token_abs": first,
        "end_abs": end,
    })
    if not record:
        return row
    st = run.req_state[index]
    st["phase"] = "done"
    st["completion"] = completion
    st["processed"] = st["total"] = row.get("prompt_tokens") or st["total"]
    await _emit_state(run, index)
    run.results.append(row)
    done = len(run.results)
    await _progress(run, "probe",
                    f"Request {done}/{run.request.parallel} finished "
                    f"(pp{row.get('prompt_tokens')} / "
                    f"tg{row.get('completion_tokens')})",
                    done, max(1, run.request.parallel))
    await _send_event(run, {"type": "result", "data": _public_row(row)})
    return row


def _public_row(row: dict) -> dict:
    """Wire shape: absolute clocks are the wave's private bookkeeping."""
    return {k: v for k, v in row.items() if not k.endswith("_abs")}


def _memory_guard(core: Any) -> dict:
    """The scheduler's OWN memory-guard view at wave start: the soft limit
    and the cached current usage (event-loop-safe: no mx refresh). This is
    the pair that decides whether an N x pp wave fits, so the panel can say
    what was AVAILABLE, not only what was used."""
    sched, _cfg, _ex = _pin_targets(core)
    out = {}
    if sched is None:
        return out
    try:
        limit = int(getattr(sched, "_memory_limit_bytes", 0) or 0)
        if limit > 0:
            out["guard_limit_bytes"] = limit
    except Exception:
        pass
    try:
        used = int(sched._current_usage_bytes(refresh_mlx_active=False))
        if used > 0:
            out["guard_usage_bytes"] = used
    except Exception:
        pass
    if "guard_limit_bytes" in out and "guard_usage_bytes" in out:
        out["guard_headroom_bytes"] = max(
            0, out["guard_limit_bytes"] - out["guard_usage_bytes"])
    return out


def _memory_summary(peak_gpu: int, guard: dict, run: PrefillRun) -> Optional[dict]:
    """Merge the wave's memory facts; keys that could not be measured are
    ABSENT, never zero (the same honesty rule as the decode floors)."""
    mem = dict(guard or {})
    if peak_gpu:
        mem["peak_gpu_bytes"] = int(peak_gpu)
    if run.peak_process_bytes:
        mem["peak_process_bytes"] = int(run.peak_process_bytes)
    return mem or None


async def _probe(run: PrefillRun, pool: Any) -> None:
    B = _engine()
    req = run.request
    core: Any = None
    pins: Optional[dict] = None
    watcher: Optional[Any] = None
    try:
        total = max(1, req.parallel)   # the bar is the wave: 1 per request
        await _progress(run, "load", f"Loading {req.model_id}...", 0, total)
        # force_lm: the batched scheduler core (add_request/stream_outputs)
        # is the mlx-lm engine; classic reaches it the same way, via
        # get_engine(force_lm=...) whenever no VLM/MTP override applies.
        engine = await pool.get_engine(req.model_id, force_lm=True)
        core = B._get_batch_benchmark_core(engine)
        if core is None:
            raise BadInput(
                f"Model {req.model_id} does not expose the batched engine "
                "core, so parallel prefill cannot be measured for it.")
        tokenizer = getattr(engine, "tokenizer", None)
        if tokenizer is None:
            raise BadInput(f"Model {req.model_id} exposes no tokenizer.")
        # user fix 2: the wave ignores the server's concurrency limit while
        # it runs; _unpin_wave in the finally puts it back (see WAVE PINS).
        pins = _pin_wave(core, req.parallel)

        await _progress(run, "prompt", f"Building {req.parallel} prompt(s) of "
                        f"{req.prefill_tokens} tokens...", 0, total)
        # Distinct prompts, one builder call each — the unique UUID prefix
        # inside _generate_prompt is what keeps the parallel requests from
        # hitting each other's prefix cache (classic's own reason for
        # building max_batch prompts, benchmark.py:2127-2130).
        prompts = [B._generate_prompt(tokenizer, req.prefill_tokens,
                                      req.context_profile)
                   for _ in range(req.parallel)]
        for i, p in enumerate(prompts):
            if len(p) != req.prefill_tokens:
                raise BadInput(f"Prompt {i + 1} built {len(p)} tokens, "
                               f"expected {req.prefill_tokens}.")

        await _progress(run, "warmup", "Warming up (JIT compile)...", 0, total)
        # classic warms before it measures for the same reason: without it
        # the first wave absorbs Metal shader + JIT compile time.
        warmup_prompt = B._generate_prompt(tokenizer, 32, req.context_profile)
        await _one_request(run, B, core, warmup_prompt,
                           _sampling_params(B, 8), index=-1, offset=0.0,
                           record=False)

        params = _sampling_params(B, req.generation_tokens)
        offsets = start_offsets(req.parallel, req.stagger_seconds)
        await _progress(run, "probe",
                        f"Running {req.parallel} request(s) at pp"
                        f"{req.prefill_tokens} / tg{req.generation_tokens}"
                        + (f", staggered {req.stagger_seconds}s"
                           if req.stagger_seconds else ", simultaneous"),
                        0, total)
        wall_start = time.perf_counter()
        for i in range(req.parallel):
            _state(run, i)                  # every line visible from t=0
        # classic's own peak-memory method (benchmark.py:1145-1156): reset the
        # device counter at the wave edge, read it at the far edge. Guarded:
        # without mlx (CI) the memory block simply stays absent.
        try:
            import mlx.core as mx
            mx.reset_peak_memory()
            have_mx = True
        except Exception:
            have_mx = False
        guard = _memory_guard(core)
        watcher = asyncio.create_task(_watch_wave(run))
        # return_exceptions, NOT a bare gather: a sibling must never be left
        # streaming after this run went terminal (its late 'result' event
        # would land after 'done' and its engine work would collide with
        # whatever bench starts next).
        outcomes = await asyncio.gather(*[
            _one_request(run, B, core, prompts[i], params,
                         index=i, offset=offsets[i], wave_t0=wall_start)
            for i in range(req.parallel)], return_exceptions=True)
        wall_end = time.perf_counter()
        # The watcher self-terminates on the all-done tick — give it a beat
        # to land the terminal sample instead of cancelling it mid-sleep
        # (cancelling straight away shaves the clean tail off the steady
        # measurement exactly when the wave is shortest on generation).
        try:
            await asyncio.wait_for(watcher, timeout=1.5)
        except BaseException:
            watcher.cancel()
            try:
                await watcher
            except BaseException:
                pass
        peak_gpu = 0
        if have_mx:
            try:
                import mlx.core as mx
                peak_gpu = int(mx.get_peak_memory())
            except Exception:
                peak_gpu = 0
        failures = [o for o in outcomes if isinstance(o, BaseException)]
        if failures:
            raise failures[0]
        rows = list(outcomes)
        min_tg = int(getattr(B, "_MIN_TG_TOKENS", 16) or 16)
        run.aggregate = aggregate_metrics(
            rows, wall_start=wall_start, wall_end=wall_end,
            prompt_tokens=req.prefill_tokens, min_decode_tokens=min_tg)
        # steady-state decode: measured over the CLEAN windows — no request
        # prefilling and at least two streams generating (see the helper)
        steady = steady_decode_tps(list(run.dec_samples), min_tokens=min_tg)
        if steady:
            run.aggregate.update(steady)
        run.aggregate["memory"] = _memory_summary(peak_gpu, guard, run)
        run.status = "completed"
        run.phase = "done"
        run.progress = 1.0
        run.message = "Benchmark complete."
        await _send_event(run, {"type": "aggregate", "data": run.aggregate})
        await _send_event(run, {"type": "done", "bench_id": run.bench_id})
    except asyncio.CancelledError:
        run.status = "cancelled"
        run.phase = "cancelled"
        run.message = "Cancelled."
        await _send_event(run, {"type": "error",
                                "message": "Custom benchmark cancelled."})
        raise
    except Exception as e:
        run.status = "error"
        run.phase = "error"
        run.error_message = str(e)
        logger.warning(f"uplift prefill probe failed: {e}", exc_info=True)
        await _send_event(run, {"type": "error", "message": str(e)})
    finally:
        # the watcher must die with the wave on EVERY path (cancel/error
        # included) — an orphan would keep ticking the engine's tracker
        if watcher is not None and not watcher.done():
            watcher.cancel()
        # the server's OWN limits come back before anything else runs —
        # a cancelled or failed wave must not leave the engine pinned
        _unpin_wave(core, pins)
        if not run.terminal:
            run.terminal = True
        if run.status == "running":
            run.status = "error"


# ---------------------------------------------------------------------------
# read/control surface (classic route shapes)
# ---------------------------------------------------------------------------

def active_summary() -> dict:
    run = get_active_run()
    if run is None:
        return {"running": False, "bench_id": None, "model_id": None}
    req = run.request
    return {"running": True, "bench_id": run.bench_id, "model_id": req.model_id,
            "prefill_tokens": req.prefill_tokens, "parallel": req.parallel,
            "stagger_seconds": req.stagger_seconds,
            "generation_tokens": req.generation_tokens,
            "done": len(run.results)}


def results_payload(run: PrefillRun) -> dict:
    return {
        "bench_id": run.bench_id,
        "status": run.status,
        "phase": run.phase,
        "progress": run.progress,
        "message": run.message,
        "request": run.request.public(),
        "results": [_public_row(r) for r in run.results],
        # the live per-request report, for the REST-poll fallback (SSE
        # consumers get the same shapes as 'request' events)
        "requests": [_public_state(s)
                     for _, s in sorted(run.req_state.items())],
        "aggregate": run.aggregate,
        "error": run.error_message or None,
    }


async def cancel(run: PrefillRun) -> dict:
    if run.status != "running":
        raise NotRunning(run.status)
    if run.task is not None and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "bench_id": run.bench_id}
