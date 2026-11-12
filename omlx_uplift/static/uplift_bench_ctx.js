/* SPLIT-3: Bench > Context panel (REPL-3): context-window probe with
   SSE progress, results and history.
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).ctx = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, dom = CORE.dom, errText = CORE.errText, api = CORE.api,
    t = CORE.t, ctxTargetOptions = CORE.ctxTargetOptions,
    benchGpuWatts = CORE.benchGpuWatts, gpuNoteText = CORE.gpuNoteText,
    el = CORE.el, busyLabel = CORE.busyLabel, labeled = CORE.labeled,
    gid = CORE.gid, streamInterrupted = CORE.streamInterrupted,
    statusLine = CORE.statusLine, setBar = CORE.setBar,
    ctxResultPairs = CORE.ctxResultPairs,
    buildTableText = CORE.buildTableText,
    historyEmptyNote = CORE.historyEmptyNote,
    loadHistory = CORE.loadHistory, resultsHead = CORE.resultsHead,
    stopStream = CORE.stopStream;

/* ==========================================================================
   CONTEXT probe (REPL-3) — classic context_benchmark over /uplift/api/
   bench/context/*. SSE progress like throughput; the classic runner
   APPLIES the measured window to model settings itself (mirror keeps
   that auto-apply honest — the warning label is classic's own).
   ========================================================================== */

function ctxHistoryBody(e) {
    var card = el('div', 'bench-result card');
    var rows = e.rows || [];
    if (!rows.length) {
        card.appendChild(historyEmptyNote());
        return card;
    }
    var r = rows[rows.length - 1];   // one result per context run
    var kv = ctxResultPairs(CTX.state && CTX.state.models, r);
    kv.forEach(function (pair) {
        var tr = el('div', 'bench-result-row');
        tr.append(el('span', 'bench-label', pair[0]), el('span', null, pair[1]));
        card.appendChild(tr);
    });
    card.prepend(resultsHead(function () {
        return buildTableText([t('ctx_bench.heading', 'Context Benchmark'), ''],
            [{ label: 'Field', get: function (pr) { return pr[0]; } },
             { label: 'Value', get: function (pr) { return pr[1]; } }], kv);
    }));
    return card;
}

