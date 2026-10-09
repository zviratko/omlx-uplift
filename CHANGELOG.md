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

- **The TUI got a real menu shell, laid out like Midnight Commander.** The
  previous version listed its screens as a menu, which was a launcher with
  extra steps; now there is a bar of menus along the top of every panel
  (`Go`, `Patches`, `Catalog`, `Keg`, `Services`, `View`, `Help`), opened with
  `F9` or `Alt`+letter, walked with the arrows and run with `Enter`. Commands
  that cannot run right now stay visible and greyed **with the reason** — a
  disabled command that explains itself teaches the tool instead of hiding
  from you — and a menu command acts on the row its own panel has selected,
  whether or not you are looking at that panel. The panels now fill the whole
  window (details sit beside the list on a wide terminal, under it on a
  narrow one) instead of stacking in a corner, and the bottom row carries the
  function-key legend. Mouse clicks open menus, run items and select rows.
  Nothing was taken away: number keys, letter shortcuts and the `m` launcher
  screen all still work, and every command still shows the CLI it mirrors.
- **Fixed: the TUI showed the wrong vanilla port.** The service rows and
  menu read a top-level `port` key from `~/.omlx/settings.json`, but omlx
  stores it under `server.port` (the same nested key `omlx-uplift view`
  rewrites) — so on any box that changed its port the TUI confidently
  pointed at the default instead. It now reads the real key shape, and the
  menu's help text quotes the ports from the live rows instead of
  hardcoding numbers.
- **The TUI is a menu system now, not a wall of keys.** It boots on a main
  menu whose entries say what lives there and carry live state (the Patches
  line already tells you how many are enabled and whether the kill switch is
  armed). Enter opens what is highlighted: a screen from the menu, an
  **action menu** from a patch or keg row — every command listed with a plain
  description and the CLI command it mirrors. `m` returns to the menu, `Esc`
  backs out one step, arrows step between screens. Number keys and letter
  shortcuts all still work — the menus are an extra path, never a worse one.
  Rows read as sentences too: name + description, then the state in words
  (`applied | enabled | scope omlx | desired v3`) instead of the old
  mark legend you had to memorize.
- **`omlx-uplift tui` — a menu-driven terminal manager.** Five screens
  (overview, patches, curated catalog, omlx-dev keg stash, session log) for
  the everyday recovery work: enable/disable/promote/update/rollback/remove a
  patch, check for drift, reconcile now, arm and clear the kill switch, sync
  the catalog, stash/activate/prune dev kegs, roll back a build, restart a
  service. It is a front-end, not a second implementation: every action calls
  the same function the dashboard route calls or runs the CLI verb printed on
  screen, so the terminal and the browser can never disagree about what a
  button does. Nothing writes until you confirm — a store change asks `y/N`,
  and anything touching tree bytes, a keg or a running service asks you to
  type `YES` on its own line, so a stray keypress cannot arm a rollback.
  Stdlib `curses` only, no new dependency, and it refuses politely (exit 2)
  when piped, redirected or run under `TERM=dumb` instead of spraying control
  codes into a log.
- **Four colour themes, cycled with `T`.** `default` leaves your terminal's
  own palette alone, **`p(doom)`** brings the SHODAN dashboard skin to the
  terminal (void black, laser crimson, ember orange), `phosphor` is a
  single-hue CRT and `mono` drops colour entirely for screenshots and broken
  `TERM`s. Truecolour is deliberately not used — it falls apart across ssh
  hops and remote tmux, which is where this tool gets used — so themes write
  exact RGB into free palette slots when the terminal allows it and otherwise
  approximate, with the status line naming which happened. The choice is
  remembered in `~/.omlx/uplift/tui.json`, kept separate from `patches.json`
  so a cosmetic preference never rides along with the patch manifest.
