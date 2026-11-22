# memory-budget-admission: engineering notes

Notes for the next agent or reviewer. The code does not read this file. The patch is
`memory-budget-admission.diff`, its catalog entry `memory-budget-admission.json`.
Status: optional tier, not upstreamed. Built against upstream `ade9f20a`, applies clean
on `f99a31f4`. Plan: owner runs with it, then a draft PR to jundot/omlx.

## Problem
1. Admission (`_admission_estimate`, shared by route preflight and the in-stream
   `_preflight_memory_check`) prices a new request as `current + its KV + transient`.
   `current` is memory in use NOW. A running request that is still prefilling or
   decoding allocates more later, and that growth is invisible. Two large prompts can
   both pass and then collide (guard pause / enforcer abort mid-prefill).
2. A request that does not fit NOW is rejected (HTTP 400, `prefill_memory_exceeded`)
   even when it would fit as soon as the running work finishes.
3. The waiting queue is a FIFO deque. Every gate that defers the head (`break`) stops
   all admission, also for small requests that would fit (head-of-line).
4. The only concurrency control is a count (`max_concurrent_requests`).

## Design (what the patch does)
- Reservation per admitted request: KV for `prompt + requeued output + decode
  allowance` where allowance = `min(max_tokens, OMLX_ADMISSION_DECODE_RESERVE=2048)`.
  KV bytes come from upstream's own `memory_monitor.estimate_resident_kv_bytes`.
- Budget check for a waiting request while others are admitted:
  `current + sum(outstanding) + own KV + max(largest live prefill transient, own
  transient) - hot-cache credit <= _admission_limit_bytes()`.
  outstanding = KV(reserved) - KV(done); done = cached/processed tokens (prefill
  tracker) for prefilling requests, prompt + output tokens for running ones.
  Transient = `_admission_estimate(...).transient` (upstream pricing, floor chunk).
  The MAX of transients is charged, not the sum: measured, concurrent prefills do not
  add their transients (table below).
- First request always passes when nothing is admitted (same rule as the other guards):
  no permanent block.
- Not fitting = held in the queue (`_budget_held_since`). Held longer than
  `OMLX_ADMISSION_MAX_QUEUE_S` (600, 0 = no limit), counted from arrival -> rejected
  with the SAME `prefill_memory_exceeded` output, so clients see no new error type.
  Only memory-held requests time out; waiting for a slot never does (as before).
- Route preflight (`preflight_or_raise`): if the vanilla check would 400 but the engine
  is busy (admitted or waiting requests), the request is queued instead. An idle engine
  still 400s a prompt that can never fit.
- Backfill: up to 16 waiting requests are scanned in order. A held head, or a head that
  is deferred (cache freshness, SSD prefetch if that patch is present), may be passed
  by a later request that fits and is not deferred. Once a held request is older than
  `OMLX_ADMISSION_AGING_S` (60) nobody may pass it (no starvation). If nothing is
  admissible only because of deferrals, the loop falls back to the exact upstream head
  path.
- Kill switch: `OMLX_ADMISSION_BUDGET=0`. All knobs are environment variables, read on
  every call (no restart needed for a changed value, but launchd env needs a restart).

### Code layout (scheduler.py)
- Method block `_battr` ... `_budget_queue_instead_of_reject`, inserted right before
  `_num_admitted_requests`. Methods are called as `Scheduler._x(self, ...)` so the tests
  can drive them with plain stubs (same style as ssd-prefix-prefetch).
- Hook 1: `_schedule_waiting`, before the admission `while`:
  `rejected_outputs.extend(Scheduler._budget_expire_waiting(self))`.
- Hook 2: in the loop, right before `request = self.waiting[0]`:
  `if not Scheduler._budget_pick_head(self): <clear head stall timers>; break`.
  The picker moves the chosen request to `waiting[0]`; all upstream head checks and the
  in-stream `_preflight_memory_check` still run on it afterwards.
- Hook 3: `preflight_or_raise`, before the "Preflight rejected" warning.
- Markers live in the request's instance dict and are read with `vars()` (`_battr`):
  `getattr` on MagicMock requests in upstream tests returns truthy mocks.
- Logging: INFO when a request is first held, admitted after a hold, or admitted ahead
  of another (names the skipped ids); WARNING on timeout; DEBUG with the full
  projection ONLY when a request's fits/does-not-fit verdict changes (an unconditional
  line flooded 47,865 lines in one run).

