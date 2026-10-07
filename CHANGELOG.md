# Changelog

Notable changes to omlx-uplift, per release. `brew install
zviratko/uplift/omlx-uplift` gets the latest tagged release; `--HEAD`
tracks `main`. Tags are cut from `main` with the formula retargeted in
the same commit — see `tests/test_release_formula.py` for what is pinned.

Maintenance rule: when a change is worth a user's attention (feature,
fixed annoyance, changed behavior, new command), add one bullet under an
`Unreleased` heading in the same PR/commit; release preparation moves
`Unreleased` into a version section. Not a commit dump — skip refactors
users never see.

## Unreleased
- **Native Bench/Chat shell (preview branch only, off by default).** The
  `feat/native-bench-chat` build accepts `?native=off|bench|chat|all` (or
  `uplift_native_surfaces` in `~/.omlx/uplift/config.json`) to swap the
  Bench and Chat tabs from the embedded classic iframes to native stub
  pages; `off` keeps today's behavior exactly. Nothing changes for main.
- **Native throughput benchmark (preview branch).** With the bench
  surface flagged on, the Throughput sub-tab is a real native page now:
  form (model, context profile, prompt lengths, batch sizes, ANE-aligned
  prompt, force-lm, external endpoint) drives the classic benchmark
  engine in-process over `/uplift/api/bench/*` — SSE live progress and
  results, cancel, single-run guard. Community leaderboard upload is an
  explicit opt-in checkbox (the classic page auto-uploads standard runs;
  native never posts to omlx.ai unless you check it). All labels ride
  the classic `bench.*` translation catalog plus new `uplift.bench.*`
  keys in all 10 locales.

## [1.1] — 2026-10-07

The release that closes a self-inflicted production outage: patch
backups are keyed to a keg identity that never used to change, so an
upgrade could silently restore old bytes into a new keg. Uplift can now
detect that class of drift by itself (`doctor`), plus a live 2 Hz metric
feed and an environment-variables reference.

### Added
- **Live rate feed (2 Hz).** Throughput, queue and memory lines resolve at
  2 Hz over short windows (≤ 5 min) instead of waiting for the 5 s stored
  tick. A FastSampler thread walks the same collectors into in-memory
  rings, streamed over SSE with a ring replay on (re)connect. The stored
  series is untouched: the 5 s tick drains its own accumulator share, so
  every persisted rate keeps its full-window semantics. Opt-in per card
  via *Layout → Live rate feed (2 Hz)*; the stream pauses while the tab is
  hidden. `iogpu.wired_limit_mb` now caches 60 s (its reader forked a
  sysctl every tick).
- **Environment variables reference.** A new *ENVIRONMENT VARIABLES*
  button in Server settings opens a searchable modal over 147 documented
  `omlx` engine knobs (11 groups), each with its description, stock
  default, honest apply-class badge and live state (SET / STORED / LAUNCH
  ENV / MANAGED). On an `omlx-dev` install 136 of them are editable
  through the UI or `omlx-uplift env list|set|reset|disable-all|enable-all`;
  on a vanilla install the modal is read-only by design and says so (PUT
  403s) — vanilla owns those variables and last-writer-wins. Editing
  stays an allow-list: a name absent from the catalog is rejected.
- **`omlx-uplift doctor`** — a read-only census of every installed `omlx`
  file against its install-time hash (exit 0 clean/expected, 1 drift, 2 no
  RECORD). Custom-kernel binaries that brew legitimately rebuilds and
  files owned by an applied patch are expected drift, never an alarm. The
  same census runs at boot (warns, never blocks) and the PATCHES card
  shows a red banner naming the drifted files. The Oct-1..4 incident
  below would have failed this check on its first boot.
- PREFILL, not just decode: the Throughput chart's prefill line and the
  prefill flagship card now plot the **exact per-tick rate**
  (`prefill.tokens_s`, credited from the engine's prefill-tracker events
  as each chunk happens) instead of `avg_prefill_tps`, a session-lifetime
  average upstream only updates when a request *finishes* — aborted
  requests never counted and one prefill could not move the line. The
  average stays collected and labelled as an average on the session tile.