- **The kill switch no longer needs an importable omlx.** `patch disable-all`
  and `patch enable-all` write only the manifest and the sentinel file, but
  they sat behind the same `is omlx installed for this python?` check as the
  verbs that touch tree bytes — so on a machine where the runtime is broken or
  omlx simply is not importable, the one command that rescues you refused to
  run, and printed nothing on stdout while doing it. Both surfaces now answer
  the switch first (the TUI's `K`/`U` keys follow the same rule). Found by CI,
  which has had no omlx since LOG-2 added these verbs.
- **`omlx-uplift patch rollback ID [--to-v N]`.** The dashboard has had a Roll
  back button for as long as it has had version history; the CLI never got
  its twin, so undoing a bad promote from a shell meant editing the manifest
  by hand. Found while wiring the TUI's rollback key.

- **Alias-card chips and RUNTIME DIVERGENCE no longer show dead knobs.**
  A profile that overrides a gated setting (MoE resident fraction,
  turboquant bits, oQ min tokens, ANE/SpecPrefill/DFlash children) while
  the master switch is off on BOTH the model and the profile printed that
  knob as its own chip/diff row — e.g. `MOE_EXPERT_OFFLOAD_RESIDENT_FRACTION
  0.25` on a card whose MoE offload is disabled, or `qwen35_oq_a8_min_tokens
  128 -> 128` in the editor. Off-master knobs are noise now (base rows only
  ever printed toggled-ON features); a REAL change under an ON master still
  shows. The divergence banner gained a **SYNC BASE → PROFILES** action:
  two-click confirm writes each diverging profile's load-time keys back to
  the base model's current values (the profile inherits them again;
  sampling/thinking and other non-load-time overrides stay untouched).