### Composition with other build patches
No changed lines in common with ssd-prefix-prefetch (its 2-line hunk sits 5 lines
below hook 2; the two hunks share one unchanged context line), pool-aware-memory-pressure
or specprefill-profile. Verified:
strict `git apply` of all 7 enabled build patches in materialize order (order, id) on a
clean `ade9f20a`, the resulting scheduler.py was byte-identical to the tested one.
Patch ids sort `memory-budget-admission` before `ssd-prefix-prefetch`; keep the hook
position if you rebase.

## Safety analysis (other models, failure modes)
**The budget never relaxes a vanilla memory check, with one deliberate exception.**
It only reorders the queue, delays admission, or rejects after a timeout. Every
admitted request still passes upstream's in-stream `_preflight_memory_check`, the chunk
sizer, the soft-pressure pause and the enforcer, unchanged. The exception is the route
preflight on a busy engine: it queues instead of 400. That request then meets the
vanilla in-stream check at admission time, so the worst case is the vanilla rejection,
delivered later (inside the stream for streaming requests).

**The math is model-agnostic in the same way vanilla's is.** All bytes come from
upstream's estimators: `estimate_resident_kv_bytes` (full-attention layers linear in
tokens, sliding-window layers capped, MLA override, measured GDN/Mamba fixed state)
and `_admission_estimate` (transient). The patch adds no per-model constants. For a
sliding-window model KV(reserved) - KV(done) is capped on both sides, so outstanding
stays small. A fixed per-request state cancels in the difference and is charged once
in own KV.

Direction of errors:
- Underestimate (seen: real peaks 6-9 GB above the projection on Flash-Next, because
  the transient is priced at the throttled floor chunk) -> the budget admits too much.
  Exposure is the SAME as vanilla's (vanilla also ignores outstanding growth, so it
  admits even more). Covered by the same reactive guards. Not a new risk.
- Overestimate -> requests are held longer than needed. This is the only path where
  the patch can do WORSE than vanilla: a request vanilla would have admitted (and that
  might have succeeded) waits and, after 600 s with running work still holding
  memory, is rejected. Known overestimate sources: SpecPrefill requests (reservation
  uses the full prompt KV, the sparse prefill keeps only the selected tokens), the
  decode allowance on models with large KV/token, and any estimator overestimate.
- Larger KV per token (dense full-attention models, ~10x Flash-Next for a 32B with
  8 KV heads x 128 dims x 64 layers bf16) makes the reservation term dominate. That
  is where the patch helps most, and where false holds are most likely if the decode
  allowance is too big.

