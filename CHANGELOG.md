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

- **First-run installs got honest errors.** Fresh-machine E2E (both README
  lanes) found three walls: `omlx-uplift install` with no server anywhere
  self-mounted into uplift's own venv and died as a cryptic
  `ModuleNotFoundError` — it now stops before writing anything and names the
  fix (`brew install omlx` or the dev lane); the `omlx-dev` formula's
  "tap jundot/omlx first" guard used `odie` at file top level, which Homebrew
  7 does not provide during formula load — every affected command
  (`brew unpin`, `brew options`) showed a Ruby stack trace instead of the
  message, now a plain `raise`; and the README quick-starts were wrong on
  step one (`brew tap jundot/omlx` has no default repo — the explicit
  `https://github.com/jundot/omlx` URL is required), skipped `brew install
  omlx` in the classic lane, missed `brew trust` for the jundot tap, the
  first-run API-key setup step (a fresh server has no key for the /uplift/
  login), a documented LAN-bind warning, and the correct full-removal order
  (unpin before uninstall, trust before unpin).


- **The labelless row under "Skip API key verification" is now the keyless-inference switch you were looking for.** The "Allow inference without API key" row shipped in a drift sync without its label text — it rendered as a bare toggle and, worse, its enable-confirmation dialog silently did nothing. Both fixed, and a new guard test fails whenever any settings row references a label that does not exist (the same drift would have been caught at review).

- **Quantizer rows now hide when they have nothing to offer.** The sensitivity-model, combine-MTP, Engram-tables rows and the enhanced (oQe) block stayed visible even when folded — the form's own CSS beat the browser's hidden rule. They now appear only when they apply (candidates exist / oQe checked / V4.1 model selected).

- **The quantizer tells the truth about DeepSeek V4.1.** The engine only supports oQ2–oQ4 (five calibrated levels, bfloat16 output) for V4.1 models and rejects the rest; the quantizer form now hides the unsupported levels and applies the same policy as the classic page (dtype pinned to bfloat16, text-only off, sensitivity model cleared at oQ4) instead of letting you pick a level that can only fail at start.

- **First run no longer dead-ends at the login card.** On a server without an API key yet, `/uplift/login` now shows a create-key form (with a random-key button) and completes the same one-time loopback setup the classic page uses — instead of answering every attempt with "Invalid API key".
- **`dev bootstrap` asks how to build.** Custom Metal kernels are presented as the answer you almost certainly want (fastest engine; skip only if this Mac cannot run Xcode); xgrammar is offered, and free formula flags can be typed in. If the Metal compiler is missing, the flow offers to install it: it runs `xcodebuild -downloadComponent MetalToolchain` when Xcode is present, or opens Xcode's App Store page when it is not. The answer is stored in `dev.json` and used by every `dev install`; explicit `--with-*` flags override it and are remembered; a terminal build with kernels on now checks the toolchain before brew starts instead of failing deep inside the compile. No vanilla omlx install is needed anywhere in this path.

## [2.6] — 2026-10-20

- **tg benchmarks now decode the length you asked for.** The Throughput bench's tg128–1024 rows measured a shorter decode than their label: a model that ends its own turn early was scored at ~25 tokens under a tg1024 label. Bench runs now ignore the model's stop tokens (bench only — normal serving is untouched), and the results table gained an `out` column with the real generated-token count.
- **Dev builds no longer break the running board, and an upgrade no longer rebuilds for nothing.** `dev install` builds a new timestamped keg beside the live one and switches at the end; previous builds stay for `dev use` rollback. `dev upgrade` rebuilds only when the omlx tip or the patch set actually moved, and `--restart` restarts the dev server only after a build that did something.
- **The header names the exact build.** The badge shows the active omlx-dev keg stamp, and a second line under the logo the vanilla omlx version and base commit it was cut from; the tooltip carries the full patch story.
- **A patch can no longer be wrongly marked "upstreamed".** The probe read the dev keg — a tree that carries patches by design — and retired three live patches at once; retired patches are now revalidated against a clean upstream checkout and restored when it lacks them. Every bundled patch goes into omlx-dev as a build commit, so the dev keg is exactly the branch.
- **KV cache compression and Claude Desktop.** The model editor picks the KV cache format (turboquant, affine 4-bit, affine 8-bit) with bits pinned per format, and the Integrations page gained a Claude Desktop switch that reconfigures the server. The dashboard tracks omlx 0.7.1.

*A new bundled patch, `bench-force-tg`, ships on the Patches page.*

## [2.5] — 2026-10-20

