1|# Changelog
2|
3|Notable changes to omlx-uplift, per release. `brew install
4|zviratko/uplift/omlx-uplift` gets the latest tagged release; `--HEAD`
5|tracks `main`. Tags are cut from `main` with the formula retargeted in
6|the same commit — see `tests/test_release_formula.py` for what is pinned.
7|
8|Maintenance rule: when a change is worth a user's attention (feature,
9|fixed annoyance, changed behavior, new command), add one bullet under an
10|`Unreleased` heading in the same PR/commit; release preparation moves
11|`Unreleased` into a version section. Not a commit dump — skip refactors
12|users never see.
13|
14|## Unreleased

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
24|
25|- **The dev lane stands alone.** omlx-dev and Uplift no longer require the classic oMLX keg: a machine that runs only the HEAD build installs, mounts and patch-checks without it. The build base follows upstream HEAD by default, and the dev panel says so.
26|- **Loads faster, redraws less.** Heavy pages — voice chat, the patches and dev panels, download tools — load only when you first open them. Theme switches no longer rebuild every chart, and the server batches duplicate sampling work behind the meters.
27|- **Chat settings stick.** Thinking mode and your preset selection survive switching between conversations.
28|
29|## [2.4] — 2026-10-20
30|
31|- **The Patches page is one table.** One row per patch, with checkboxes for the vanilla server and the dev build, and an AUTO column for auto-update. The MANAGE dialog covers versions, pins, test, source edit and removal.
32|- **Chat renders math.** Formulas written as `$x$` or `$$…$$` display as real equations. The renderer ships inside the dashboard; no network is needed.
33|- **The Memory & cache card shows real memory use.** The figure used to be the sum of model-file sizes, so it stayed flat while the server actually grew.
34|- **The Activity card no longer sleeps.** Clicking into Chat, Bench or Cluster used to stop its live stream; loads took up to 15 seconds to appear. Both are fixed.
35|
36|*P.S. Two new curated patches wait on the Patches page. They remove two server stalls around model loads: the ~19 s freeze while a vision model loads, and the ~0.8 s pause on the first request after a load.*
37|
38|## [2.3] — 2026-10-19
39|
40|- **macOS `say` is now a TTS engine.** A VOICES tab lists every
41|  system voice, folded by language, with quality tiers; downloadable
42|  voices are marked and install from there. Mark a preferred voice
43|  per language, or let bare `say` work the language out from the
44|  text.
45|- **TTS settings restructured.** "TTS & Voices" opens on TEXT TO
46|  SPEECH; each engine is a card with its voices wired under it, and
47|  a model's VOICES chip jumps to its cloned voices.
48|- **Reading replies aloud got real controls.** Play, pause, progress,
49|  re-record — pause stops where you left and resumes from that
50|  second. With auto-speak, every chunk gets a numbered row with a
51|  waveform and the highlight follows the voice.
52|- **Voice recognition is steadier.** The last sentence always arrives
53|  when you stop talking; whisper large-class models avoid a broken
54|  transport; the LISTEN noise floor calibrates itself. A new
55|  optional patch runs Qwen3-ASR live: utterances commit in about a
56|  second.
57|- **Audio shows on the dashboard.** Speaking and listening activity
58|  rides the stats feed as it happens.
59|- **The chat page sits still.** One-line top bar, no more whole-page
60|  scroll, voice picker and Auto merged into one "Speak" row; a saved
61|  preset stays selectable beside your edited copy, so reverting no
62|  longer means deleting.
63|- **Patch zones cleaned up.** Two exclusive zones, rebuild chips
64|  classified by actual content, dev kegs take runtime overlays
65|  without a rebuild.
66|- Small touches: install no longer hangs on a probe, `patch status`
67|  reads like a human wrote it, per-bubble SPEAK follows the chunk
68|  strategy, a stale voice no longer blanks the picker.
69|
70|## [2.2] — 2026-10-18
71|
72|- **Profiles now remember what you were editing.** Change the prompt or
73|  any setting while a profile is selected and the picker reads
74|  `Profile (modified)` — the unsaved copy lives **on that profile**.
75|  Switching between profiles no longer overwrites in-progress work
76|  (the old design had one anonymous stash slot for everyone), coming
77|  back finds your edits where you left them, and they survive a
78|  reload. Delete on a modified row reverts to the saved profile; Save
79|  keeps suggesting its original name.
80|- The anonymous "Modified (unsaved)" row is gone from profile flows —
81|  it appears only for a chat never saved under any profile. Existing
82|  conversations migrate their pending edits onto their selected
83|  profile automatically.
84|
85|## [2.1] — 2026-10-18
86|
87|- **The chat got a voice and ears.** Replies read themselves aloud
88|  while streaming (gapless chunked TTS — sentence / line / paragraph),
89|  and push-to-talk plus continuous hands-free listening ride a live
90|  speech-recognition stream — echo-guarded and decoupled from the chat
91|  model. STT model, language and auto-send live in the Voice input
92|  settings.
93|- **Whole-page presets.** A profile stores and restores the prompt,
94|  thinking, sampling, web search and voice — everything settable on the
95|  page except the model you talk to. Edits surface as
96|  'Profile (modified)', Save suggests the original name (keep it to
97|  update, type a new one to create), Delete reverts unsaved changes or
98|  removes the preset — and nothing is lost silently: a page you switch
99|  away from is stashed.
100|- **The chat was rebuilt classic-style:** histories left, settings
101|  right, model and preset on top; the voice-settings popover stays
102|  visible and follows scroll.
103|- **Request Inspector** decodes prompts even after the model was
104|  unloaded (tokenizer from disk); the Activity card gained a per-model
105|  Unload button.
106|- **Bench:** harness runs carry per-question records (raw downloads),
107|  the thinking checkbox reaches the server, and two more FAST Czech
108|  suites joined.
109|- Small touches: voice references in mp3/flac transcode to WAV at
110|  save, the streaming reader cuts at sentence boundaries, the chat
111|  picker lists text models only, and classic multi-line profiles are
112|  no longer falsely marked modified.
113|
114|## [2.0] — 2026-10-15
115|
116|- **The board stopped fighting itself.** An open dashboard tab no longer
117|  pins a CPU core or freezes requests: stats build off the event loop,
118|  ride a live stream instead of timers, and charts fetch only new
119|  points — ~5 % of a core instead of a full one.
120|- **Decision bench scores any chat model** via the new upstream
121|  /v1/decisions readout, with a forced-choice "System One" answer
122|  policy; every row carries the path that produced it.
123|- **Nine more suites in a collapsed "Additional suites" section**
124|  (IFEval, BBH, Czech MMLU-ProX-Lite, hellaswag, winogrande, mathqa,
125|  TruthfulQA, KMMLU, CMMLU) — the classic grid stays pure and
126|  TruthfulQA measures truthfulness again.
127|- **Benches are easier to run:** all seven surfaces in the menu, one
128|  clear progress bar, a global queue instead of a rejection, honest
129|  ms/question labels, raw rows downloadable.
130|- **Voices: record the reference clip in the tab**, with a per-language
131|  read-aloud suggestion and a free-form language field.
132|- **Synced to upstream 0.7.1** — model settings keep saving; one SAVE
133|  now commits base + all profile tabs; bench envs rebuild clean.
134|
135|## [1.99b] — 2026-10-11
136|
137|The voice release.
138|
139|- **Named voice cloning.** Save a reference clip + transcript as a
140|  named voice on the new Voices page, preview it before saving, edit
141|  it later or save a copy onto another TTS model. A local
142|  speech-recognition model can transcribe the clip for you. Chat got a
143|  read-aloud button on every assistant reply with a voice picker that
144|  remembers your choice.
145|- **Voices from any audio client.** A standard OpenAI-shaped endpoint
146|  (`/uplift/v1/audio/speech`, works with the official SDK as-is). Any
147|  speech route accepts `Model:Voice` — e.g. `Qwen3-TTS:Jake` — so a
148|  stored voice is one field away from any client, on any TTS model.
149|- **Voice calls cannot hang forever** — a 240 s watchdog ends a stuck
150|  request with an honest message.
151|- **Tabbed settings.** The model editor and the server settings page
152|  now split their long forms into tabs (with dirty-count badges); tab
153|  colors derive from the active skin.
154|- **Profile drift is shown before it bites** — `(= base)` tags and a
155|  request-divergence preview with one-click sync.
156|- **Small touches:** "Download queued" no longer locks the download
157|  button.
158|
159|## [1.4] — 2026-10-11
160|
161|The measurement-honesty release: the dashboard shows what is really
162|happening, and hides nothing that happened before.
163|
164|- **MTP acceptance metrics.** Native Lightning MTP stats that vanilla
165|  only printed at sequence finish are now collected and graphed: an
166|  'MTP accepted tgs' area under the Throughput generation line, and
167|  one acceptance card with the per-depth decay ladder. The card's
168|  headline reads the same number as the ladder's top edge.
169|- **Embedding work counts in Throughput (EMBED-1).** Embedding and
170|  reranker models ran on a path the chart never watched; they now have
171|  their own series.
172|- **Charts hold still when data goes stale.** No more sliding the
173|  window left with an empty hole; the 'value holds, then pops into
174|  place' delay on 5-second cards is fixed at the root.
175|- **Metric history survives upgrades.** Rows from previous sessions
176|  and old kegs are visible again; only live co-tenant writers are
177|  filtered.
178|- **Faster, smoother live feed.** The 2 Hz sampler is deadline-
179|  scheduled; backgrounded tabs paint instantly on return; a
180|  'Smoothing:' select on the Throughput chart; click any card title to
181|  pop the graph out full-size.
182|- **Honest settings and patch workflow.** Non-LLM models no longer
183|  show ~47 LLM settings that their engines ignore; a patch touching
184|  the Homebrew formula is held with an explanation instead of showing
185|  APPLIED while doing nothing; dashboard rebuilds stream their log
186|  live; stored patch versions remember the base they tested against.
187|- **Small touches:** the Request feed is now a popup with 2 h default
188|  history (stale 'queued' rows are repaired at open), legends fit
189|  inside cards, card titles fit one line, Escape closes layout edit
190|  mode, default skin is Discovery One, the throughput bench lets you
191|  pick generation length (tg128–1024).
192|
193|## [1.3] — 2026-10-09
194|
195|The patch-workflow release. The CLI can now drive the whole patch lifecycle
196|without a browser, dev builds route around merged-but-moved upstream PRs
197|instead of wedging, and the model cards lead with the name and tell the
198|build truth.
199|
200|- **The CLI knows the whole patch lifecycle now.** `patch approve ID` is a