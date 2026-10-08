/* NAT-3 shell + REPL-1 throughput UI — native Bench surface (thin host).
   Sub-tab machinery lives here; accuracy (REPL-2), context/ANE (REPL-3)
   and the new classes (REPL-4) plug into the same strip as their cards
   land. The classic engine is NOT duplicated: everything measurable runs
   in the server via /uplift/api/bench/* — omlx_uplift/bench_engine.py
   reuses omlx/admin/benchmark.py in-process (REPL-1 reuse verdict).

   i18n doctrine (REPL-1): every label routes through C.t using the keys
   CLASSIC'S OWN bench page uses ('bench.*' from the classic catalog the
   /locale endpoint merges — verified present in all 10 locales), plus
   new uplift.bench.* keys for native-only strings (added to all 10
   locale files in the same commit). Nothing user-visible is a hardcoded
   English string here; fallback texts exist only so the shell survives
   a catalog load failure. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftNativeBench = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var _mounted = false;
var _sub = 'throughput';
var _es = null;          // throughput SSE
var _poll = null;        // fallback poll timer while SSE unavailable

function W() { return (typeof window !== 'undefined') ? window : null; }
function C() { return W() && W().UpliftCore ? W().UpliftCore : null; }
function dom() { return W() && W().UpliftDom ? W().UpliftDom : null; }
function api() {
    var st = W() && W().Uplift && W().Uplift.state;
    return ((st && st.API) || '') + '/uplift/api';
}

/* t(): classic OR uplift key with fallback (catalog is merged server-side) */
function t(key, fb) {
    var c = C();
    var v = (c && c.t) ? c.t(key) : key;
    return v === key ? (fb || key) : v;
}

var PROMPT_LENGTHS = [1024, 4096, 8192, 16384, 32768, 65536, 131072, 200000];
var BATCH_SIZES = [2, 4, 8];
var TARGET_TOKENS = [16384, 32768, 65536, 131072, 262144, 524288];
var PROFILES = ['code_python', 'code_mixed', 'novel_en', 'novel_ja', 'novel_ko'];
var PROFILE_FALLBACK = { code_python: 'Code (Python)', code_mixed: 'Code (Mixed)',
    novel_en: 'Novel (English)', novel_ja: 'Novel (Japanese)', novel_ko: 'Novel (Korean)' };

function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function labeled(label, node) {
    var w = el('label', 'bench-field');
    w.append(el('span', 'bench-label', label), node);
    return w;
}
function check(id, label, on) {
    var lb = el('label', 'bench-check');
    var cb = el('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = !!on;
    lb.append(cb, document.createTextNode(' ' + label));
    return lb;
}
function gid(id) { return document.getElementById(id); }
function checkedVals(box) {
    return box ? Array.prototype.map.call(box.querySelectorAll('input:checked'),
        function (i) { return Number(i.value); }) : [];
}

function mount() {
    var host = gid('bench-native');
    if (!host || _mounted) return;
    _mounted = true;
    host.replaceChildren();
    var strip = el('div', 'native-subtabs');
    [['throughput', t('navbar.dropdown.performance', 'Throughput')],
     ['accuracy', t('navbar.dropdown.accuracy', 'Intelligence')],
     ['context', t('navbar.dropdown.context', 'Context')],
     ['ane', t('uplift.bench.ane_tune', 'ANE Tune')],
     ['embed', t('uplift.bench.embeddings', 'Embeddings')],
     ['rerank', t('uplift.bench.rerankers', 'Rerankers')]].forEach(function (s) {
        var b = el('button', 'native-subtab' + (s[0] === _sub ? ' active' : ''), s[1]);
        b.type = 'button';
        b.dataset.sub = s[0];
        b.addEventListener('click', function () { showSub(s[0]); });
        strip.appendChild(b);
    });
    var panel = el('div', 'native-subpanel');
    panel.id = 'bench-subpanel';
    host.append(strip, panel);
    showSub(_sub);
}

function showSub(sub) {
    _sub = sub;
    document.querySelectorAll('#bench-native .native-subtab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.sub === sub);
    });
    var panel = gid('bench-subpanel');
    if (!panel) return;
    stopStream();
    panel.replaceChildren();
    if (sub === 'throughput') TP.render(panel);
    else if (sub === 'accuracy') ACC.render(panel);
    else if (sub === 'context') CTX.render(panel);
    else if (sub === 'ane') ANE.render(panel);
    else if (sub === 'embed') MTEB('embed').render(panel);
    else if (sub === 'rerank') MTEB('rerank').render(panel);
    else panel.appendChild(stubCard(sub));
}

function stubCard(sub) {
    var card = el('div', 'native-stub card');
    var titles = { accuracy: ['navbar.dropdown.accuracy', 'Intelligence'],
                   context: ['navbar.dropdown.context', 'Context'],
                   ane: ['uplift.bench.ane_tune', 'ANE Tune'] };
    var tt = titles[sub] || titles.ane;
    card.append(el('h2', null, t(tt[0], tt[1])),
                el('p', 'native-stub-note', t('uplift.bench.native_stub',
                    'Native surface — not implemented yet.')));
    return card;
}

/* ==========================================================================
   THROUGHPUT (REPL-1) — classic engine driven over /uplift/api/bench/*
   Feature checklist parity with classic _bench.html: model, context
   profile, prompt lengths, batch sizes, ANE-aligned prompt, force lm
   engine, external endpoint mode, run/cancel, live progress + results.
   Native additions: community upload is an explicit opt-IN checkbox
   (classic auto-uploads every standard run; the card demands opt-in).
   tg stays the fixed 128 classic uses (hint shown, no fake control).
   ========================================================================== */