Not covered (same as vanilla): image/video embedding memory of VLM requests; future
growth of requests on ANOTHER loaded model (each engine has its own scheduler, the
budget sees the other engine's memory in use but not its outstanding reservations).

Code failure modes:
- Picker raises -> caught, WARNING, upstream queue order (vanilla).
- No memory monitor, or `prefill_memory_guard` off -> no holds, no timeouts, no
  preflight change. Only the deferral backfill stays active.
- Estimate returns None -> transient 0, KV from the monitor.
- KNOWN GAP: `_budget_expire_waiting` is not wrapped in try/except. It reuses the
  cached size estimate of held requests, so it should not raise, but if it did, the
  exception would leave `_schedule_waiting`. Wrap it (return []) before upstreaming.

**Does it need testing per model?** Not for memory safety (argument above, it only adds
restrictions on top of vanilla's checks). Yes for usefulness: false holds or a
transient underestimate differ by architecture. Before the PR, run the 2-request A/B
once per architecture class and compare the DEBUG projection with the measured peak:
a dense full-attention model, a sliding-window model (gemma), and a hybrid
(Qwen3.5-style, already done). The procedure is below.

## Verification done
- 17 unit tests `tests/test_admission_budget.py` (in the diff). Mutation check: with
  `_budget_committed` -> (0, 0) and `_budget_queue_instead_of_reject` -> False,
  exactly the 3 targeted tests fail (reservation, transient, busy preflight).
- Upstream suite on uplift-dev + patch (`-m "not slow"`): 19,308 passed. 8 failures,
  all identical without the patch: test_context_benchmark capped_by_native (comes from
  the ctx-probe-above-native patch), glm5_next_mtp split_k x2, hy_v4 NAX (hardware),
  install_detection x2 (environment), mcp_client SSE headers, tts_macos_say locale keys.
- Test recipe (no project venv): keg python + pytest/pytest-asyncio in a --target dir,
  and a no-op `omlx_uplift` stub package FIRST on PYTHONPATH so uplift's boot-sync does
  not mount overlays into the tree under test:
  `PYTHONPATH=<stub>:<pylibs>:<tree> <omlx-dev libexec python> -m pytest tests/... -p no:cacheprovider`
- Gate: `patchsource.fetch_and_gate({"kind":"upload","data":diff}, <keg site-packages>,
  skip_patterns=DEFAULT_SKIP_PATTERNS)` -> ok, test file skipped, no compile problems.

## Measurements (128 GB Apple Silicon MacBook Pro, Qwen3.8-Flash-Next oQ4h, 27.28 KB
KV/token, hot cache 6 GB, guard ceiling 115 GB -> admission limit ~108.8 GB decimal)
Without the patch, fresh prompts, `X-oMLX-Cache-Store: off`:

| run | peak above idle (GiB) | KV (GiB) | rest (transient/pool) | prompt tok/s total |
|---|---|---|---|---|
| 1 x 100k | +9.7 | 2.7 | ~7.0 | 1097 |
| 2 x 100k | +13.6 | 5.4 | ~8.2 | 1282 |
| 2 x 200k | +23.6 | 10.9 | ~12.7 | 1351 |

With the patch (hot-copied into the keg, see method):

| run | setup | result |
|---|---|---|
| T1b | ceiling 115, 2x200k + 3 small | pair fits (projected 94.2 GB vs limit 108.8 GB), real peak 96.2 GiB (103.3 GB) |
| T2b | ceiling 105, decode reserve inflated to 400k | 2nd held; 3 small admitted ahead; held request rejected after 600 s with a clean `prefill_memory_exceeded` |
| T2e | ceiling 92, 2x150k at t=0/1 s, small at 30/50/100 s | 2nd held; small at 30 and 50 s admitted ahead; held admitted after 96.8 s when it fit (first request still prefilling); all OK; guard reached soft once (peak 87.3 GiB vs projection 86.8 GB) |
| T4 | ceiling 115, max_concurrent 4, 2x150k + 2x30k at once + 2 small | all 6 OK, peak 101.9 GiB, guard ok, ~920 tok/s total |

Not observed live: aging (the held request was admitted 3 s before the late small one
arrived), the busy-route-preflight queueing (needs a prompt that fails the vanilla
estimate while others run). Both are unit-tested.

T4 finding, separate from this patch: more slots were memory-safe but slower. With 4
concurrent prefills, decode fairness cut prefill chunks 8192 -> 1216 tokens; total
prompt throughput ~920 tok/s, small requests waited 145 s for a first token (17-21 s
with 2 slots).

## How to test live (method that worked)
- Hot-copy: back up the keg's `omlx/scheduler.py` (check it equals the branch's
  unpatched file), copy the patched one in, delete its `__pycache__` entry,
  `launchctl kickstart -k gui/$UID/sh.brew.omlx-dev`; restore the same way and `cmp`.
  (`launchctl bootout/bootstrap` is blocked inside a Hermes gateway; a shadow server on
  the same port is not possible from there.)
- Make a hold happen on purpose: Flash-Next KV is small, so lower
  `memory.memory_guard_custom_ceiling_gb` (back up settings.json first) and fire both
  large requests within 1 s. A second request sent 20 s later finds most of the first
  one's KV already allocated and correctly fits.
- Fire times per request, not a uniform stagger: a 150-200k prompt tokenizes for
  seconds, so a small request sent just after it reaches the scheduler first.
- Do not cut streams client-side to end a request: closing a urllib stream does not
  abort it server-side until the client process exits. Bound runs with `max_tokens`.
- Read the decisions from server.log (`grep "Admission budget"`); the DEBUG line shows
  every term of the projection.
- Driver used: `scripts/probe-admission.py` (fires sized prompts at given times, samples
  /admin/api/stats every second, aborts all streams above a memory threshold, captures
  the budget log lines).

## Open items before an upstream PR
1. Wrap `_budget_expire_waiting` in try/except (known gap above).
2. Decide the timeout semantics: reject (current, as asked) or "stop holding and let
   the vanilla check decide" (bottom line = vanilla behavior).
3. Per-architecture A/B (dense, sliding window) with projection vs peak.
4. Settings UI / settings.json keys instead of env vars (upstream will want them).
5. Rebase onto the current upstream tip and rerun the suite there.
6. Prefill-fairness slowdown with >2 concurrent prefills: separate issue/PR.