- **The dev lane stands alone.** omlx-dev and Uplift no longer require the classic oMLX keg: a machine that runs only the HEAD build installs, mounts and patch-checks without it. The build base follows upstream HEAD by default, and the dev panel says so.
- **Loads faster, redraws less.** Heavy pages — voice chat, the patches and dev panels, download tools — load only when you first open them. Theme switches no longer rebuild every chart, and the server batches duplicate sampling work behind the meters.
- **Chat settings stick.** Thinking mode and your preset selection survive switching between conversations.

## [2.4] — 2026-10-20

- **The Patches page is one table.** One row per patch, with checkboxes for the vanilla server and the dev build, and an AUTO column for auto-update. The MANAGE dialog covers versions, pins, test, source edit and removal.
- **Chat renders math.** Formulas written as `$x$` or `$$…$$` display as real equations. The renderer ships inside the dashboard; no network is needed.
- **The Memory & cache card shows real memory use.** The figure used to be the sum of model-file sizes, so it stayed flat while the server actually grew.
- **The Activity card no longer sleeps.** Clicking into Chat, Bench or Cluster used to stop its live stream; loads took up to 15 seconds to appear. Both are fixed.

*P.S. Two new curated patches wait on the Patches page. They remove two server stalls around model loads: the ~19 s freeze while a vision model loads, and the ~0.8 s pause on the first request after a load.*

## [2.3] — 2026-10-19

- **macOS `say` is now a TTS engine.** A VOICES tab lists every
  system voice, folded by language, with quality tiers; downloadable
  voices are marked and install from there. Mark a preferred voice
  per language, or let bare `say` work the language out from the
  text.
- **TTS settings restructured.** "TTS & Voices" opens on TEXT TO
  SPEECH; each engine is a card with its voices wired under it, and
  a model's VOICES chip jumps to its cloned voices.
- **Reading replies aloud got real controls.** Play, pause, progress,
  re-record — pause stops where you left and resumes from that
  second. With auto-speak, every chunk gets a numbered row with a
  waveform and the highlight follows the voice.
- **Voice recognition is steadier.** The last sentence always arrives
  when you stop talking; whisper large-class models avoid a broken
  transport; the LISTEN noise floor calibrates itself. A new
  optional patch runs Qwen3-ASR live: utterances commit in about a
  second.
- **Audio shows on the dashboard.** Speaking and listening activity
  rides the stats feed as it happens.
- **The chat page sits still.** One-line top bar, no more whole-page
  scroll, voice picker and Auto merged into one "Speak" row; a saved
  preset stays selectable beside your edited copy, so reverting no
  longer means deleting.
- **Patch zones cleaned up.** Two exclusive zones, rebuild chips
  classified by actual content, dev kegs take runtime overlays
  without a rebuild.
- Small touches: install no longer hangs on a probe, `patch status`
  reads like a human wrote it, per-bubble SPEAK follows the chunk
  strategy, a stale voice no longer blanks the picker.

## [2.2] — 2026-10-18

- **Profiles now remember what you were editing.** Change the prompt or
  any setting while a profile is selected and the picker reads
  `Profile (modified)` — the unsaved copy lives **on that profile**.
  Switching between profiles no longer overwrites in-progress work
  (the old design had one anonymous stash slot for everyone), coming
  back finds your edits where you left them, and they survive a
  reload. Delete on a modified row reverts to the saved profile; Save
  keeps suggesting its original name.
- The anonymous "Modified (unsaved)" row is gone from profile flows —
  it appears only for a chat never saved under any profile. Existing
  conversations migrate their pending edits onto their selected
  profile automatically.

## [2.1] — 2026-10-18

- **The chat got a voice and ears.** Replies read themselves aloud
  while streaming (gapless chunked TTS — sentence / line / paragraph),
  and push-to-talk plus continuous hands-free listening ride a live
  speech-recognition stream — echo-guarded and decoupled from the chat
  model. STT model, language and auto-send live in the Voice input
  settings.
- **Whole-page presets.** A profile stores and restores the prompt,
  thinking, sampling, web search and voice — everything settable on the
  page except the model you talk to. Edits surface as
  'Profile (modified)', Save suggests the original name (keep it to
  update, type a new one to create), Delete reverts unsaved changes or
  removes the preset — and nothing is lost silently: a page you switch
  away from is stashed.
- **The chat was rebuilt classic-style:** histories left, settings
  right, model and preset on top; the voice-settings popover stays
  visible and follows scroll.
- **Request Inspector** decodes prompts even after the model was
  unloaded (tokenizer from disk); the Activity card gained a per-model
  Unload button.