var CTX = {
    state: null,

    render: function (panel) {
        this.state = { running: false, benchId: null, result: null, models: [] };
        panel.appendChild(this.form());
        var status = statusLine('bench-ctx-status');
        var results = el('div', 'bench-results'); results.id = 'bench-ctx-results';
        var history = el('div', 'bench-results'); history.id = 'bench-ctx-history';
        panel.append(status, results, history);
        this.loadModels();
        this.discover();
        this.loadHist();
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('ctx_bench.heading', 'Context Benchmark')));
        f.appendChild(el('p', 'native-stub-note', t('ctx_bench.description',
            'Measure the largest context window this machine can actually prefill for a model. The result is written into the model’s Context Window setting.')));

        var row = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-ctx-model';
        var ph = el('option', null, t('ctx_bench.config.model_placeholder', 'Select a model...'));
        ph.value = ''; modelSel.appendChild(ph);
        var targetSel = el('select'); targetSel.id = 'bench-ctx-target';
        var customWrap = el('div', 'bench-ctx-custom'); customWrap.hidden = true;
        customWrap.id = 'bench-ctx-custom-wrap';   // gid-reachable (test stubs
        var customInp = el('input'); customInp.type = 'number';
        customInp.id = 'bench-ctx-target-custom';
        customInp.min = String(CORE.CTX_CUSTOM_MIN);
        customInp.step = '1';
        customInp.placeholder = t('uplift.bench.ctx_custom_placeholder',
            'tokens (at least 2,048)');
        customWrap.appendChild(customInp);
        // U50: options rebuild per model (native config.json window first,
        // classic hide-above-native rule, Custom probe last)
        self.buildTargetOptions();
        modelSel.addEventListener('change', function () { self.buildTargetOptions(); });
        targetSel.addEventListener('change', function () {
            customWrap.hidden = targetSel.value !== 'custom';
        });
        row.append(labeled(t('ctx_bench.config.model', 'Model'), modelSel),
                   labeled(t('ctx_bench.config.target', 'Maximum context to test'), targetSel),
                   customWrap);
        f.appendChild(row);
        // UP-56 (classic _bench_context.html): stored GPU cap does not
        // apply to the context bench either — no external condition here
        var ctxGpuNote = el('p', 'native-stub-note'); ctxGpuNote.hidden = true;
        function syncCtxGpuNote() {
            var w = benchGpuWatts(self.state && self.state.models, modelSel.value);
            ctxGpuNote.hidden = !w;
            if (w) ctxGpuNote.textContent = gpuNoteText(w);
        }
        self._syncCtxGpuNote = syncCtxGpuNote;
        modelSel.addEventListener('change', syncCtxGpuNote);
        syncCtxGpuNote();
        f.appendChild(ctxGpuNote);
        f.appendChild(el('p', 'native-stub-note', t('ctx_bench.config.target_hint',
            'The benchmark searches up to this size. Larger targets take longer to verify.')));
        f.appendChild(el('p', 'native-stub-note', t('ctx_bench.warning.autoapply',
            'The measured value is applied to the model automatically.')));
        // U49: deliberately NO Advanced section here — the card says do
        // not invent an empty one, and there is nothing extra to fold:
        // model/target/custom-input are first-order and already labeled.

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn primary', t('ctx_bench.start', 'Start Benchmark'));
        runBtn.type = 'button'; runBtn.id = 'bench-ctx-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('ctx_bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-ctx-cancel'; cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        actions.append(runBtn, cancelBtn);
        f.appendChild(actions);
        return f;
    },

    // U50: rebuild the target list from the selected model's native window
    buildTargetOptions: function () {
        var sel = gid('bench-ctx-target');
        if (!sel) return;
        var mSel = gid('bench-ctx-model');
        var id = mSel ? mSel.value : '';
        var row = (this.state.models || []).filter(function (m) {
            return (m.id || m.model_id) === id; })[0];
        var native = row ? Number(row.model_context_length || 0) : 0;
        var opts = ctxTargetOptions(native);
        sel.replaceChildren();
        opts.forEach(function (o) {
            var e2 = el('option', null, o.custom
                ? t('uplift.bench.ctx_custom', 'Custom…') : o.label);
            e2.value = o.value;
            if (o.native) {
                e2.textContent = o.label + ' — ' + t('ctx_bench.capped.native',
                    "Model's native context length");
                e2.selected = true;
            }
            sel.appendChild(e2);
        });
        var cw = gid('bench-ctx-custom-wrap');
        if (cw) cw.hidden = true;
    },

    // U50: '' | number -> validated whole-number target, or null + toast
    resolveTargetTokens: function () {
        var d = dom();
        var sel = gid('bench-ctx-target');
        if (!sel) return null;
        if (sel.value !== 'custom') return Number(sel.value);
        var inp = gid('bench-ctx-target-custom');
        var v = inp ? Number(inp.value) : NaN;
        if (!isFinite(v) || v !== Math.floor(v) || v < CORE.CTX_CUSTOM_MIN) {
            d.toast(t('uplift.bench.ctx_custom_range',
                'Custom target must be a whole number of at least 2,048 tokens.'));
            return null;
        }
        return v;
    },

    loadModels: async function () {
        var d = dom();
        try {
            var data = await d.fetchJson(api() + '/models');
            var sel = gid('bench-ctx-model');
            if (!sel) return;
            var usable = ((data && data.models) || []).filter(function (m) {
                var ty = m.model_type || m.type;
                return !ty || ty === 'llm' || ty === 'vlm';
            });
            // U50: stash rows for the target builder (model_context_length
            // is classic's native window from config.json, served verbatim)
            this.state.models = usable;
            if (this._syncCtxGpuNote) this._syncCtxGpuNote();   // UP-56
            var ph2 = el('option', null, t('ctx_bench.config.model_placeholder', 'Select a model...'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) { sel.appendChild(el('option', null, m.id || m.model_id)); });
            this.buildTargetOptions();   // U50: native option needs the rows
        } catch (e) { /* placeholder stays */ }
    },

    discover: async function () {
        var d = dom();
        try {
            var a = await d.fetchJson(api() + '/bench/context/active');
            if (a && a.running) {
                this.state.running = true;
                this.state.benchId = a.bench_id;
                this.setButtons();
                this.startStream(a.bench_id);
                this.renderStatus(t('bench.other_active.already_running',
                    'Another throughput benchmark is already running in this server.') +
                    ' (' + a.model_id + ')');
            }
        } catch (e) { /* idle */ }
    },

    start: async function () {
        var d = dom();
        var sel = gid('bench-ctx-model');
        if (!sel || !sel.value) {
            d.toast(t('ctx_bench.config.model_placeholder', 'Select a model...'), 'error');
            return;
        }
        var target = this.resolveTargetTokens();   // U50: select or custom
        if (target == null) return;   // resolveTargetTokens toasted already
        this.state.running = true;
        this.state.result = null;
        this.setButtons();
        var rw = gid('bench-ctx-results');
        if (rw) rw.replaceChildren();
        var rel = busyLabel(gid('bench-ctx-run'));
        try {
            var out = await d.postJson(api() + '/bench/context/start', {
                model_id: sel.value,
                target_tokens: target,
            });
            rel();
            // BENCHQ: queued behind the live run — stay idle, the box shows it
            if (CORE.BENCHQ.isQueued(out)) {
                this.state.running = false;
                this.state.benchId = null;
                this.setButtons();
                CORE.BENCHQ.note();
                return;
            }
            this.state.benchId = out.bench_id;
            this.startStream(out.bench_id);
            this.renderStatus(t('ctx_bench.progress.starting', 'Starting...'));
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
            await d.postJson(api() + '/bench/context/' +
                encodeURIComponent(this.state.benchId) + '/cancel', {});
        } catch (e) { d.toast(errText(e), 'error'); }
    },

    setButtons: function () {
        var r = gid('bench-ctx-run'), c = gid('bench-ctx-cancel');
        if (r) r.disabled = this.state.running;
        if (c) c.hidden = !this.state.running;
    },

    startStream: function (benchId) {
        var self = this;
        stopStream();
        if (!W().EventSource) { this.poll(benchId); return; }
        try {
            CORE._es = new EventSource(api() + '/bench/context/' + encodeURIComponent(benchId) + '/stream');
            CORE._es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            CORE._es.onerror = function () { streamInterrupted('bench-ctx-status'); };
        } catch (e) { this.poll(benchId); }
    },

    poll: function (benchId) {
        var self = this;
        var d = dom();
        if (CORE._poll) clearInterval(CORE._poll);
        CORE._poll = setInterval(async function () {
            try {
                var r = await d.fetchJson(api() + '/bench/context/' + encodeURIComponent(benchId) + '/results');
                setBar('bench-ctx-status', r.progress || 0);
                self.renderStatus((r.message || r.phase || '') + ' ' +
                    Math.round(r.progress || 0) + '%');  // classic: 0-100 scale
                if (r.result) { self.state.result = r.result; self.renderResult(r.result); }
                if (r.status !== 'running') self.finish();
            } catch (e) { /* keep polling */ }
        }, 3000);
    },

    onEvent: function (ev) {
        if (ev.type === 'progress') {
            setBar('bench-ctx-status', ev.progress || 0);
            this.renderStatus((ev.message || ev.phase || '') + ' ' +
                Math.round(ev.progress || 0) + '%');  // classic: 0-100 scale
        } else if (ev.type === 'result') {
            this.state.result = ev.data;
            this.renderResult(ev.data);
        } else if (ev.type === 'error') {
            this.renderStatus(String(ev.message || 'error'), true);
            this.finish();
        }
        // context bench terminal events are done + error (classic code)
    },

    renderStatus: function (msg, isError) {
        var st = gid('bench-ctx-status');
        if (!st) return;
        st.textContent = msg || '';
        st.classList.toggle('bench-status-error', !!isError);
    },

    renderResult: function (r) {
        var wrap = gid('bench-ctx-results');
        if (!wrap) return;
        var card = el('div', 'bench-result card');
        this.state.result = r;   // U49: Copy survives reattach/re-render
        card.appendChild(el('h2', null, t('ctx_bench.result.section_label', 'Result')));
        var rows = [
            [t('ctx_bench.result.measured', 'Admission boundary'), (r.measured_tokens || 0).toLocaleString()],
            [t('ctx_bench.result.verified', 'Verified prefill'), (r.verified_tokens || 0).toLocaleString()],
            [t('ctx_bench.result.tokens_label', 'tokens applied to Context Window'), (r.applied_tokens || 0).toLocaleString()],
            [t('ctx_bench.result.capped_by', 'Capped by'), t('ctx_bench.capped.' + r.capped_by, r.capped_by || '')],
            [t('ctx_bench.result.prefill_tps', 'Prefill speed'), (r.prefill_tps || 0).toLocaleString() + ' tok/s'],
            [t('ctx_bench.result.duration', 'Duration'), (r.duration_s || 0) + ' s'],
        ];
        rows.forEach(function (kv) {
            if (!kv[1]) return;
            var tr = el('div', 'bench-result-row');
            tr.append(el('span', 'bench-label', kv[0]), el('span', null, kv[1]));
            card.appendChild(tr);
        });
        if (r.applied) {
            card.appendChild(el('p', 'native-stub-note', t('ctx_bench.result.applied_note',
                'The value has been applied to this model’s Context Window setting.')));
        }
        card.appendChild(el('p', 'native-stub-note', t('ctx_bench.result.snapshot_note',
            'The result reflects free memory at benchmark time; rerun after big config changes.')));
        // U49: classic exports no context block; keep the shared Copy
        // affordance, export exactly what the card shows (model row added
        // so pasted output is attributable)
        var selfC = this;
        wrap.replaceChildren(
            resultsHead(function () {
                return buildTableText(
                    [t('ctx_bench.heading', 'Context Benchmark'), ''],
                    [{ label: 'Field', get: function (kv) { return kv[0]; } },
                     { label: 'Value', get: function (kv) { return kv[1]; } }],
                    ctxResultPairs(selfC.state.models, r));
            }, 'ctx_bench.result.section_label', 'Result', {
                name: function () { return 'uplift_context_'
                    + String((r && r.model_id) || 'run'); },
                rows: function () { return r || {}; },
                cols: function () {
                    return ctxResultPairs(selfC.state.models, r).map(function (kv) {
                        return { head: kv[0], get: function () { return kv[1]; } };
                    });
                },
            }),
            card);
    },

    loadHist: function () {
        var self = this;
        return loadHistory('context', 'bench-ctx-history', ctxHistoryBody,
            self.state && self.state.benchId);
    },

    finish: function () {
        stopStream();
        this.state.running = false;
        this.setButtons();
        this.loadHist();   // U64
        var st = gid('bench-ctx-status');
        if (st && !st.classList.contains('bench-status-error') && st.textContent) {
            setBar('bench-ctx-status', 100);
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'Finished');
        }
    },
};

return {
    CTX: CTX
};
});
