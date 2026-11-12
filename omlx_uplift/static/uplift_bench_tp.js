/* SPLIT-3: Bench > Throughput panel (REPL-1): the classic throughput
   run (prompt lengths, batch sizes, generation length), SSE progress,
   results and history, plus the prefill probe block inside its form
   (custom prefill length, parallelism, staggered starts).
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).tp = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, dom = CORE.dom, errText = CORE.errText, api = CORE.api,
    t = CORE.t, ta = CORE.ta, benchGpuWatts = CORE.benchGpuWatts,
    gpuNoteText = CORE.gpuNoteText, el = CORE.el,
    busyLabel = CORE.busyLabel, labeled = CORE.labeled, check = CORE.check,
    checkI18n = CORE.checkI18n, gid = CORE.gid,
    streamInterrupted = CORE.streamInterrupted,
    statusLine = CORE.statusLine, setBar = CORE.setBar,
    advancedSection = CORE.advancedSection, checkedVals = CORE.checkedVals,
    fmtNum = CORE.fmtNum, fmtMemory = CORE.fmtMemory,
    buildThroughputText = CORE.buildThroughputText,
    simpleTable = CORE.simpleTable, loadHistory = CORE.loadHistory,
    resultsHead = CORE.resultsHead, tpTip = CORE.tpTip,
    tpDlCols = CORE.tpDlCols, buildTpTables = CORE.buildTpTables,
    tpHistoryBody = CORE.tpHistoryBody, stopStream = CORE.stopStream;

/* ==========================================================================
   PREFILL PROBE (user item 4) — 'longer or custom prefill length, custom
   parallelism with longer prefills (with an option to stagger their
   starts)'. An UPLIFT-NATIVE lane, by necessity: classic's BenchmarkRequest
   validates prompt lengths against VALID_PROMPT_LENGTHS and batch sizes
   against [2,4,8], its batch test pins pp1024 and submits every request at
   once — so none of the three asks can go through /bench/start without
   editing vanilla. The server side is omlx_uplift/bench_prefill.py, which
   reuses classic's prompt builder, engine seam (add_request/stream_outputs)
   and metric math but owns its own run registry, and the routes are the
   /bench/prefill/* pair. Nothing here touches the vanilla chips, the
   classic payload or /bench/start: a standard run stays byte-identical.
   ========================================================================== */

// Mirrors of the server's bounds (omlx_uplift/bench_prefill.py). The UI
// must never offer what the runner rejects, so these two numbers are one
// contract read from both ends — change them together.
var PF_MIN_TOKENS = 1024;       // MIN_PREFILL_TOKENS — floor, NO ceiling
var PF_MAX_PARALLEL = 256;      // MAX_PARALLEL (typo guard, not a product cap)
var _pfEs = null, _pfPoll = null;

function gid0(field) { return field ? field.children[1] : null; }

function pfStop() {
    if (_pfEs) { try { _pfEs.close(); } catch (_) {} _pfEs = null; }
    if (_pfPoll) { clearInterval(_pfPoll); _pfPoll = null; }
}

// One numbered input of the probe form. No `max` on the length field: the
// server has no ceiling there (only the model's own context window, and the
// probe fails loudly when the engine cuts a prompt short).
function pfNum(id, label, value, min, max, step, ph) {
    var inp = el('input');
    inp.type = 'number'; inp.id = id;
    inp.value = String(value);
    if (min != null) inp.min = String(min);
    if (max != null) inp.max = String(max);
    inp.step = String(step == null ? 1 : step);
    if (ph) {
        inp.placeholder = ph.s;
        inp.dataset.i18nPh = ph.k;
        inp.dataset.enPh = ph.en;
    }
    var w = labeled(label.s, inp);
    var lab = w.children[0];
    lab.dataset.i18n = label.k;            // painted once, re-resolved when
    lab.dataset.en = label.en;             // the catalog lands late (U59)
    return w;
}

/* Pure collector/validator: raw form strings in, request body or an i18n
   error out. Separate from PF.start so a node harness can prove the client
   bounds match the server's WITHOUT a DOM round-trip. */
function pfBody(raw) {
    raw = raw || {};
    var pp = Number(raw.prefill_tokens), par = Number(raw.parallel);
    var st = (raw.stagger_seconds === '' || raw.stagger_seconds == null)
        ? 0 : Number(raw.stagger_seconds);
    var tg = Number(raw.generation_tokens);
    function bad(label) { return { ok: false, key: label.k, en: label.en,
                                   msg: label.s }; }
    if (!raw.model_id)
        return bad(ta('bench.config.model_placeholder', 'Select model\u2026'));
    if (!Number.isInteger(pp) || pp < PF_MIN_TOKENS)
        return bad(ta('uplift.bench.prefill.bad_tokens',
            'Prefill length must be a whole number of at least 1,024 tokens.'));
    if (!Number.isInteger(par) || par < 1 || par > PF_MAX_PARALLEL)
        return bad(ta('uplift.bench.prefill.bad_parallel',
            'Parallel requests must be a whole number between 1 and 256.'));
    if (!(st >= 0))     // NaN-safe: a blank or garbage stagger is refused
        return bad(ta('uplift.bench.prefill.bad_stagger',
            'Stagger must be a number of seconds, 0 or more.'));
    if (!Number.isInteger(tg) || tg < 1)
        return bad(ta('uplift.bench.prefill.bad_generation',
            'Generation tokens must be a whole number of at least 1.'));
    return { ok: true, body: {
        model_id: raw.model_id,
        prefill_tokens: pp,
        parallel: par,
        stagger_seconds: st,
        generation_tokens: tg,
        context_profile: raw.context_profile || 'code_python',
    } };
}