- **Bench:** harness runs carry per-question records (raw downloads),
  the thinking checkbox reaches the server, and two more FAST Czech
  suites joined.
- Small touches: voice references in mp3/flac transcode to WAV at
  save, the streaming reader cuts at sentence boundaries, the chat
  picker lists text models only, and classic multi-line profiles are
  no longer falsely marked modified.

## [2.0] — 2026-10-15

- **The board stopped fighting itself.** An open dashboard tab no longer
  pins a CPU core or freezes requests: stats build off the event loop,
  ride a live stream instead of timers, and charts fetch only new
  points — ~5 % of a core instead of a full one.
- **Decision bench scores any chat model** via the new upstream
  /v1/decisions readout, with a forced-choice "System One" answer
  policy; every row carries the path that produced it.
- **Nine more suites in a collapsed "Additional suites" section**
  (IFEval, BBH, Czech MMLU-ProX-Lite, hellaswag, winogrande, mathqa,
  TruthfulQA, KMMLU, CMMLU) — the classic grid stays pure and
  TruthfulQA measures truthfulness again.
- **Benches are easier to run:** all seven surfaces in the menu, one
  clear progress bar, a global queue instead of a rejection, honest
  ms/question labels, raw rows downloadable.
- **Voices: record the reference clip in the tab**, with a per-language
  read-aloud suggestion and a free-form language field.
- **Synced to upstream 0.7.1** — model settings keep saving; one SAVE
  now commits base + all profile tabs; bench envs rebuild clean.

## [1.99b] — 2026-10-11

The voice release.

- **Named voice cloning.** Save a reference clip + transcript as a
  named voice on the new Voices page, preview it before saving, edit
  it later or save a copy onto another TTS model. A local
  speech-recognition model can transcribe the clip for you. Chat got a
  read-aloud button on every assistant reply with a voice picker that
  remembers your choice.
- **Voices from any audio client.** A standard OpenAI-shaped endpoint
  (`/uplift/v1/audio/speech`, works with the official SDK as-is). Any
  speech route accepts `Model:Voice` — e.g. `Qwen3-TTS:Jake` — so a
  stored voice is one field away from any client, on any TTS model.
- **Voice calls cannot hang forever** — a 240 s watchdog ends a stuck
  request with an honest message.
- **Tabbed settings.** The model editor and the server settings page
  now split their long forms into tabs (with dirty-count badges); tab
  colors derive from the active skin.
- **Profile drift is shown before it bites** — `(= base)` tags and a
  request-divergence preview with one-click sync.
- **Small touches:** "Download queued" no longer locks the download
  button.

## [1.4] — 2026-10-11

The measurement-honesty release: the dashboard shows what is really
happening, and hides nothing that happened before.

- **MTP acceptance metrics.** Native Lightning MTP stats that vanilla
  only printed at sequence finish are now collected and graphed: an
  'MTP accepted tgs' area under the Throughput generation line, and
  one acceptance card with the per-depth decay ladder. The card's
  headline reads the same number as the ladder's top edge.
- **Embedding work counts in Throughput (EMBED-1).** Embedding and
  reranker models ran on a path the chart never watched; they now have
  their own series.
- **Charts hold still when data goes stale.** No more sliding the
  window left with an empty hole; the 'value holds, then pops into
  place' delay on 5-second cards is fixed at the root.
- **Metric history survives upgrades.** Rows from previous sessions
  and old kegs are visible again; only live co-tenant writers are
  filtered.
- **Faster, smoother live feed.** The 2 Hz sampler is deadline-
  scheduled; backgrounded tabs paint instantly on return; a
  'Smoothing:' select on the Throughput chart; click any card title to
  pop the graph out full-size.
- **Honest settings and patch workflow.** Non-LLM models no longer
  show ~47 LLM settings that their engines ignore; a patch touching
  the Homebrew formula is held with an explanation instead of showing
  APPLIED while doing nothing; dashboard rebuilds stream their log
  live; stored patch versions remember the base they tested against.
- **Small touches:** the Request feed is now a popup with 2 h default
  history (stale 'queued' rows are repaired at open), legends fit
  inside cards, card titles fit one line, Escape closes layout edit
  mode, default skin is Discovery One, the throughput bench lets you
  pick generation length (tg128–1024).

## [1.3] — 2026-10-09

The patch-workflow release. The CLI can now drive the whole patch lifecycle
without a browser, dev builds route around merged-but-moved upstream PRs
instead of wedging, and the model cards lead with the name and tell the
build truth.

- **The CLI knows the whole patch lifecycle now.** `patch approve ID` is a