- SYNC-1 upstream sync: Server settings gained the **GPU Keep-Warm
  Interval** row (upstream `server.gpu_keep_warm_interval` — live-applied,
  was previously settings.json/env-only), the Helper page lists **DeepSeek
  Harness** with the other CLI assistants (upstream #3950), and the model
  editor's Model Type offers **decision** (upstream #4315, Clef/OpenJev).
  The drift guards that should have caught these silently skipped on the
  standalone repo; they now run against a plain upstream checkout nightly.
- Classic parity for storage: **SSD Write Buffer** and **SSD Snapshot
  Precision** are now always visible with the control disabled when the
  effective storage mode does not use them, exactly like the classic
  dashboard — previously both rows were hidden unless SSD-snapshot storage
  was set explicitly. Labels relabelled to the classic catalog across all
  10 locales.
- `omlx-uplift serve --qa` runs an isolated instance on its own base
  (`~/.omlx-qa`, its own fresh API key): a QA server can no longer rewrite
  production settings — the root cause of the 2026-10-03 port-persistence
  incidents.
- Charts respect what their values can physically be: percent metrics pin
  0–100, temperatures and byte counters float their own range, rates stay
  floored. Card y-axes give room for 3–4 ticks instead of 2, so the axis
  no longer reads `[0, 1]` on an idle card.
- Inkwell gained a teal accent plate (its chart series 2 now clears 3.5:1
  on the card background).

### Changed
- Dev builds stash every outgoing keg under its own build name (was: one
  entry per commit, so a same-commit reinstall discarded the bytes being
  replaced). Retention default 3 → 5, configurable via `keg_stash_keep` in
  `dev.json`; a bare commit-ish rollback now picks the newest stashed
  build of that commit instead of any build of it.
- In-flight feed wording: spec-prefill extras read
  `(draft $selected / $generated)` — deliberately diverging from classic's
  phrasing, per user decision.
- Stable builds re-pinned to the tested set (`constraints-stable.txt`);
  `--HEAD` still floats.

### Fixed
- **Keg identity: patches no longer resurrect old files into a new
  install.** `keg_id()` hashed `omlx/version.py`, but real wheels ship
  `omlx/_version.py` — so *every* production keg identified as the same
  constant and the documented "reinstall → new identity → patches
  re-validate" guarantee never held. Live consequence: pre-upgrade
  first-touch backups survived a reinstall keyed to that constant, and the
  next patch removal restored 6 files from 5 different upstream commits
  into the newer keg. Every model load failed with a
  `validate_moe_expert_offload()` signature mismatch for three days,
  invisible to pytest, node tests and nightly (none of them load a
  model). Identity now prefers the wheel's `dist-info` RECORD, then
  `_version.py`, then `version.py`.
- A cached `doctor` WARNING used to replay as a false alarm after a manual
  repair. Clean verdicts cache, drift re-censuses every boot, and the read
  side refuses a cached `ok:false` — an alarm that can lie is worse than
  none.
- A `kernel_source` patch added with dev scope produced eight near-identical
  SAFEGUARDS rows, held AUTO-APPLY, and rendered the block twice.
  The heuristic is now scope-aware (on a source tree the rebuild *is* the
  pipeline, so the kernel paths are one display-only advisory), problems
  group per code with the long rebuild hint rendered exactly once, and the
  add-preview defers to the card behind it. Misaligned approve buttons in
  the preview now have their own borders and spacing.
- The whole cache/queue/prefix metric family could stop being recorded:
  `collect_cache` guarded the hits delta but not the misses delta, so an
  engine reporting `hits` without `misses` raised every tick and the
  collector's blanket `except` took the family down with it. Spec-prefill
  *scoring* (draft-model work) is also no longer credited as target
  prefill.
- Memory & Cache legend values no longer blink (~1 s apart, forever):
  the idle legend read the union column's last ROW, which on the new
  mixed 2 Hz/5 s cadence belongs to only one stream at a time — the
  other series rendered '—' between their samples. Idle cells now show
  each series' OWN latest value (hovered crosshair rows keep their
  honest nulls). A distinct root from the axis-tick flicker below,
  same mixed-cadence surface.
- Chart lines no longer show a visible break every ~5 s on short windows.
  The mixed-cadence x column left ~10 nulls between stored samples and
  uPlot clipped each run; a per-series gap hook now bridges holes up to
  ~12 s (3 stored intervals) and keeps a break for a longer one, so a
  stalled sampler or a genuinely quiet metric still reads as absent.
  `spanGaps` was rejected — it would fabricate a straight line across a
  real outage.
- Chart bottom-axis tick labels no longer appear and disappear on a
  ~12–45 s cycle. Every chart feeds uPlot millisecond timestamps but
  never told it (`opts.ms` defaulted to the seconds unit), so the tick
  chooser worked on a fake 3.5-day axis and picked spacings (43.2 s,
  28.8 s) that do not divide the window — as the pinned range slid, the
  tick count flipped 6↔7. Charts now share `TSTAMP_MS = 1` from the
  chartkit; ticks land on clock 30 s boundaries and stay put.
- `server.log` is no longer flooded by the "prefix_cache counters absent"
  notice (98k lines after one restart). Absence right after a restart is
  expected — the engine fills those counters only once requests flow — so
  it now logs once per absence episode instead of on every 5 s tick, and
  the 2 Hz walk (which shares the collector) stays silent.