var PF = {
    state: null,
    tp: null,                 // the panel this block lives in (set by block())
    refs: null,               // the block's own elements (UP-57: no gid race)

    ensure: function () {
        if (!this.state) this.state = { running: false, runId: null,
                                        rows: [], aggregate: null, total: 0,
                                        reqState: {}, error: false };
        if (!this.state.reqState) this.state.reqState = {};
        return this.state;
    },

    // ---- paint ----------------------------------------------------------
    block: function (tp) {
        this.tp = tp;
        var self = this;
        this.ensure();
        var wrap = el('div', 'bench-prefill card'); wrap.id = 'bench-tp-prefill';

        var h = el('h3', 'bench-tp-section');
        var hl = el('span', 'bench-label',
            t('uplift.bench.prefill.section', 'Advanced prefill and parallelism'));
        hl.dataset.i18n = 'uplift.bench.prefill.section';
        hl.dataset.en = 'Advanced prefill and parallelism';
        h.appendChild(hl);
        wrap.appendChild(h);

        // The honest scope line — see PF.sync for the external-mode relabel.
        var hint = el('p', 'native-stub-note'); hint.id = 'bench-tp-pf-hint';
        wrap.appendChild(hint);
        this._hint = hint;

        var row = el('div', 'bench-row');
        var f1 = pfNum('bench-tp-pf-pp',
            ta('uplift.bench.prefill.tokens', 'Prefill tokens'),
            8192, PF_MIN_TOKENS, null, 1,
            ta('uplift.bench.prefill.tokens_ph', 'at least 1,024'));
        var f2 = pfNum('bench-tp-pf-parallel',
            ta('uplift.bench.prefill.parallel', 'Parallel requests'),
            4, 1, PF_MAX_PARALLEL, 1);
        row.append(f1, f2);
        var row2 = el('div', 'bench-row');
        var f3 = pfNum('bench-tp-pf-stagger',
            ta('uplift.bench.prefill.stagger', 'Stagger between starts (s)'),
            0, 0, null, 0.05);
        var f4 = pfNum('bench-tp-pf-tg',
            ta('uplift.bench.prefill.generation', 'Generation tokens'),
            32, 1, null, 1);
        row2.append(f3, f4);
        wrap.append(row, row2);

        var acts = el('div', 'bench-actions');
        var runBtn = el('button', 'btn',
            t('uplift.bench.prefill.run', 'Start custom benchmark'));
        runBtn.type = 'button'; runBtn.id = 'bench-tp-pf-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-tp-pf-cancel';
        cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        acts.append(runBtn, cancelBtn);
        wrap.appendChild(acts);

        // OWN results host: probe rows never mix into classic's two tables,
        // and the panel keeps exactly ONE progress bar (the shared
        // bench-tp-status box) for whichever run is live.
        var results = el('div', 'bench-results'); results.id = 'bench-tp-pf-results';
        wrap.appendChild(results);

        // UP-57 doctrine: the form is NOT in the document yet while it is
        // being built, so every wiring point here holds ELEMENT REFERENCES —
        // a gid() lookup at this moment returns nothing in a real browser
        // (and auto-creates a stray node in the test stub).
        this.refs = { pp: gid0(f1), parallel: gid0(f2), stagger: gid0(f3),
                      tg: gid0(f4), hint: hint, run: runBtn, cancel: cancelBtn,
                      results: results };
        // paint state, don't assume idle: a panel re-render while a probe
        // runs must come back with the controls already dead (setButtons
        // runs sync() internally)
        this.setButtons();
        return wrap;
    },

    // External-endpoint mode: this probe measures THIS machine's engine, so
    // the whole block dies with the cache-off knobs (same syncCacheOff path,
    // same 'local only' relabel contract).
    sync: function (extOn) {
        var s = this.ensure();
        var r = this.refs || {};
        var ids = ['pp', 'parallel', 'stagger', 'tg'];
        for (var i = 0; i < ids.length; i++) {
            // reference first, gid as the panel-rebuilt fallback
            var e = r[ids[i]] || gid('bench-tp-pf-' + ids[i]);
            if (e) e.disabled = !!extOn || s.running;
        }
        var btn = r.run || gid('bench-tp-pf-run');
        if (btn && !s.running) btn.disabled = !!extOn;
        var hint = r.hint || this._hint || gid('bench-tp-pf-hint');
        if (!hint) return;
        if (extOn) {
            hint.textContent = t('uplift.bench.prefill.local_only',
                'Local models only: this benchmark measures the engine '
                + 'running in this server, not a remote endpoint.');
            hint.dataset.i18n = 'uplift.bench.prefill.local_only';
            hint.dataset.en = 'Local models only: this benchmark measures '
                + 'the engine running in this server, not a remote endpoint.';
        } else {
            hint.textContent = t('uplift.bench.prefill.hint',
                'Custom prompt sizes, request counts and start timing, '
                + 'measured outside the standard benchmark. The run ignores '
                + 'the server\'s concurrency limit while it is in flight and '
                + 'restores it when it ends. It refuses to start while '
                + 'another benchmark holds the engine; a benchmark started '
                + 'from the classic admin page during a custom benchmark is '
                + 'not blocked, and both results would be wrong.');
            hint.dataset.i18n = 'uplift.bench.prefill.hint';
            hint.dataset.en = 'Custom prompt sizes, request counts and start '
                + 'timing, measured outside the standard benchmark. The run '
                + 'ignores the server\'s concurrency limit while it is in '
                + 'flight and restores it when it ends. It refuses to start '
                + 'while another benchmark holds the engine; a benchmark '
                + 'started from the classic admin page during a custom '
                + 'benchmark is not blocked, and both results would be '
                + 'wrong.';
        }
    },

    collect: function () {
        var r = this.refs || {};
        function val(key, id) {
            var e = r[key] || gid(id);
            return e ? e.value : '';
        }
        return {
            model_id: val(null, 'bench-tp-model'),
            context_profile: (gid('bench-tp-profile') || {}).value || 'code_python',
            prefill_tokens: val('pp', 'bench-tp-pf-pp'),
            parallel: val('parallel', 'bench-tp-pf-parallel'),
            stagger_seconds: val('stagger', 'bench-tp-pf-stagger'),
            generation_tokens: val('tg', 'bench-tp-pf-tg'),
        };
    },

    start: async function () {
        var d = dom();
        var s = this.ensure();
        var r = pfBody(this.collect());
        if (!r.ok) { d.toast(r.msg, 'error'); return; }   // pfBody resolved it
        if (this.tp && this.tp.state && this.tp.state.running) {
            d.toast(t('uplift.bench.prefill.panel_busy',
                'The standard benchmark is running in this panel.'), 'error');
            return;
        }
        s.running = true; s.rows = []; s.aggregate = null; s.error = false;
        s.reqState = {};
        s.total = r.body.parallel;
        this.setButtons();
        var host = gid('bench-tp-pf-results');
        if (host) host.replaceChildren();
        var rel = busyLabel(gid('bench-tp-pf-run'));
        try {
            var out = await d.postJson(api() + '/bench/prefill/start', r.body);
            rel();
            s.runId = out.bench_id;
            this.stream(out.bench_id);
            setBar('bench-tp-status', 0);
            this.status(t('uplift.bench.prefill.preparing',
                'Preparing benchmark\u2026'));
        } catch (e) {
            rel();
            s.running = false;
            this.setButtons();
            d.toast(errText(e), 'error');
        }
    },

    stream: function (runId) {
        var self = this;
        pfStop();
        if (!W().EventSource) { this.poll(runId); return; }
        try {
            _pfEs = new EventSource(api() + '/bench/prefill/'
                + encodeURIComponent(runId) + '/stream');
            _pfEs.onmessage = function (ev) {
                var data;
                try { data = JSON.parse(ev.data); } catch (_) { return; }
                // a live event means the stream recovered: retire the
                // emergency poll the error handler may have armed
                if (_pfPoll) { clearInterval(_pfPoll); _pfPoll = null; }
                self.onEvent(data);
            };
            _pfEs.onerror = function () {
                // user report 2026-10-28: a dropped SSE (board restart,
                // network blip, laptop sleep) used to leave the panel frozen
                // at its last event while the wave ran on. Arm the 3 s REST
                // fallback instead - the wave keeps reporting.
                streamInterrupted('bench-tp-status');
                self.poll(runId);
            };
        } catch (e) { this.poll(runId); }
    },

    // Same 3s REST fallback the throughput panel uses when EventSource is
    // unavailable (and the path every node harness exercises).
    poll: function (runId) {
        var self = this;
        var d = dom();
        if (_pfPoll) clearInterval(_pfPoll);
        _pfPoll = setInterval(async function () {
            try {
                var r = await d.fetchJson(api() + '/bench/prefill/'
                    + encodeURIComponent(runId) + '/results');
                self.state.rows = r.results || [];
                self.state.aggregate = r.aggregate || self.state.aggregate;
                if (r.requests) {
                    self.state.reqState = {};
                    r.requests.forEach(function (q) { self.state.reqState[q.index] = q; });
                }
                // poll mode drives the SAME bar and status line the SSE
                // mode gets from events, so a fallback run never looks dead
                var done = (r.results || []).length;
                setBar('bench-tp-status', (r.progress || 0) * 100,
                    done + '/' + (self.state.total || done));
                if (r.message) self.status(r.message);
                self.render();
                if (r.status !== 'running') self.finish(r.status === 'error'
                    ? r.error : null);
            } catch (e) { /* keep polling */ }
        }, 3000);
    },

    onEvent: function (ev) {
        var s = this.ensure();
        if (ev.type === 'progress') {
            var pct = (ev.total ? (ev.current || 0) / ev.total : 0) * 100;
            setBar('bench-tp-status', pct,
                (ev.current || 0) + '/' + (ev.total || s.total));
            this.status(ev.message || ev.phase || '');
        } else if (ev.type === 'result') {
            // SSE replays the log after a reconnect: replace by identity
            var rows = s.rows, seen = false;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].index === ev.data.index) { rows[i] = ev.data; seen = true; break; }
            }
            if (!seen) rows.push(ev.data);
            this.render();
        } else if (ev.type === 'request') {
            // live per-request line (user Q3)
            s.reqState[ev.data.index] = ev.data;
            this.render();
        } else if (ev.type === 'aggregate') {
            s.aggregate = ev.data;
            this.render();
        } else if (ev.type === 'error') {
            this.finish(String(ev.message || 'error'));
        } else if (ev.type === 'done') {
            this.finish();
        }
    },

    status: function (msg, isError) {
        var st = gid('bench-tp-status');     // the panel's ONE status box
        if (!st) return;
        st.textContent = msg || '';
        st.classList.toggle('bench-status-error', !!isError);
    },

    setButtons: function () {
        var s = this.ensure();
        var r = this.refs || {};
        var runBtn = r.run || gid('bench-tp-pf-run');
        var cancelBtn = r.cancel || gid('bench-tp-pf-cancel');
        if (cancelBtn) cancelBtn.hidden = !s.running;
        if (runBtn) runBtn.disabled = s.running;
        this.sync(this.tp ? this.tp.isExternal() : false);
        // the classic Run button is disabled while a probe owns the engine —
        // but only when the vanilla run is not driving it itself
        var tpRun = gid('bench-tp-run');
        if (tpRun && !(this.tp && this.tp.state && this.tp.state.running))
            tpRun.disabled = s.running;
    },

    render: function () {
        var host = (this.refs && this.refs.results) || gid('bench-tp-pf-results');
        if (!host) return;
        var s = this.ensure();
        var live = this.reqNodes();          // one line per request, from t=0
        if (!s.rows.length && !s.aggregate) {
            host.replaceChildren.apply(host, live);   // container-clear only;
            return;                                   // strings via textContent
        }
        var kids = [];
        if (s.aggregate) kids = kids.concat(this.summaryNodes(s.aggregate));
        if (s.rows.length) {
            var head = el('div', 'bench-tp-section');
            var lab = el('span', 'bench-label',
                t('uplift.bench.prefill.per_request', 'Per request'));
            lab.dataset.i18n = 'uplift.bench.prefill.per_request';
            lab.dataset.en = 'Per request';
            head.appendChild(lab);
            kids.push(head);
            kids.push(simpleTable([
                ['index', '#', function (v) { return String(Number(v) + 1); }],
                ['submit_s', t('uplift.bench.prefill.col_start', 'Start (s)'),
                    // REAL leave-time (proves the stagger ran); older rows
                    // only carry the scheduled slot — print that instead
                    function (v, r) {
                        return fmtNum(v != null ? v : r.start_offset_s, 2);
                    }, null,
                    { k: 'uplift.bench.prefill.col_start', en: 'Start (s)' }],
                ['ttft_ms', t('uplift.bench.prefill.col_ttft', 'TTFT (ms)'),
                    function (v) { return fmtNum(v, 1); }, null,
                    { k: 'uplift.bench.prefill.col_ttft', en: 'TTFT (ms)' }],
                ['processing_tps', t('uplift.bench.prefill.col_prefill', 'Prefill (tok/s)'),
                    function (v) { return fmtNum(v, 1); }, null,
                    { k: 'uplift.bench.prefill.col_prefill', en: 'Prefill (tok/s)' }],
                ['gen_tps', t('uplift.bench.prefill.col_decode', 'Decode (tok/s)'),
                    function (v) { return fmtNum(v, 1); }, null,
                    { k: 'uplift.bench.prefill.col_decode', en: 'Decode (tok/s)' }],
                ['completion_tokens', t('uplift.bench.prefill.col_generated', 'Generated'),
                    function (v) { return v == null ? '\u2014' : String(v); }, null,
                    { k: 'uplift.bench.prefill.col_generated', en: 'Generated' }],
                ['e2e_latency_s', t('uplift.bench.prefill.col_e2e', 'Total (s)'),
                    function (v) { return fmtNum(v, 3); }, null,
                    { k: 'uplift.bench.prefill.col_e2e', en: 'Total (s)' }],
            ], s.rows.slice().sort(function (a, b) { return a.index - b.index; }),
                'tp-table'));
        }
        // while the wave is live the activity list rides under the table:
        // finished rows above, still-running requests in plain sight below
        if (s.running) kids = kids.concat(live);
        host.replaceChildren.apply(host, kids);
    },

    // One line per request (user Q3): '#k - phase - live detail'. Lines
    // exist from the moment START is pressed - the queue is visible while
    // the model loads, the prefill counts stream while it prefills.
    reqNodes: function () {
        var s = this.ensure();
        var n = s.total || 0;
        for (var k in s.reqState) {
            if (Number(k) + 1 > n) n = Number(k) + 1;
        }
        if (!n) return [];
        var out = [];
        var head = el('div', 'bench-tp-section');
        var lab = el('span', 'bench-label',
            t('uplift.bench.prefill.req_lines', 'Request activity'));
        lab.dataset.i18n = 'uplift.bench.prefill.req_lines';
        lab.dataset.en = 'Request activity';
        head.appendChild(lab);
        out.push(head);
        for (var i = 0; i < n; i++) {
            var q = s.reqState[i] || { phase: 'pending' };
            var word, detail = '';
            if (q.phase === 'pending') {
                word = t('uplift.bench.prefill.req_queued', 'Queued');
            } else if (q.phase === 'submitted') {
                word = t('uplift.bench.prefill.req_submitted', 'Submitted');
                if (q.submit_s != null) detail = ' +' + Number(q.submit_s).toFixed(2) + ' s';
            } else if (q.phase === 'prefilling') {
                word = t('uplift.bench.prefill.req_prefilling', 'Prefilling');
                detail = ' ' + Number(q.processed || 0).toLocaleString()
                    + '/' + Number(q.total || 0).toLocaleString();
            } else if (q.phase === 'generating') {
                word = t('uplift.bench.prefill.req_generating', 'Generating');
                detail = ' ' + Number(q.completion || 0) + ' tok';
            } else {
                word = t('uplift.bench.prefill.req_done', 'Done');
                detail = ' ' + Number(q.completion || 0) + ' tok';
            }
            var row = el('div', 'bench-pf-req');
            row.textContent = '#' + (i + 1) + ' \u00b7 ' + word + detail;
            out.push(row);
        }
        return out;
    },

    // The wave is what the user asked for (parallel + stagger), so it leads.
    // kv rows, not a table: one column of numbers with labels reads better
    // and reuses the context panel's row markup.
    summaryNodes: function (agg) {
        var pairs = [
            [ta('uplift.bench.prefill.sum_requests', 'Requests'),
                String(agg.requests)],
            [ta('uplift.bench.prefill.sum_prefill', 'Combined prefill (tok/s)'),
                fmtNum(agg.combined_prefill_tps, 1)],
            [ta('uplift.bench.prefill.sum_decode', 'Combined decode (tok/s)'),
                fmtNum(agg.combined_decode_tps, 1)],
            [ta('uplift.bench.prefill.sum_wall', 'Total wall time (s)'),
                fmtNum(agg.wall_time_s, 3)],
            [ta('uplift.bench.prefill.sum_ttft_avg', 'Average TTFT (ms)'),
                fmtNum(agg.avg_ttft_ms, 1)],
            [ta('uplift.bench.prefill.sum_ttft_max', 'Slowest TTFT (ms)'),
                fmtNum(agg.max_ttft_ms, 1)],
        ];
        // measured all-decoding rate (user Q2: the classic-style combined
        // number is comparable with classic; THIS is the wave's real decode)
        if (agg.steady_decode_tps != null) pairs.push(
            [ta('uplift.bench.prefill.sum_decode_steady',
                'Steady decode (tok/s)'),
                fmtNum(agg.steady_decode_tps, 1)
                + (agg.steady_streams_avg
                    ? ' \u00b7 ' + fmtNum(agg.steady_streams_avg, 1)
                      + ' streams' : '')]);
        var mem = agg.memory || {};
        if (mem.peak_gpu_bytes) pairs.push(
            [ta('uplift.bench.prefill.mem_gpu', 'Peak GPU memory'),
                fmtMemory(mem.peak_gpu_bytes)]);
        if (mem.peak_process_bytes) pairs.push(
            [ta('uplift.bench.prefill.mem_proc', 'Peak process memory'),
                fmtMemory(mem.peak_process_bytes)]);
        if (mem.guard_headroom_bytes) pairs.push(
            [ta('uplift.bench.prefill.mem_headroom',
                'Guard headroom at start'),
                fmtMemory(mem.guard_headroom_bytes)]);
        var out = [];
        var head = el('div', 'bench-tp-section');
        var lab = el('span', 'bench-label',
            t('uplift.bench.prefill.summary', 'Benchmark result'));
        lab.dataset.i18n = 'uplift.bench.prefill.summary';
        lab.dataset.en = 'Benchmark result';
        head.appendChild(lab);
        out.push(head);
        pairs.forEach(function (p) {
            var tr = el('div', 'bench-result-row');
            var l = el('span', 'bench-label', p[0].s);
            l.dataset.i18n = p[0].k;
            l.dataset.en = p[0].en;           // U59: late catalog repair
            tr.append(l, el('span', null, p[1]));
            out.push(tr);
        });
        return out;
    },

    finish: function (errorMessage) {
        pfStop();
        var s = this.ensure();
        s.running = false;
        this.setButtons();
        if (errorMessage) {
            s.error = true;
            this.status(String(errorMessage), true);
            return;
        }
        setBar('bench-tp-status', 100);
        var st = gid('bench-tp-status');
        if (st) {
            st.textContent = (st.textContent ? st.textContent + ' \u2014 ' : '')
                + t('uplift.bench.run_finished', 'Finished');
        }
    },

    cancel: async function () {
        var s = this.ensure();
        if (!s.runId) return;
        var d = dom();
        try {
            await d.postJson(api() + '/bench/prefill/'
                + encodeURIComponent(s.runId) + '/cancel', {});
        } catch (e) { d.toast(errText(e), 'error'); }
    },

    // Reattach after a reload: the panel shows a running probe the same way
    // it shows a running benchmark (TP.discover calls this).
    discover: async function () {
        var d = dom();
        try {
            var a = await d.fetchJson(api() + '/bench/prefill/active');
            if (!a || !a.running) return;
            var s = this.ensure();
            s.running = true; s.runId = a.bench_id; s.total = a.parallel || 0;
            this.setButtons();
            this.stream(a.bench_id);
            this.status(t('uplift.bench.prefill.already_running',
                'A custom benchmark is already running in this server.')
                + ' (' + a.model_id + ')');
        } catch (e) { /* idle is fine */ }
    },
};

