/* SPLIT-3: Bench > ANE tuning panel (REPL-3): poll-driven run and the
   apply-recommendation step.
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).ane = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var dom = CORE.dom, errText = CORE.errText, api = CORE.api, t = CORE.t,
    el = CORE.el, busyLabel = CORE.busyLabel, labeled = CORE.labeled,
    check = CORE.check, gid = CORE.gid, statusLine = CORE.statusLine,
    setBar = CORE.setBar, advancedSection = CORE.advancedSection,
    buildTableText = CORE.buildTableText, simpleTable = CORE.simpleTable,
    historyEmptyNote = CORE.historyEmptyNote,
    loadHistory = CORE.loadHistory, resultsHead = CORE.resultsHead,
    dlCols = CORE.dlCols;

/* ==========================================================================
   ANE tuning (REPL-3) — classic ane_tuning mirror; POLL model like the
   classic modal (no SSE upstream). Apply = recommendation -> model
   settings; keys are derived by the SERVER (mirror of classic's JS),
   the UI only sends the snapshot back.
   ========================================================================== */

function aneHistoryBody(e) {
    var card = el('div', 'bench-result card');
    var rows = (e.rows || []).filter(function (r) {
        return r && (r.processing_tps != null || r.state); });
    if (!rows.length) {
        card.appendChild(historyEmptyNote());
        return card;
    }
    card.appendChild(simpleTable(
        [['split', 'split'], ['state', 'state'],
         ['processing_tps', 'processing_tps'], ['latency_ms', 'latency_ms']],
        rows.map(function (r) {
            return { split: r.split || r.name || '', state: r.state || '',
                     processing_tps: r.processing_tps == null ? '\u2014'
                         : Math.round(r.processing_tps).toLocaleString(),
                     latency_ms: r.latency_ms == null ? '\u2014'
                         : Math.round(r.latency_ms).toLocaleString() };
        })));
    card.prepend(resultsHead(function () {
        return buildTableText(
            ['ANE Tuning \u2014 ' + (e.model_id || ''), ''],
            [{ label: 'split', get: function (r) { return String(r.split); } },
             { label: 'state', get: function (r) { return String(r.state); } },
             { label: 'processing_tps', numeric: true,
               get: function (r) { return String(r.processing_tps); } },
             { label: 'latency_ms', numeric: true,
               get: function (r) { return String(r.latency_ms); } }],
            rows);
    }));
    return card;
}