var TP = {
    state: null,

    render: function (panel) {
        this.state = { active: null, results: [], total: 0, current: 0,
                       phase: '', running: false, benchId: null };
        panel.appendChild(this.form());
        var status = el('div', 'bench-status'); status.id = 'bench-tp-status';
        var results = el('div', 'bench-results'); results.id = 'bench-tp-results';
        panel.append(status, results);
        this.loadModels();
        this.discover();
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('bench.heading', 'Performance Benchmark')));

        var row1 = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-tp-model';
        var ph = el('option', null, t('bench.config.model_placeholder', 'Select model…')); ph.value = ''; modelSel.appendChild(ph);
        var profSel = el('select'); profSel.id = 'bench-tp-profile';
        PROFILES.forEach(function (p) {
            var o = el('option', null, t('bench.config.context.' + p, PROFILE_FALLBACK[p]));
            o.value = p;
            profSel.appendChild(o);
        });
        row1.append(labeled(t('bench.config.model', 'Model'), modelSel),
                    labeled(t('bench.config.context_profile', 'Benchmark Context'), profSel));

        var row2 = el('div', 'bench-row');
        var ppBox = el('div', 'bench-chips'); ppBox.id = 'bench-tp-pp';
        PROMPT_LENGTHS.forEach(function (pp) {
            var lb = el('label', 'chip');
            var cb = el('input'); cb.type = 'checkbox'; cb.value = String(pp);
            if (pp === 1024 || pp === 4096) cb.checked = true;
            lb.append(cb, document.createTextNode(' pp' + pp.toLocaleString()));
            ppBox.appendChild(lb);
        });
        var genNote = el('p', 'native-stub-note', t('bench.config.generation_hint',
            'Generation length: 128 tokens (fixed)'));
        row2.append(labeled(t('bench.config.single_request', 'Single Request Tests'), ppBox), genNote);

        var row3 = el('div', 'bench-row');
        var bsBox = el('div', 'bench-chips'); bsBox.id = 'bench-tp-bs';
        BATCH_SIZES.forEach(function (bs) {
            var lb = el('label', 'chip');
            var cb = el('input'); cb.type = 'checkbox'; cb.value = String(bs);
            lb.append(cb, document.createTextNode(' ' + bs + '×'));
            bsBox.appendChild(lb);
        });
        var adv = el('details', 'bench-advanced');
        adv.appendChild(el('summary', null, t('bench.config.advanced_options', 'Advanced options')));
        var advBody = el('div', 'bench-adv-body');
        advBody.append(
            check('bench-tp-ane', t('bench.config.ane_aligned_prompt', 'ANE-aligned prompts (+1 token)'), false),
            check('bench-tp-lm', t('bench.config.force_lm_engine', 'Force mlx-lm engine'), false),
            check('bench-tp-ext', t('bench.config.external', 'Use external OpenAI API endpoint'), false),
            check('bench-tp-upload', t('uplift.bench.upload_results', 'Upload results to community leaderboard'), false),
            el('p', 'native-stub-note', t('uplift.bench.upload_hint',
                'Off by default: a native run never posts to omlx.ai unless you check this.')),
            el('p', 'native-stub-note', t('bench.config.batch_hint', 'Batch tests use pp1024 / tg128')));
        adv.appendChild(advBody);
        row3.append(labeled(t('bench.config.batch_tests', 'Continuous Batching Tests'), bsBox), adv);

        var extRow = el('div', 'bench-row bench-external');
        extRow.id = 'bench-tp-ext-row'; extRow.hidden = true;
        var eurl = el('input'); eurl.id = 'bench-tp-ext-url'; eurl.placeholder = t('bench.config.external_base_url', 'Base URL');
        var ekey = el('input'); ekey.id = 'bench-tp-ext-key'; ekey.type = 'password'; ekey.placeholder = t('bench.config.external_api_key', 'API key');
        var emod = el('input'); emod.id = 'bench-tp-ext-model'; emod.placeholder = t('bench.config.external_model', 'Model');
        extRow.append(labeled(t('bench.config.external_base_url', 'Base URL'), eurl),
                      labeled(t('bench.config.external_api_key', 'API key'), ekey),
                      labeled(t('bench.config.external_model', 'Model'), emod));

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn btn-primary', t('bench.config.run_button', 'Run Benchmark'));
        runBtn.type = 'button'; runBtn.id = 'bench-tp-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-tp-cancel'; cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        actions.append(runBtn, cancelBtn);

        f.append(row1, row2, row3, extRow, actions);
        requestAnimationFrame(function () {
            var ext = gid('bench-tp-ext');
            if (ext) ext.addEventListener('change', function () {
                var er = gid('bench-tp-ext-row');
                if (er) er.hidden = !ext.checked;
            });
        });
        return f;
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
                this.setButtons();
                this.startStream(a.bench_id);
                this.renderStatus(t('bench.other_active.already_running',
                    'Another throughput benchmark is already running in this server.') +
                    ' (' + a.model_id + ')');
            }
        } catch (e) { /* idle is fine */ }
    },

    collect: function () {
        var body = {
            model_id: gid('bench-tp-model') ? gid('bench-tp-model').value : '',
            prompt_lengths: checkedVals(gid('bench-tp-pp')),
            generation_length: 128,
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
        this.setButtons();
        var rw = gid('bench-tp-results');
        if (rw) rw.replaceChildren();
        try {
            var out = await d.postJson(api() + '/bench/start', body);
            this.state.benchId = out.bench_id;
            this.startStream(out.bench_id);
            this.renderStatus(t('bench.progress.preparing', 'Preparing…'));
        } catch (e) {
            this.state.running = false;
            this.setButtons();
            d.toast(String((e && e.message) || e), 'error');
        }
    },

    cancel: async function () {
        if (!this.state.benchId) return;
        var d = dom();
        try {
            await d.postJson(api() + '/bench/' + encodeURIComponent(this.state.benchId) + '/cancel', {});
        } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
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
            _es = new EventSource(api() + '/bench/' + encodeURIComponent(benchId) + '/stream');
            _es.onmessage = function (ev) {
                var data;
                try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            _es.onerror = function () {
                /* EventSource reconnects on its own; the server replays the
                   whole event log on every (re)open (replay-after-reconnect
                   is classic's pinned SSE model, we reuse the run object). */
            };
        } catch (e) { this.fallbackPoll(benchId); }
    },

    fallbackPoll: function (benchId) {
        var self = this;
        var d = dom();
        if (_poll) clearInterval(_poll);
        _poll = setInterval(async function () {
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
        var cols = [
            ['pp', 'PP'], ['tg', 'TG'],
            ['ttft_ms', t('bench.metrics.ttft.name', 'TTFT')],
            ['processing_tps', t('bench.metrics.pp_tps.name', 'pp TPS')],
            ['gen_tps', t('bench.metrics.tg_tps.name', 'tg TPS')],
            ['total_throughput', t('bench.metrics.throughput.name', 'Throughput')],
            ['tpot_ms', t('bench.metrics.tpot.name', 'TPOT')],
            ['e2e_latency_s', t('bench.metrics.e2e.name', 'E2E')],
            ['batch_size', t('bench.metrics.batch_size.name', 'Batch Size')],
        ];
        var tbl = el('table', 'bench-table');
        var thead = el('tr');
        cols.forEach(function (c) { thead.appendChild(el('th', null, c[1])); });
        tbl.appendChild(thead);
        var self = this;
        rows.forEach(function (r) {
            var tr = el('tr');
            cols.forEach(function (c) {
                var v = r[c[0]];
                tr.appendChild(el('td', null, v == null ? '—'
                    : (typeof v === 'number' ? self.fmt(c[0], v) : String(v))));
            });
            tbl.appendChild(tr);
        });
        wrap.replaceChildren(tbl);
    },

    fmt: function (key, v) {
        if (key === 'ttft_ms' || key === 'tpot_ms') return Math.round(v * 10) / 10 + ' ms';
        if (key === 'e2e_latency_s') return Math.round(v * 100) / 100 + ' s';
        if (key === 'pp') return v.toLocaleString();
        return (Math.round(v * 10) / 10).toLocaleString();
    },

    finish: function () {
        stopStream();
        this.state.running = false;
        this.setButtons();
        var st = gid('bench-tp-status');
        if (st && !st.classList.contains('bench-status-error')) {
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'finished');
        }
    },
};


/* ==========================================================================
   CONTEXT probe (REPL-3) — classic context_benchmark over /uplift/api/
   bench/context/*. SSE progress like throughput; the classic runner
   APPLIES the measured window to model settings itself (mirror keeps
   that auto-apply honest — the warning label is classic's own).
   ========================================================================== */

var CTX = {
    state: null,

    render: function (panel) {
        this.state = { running: false, benchId: null, result: null };
        panel.appendChild(this.form());
        var status = el('div', 'bench-status'); status.id = 'bench-ctx-status';
        var results = el('div', 'bench-results'); results.id = 'bench-ctx-results';
        panel.append(status, results);
        this.loadModels();
        this.discover();
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
        TARGET_TOKENS.forEach(function (tk) {
            var o = el('option', null, tk.toLocaleString()); o.value = String(tk);
            if (tk === 131072) o.selected = true;
            targetSel.appendChild(o);
        });
        row.append(labeled(t('ctx_bench.config.model', 'Model'), modelSel),
                   labeled(t('ctx_bench.config.target', 'Maximum context to test'), targetSel));
        f.appendChild(row);
        f.appendChild(el('p', 'native-stub-note', t('ctx_bench.config.target_hint',
            'The benchmark searches up to this size. Larger targets take longer to verify.')));
        f.appendChild(el('p', 'native-stub-note', t('ctx_bench.warning.autoapply',
            'The measured value is applied to the model automatically.')));

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn btn-primary', t('ctx_bench.start', 'Start Benchmark'));
        runBtn.type = 'button'; runBtn.id = 'bench-ctx-run';
        runBtn.addEventListener('click', function () { self.start(); });
        var cancelBtn = el('button', 'btn', t('ctx_bench.progress.cancel', 'Cancel'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-ctx-cancel'; cancelBtn.hidden = true;
        cancelBtn.addEventListener('click', function () { self.cancel(); });
        actions.append(runBtn, cancelBtn);
        f.appendChild(actions);
        return f;
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
            var ph2 = el('option', null, t('ctx_bench.config.model_placeholder', 'Select a model...'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) { sel.appendChild(el('option', null, m.id || m.model_id)); });
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
        this.state.running = true;
        this.state.result = null;
        this.setButtons();
        var rw = gid('bench-ctx-results');
        if (rw) rw.replaceChildren();
        try {
            var out = await d.postJson(api() + '/bench/context/start', {
                model_id: sel.value,
                target_tokens: Number(gid('bench-ctx-target').value),
            });
            this.state.benchId = out.bench_id;
            this.startStream(out.bench_id);
            this.renderStatus(t('ctx_bench.progress.starting', 'Starting...'));
        } catch (e) {
            this.state.running = false;
            this.setButtons();
            d.toast(String((e && e.message) || e), 'error');
        }
    },

    cancel: async function () {
        if (!this.state.benchId) return;
        var d = dom();
        try {
            await d.postJson(api() + '/bench/context/' +
                encodeURIComponent(this.state.benchId) + '/cancel', {});
        } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
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
            _es = new EventSource(api() + '/bench/context/' + encodeURIComponent(benchId) + '/stream');
            _es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            _es.onerror = function () { /* auto-reconnect replays from 0 */ };
        } catch (e) { this.poll(benchId); }
    },

    poll: function (benchId) {
        var self = this;
        var d = dom();
        if (_poll) clearInterval(_poll);
        _poll = setInterval(async function () {
            try {
                var r = await d.fetchJson(api() + '/bench/context/' + encodeURIComponent(benchId) + '/results');
                self.renderStatus((r.message || r.phase || '') + ' ' +
                    Math.round(r.progress || 0) + '%');  // classic: 0-100 scale
                if (r.result) { self.state.result = r.result; self.renderResult(r.result); }
                if (r.status !== 'running') self.finish();
            } catch (e) { /* keep polling */ }
        }, 3000);
    },

    onEvent: function (ev) {
        if (ev.type === 'progress') {
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
        wrap.replaceChildren(card);
    },

    finish: function () {
        stopStream();
        this.state.running = false;
        this.setButtons();
        var st = gid('bench-ctx-status');
        if (st && !st.classList.contains('bench-status-error') && st.textContent) {
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'finished');
        }
    },
};

/* ==========================================================================
   ANE tuning (REPL-3) — classic ane_tuning mirror; POLL model like the
   classic modal (no SSE upstream). Apply = recommendation -> model
   settings; keys are derived by the SERVER (mirror of classic's JS),
   the UI only sends the snapshot back.
   ========================================================================== */

var ANE = {
    state: null, _timer: null,

    render: function (panel) {
        this.state = { running: false, tuningId: null, snapshot: null };
        panel.appendChild(this.form());
        var status = el('div', 'bench-status'); status.id = 'bench-ane-status';
        var results = el('div', 'bench-results'); results.id = 'bench-ane-results';
        panel.append(status, results);
        this.loadModels();
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

        var ov = el('details', 'bench-advanced');
        ov.appendChild(el('summary', null, t('modal.model_settings.qwen_ane_tune_overrides', 'Search space')));
        var body = el('div', 'bench-adv-body');
        body.append(
            check('bench-ane-cpu', t('modal.model_settings.qwen_ane_tune_allow_cpu', 'Allow CPU candidates'), true),
            check('bench-ane-gate', t('modal.model_settings.qwen_ane_tune_allow_cpu_gate', 'CPU gate projections'), true),
            check('bench-ane-down', t('modal.model_settings.qwen_ane_tune_allow_cpu_down', 'CPU down projections'), true),
            check('bench-ane-gdn', t('modal.model_settings.qwen_ane_tune_allow_ane_gdn', 'ANE GDN candidates'), true),
            check('bench-ane-cpugdn', t('modal.model_settings.qwen_ane_tune_allow_cpu_gdn', 'CPU GDN candidates'), true),
            check('bench-ane-shared', t('modal.model_settings.qwen_ane_tune_allow_cpu_scheduler', 'CPU shared resource'), true));
        ov.appendChild(body);
        f.appendChild(ov);

        var actions = el('div', 'bench-actions');
        var runBtn = el('button', 'btn btn-primary', t('modal.model_settings.qwen_ane_tune_start', 'Start Tuning'));
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
            this.state.tuningId = out.tuning_id;
            this.pollNow();
            if (this._timer) clearInterval(this._timer);
            var self = this;
            this._timer = setInterval(function () { self.pollNow(); }, 2000);
        } catch (e) {
            this.state.running = false;
            this.setButtons();
            d.toast(String((e && e.message) || e), 'error');
        }
    },

    pollNow: async function () {
        if (!this.state.tuningId) return;
        var d = dom();
        try {
            var snap = await d.fetchJson(api() + '/bench/ane-tune/' +
                encodeURIComponent(this.state.tuningId) + '/results');
            this.state.snapshot = snap;
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
        } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
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
            d.toast(String((e && e.message) || e), 'error');
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
            var ab = el('button', 'btn btn-primary', t('modal.model_settings.qwen_ane_tune_apply', 'Apply Recommendation'));
            ab.type = 'button'; ab.id = 'bench-ane-apply';
            ab.addEventListener('click', function () { ANE.apply(); });
            card.appendChild(ab);
        }
        wrap.replaceChildren(card);
    },

    finish: function () {
        this.stopTimer();
        this.state.running = false;
        this.setButtons();
        if (this.state.snapshot) this.renderResults(this.state.snapshot);
        var st = gid('bench-ane-status');
        if (st && !st.classList.contains('bench-status-error') && st.textContent &&
            this.state.snapshot && this.state.snapshot.status === 'completed') {
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'finished');
        }
    },
};