var TP = {
    state: null,

    render: function (panel) {
        this.state = { active: null, results: [], total: 0, current: 0,
                       phase: '', running: false, benchId: null,
                       // U47: run context for the text export (classic prints
                       // model/engine/context above the tables)
                       ctx: { model: '', profile: 'code_python',
                              forceLm: false, external: null } };
        panel.appendChild(this.form());
        var status = statusLine('bench-tp-status');
        var results = el('div', 'bench-results'); results.id = 'bench-tp-results';
        var history = el('div', 'bench-results'); history.id = 'bench-tp-history';
        panel.append(status, results, history);
        this.loadModels();
        this.discover();
        PF.discover();   // the prefill lane has its own registry to reattach to
        this.loadHist();
    },

    loadHist: function () {
        var self = this;
        return loadHistory('throughput', 'bench-tp-history', tpHistoryBody,
            self.state && self.state.benchId);
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('bench.heading', 'Performance Benchmark')));

        var row1 = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-tp-model';
        var ph = el('option', null, t('bench.config.model_placeholder', 'Select model…')); ph.value = ''; modelSel.appendChild(ph);
        var profSel = el('select'); profSel.id = 'bench-tp-profile';
        CORE.PROFILES.forEach(function (p) {
            var o = el('option', null, t('bench.config.context.' + p, CORE.PROFILE_FALLBACK[p]));
            o.value = p;
            profSel.appendChild(o);
        });
        row1.append(labeled(t('bench.config.model', 'Model'), modelSel),
                    labeled(t('bench.config.context_profile', 'Benchmark Context'), profSel));
        // UP-56 (classic _bench.html): a stored GPU cap on the picked model
        // does not apply while the bench runs — amber-line note, hidden for
        // the external endpoint (classic's !benchExternalEnabled condition)
        var tpGpuNote = el('p', 'native-stub-note'); tpGpuNote.hidden = true;
        function syncGpuNote() {
            var w = self.isExternal() ? 0
                : benchGpuWatts(self.state && self.state.modelRows, modelSel.value);
            tpGpuNote.hidden = !w;
            if (w) tpGpuNote.textContent = gpuNoteText(w);
        }
        self._syncGpuNote = syncGpuNote;
        // bind to the element reference, NOT gid+rAF: this panel's legacy
        // rAF callback can fire BEFORE f lands in the DOM (async view
        // mount), so gid misses and the listener is never attached —
        // pre-existing dead-wiring bug, ticketed as UP-57, not widened here
        modelSel.addEventListener('change', syncGpuNote);

        var row2 = el('div', 'bench-row');
        var ppBox = el('div', 'bench-chips'); ppBox.id = 'bench-tp-pp';
        CORE.PROMPT_LENGTHS.forEach(function (pp) {
            var lb = el('label', 'chip');
            var cb = el('input'); cb.type = 'checkbox'; cb.value = String(pp);
            if (pp === 1024 || pp === 4096) cb.checked = true;
            lb.append(cb, document.createTextNode(' pp' + pp.toLocaleString()));
            ppBox.appendChild(lb);
        });
        var genBox = el('div', 'bench-chips'); genBox.id = 'bench-tp-gen';
        CORE.GEN_LENGTHS.forEach(function (tg, i) {
            var lb = el('label', 'chip');
            var rb = el('input'); rb.type = 'radio'; rb.name = 'bench-tp-gen';
            rb.value = String(tg);
            if (i === 0) rb.checked = true;
            lb.append(rb, document.createTextNode(' tg' + tg));
            genBox.appendChild(lb);
        });
        row2.append(labeled(t('bench.config.single_request', 'Single Request Tests'), ppBox),
                    labeled(t('uplift.bench.generation_length', 'Generation length'), genBox));

        var row3 = el('div', 'bench-row');
        var bsBox = el('div', 'bench-chips'); bsBox.id = 'bench-tp-bs';
        CORE.BATCH_SIZES.forEach(function (bs) {
            var lb = el('label', 'chip');
            var cb = el('input'); cb.type = 'checkbox'; cb.value = String(bs);
            lb.append(cb, document.createTextNode(' ' + bs + '×'));
            bsBox.appendChild(lb);
        });
        var extRow = el('div', 'bench-row bench-external');
        extRow.id = 'bench-tp-ext-row'; extRow.hidden = true;
        var eurl = el('input'); eurl.id = 'bench-tp-ext-url'; eurl.placeholder = t('bench.config.external_base_url', 'Base URL');
        var ekey = el('input'); ekey.id = 'bench-tp-ext-key'; ekey.type = 'password'; ekey.placeholder = t('bench.config.external_api_key', 'API key');
        var emod = el('input'); emod.id = 'bench-tp-ext-model'; emod.placeholder = t('bench.config.external_model', 'Model');
        extRow.append(labeled(t('bench.config.external_base_url', 'Base URL'), eurl),
                      labeled(t('bench.config.external_api_key', 'API key'), ekey),
                      labeled(t('bench.config.external_model', 'Model'), emod));

        // U48: full-width section; external inputs live INSIDE it now (the
        // old form kept the toggle in the details but rendered its inputs
        // at form level — the 'visible while you were not looking' half of
        // the defect)
        // TG-OPT: the classic batch hint is static ('…/ tg128'); make it
        // track the chosen generation length so the form can't lie. All 10
        // locales carry the 'tg128' token in this string — replace is a
        // no-op if a future locale does not.
        var batchHint = el('p', 'native-stub-note', t('bench.config.batch_hint', 'Batch tests use pp1024 / tg128'));
        // CACHE-OFF (user item 3, client half): per-run cache overrides, off
        // by default and rebuilt unchecked on every panel render. The hints
        // are title attributes (the row is a chip-sized label, no room for a
        // second line), and the pair is DEAD for external endpoints — the
        // caches being disabled live in this process, so an external run has
        // nothing to turn off.
        var noHot = checkI18n('bench-tp-no-hot',
            'uplift.bench.tp.no_hot_cache', 'Hot cache off for this run');
        var noSsd = checkI18n('bench-tp-no-ssd',
            'uplift.bench.tp.no_ssd_cache', 'SSD cache off for this run');
        var HINTS = [
            ['uplift.bench.tp.no_hot_cache_hint',
             'Sets the in-memory Hot Cache limit to 0 while this benchmark '
             + 'runs, then restores your setting. Loaded models are reloaded '
             + 'at run start and finish.'],
            ['uplift.bench.tp.no_ssd_cache_hint',
             'Enables Hot Cache Only (no SSD reads, writes or background '
             + 'writer) while this benchmark runs, then restores your '
             + 'setting. Loaded models are reloaded at run start and finish.'],
        ];
        var LOCAL_TIP = ['uplift.bench.tp.cache_off_local',
                         'Applies to local models only.'];
        var cacheRows = [[noHot, HINTS[0]], [noSsd, HINTS[1]]];
        cacheRows.forEach(function (row) {
            row[0].title = tpTip(row[1][0], row[1][1]);
            row[0].dataset.i18nTitle = row[1][0];
            row[0].dataset.enTitle = row[1][1];
        });
        // The hint and the 'local only' note share ONE slot: whatever the
        // row says right now is what its title carries, and the datasets
        // follow so a late catalog load repaints the CURRENT meaning.
        function syncCacheOff() {
            var extOn = self.isExternal();
            for (var i = 0; i < cacheRows.length; i++) {
                var lb = cacheRows[i][0], hint = cacheRows[i][1];
                var key = extOn ? LOCAL_TIP[0] : hint[0];
                var en = extOn ? LOCAL_TIP[1] : hint[1];
                lb.input.disabled = extOn;
                if (extOn) lb.input.checked = false;    // a dead knob is off
                lb.title = extOn ? t(key, en) : tpTip(key, en);
                lb.dataset.i18nTitle = key;
                lb.dataset.enTitle = en;
            }
            // PREFILL (user item 4): the probe measures THIS engine, so the
            // external toggle kills the whole block — same rule, same sync
            // path, same 'local only' relabel contract.
            PF.sync(extOn);
            syncGpuNote();   // UP-56: the note rides the same model/ext moves
        }
        syncCacheOff();
        var adv = advancedSection([
            check('bench-tp-ane', t('bench.config.ane_aligned_prompt', 'ANE-aligned prompts (+1 token)'), false),
            check('bench-tp-lm', t('bench.config.force_lm_engine', 'Force mlx-lm engine'), false),
            noHot, noSsd,
            (function () {
                // CACHE-OFF: the toggle must react the moment it flips.
                // UP-57: BOTH behaviours (row reveal + knob sync) bind to
                // the element reference — the legacy gid()+rAF block
                // attached nothing when the rAF fired before this panel
                // landed in the DOM (async view mount), leaving external
                // mode unable to reveal its inputs.
                var lb = check('bench-tp-ext',
                    t('bench.config.external', 'Use external OpenAI API endpoint'), false);
                lb.input.addEventListener('change', function () {
                    extRow.hidden = !lb.input.checked;
                    syncCacheOff();     // CACHE-OFF: the knobs die with the mode
                });
                return lb;
            })(),
            extRow,
            check('bench-tp-upload', t('uplift.bench.upload_results', 'Upload results to community leaderboard'), false),
            el('p', 'native-stub-note', t('uplift.bench.upload_hint',
                'Off by default: a native run never posts to omlx.ai unless you check this.')),
            batchHint]);
        row3.append(labeled(t('bench.config.batch_tests', 'Continuous Batching Tests'), bsBox));

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn primary', t('bench.config.run_button', 'Run Benchmark'));
        runBtn.type = 'button'; runBtn.id = 'bench-tp-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-tp-cancel'; cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        actions.append(runBtn, cancelBtn);

        // PREFILL (user item 4): a clearly separated sub-block BETWEEN the
        // classic options and the actions row — the standard controls above
        // are untouched and still post the classic payload.
        f.append(row1, tpGpuNote, row2, row3, adv, PF.block(self), actions);
        // UP-57: gen-hint and model→cache-off sync bind to the elements
        // directly; the ext-row reveal moved into the checkbox's own
        // reference-bound listener above. The whole gid()+rAF block died
        // silently whenever the rAF beat the async mount.
        genBox.addEventListener('change', function (ev) {
            if (ev.target && ev.target.checked && batchHint)
                batchHint.textContent = t('bench.config.batch_hint',
                    'Batch tests use pp1024 / tg128')
                    .replace('tg128', 'tg' + Number(ev.target.value).toLocaleString());
        });
        modelSel.addEventListener('change', syncCacheOff);
        return f;
    },

    // CACHE-OFF (user item 3): an external endpoint has no local cache to
    // turn off, so the pair is for local models only. The ext checkbox IS
    // the panel's external-endpoint mode (the classic mirror — there is no
    // endpoint row inside the model picker).
    isExternal: function () {
        var ext = gid('bench-tp-ext');
        return !!(ext && ext.checked);
    },

    loadModels: async function () {
        var d = dom();
        try {
            var data = await d.fetchJson(api() + '/models');
            var sel = gid('bench-tp-model');
            if (!sel) return;
            var rows = (data && data.models) || [];
            var usable = rows.filter(function (m) {
                var type = m.model_type || m.type;
                return !type || type === 'llm' || type === 'vlm';
            });
            var ph2 = el('option', null, t('bench.config.model_placeholder', 'Select model…'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) {
                sel.appendChild(el('option', null, m.id || m.model_id));
            });
            // UP-56: the cap note reads the model rows, like classic's
            // benchGpuPowerLimit(this.models.find(...))
            if (!this.state) this.state = {};
            this.state.modelRows = usable;
            if (this._syncGpuNote) this._syncGpuNote();
        } catch (e) { /* list stays placeholder; start() will surface errors */ }
    },

    discover: async function () {
        var d = dom();
        try {
            var a = await d.fetchJson(api() + '/bench/active');
            if (a && a.running) {
                this.state.running = true;
                this.state.active = a;
                this.state.benchId = a.bench_id;
                if (a.model_id) {   // U47: reattach keeps the export context
                    this.state.ctx = { model: a.model_id,
                        profile: a.context_profile || 'code_python',
                        forceLm: !!a.force_lm_engine,
                        external: a.external ? { model: a.model_id } : null };
                }
                this.setButtons();
                this.startStream(a.bench_id);
                this.renderStatus(t('bench.other_active.already_running',
                    'Another throughput benchmark is already running in this server.') +
                    ' (' + a.model_id + ')');
            }
        } catch (e) { /* idle is fine */ }
    },

    collect: function () {
        var genSel = gid('bench-tp-gen') ? gid('bench-tp-gen').querySelector('input:checked') : null;
        var body = {
            model_id: gid('bench-tp-model') ? gid('bench-tp-model').value : '',
            prompt_lengths: checkedVals(gid('bench-tp-pp')),
            generation_length: genSel ? Number(genSel.value) : 128,
            batch_sizes: checkedVals(gid('bench-tp-bs')),
            context_profile: gid('bench-tp-profile') ? gid('bench-tp-profile').value : 'code_python',
            warmup_mode: 'quick',
            align_prompt_to_ane: !!(gid('bench-tp-ane') && gid('bench-tp-ane').checked),
            force_lm_engine: !!(gid('bench-tp-lm') && gid('bench-tp-lm').checked),
            upload: !!(gid('bench-tp-upload') && gid('bench-tp-upload').checked),
        };
        var ext = gid('bench-tp-ext');
        if (ext && ext.checked) {
            body.external = {
                base_url: (gid('bench-tp-ext-url') || {}).value || '',
                api_key: (gid('bench-tp-ext-key') || {}).value || '',
                model: (gid('bench-tp-ext-model') || {}).value || '',
            };
        }
        // CACHE-OFF (server lane contract): the keys exist ONLY when the box
        // is on — an absent field is 'leave my setting alone', a false one
        // would be a command. External runs never carry them (the knobs are
        // disabled+cleared, and the caches are process-local).
        if (!body.external) {
            if (gid('bench-tp-no-hot') && gid('bench-tp-no-hot').checked)
                body.no_hot_cache = true;
            if (gid('bench-tp-no-ssd') && gid('bench-tp-no-ssd').checked)
                body.no_ssd_cache = true;
        }
        return body;
    },

    start: async function () {
        var d = dom();
        var body = this.collect();
        if (!body.external && !body.model_id) {
            d.toast(t('bench.config.model_placeholder', 'Select model…'), 'error');
            return;
        }
        if (!body.prompt_lengths.length) {
            d.toast(t('uplift.bench.pick_prompt', 'Pick at least one prompt length'), 'error');
            return;
        }
        this.state.running = true;
        this.state.results = [];
        this.state.ctx = {   // U47: what the text export will label the run
            model: body.model_id, profile: body.context_profile,
            forceLm: !!body.force_lm_engine,
            external: body.external ? { model: body.external.model } : null };
        this.setButtons();
        var rw = gid('bench-tp-results');
        if (rw) rw.replaceChildren();
        var rel = busyLabel(gid('bench-tp-run'));
        try {
            var out = await d.postJson(api() + '/bench/start', body);
            rel();
            // BENCHQ: a busy server queued the run instead of starting it —
            // no running state, no EventSource on a qid that has not begun.
            if (CORE.BENCHQ.isQueued(out)) {
                this.state.running = false;
                this.state.benchId = null;
                this.setButtons();
                CORE.BENCHQ.note();
                return;
            }
            this.state.benchId = out.bench_id;
            this.startStream(out.bench_id);
            setBar('bench-tp-status', 0);   // U-PROG: new run, bar starts empty
            this.renderStatus(t('bench.progress.preparing', 'Preparing…'));
        } catch (e) {
            rel();
            this.state.running = false;
            this.setButtons();
            d.toast(errText(e), 'error');
        }
    },

    cancel: async function () {
        if (!this.state.benchId) return;
        var d = dom();
        try {
            await d.postJson(api() + '/bench/' + encodeURIComponent(this.state.benchId) + '/cancel', {});
        } catch (e) { d.toast(errText(e), 'error'); }
    },

    setButtons: function () {
        var runBtn = gid('bench-tp-run'), cancelBtn = gid('bench-tp-cancel');
        if (runBtn) runBtn.disabled = this.state.running;
        if (cancelBtn) cancelBtn.hidden = !this.state.running;
    },

    startStream: function (benchId) {
        var self = this;
        stopStream();
        if (!W().EventSource) { this.fallbackPoll(benchId); return; }
        try {
            CORE._es = new EventSource(api() + '/bench/' + encodeURIComponent(benchId) + '/stream');
            CORE._es.onmessage = function (ev) {
                var data;
                try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            CORE._es.onerror = function () { streamInterrupted('bench-tp-status'); };
        } catch (e) { this.fallbackPoll(benchId); }
    },

    fallbackPoll: function (benchId) {
        var self = this;
        var d = dom();
        if (CORE._poll) clearInterval(CORE._poll);
        CORE._poll = setInterval(async function () {
            try {
                var r = await d.fetchJson(api() + '/bench/' + encodeURIComponent(benchId) + '/results');
                self.state.results = r.results || [];
                self.renderTable();
                if (r.status !== 'running') self.finish();
            } catch (e) { /* keep polling */ }
        }, 3000);
    },

    onEvent: function (ev) {
        var s = this.state;
        if (ev.type === 'progress') {
            s.phase = ev.phase || s.phase;
            if (ev.current != null) s.current = ev.current;
            if (ev.total != null) s.total = ev.total;
            if (s.total) setBar('bench-tp-status', s.current / s.total * 100);
            this.renderStatus((ev.message || ev.phase || '') +
                (s.total ? '  (' + s.current + '/' + s.total + ')' : ''));
        } else if (ev.type === 'result') {
            // SSE replays the whole log after every reconnect: replace by
            // identity instead of appending, so rerenders stay idempotent.
            var key = function (r) { return [r.test_type, r.pp, r.tg, r.batch_size].join('/'); };
            var k = key(ev.data);
            var found = false;
            for (var i = 0; i < s.results.length; i++) {
                if (key(s.results[i]) === k) { s.results[i] = ev.data; found = true; break; }
            }
            if (!found) s.results.push(ev.data);
            this.renderTable();
        } else if (ev.type === 'error') {
            this.renderStatus(String(ev.message || 'error'), true);
            this.finish();
        } else if (ev.type === 'upload_done') {
            if (ev.data && ev.data.error) {
                this.renderStatus(t('uplift.bench.upload_failed', 'Upload failed') + ': ' + ev.data.error, true);
            }
            this.finish();
        } else if (ev.type === 'upload_skipped') {
            this.finish();
        }
        // 'done' is only the tests→upload boundary in classic's stream; the
        // real terminal events are upload_done/upload_skipped/error above.
    },

    renderStatus: function (msg, isError) {
        var st = gid('bench-tp-status');
        if (!st) return;
        st.textContent = msg || '';
        st.classList.toggle('bench-status-error', !!isError);
    },

    renderTable: function () {
        var wrap = gid('bench-tp-results');
        if (!wrap) return;
        var rows = this.state.results;
        if (!rows.length) { wrap.replaceChildren(); return; }
        var self = this;
        // U47/classic parity: the same Copy head, then classic's TWO tables
        // (buildTpTables is also what the history cards paint, so live and
        // history can never disagree)
        var kids = [resultsHead(function () {
            return buildThroughputText(self.state.ctx, self.state.results);
        }, null, null, {
            name: function () { return 'uplift_throughput_'
                + String((self.state.ctx && self.state.ctx.model) || 'run'); },
            rows: function () { return self.state.results; },
            cols: function () { return tpDlCols(self.state.results); },
        })];
        buildTpTables(rows).forEach(function (n) { kids.push(n); });
        wrap.replaceChildren.apply(wrap, kids);
    },

    // TP.fmt is gone with the merged table: every cell now formats through
    // the classic helpers (fmtNum / fmtMemory / outCell), so a table value
    // and its Copy-text twin can never disagree again.

    finish: function () {
        stopStream();
        this.state.running = false;
        this.setButtons();
        this.loadHist();   // U64: the run is in history now — show it
        var st = gid('bench-tp-status');
        if (st && !st.classList.contains('bench-status-error')) {
            setBar('bench-tp-status', 100);   // U-PROG: run complete
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'Finished');
        }
    },
};

return {
    PF_MIN_TOKENS: PF_MIN_TOKENS,
    PF_MAX_PARALLEL: PF_MAX_PARALLEL,
    pfBody: pfBody,
    PF: PF,
    TP: TP
};
});