var ANE = {
    state: null, _timer: null,

    render: function (panel) {
        this.state = { running: false, tuningId: null, snapshot: null };
        panel.appendChild(this.form());
        var status = statusLine('bench-ane-status');
        var results = el('div', 'bench-results'); results.id = 'bench-ane-results';
        var ahist = el('div', 'bench-results'); ahist.id = 'bench-ane-history';
        panel.append(status, results, ahist);
        this.loadModels();
        this.loadHist();   // U64
    },

    loadHist: function () {
        var self = this;
        return loadHistory('ane', 'bench-ane-history', aneHistoryBody,
            self.state && self.state.tuningId);
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('modal.model_settings.qwen_ane_tune', 'ANE Tuning')));
        f.appendChild(el('p', 'native-stub-note', t('modal.model_settings.k2_ane_tune_hint',
            'Optional tuning for long-prompt processing.')));

        var row = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-ane-model';
        var ph = el('option', null, t('ctx_bench.config.model_placeholder', 'Select a model...'));
        ph.value = ''; modelSel.appendChild(ph);
        row.appendChild(labeled(t('bench.config.model', 'Model'), modelSel));
        f.appendChild(row);

        // U49: same prominent Advanced card as the other panels; only the
        // label differs — classic names this block 'Search space'
        var body = [
            check('bench-ane-cpu', t('modal.model_settings.qwen_ane_tune_allow_cpu', 'Allow CPU candidates'), true),
            check('bench-ane-gate', t('modal.model_settings.qwen_ane_tune_allow_cpu_gate', 'CPU gate projections'), true),
            check('bench-ane-down', t('modal.model_settings.qwen_ane_tune_allow_cpu_down', 'CPU down projections'), true),
            check('bench-ane-gdn', t('modal.model_settings.qwen_ane_tune_allow_ane_gdn', 'ANE GDN candidates'), true),
            check('bench-ane-cpugdn', t('modal.model_settings.qwen_ane_tune_allow_cpu_gdn', 'CPU GDN candidates'), true),
            check('bench-ane-shared', t('modal.model_settings.qwen_ane_tune_allow_cpu_scheduler', 'CPU shared resource'), true)];
        f.appendChild(advancedSection(body,
            'modal.model_settings.qwen_ane_tune_overrides', 'Search space'));

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn primary', t('modal.model_settings.qwen_ane_tune_start', 'Start Tuning'));
        runBtn.type = 'button'; runBtn.id = 'bench-ane-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('modal.model_settings.qwen_ane_tune_cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-ane-cancel'; cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        actions.append(runBtn, cancelBtn);
        f.appendChild(actions);
        return f;
    },

    loadModels: async function () {
        var d = dom();
        try {
            var data = await d.fetchJson(api() + '/models');
            var sel = gid('bench-ane-model');
            if (!sel) return;
            var usable = ((data && data.models) || []).filter(function (m) {
                var ty = m.model_type || m.type;
                return !ty || ty === 'llm' || ty === 'vlm';
            });
            var ph2 = el('option', null, t('ctx_bench.config.model_placeholder', 'Select a model...'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) { sel.appendChild(el('option', null, m.id || m.model_id)); });
        } catch (e) { /* placeholder stays */ }
    },

    start: async function () {
        var d = dom();
        var sel = gid('bench-ane-model');
        if (!sel || !sel.value) {
            d.toast(t('ctx_bench.config.model_placeholder', 'Select a model...'), 'error');
            return;
        }
        var on = function (id) { var e = gid(id); return e && e.checked; };
        this.state.running = true;
        this.state.snapshot = null;
        this.setButtons();
        var rel = busyLabel(gid('bench-ane-run'));
        try {
            var out = await d.postJson(api() + '/bench/ane-tune/start', {
                model_id: sel.value,
                sequence_length: 2048,
                repeats: 2,
                allow_cpu: on('bench-ane-cpu'),
                allow_cpu_gate: on('bench-ane-cpu') && on('bench-ane-gate'),
                allow_cpu_down: on('bench-ane-cpu') && on('bench-ane-down'),
                allow_ane_gdn: on('bench-ane-gdn'),
                allow_cpu_gdn: on('bench-ane-cpu') && on('bench-ane-gdn') && on('bench-ane-cpugdn'),
                allow_cpu_shared_resource: on('bench-ane-cpu') && on('bench-ane-shared'),
            });
            rel();
            this.state.tuningId = out.tuning_id;
            this.pollNow();
            if (this._timer) clearInterval(this._timer);
            var self = this;
            this._timer = setInterval(function () { self.pollNow(); }, 2000);
        } catch (e) {
            rel();
            this.state.running = false;
            this.setButtons();
            d.toast(errText(e), 'error');
        }
    },

    pollNow: async function () {
        if (!this.state.tuningId) return;
        var d = dom();
        try {
            var snap = await d.fetchJson(api() + '/bench/ane-tune/' +
                encodeURIComponent(this.state.tuningId) + '/results');
            this.state.snapshot = snap;
            if (snap.total) setBar('bench-ane-status', snap.current / snap.total * 100);
            this.renderStatus((snap.message || snap.phase || '') +
                (snap.total ? '  (' + (snap.current || 0) + '/' + snap.total + ')' : ''));
            if (snap.status !== 'running') this.finish();
            else this.renderResults(snap);
        } catch (e) {
            this.stopTimer();
            this.state.running = false;
            this.setButtons();
        }
    },

    cancel: async function () {
        if (!this.state.tuningId) return;
        var d = dom();
        try {
            await d.postJson(api() + '/bench/ane-tune/' +
                encodeURIComponent(this.state.tuningId) + '/cancel', {});
        } catch (e) { d.toast(errText(e), 'error'); }
    },

    apply: async function () {
        var d = dom();
        var snap = this.state.snapshot;
        if (!snap || !snap.recommendation) return;
        var btn = gid('bench-ane-apply');
        if (btn) btn.disabled = true;
        try {
            await d.postJson(api() + '/bench/ane-tune/' +
                encodeURIComponent(snap.tuning_id) + '/apply',
                { recommendation: snap.recommendation });
            if (btn) btn.textContent = t('modal.model_settings.qwen_ane_tune_applied', 'Applied');
        } catch (e) {
            if (btn) btn.disabled = false;
            d.toast(errText(e), 'error');
        }
    },

    setButtons: function () {
        var r = gid('bench-ane-run'), c = gid('bench-ane-cancel');
        if (r) r.disabled = this.state.running;
        if (c) c.hidden = !this.state.running;
    },

    stopTimer: function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    renderStatus: function (msg, isError) {
        var st = gid('bench-ane-status');
        if (!st) return;
        st.textContent = msg || '';
        st.classList.toggle('bench-status-error', !!isError);
    },

    renderResults: function (snap) {
        var wrap = gid('bench-ane-results');
        if (!wrap) return;
        var card = el('div', 'bench-result card');
        card.appendChild(el('h2', null, t('uplift.bench.ane_candidates', 'Candidates')));
        var tbl = el('table', 'bench-table');
        var head = el('tr');
        ['split', 'state', 'processing_tps', 'latency_ms'].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        tbl.appendChild(head);
        (snap.results || []).forEach(function (r) {
            var tr = el('tr');
            [r.split || r.name || '', r.state || '',
             r.processing_tps == null ? '—' : Math.round(r.processing_tps).toLocaleString(),
             r.latency_ms == null ? '—' : Math.round(r.latency_ms).toLocaleString()]
                .forEach(function (v) { tr.appendChild(el('td', null, String(v))); });
            tbl.appendChild(tr);
        });
        card.appendChild(tbl);
        if (snap.recommendation && snap.status !== 'running') {
            var rec = snap.recommendation;
            card.appendChild(el('p', null, t('modal.model_settings.qwen_ane_tune_throughput', 'Recommended throughput') +
                ': ' + Math.round(rec.processing_tps || 0).toLocaleString() + ' tok/s'));
            var ab = el('button', 'btn primary', t('modal.model_settings.qwen_ane_tune_apply', 'Apply Recommendation'));
            ab.type = 'button'; ab.id = 'bench-ane-apply';
            ab.addEventListener('click', function () { ANE.apply(); });
            card.appendChild(ab);
        }
        // U49: classic exports no ANE block; shared Copy over the table
        // (model named in the header so pasted output is attributable)
        var mSel = gid('bench-ane-model');
        var aneHeadKey = 'uplift.bench.ane_candidates';
        wrap.replaceChildren(
            resultsHead(function () {
                return buildTableText(
                    ['ANE Tuning \u2014 ' + ((mSel && mSel.value) || ''), ''],
                    [{ label: 'split', get: function (r) { return String(r.split || r.name || ''); } },
                     { label: 'state', get: function (r) { return String(r.state || ''); } },
                     { label: 'processing_tps', numeric: true, get: function (r) {
                         return r.processing_tps == null ? '\u2014'
                             : Math.round(r.processing_tps).toLocaleString(); } },
                     { label: 'latency_ms', numeric: true, get: function (r) {
                         return r.latency_ms == null ? '\u2014'
                             : Math.round(r.latency_ms).toLocaleString(); } }],
                    snap.results || []);
            }, aneHeadKey, 'Candidates', {
                name: function () { return 'uplift_ane_'
                    + (((mSel && mSel.value) || 'run').replace(/\s+/g, '_')); },
                rows: function () { return (snap.results || []).map(function (r) {
                    return { split: r.split || r.name || '', state: r.state || '',
                             processing_tps: r.processing_tps, latency_ms: r.latency_ms };
                }); },
                cols: function () { return dlCols(
                    [['split', 'split'], ['state', 'state'],
                     ['processing_tps', 'processing_tps'],
                     ['latency_ms', 'latency_ms']]); },
            }),
            card);
    },

    finish: function () {
        this.stopTimer();
        this.state.running = false;
        this.setButtons();
        this.loadHist();   // U64
        if (this.state.snapshot) this.renderResults(this.state.snapshot);
        var st = gid('bench-ane-status');
        if (st && !st.classList.contains('bench-status-error') && st.textContent &&
            this.state.snapshot && this.state.snapshot.status === 'completed') {
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'Finished');
        }
    },
};

return {
    ANE: ANE
};
});
