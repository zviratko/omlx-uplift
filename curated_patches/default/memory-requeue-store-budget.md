# memory-requeue-store-budget: engineering notes

Notes for the next agent or reviewer. The code does not read this file. The patch
content is upstream PR jundot/omlx#5542 (linked, not vendored).

## Problem (found 2026-11-22 while demonstrating memory-budget-admission)
- At hard pressure `ProcessMemoryEnforcer` calls `Scheduler.request_memory_requeue()`
  (upstream PR #4509). `_process_pending_memory_requeue` stores each live request's KV
  to the paged SSD cache on the INFERENCE thread, under `bounded_pending_writes(2)`, so
  it runs at the cache drive's write speed.
- `_pending_abort_ids` was checked only between requests. Aborts during a store waited.
- With the SSD cache on an SD card (~21 MB/s): 150k-token request = 19 blocks of 216 MB,
  one block per ~10 s. Two requests = ~6 min frozen. Observed: scheduler wrote 0 log
  lines for 3 min, enforcer repeated "storing and requeueing 2 request(s)" every second
  (160 times), client aborts queued but not processed, server killed by hand.
- Not caused by any uplift patch (pool-aware-memory-pressure only delayed the trigger
  by one enforcer poll). The run had memory-budget-admission switched OFF.

## Fix
- `BlockAwarePrefixCache.store_cache(..., should_stop=None)`: checked before each new
  block is allocated; a True ends the store through the same exit as a failed
  allocation, so the stored blocks stay a valid prefix.
- Requeue passes `should_stop = pending abort or perf_counter() >= deadline`; budget
  `_MEMORY_REQUEUE_STORE_BUDGET_S = 30`, env `OMLX_MEMORY_REQUEUE_STORE_BUDGET_S`
  (0 = no limit). Requests not reached are requeued with nothing stored.
- `_store_for_memory_requeue` reports the tokens really kept (log only).

## Verification
- 6 tests `tests/test_memory_requeue_store_budget.py` on upstream's
  `_chunked_scheduler_rig` (tiny GDN and rotating models, real paged SSD cache).
  Fail-before/pass-after shown by mutation.
- Default suite on jundot/main 7cede985 + fix: 19,804 passed; the 6 failures are
  identical on main (hardware/environment tests).
- Live (Qwen3.8-Flash-Next, SD-card cache): requeue forced with a temporary test hook
  (load-based repros hit hard pressure in 1 of 4 attempts). Store stopped at
  40,960/73,728 tokens after 36.3 s, second request requeued with nothing stored,
  both completed all tokens.

## Pitfall found on the way (omlx-uplift bug, fixed in 6b5621b)
Any omlx-dev keg python started with an omlx SOURCE checkout importable (cwd) runs
`omlx_uplift.pth` -> `autopatch` -> `patchsync.sync_at_startup()`, which finds the
checkout via `find_spec("omlx")`, sees no "omlx-dev" in the path, treats it as a vanilla
target and WRITES the omlx/both-scope patches into the checkout. A PYTHONPATH stub does
not stop child processes that tests start with a clean env. During the PR suite run this
put 4 uplift patches into the PR worktree; caught before the PR was opened. Workaround
used: `chmod -R a-w omlx` on the tree under test, `git status` after the run.
Fix: `patches.is_source_checkout()`; the boot sync and the tree doctor skip an omlx
whose parent holds `.git`. Explicit tree_root callers are unchanged.
