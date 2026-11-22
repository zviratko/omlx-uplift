# 0004 ssd-prefix-prefetch: upstream PR

## Request
The patch is measured (it also prevents a Metal GPU-watchdog failure on drives that need more than ~20 s for the restore read). Standalone it still holds ALL waiting requests while a prefetch runs (head-of-line); memory-budget-admission's backfill removes that only when both patches are active.

## Done when
- The head-of-line wait is fixed inside the patch itself (skip only the deferred request in the admission loop), tested, and the PR text is confirmed by the owner.

## Result