- **Merged PRs no longer wedge `dev upgrade`. When upstream merges your
  patch PR and later commits move the surrounding code, the stored diff
  stops applying — the drift gate used to report a bare `error` and the
  build died on materialize (live case jundot/omlx#4320: the merged PR's
  web-UI files moved to `apps/omlx-web`, its context was trimmed). The
  check now asks GitHub whether the PR merged BEFORE reporting the
  error: a proven merge marks the patch OBSOLETE ('upstream now contains
  the patch — consider removing') and the dev build skips it, so the
  upgrade goes through. A patch that is merely stale (PR still open, or
  GitHub unreachable) keeps its honest error and needs_review exit —
  the fail-safe rule is unchanged.

## [1.2] — 2026-10-09

The native release. Bench and Chat are real Uplift pages now —
throughput, intelligence (classic 16-task engine + opt-in
lm-evaluation-harness), embeddings/rerankers over MTEB, System-1
decisions, context probe + ANE tuning, and a full chat with thinking,
the web-search tool loop, transcription, inline editing and prompt
profiles. The embedded classic pages stay fully reachable as a
per-viewer fallback: hover the menu for "Classic (Embed)". Plus honest
benchmark progress across restarts and multiple tabs.

- **Intelligence benchmark: live queue board (U83).** While a benchmark
  runs, the Bench → Intelligence page now shows a board instead of one
  gray status line: every queued suite gets a box (name + question
  counter) that fills left to right as it progresses — suites being
  prepared are striped, finished ones stay green with a check, later
  queued entries are all visible and removable. The counters are fixed:
  a running suite counts as 1/3 (not 0/2), the question pair now shows
  questions done over the TOTAL across everything you queued (both
  engines), and lm-eval's per-subtask bars add up instead of restarting.
  Harness dataset-prep no longer looks frozen: when lm-eval goes quiet
  during a download/build the board says so with a live silence timer,
  and a dropped progress stream reconnects visibly with polling fallback.
- **Native Chat prompt profiles + readability.** The
  chat toolbar gained the Profile picker mirroring classic's prompt
  profiles (same localStorage store, so profiles stay the user's across
  both pages; selecting copies the prompt, Save commits an edit back
  into the active profile, and the active name persists per
  conversation). Enhanced-readability now reaches the native panel too:
  switching the board theme restyles the chat bubbles in place — grays
  lift to primary ink with the 12px floor, no reload, no iframe.
- **Native Decision benchmark.** The Bench tab gained a
  Decision sub-tab for System-1 models (Clef/OpenJev via upstream's new
  `/v1/systemone`). Scoring runs in-process against the decision engine
  through upstream's own eviction-proof lease — the bench measures the
  serving path. The task pack ships pinned and offline: three packs
  (ARC-Challenge 294, BBQ 300, TruthfulQA mc1 400) as JSON fixtures with
  sha256 integrity + licence provenance (CC-BY-SA / CC-BY / Apache-2.0,
  extractor script included). Per pack: choice accuracy, Brier + ECE on
  derived probability questions, position-bias agreement (same item
  re-asked with shuffled options) and ms/question latency. Cancel stops
  between items; a cancelled pack is never persisted.
- **Dashboard tabs stop starving each other (hang fix).** Every visible
  tab used to hold two always-open server-sent streams (requests feed +
  metrics feed). uvicorn speaks HTTP/1.1 and browsers cap a plain origin
  at ~6 parallel connections — three background tabs of the dashboard
  already filled the pipe and the fourth froze on load, the "sometimes
  the page hangs, usually because another tab has it open" report. Now
  only the FOCUSED tab holds the streams; blurred tabs close theirs and
  catch up through the existing 2 s poll, and the focused tab replays
  what happened while it was away on return. Hidden tabs behaved this
  way already; focus is now the same gate.
- **Header chips equal the graph headers.** The power and temperature
  chips at the top of the dashboard now show exactly what the matching
  chart card header shows (the card's live last-sample value, not a
  60 s mean/max), so the two readouts can no longer disagree; the
  windowed mean/max stay in the tooltip.
- **Benchmark results persist until cleared (U64).** Throughput,
  accuracy, context and ANE rows survive a server restart and a page
  reload across every surface — classic kept the accuracy table in
  memory only, so a restart silently discarded the session's scores.
  A clear button owns removal now; nothing evicts on its own.
- **Native Bench/Chat + the classic embed, side by side.** The Bench and
  Chat tabs open the native surfaces by default. The embedded classic
  pages stay fully reachable as a fallback: hover Bench and an option to
  reveal "Classic (Embed)" beside it, or hover Chat to reveal it below;
  each embedded page also carries a NATIVE badge in its header to switch
  back. The choice persists per browser (and deep-links as
  `#chat/chat/classic`). A server that wants the embed as the default can
  still set `uplift_native_surfaces` to `off` (or `bench`/`chat`) in
  `~/.omlx/uplift/config.json`, and any viewer can override per load with
  `?native=off|bench|chat|all`.
- **Native throughput benchmark.** The Throughput sub-tab is a real
  native page now:
  form (model, context profile, prompt lengths, batch sizes, ANE-aligned
  prompt, force-lm, external endpoint) drives the classic benchmark
  engine in-process over `/uplift/api/bench/*` — SSE live progress and
  results, cancel, single-run guard. Community leaderboard upload is an
  explicit opt-in checkbox (the classic page auto-uploads standard runs;
  native never posts to omlx.ai unless you check it). All labels ride
  the classic `bench.*` translation catalog plus new `uplift.bench.*`
  keys in all 10 locales.
- **Native context probe + ANE tuning.** The Context
  and ANE Tune sub-tabs are live too: the context benchmark runs in the
  server over `/uplift/api/bench/context/*` (SSE progress; the measured
  window auto-applies to the model's Context Window setting, same as
  classic), and ANE tuning mirrors classic's candidate search + poll
  model over `/uplift/api/bench/ane-tune/*` with an explicit Apply
  button that writes the recommendation through the same settings
  manager the classic UI uses. Labels reuse the classic `ctx_bench.*` /
  `modal.model_settings.qwen_ane_tune*` catalogs (already complete in
  all 10 locales).
- **Native intelligence benchmark.** The Intelligence
  sub-tab is a native page over the classic 16-task accuracy engine
  (`/uplift/api/bench/accuracy/*`): the task grid with per-task sample
  sizes, queue with remove, batch size, deterministic/model-settings
  sampling, thinking toggle, external-endpoint mode, SSE progress and
  the accumulated results table with upload badges. Community
  leaderboard upload is again an explicit opt-in (classic auto-uploads
  local runs ≥100 questions; native never posts unless checked).
  Parity on the dev keg: identical scores native-vs-classic across
  SmolLM2-360M (arc/gsm8k), Qwen2.5-0.5B (queued chain), Qwen3.5-9B
  with thinking on (0.9 = 0.9), and external-endpoint mode.
- **Harness accuracy engine, opt-in.** The Intelligence
  page gained a Scoring-engine choice: Classic (default, unchanged) or
  Harness — lm-evaluation-harness running as a pinned subprocess in its
  own venv (`omlx-uplift bench-env create`, ~600 MB, torch-free by hard
  rule) against the public /v1 path, one suite per subprocess, progress
  at task granularity with per-question counts parsed from harness
  output. Mapped tasks: MMLU (flan 5-shot generative), MMLU-Pro,
  ARC-Challenge, GSM8K, BBQ-generate; a run containing any unmapped
  task is refused with the task names (mixed-engine runs come later).
  humaneval/mbpp STAY classic on purpose: harness exec-scoring runs
  model code in-process, weaker isolation than classic's sandboxed
  subprocess. Scores carry an engine label; full-dataset ARC
  divergence vs classic measured at +1.4 points (few-shot formatting).
  API key passes only through the child environment and is scrubbed
  from all captured output; cancel kills the whole process group and a
  server stop never orphans a harness run (drilled). Dataset cache and
  offline mode configurable (`bench_hf_cache` / `bench_offline` in
  `~/.omlx/uplift/config.json`); the offline drill passed from a warm
  cache.
- **Native Embeddings and Rerankers benchmark.** The
  Bench tab gained two sub-tabs over MTEB: a curated, laptop-sized task
  set (STS, retrieval, classification, pair-classification, clustering,
  bitext — three of them Czech — plus two small instruction-reranking
  sets) instead of MTEB's full 1492-task registry. MTEB runs as a
  subprocess in a second pinned venv (`omlx-uplift mteb-env create`,
  ~1.5 GB) because mteb itself hard-requires torch; the harness bench-env
  stays torch-free and neither the omlx nor the uplift keg gains any
  dependency. Scores stream from the public serving path at task
  granularity (MTEB over the API offers no per-question events; we report
  the real granularity, never a fabricated one) and each row names its
  metric. No community upload exists for these classes.
- **Native Chat (core features).** The Chat tab opens the native page
  (the embedded classic page stays reachable per viewer — see the
  fallback entry; a server can still park Chat on the embed with
  `uplift_native_surfaces` or any viewer with `?native=off|bench`).
  Streaming chat, stop, model picker
  (chat-capable models only), system prompt, copy/regenerate/edit,
  image attachments with vision answered, and a server-side history
  store with stated caps; classic localStorage chats import once on
  first boot. deep-chat 2.5.1 (MIT) is vendored with pinned sha256 and
  a drift test. A live reasoning panel mirrors classic's thinking modes
  (auto/on/limit/off) and persists per message. A web-search toggle
  runs classic's full tool loop natively (web_search/fetch_url via the
  server's /v1/web routes, multi-round chaining, bounded, stop-safe —
  drilled live). Selecting a speech-to-text model turns the input into
  classic's transcription flow (attach audio or record with the mic;
  capture is WAV client-side because a webm upload needs an ffmpeg the
  server may not have); the transcript streams into an assistant turn
  and cannot be regenerated, matching classic. Skins restyle the chat
  live with zero reload — CSS custom properties cross the component's
  shadow boundary, so the theme needs no JS on the switch path.

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