/* ==========================================================================
   ACCURACY (REPL-2a) — classic 16-task engine over /uplift/api/bench/
   accuracy/*. Queue chaining + per-suite upload events belong to the
   classic runner; uplift flips upload to explicit OPT-IN (engine window
   patch, documented in accuracy_engine.py). Task grid comes from the
   server (/tasks) so dataset facts ship in one place; labels are classic
   acc_bench.* keys.
   ========================================================================== */

var ACC = {
    state: null,

    render: function (panel) {
        this.state = { running: false, benchId: null, queue: [],
                       progress: null, groups: null,
                       selected: {}, sizes: {}, results: [] };
        panel.appendChild(this.form());
        var queue = el('div', 'acc-queue'); queue.id = 'bench-acc-queue';
        var status = el('div', 'bench-status'); status.id = 'bench-acc-status';
        var results = el('div', 'bench-results'); results.id = 'bench-acc-results';
        panel.append(queue, status, results);
        this.loadModels();
        this.loadTasks();
        this.refreshQueue();
        this.refreshResults();
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('acc_bench.heading', 'Intelligence Benchmark')));
        f.appendChild(el('p', 'native-stub-note', t('acc_bench.description',
            'Multiple-choice and generation accuracy across 16 community benchmarks.')));

        var row1 = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-acc-model';
        var ph = el('option', null, t('acc_bench.config.model_placeholder', 'Select a model...'));
        ph.value = ''; modelSel.appendChild(ph);
        row1.appendChild(labeled(t('acc_bench.config.model', 'Model'), modelSel));
        f.appendChild(row1);

        var grid = el('div', 'acc-taskgrid'); grid.id = 'bench-acc-tasks';
        f.appendChild(grid);

        var adv = el('details', 'bench-advanced');
        adv.appendChild(el('summary', null, t('acc_bench.config.advanced_options', 'Advanced options')));
        var body = el('div', 'bench-adv-body');
        var bsSel = el('select'); bsSel.id = 'bench-acc-batch';
        [1, 2, 4, 8, 16, 32].forEach(function (n) {
            var o = el('option', null, String(n)); o.value = String(n); bsSel.appendChild(o);
        });
        var sampSel = el('select'); sampSel.id = 'bench-acc-sampling';
        var o1 = el('option', null, t('acc_bench.config.sampling_deterministic', 'Deterministic (greedy)'));
        o1.value = 'deterministic'; sampSel.appendChild(o1);
        var o2 = el('option', null, t('acc_bench.config.sampling_model', 'Model settings (temperature)'));
        o2.value = 'model_settings'; sampSel.appendChild(o2);
        body.append(
            labeled(t('acc_bench.config.batch_size', 'Batch size'), bsSel),
            labeled(t('acc_bench.config.sampling', 'Sampling'), sampSel),
            el('p', 'native-stub-note', t('acc_bench.config.batch_size_hint', 'Larger batches are faster but use more memory.')),
            check('bench-acc-think', t('acc_bench.config.thinking', 'Enable thinking mode'), false),
            el('p', 'native-stub-note', t('acc_bench.config.thinking_hint', 'Applies to models whose template supports thinking toggles.')),
            check('bench-acc-ext', t('bench.config.external', 'Use external OpenAI API endpoint'), false),
            el('label', 'bench-field', el('span', 'bench-label', t('uplift.bench.engine', 'Scoring engine'))),
            (function () {
                var seg = el('div', 'bench-chips'); seg.id = 'bench-acc-engine';
                [['classic', t('uplift.bench.engine_classic', 'Classic')],
                 ['harness', t('uplift.bench.engine_harness', 'Harness')]].forEach(function (e, i) {
                    var lb = el('label', 'chip');
                    var rb = el('input'); rb.type = 'radio'; rb.name = 'bench-acc-engine';
                    rb.value = e[0]; rb.checked = i === 0;
                    lb.append(rb, document.createTextNode(' ' + e[1]));
                    seg.appendChild(lb);
                });
                return seg;
            })(),
            el('p', 'native-stub-note', t('uplift.bench.engine_hint',
                'Harness = lm-evaluation-harness subprocess (mapped tasks only; a run with unmapped tasks is refused). Classic is the built-in engine.')),
            check('bench-acc-upload', t('uplift.bench.upload_results', 'Upload results to community leaderboard'), false),
            el('p', 'native-stub-note', t('uplift.bench.upload_hint',
                'Off by default: a native run never posts to omlx.ai unless you check this.')));
        adv.appendChild(body);
        f.appendChild(adv);

        var extRow = el('div', 'bench-row bench-external');
        extRow.id = 'bench-acc-ext-row'; extRow.hidden = true;
        var eurl = el('input'); eurl.id = 'bench-acc-ext-url'; eurl.placeholder = t('bench.config.external_base_url', 'Base URL');
        var ekey = el('input'); ekey.id = 'bench-acc-ext-key'; ekey.type = 'password'; ekey.placeholder = t('bench.config.external_api_key', 'API key');
        var emax = el('input'); emax.id = 'bench-acc-ext-max'; emax.type = 'number'; emax.placeholder = t('acc_bench.config.external_max_tokens', 'Max tokens');
        var ebody = el('input'); ebody.id = 'bench-acc-ext-body'; ebody.placeholder = t('acc_bench.config.external_extra_body', 'Extra body (JSON)');
        var emod = el('input'); emod.id = 'bench-acc-ext-model'; emod.placeholder = t('bench.config.external_model', 'Model');
        extRow.append(labeled(t('bench.config.external_base_url', 'Base URL'), eurl),
                      labeled(t('bench.config.external_api_key', 'API key'), ekey),
                      labeled(t('bench.config.external_model', 'Model'), emod),
                      labeled(t('acc_bench.config.external_max_tokens', 'Max tokens'), emax),
                      labeled(t('acc_bench.config.external_extra_body', 'Extra body (JSON)'), ebody));
        f.appendChild(extRow);

        var actions = el('div', 'bench-actions');
        var addBtn = el('button', 'btn btn-primary', t('acc_bench.config.add_run', 'Add to Queue'));
        addBtn.type = 'button'; addBtn.id = 'bench-acc-add';
        addBtn.addEventListener('click', function () { self.add(); });
        var cancelBtn = el('button', 'btn', t('acc_bench.config.cancel_button', 'Cancel All'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-acc-cancel';
        cancelBtn.addEventListener('click', function () { self.cancelAll(); });
        var clearBtn = el('button', 'btn', t('acc_bench.results.clear', 'Clear'));
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', function () { self.clearResults(); });
        actions.append(addBtn, cancelBtn, clearBtn);
        f.appendChild(actions);

        requestAnimationFrame(function () {
            var ext = gid('bench-acc-ext');
            if (ext) ext.addEventListener('change', function () {
                var er = gid('bench-acc-ext-row');
                if (er) er.hidden = !ext.checked;
            });
        });
        return f;
    },

    loadModels: function () {
        var d = dom();
        return d.fetchJson(api() + '/models').then(function (data) {
            var sel = gid('bench-acc-model');
            if (!sel) return;
            var usable = ((data && data.models) || []).filter(function (m) {
                var ty = m.model_type || m.type;
                return !ty || ty === 'llm' || ty === 'vlm';
            });
            var ph2 = el('option', null, t('acc_bench.config.model_placeholder', 'Select a model...'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) { sel.appendChild(el('option', null, m.id || m.model_id)); });
        }).catch(function () {});
    },

    loadTasks: function () {
        var d = dom();
        var self = this;
        return d.fetchJson(api() + '/bench/accuracy/tasks').then(function (data) {
            self.state.groups = data.tasks || [];
            self.renderGrid();
        }).catch(function () {});
    },

    renderGrid: function () {
        var grid = gid('bench-acc-tasks');
        if (!grid || !this.state.groups) return;
        var self = this;
        grid.replaceChildren();
        this.state.groups.forEach(function (grp) {
            var wrap = el('div', 'acc-group');
            wrap.appendChild(el('div', 'bench-label', t(grp.group, grp.group.split('.').pop())));
            var row = el('div', 'acc-group-tasks');
            grp.tasks.forEach(function (tk) {
                var card = el('div', 'acc-task');
                card.dataset.key = tk.key;
                var name = el('div', 'acc-task-name', tk.label);
                var desc = el('div', 'acc-task-desc',
                    tk.desc ? t(tk.desc, tk.desc_literal || tk.key) : (tk.desc_literal || ''));
                var sizeSel = el('select');
                sizeSel.dataset.key = tk.key;
                tk.sizes.forEach(function (n) {
                    var o = el('option', null, String(n)); o.value = String(n); sizeSel.appendChild(o);
                });
                var fullOpt = el('option', null, t('acc_bench.config.full_option', 'Full') +
                    ' (' + tk.full_size.toLocaleString() + ')');
                fullOpt.value = '0';
                sizeSel.appendChild(fullOpt);
                sizeSel.value = String(tk.sizes[Math.min(2, tk.sizes.length - 1)]);
                sizeSel.disabled = true;
                card.append(name, desc, sizeSel);
                card.addEventListener('click', function (ev) {
                    if (ev.target === sizeSel) return;
                    var on = card.classList.toggle('on');
                    self.state.selected[tk.key] = on;
                    sizeSel.disabled = !on;
                });
                sizeSel.addEventListener('change', function () {
                    self.state.sizes[tk.key] = Number(sizeSel.value);
                });
                row.appendChild(card);
            });
            wrap.appendChild(row);
            grid.appendChild(wrap);
        });
    },

    collect: function () {
        var g = this.state;
        var benchmarks = {};
        Object.keys(g.selected).forEach(function (k) {
            if (!g.selected[k]) return;
            benchmarks[k] = g.sizes[k] != null ? g.sizes[k]
                : (g.groups ? this.defaultSize(k) : 100);
        }, this);
        var body = {
            model_id: gid('bench-acc-model') ? gid('bench-acc-model').value : '',
            benchmarks: benchmarks,
            batch_size: Number((gid('bench-acc-batch') || {}).value || 1),
            sampling_profile: (gid('bench-acc-sampling') || {}).value || 'deterministic',
            enable_thinking: !!(gid('bench-acc-think') && gid('bench-acc-think').checked),
            upload: !!(gid('bench-acc-upload') && gid('bench-acc-upload').checked),
        };
        var eng = document.querySelector('input[name=bench-acc-engine]:checked');
        body.engine = eng ? eng.value : 'classic';
        var ext = gid('bench-acc-ext');
        if (ext && ext.checked) {
            // classic parity (accuracyExternalRequestBody): extra_body +
            // max_tokens_override live INSIDE the external object, and
            // model_id IS the remote model name (local catalog skipped)
            var external = {
                base_url: (gid('bench-acc-ext-url') || {}).value || '',
                api_key: (gid('bench-acc-ext-key') || {}).value || '',
                model: ((gid('bench-acc-ext-model') || {}).value || '').trim(),
            };
            var eb = (gid('bench-acc-ext-body') || {}).value;
            if (eb && eb.trim()) {
                try { external.extra_body = JSON.parse(eb); }
                catch (e) { throw new Error(t('acc_bench.config.external_extra_body', 'Extra body (JSON)') + ': JSON'); }
            }
            var mt = Number((gid('bench-acc-ext-max') || {}).value || 0);
            if (mt > 0) external.max_tokens_override = mt;
            body.model_id = external.model || body.model_id;
            body.external = external;
            body.enable_thinking = false;  // classic forces off for external
        }
        return body;
    },

    defaultSize: function (key) {
        var out = 100;
        (this.state.groups || []).forEach(function (grp) {
            grp.tasks.forEach(function (tk) {
                if (tk.key === key) out = tk.sizes[Math.min(2, tk.sizes.length - 1)];
            });
        });
        return out;
    },

    add: async function () {
        var d = dom();
        var body;
        try { body = this.collect(); }
        catch (e) { d.toast(String((e && e.message) || e), 'error'); return; }
        if (!body.external && !body.model_id) {
            d.toast(t('acc_bench.config.model_placeholder', 'Select a model...'), 'error');
            return;
        }
        if (!Object.keys(body.benchmarks).length) {
            d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
            return;
        }
        try {
            await d.postJson(api() + '/bench/accuracy/add', body);
            this.refreshQueue();
        } catch (e) {
            d.toast(String((e && e.message) || e), 'error');
        }
    },

    cancelAll: async function () {
        var d = dom();
        try { await d.postJson(api() + '/bench/accuracy/cancel', {}); this.refreshQueue(); }
        catch (e) { d.toast(String((e && e.message) || e), 'error'); }
    },

    clearResults: async function () {
        var d = dom();
        try { await d.postJson(api() + '/bench/accuracy/results/reset', {}); this.refreshResults(); }
        catch (e) { d.toast(String((e && e.message) || e), 'error'); }
    },

    refreshQueue: async function () {
        var d = dom();
        try {
            var st = await d.fetchJson(api() + '/bench/accuracy/queue');
            this.state.queue = st.queue || [];
            var wasRunning = this.state.running;
            this.state.running = !!st.running;
            this.state.benchId = st.current_bench_id || null;
            this.renderQueue(st);
            if (st.running && !wasRunning && st.current_bench_id) this.startStream(st.current_bench_id);
            if (!st.running && wasRunning) { stopStream(); this.refreshResults(); }
        } catch (e) { /* board offline */ }
    },

    renderQueue: function (st) {
        var wrap = gid('bench-acc-queue');
        if (!wrap) return;
        wrap.replaceChildren();
        var head = el('div', 'bench-label', t('acc_bench.config.queue_label', 'Queue'));
        wrap.appendChild(head);
        if (st.running && st.current_model) {
            var cur = el('div', 'acc-queue-item running',
                '▸ ' + st.current_model + (st.phase ? ' (' + st.phase + ')' : ''));
            wrap.appendChild(cur);
        }
        var self = this;
        (st.queue || []).forEach(function (q, i) {
            var it = el('div', 'acc-queue-item', (i + 1) + '. ' + q.model_id +
                (q.external ? ' [' + t('acc_bench.results.external_badge', 'external') + ']' : '') +
                ' — ' + (q.benchmarks || []).join(', '));
            var rm = el('button', 'acc-queue-remove', '×');
            rm.type = 'button';
            rm.title = t('models.queue.remove_tooltip', 'Remove');
            rm.addEventListener('click', async function () {
                var d = dom();
                try { await d.deleteJson(api() + '/bench/accuracy/queue/' + i); self.refreshQueue(); }
                catch (e) { d.toast(String((e && e.message) || e), 'error'); }
            });
            it.appendChild(rm);
            wrap.appendChild(it);
        });
    },

    startStream: function (benchId) {
        var self = this;
        stopStream();
        if (!W().EventSource) {
            if (_poll) clearInterval(_poll);
            _poll = setInterval(function () { self.refreshQueue(); }, 4000);
            return;
        }
        try {
            _es = new EventSource(api() + '/bench/accuracy/' + encodeURIComponent(benchId) + '/stream');
            _es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            _es.onerror = function () { /* replay-from-0 on reconnect */ };
        } catch (e) {
            if (_poll) clearInterval(_poll);
            _poll = setInterval(function () { self.refreshQueue(); }, 4000);
        }
    },

    onEvent: function (ev) {
        var st = gid('bench-acc-status');
        if (ev.type === 'progress') {
            // classic event fields: phase, benchmark, current/total (suite
            // index), bench_current/bench_total (question counters)
            if (st) st.textContent = (ev.message || ev.phase || '') +
                (ev.bench_total ? '  [' + (ev.current || 0) + '/' + ev.total +
                    ' suites · ' + (ev.bench_current || 0) + '/' + ev.bench_total + ' q]' : '');
        } else if (ev.type === 'result') {
            this.refreshResults();
        } else if (ev.type === 'error') {
            if (st) { st.textContent = String(ev.message || 'error');
                      st.classList.add('bench-status-error'); }
            this.state.running = false;
            stopStream();
        } else if (ev.type === 'done') {
            if (st) st.classList.remove('bench-status-error');
            this.state.running = false;
            stopStream();
            this.refreshQueue();
            this.refreshResults();
        }
    },

    refreshResults: async function () {
        var d = dom();
        try {
            var r = await d.fetchJson(api() + '/bench/accuracy/results');
            this.state.results = r.results || [];
            this.renderResults();
        } catch (e) { /* keep last table */ }
    },

    renderResults: function () {
        var wrap = gid('bench-acc-results');
        if (!wrap) return;
        var rows = this.state.results;
        if (!rows.length) { wrap.replaceChildren(); return; }
        var tbl = el('table', 'bench-table');
        var head = el('tr');
        [t('bench.config.model', 'Model'), t('acc_bench.results.category', 'Benchmark'),
         t('acc_bench.results.correct_line', '{correct} of {total} in {time}s'),
         t('acc_bench.results.total_accuracy', 'Total accuracy'), ''].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        tbl.appendChild(head);
        rows.forEach(function (r) {
            var tr = el('tr');
            var badges = '';
            if (r.engine === 'harness') badges += ' [H]';
            else if (r.engine === 'classic') badges += ' [C]';
            if (r.external) badges += ' [' + t('acc_bench.results.external_badge', 'external') + ']';
            if (r.thinking_used) badges += ' [' + t('acc_bench.results.thinking_badge', 'thinking') + ']';
            var up = r.upload ? (r.upload.status === 'skipped' ? '—' : '↑') : '';
            // classic renders count+time through its own template string
            var line = t('acc_bench.results.correct_line', '{correct} of {total} in {time}s')
                .replace('{correct}', String(r.correct || 0))
                .replace('{total}', String(r.total || 0))
                .replace('{time}', String(r.time_s || 0));
            // 'x of y' reads exactly like classic's leaderboard copy;
            // dataset_total is the raw number beside it (no invented key)
            if (r.dataset_total) line += ' · /' + r.dataset_total.toLocaleString();
            tr.append(
                el('td', null, String(r.model_id || '')),
                el('td', null, String(r.benchmark || '')),
                el('td', null, line),
                el('td', null, ((r.accuracy || 0) * 100).toFixed(1) + '% ' + badges),
                el('td', null, up));
            tbl.appendChild(tr);
        });
        wrap.replaceChildren(tbl);
    },
};