- Max Concurrent Requests no longer demands a server restart after every
  save: upstream #3765 live-applies it, so Uplift shows the restart badge
  only while distributed (cluster) engines are active — classic parity.
- Restart badges now follow the runtime truth (upstream `runtime_applied`),
  not the classic template's stale badges: Start on Login, KV Cache,
  HF/MS endpoints and CA bundle no longer claim RESTART REQUIRED — they
  apply on save (KV Cache still unloads/reloads models when it takes
  effect; it just never needed a *server* restart). Divergence filed
  upstream as tracker UP-6.
- Achievements: "You upgraded me" / "More memory" / "You made me bigger
  today" no longer fire on their own. They watched `model_memory_max`
  between stats polls — but that value is the memory guard's *dynamic*
  ceiling, recomputed from live vm_stat on every call, so ordinary page
  cache churn drifted it upward and each drift read as a hardware
  upgrade (worst right after a restart, with the dashboard open and
  nothing happening). The praise now fires only on the real user action:
  raising the custom memory ceiling in Server settings. Hot/SSD cache
  growth and guard loosening already fired from committed saves and are
  unchanged.
- Throughput chart: the generation line now shows the **momentary** decode
  rate (new `generation.tokens_s` series — per-tick deltas of the in-flight
  requests' token counters, with the tail of sub-tick and aborted
  generations captured via the engine hooks). It used to plot
  `avg_generation_tps`, a session-lifetime average that no single request
  could move — the "flat line like cumulative stats" symptom. The average
  stays tracked everywhere it is honestly an average: the small metric
  card is now labelled "average generation tok/s" and the Generation tile's
  sub-label reads "average tok/s". Long windows backfill from hourly usage
  rollups; zeros are recorded, so the line drains to 0 instead of vanishing.
- `cache_efficiency` hourly backfill divided a raw ratio while the live
  key is a percent; auto-scaled axes hid the 100× error, and the 7 d/30 d
  history would have drawn flat along the floor once the axis pinned 0–100.
  Backfill now mirrors the live formula.
- A selected skin's chart colors no longer freeze to the *previous* skin's
  palette. Re-tint waited on the wrong signal: mid-swap the browser still
  exposes the old stylesheet for ~120–300 ms, so every token fell through
  to the dark defaults. Charts now wait for liveness identified by URL.
- Six locales (ja, ru, fr, es, pt-BR, zh-TW) had English text pasted
  verbatim into the storage-settings labels by an earlier parity sync;
  translated to each locale's own terminology, and the parity guard that
  should have caught it now whitelists quantization labels (BF16/FP32/
  "RHT + int16") that are identical by design.

## [1.0] — 2026-10-03

First stable release; stable Homebrew installs are dependency-pinned
(`constraints-stable.txt`) while `--HEAD` floats.

### Added
- Skin system growth: hover previews in the picker, motion-governance
  validator, skin-overridable CSS tokens, eleven new crates (CAAAAATZ!,
  PHOSPHOR, TRON grid, INKWELL/INKWELL NOIR, discovery-one, halftone,
  kubus, lampion, monitor-83, artelight) and the authoring guide in
  `docs/skins.md`
- Achievements and gamified operations (SHODAN voice), upgrade taunts,
  Czech and 8 more locales at full overlay parity
- Memory & cache header with the three GiB figures; per-card clocks on
  the PHOSPHOR roll band
- CI: GitHub Actions on every push, PR and release tag; nightly
  full-suite watcher for the dev box

### Changed
- Model-settings editor redesigned: Context → Thinking → Sampling →
  Acceleration order, toggles and their knobs as aligned family bands,
  layout fully stable while changes queue (rail pops in, never moves a
  control)
- Patch carrier: dev builds moved to a separate keg (`omlx-dev`), one
  gate rule, one safeguard-approval machine, per-patch disable and
  process log
- Frontend consolidated: one widget registry, one dirty-state machine,
  one fetch kit (`domkit`) — pages no longer drift apart
- Stable builds pin their Python dependencies to the tested set

## [0.9b] — 2026-10-01

Pre-1.0 polish baseline: monorepo split of the frontend (router, models
manager, inspector into modules), shared-domkit groundwork, static-drift
guards, settings-editor modal fixes; login hardening (constant-time key
compare, brute-force throttle).

## [0.1] — 2026-09-26

First standalone repository and Homebrew formula (`zviratko/uplift/
omlx-uplift`): uplift dashboard, metrics store, patch carrier, mount
mechanism (.pth into the omlx keg) and the v1 skin system (drop-in CSS
crates, crate + working-dir formats, CLI codecs) extracted from the omlx
monorepo.
