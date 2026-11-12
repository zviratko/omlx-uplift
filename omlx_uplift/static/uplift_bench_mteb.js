/* SPLIT-3: Bench > Embeddings panel (REPL-4): the MTEB task picker,
   run, SSE progress and score table for embedding and reranker models.
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel factory. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).mteb = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, dom = CORE.dom, errText = CORE.errText, api = CORE.api,
    t = CORE.t, el = CORE.el, busyLabel = CORE.busyLabel,
    labeled = CORE.labeled, gid = CORE.gid, taskCard = CORE.taskCard,
    loadingNote = CORE.loadingNote,
    streamInterrupted = CORE.streamInterrupted,
    statusLine = CORE.statusLine, setBar = CORE.setBar,
    buildTableText = CORE.buildTableText, resultsHead = CORE.resultsHead,
    stopStream = CORE.stopStream;

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
            var status = statusLine(prefix + '-status');
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
            // U86: the first Run click builds the env server-side (the
            // panel streams its progress) — no terminal round-trip
            n.textContent = t('uplift.bench.mteb_env_missing',
                'MTEB environment not installed yet — the first Run '
                + 'creates it automatically (2-5 min for the download).');
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
                // U51: full_option's {count} slot has no value here (the
                // limit select is per-run, not per-task) — classic's plain
                // 'Full' word instead of a raw 'Full ({count})' leak
                var o = el('option', null, n === 0
                    ? t('acc_bench.results.text_export.full', 'Full')
                    : n.toLocaleString());
                o.value = String(n);
                if (n === 500) o.selected = true;
                limSel.appendChild(o);
            });
            row.append(labeled(t('bench.config.model', 'Model'), modelSel),
                       labeled(t('uplift.bench.sample_limit', 'Sample limit'), limSel));
            f.appendChild(row);

            // U49: grid floated unlabeled; classic's caption for the list
            f.appendChild(el('div', 'bench-label acc-grid-label',
                t('acc_bench.config.benchmarks', 'Benchmarks')));
            var grid = el('div', 'acc-taskgrid'); grid.id = prefix + '-tasks';
            f.appendChild(grid);

            var actions = el('div', 'bench-actions');
            var runBtn = el('button', 'btn primary', t('bench.config.run_button', 'Run'));
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
            var g0 = gid(prefix + '-tasks');
            if (g0) g0.replaceChildren(loadingNote());
            try {
                var p = await d.fetchJson(api() + '/bench/embed/tasks');
                this.state.tasks = p.tasks || {};
                var note = gid(prefix + '-envnote');
                if (note) note.hidden = p.env === 'ready';
                this.renderGrid();
                // U65: results frequently arrive BEFORE the task grid; the
                // samples fallback reads meta.sizes, so repaint once the
                // metadata exists (dashes would otherwise stick forever)
                if (this.state.results && this.state.results.length) {
                    this.renderResults();
                }
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
                    var card = taskCard(name + (m.cs ? ' [CZ]' : ''),
                        m.sizes.toLocaleString() + (m.cap ? ' → ' + m.cap : ''),
                        null, function (on) { self.state.selected[name] = on; });
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
            var rel = busyLabel(gid(prefix + '-run'));
            try {
                var r = await d.postJson(api() + '/bench/embed/start',
                    { model_id: model, kind: kind, tasks: tasks,
                      limit: this.state.limit });
                rel();
                // BENCHQ: busy server => queued behind the live run. The Run
                // button stays enabled precisely so this click was legal.
                if (CORE.BENCHQ.isQueued(r)) { CORE.BENCHQ.note(); return; }
                this.state.running = true;
                this.state.runId = r.run_id;
                // U86: start succeeded => the run itself now owns the
                // env build; the static 'not installed yet' note would
                // just contradict the live progress line below it
                var note0 = gid(prefix + '-envnote');
                if (note0) note0.hidden = true;
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
            try { await d.postJson(api() + '/bench/embed/'
                + encodeURIComponent(this.state.runId) + '/cancel', {}); }
            catch (e) { d.toast(errText(e), 'error'); }
        },

        clearResults: async function () {
            var d = dom();
            try {
                await d.postJson(api() + '/bench/embed/results/reset', {});
                this.refreshResults();
            } catch (e) { d.toast(errText(e), 'error'); }
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
                if (CORE._poll) clearInterval(CORE._poll);
                CORE._poll = setInterval(async function () {
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
                CORE._es = new EventSource(api() + '/bench/embed/'
                    + encodeURIComponent(runId) + '/stream');
                CORE._es.onmessage = function (ev) {
                    var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                    self.onEvent(data);
                };
                CORE._es.onerror = function () { streamInterrupted(prefix + '-status'); };
            } catch (e) { poll(); }
        },

        onEvent: function (ev) {
            if (ev.type === 'progress') {
                if (ev.total) setBar(prefix + '-status',
                    Math.min(100, (Number(ev.current) || 0) / ev.total * 100));
                this.renderStatus((ev.message || ev.phase || '') +
                    (ev.total ? ' (' + (Number(ev.current) + 1) + '/' + ev.total + ')' : ''));
            } else if (ev.type === 'result') {
                this.state.results.push(ev.data);
                this.renderResults();
            } else if (ev.type === 'done') {
                this.state.running = false; this.state.runId = null;
                this.setButtons(); stopStream();
                setBar(prefix + '-status', 100);
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
            var c = gid(prefix + '-cancel');
            // BENCHQ (user item 6): Run stays ENABLED during a live run — a
            // second click is not an error, the server queues it behind the
            // first (benchmarks+models within one benchmark type, the way
            // Intelligence already does). Only Cancel is state-dependent.
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
            var selfR = this;
            // U65: MTEB's scores dict carries metric floats only — no
            // count key exists (verified against accumulated.json), so a
            // full run showed '—'. Chain: explicit n/num (future-proof) ->
            // run limit ('≤50' sampling marker) -> the task's dataset size
            // (a full run evaluates exactly that many; EMBED_TASKS ships
            // it) -> dash.
            function samplesOf(r) {
                var k0 = Object.keys(r.scores || {})[0];
                var sc = k0 ? r.scores[k0] : null;
                var n = sc && sc.all ? (sc.all.n || sc.all.num || null) : null;
                if (n != null) return String(n);
                if (r.limit) return '\u2264' + r.limit;
                var meta = (selfR.state.tasks || {})[r.task];
                return (meta && meta.sizes) ? String(meta.sizes) : '\u2014';
            }
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
                tr.append(
                    el('td', null, String(r.model_id || '')),
                    el('td', null, String(r.task || '')),
                    el('td', null, sc && sc.main_score != null
                        ? Number(sc.main_score).toFixed(4) : '—'),
                    el('td', null, sc && sc.main_metric ? String(sc.main_metric) : '—'),
                    el('td', null, samplesOf(r)),
                    el('td', null, r.ts ? new Date(r.ts * 1000)
                        .toLocaleString() : ''));
                tbl.appendChild(tr);
            });
            // U49: one shared Copy for both kinds (factory pattern the
            // card asked for) — Model/Benchmark/Score/Metric/Samples rows
            var selfM = this;
            wrap.replaceChildren(
                resultsHead(function () {
                    return buildTableText(
                        [kind === 'embed' ? t('uplift.bench.embeddings', 'Embeddings')
                                          : t('uplift.bench.rerankers', 'Rerankers'), ''],
                        [{ label: 'Model', get: function (r) { return String(r.model_id || ''); } },
                         { label: 'Benchmark', get: function (r) { return String(r.task || ''); } },
                         { label: 'Score', numeric: true, get: function (r) {
                             var k0 = Object.keys(r.scores || {})[0];
                             var sc = k0 ? r.scores[k0] : null;
                             return sc && sc.main_score != null
                                 ? Number(sc.main_score).toFixed(4) : '\u2014'; } },
                         { label: 'Metric', get: function (r) {
                             var k0 = Object.keys(r.scores || {})[0];
                             var sc = k0 ? r.scores[k0] : null;
                             return sc && sc.main_metric ? String(sc.main_metric) : '\u2014'; } },
                         { label: 'Samples', numeric: true,
                           get: samplesOf }],
                        selfM.state.results.slice().reverse());
                }, null, null, {
                    name: function () {
                        // same fallback as the decision panel: newest
                        // result's model beats the (possibly reset) selector
                        var rs = selfM.state.results;
                        var m = rs.length ? rs[rs.length - 1].model_id : '';
                        if (!m) {
                            var mSel = gid(prefix + '-model');
                            m = mSel && mSel.value;
                        }
                        return 'uplift_' + kind + '_' + String(m || 'run');
                    },
                    rows: function () { return selfM.state.results.slice().reverse(); },
                    cols: function () { return [
                        { head: 'Model', get: function (r) { return r.model_id || ''; } },
                        { head: 'Benchmark', get: function (r) { return r.task || ''; } },
                        { head: 'Score', get: function (r) {
                            var k0 = Object.keys(r.scores || {})[0];
                            var sc = k0 ? r.scores[k0] : null;
                            return sc && sc.main_score != null ? sc.main_score : ''; } },
                        { head: 'Metric', get: function (r) {
                            var k0 = Object.keys(r.scores || {})[0];
                            var sc = k0 ? r.scores[k0] : null;
                            return sc && sc.main_metric ? sc.main_metric : ''; } },
                        { head: 'Samples', get: function (r) {
                            var s = samplesOf(r);
                            return s === '\u2014' ? '' : s; } },
                    ]; },
                }),
                tbl);
        },
    };
}

return {
    MTEB: MTEB
};
});
