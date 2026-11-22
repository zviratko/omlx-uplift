# Handoff

State document for the next session. Keep hazards until they are fixed or the owner
accepts them (then mark them with the decision ID). Public repo: no hostnames, user
names or home paths here.

## State (2026-11-22)

| Area | State |
|---|---|
| Curated `default` | ctx-probe-above-native, omlx-tts-macos-say, vlm-load-tokenizer-offloop, warm-before-ready, memory-requeue-store-budget (links jundot/omlx#5542) |
| Curated `optional` | pool-aware-memory-pressure, ssd-prefix-prefetch, memory-budget-admission (v2: timeout releases to vanilla, D1) |
| Upstream PRs | jundot/omlx#5542 open: bound the memory-pressure requeue store and let aborts stop it. Planned: memory-budget-admission as a DRAFT PR after the owner has run with it (D4, ticket 0001). ssd-prefix-prefetch is not upstreamed (ticket 0004). |
| `6b5621b` rollout | The boot sync never writes patches into an omlx source checkout. The guard ships with main; a box picks it up at its next uplift install/upgrade (`omlx-uplift install`, restarts the boards); until then hazard H2 applies there. |
| Probe tools | `scripts/probe-ssd-pool.py` (SSD restore stall, pool pressure; evicts the cache files from the OS file cache without root), `scripts/probe-admission.py` (sized prompts at given fire times, memory sampling, budget log capture). |

Per-patch engineering notes (design, measurements, safety analysis, open items):
`curated_patches/optional/memory-budget-admission.md`,
`curated_patches/default/memory-requeue-store-budget.md`.

## Hazards

- **H1 Slow SSD cache drive.** Every cache store and the memory-pressure requeue run
  at the drive's write speed. Unpatched, a hard-pressure requeue of two long requests
  froze all decoding for minutes and ignored aborts (measured on an SD card, about
  21 MB/s). memory-requeue-store-budget bounds it to about 30 s plus one block.
- **H2 Boxes without `6b5621b`** patch any omlx source checkout in which a keg python
  starts (cwd on sys.path, test child processes), and record the checkout as a patch
  target in `patches.json`. Until a box is reinstalled: write-protect the tree under
  test (`chmod -R a-w omlx`) and check `git status` before every commit.
- **H3 Metal wired limit below the oMLX static ceiling.** The server warns that Metal
  then clamps allocations and can panic the machine when a request exceeds the cap.
  Memory-pressure tests near the ceiling need a server-side guard.

## Pitfalls and harness facts

- A no-op `omlx_uplift` stub first on PYTHONPATH blocks the boot sync only in the
  process that inherits that PYTHONPATH. Test children started with a clean env load
  the real autopatch (H2).
- `patches._omlx_root()` resolves via `find_spec`, so it follows cwd. For gate checks
  pass the keg site-packages path explicitly, or `cd ~` first.
- `git stash` is shared by all worktrees of one repository; avoid stash in scripts
  that run in a worktree of a repo someone else uses.
- Closing a client stream does not abort the request server-side. Bound test
  requests with `max_tokens`; a safety watchdog must act on the SERVER (restart it),
  not on the client.
- The end of a long prefill (switch to decode) spikes the board's memory reading by
  about 10 GB for 1-2 s (measured: 89.8 -> 98.9 GB, back to 88 GB 2 s later). A watchdog on instant values fires on that spike; require the
  limit to hold for some seconds, and keep an instant floor on free system memory.
- Hard memory pressure is not reproducible by load: admission margins are tens of MB
  and the chunk sizer usually throttles first. To test a pressure code path, trigger
  it directly (temporary hook in a copied keg file), never ship the hook.
- Python's `hash()` of a str is randomized per process: prompts built from it differ
  between runs and get no cache hit. Seed with crc32.
- INFO lines of the scheduler (`SSD prefetch`, `Admission budget`) go to
  `<base>/logs/server.log`, not to the Homebrew service log.
- The page cache keeps freshly written SSD-cache files warm; an "SSD read" test is
  only cold after an explicit eviction (the probe does it).
- With 4 concurrent long prefills, decode fairness cut prefill chunks to 1216 tokens
  and total prompt throughput fell below 2-slot levels (ticket 0003).
- Upstream test suite: 6 tests fail on current `main` without any change
  (`test_glm5_next_mtp` split-K x2, `test_hy_v4` NAX, `test_install_detection` x2,
  `test_mcp_client` SSE headers). Compare failure sets, not counts.
