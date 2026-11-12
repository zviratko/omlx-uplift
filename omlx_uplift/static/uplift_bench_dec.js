/* SPLIT-3: Bench > Decision panel (REPL-4c): pack picker, run, SSE
   progress and the score table for the System-1 decision engine.
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).dec = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, dom = CORE.dom, errText = CORE.errText, api = CORE.api,
    t = CORE.t, el = CORE.el, busyLabel = CORE.busyLabel,
    labeled = CORE.labeled, gid = CORE.gid, taskCard = CORE.taskCard,
    loadingNote = CORE.loadingNote,
    streamInterrupted = CORE.streamInterrupted,
    statusLine = CORE.statusLine, setBar = CORE.setBar, fmtMs = CORE.fmtMs,
    msPerItem = CORE.msPerItem, buildTableText = CORE.buildTableText,
    thHelp = CORE.thHelp, resultsHead = CORE.resultsHead,
    stopStream = CORE.stopStream;

/* ---- REPL-4c: decision / System-1 (scored server-side, /v1/systemone) ----
   Same thin-host doctrine as MTEB: the pinned pack list comes from
   /bench/decision/tasks (provenance + counts from the manifest), the run
   executes in the server against the decision engine, this panel draws
   state and streams events. Scores: accuracy on the choice leg, Brier +
   ECE on the DERIVED noul legs, agreement = same text after an option
   re-order (position-bias), ms/question latency class. null = not
   computable (shown as —, never 0). */
var DEC_LIMITS = [0, 25, 50, 100];
function fmt4(v) { return v == null ? '\u2014' : Number(v).toFixed(4); }

/* DEC-API marker: a run scored through /v1/decisions (any chat model) rather
   than the native decision heads. CHOSEN FORM = a ' (decisions)' suffix on
   the Model text, NOT a new 'Scoring' column: a column needs a 10th header
   key, shifts every existing column, and repeats one of two values down the
   whole table for a native-only run set. The suffix rides on the Model cell
   and on the Model column of the Copy / Markdown / CSV exports, so a pasted
   table still says which endpoint produced the number.
   Contract: rows gain path:'native'|'generic'|'forced'; rows written before
   the feature have NO path (engine:'systemone') and must render untouched,
   so missing path = native. engine:'decisions' is accepted as a marker when
   path is absent (a row can only reach that engine via the generic path).
   FORCED-1: path:'forced' rows were scored with the /v1/systemone chat
   semantics (decide floor OFF) — a DIFFERENT MEASURAND (forced guess, never
   an abstention), so they carry their own ' (forced)' marker; they must
   never be mixed into gated averages (the server keeps them as their own
   rows, the label keeps humans honest). */
function decModelCell(r) {
    var id = String((r && r.model_id) || '');
    var path = r && r.path;
    if (path === 'forced') return id + ' (forced)';
    var generic = path ? path === 'generic'
                       : !!(r && r.engine === 'decisions');
    return generic ? id + ' (decisions)' : id;
}