/* ---- REPL-4: embeddings / rerankers (one factory, MTEB server-side) -----
   Same thin-host doctrine: the curated task list + engine readiness come
   from /bench/embed/tasks, the run executes as a server subprocess, this
   panel only draws state and streams events. Score cells show mteb's main
   metric value with the metric name under it — a bare number with no
   metric name would lie about what it measures. */
var MTEB_GROUPS = { sts: 'STS', retrieval: 'Retrieval', class: 'Classification',
    pair: 'PairClassification', cluster: 'Clustering', bitext: 'BitextMining',
    rerank: 'Reranking' };
var MTEB_LIMITS = [0, 100, 500, 1000, 5000];

function MTEB(kind) {
    var prefix = 'bench-' + kind;

    return {
        state: null,

        render: function (panel) {
            this.state = { running: false, runId: null, tasks: {},
                           selected: {}, limit: 0, results: [] };
            panel.appendChild(this.form());
            panel.appendChild(this.envNote());
            var status = el('div', 'bench-status'); status.id = prefix + '-status';
            var results = el('div', 'bench-results'); results.id = prefix + '-results';
            panel.append(status, results);
            this.loadModels();
            this.loadTasks();
            this.refreshResults();
            this.discover();
        },

        envNote: function () {
            var n = el('div', 'native-stub-note'); n.id = prefix + '-envnote';
            n.hidden = true;
            n.textContent = t('uplift.bench.mteb_env_missing',
                'MTEB environment missing — run: omlx-uplift mteb-env create');
            return n;
        },

        form: function () {
            var self = this;
            var f = el('div', 'bench-form card');
            f.appendChild(el('h2', null, t(kind === 'embed'
                ? 'uplift.bench.embeddings' : 'uplift.bench.rerankers',
                kind === 'embed' ? 'Embeddings' : 'Rerankers')));
            f.appendChild(el('p', 'native-stub-note', t(kind === 'embed'
                ? 'uplift.bench.embed_desc' : 'uplift.bench.rerank_desc',
                'MTEB tasks over the served API; a curated small set.')));

            var row = el('div', 'bench-row');
            var modelSel = el('select'); modelSel.id = prefix + '-model';
            var ph = el('option', null, t('bench.config.model_placeholder', 'Select model…'));
            ph.value = ''; modelSel.appendChild(ph);
            var limSel = el('select'); limSel.id = prefix + '-limit';
            MTEB_LIMITS.forEach(function (n) {
                var o = el('option', null, n === 0
                    ? t('acc_bench.config.full_option', 'Full') : String(n));
                o.value = String(n);
                if (n === 500) o.selected = true;
                limSel.appendChild(o);
            });
            row.append(labeled(t('bench.config.model', 'Model'), modelSel),
                       labeled(t('uplift.bench.sample_limit', 'Sample limit'), limSel));
            f.appendChild(row);

            var grid = el('div', 'acc-taskgrid'); grid.id = prefix + '-tasks';
            f.appendChild(grid);

            var actions = el('div', 'bench-actions');
            var runBtn = el('button', 'btn btn-primary', t('bench.config.run_button', 'Run'));
            runBtn.type = 'button'; runBtn.id = prefix + '-run';
            runBtn.addEventListener('click', function () { self.start(); });
            var cancelBtn = el('button', 'btn', t('bench.progress.cancel', 'Cancel'));
            cancelBtn.type = 'button'; cancelBtn.id = prefix + '-cancel';
            cancelBtn.hidden = true;
            cancelBtn.addEventListener('click', function () { self.cancel(); });
            var clearBtn = el('button', 'btn', t('acc_bench.results.clear', 'Clear Results'));
            clearBtn.type = 'button'; clearBtn.id = prefix + '-clear';
            clearBtn.addEventListener('click', function () { self.clearResults(); });
            actions.append(runBtn, cancelBtn, clearBtn);
            f.appendChild(actions);
            return f;
        },

        loadModels: async function () {
            var d = dom();
            try {
                var data = await d.fetchJson(api() + '/models');
                var sel = gid(prefix + '-model');
                if (!sel) return;
                var rows = (data && data.models) || [];
                var want = kind === 'embed' ? 'embedding' : 'reranker';
                var usable = rows.filter(function (m) {
                    return (m.engine_type || m.model_type) === want;
                });
                var ph2 = el('option', null, t('bench.config.model_placeholder', 'Select model…'));
                ph2.value = '';
                sel.replaceChildren(ph2);
                usable.forEach(function (m) {
                    sel.appendChild(el('option', null, m.id || m.model_id));
                });
            } catch (e) { /* start surfaces errors */ }
        },

        loadTasks: async function () {
            var d = dom();
            var self = this;
            try {
                var p = await d.fetchJson(api() + '/bench/embed/tasks');
                this.state.tasks = p.tasks || {};
                var note = gid(prefix + '-envnote');
                if (note) note.hidden = p.env === 'ready';
                this.renderGrid();
            } catch (e) { /* grid stays empty until a retry */ }
        },

        renderGrid: function () {
            var grid = gid(prefix + '-tasks');
            if (!grid) return;
            var self = this;
            var byGroup = {};
            Object.keys(this.state.tasks).forEach(function (name) {
                var m = self.state.tasks[name];
                if (m.kind !== kind) return;
                (byGroup[m.group] = byGroup[m.group] || []).push(name);
            });
            grid.replaceChildren();
            Object.keys(MTEB_GROUPS).forEach(function (g) {
                if (!byGroup[g]) return;
                var wrap = el('div', 'acc-group');
                wrap.appendChild(el('div', 'bench-label', MTEB_GROUPS[g]));
                var row = el('div', 'acc-group-tasks');
                byGroup[g].sort().forEach(function (name) {
                    var m = self.state.tasks[name];
                    var card = el('div', 'acc-task');
                    var name1 = el('div', 'acc-task-name',
                        name + (m.cs ? ' [CZ]' : ''));
                    var desc = el('div', 'acc-task-desc',
                        m.sizes.toLocaleString() + (m.cap ? ' → ' + m.cap : ''));
                    card.append(name1, desc);
                    card.addEventListener('click', function () {
                        var on = card.classList.toggle('on');
                        self.state.selected[name] = on;
                    });
                    row.appendChild(card);
                });
                wrap.appendChild(row);
                grid.appendChild(wrap);
            });
        },

        start: async function () {
            var d = dom();
            var model = (gid(prefix + '-model') || {}).value || '';
            var tasks = Object.keys(this.state.selected)
                .filter(function (k) { return this.state.selected[k]; }, this);
            if (!model) {
                d.toast(t('bench.config.model_placeholder', 'Select model…'), 'error');
                return;
            }
            if (!tasks.length) {
                d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
                return;
            }
            var limitSel = gid(prefix + '-limit');
            this.state.limit = Number((limitSel || {}).value || 0);
            try {
                var r = await d.postJson(api() + '/bench/embed/start',
                    { model_id: model, kind: kind, tasks: tasks,
                      limit: this.state.limit });
                this.state.running = true;
                this.state.runId = r.run_id;
                this.setButtons();
                this.startStream(r.run_id);
            } catch (e) {
                d.toast(String((e && e.message) || e), 'error');
            }
        },

        cancel: async function () {
            var d = dom();
            if (!this.state.runId) return;
            try { await d.postJson(api() + '/bench/embed/'
                + encodeURIComponent(this.state.runId) + '/cancel', {}); }
            catch (e) { d.toast(String((e && e.message) || e), 'error'); }
        },

        clearResults: async function () {
            var d = dom();
            try {
                await d.postJson(api() + '/bench/embed/results/reset', {});
                this.refreshResults();
            } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
        },

        discover: async function () {
            var d = dom();
            try {
                var a = await d.fetchJson(api() + '/bench/embed/active');
                if (a && a.running && a.kind === kind) {
                    this.state.running = true;
                    this.state.runId = a.run_id;
                    this.setButtons();
                    this.startStream(a.run_id);
                }
            } catch (e) { /* idle */ }
        },

        refreshResults: async function () {
            var d = dom();
            try {
                var p = await d.fetchJson(api() + '/bench/embed/results');
                this.state.results = (p.results || []).filter(function (r) {
                    return r.kind === kind;
                });
                this.renderResults();
            } catch (e) { /* keep last view */ }
        },

        startStream: function (runId) {
            var self = this;
            stopStream();
            var poll = function () {
                if (_poll) clearInterval(_poll);
                _poll = setInterval(async function () {
                    var d = dom();
                    try {
                        var a = await d.fetchJson(api() + '/bench/embed/active');
                        if (!a || !a.running) { stopStream(); }
                        self.refreshResults();
                    } catch (e) { /* transient */ }
                }, 5000);
            };
            if (!W().EventSource) { poll(); return; }
            try {
                _es = new EventSource(api() + '/bench/embed/'
                    + encodeURIComponent(runId) + '/stream');
                _es.onmessage = function (ev) {
                    var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                    self.onEvent(data);
                };
                _es.onerror = function () { /* replay-from-0 on reconnect */ };
            } catch (e) { poll(); }
        },

        onEvent: function (ev) {
            if (ev.type === 'progress') {
                this.renderStatus((ev.message || ev.phase || '') +
                    (ev.total ? ' (' + (Number(ev.current) + 1) + '/' + ev.total + ')' : ''));
            } else if (ev.type === 'result') {
                this.state.results.push(ev.data);
                this.renderResults();
            } else if (ev.type === 'done') {
                this.state.running = false; this.state.runId = null;
                this.setButtons(); stopStream();
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
            var runBtn = gid(prefix + '-run'), c = gid(prefix + '-cancel');
            if (runBtn) runBtn.disabled = this.state.running;
            if (c) c.hidden = !this.state.running;
        },

        renderStatus: function (s) {
            var n = gid(prefix + '-status');
            if (n) n.textContent = s;
        },

        renderResults: function () {
            var wrap = gid(prefix + '-results');
            if (!wrap) return;
            var rows = this.state.results.slice().reverse();
            if (!rows.length) { wrap.replaceChildren(); return; }
            var tbl = el('table', 'bench-table');
            var head = el('tr');
            [t('bench.config.model', 'Model'), t('acc_bench.config.benchmarks', 'Benchmarks'),
             t('acc_bench.results.score', 'Score'), t('uplift.bench.metric', 'Metric'),
             t('uplift.bench.samples', 'Samples'), ''].forEach(function (h) {
                head.appendChild(el('th', null, h));
            });
            tbl.appendChild(head);
            rows.forEach(function (r) {
                var tr = el('tr');
                var tests = Object.keys(r.scores || {});
                var sc = tests.length ? r.scores[tests[0]] : null;
                var n = sc && sc.all ? (sc.all.n || sc.all.num || null) : null;
                tr.append(
                    el('td', null, String(r.model_id || '')),
                    el('td', null, String(r.task || '')),
                    el('td', null, sc && sc.main_score != null
                        ? Number(sc.main_score).toFixed(4) : '—'),
                    el('td', null, sc && sc.main_metric ? String(sc.main_metric) : '—'),
                    el('td', null, n != null ? String(n)
                        : (r.limit ? ('≤' + r.limit) : '—')),
                    el('td', null, r.ts ? new Date(r.ts * 1000)
                        .toLocaleString() : ''));
                tbl.appendChild(tr);
            });
            wrap.replaceChildren(tbl);
        },
    };
}

function stopStream() {
    if (_es) { try { _es.close(); } catch (_) {} _es = null; }
    if (_poll) { clearInterval(_poll); _poll = null; }
    if (typeof ANE !== 'undefined' && ANE.stopTimer) ANE.stopTimer();
}

return { mount: mount, isMounted: function () { return _mounted; },
         showSub: showSub, tp: TP };
});
