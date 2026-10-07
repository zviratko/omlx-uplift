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
     ['ane', t('uplift.bench.ane_tune', 'ANE Tune')]].forEach(function (s) {
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
    else if (sub === 'context') CTX.render(panel);
    else if (sub === 'ane') ANE.render(panel);
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

function stopStream() {
    if (_es) { try { _es.close(); } catch (_) {} _es = null; }
    if (_poll) { clearInterval(_poll); _poll = null; }
    if (typeof ANE !== 'undefined' && ANE.stopTimer) ANE.stopTimer();
}

return { mount: mount, isMounted: function () { return _mounted; },
         showSub: showSub, tp: TP };
});