var DEC = {
    state: null,

    render: function (panel) {
        this.state = { running: false, runId: null, packs: {},
                       selected: {}, limit: 0, results: [],
                       groups: null, modeEls: null };
        panel.appendChild(this.form());
        var status = statusLine('bench-dec-status');
        var results = el('div', 'bench-results'); results.id = 'bench-dec-results';
        panel.append(status, results);
        this.loadModels();
        this.loadTasks();
        this.refreshResults();
        this.discover();
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('uplift.bench.decision', 'Decision')));
        f.appendChild(el('p', 'native-stub-note', t('uplift.bench.decision_desc',
            'Typed questions over /v1/systemone; a pinned offline task pack.')));
        var row = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-dec-model';
        var ph = el('option', null, t('bench.config.model_placeholder', 'Select model…'));
        ph.value = ''; modelSel.appendChild(ph);
        var limSel = el('select'); limSel.id = 'bench-dec-limit';
        DEC_LIMITS.forEach(function (n) {
            var o = el('option', null, n === 0
                ? t('acc_bench.results.text_export.full', 'Full')
                : n.toLocaleString());
            o.value = String(n);
            if (n === 25) o.selected = true;
            limSel.appendChild(o);
        });
        // FORCED-1: answer policy. 'gated' is the historical /v1/decisions
        // behaviour (refusals stay honest nulls) and the DEFAULT; 'forced'
        // mirrors the /v1/systemone chat branch (upstream 5833533: the
        // letter-mass floor off, the model can never abstain). It measures
        // a DIFFERENT thing — the row marker and the hint say so. Wired
        // live by _syncMode: native models never see it enabled, and the
        // forced option stays disabled with the server's reason until the
        // keg carries decide(require_answer=...).
        var modeSel = el('select'); modeSel.id = 'bench-dec-mode';
        var modeG = el('option', null,
            t('uplift.bench.dec.mode_gated', 'Quality-gated (may refuse)'));
        modeG.value = 'gated';
        var modeF = el('option', null,
            t('uplift.bench.dec.mode_forced', 'Forced choice (must pick)'));
        modeF.value = 'forced'; modeF.disabled = true;
        modeSel.append(modeG, modeF);
        modeSel.disabled = true;   // until a chat model is selected
        this.state.modeEls = { sel: modeSel, gated: modeG, forced: modeF };
        row.append(labeled(t('bench.config.model', 'Model'), modelSel),
                   labeled(t('uplift.bench.sample_limit', 'Sample limit'), limSel),
                   labeled(t('uplift.bench.dec.mode_label', 'Answer policy'), modeSel));
        modelSel.addEventListener('change', function () { self._syncMode(); });
        f.appendChild(row);
        // U49: pack grid caption (same classic key as the other panels)
        f.appendChild(el('div', 'bench-label acc-grid-label',
            t('acc_bench.config.benchmarks', 'Benchmarks')));
        var grid = el('div', 'acc-taskgrid'); grid.id = 'bench-dec-tasks';
        f.appendChild(grid);
        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn primary', t('bench.config.run_button', 'Run'));
        runBtn.type = 'button'; runBtn.id = 'bench-dec-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-dec-cancel';
        cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        var clearBtn = el('button', 'btn', t('acc_bench.results.clear', 'Clear Results'));
        clearBtn.type = 'button'; clearBtn.id = 'bench-dec-clear';
        clearBtn.addEventListener('click', function () { self.clearResults(); });
        actions.append(runBtn, cancelBtn, clearBtn);
        f.appendChild(actions);
        return f;
    },

    /* DEC model picker (design brief D): ONE select, TWO optgroups —
       'Decision models' (native /v1/systemone decision heads) and 'Other
       models' (any chat model scored through /v1/decisions). The GROUPS come
       from the server (`/bench/decision/models`): only the server can probe
       whether this omlx build exposes /v1/decisions, so the client no longer
       guesses on engine_type. /models is still fetched — it is the row source
       for the native group (membership keeps the ids the manager actually
       has) and carries the display rows/flags. Order inside both groups is
       the SERVER's id order, never a client sort.
       Degrade honestly: if the groups endpoint fails (pre-feature server),
       fall back to the previous single-group behaviour so the panel never
       bricks. If the server says the generic path is unavailable, the 'Other
       models' group stays visible with every option disabled plus a leading
       disabled note — a greyed group that explains itself beats a silent
       omission. When the path IS available but no chat model is installed,
       the empty group is dropped: there is nothing to show and nothing to
       apologise for. */
    loadModels: async function () {
        var d = dom();
        var sel = gid('bench-dec-model');
        if (!sel || !d) return;
        // one bad row must not leave the picker half-built: the whole fill
        // is guarded exactly like the pre-feature version (silently keeps the
        // placeholder; start() surfaces the real error)
        try {
            var both = await Promise.all([
                d.fetchJson(api() + '/models').catch(function () { return null; }),
                d.fetchJson(api() + '/bench/decision/models')
                    .catch(function () { return null; }),
            ]);
            var rows = ((both[0] && both[0].models) || []);
            // null-proto: a model id like 'toString' must not read as installed
            var present = Object.create(null);
            rows.forEach(function (m) {
                var id = String((m && (m.id || m.model_id)) || '');
                if (id) present[id] = m;
            });
            var ph2 = el('option', null,
                t('bench.config.model_placeholder', 'Select model…'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            var mk = function (label, disabled) {
                var o = el('option', null, label);
                o.value = label;
                if (disabled) o.disabled = true;
                return o;
            };
            var g = both[1];
            if (!g || !Array.isArray(g.native)) {
                // legacy single group (the behaviour before the path split)
                rows.filter(function (m) {
                    return (m.engine_type || m.model_type) === 'decision';
                }).forEach(function (m) {
                    sel.appendChild(mk(String(m.id || m.model_id || '')));
                });
                return;
            }
            var nat = el('optgroup');
            nat.label = t('uplift.bench.dec_group_native', 'Decision models');
            (g.native || []).forEach(function (id) {
                if (present[id]) nat.appendChild(mk(String(id)));
            });
            // same rule as below: an empty group labels nothing, so skip it
            if (nat.children.length) sel.appendChild(nat);
            var available = !!g.generic_available;
            var other = el('optgroup');
            other.label = t('uplift.bench.dec_group_generic', 'Other models');
            if (!available) {
                // capability-honest note, FIRST in the group (see brief D)
                other.appendChild(mk(t('uplift.bench.dec_generic_needs_newer',
                    'Other models need /v1/decisions — update omlx'), true));
            }
            (g.generic || []).forEach(function (id) {
                other.appendChild(mk(String(id), !available));
            });
            if (!available || other.children.length) sel.appendChild(other);
            // FORCED-1: remember the SERVER's answer for the mode control
            // (membership + both capability flags) and re-sync it. NOTE
            // `this` — loadModels has no self-alias (loadTasks does).
            this.state.groups = g;
            this._syncMode();
        } catch (e) { /* start surfaces errors */ }
    },

    /* FORCED-1: one place decides the Answer-policy control's truth:
       - only a model the SERVER listed as generic (chat/VLM) enables it
       - the 'forced' option needs groups.forced_available (decide()'s
         require_answer kwarg on this keg, 5833533); the server's reason
         rides in the title so the disabled option explains itself
       - losing either condition while forced is selected snaps back to
         'gated' — a stale selection must never start a run the server
         would refuse. */
    _syncMode: function () {
        var els = this.state && this.state.modeEls;
        if (!els) return;
        var g = this.state.groups || {};
        var mid = String((gid('bench-dec-model') || {}).value || '');
        var isChat = (g.generic || []).indexOf(mid) >= 0;
        var canForce = isChat && !!g.forced_available;
        els.sel.disabled = !isChat;
        els.forced.disabled = !canForce;
        if (els.sel.value === 'forced' && !canForce) els.sel.value = 'gated';
        var hint = t('uplift.bench.dec.mode_hint',
            'Forced choice mirrors /v1/systemone chat semantics: the model '
            + 'never abstains, so accuracy measures the quality of a forced '
            + 'guess and is not comparable with quality-gated runs.');
        els.sel.title = (isChat && !canForce && g.forced_reason)
            ? g.forced_reason : hint;
    },

    loadTasks: async function () {
        var d = dom();
        var self = this;
        var g0 = gid('bench-dec-tasks');
        if (g0) g0.replaceChildren(loadingNote());
        try {
            var p = await d.fetchJson(api() + '/bench/decision/tasks');
            this.state.packs = p.tasks || {};
            var grid = gid('bench-dec-tasks');
            if (!grid) return;
            grid.replaceChildren();
            Object.keys(this.state.packs).sort().forEach(function (name) {
                var m = self.state.packs[name];
                var packKey = 'uplift.bench.pack.' + name.replace(/-/g, '_');
                var card = taskCard(
                    t(packKey, name),
                    (m.items || 0).toLocaleString() + ' · ' + (m.license || ''),
                    String(m.source || ''),
                    function (on) { self.state.selected[name] = on; },
                    { l: packKey });
                grid.appendChild(card);
            });
        } catch (e) {
            self.renderStatus('⚠ ' + errText(e));
        }
    },

    start: async function () {
        var d = dom();
        var model = (gid('bench-dec-model') || {}).value || '';
        var packs = Object.keys(this.state.selected)
            .filter(function (k) { return this.state.selected[k]; }, this)
            // U-ORDER: stable queue order — selection order depended on the
            // order the user clicked the cards, so two identical runs posted
            // different packs arrays (and different progress text)
            .sort();
        if (!model) {
            d.toast(t('bench.config.model_placeholder', 'Select model…'), 'error');
            return;
        }
        if (!packs.length) {
            d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
            return;
        }
        var limSel = gid('bench-dec-limit');
        this.state.limit = Number((limSel || {}).value || 0);
        // FORCED-1: mode travels in the body; 'gated' is sent EXPLICITLY so
        // a queued replay carries the same answer policy the user chose
        // (a queue entry is replayed verbatim; the server default must
        // never silently upgrade a gated choice into a forced run).
        var modeSel = gid('bench-dec-mode');
        var mode = (modeSel && !modeSel.disabled
                    && modeSel.value === 'forced') ? 'forced' : 'gated';
        var rel = busyLabel(gid('bench-dec-run'));
        try {
            var r = await d.postJson(api() + '/bench/decision/start',
                { model_id: model, packs: packs, limit: this.state.limit,
                  mode: mode });
            rel();
            // BENCHQ: busy server => queued behind the live run. The Run
            // button stays enabled precisely so this click was legal.
            if (CORE.BENCHQ.isQueued(r)) { CORE.BENCHQ.note(); return; }
            this.state.running = true;
            this.state.runId = r.run_id;
            this.setButtons();
            this.startStream(r.run_id);
        } catch (e) {
            rel();
            d.toast(errText(e), 'error');
        }
    },

    cancel: async function () {
        var d = dom();
        if (!this.state.runId) return;
        try { await d.postJson(api() + '/bench/decision/'
            + encodeURIComponent(this.state.runId) + '/cancel', {}); }
        catch (e) { d.toast(errText(e), 'error'); }
    },

    clearResults: async function () {
        var d = dom();
        try {
            await d.postJson(api() + '/bench/decision/results/reset', {});
            this.refreshResults();
        } catch (e) { d.toast(errText(e), 'error'); }
    },

    discover: async function () {
        var d = dom();
        try {
            var a = await d.fetchJson(api() + '/bench/decision/active');
            if (a && a.running) {
                this.state.running = true;
                this.state.runId = a.run_id;
                this.setButtons();
                // U-PROG2: progress is known the moment the page re-attaches
                // to a live run — packs done/total drive the bar immediately
                // (SSE events refine it from there).
                var total = ((a.packs || []).length) || 0;
                var done = Number(a.done || 0);
                if (total) {
                    this.renderStatus(String(a.model_id || ''));
                    setBar('bench-dec-status', done / total * 100,
                        done + '/' + total + ' packs');
                }
                this.startStream(a.run_id);
            }
        } catch (e) { /* idle */ }
    },

    refreshResults: async function () {
        var d = dom();
        try {
            var p = await d.fetchJson(api() + '/bench/decision/results');
            this.state.results = p.results || [];
            this.renderResults();
        } catch (e) { /* keep last view */ }
    },

    startStream: function (runId) {
        var self = this;
        stopStream();
        if (!W().EventSource) return;
        try {
            CORE._es = new EventSource(api() + '/bench/decision/'
                + encodeURIComponent(runId) + '/stream');
            CORE._es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            CORE._es.onerror = function () { streamInterrupted('bench-dec-status'); };
        } catch (e) { /* polling fallback omitted: short runs, results refresh covers */ }
    },

    onEvent: function (ev) {
        if (ev.type === 'progress') {
            // engine messages already carry the counts ("pack (1/3)",
            // "pack: 20/294") — appending (current+1/total) here would
            // print them twice (caught in the live UI drill); the bar
            // (U-PROG) tracks the whole queue from the same counters
            if (ev.total) setBar('bench-dec-status',
                Math.min(100, (Number(ev.current) || 0) / ev.total * 100));
            this.renderStatus(ev.message || ev.phase || '');
        } else if (ev.type === 'result') {
            this.state.results.push(ev.data);
            this.renderResults();
        } else if (ev.type === 'done') {
            this.state.running = false; this.state.runId = null;
            this.setButtons(); stopStream();
            setBar('bench-dec-status', 100);
            this.renderStatus(t('uplift.bench.run_finished', 'Finished'));
            this.refreshResults();
        } else if (ev.type === 'error') {
            this.state.running = false; this.state.runId = null;
            this.setButtons(); stopStream();
            this.renderStatus('⚠ ' + (ev.message || 'error'));
            this.refreshResults();
        }
    },

    setButtons: function () {
        var c = gid('bench-dec-cancel');
        // BENCHQ (user item 6): Run stays ENABLED during a live run — a
        // second click queues this model/pack set behind the first instead
        // of being refused. Only Cancel is state-dependent.
        if (c) c.hidden = !this.state.running;
    },

    renderStatus: function (s) {
        var n = gid('bench-dec-status');
        if (n) n.textContent = s;
    },

    renderResults: function () {
        var wrap = gid('bench-dec-results');
        if (!wrap) return;
        var rows = this.state.results.slice().reverse();
        if (!rows.length) { wrap.replaceChildren(); return; }
        var tbl = el('table', 'bench-table');
        var head = el('tr');
        // U-TERM: the metric columns carry a '?' explainer marker (thHelp);
        // Model / Benchmarks / the timestamp column are self-evident.
        head.appendChild(el('th', null, t('bench.config.model', 'Model')));
        head.appendChild(el('th', null, t('acc_bench.config.benchmarks', 'Benchmarks')));
        head.appendChild(thHelp(t('uplift.bench.dec_accuracy', 'Accuracy'),
            'uplift.bench.help.accuracy',
            'Share of questions where the model picked the correct option text.'));
        head.appendChild(thHelp(t('uplift.bench.dec_brier', 'Brier'),
            'uplift.bench.help.brier',
            'Brier score: mean squared error between the probability the '
            + 'model states and the truth (0 = perfect). Lower is better.'));
        head.appendChild(thHelp(t('uplift.bench.dec_ece', 'ECE'),
            'uplift.bench.help.ece',
            'Expected Calibration Error: the gap between stated confidence '
            + 'and actual hit rate, grouped into 10 probability buckets '
            + '(0 = perfect). Lower is better.'));
        head.appendChild(thHelp(t('uplift.bench.dec_agreement', 'Agreement'),
            'uplift.bench.help.agreement',
            'Position-bias check: the same question is asked twice with the '
            + 'options re-ordered. 1.0000 means the model picks the same '
            + 'answer text both times.'));
        head.appendChild(thHelp(t('uplift.bench.dec_latency', 'ms/question'),
            'uplift.bench.help.ms_question',
            'Average wall time per question (run time divided by samples). '
            + 'Each question runs several internal probes; see the ms/probe '
            + 'column in the exports.'));
        head.appendChild(thHelp(t('uplift.bench.dec_time', 'Time (s)'),
            'uplift.bench.help.time',
            'Total wall time of this benchmark run.'));
        head.appendChild(thHelp(t('uplift.bench.samples', 'Samples'),
            'uplift.bench.help.samples',
            'Number of questions scored in this run.'));
        head.appendChild(el('th', null, ''));
        tbl.appendChild(head);
        var fmt = function (v) { return v == null ? '—' : Number(v).toFixed(4); };
        rows.forEach(function (r) {
            var tr = el('tr');
            var packName = r.pack || '';
            tr.append(
                el('td', null, decModelCell(r)),
                el('td', null, t('uplift.bench.pack.' + packName.replace(/-/g, '_'), packName)),
                el('td', null, fmt(r.accuracy)),
                el('td', null, fmt(r.brier)),
                el('td', null, fmt(r.ece)),
                el('td', null, fmt(r.agreement)),
                el('td', null, fmtMs(msPerItem(r))),
                el('td', null, r.time_s != null
                    ? Number(r.time_s).toFixed(1) : '—'),
                el('td', null, r.items != null
                    ? Number(r.items).toLocaleString() : '—'),
                el('td', null, r.ts ? new Date(r.ts * 1000).toLocaleString() : ''));
            tbl.appendChild(tr);
        });
        // U49: shared Copy helper over the decision rows (MTEB pattern)
        var selfD = this;
        wrap.replaceChildren(
            resultsHead(function () {
                return buildTableText(
                    [t('uplift.bench.decision', 'Decision'), ''],
                    // DEC-API: the Model column carries the ' (decisions)'
                    // marker so a copied table says which endpoint scored it
                    [{ label: 'Model', get: function (r) { return decModelCell(r); } },
                     { label: 'Benchmark', get: function (r) { return String(r.pack || ''); } },
                     { label: 'Accuracy', numeric: true, get: function (r) { return fmt4(r.accuracy); } },
                     { label: 'Brier', numeric: true, get: function (r) { return fmt4(r.brier); } },
                     { label: 'ECE', numeric: true, get: function (r) { return fmt4(r.ece); } },
                     { label: 'Agreement', numeric: true, get: function (r) { return fmt4(r.agreement); } },
                     { label: 'ms/question', numeric: true, get: function (r) {
                         return fmtMs(msPerItem(r)); } },
                     // U-LAT: the probe-level number (ms_per_question divides
                     // by the engine's internal re-ordered probes, ~4 per
                     // item) stays available where the jargon belongs
                     { label: 'ms/probe', numeric: true, get: function (r) {
                         return fmtMs(r.ms_per_question); } },
                     { label: 'Time (s)', numeric: true, get: function (r) {
                         return r.time_s != null
                             ? Number(r.time_s).toFixed(1) : '—'; } },
                     { label: 'Samples', numeric: true, get: function (r) {
                         return r.items != null
                             ? Number(r.items).toLocaleString() : '—'; } }],
                    selfD.state.results.slice().reverse());
            }, null, null, {
                name: function () {
                    // U-CPY: name from the newest result when the selector
                    // was reset between runs — 'uplift_decision_run' told
                    // the user nothing (download drill 2026-10-13)
                    var rows = selfD.state.results;
                    var m = rows.length ? rows[rows.length - 1].model_id : '';
                    if (!m) {
                        var mSel = gid('bench-dec-model');
                        m = mSel && mSel.value;
                    }
                    return 'uplift_decision_' + String(m || 'run');
                },
                rows: function () { return selfD.state.results.slice().reverse(); },
                cols: function () { return [
                    { head: 'Model', get: function (r) { return decModelCell(r); } },
                    { head: 'Benchmark', get: function (r) { return r.pack || ''; } },
                    { head: 'Accuracy', get: function (r) { return r.accuracy; } },
                    { head: 'Brier', get: function (r) { return r.brier; } },
                    { head: 'ECE', get: function (r) { return r.ece; } },
                    { head: 'Agreement', get: function (r) { return r.agreement; } },
                    { head: 'ms/question', get: function (r) { return msPerItem(r); } },
                    { head: 'ms/probe', get: function (r) { return r.ms_per_question; } },
                    { head: 'Time (s)', get: function (r) { return r.time_s; } },
                    { head: 'Samples', get: function (r) { return r.items; } },
                ]; },
            }),
            tbl);
    },
};

return {
    DEC: DEC
};
});
