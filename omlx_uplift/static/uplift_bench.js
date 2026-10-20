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
var _curPanel = null;    // BENCHQ: the panel instance showSub() painted

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
// TG-OPT: generation length is selectable (classic fixes it at 128). The
// engine already takes generation_length on every request (single + batch)
// — no server-side change needed; default stays 128 so a run started
// without touching the control is byte-identical to classic's.
var GEN_LENGTHS = [128, 256, 512, 1024];
var TARGET_TOKENS = [16384, 32768, 65536, 131072, 262144, 524288];
// U50: context-target option list for a model, pure so it is unit-testable.
// Rules: the model's OWN config.json window is offered first and selected
// (classic's classic-page hint says sizes beyond the native window are
// hidden — we hide them too), the standard ladder keeps only sizes at or
// below it, and a Custom entry allows an arbitrary probe (server accepts
// any whole number >= 2048, including beyond the declared window; the
// runner still clamps to native + floors to 2k, so an over-native custom
// value is safe, just capped at run time).
var CTX_CUSTOM_MIN = 2048;
function ctxTargetOptions(native, ladder) {
    // No ceiling: every offered size is a search cap the runner accepts —
    // beyond the native window the run is clamped to native at run time and
    // the result says so ('capped by native'), never silent rounding.
    var out = [];
    var list = ladder || TARGET_TOKENS;
    if (native && native > 0) {
        out.push({ value: String(native), label: native.toLocaleString(),
                   native: true });
        list.filter(function (tk) { return tk < native; })
            .forEach(function (tk) {
                out.push({ value: String(tk), label: tk.toLocaleString() });
            });
    } else {
        list.forEach(function (tk) {
            out.push({ value: String(tk), label: tk.toLocaleString() });
        });
    }
    out.push({ value: 'custom', custom: true });
    return out;
}
var PROFILES = ['code_python', 'code_mixed', 'novel_en', 'novel_ja', 'novel_ko'];
var PROFILE_FALLBACK = { code_python: 'Code (Python)', code_mixed: 'Code (Mixed)',
    novel_en: 'Novel (English)', novel_ja: 'Novel (Japanese)', novel_ko: 'Novel (Korean)' };

function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
/* U62: the bench start/add POSTs can block for seconds on a
   cold model load (queue_add starts the run synchronously). Without a
   visible in-flight state the click reads as dead — the user's 'add to
   queue does nothing'. Disable + relabel before the await, restore after. */
function busyLabel(btn) {
    if (!btn || btn.dataset.busy === '1') return function () {};
    var prev = btn.textContent;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = t('uplift.bench.starting', 'Starting\u2026');
    return function () {
        btn.disabled = false;
        btn.textContent = prev;
        delete btn.dataset.busy;
    };
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
    lb.input = cb;      // CACHE-OFF: the handle, so a caller never needs gid
    return lb;
}
/* A checkbox whose LABEL text is re-resolvable (U59 contract): the text
   lives in its own span carrying dataset.i18n/dataset.en, because
   applyI18n repaints with textContent= and a dataset on the label itself
   would DELETE the input on a late catalog load. The input is also hung
   off lb.input so the panel can reach it without a getElementById.
   (.bench-check is inline-flex with a gap — no leading space node needed) */
function checkI18n(id, key, fb, on) {
    var lb = el('label', 'bench-check');
    var cb = el('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = !!on;
    var txt = el('span', 'bench-check-text', t(key, fb));
    txt.dataset.i18n = key;
    txt.dataset.en = fb;                         // the EN baseline, verbatim
    lb.append(cb, txt);
    lb.input = cb;
    return lb;
}
function gid(id) { return document.getElementById(id); }
// U51: task/pack cards were click-only divs — keyboard users could not
// reach them. Real button semantics (role/tabindex/aria-pressed +
// Enter/Space), selection state mirrored from the .on class.
function taskCard(label, desc, title, onToggle, i18n) {
    var card = el('div', 'acc-task');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', 'false');
    var nameEl = el('div', 'acc-task-name', label);
    // U59: t() ran before the locale fetch on a fast grid paint; carrying
    // the key lets uplift.js's applyI18n(document) pass re-resolve it the
    // moment the catalog lands (data-en = the fallback we rendered)
    if (i18n && i18n.l) { nameEl.dataset.i18n = i18n.l; nameEl.dataset.en = label; }
    card.appendChild(nameEl);
    var descEl = el('div', 'acc-task-desc', desc);
    if (i18n && i18n.d) { descEl.dataset.i18n = i18n.d; descEl.dataset.en = desc; }
    card.appendChild(descEl);
    if (title) card.title = title;
    function toggle() {
        var on = card.classList.toggle('on');
        card.setAttribute('aria-pressed', on ? 'true' : 'false');
        onToggle(on);
    }
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', function (ev) {
        // U53: only when the card itself is focused; Enter/Space on an
        // inner control (the size select) belongs to that control
        if (ev.target !== card) return;
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });
    return card;
}
// U51: grids rendered nothing while /tasks was in flight (dead-panel
// look); one honest loading line, replaced by the real grid on resolve.
function loadingNote() {
    var n = el('div', 'native-stub-note');
    n.textContent = t('uplift.bench.loading_tasks', 'Loading benchmarks…');
    return n;
}
// U51: a dropped SSE stream used to freeze the last progress line with no
// signal. EventSource retries by itself (the server replays from 0), so
// say that honestly; the next event or finish() overwrites the line.
function streamInterrupted(statusId) {
    var st = gid(statusId);
    if (st && !st.classList.contains('bench-status-error')) {
        st.textContent = '⚠ ' + t(
            'uplift.ui.server_restarting_dashboard_reconnecting',
            'Server restarting — dashboard reconnecting…');
    }
}
// U51: run status text is announced to assistive tech
// U-PROG (user 2026-10-12): every panel's status sits in a prominent box
// with a determinate progress bar. The old dim 11px single line was
// easily missed while a bench ran. statusLine builds the box (bar under
// the text); panels paint the text via gid(id) as before and move the
// bar with setBar(id, pct). The box hides itself when empty and idle.
// U-PROG3 (user 2026-10-13: 'I see two progress bars'): the box used to
// carry the graphical .bench-bar AND the ASCII line painted from the same
// percentage — the same progress twice, one of them skin-fragile. The
// ASCII line is now the one bar; it took over the progressbar semantics
// (role + aria-value*) that the graphical div owned.
function statusLine(id) {
    var box = el('div', 'bench-statusbox');
    var st = el('div', 'bench-status'); st.id = id;
    st.setAttribute('role', 'status');
    st.setAttribute('aria-live', 'polite');
    // U-PROG2: prominent ASCII progress line (user 2026-10-13) — monospace
    // block bar survives every skin/font and prints alongside the counts.
    var ascii = el('div', 'bench-bar-ascii'); ascii.id = id + '-bar-ascii';
    ascii.setAttribute('role', 'progressbar');
    ascii.setAttribute('aria-valuemin', '0');
    ascii.setAttribute('aria-valuemax', '100');
    ascii.setAttribute('aria-valuenow', '0');
    box.append(st, ascii);
    return box;
}
// U-PROG: move the bar of a status box. stId is the .bench-status id
// (same key every panel already uses); pct is 0-100; meta is an optional
// counter string ("20/294") echoed into the ASCII line.
function setBar(stId, pct, meta) {
    var p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    var ascii = gid(stId + '-bar-ascii');
    if (!ascii) return;
    var cells = 20, on = Math.round(cells * p / 100);
    ascii.textContent = '[' + new Array(on + 1).join('\u2588')
        + new Array(cells - on + 1).join('\u2591') + '] ' + p + '%'
        + (meta ? '  ' + meta : '');
    ascii.setAttribute('aria-valuenow', String(p));
}
// U51: ms-per-question with locale separators + one decimal (a raw
// 568.75 next to formatted columns reads like a machine dump)
function fmtMs(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString(undefined,
        { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
// U-LAT (user 2026-10-13: '253.4ms but 298s for 294 samples?'): the stored
// ms_per_question is divided by the engine's INTERNAL question-probes (4 per
// item — original, re-ordered, …) while the Samples column counts ITEMS, so
// the cell quoted a number no arithmetic in the row could reproduce. The
// table's 'ms/question' column is per-ITEM latency now (honest against
// Time (s) / Samples); the probe-level number still ships as 'ms/probe' in
// the Copy/Download exports. Rows written before the backend stored
// ms_per_item derive it from time_s/items; rows with neither stay '—'.
function msPerItem(r) {
    if (r.ms_per_item != null) return r.ms_per_item;
    if (r.time_s != null && r.items) {
        return Math.round(r.time_s * 1000 / r.items * 100) / 100;
    }
    // Legacy rows (pre ms_per_item AND pre time_s — 10/08 era): per-item
    // latency is NOT derivable honestly (probe count was never stored and
    // skipped/shuffle-failed items vary it), so the column says '—'.
    // The per-PROBE figure (ms/probe column / ms_per_question export key)
    // stays truthful for every era. EFF-1 doctrine: never claim a value
    // the server does not report.
    return null;
}
// U48: one Advanced section builder shared by the panels (classic keeps
// external-endpoint as a first-class mode; the user explicitly asked for
// it under a PROMINENT Advanced section instead of the old 11px <details>
// squeezed beside the batch checkboxes — recorded deviation from classic).
// Open/closed is a layout preference -> localStorage (board doctrine).
var ADV_LS = 'omlx-uplift-bench-advanced';

/* ---- U83: accuracy queue board ------------------------------------------
   The old line read '▸ model (loading)' + '[0/2 suites · 28/300 q]':
   suite counting was per-request and 0-based (a RUNNING suite showed as
   0), the question pair duplicated the per-suite counters instead of the
   queue total, and queued suites were invisible text. The board tracks
   every suite the user queued THIS session across both engine entries
   (a mixed pick posts two queue rows; classic counts them separately —
   the user counts 3 benchmarks), renders each as a box that fills left
   to right, and computes [running-suite/total · done-q/total-q] from it.
   Pure helpers so a node test can replay event sequences. */
function boardSuiteMeta(groups, key, extras) {
    // classic card truth sources: label for the box, full_size for a
    // 'Full' selection (size 0); unknown -> null (board renders '?')
    for (const g of (groups || []))
        for (const tk of (g.tasks || []))
            if (tk.key === key) return { label: tk.label || key, full: tk.full_size || 0 };
    // ACC-2a: a harness-only suite lives in extra_suites, not in the
    // classic groups — without this the board would print the raw key
    for (const x of (extras || []))
        if (x && x.key === key)
            return { label: x.label || key, full: x.rows || 0 };
    return { label: key, full: 0 };
}
function boardQuestions(sizes, engine, hSizes, groups) {
    // effective question count per suite of one entry (U68 math: harness
    // --limit applies PER SUBTASK -> size x leaf count)
    var out = 0, per = {};
    for (var k in sizes) {
        var n = sizes[k] | 0, q;
        if (engine === 'harness') q = n * ((hSizes && hSizes[k]) || 1);
        else q = n || (boardSuiteMeta(groups, k).full) || 0;
        per[k] = q; out += q;
    }
    return { per: per, total: out };
}
function boardSuiteBoxes(entries) {
    // flat ordered suite list: {key,label,engine,model,state,done,total,q}
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        for (var k in (e.sizes || {})) {
            out.push({ key: k, label: (e.meta && e.meta[k] && e.meta[k].label) || k,
                       engine: e.engine || 'classic', model: e.model_id,
                       state: e.suiteState && e.suiteState[k] || 'queued',
                       done: (e.suiteDone && e.suiteDone[k]) | 0,
                       total: (e.qper && e.qper[k]) | 0,
                       quiet: !!(e.suiteQuiet && e.suiteQuiet[k]) });
        }
    }
    return out;
}
function boardCounters(entries) {
    var suites = boardSuiteBoxes(entries), doneS = 0, runIdx = -1, doneQ = 0, totQ = 0;
    for (var i = 0; i < suites.length; i++) {
        var s = suites[i]; totQ += s.total;
        if (s.state === 'done') { doneS++; doneQ += s.total || s.done; }
        else if (s.state === 'running' && runIdx < 0) runIdx = i;
    }
    // 'current suite' is 1-based the moment it runs (user: 0 makes no
    // sense); between entries (nothing running) the count sits at done
    var cur = runIdx >= 0 ? runIdx + 1 : doneS;
    var live = runIdx >= 0 ? suites[runIdx].done : 0;
    if (runIdx >= 0 && suites[runIdx].total && live > suites[runIdx].total)
        live = suites[runIdx].total;
    return { cur: cur, total: suites.length, qDone: doneQ + live, qTotal: totQ,
             running: runIdx >= 0 ? suites[runIdx] : null };
}
function advancedSection(children, labelKey, labelFb) {
    var adv = el('details', 'bench-advanced');
    var sum = el('summary', null, t(labelKey || 'bench.config.advanced_options',
        labelFb || 'Advanced options'));
    var chev = el('span', 'bench-adv-chev', '▾');
    sum.appendChild(chev);
    adv.appendChild(sum);
    var body = el('div', 'bench-adv-body');
    (children || []).forEach(function (c) { body.appendChild(c); });
    adv.appendChild(body);
    var open = null;
    try { open = localStorage.getItem(ADV_LS); } catch (_) {}
    adv.open = open === '1';   // default closed (classic's details shape)
    sum.setAttribute('aria-expanded', adv.open ? 'true' : 'false');  // U51
    adv.addEventListener('toggle', function () {
        sum.setAttribute('aria-expanded', adv.open ? 'true' : 'false');
        try { localStorage.setItem(ADV_LS, adv.open ? '1' : '0'); } catch (_) {}
    });
    return adv;
}
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
     ['rerank', t('uplift.bench.rerankers', 'Rerankers')],
     ['decision', t('uplift.bench.decision', 'Decision')]].forEach(function (s) {
        var b = el('button', 'native-subtab' + (s[0] === _sub ? ' active' : ''), s[1]);
        b.type = 'button';
        b.dataset.sub = s[0];
        b.addEventListener('click', function () { showSub(s[0]); });
        strip.appendChild(b);
    });
    var panel = el('div', 'native-subpanel');
    panel.id = 'bench-subpanel';
    // BENCHQ: one grid now that the bench tab has a side column — the
    // strip+panel keep their old order inside .bench-col-main (queue empty
    // = single column, i.e. today's markup), the queue box is the sibling
    // column that appears only when the server has something in flight.
    var cols = el('div', 'bench-cols');
    var main = el('div', 'bench-col-main');
    main.append(strip, panel);
    cols.appendChild(main);
    host.appendChild(cols);
    BENCHQ.mount(cols);
    showSub(_sub);
    BENCHQ.start();
}

function showSub(sub) {
    _sub = sub;
    // U60: the strip is a navigation control — mirror it into the URL so a
    // reload (or a shared link) lands on the same benchmark. replaceState
    // (same precedent as applyTab's stale-hash rewrite), NOT location.hash:
    // writing the hash would fire hashchange -> applyTab -> showSub again
    // and re-render the panel a second time per click.
    var want = '#bench/' + sub;
    var w = W();
    // W() guard: node structural harnesses load this module in a vm
    // context without a location stub
    if (w && w.location && w.history && w.location.hash !== want) {
        w.history.replaceState(null, '', w.location.pathname + w.location.search + want);
    }
    document.querySelectorAll('#bench-native .native-subtab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.sub === sub);
    });
    var panel = gid('bench-subpanel');
    if (!panel) return;
    stopStream();
    panel.replaceChildren();
    // BENCHQ: remember the instance we are showing so the queue can hand a
    // run it did not start back to the live panel (discover/repaint).
    _curPanel = null;
    if (sub === 'throughput') _curPanel = TP;
    else if (sub === 'accuracy') _curPanel = ACC;
    else if (sub === 'context') _curPanel = CTX;
    else if (sub === 'ane') _curPanel = ANE;
    else if (sub === 'embed') _curPanel = mtebPanel('embed');
    else if (sub === 'rerank') _curPanel = mtebPanel('rerank');
    else if (sub === 'decision') _curPanel = DEC;
    if (_curPanel) _curPanel.render(panel);
    else panel.appendChild(stubCard(sub));
}

// BENCHQ: MTEB is a factory (embed + rerank share the code), so the live
// instance must be cached per kind — a queue entry that starts running
// while the tab is open has to talk to the panel that is ON SCREEN, not to
// a fresh object with no state.
var _mtebPanels = {};
function mtebPanel(kind) {
    if (!_mtebPanels[kind]) _mtebPanels[kind] = MTEB(kind);
    return _mtebPanels[kind];
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

/* ---- BENCHQ: the global bench queue ---------------------------------------
   Every bench start route (decision / embed / throughput / context /
   accuracy) now answers {queued:true, qid, position} instead of a 409 when
   the server is busy, and serves ONE queue for all of them. The queue is
   server-wide and kind-agnostic, so its box is too: a side column on the
   bench tab that outlives whichever panel started the entry.
   Doctrine copied from the ACC board: poll for truth (a cheap local GET
   every 4s beats trusting one POST response), and poll ONLY while the
   surface is actually on screen — offsetParent is null inside a [hidden]
   page, so a backgrounded tab costs zero requests. */
var BENCHQ_MS = 4000;
// kind -> the subtab's own [key, fallback] (no new vocabulary in the box)
var BENCHQ_KIND_LABEL = {
    decision:   ['uplift.bench.decision', 'Decision'],
    embed:      ['uplift.bench.embeddings', 'Embeddings'],
    rerank:     ['uplift.bench.rerankers', 'Rerankers'],
    throughput: ['navbar.dropdown.performance', 'Throughput'],
    context:    ['navbar.dropdown.context', 'Context'],
    accuracy:   ['navbar.dropdown.accuracy', 'Intelligence'],
    ane:        ['uplift.bench.ane_tune', 'ANE Tune']
};
// kind -> the sub key showSub() uses, for the running-entry hand-back
var BENCHQ_KIND_SUB = { decision: 'decision', embed: 'embed', rerank: 'rerank',
    throughput: 'throughput', context: 'context', accuracy: 'accuracy',
    ane: 'ane' };

var BENCHQ = {
    cols: null, box: null, list: null, timer: null,
    entries: [], _seen: {}, _order: [],

    /* mount builds the (empty, hidden) column: with nothing queued the
       bench tab's DOM stays what it was before this box existed. */
    mount: function (cols) {
        this.cols = cols;
        var box = el('aside', 'bench-queue card');
        box.id = 'bench-queue';
        box.hidden = true;                 // empty queue: no second column
        var head = el('div', 'bench-queue-head',
            t('uplift.bench.queue_title', 'Bench Queue'));
        // U59 doctrine: labels painted before the locale fetch land carry
        // their key + the English shown, so applyI18n() repairs them — the
        // header is built once per mount and never re-rendered by the poll.
        head.dataset.i18n = 'uplift.bench.queue_title';
        head.dataset.en = t('uplift.bench.queue_title', 'Bench Queue');
        box.appendChild(head);
        var list = el('div', 'bench-queue-list acc-queue');
        list.id = 'bench-queue-list';
        box.appendChild(list);
        cols.appendChild(box);
        this.box = box;
        this.list = list;
    },

    start: function () {
        var self = this;
        var w = W();
        // no timers in the vm structural harnesses (and never a second one)
        if (this.timer || !w || typeof w.setInterval !== 'function') return;
        this.timer = w.setInterval(function () { self.tick(); }, BENCHQ_MS);
        this.refresh();                    // first paint, don't wait 4s
    },

    tick: function () { if (this.visible()) this.refresh(); },

    visible: function () {
        if (!this.box) return false;
        var host = gid('bench-native');
        return !!host && host.offsetParent !== null;
    },

    refresh: async function () {
        var d = dom();
        if (!d || !this.box) return;
        var payload;
        try { payload = await d.fetchJson(api() + '/bench/queue'); }
        catch (e) { return; }              // board offline: keep last view
        this.render(payload || {});
    },

    /* render is split from refresh so a harness (and the panel start paths)
       can replay a payload without a server. */
    render: function (payload) {
        if (!this.box) return;
        var self = this;
        var raw = payload.entries || payload.queue || [];
        var entries = raw.filter(function (e) { return e && e.status !== 'done'; });
        // queued -> running transition: hand the run to the panel on screen
        entries.forEach(function (e) {
            var prev = self._seen[e.qid];
            self._seen[e.qid] = e.status;
            if (e.status === 'running' && prev && prev !== 'running')
                self.reattach(e);
        });
        this.entries = entries;
        var alive = {};
        entries.forEach(function (e) { alive[e.qid] = self._seen[e.qid]; });
        this._seen = alive;                // forget removed/finished qids
        var has = entries.length > 0;
        this.box.hidden = !has;
        if (this.cols) {                   // 250px side column only when used
            if (has) this.cols.classList.add('has-q');
            else this.cols.classList.remove('has-q');
        }
        if (!this.list) return;
        // position number = ordinal among the still-queued entries
        var pos = 0;
        var spots = entries.map(function (e) {
            if (e.status === 'queued') pos++;
            return pos;
        });
        var order = entries.map(function (e) { return String(e.qid); });
        var same = this.list.children.length === entries.length
            && order.join('|') === (this._order || []).join('|');
        this._order = order;
        if (same) {
            // ACC board doctrine (U83): repaint text IN PLACE. Replacing the
            // nodes every 4s would eat a hover and can land between a mousedown
            // and its click, which reads as 'the × button does nothing'.
            entries.forEach(function (e, i) {
                self.updateRow(self.list.children[i], e, spots[i]);
            });
            return;
        }
        this.list.replaceChildren();
        entries.forEach(function (e, i) {
            self.list.appendChild(self.row(e, spots[i]));
        });
    },

    rowState: function (e) {
        return e.status === 'running' ? 'running'
             : e.status === 'failed' ? 'failed' : 'queued';
    },

    /* Row children are positional and stable: [badge, main[model, detail],
       status, ×] — updateRow depends on that shape. */
    row: function (e, pos) {
        var self = this;
        var d = dom();
        var body = e.body || {};
        var st = BENCHQ.rowState(e);
        var row = el('div', 'acc-queue-item bench-queue-item ' + st);
        row.dataset.qid = String(e.qid == null ? '' : e.qid);
        var kl = BENCHQ_KIND_LABEL[e.kind];
        var badge = el('span', 'bench-queue-kind',
            kl ? t(kl[0], kl[1]) : String(e.kind || ''));
        if (kl) { badge.dataset.i18n = kl[0]; badge.dataset.en = badge.textContent; }
        row.appendChild(badge);
        var main = el('div', 'bench-queue-main');
        // liberal: the server's label wins, else compose from the body
        var head = (typeof e.label === 'string' && e.label) || body.model_id || '';
        main.appendChild(el('div', 'bench-queue-model', String(head || '—')));
        main.appendChild(el('div', 'bench-queue-detail', BENCHQ.detail(body)));
        row.appendChild(main);
        var stat = el('span', 'bench-queue-status', BENCHQ.statusText(e, pos));
        if (st === 'failed' && e.error) stat.title = String(e.error);
        row.appendChild(stat);
        var rm = el('button', 'acc-queue-remove', '×');
        rm.type = 'button';
        rm.title = t('models.queue.remove_tooltip', 'Remove');
        rm.dataset.i18nTitle = 'models.queue.remove_tooltip';
        rm.dataset.enTitle = rm.title;
        rm.addEventListener('click', async function () {
            try {
                if (d && d.deleteJson)
                    await d.deleteJson(api() + '/bench/queue/'
                        + encodeURIComponent(String(e.qid)));
            } catch (err) {
                if (d) d.toast(String((err && err.message) || err), 'error');
            }
            self.refresh();
        });
        row.appendChild(rm);
        return row;
    },

    updateRow: function (row, e, pos) {
        if (!row || !row.children) return;
        var st = BENCHQ.rowState(e);
        ['running', 'queued', 'failed'].forEach(function (c) {
            if (c === st) row.classList.add(c); else row.classList.remove(c);
        });
        var body = e.body || {};
        var main = row.children[1];
        if (main && main.children) {
            var head = (typeof e.label === 'string' && e.label) || body.model_id || '';
            main.children[0].textContent = String(head || '—');
            main.children[1].textContent = BENCHQ.detail(body);
        }
        var stat = row.children[2];
        if (!stat) return;
        stat.textContent = BENCHQ.statusText(e, pos);
        stat.title = (st === 'failed' && e.error) ? String(e.error) : '';
    },

    /* The body shape differs per kind (packs / tasks / benchmarks / target);
       the row shows whatever identifiers the entry carries. body.kind is NOT
       repeated here — the badge on the left already says it. */
    detail: function (body) {
        var out = [];
        if (Array.isArray(body.packs)) out = out.concat(body.packs);
        if (Array.isArray(body.tasks)) out = out.concat(body.tasks);
        if (body.benchmarks && typeof body.benchmarks === 'object')
            out = out.concat(Object.keys(body.benchmarks));
        if (body.target != null) out.push(String(body.target));
        return out.map(function (s) { return String(s); }).join(', ');
    },

    statusText: function (e, pos) {
        if (e.status === 'running')
            return t('uplift.bench.queue_running', 'Running');
        if (e.status === 'failed')
            return t('uplift.bench.queue_failed', 'Failed');
        var q = t('uplift.bench.queue_queued', 'Queued');
        return pos ? q + ' ' + pos : q;     // position number appended here
    },

    /* A run started from the queue is not the panel's own run: without this
       the live panel keeps saying 'idle' while its benchmark is scoring.
       typeof-guarded — ANE has neither, and the box must never throw. */
    reattach: function (e) {
        if (BENCHQ_KIND_SUB[e.kind] !== _sub) return;
        var p = _curPanel;
        if (!p) return;
        var fn = (typeof p.discover === 'function' ? p.discover
                : typeof p.refreshQueue === 'function' ? p.refreshQueue
                : typeof p.refreshResults === 'function' ? p.refreshResults
                : typeof p.refresh === 'function' ? p.refresh : null);
        if (!fn) return;
        try { fn.call(p); } catch (_) { /* panel repaint is best-effort */ }
    },

    // POST start routes answer {queued:true} while the server is busy
    isQueued: function (out) { return !!(out && out.queued === true); },
    note: function () {
        var d = dom();
        if (d) d.toast(t('uplift.bench.queued', 'Added to queue'));
        BENCHQ.refresh();
    },
};

/* ==========================================================================
   THROUGHPUT (REPL-1) — classic engine driven over /uplift/api/bench/*
   Feature checklist parity with classic _bench.html: model, context
   profile, prompt lengths, batch sizes, ANE-aligned prompt, force lm
   engine, external endpoint mode, run/cancel, live progress + results.
   Native additions: community upload is an explicit opt-IN checkbox
   (classic auto-uploads every standard run; the card demands opt-in).
   tg stays the fixed 128 classic uses (hint shown, no fake control).
   ========================================================================== */

// ---------------------------------------------------------------------------
// U47: classic-shaped text export of throughput results (dashboard.js
// benchBuildText / benchCopyText mirrored line-for-line — users paste this
// into the same threads as classic output, so a prettier-but-different
// format would be a regression). Pure functions, no DOM: unit-tested;
// U49 reuses these for the other panels.
// ---------------------------------------------------------------------------
function fmtNum(value, decimals, suffix) {
    // classic benchFmtNum: unmeasured is N/A, never a misleading 0.0
    if (value === null || value === undefined) return 'N/A';
    return Number(value).toFixed(decimals) + (suffix || '');
}
function fmtMemory(bytes) {
    // classic benchFormatMemory
    if (!bytes || bytes === 0) return '-';
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
}
function outTokens(r) {
    // Measured decode length of a throughput row. Single tests report
    // completion_tokens; batch reports total_gen_tokens (sum over the
    // batch). TG is only ever a ceiling in the row — this is the truth.
    if (r.completion_tokens != null) return r.completion_tokens;
    if (r.total_gen_tokens != null) {
        var bs = r.batch_size || 1;
        return Math.round(r.total_gen_tokens / bs);
    }
    return null;
}
function outCell(r) {
    // 'tg1024' labels what was REQUESTED. Show what the model GENERATED;
    // when the run ended early (external endpoints, spec-decode engines)
    // the fraction says so instead of the row silently lying.
    var out = outTokens(r);
    if (out == null) return '\u2014';
    if (r.tg != null && out < r.tg) return out + '/' + r.tg;
    return String(out);
}
function contextLabel(profile) {
    var keys = { code_python: 'Code (Python)', code_mixed: 'Code (Mixed)',
        novel_ko: 'Novel (Korean)', novel_en: 'Novel (English)',
        novel_ja: 'Novel (Japanese)' };
    return t('bench.config.context.' + profile, keys[profile] || keys.code_python);
}
function singleTestLabel(r) {
    var requested = r.requested_pp != null ? r.requested_pp : r.pp;
    if (requested !== r.pp) {
        return t('bench.results.test.requested', 'pp{actual} (requested pp{requested})/tg{tg}')
            .replace('{actual}', r.pp).replace('{requested}', requested)
            .replace('{tg}', r.tg);
    }
    return t('bench.results.test.plain', 'pp{actual}/tg{tg}')
        .replace('{actual}', r.pp).replace('{tg}', r.tg);
}
function batchPromptSummary(rows) {
    // classic benchBatchPromptSummary (first batch row carries the pp summary)
    var result = rows[0];
    if (!result || result.requested_pp === undefined) {
        return t('bench.results.batch.subtitle', 'pp1024 / tg128');
    }
    var requested = result.requested_pp;
    var minimum = result.prompt_tokens_min != null ? result.prompt_tokens_min : result.pp;
    var maximum = result.prompt_tokens_max != null ? result.prompt_tokens_max : result.pp;
    var actual = minimum === maximum
        ? t('bench.results.batch.actual_pp', 'actual pp{pp}').replace('{pp}', minimum)
        : t('bench.results.batch.actual_pp_range', 'actual pp{min}-{max}')
            .replace('{min}', minimum).replace('{max}', maximum);
    return t('bench.results.batch.requested_summary',
             'requested pp{requested} / {actual} / tg{tg}')
        .replace('{requested}', requested).replace('{actual}', actual)
        .replace('{tg}', result.tg);
}
function buildThroughputText(ctx, rows) {
    // ctx: {model, profile, forceLm, external:{model}|null} — NEVER the
    // endpoint URL or key (classic prints model @ url for external runs;
    // the base_url may embed credentials in the query, so external runs
    // identify by model only — honest and safe; recorded on the card)
    var pad = function (s, w) { return String(s).padStart(w); };
    var rpad = function (s, w) { return String(s).padEnd(w); };
    var lines = [];
    lines.push(t('bench.results.text_export.title', 'oMLX - {tagline}')
        .replace('{tagline}', t('app.tagline', 'LLM inference, optimized for your Mac')));
    lines.push('https://github.com/jundot/omlx');
    if (ctx.external) {
        lines.push(t('bench.results.text_export.benchmark_model', 'Benchmark Model: {model}')
            .replace('{model}', ctx.external.model));
        lines.push(t('bench.results.text_export.engine_external',
                     'Engine: External OpenAI-compatible endpoint'));
    } else {
        lines.push(t('bench.results.text_export.benchmark_model', 'Benchmark Model: {model}')
            .replace('{model}', ctx.model));
        lines.push(ctx.forceLm
            ? t('bench.results.text_export.engine_force_lm', 'Engine: Force mlx-lm')
            : t('bench.results.text_export.engine_auto', 'Engine: Auto'));
    }
    lines.push(t('bench.results.text_export.context', 'Context: {context}')
        .replace('{context}', contextLabel(ctx.profile)));
    lines.push('='.repeat(80));
    var singles = (rows || []).filter(function (r) { return r.test_type !== 'batch'; });
    var batch = (rows || []).filter(function (r) { return r.test_type === 'batch'; });
    if (singles.length) {
        lines.push('');
        lines.push(t('bench.results.single.section_label', 'Single Request Results'));
        lines.push('-'.repeat(80));
        lines.push([
            rpad(t('bench.results.single.test', 'Test'), 32),
            pad('TTFT(ms)', 10), pad('TPOT(ms)', 10), pad('pp TPS', 12),
            pad('tg TPS', 12), pad('E2E(s)', 10),
            pad(t('bench.results.single.throughput', 'Throughput'), 12),
            pad(t('bench.results.single.peak_mem', 'Peak Mem'), 10),
        ].join('  '));
        singles.forEach(function (r) {
            lines.push([
                rpad(singleTestLabel(r), 32),
                pad(fmtNum(r.ttft_ms, 1), 10),
                pad(fmtNum(r.tpot_ms, 2), 10),
                pad(fmtNum(r.processing_tps, 1, ' tok/s'), 12),
                pad(fmtNum(r.gen_tps, 1, ' tok/s'), 12),
                pad(r.e2e_latency_s == null ? 'N/A' : Number(r.e2e_latency_s).toFixed(3), 10),
                pad(fmtNum(r.total_throughput, 1, ' tok/s'), 12),
                pad(fmtMemory(r.peak_memory_bytes), 10),
            ].join('  '));
        });
    }
    if (batch.length) {
        var baseline = null;
        for (var bi = 0; bi < singles.length; bi++) {
            var bpp = singles[bi].requested_pp != null ? singles[bi].requested_pp : singles[bi].pp;
            if (bpp === 1024) { baseline = singles[bi]; break; }
        }
        lines.push('');
        lines.push(t('bench.results.batch.title', 'Continuous Batching'));
        lines.push(batchPromptSummary(batch));
        lines.push('-'.repeat(80));
        lines.push([
            rpad(t('bench.results.text_export.batch', 'Batch'), 8),
            pad('tg TPS', 12), pad(t('bench.results.batch.speedup', 'Speedup'), 8),
            pad('pp TPS', 12), pad('pp TPS/req', 12), pad('TTFT(ms)', 10), pad('E2E(s)', 10),
        ].join('  '));
        if (baseline) {
            lines.push([
                rpad('1x', 8),
                pad(fmtNum(baseline.gen_tps, 1, ' tok/s'), 12),
                pad('1.00x', 8),
                pad(fmtNum(baseline.processing_tps, 1, ' tok/s'), 12),
                pad(fmtNum(baseline.processing_tps, 1, ' tok/s'), 12),
                pad(fmtNum(baseline.ttft_ms, 1), 10),
                pad(baseline.e2e_latency_s == null ? 'N/A' : Number(baseline.e2e_latency_s).toFixed(3), 10),
            ].join('  '));
        }
        batch.forEach(function (r) {
            var speedup = (baseline && baseline.gen_tps > 0 && r.tg_tps != null)
                ? r.tg_tps / baseline.gen_tps : null;
            var ppPerReq = (r.pp_tps == null) ? null : r.pp_tps / r.batch_size;
            lines.push([
                rpad(r.batch_size + 'x', 8),
                pad(fmtNum(r.tg_tps, 1, ' tok/s'), 12),
                pad(speedup != null ? speedup.toFixed(2) + 'x'
                    : t('bench.results.text_export.not_available', 'N/A'), 8),
                pad(fmtNum(r.pp_tps, 1, ' tok/s'), 12),
                pad(fmtNum(ppPerReq, 1, ' tok/s'), 12),
                pad(fmtNum(r.avg_ttft_ms, 1), 10),
                pad(r.e2e_latency_s == null ? 'N/A' : Number(r.e2e_latency_s).toFixed(3), 10),
            ].join('  '));
        });
    }
    return lines.join('\n');
}
// classic benchCopyText: clipboard with the same textarea fallback the
// chat panel uses (plain-http boards have no navigator.clipboard).
function copyTextFallback(s) {
    var ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
}
// U49: generic padded table text for the panels without a classic export
// (MTEB/Decision) — same look as the classic throughput block: header line
// + one row per result, columns separated by two spaces, right-aligned
// numbers. Cells arrive pre-formatted (UI shows exactly what copies).
// U49: Field/Value pairs for the context card's Copy (labels match the
// rendered rows; the row carries the model_id when the engine stored it)
function ctxResultPairs(models, r) {
    var mid = r.model_id || '';
    var pairs = [];
    if (mid) pairs.push(['Model', mid]);
    pairs.push(['Target', (r.target_tokens || 0).toLocaleString() + ' tokens']);
    pairs.push(['Admission boundary', (r.measured_tokens || 0).toLocaleString() + ' tokens']);
    pairs.push(['Verified prefill', (r.verified_tokens || 0).toLocaleString() + ' tokens']);
    pairs.push(['Applied to Context Window', (r.applied_tokens || 0).toLocaleString() + ' tokens']);
    pairs.push(['Capped by', r.capped_by || '\u2014']);
    pairs.push(['Prefill speed', Math.round(r.prefill_tps || 0).toLocaleString() + ' tok/s']);
    pairs.push(['Duration', (r.duration_s || 0) + ' s']);
    return pairs;
}
function buildTableText(headerLines, cols, rows) {
    var lines = (headerLines || []).slice();
    if (!rows.length) return lines.join('\n');
    var widths = cols.map(function (c) { return c.label.length; });
    var cells = rows.map(function (r, ri) {
        return cols.map(function (c, ci) {
            var s = c.get(r, ri);
            widths[ci] = Math.max(widths[ci], s.length);
            return s;
        });
    });
    lines.push(cols.map(function (c, ci) {
        return c.numeric ? c.label.padStart(widths[ci]) : c.label.padEnd(widths[ci]);
    }).join('  '));
    cells.forEach(function (row) {
        lines.push(row.map(function (s, ci) {
            return cols[ci].numeric ? s.padStart(widths[ci]) : s.padEnd(widths[ci]);
        }).join('  ').trimEnd());
    });
    return lines.join('\n');
}
// U49: classic accBuildText mirror (dashboard.js:5358) — comparison matrix
// + per-model detail. Native rows carry the same accumulated-result shape.
function buildAccuracyText(rows, groups) {
    if (!rows.length) return '';
    var pad = function (s, w) { return String(s).padStart(w); };
    var rpad = function (s, w) { return String(s).padEnd(w); };
    var models = []; rows.forEach(function (r) {
        if (models.indexOf(r.model_id) < 0) models.push(r.model_id); });
    var benches = []; rows.forEach(function (r) {
        if (benches.indexOf(r.benchmark) < 0) benches.push(r.benchmark); });
    var lookup = {};
    rows.forEach(function (r) {
        (lookup[r.model_id] = lookup[r.model_id] || {})[r.benchmark] = r; });
    var fullSizes = {};
    (groups || []).forEach(function (g) {
        (g.tasks || []).forEach(function (tk) { fullSizes[tk.key] = tk.full_size; }); });
    var modelWidth = Math.max.apply(null, [12].concat(models.map(function (m) { return m.length + 2; })));
    var modeW = 8, sampledW = 14;
    var benchWidth = Math.max.apply(null, [14].concat(benches.map(function (b) { return b.length + 2; })));
    var lines = [];
    lines.push(t('acc_bench.results.comparison_title', 'Intelligence Benchmark Comparison'));
    lines.push('');
    var header = rpad('', benchWidth)
        + rpad(t('acc_bench.results.text_export.mode', 'Mode'), modeW)
        + rpad(t('acc_bench.results.text_export.sampled', 'Sampled'), sampledW);
    models.forEach(function (m) { header += pad(m, modelWidth); });
    lines.push(header);
    lines.push('-'.repeat(benchWidth + modeW + sampledW + models.length * modelWidth));
    benches.forEach(function (b) {
        var sample = null;
        for (var mi = 0; mi < models.length && !sample; mi++) {
            sample = (lookup[models[mi]] || {})[b] || null; }
        var total = (sample && sample.total) || 0;
        var full = fullSizes[b] || 0;
        var isFull = total >= full;
        var mode = isFull ? t('acc_bench.results.text_export.full', 'Full')
                          : t('acc_bench.results.text_export.sample', 'Sample');
        var sampledStr = isFull ? String(full) : (total + '/' + full);
        var row = rpad(b.toUpperCase(), benchWidth) + rpad(mode, modeW) + rpad(sampledStr, sampledW);
        models.forEach(function (m) {
            var r = (lookup[m] || {})[b];
            row += pad(r ? (r.accuracy * 100).toFixed(1) + '%' : '-', modelWidth); });
        lines.push(row);
    });
    lines.push('');
    lines.push(t('acc_bench.results.text_export.detail', '--- Detail ---'));
    models.forEach(function (m) {
        lines.push('');
        lines.push(t('acc_bench.results.text_export.model', 'Model: {model}')
            .replace('{model}', function () { return m; }));  // fn replacer:
            // a model id with $ patterns must not act as a replace pattern
            // (classic dashboard.js uses the same function form)
        lines.push(rpad(t('acc_bench.results.text_export.benchmark', 'Benchmark'), 16)
            + pad(t('acc_bench.results.text_export.accuracy', 'Accuracy'), 10)
            + pad(t('acc_bench.results.text_export.correct', 'Correct'), 10)
            + pad(t('acc_bench.results.text_export.total', 'Total'), 8)
            + pad('Time(s)', 10)
            + pad(t('acc_bench.results.text_export.think', 'Think'), 8));
        lines.push('-'.repeat(62));
        rows.filter(function (r) { return r.model_id === m; }).forEach(function (r) {
            lines.push(
                rpad(String(r.benchmark).toUpperCase(), 16)
                + pad((r.accuracy * 100).toFixed(1) + '%', 10)
                + pad(r.correct, 10) + pad(r.total, 8) + pad(r.time_s, 10)
                + pad(r.thinking_used
                    ? t('acc_bench.results.text_export.yes', 'Yes')
                    : t('acc_bench.results.text_export.no', 'No'), 8));
            if (r.external) {
                lines.push(t('acc_bench.results.text_export.external_detail',
                    '  Valid responses: {valid}/{total} ({rate}%) · Valid-answer accuracy: {accuracy}% · Empty: {empty} · Truncated: {truncated} · Timeout: {timeout} · HTTP: {http} · Connection: {connection} · Invalid: {invalid} · Parse: {parse}')
                    .replace('{valid}', r.valid_response_count)
                    .replace('{total}', r.total)
                    .replace('{rate}', (r.valid_response_rate * 100).toFixed(1))
                    .replace('{accuracy}', (r.valid_answer_accuracy * 100).toFixed(1))
                    .replace('{empty}', r.empty_content_count)
                    .replace('{truncated}', r.truncated_count)
                    .replace('{timeout}', r.timeout_count)
                    .replace('{http}', r.http_error_count)
                    .replace('{connection}', r.connection_error_count)
                    .replace('{invalid}', r.invalid_response_count)
                    .replace('{parse}', r.parse_error_count));
            }
        });
    });
    return lines.join('\n');
}
function copyPlainText(text, okMsg) {
    var d = dom();
    // NOTE: domkit.toast is (text, ms, cls) — the (msg,'error') two-arg
    // calls scattered through this module are a U51 finding; using the
    // documented single-arg form here.
    var onSuccess = function () { if (okMsg && d) d.toast(okMsg); };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(onSuccess, function () {
            copyTextFallback(text); onSuccess();
        });
    } else {
        copyTextFallback(text); onSuccess();
    }
}

/* U64: persistent run history for the one-run-per-surface panels
   (throughput/context/ANE). The server snapshots every finished run into
   ~/.omlx/uplift/bench-history/<surface>/history.json; the panel lists
   them below the live result, collapsed per run, each with its own Copy.
   Accuracy/Embeddings/Decision already accumulate rows across runs — they
   needed storage, not UI. */
/* U64: result tables for every persistent panel.
   cols = [rowKey, head, getter?, tooltip?, i18n?]; the 4th element is the
   classic bench_th() hover text (th title), the 5th carries the catalog keys
   so applyI18n re-resolves head and title when the locale arrives late.
   cls adds a modifier class (tp-table) without touching the shared one. */
function simpleTable(cols, rows, cls) {
    var tbl = el('table', cls ? 'bench-table ' + cls : 'bench-table');
    var head = el('tr');
    cols.forEach(function (c) {
        var th = el('th', null, c[1]);
        if (c[3]) th.title = c[3];
        var i18n = c[4];
        if (i18n && i18n.k) {
            th.dataset.i18n = i18n.k;
            th.dataset.en = i18n.en != null ? i18n.en : c[1];
        }
        if (i18n && i18n.tk) {
            th.dataset.i18nTitle = i18n.tk;
            th.dataset.enTitle = i18n.ten || c[3] || '';
        }
        head.appendChild(th);
    });
    tbl.appendChild(head);
    rows.forEach(function (r) {
        var tr = el('tr');
        cols.forEach(function (c) {
            var v = r[c[0]];
            tr.appendChild(el('td', null, c[2] ? c[2](v, r)
                : (v == null ? '\u2014' : String(v))));
        });
        tbl.appendChild(tr);
    });
    return tbl;
}

function historyEmptyNote() {
    var pE = el('p', 'native-stub-note',
        t('uplift.bench.history.empty', 'No completed tests.'));
    pE.dataset.i18n = 'uplift.bench.history.empty';
    pE.dataset.en = pE.textContent;      // U59: late catalog repair
    return pE;
}

function loadHistory(surface, hostId, buildBody, excludeId) {
    var host = gid(hostId);
    if (!host) return Promise.resolve();
    var d = dom();
    return d.fetchJson(api() + '/bench/history?surface=' + encodeURIComponent(surface))
        .then(function (p) {
            host.replaceChildren();
            var es = (p.entries || []).slice().reverse()    // newest first
                .filter(function (e) { return !excludeId || String(e.id) !== String(excludeId); });
            if (!es.length) return;
            var hLab = el('div', 'bench-label acc-grid-label',
                t('uplift.bench.history.title', 'History'));
            hLab.dataset.i18n = 'uplift.bench.history.title';
            hLab.dataset.en = hLab.textContent;      // U59: late catalog
            host.appendChild(hLab);
            var head = el('div', 'bench-results-head');
            var clear = el('button', 'btn', t('uplift.bench.history.clear', 'Clear history'));
            clear.dataset.i18n = 'uplift.bench.history.clear';
            clear.dataset.en = clear.textContent;    // U59: late catalog
            clear.type = 'button';
            clear.addEventListener('click', function () {
                d.postJson(api() + '/bench/history/clear', { surface: surface })
                    .then(function () {
                        d.toast(t('uplift.bench.history.cleared', 'History cleared'));
                        loadHistory(surface, hostId, buildBody, excludeId);
                    })
                    .catch(function (e) { d.toast(String((e && e.message) || e), 'error'); });
            });
            head.appendChild(clear);
            host.appendChild(head);
            es.forEach(function (e) {
                var det = el('details', 'bench-history-item');
                var when = e.ts ? new Date(e.ts * 1000).toLocaleString() : '';
                var sum = el('summary', null,
                    when + ' \u00b7 ' + (e.model_id || '') +
                    (e.status && e.status !== 'completed'
                        ? ' \u00b7 ' + e.status.toUpperCase() : ''));
                det.appendChild(sum);
                det.appendChild(buildBody(e));
                host.appendChild(det);
            });
        })
        .catch(function () { /* history is an affordance */ });
}

// U70: file download via Blob (no deps; same primitive classic uses).
// NEVER put base URLs or keys in file content — model id only, the same
// credential rule as the Copy exports.
function dlFile(name, mime, text) {
    var w = W();
    if (!w || !w.URL || typeof w.document === 'undefined') return false;
    var blob = new w.Blob([text], { type: mime });
    var url = w.URL.createObjectURL(blob);
    var a = w.document.createElement('a');
    a.href = url; a.download = name;
    w.document.body.appendChild(a);
    a.click();
    // Safari/Firefox read the blob URL asynchronously after click() —
    // revoking synchronously here silently kills the download (embed
    // bench 'Download does nothing', user 2026-10-13). Detach lazily.
    w.setTimeout(function () {
        a.remove();
        w.URL.revokeObjectURL(url);
    }, 4000);
    return true;
}

function dlJson(nameBase, value) {
    return dlFile(nameBase + '.json', 'application/json',
        JSON.stringify(value, null, 2));
}

// CSV from a column spec — shared by every surface's Download CSV and
// U-CPY clipboard CSV (identical escaping, one source of truth)
function csvText(cols, rows) {
    var esc = function (x) {
        if (x == null) return '';
        return '"' + String(x).replace(/"/g, '""') + '"';
    };
    var out = [cols.map(function (c) { return c.head; }).join(',')];
    rows.forEach(function (r) {
        out.push(cols.map(function (c) {
            var v = c.get(r);
            return typeof v === 'number' ? String(v) : esc(v);
        }).join(','));
    });
    return out.join('\n');
}
function dlCsv(nameBase, cols, rows) {
    return dlFile(nameBase + '.csv', 'text/csv', csvText(cols, rows));
}

// U-CPY: GitHub-flavoured Markdown table from the same [head,get] spec
function toMarkdown(cols, rows) {
    var esc = function (x) {
        return (x == null ? '' : String(x)).split('|').join('\\|');
    };
    var lines = ['| ' + cols.map(function (c) { return c.head; }).join(' | ') + ' |',
                 '|' + cols.map(function () { return ' --- '; }).join('|') + '|'];
    rows.forEach(function (r) {
        lines.push('| ' + cols.map(function (c) { return esc(c.get(r)); }).join(' | ') + ' |');
    });
    return lines.join('\n');
}

// Classic accDownloadResult ported 1:1 (dashboard.js) — field lists, the
// external/local CSV header split, TXT line order and the classic i18n
// keys, so files from native and classic are interchangeable.
var ACC_EXPORT_COLS = {
    local: 'id,category,correct,expected,predicted,question,raw_response,time_s,finish_reason,completion_tokens',
    external: 'id,category,status,correct,expected,predicted,finish_reason,reasoning_fields,prompt_tokens,completion_tokens,error_message,question,raw_response,time_s',
};
function accExportJson(r) {
    var qr = r.question_results || [];
    var out = {
        model_id: r.model_id, benchmark: r.benchmark, accuracy: r.accuracy,
        correct: r.correct, total: r.total, time_s: r.time_s,
        thinking_used: r.thinking_used || false,
        category_scores: r.category_scores || null,
        questions: qr,
    };
    if (r.engine) out.engine = r.engine;   // native addition: which twin ran
    if (r.external) {
        ['valid_response_count', 'empty_content_count', 'truncated_count',
         'timeout_count', 'http_error_count', 'connection_error_count',
         'invalid_response_count', 'parse_error_count', 'wrong_count',
         'valid_response_rate', 'valid_answer_accuracy',
         'reliability_warning'].forEach(function (k) {
            if (r[k] !== undefined) out[k] = r[k];
        });
    } else if (r.truncated_count !== undefined) {
        ['truncated_count', 'truncated_correct_count', 'finished_count',
         'finished_accuracy'].forEach(function (k) {
            if (r[k] !== undefined) out[k] = r[k];
        });
    }
    return JSON.stringify(out, null, 2);
}
function accExportCsv(r) {
    var esc = function (x) {
        if (x == null) return '';
        return '"' + String(x).replace(/"/g, '""') + '"';
    };
    var qr = r.question_results || [];
    var lines = [r.external ? ACC_EXPORT_COLS.external : ACC_EXPORT_COLS.local];
    qr.forEach(function (q) {
        if (r.external) {
            lines.push([q.id, esc(q.category || ''), esc(q.status || ''),
                q.correct, esc(q.expected), esc(q.predicted),
                esc(q.finish_reason || ''),
                esc((q.reasoning_fields_nonempty || []).join('|')),
                q.prompt_tokens || 0, q.completion_tokens || 0,
                esc(q.error_message || ''), esc(q.question),
                esc(q.raw_response), q.time_s].join(','));
        } else {
            lines.push([q.id, esc(q.category || ''), q.correct,
                esc(q.expected), esc(q.predicted), esc(q.question),
                esc(q.raw_response), q.time_s, esc(q.finish_reason || ''),
                q.completion_tokens == null ? '' : q.completion_tokens
            ].join(','));
        }
    });
    return lines.join('\n');
}
function accExportTxt(r) {
    var sub = function (key, vars) {
        var line = t(key, key);
        Object.keys(vars || {}).forEach(function (k) {
            line = line.split('{' + k + '}').join(String(vars[k]));
        });
        return line;
    };
    var qr = r.question_results || [];
    var lines = [
        sub('acc_bench.results.text_export.model', { model: r.model_id }),
        sub('acc_bench.results.text_export.benchmark_line',
            { benchmark: String(r.benchmark || '').toUpperCase() }),
        sub('acc_bench.results.text_export.accuracy_line',
            { accuracy: ((r.accuracy || 0) * 100).toFixed(1),
              correct: r.correct, total: r.total }),
        sub('acc_bench.results.text_export.time_line', { seconds: r.time_s }),
    ];
    if (r.external) {
        lines.push(
            sub('acc_bench.results.text_export.valid_responses_line',
                { valid: r.valid_response_count, total: r.total,
                  rate: ((r.valid_response_rate || 0) * 100).toFixed(1) }),
            sub('acc_bench.results.text_export.valid_answer_accuracy_line',
                { accuracy: ((r.valid_answer_accuracy || 0) * 100).toFixed(1) }),
            sub('acc_bench.results.text_export.external_summary',
                { empty: r.empty_content_count, truncated: r.truncated_count,
                  timeout: r.timeout_count, http: r.http_error_count,
                  connection: r.connection_error_count,
                  invalid: r.invalid_response_count,
                  parse: r.parse_error_count }));
    } else if (r.truncated_count > 0) {
        lines.push(sub('acc_bench.results.text_export.local_truncation_line',
            { truncated: r.truncated_count, total: r.total,
              truncated_correct: r.truncated_correct_count,
              accuracy: r.finished_accuracy == null
                  ? '\u2014' : (r.finished_accuracy * 100).toFixed(1) + '%',
              finished: r.finished_count }));
    }
    lines.push('');
    qr.forEach(function (q) {
        var label = r.external ? (q.status || 'invalid_response').toUpperCase()
                               : (q.correct ? 'CORRECT' : 'WRONG');
        lines.push(sub('acc_bench.results.text_export.question_header',
            { id: q.id, label: label }));
        if (q.category) {
            lines.push(sub('acc_bench.results.text_export.category_line',
                { category: q.category }));
        }
        if (q.finish_reason && (r.external || q.finish_reason !== 'stop')) {
            lines.push(sub('acc_bench.results.text_export.finish_reason_line',
                { reason: q.finish_reason }));
        }
        if (r.external && (q.reasoning_fields_nonempty || []).length) {
            lines.push(sub('acc_bench.results.text_export.reasoning_fields_line',
                { fields: q.reasoning_fields_nonempty.join(', ') }));
        }
        if (r.external && q.error_message) {
            lines.push(sub('acc_bench.results.text_export.error_line',
                { error: q.error_message }));
        }
        lines.push(sub('acc_bench.results.text_export.question_line',
            { question: q.question || '' }));
        lines.push(sub('acc_bench.results.text_export.expected_line',
            { expected: q.expected }));
        lines.push(sub('acc_bench.results.text_export.predicted_line',
            { predicted: q.predicted }));
        lines.push(sub('acc_bench.results.text_export.raw_response_line',
            { response: q.raw_response
                || t('acc_bench.results.text_export.empty_value', '(empty)') }));
        lines.push(sub('acc_bench.results.text_export.time_line',
            { seconds: q.time_s }));
        lines.push('');
    });
    return lines.join('\n');
}

// Download menu (classic's per-row JSON/CSV/TXT), labels via the SAME
// classic keys so they translate with the merged catalog
function dlMenu(makeName, formats) {
    var wrap = el('span', 'bench-dl');
    var btn = el('button', 'btn tiny', t('acc_bench.results.download', 'Download'));
    btn.type = 'button';
    var open = null;
    btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (open) { open.remove(); open = null; return; }
        open = el('div', 'bench-dl-menu');
        formats.forEach(function (f) {
            var b = el('button', null, t(f[1], f[2]));
            b.type = 'button';
            b.addEventListener('click', function (ev2) {
                ev2.stopPropagation();
                // close BEFORE the action: the action's synthetic anchor
                // click bubbles to document and fires our dismiss — a
                // stale `open.remove()` after it threw TypeError (2026-10-13)
                var o = open; open = null;
                if (o) o.remove();
                f[0](makeName());
            });
            open.appendChild(b);
        });
        wrap.appendChild(open);
        var dismiss = function () {
            if (open) { open.remove(); open = null; }
            document.removeEventListener('click', dismiss);
        };
        setTimeout(function () { document.addEventListener('click', dismiss); }, 0);
    });
    wrap.appendChild(btn);
    return wrap;
}

// U-CPY: one dropdown pattern for the results-head buttons (classic's
// bench-dl-menu styling). entries = [[i18nKey, fallback, onClick], ...]
function dropMenu(host, btn, entries) {
    var open = null;
    btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (open) { open.remove(); open = null; return; }
        open = el('div', 'bench-dl-menu');
        entries.forEach(function (f) {
            var b = el('button', null, t(f[0], f[1]));
            b.type = 'button';
            b.addEventListener('click', function (ev2) {
                ev2.stopPropagation();
                // close BEFORE the action — same document-dismiss race
                // as dlMenu (anchor click bubbles; stale open.remove()
                // threw TypeError after every download, 2026-10-13)
                var o = open; open = null;
                if (o) o.remove();
                f[2]();
            });
            open.appendChild(b);
        });
        host.appendChild(open);
        var dismiss = function () {
            if (open) { open.remove(); open = null; }
            document.removeEventListener('click', dismiss);
        };
        setTimeout(function () { document.addEventListener('click', dismiss); }, 0);
    });
    host.appendChild(btn);
}

/* ---- U-TERM (user 2026-10-13): column explainers ----------------------
   'Brier', 'ECE', 'Agreement' and the two latency flavours are jargon; the
   decision table now puts a '?' marker in those headers that opens a
   one-sentence popover. Same dismiss contract as dropMenu (outside click,
   via the deferred document listener so the opening click cannot close it)
   plus Escape for the keyboard. The text is set with textContent — never
   innerHTML — and carries data-i18n + data-en exactly like taskCard, so
   applyI18n() re-resolves an explainer that was painted before the locale
   catalog arrived. Only one popover is open at a time. */
var _helpPop = null, _helpKey = null;
function helpPopClose() {
    if (!_helpPop) return;
    var p = _helpPop; _helpPop = null; _helpKey = null;
    p.remove();
    document.removeEventListener('click', helpPopClose);
    document.removeEventListener('keydown', helpPopKey);
}
function helpPopKey(ev) { if (ev.key === 'Escape') helpPopClose(); }
function thHelp(label, i18nKey, fallbackText) {
    var th = el('th', 'bench-th');
    th.appendChild(document.createTextNode(label));
    var btn = el('button', 'bench-help-btn', '?');
    btn.type = 'button';
    btn.setAttribute('aria-label',
        t('uplift.bench.help_aria', 'What does this column mean?'));
    btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var wasOpen = (_helpKey === i18nKey);
        helpPopClose();
        if (wasOpen) return;                       // the marker toggles itself
        var pop = el('div', 'bench-help-pop');
        pop.textContent = t(i18nKey, fallbackText);
        pop.dataset.i18n = i18nKey;
        pop.dataset.en = fallbackText;
        pop.setAttribute('role', 'tooltip');
        th.appendChild(pop);
        _helpPop = pop; _helpKey = i18nKey;
        setTimeout(function () {
            // the deferred arm must re-check: a fast toggle can close this
            // pop before the timer runs, and a stale document listener would
            // then hang around for the life of the page
            if (_helpPop !== pop) return;
            document.addEventListener('click', helpPopClose);
            document.addEventListener('keydown', helpPopKey);
        }, 0);
    });
    th.appendChild(btn);
    return th;
}

// U49: shared Copy/Download factory for all result cards (classic's export
// blocks all say the same 'Copy' with the section label as hover text).
// U-CPY (user 2026-10-13): Copy is a 3-format menu — Markdown, CSV, table
// (plaintext for monospace) — whenever the panel carries a dl column spec;
// panels without one keep the single legacy plaintext-copy button.
function resultsHead(buildText, titleKey, titleFb, dl) {
    var head = el('div', 'bench-results-head');
    var btn = el('button', 'btn', t('bench.results.text_export.copy', 'Copy'));
    btn.type = 'button';
    btn.title = t(titleKey || 'bench.results.text_export.section_label',
                  titleFb || 'Benchmark Results (Text — Copy & Paste)');
    var copyTable = function () {
        copyPlainText(buildText(),
            t('bench.results.text_export.copied', 'Copied!'));
    };
    if (dl && dl.cols && dl.rows) {
        dropMenu(head, btn, [
            ['uplift.bench.copy_markdown', 'Markdown', function () {
                copyPlainText(toMarkdown(dl.cols(), dl.rows()),
                    t('bench.results.text_export.copied', 'Copied!'));
            }],
            ['acc_bench.results.download_csv', 'CSV', function () {
                copyPlainText(csvText(dl.cols(), dl.rows()),
                    t('bench.results.text_export.copied', 'Copied!'));
            }],
            ['uplift.bench.copy_table', 'Table (text)', copyTable],
        ]);
    } else {
        btn.addEventListener('click', copyTable);
        head.appendChild(btn);
    }
    // U70: whole-result set downloads for EVERY surface (user asked for
    // classic's availability everywhere, not just Intelligence). dl =
    // {name(): file stem, rows(), cols(): [{head, get}]}
    if (dl) {
        var dlBtn = el('button', 'btn', t('acc_bench.results.download', 'Download'));
        dlBtn.type = 'button';
        dropMenu(head, dlBtn, [
            ['acc_bench.results.download_json', 'JSON',
             function () { dlJson(dl.name(), dl.rows()); }],
            ['acc_bench.results.download_csv', 'CSV',
             function () { dlCsv(dl.name(), dl.cols(), dl.rows()); }],
        ]);
    }
    return head;
}

// U70: standard cols from the shared [key, label] tables
function dlCols(defs) {
    return defs.map(function (c) {
        return { head: c[1], get: function (r) { return c[2] ? c[2](r) : r[c[0]]; } };
    });
}

/* ---------------------------------------------------------------------------
   TP-TABLES (user items 2 + 5): the throughput result set is the SAME two
   tables classic shows — 'Single Request Results' and 'Continuous Batching' —
   in classic's column order, with classic's header names (bench.results.*)
   and classic's header tooltips (bench.metrics.*.tooltip, the info icon's
   hover text). The merged single-table this replaced read single-only keys
   off batch rows, so TTFT/TPOT/Throughput printed dashes for every batch
   line, and it had no memory column at all.
   The specs are PURE data (rows in, column descriptors out) so node tests can
   pin the header order/keys/tooltips DOM-free; buildTpTables only paints them
   and is the single path BOTH the live panel and the history cards use —
   live and history can no longer drift from each other or from classic.
   Native addition kept: the measured 'out' column, as the LAST extra column
   of both tables (rows predating token accounting keep outCell's dash).
   --------------------------------------------------------------------------- */
function tpIsBatch(r) { return !!(r && r.test_type === 'batch'); }
function tpSingles(rows) {
    return (rows || []).filter(function (r) { return !tpIsBatch(r); });
}
function tpBatch(rows) { return (rows || []).filter(tpIsBatch); }
function tpBaseline(singles) {
    // classic benchFindSingle(1024): the REQUESTED prompt length, not the
    // clamped one the runner actually measured
    for (var i = 0; i < (singles || []).length; i++) {
        var r = singles[i];
        var pp = r.requested_pp != null ? r.requested_pp : r.pp;
        if (pp === 1024) return r;
    }
    return null;
}
function tpPpPerReq(r) {
    // classic benchPpPerReq: null when the aggregate itself is unmeasured
    if (r.pp_tps == null) return null;
    return r.pp_tps / (r.batch_size || 1);
}
/* Catalog-only tooltip: the classic bench.metrics.*.tooltip strings ship in
   every locale, so a missing key renders NO tooltip rather than leaking the
   raw key into the title attribute. New uplift keys pass an English fallback
   (repo doctrine) and are the only ones carrying one. */
function tpTip(key, en) {
    var c = C();
    var v = (c && c.t) ? c.t(key) : null;
    if (v && v !== key) return v;
    return en || '';
}
// One column: row key, catalog head [+tooltip], the cell formatter, and the
// table it belongs to (kind: null = shared by both, e.g. the native 'out').
function tpCol(kind, rowKey, headKey, headEn, tipKey, tipEn, get) {
    return {
        kind: kind, key: rowKey,
        headKey: headKey, headEn: headEn,
        head: headKey ? t(headKey, headEn) : headEn,
        tipKey: tipKey, tipEn: tipEn || '',
        tip: tipKey ? tpTip(tipKey, tipEn) : '',
        get: get,
    };
}
// classic benchFmtNum/benchFormatMemory mirroring — the same cell texts the
// text export (buildThroughputText) prints, so table and Copy agree.
function tpSingleDefs(base) {
    return [
        tpCol('single', 'test', 'bench.results.single.test', 'Test',
              'bench.metrics.test.tooltip', '',
              function (r) { return singleTestLabel(r); }),
        tpCol('single', 'ttft_ms', 'bench.results.single.ttft', 'TTFT (ms)',
              'bench.metrics.ttft.tooltip', '',
              function (r) { return fmtNum(r.ttft_ms, 1); }),
        tpCol('single', 'tpot_ms', 'bench.results.single.tpot', 'TPOT (ms/tok)',
              'bench.metrics.tpot.tooltip', '',
              function (r) { return fmtNum(r.tpot_ms, 2); }),
        tpCol('single', 'processing_tps', 'bench.results.single.pp_tps', 'PP TPS',
              'bench.metrics.pp_tps.tooltip', '',
              function (r) { return fmtNum(r.processing_tps, 1, ' tok/s'); }),
        tpCol('single', 'gen_tps', 'bench.results.single.tg_tps', 'TG TPS',
              'bench.metrics.tg_tps.tooltip', '',
              function (r) { return fmtNum(r.gen_tps, 1, ' tok/s'); }),
        tpCol('single', 'e2e_latency_s', 'bench.results.single.e2e_latency',
              'E2E Latency', 'bench.metrics.e2e.tooltip', '',
              function (r) { return fmtNum(r.e2e_latency_s, 3, 's'); }),
        tpCol('single', 'total_throughput', 'bench.results.single.throughput',
              'Throughput', 'bench.metrics.throughput.tooltip', '',
              function (r) { return fmtNum(r.total_throughput, 1, ' tok/s'); }),
        tpCol('single', 'peak_memory_bytes', 'bench.results.single.peak_mem',
              'Peak MLX', 'bench.metrics.peak_mem.tooltip', '',
              function (r) { return fmtMemory(r.peak_memory_bytes); }),
    ];
}
function tpBatchDefs(base) {
    return [
        tpCol('batch', 'batch_size', 'bench.results.batch.batch_size',
              'Batch Size', 'bench.metrics.batch_size.tooltip', '',
              function (r) {
                  return r.__baseline
                      ? t('bench.results.batch.baseline', '1x (baseline)')
                      : r.batch_size + 'x';
              }),
        tpCol('batch', 'tg_tps', 'bench.results.batch.tg_tps', 'TG TPS',
              'bench.metrics.tg_tps.tooltip', '',
              function (r) { return fmtNum(r.tg_tps, 1, ' tok/s'); }),
        tpCol('batch', 'speedup', 'bench.results.batch.speedup', 'Speedup',
              'bench.metrics.speedup.tooltip', '',
              function (r) {
                  if (r.__baseline) return '1.00x';
                  var sp = (base && base.gen_tps > 0 && r.tg_tps != null)
                      ? r.tg_tps / base.gen_tps : null;
                  return sp == null
                      ? t('bench.results.text_export.not_available', 'N/A')
                      : sp.toFixed(2) + 'x';
              }),
        tpCol('batch', 'pp_tps', 'bench.results.batch.pp_tps', 'PP TPS',
              'bench.metrics.pp_tps.tooltip', '',
              function (r) { return fmtNum(r.pp_tps, 1, ' tok/s'); }),
        tpCol('batch', 'pp_tps_req', 'bench.results.batch.pp_tps_req',
              'PP TPS/req', 'bench.metrics.pp_tps_req.tooltip', '',
              function (r) {
                  // classic prints the baseline's own PP TPS in this cell
                  return fmtNum(r.__baseline ? r.processing_tps : tpPpPerReq(r),
                      1, ' tok/s');
              }),
        tpCol('batch', 'avg_ttft_ms', 'bench.results.batch.avg_ttft',
              'Avg TTFT (ms)', 'bench.metrics.avg_ttft.tooltip', '',
              function (r) { return fmtNum(r.avg_ttft_ms, 1); }),
        tpCol('batch', 'e2e_latency_s', 'bench.results.batch.e2e_latency',
              'E2E Latency', 'bench.metrics.e2e.tooltip', '',
              function (r) { return fmtNum(r.e2e_latency_s, 3, 's'); }),
    ];
}
function tpOutDef() {
    // uplift-native measured-decode column: 'tg1024' says what was REQUESTED,
    // this says what the model GENERATED (fraction on an early stop)
    return tpCol(null, 'out', null, 'out', 'uplift.bench.tp.out_hint',
        'Measured output tokens vs the requested tg length.',
        function (r) { return outCell(r); });
}
function tpBatchBody(base, batch) {
    // classic's first body row IS the single pp1024 run, relabelled. A copy
    // with batch-shaped keys: every getter reads one row shape, and the
    // __baseline marker is what the label/speedup cells print classic's
    // fixed texts from. completion_tokens/tg ride along, so the native 'out'
    // cell stays honest on that row too.
    if (!base) return batch.slice();
    return [Object.assign({}, base, {
        __baseline: true, batch_size: 1,
        tg_tps: base.gen_tps, pp_tps: base.processing_tps,
        avg_ttft_ms: base.ttft_ms, e2e_latency_s: base.e2e_latency_s,
    })].concat(batch);
}
function tpTableSpecs(rows) {
    var singles = tpSingles(rows), batch = tpBatch(rows);
    var base = tpBaseline(singles);
    var out = [];
    if (singles.length) {
        out.push({
            kind: 'single', key: 'bench.results.single.section_label',
            en: 'Single Request Results', sub: '',
            defs: tpSingleDefs(base).concat([tpOutDef()]),
            rows: singles,
        });
    }
    if (batch.length) {
        out.push({
            kind: 'batch', key: 'bench.results.batch.section_label',
            en: 'Continuous Batching', sub: batchPromptSummary(batch),
            defs: tpBatchDefs(base).concat([tpOutDef()]),
            rows: tpBatchBody(base, batch),
        });
    }
    return out;
}
// simpleTable column tuples: [rowKey, head, getter(v, r), tooltip, i18n bag]
function tpCols(defs) {
    return defs.map(function (d) {
        return [d.key, d.head, function (v, r) { return d.get(r); }, d.tip,
                { k: d.headKey, en: d.headEn, tk: d.tipKey, ten: d.tipEn }];
    });
}
// CSV/Markdown export: BOTH tables' columns concatenated under classic's
// header names, the shared 'out' column once at the end. A row leaves the
// other table's cells empty — one flat sheet, honest about what each row is.
function tpDlCols(rows) {
    var specs = tpTableSpecs(rows);
    var defs = [], outDef = null;
    specs.forEach(function (s) {
        s.defs.forEach(function (d) {
            if (d.kind === null) { outDef = outDef || d; return; }
            defs.push(d);
        });
    });
    if (outDef) defs.push(outDef);
    return defs.map(function (d) {
        return {
            head: d.head,
            get: function (r) {
                if (d.kind && (tpIsBatch(r) ? 'batch' : 'single') !== d.kind)
                    return '';
                return d.get(r);
            },
        };
    });
}
function buildTpTables(rows) {
    var nodes = [];
    tpTableSpecs(rows).forEach(function (s) {
        var head = el('div', 'bench-tp-section');
        var lab = el('span', 'bench-label', t(s.key, s.en));
        lab.dataset.i18n = s.key;
        lab.dataset.en = s.en;                   // U59: late catalog repair
        head.appendChild(lab);
        // classic shows the batch prompt summary beside its section title; it
        // carries substituted placeholders, so NO dataset.i18n (SAY-2c)
        if (s.sub) head.appendChild(el('span', 'bench-tp-section-note', s.sub));
        nodes.push(head);
        nodes.push(simpleTable(tpCols(s.defs), s.rows, 'tp-table'));
    });
    return nodes;
}
// Client half of the cache-off run option (user item 3): the snapshot says
// which caches the run disabled, the card says so under its title.
function tpCacheOffNote(e) {
    var off = e && e.meta && e.meta.cache_off;
    if (!off || !off.length) return null;
    var p = el('p', 'bench-tp-note',
        t('uplift.bench.tp.cache_off', 'Cache disabled during this run'));
    p.dataset.i18n = 'uplift.bench.tp.cache_off';
    p.dataset.en = p.textContent;
    return p;
}

function tpHistoryBody(e) {
    var card = el('div', 'bench-result card');
    var ctx = { model: e.model_id || '',
                profile: (e.meta && e.meta.context_profile) || 'code_python',
                forceLm: false,
                external: (e.meta && e.meta.external) ? { model: e.model_id } : null };
    var rows = e.rows || [];
    // head first, then the cache-off note, then classic's two tables (the
    // old code prepended the head; appendChild keeps one paint order and
    // works in every harness — 'prepend' is not in the DOM stubs)
    card.appendChild(resultsHead(function () {
        return buildThroughputText(ctx, rows);
    }));
    var note = tpCacheOffNote(e);
    if (note) card.appendChild(note);
    if (!rows.length) {
        card.appendChild(historyEmptyNote());
        return card;
    }
    buildTpTables(rows).forEach(function (n) { card.appendChild(n); });
    return card;
}

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
        var genBox = el('div', 'bench-chips'); genBox.id = 'bench-tp-gen';
        GEN_LENGTHS.forEach(function (tg, i) {
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
        BATCH_SIZES.forEach(function (bs) {
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
        }
        syncCacheOff();
        var adv = advancedSection([
            check('bench-tp-ane', t('bench.config.ane_aligned_prompt', 'ANE-aligned prompts (+1 token)'), false),
            check('bench-tp-lm', t('bench.config.force_lm_engine', 'Force mlx-lm engine'), false),
            noHot, noSsd,
            (function () {
                // CACHE-OFF: the toggle must react the moment it flips, and
                // the rAF block below wires the SAME checkbox for its own
                // row reveal — the listener here is attached to the element
                // reference, so a harness without requestAnimationFrame
                // still gets the working pair.
                var lb = check('bench-tp-ext',
                    t('bench.config.external', 'Use external OpenAI API endpoint'), false);
                lb.input.addEventListener('change', syncCacheOff);
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

        f.append(row1, row2, row3, adv, actions);
        requestAnimationFrame(function () {
            var ext = gid('bench-tp-ext');
            if (ext) ext.addEventListener('change', function () {
                var er = gid('bench-tp-ext-row');
                if (er) er.hidden = !ext.checked;
                syncCacheOff();     // CACHE-OFF: the knobs die with the mode
            });
            var gen = gid('bench-tp-gen');
            if (gen) gen.addEventListener('change', function (ev) {
                if (ev.target && ev.target.checked && batchHint)
                    batchHint.textContent = t('bench.config.batch_hint',
                        'Batch tests use pp1024 / tg128')
                        .replace('tg128', 'tg' + Number(ev.target.value).toLocaleString());
            });
            var mod = gid('bench-tp-model');
            if (mod) mod.addEventListener('change', syncCacheOff);
        });
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
            if (BENCHQ.isQueued(out)) {
                this.state.running = false;
                this.state.benchId = null;
                this.setButtons();
                BENCHQ.note();
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
            _es.onerror = function () { streamInterrupted('bench-tp-status'); };
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
        customInp.min = String(CTX_CUSTOM_MIN);
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
        if (!isFinite(v) || v !== Math.floor(v) || v < CTX_CUSTOM_MIN) {
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
            if (BENCHQ.isQueued(out)) {
                this.state.running = false;
                this.state.benchId = null;
                this.setButtons();
                BENCHQ.note();
                return;
            }
            this.state.benchId = out.bench_id;
            this.startStream(out.bench_id);
            this.renderStatus(t('ctx_bench.progress.starting', 'Starting...'));
        } catch (e) {
            rel();
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
            _es.onerror = function () { streamInterrupted('bench-ctx-status'); };
        } catch (e) { this.poll(benchId); }
    },

    poll: function (benchId) {
        var self = this;
        var d = dom();
        if (_poll) clearInterval(_poll);
        _poll = setInterval(async function () {
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
            st.textContent += ' — ' + t('uplift.bench.run_finished', 'finished');
        }
    },
};


/* ==========================================================================
   ACC-2a/ACC-2b — 'ADDITIONAL SUITES' — the home of EVERY LM-Eval card.
   The user's hard constraint on this block: the classic grid (#bench-acc-tasks)
   shows oMLX Classic cards ONLY, and every harness card — both the twin of a
   classic suite (mmlu -> 'mmlu|h') and the expanded catalog's own suites —
   lives here instead. The section is a COLLAPSED-BY-DEFAULT <details> framed
   in the accent colour: the harness path is the expensive, per-subtask one,
   so it is revealed by a deliberate click, never by scrolling past it.
   Two sources feed one list (buildExtras, deterministic server order):
     - family 'core': the classic catalog crossed with 'harness_tasks' —
       rendered by the REAL taskRowEl(tk, true) card, so its size select,
       its '|h' key and its uploadable routing are exactly as before
     - the ACC-2a extra_suites payload (sibling of harness-sizes):
       {"extra_suites": [{"key": "ifeval", "label": "IFEval",
                          "family": "instruction", "rows": 541,
                          "upload_ok": false}, ...]}
   family is one of instruction|reasoning|locale (unknown families render
   under their own raw name). rows is a dataset fact or null — a null row
   count renders NO row part in the chip (U68: never a guessed number).
   Leaf counts come from the harness-sizes map the panel already owns; a
   suite the probe does not know yet omits the 'x' part the same way.
   The extra_suites are local-only by construction (the omlx.ai leaderboard
   knows just the classic 16), so this section carries NO upload affordance
   and their picks leave /add in their own queue entry with upload off.
   ========================================================================== */
var EXTRAS = {
    KEY: 'uplift.bench.extras.v1',   // fold + show-all persistence (browser pref)
    CAP: 6,                          // visible cards per family before 'show all'
    LIMIT: 100,                      // per-subtask sample limit of an extras pick
    FAMILIES: ['core', 'instruction', 'reasoning', 'locale'],
    // 'other' is the honest bucket: the ACC-2b seam emits family straight
    // off the spec ('spec.get("family")'), so a suite added without one
    // must still land somewhere NAMED, not under a raw null
    FAM_FALLBACK: { core: 'Core benchmarks', instruction: 'Instruction following',
                    reasoning: 'Reasoning', locale: 'Language & locale',
                    other: 'Other' },
    FAM_KEYS: ['core', 'instruction', 'reasoning', 'locale', 'other'],

    norm: function (list) {
        // Server order is kept (same doctrine as the classic grid: the
        // order of the catalog is a server-side decision, not a UI one)
        var out = [];
        (list || []).forEach(function (s) {
            if (!s || !s.key) return;
            out.push({ key: String(s.key), label: s.label || String(s.key),
                       family: s.family ? String(s.family) : 'other',
                       rows: (typeof s.rows === 'number' && s.rows > 0)
                             ? s.rows : null,
                       upload_ok: s.upload_ok === true });
        });
        return out;
    },

    buildExtras: function (st) {
        // ONE list, two sources, both in server order (the deterministic-
        // order doctrine: the catalog's order is a server-side decision).
        // 'core' first: the LM-Eval TWINS of the classic suites left the
        // classic grid (user directive: the grid is classic-only) and live
        // here, so the section exists as soon as a harness twin exists —
        // a pre-ACC-2b server (empty harness_tasks AND no extra_suites)
        // still gets zero DOM delta.
        var out = [];
        var twins = (st && st.harnessTasks) || [];
        ((st && st.groups) || []).forEach(function (grp) {
            (grp.tasks || []).forEach(function (tk) {
                if (!tk || !tk.key) return;
                if (twins.indexOf(tk.key) < 0) return;
                out.push({ key: String(tk.key), label: tk.label || String(tk.key),
                           family: 'core',
                           rows: (typeof tk.full_size === 'number'
                                  && tk.full_size > 0) ? tk.full_size : null,
                           upload_ok: true,      // a classic twin uploads
                           task: tk });          // painted by taskRowEl
            });
        });
        return out.concat(EXTRAS.norm((st && st.extraSuites) || []));
    },

    isExtra: function (st, bareKey) {
        var list = (st && st.extraSuites) || [];
        for (var i = 0; i < list.length; i++)
            if (list[i] && list[i].key === bareKey) return true;
        return false;
    },

    uploadOk: function (st, bareKey) {
        // ACC-2a: the server owns the leaderboard truth per suite. The
        // omlx.ai site knows only the classic 16, so it advertises
        // upload_ok:false for every extra — the UI must then never let an
        // extras pick travel in a request that carries the upload flag.
        var list = (st && st.extraSuites) || [];
        for (var i = 0; i < list.length; i++)
            if (list[i] && list[i].key === bareKey)
                return list[i].upload_ok === true;
        return true;   // not an extra: the classic/harness rule stands
    },

    groups: function (list) {
        var byF = {}, order = [];
        (list || []).forEach(function (s) {
            var f = s.family || 'other';    // norm() mapped a null family here
            if (!byF[f]) { byF[f] = []; order.push(f); }
            byF[f].push(s);
        });
        var known = EXTRAS.FAMILIES.filter(function (f) { return byF[f]; });
        var rest = order.filter(function (f) {
            return known.indexOf(f) < 0; });
        return known.concat(rest).map(function (f) {
            return { family: f, items: byF[f] };
        });
    },

    famLabel: function (f) {
        var fb = EXTRAS.FAM_FALLBACK[f] || f;
        return t('uplift.bench.extras_family_' + f, fb);
    },

    match: function (s, family, q) {
        if (!q) return true;
        return (String(s.label) + ' ' + String(s.key) + ' ' + family + ' '
                + EXTRAS.famLabel(family)).toLowerCase().indexOf(q) >= 0;
    },

    chip: function (rows, leaves) {
        // 'N rows · x<leaves> · LM-Eval' with the honest omissions: rows
        // unknown -> no row part, leaves unknown -> no 'x' part. Never a
        // guessed number (U68 doctrine).
        var parts = [];
        if (typeof rows === 'number' && rows > 0)
            parts.push(t('uplift.bench.extras_rows', '{n} rows')
                .replace('{n}', rows.toLocaleString()));
        // x1 is not information — the size-option labels apply the same
        // rule (applyEngineLabels multiplies only when the count is > 1)
        if (typeof leaves === 'number' && leaves > 1)
            parts.push('\u00d7' + leaves);
        parts.push(t('uplift.bench.engine_harness', 'LM-Eval'));
        return parts.join(' \u00b7 ');
    },

    ui: function () { return { fold: {}, all: {}, open: false, q: '' }; },

    load: function () {
        var out = EXTRAS.ui();
        try {
            var raw = localStorage.getItem(EXTRAS.KEY);
            var d = raw ? JSON.parse(raw) : null;
            if (d && d.fold && typeof d.fold === 'object') out.fold = d.fold;
            if (d && d.all && typeof d.all === 'object') out.all = d.all;
            // the SECTION's own fold: collapsed until the user opens it,
            // and that choice is remembered like every other pref here
            if (d && typeof d.open === 'boolean') out.open = d.open;
        } catch (_) { /* a broken pref is no pref: defaults, never a throw */ }
        return out;
    },

    save: function (ui) {
        try {
            localStorage.setItem(EXTRAS.KEY, JSON.stringify(
                { fold: ui.fold, all: ui.all, open: ui.open === true }));
        } catch (_) {}
    },

    render: function (acc) {
        var st = acc && acc.state;
        if (!st) return;
        if (!st.extrasUI) st.extrasUI = EXTRAS.load();
        var ui = st.extrasUI;
        st.extrasItems = EXTRAS.buildExtras(st);
        if (!st.extrasItems.length) {
            // nothing to show (no twin, no extra suite): no node at all, so
            // the panel is the one that shipped before this section existed
            if (st.extrasSec && st.extrasSec.remove) st.extrasSec.remove();
            st.extrasSec = null; st.extrasBox = null; st.extrasCount = null;
            return;
        }
        // The section belongs to ONE form() build: state is rebuilt on
        // every panel mount, so 'no st.extrasSec' means 'this form has no
        // section yet'. (Never look the node up by id — a remount detaches
        // the old one and an id lookup can still find a stale node.)
        if (!st.extrasSec) {
            // A <details> that stays COLLAPSED until the user clicks it:
            // the harness path is the expensive one (N requests PER
            // subtask), so reaching it must be a deliberate act, never a
            // scroll past it.
            var sec = el('details', 'acc-extras'); sec.id = 'bench-acc-extras';
            var head = el('summary', 'acc-extras-head');
            var cap = el('span', 'bench-label acc-extras-cap',
                t('uplift.bench.extras_title', 'Additional suites'));
            cap.dataset.i18n = 'uplift.bench.extras_title';
            cap.dataset.en = cap.textContent;                 // U59 repair
            var fbCount = t('uplift.bench.extras_count', '{n} suites')
                .replace('{n}', String(st.extrasItems.length));
            var count = el('span', 'acc-extras-count', fbCount);
            count.dataset.i18n = 'uplift.bench.extras_count';
            count.dataset.en = count.textContent;             // U59 repair
            // exactly like the cap: data-en holds the RENDERED text, so an
            // applyI18n pass with no catalog answer restores '13 suites'
            // rather than a raw '{n}' template. paint() is the authority
            // for the number (the {n} key is re-substituted on every
            // repaint, the same contract as the chip / show-all labels).
            head.append(cap, count, el('span', 'bench-adv-chev', '▾'));
            var body = el('div', 'acc-extras-body');
            var note = el('p', 'native-stub-note',
                t('uplift.bench.extras_note',
                  'Local only \u2014 the community leaderboard knows just the classic suites.'));
            note.dataset.i18n = 'uplift.bench.extras_note';
            note.dataset.en = note.textContent;               // U59 repair
            var search = el('input');
            search.type = 'search'; search.id = 'bench-acc-extras-search';
            search.className = 'acc-extras-search';
            var ph = t('uplift.bench.extras_search',
                'Search additional suites\u2026');
            search.placeholder = ph;
            // U51: a placeholder is not an accessible name; the box lives
            // beside its own caption, so label it with the section title
            search.setAttribute('aria-label',
                t('uplift.bench.extras_title', 'Additional suites'));
            search.dataset.i18nPh = 'uplift.bench.extras_search';
            search.dataset.enPh = ph;
            var box = el('div', 'acc-extras-fams'); box.id = 'bench-acc-extras-fams';
            // Everything that belongs to the fold lives INSIDE the details;
            // the body wrapper keeps a CLOSED section at zero stray padding
            // (nothing but the header strip is laid out at all).
            body.append(note, search, box);
            sec.append(head, body);
            sec.open = ui.open === true;      // collapsed by default
            head.setAttribute('aria-expanded', sec.open ? 'true' : 'false');
            sec.addEventListener('toggle', function () {
                var on = sec.open === true;
                head.setAttribute('aria-expanded', on ? 'true' : 'false');
                if (ui.open === on) return;
                ui.open = on;
                EXTRAS.save(ui);
            });
            // Below the classic grid, ABOVE the LM-Eval request total: the
            // suite choice may never sit after the run buttons (U79
            // grouping by concern) and the total stays readable outside the
            // fold. insertBefore keeps the classic children untouched.
            var host = st.extrasHost, anchor = st.extrasAnchor;
            if (!host) return;        // form() not built yet: stay unbuilt,
                                      // a later render() retries (never
                                      // adopt a detached node — painting
                                      // into one would show nothing)
            if (anchor && host.insertBefore) host.insertBefore(sec, anchor);
            else host.appendChild(sec);
            st.extrasSec = sec; st.extrasBox = box; st.extrasCount = count;
            search.addEventListener('input', function () {
                st.extrasUI.q = String(search.value || '');
                EXTRAS.paint(acc);
            });
        }
        EXTRAS.paint(acc);
    },

    paint: function (acc) {
        var st = acc.state, box = st.extrasBox, sec = st.extrasSec;
        if (!box || !sec) return;
        var ui = st.extrasUI || (st.extrasUI = EXTRAS.load());
        var q = String(ui.q || '').trim().toLowerCase();
        // The header answers 'how much is behind this fold' — a count of
        // the SUITES in the section, not of the picks (the request math
        // stays in #bench-acc-engine-total, outside the fold). A search
        // filters the list; it does not change what the section holds.
        if (st.extrasCount) {
            st.extrasCount.textContent = t('uplift.bench.extras_count',
                '{n} suites').replace('{n}', String(st.extrasItems.length));
        }
        box.replaceChildren();
        EXTRAS.groups(st.extrasItems).forEach(function (g) {
            var hits = q ? g.items.filter(function (s) {
                return EXTRAS.match(s, g.family, q); }) : g.items;
            if (q && !hits.length) return;      // a filtered-out family is gone
            // Families default open. A LIVE SEARCH always reveals them:
            // a folded <details> would keep the very match the user typed
            // for invisible (the pref itself is untouched — clearing the
            // box restores the folded state)
            var open = q ? true : ui.fold[g.family] !== false;
            var full = !!ui.all[g.family];
            // a search shows every hit — capping the matches would hide
            // the very suite the user typed for
            var vis = (full || q) ? hits : hits.slice(0, EXTRAS.CAP);
            var det = el('details', 'acc-extras-fam');
            det.open = open;
            det.dataset.family = g.family;
            var sum = el('summary', 'acc-extras-fam-cap',
                EXTRAS.famLabel(g.family) + ' (' + hits.length + ')');
            sum.setAttribute('aria-expanded', open ? 'true' : 'false');
            det.appendChild(sum);
            var row = el('div', 'acc-group-tasks acc-extras-tasks');
            vis.forEach(function (s) {
                // 'core' is the twin of a classic suite: it is painted by
                // the SAME taskRowEl(tk, true) that used to sit in the
                // classic grid, so its size select, its '|h' key and its
                // uploadable routing are untouched by the move. The extra
                // suites keep their own local-only card.
                row.appendChild((g.family === 'core' && s.task)
                    ? acc.taskRowEl(s.task, true)
                    : EXTRAS.card(acc, s, g.family, det));
            });
            det.appendChild(row);
            if (!q && hits.length > vis.length) {
                var more = el('button', 'btn acc-extras-more',
                    t('uplift.bench.extras_show_all', 'show all ({n})')
                        .replace('{n}', String(hits.length)));
                more.type = 'button';
                more.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    ui.all[g.family] = true; EXTRAS.save(ui); EXTRAS.paint(acc);
                });
                det.appendChild(more);
            } else if (!q && full && hits.length > EXTRAS.CAP) {
                var less = el('button', 'btn acc-extras-more',
                    t('uplift.bench.extras_hide', 'hide'));
                less.type = 'button';
                less.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    delete ui.all[g.family]; EXTRAS.save(ui); EXTRAS.paint(acc);
                });
                det.appendChild(less);
            }
            det.addEventListener('toggle', function () {
                var on = det.open !== false;
                sum.setAttribute('aria-expanded', on ? 'true' : 'false');
                if (ui.fold[g.family] === on) return;
                ui.fold[g.family] = on;
                if (!on) delete ui.all[g.family];   // refold re-caps the list
                EXTRAS.save(ui);
            });
            box.appendChild(det);
        });
        if (!box.children.length) {
            box.appendChild(el('p', 'native-stub-note',
                t('uplift.bench.extras_none',
                  'No additional suite matches that search.')));
        }
    },

    card: function (acc, s, family, det) {
        var st = acc.state, ui = st.extrasUI;
        var key = s.key + '|h';   // the harness engine carries these picks
        var card = taskCard(s.label, '', null, function (on) {
            if (on) {
                st.selected[key] = true;
                st.sizes[key] = EXTRAS.LIMIT;
                // a pick must never stay invisible: reveal the folded
                // family (and a capped list) it lives in
                if (det && det.open === false) {
                    det.open = true; ui.fold[family] = true; EXTRAS.save(ui);
                }
                if (!ui.all[family] && !ui.q) {
                    var g = EXTRAS.groups(st.extrasItems).filter(function (x) {
                        return x.family === family; })[0];
                    var idx = g ? g.items.indexOf(s) : -1;
                    if (idx >= EXTRAS.CAP) {
                        ui.all[family] = true; EXTRAS.save(ui); EXTRAS.paint(acc);
                    }
                }
            } else {
                delete st.selected[key]; delete st.sizes[key];
            }
            acc.applyEngineLabels();   // U68: totals hint counts the pick
        });
        card.dataset.key = key;
        card.dataset.localOnly = '1';
        card.classList.add('acc-task-harness');
        var leaves = (st.harnessSizes && st.harnessSizes[s.key]) || null;
        var chip = el('div', 'acc-task-chip',
            EXTRAS.chip(s.rows, leaves));
        chip.title = t('uplift.bench.extras_limit',
            'Sample limit {n} per subtask (harness default)').replace(
                '{n}', String(EXTRAS.LIMIT));
        card.appendChild(chip);
        if (st.selected[key]) {
            card.classList.add('on');
            card.setAttribute('aria-pressed', 'true');
        }
        return card;
    },
};

/* ==========================================================================
   ACCURACY (REPL-2a) — classic 16-task engine over /uplift/api/
   bench/accuracy/*. Queue chaining + per-suite upload events belong to the
   classic runner; uplift flips upload to explicit OPT-IN (engine window
   patch, documented in accuracy_engine.py). Task grid comes from the
   server (/tasks) so dataset facts ship in one place; labels are classic
   acc_bench.* keys. The grid holds oMLX Classic cards ONLY — every
   LM-Eval card (a classic suite's twin as well as the expanded catalog)
   renders in the 'Additional suites' fold above, and never mixes in here.
   ========================================================================== */

/* ACC-STALL (user item 4): a half-open SSE socket (proxy blip) keeps the
   EventSource technically OPEN while the server stops talking — the board
   froze on the last painted event (the user saw 1/164 for minutes). Two
   defences, both driven from the 4s queue poll:
     1. restart the stream when the server has events we never consumed
        (needsStreamRestart hysteresis below);
     2. forward-seed the board from the poll's own last_progress, so the
        boxes move even against a server that does not report event_count.
   Both are FORWARD-ONLY by construction: harness leaf-restart events (cur
   lower than the live bar) are never seeded — a real leaf boundary only
   arrives through the stream or a full replay. */
var ACC_POLL_MS = 4000;
var ACC_STALL_MS = 90000;
function needsStreamRestart(eventCount, seen, prevEventCount) {
    // The fetch and the stream race each other, so ONE poll that shows a
    // backlog proves nothing: restart only when the miss REPEATS, i.e. the
    // previous poll already reported more events than we have consumed NOW
    // (seen has not caught up to what the last poll saw). A stream that is
    // merely a moment behind has consumed the previous count by now, so this
    // also survives a backlog that keeps climbing while the socket is dead.
    if (typeof eventCount !== 'number') return false;
    if (eventCount <= (seen | 0)) return false;         // stream is current
    return typeof prevEventCount === 'number' && prevEventCount > (seen | 0);
}
function resetBoardEntry(entry, harnessSizes, groups) {
    // A reconnect REPLAYS the whole log from index 0. The harness leaf bank
    // lives in entry.bar (a bar that restarts below its previous cur banks
    // the old total) — replaying into a non-empty bar would bank twice, so
    // the accumulator is cleared first and the rebuild is exact.
    if (!entry) return entry;
    entry.bar = {};
    entry.suiteDone = {};
    entry.suiteQuiet = {};
    entry.qper = boardQuestions(entry.sizes || {}, entry.engine || 'classic',
                                harnessSizes, groups).per;
    var first = true;
    entry.suiteState = {};
    Object.keys(entry.sizes || {}).forEach(function (k) {
        entry.suiteState[k] = (entry.running && first) ? 'running' : 'queued';
        first = false;
    });
    return entry;
}

var ACC = {
    state: null,

    render: function (panel) {
        this.state = { running: false, benchId: null, queue: [],
                       progress: null, groups: null,
                       selected: {}, sizes: {}, results: [],
                       // ACC-STALL: stream bookkeeping (consumed events, the
                       // previous poll's event_count, last visible activity)
                       seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                       // U68: {suite: leaf subtask count}; harness --limit
                       // applies PER subtask, the labels must say so
                       harnessSizes: ACC._sizesCache || null,
                       harnessTasks: ACC._tasksCache || [],
                       // ACC-2a: harness-only suites (the SEPARATE section
                       // under the classic grid). /tasks owns the list; an
                       // absent key is the pre-ACC-2b server, and the
                       // section then does not exist in the DOM at all
                       extraSuites: ACC._extrasCache || [],
                       engine: 'classic' };
        panel.appendChild(this.form());
        var queue = el('div', 'acc-queue'); queue.id = 'bench-acc-queue';
        // ACC-STALL: this is a FRESH wrap — the in-place repaint guard must
        // forget the previous mount's shape or the first poll would skip it
        this._qSig = null;
        var status = statusLine('bench-acc-status');
        var results = el('div', 'bench-results'); results.id = 'bench-acc-results';
        panel.append(queue, status, results);
        this.loadModels();
        this.loadTasks();
        // ACC-2a: paint the extras section from the module cache right
        // away (a panel reopen must not blank it while /tasks is in
        // flight); loadTasks repaints when the payload lands
        EXTRAS.render(this);
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

// U49: task grid gets its classic section caption (it floated
        // unlabeled before) and the scoring-engine choice moves OUT of
        // Advanced — first-order per-run decision, classic shows it openly
        f.appendChild(el('div', 'bench-label acc-grid-label',
            t('acc_bench.config.benchmarks', 'Benchmarks')));
        var grid = el('div', 'acc-taskgrid'); grid.id = 'bench-acc-tasks';
        // U69 (user): the engine is a property of the benchmark, not a
        // global mode. One list; every card carries its engine caption
        // (oMLX Classic / LM-Eval); the lm-eval math shows on the harness
        // cards' own size options. The old radio row is gone.
        var engNote = el('p', 'native-stub-note', t('uplift.bench.engine_hint',
            'oMLX Classic samples N questions total. LM-Eval (the community '
            + 'harness lm-eval) runs N PER SUBTASK — MMLU has 57 subtasks, so '
            + '30 becomes 1710 requests. The LM-Eval suites live in the '
            + 'Additional suites section below; its request total is shown '
            + 'under it.'));
        engNote.id = 'bench-acc-engine-hint';
        var totNote = el('p', 'native-stub-note'); totNote.id = 'bench-acc-engine-total';
        f.append(grid, engNote, totNote);
        self.loadHarnessSizes();
        // ACC-2a/2b: the extras section is a SIBLING that lands under the
        // classic grid and ABOVE the LM-Eval request total (the suite
        // choice may never sit after the run buttons, U79; and the total
        // has to stay readable while the fold is closed). form() only
        // records where it goes — the node itself exists only once the
        // server offers a harness card, so a plain classic panel is
        // byte-identical to the one that shipped without this section.
        self.state.extrasHost = f;
        self.state.extrasAnchor = totNote;   // insertBefore(target) = the
                                             // section goes above the total

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

        // U48/U49: prominent full-width Advanced section; the external
        // inputs live INSIDE with their toggle (form-level before)
        var bsSel = el('select'); bsSel.id = 'bench-acc-batch';
        [1, 2, 4, 8, 16, 32].forEach(function (n) {
            var o = el('option', null, String(n)); o.value = String(n); bsSel.appendChild(o);
        });
        var sampSel = el('select'); sampSel.id = 'bench-acc-sampling';
        var o1 = el('option', null, t('acc_bench.config.sampling_deterministic', 'Deterministic (greedy)'));
        o1.value = 'deterministic'; sampSel.appendChild(o1);
        var o2 = el('option', null, t('acc_bench.config.sampling_model', 'Model settings (temperature)'));
        o2.value = 'model_settings'; sampSel.appendChild(o2);
        var adv = advancedSection([
            labeled(t('acc_bench.config.batch_size', 'Batch size'), bsSel),
            labeled(t('acc_bench.config.sampling', 'Sampling'), sampSel),
            el('p', 'native-stub-note', t('acc_bench.config.batch_size_hint', 'Larger batches are faster but use more memory.')),
            check('bench-acc-think', t('acc_bench.config.thinking', 'Enable thinking mode'), false),
            el('p', 'native-stub-note', t('acc_bench.config.thinking_hint', 'Applies to models whose template supports thinking toggles.')),
            check('bench-acc-ext', t('bench.config.external', 'Use external OpenAI API endpoint'), false),
            extRow,
            check('bench-acc-upload', t('uplift.bench.upload_results', 'Upload results to community leaderboard'), false),
            el('p', 'native-stub-note', t('uplift.bench.upload_hint',
                'Off by default: a native run never posts to omlx.ai unless you check this.'))],
            'acc_bench.config.advanced_options', 'Advanced options');
        f.appendChild(adv);

        var actions = el('div', 'bench-actions');
        var addBtn = el('button', 'btn primary', t('acc_bench.config.add_run', 'Add to Queue'));
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

    _sizesCache: null,
    _tasksCache: null,   // U69: harness-mapped suite keys (module cache)
    _extrasCache: null,  // ACC-2a: harness-only suites (module cache)

    loadHarnessSizes: function () {
        // U68: lazy, never blocks the grid; the first server probe can
        // expand groups through bench-env (~20s once, cached on disk)
        if (ACC._sizesCache) { this.state.harnessSizes = ACC._sizesCache; this.applyEngineLabels(); return; }
        var self = this;
        var d = dom();
        d.fetchJson(api() + '/bench/accuracy/harness-sizes').then(function (p) {
            if (!p || !p.sizes) return;              // bench-env not ready: plain sizes
            ACC._sizesCache = p.sizes;
            if (self.state) { self.state.harnessSizes = p.sizes; }
            self.applyEngineLabels();
            // ACC-2a: the chips multiply by the leaf count — repaint once
            // the probe lands (before that they honestly omit the 'x' part)
            if (self.state && self.state.extrasBox) EXTRAS.paint(self);
            // U83: harness question math needs the leaf counts
            if (self.state && (self.state.running || (self.state.queue || []).length))
                self.refreshQueue();
        }).catch(function () { /* honest plain sizes */ });
    },

    _fullSize: function (st, key) {
        var out = 0;
        (st.groups || []).forEach(function (g) {
            (g.tasks || []).forEach(function (tk) {
                if (tk.key === key) out = tk.full_size || 0;
            });
        });
        return out;
    },

    applyEngineLabels: function () {
        var self = this;   // U83-FIX: pre-existing since 38c1259 — the
                           // engine-total loop below calls this._fullSize
                           // from a forEach callback where `this` is lost
                           // (crash: "can't access property _fullSize,
                           // this is undefined"). Found by the U83 drill
                           // because the board re-syncs labels on catalog
                           // load; the old code path hit it too.
        // U68+U69: every LM-Eval card relabels its OWN size options with
        // the per-subtask truth ('30 \u00d757'); classic cards stay plain
        var st = this.state;
        if (!st) return;
        var gdoc = (typeof document.querySelectorAll === 'function')
            ? document : null;
        if (gdoc) gdoc.querySelectorAll(
            // ACC-2b: the harness twins moved into the extras fold — the
            // multiplier must follow them there or their size options
            // would silently stop showing '30 \u00d757'
            '#bench-acc-tasks .acc-task, #bench-acc-extras .acc-task'
        ).forEach(function (card) {
            var key = card.dataset.key || '';
            var bare = key.indexOf('|h') > 0 ? key.slice(0, key.indexOf('|h')) : key;
            var c = (st.harnessSizes && st.harnessSizes[bare]) || 1;
            var sel = card.querySelector('select');
            if (!sel) return;
            var mult = (key.indexOf('|h') > 0 && c > 1) ? c : 1;
            [].forEach.call(sel.children, function (o) {
                if (o.value === '0') { o.dataset.base = o.dataset.base || o.textContent; return; }
                o.dataset.base = o.dataset.base || o.textContent;
                o.textContent = mult > 1 ? o.dataset.base + ' \u00d7' + mult : o.dataset.base;
            });
        });
        // Honest request total for the LM-Eval picks (sizes 0 = full
        // dataset: counted as full_size per subtask only when known,
        // otherwise excluded with the total staying a lower bound — we
        // NEVER print a guessed number)
        var tot = gid('bench-acc-engine-total');
        if (tot) {
            var reqs = 0, counted = false;
            Object.keys(st.selected).forEach(function (k) {
                if (!st.selected[k] || k.indexOf('|h') < 0) return;
                var bare = k.slice(0, k.indexOf('|h'));
                var c = (st.harnessSizes && st.harnessSizes[bare]) || 1;
                var n = st.sizes[k] || 0;
                if (!n) {
                    var fs = self._fullSize(st, bare);
                    if (!fs) return;             // unknown: stay silent-ish
                    n = fs;
                }
                reqs += c * n; counted = true;
            });
            var shown = counted && reqs ? reqs.toLocaleString() : '\u2014';
            var c2 = C();
            var line = (c2 && c2.t) ? c2.t('uplift.bench.engine_total',
                                            { n: shown }) : null;
            if (typeof line !== 'string' || line === 'uplift.bench.engine_total'
                || line.indexOf('{n}') >= 0) {
                var fb = t('uplift.bench.engine_total',
                    'LM-Eval selection: about {n} requests.');
                line = (typeof fb === 'string' ? fb
                        : 'LM-Eval selection: about {n} requests.')
                        .replace('{n}', shown);
            }
            tot.textContent = line;
            tot.hidden = !(Object.keys(st.selected).some(function (k) {
                return st.selected[k] && k.indexOf('|h') > 0; }));
        }
    },

    loadTasks: function () {
        var d = dom();
        var self = this;
        var g0 = gid('bench-acc-tasks');
        if (g0) g0.replaceChildren(loadingNote());
        return d.fetchJson(api() + '/bench/accuracy/tasks').then(function (data) {
            self.state.groups = data.tasks || [];
            // U69: which suites have an lm-eval equivalent (module cache:
            // a panel reopen before this fetch resolves still renders the
            // full list)
            ACC._tasksCache = data.harness_tasks || [];
            self.state.harnessTasks = ACC._tasksCache;
            // ACC-2a: harness-only suites for the SEPARATE section (the
            // key is absent on a pre-ACC-2b server — an absent key and an
            // empty list both mean: render nothing, ever)
            ACC._extrasCache = data.extra_suites || [];
            self.state.extraSuites = ACC._extrasCache;
            self.renderGrid();
            EXTRAS.render(self);
            self.applyEngineLabels();   // ACC-2a: totals see the extras cache
            // U83: the board may have painted BEFORE the catalog landed
            // (queued suites render key-only, 'Full' sizes unknown). Labels
            // and full-dataset totals come from groups — resync in place.
            if (self.state.running || (self.state.queue || []).length)
                self.refreshQueue();
        }).catch(function () {});
    },

    renderGrid: function () {
        var grid = gid('bench-acc-tasks');
        if (!grid || !this.state.groups) return;
        var self = this;
        grid.replaceChildren();
        this.state.groups.forEach(function (grp) {
            var wrap = el('div', 'acc-group');
            var cap = el('div', 'bench-label', t(grp.group, grp.group.split('.').pop()));
            cap.dataset.i18n = grp.group; cap.dataset.en = cap.textContent;  // U59
            wrap.appendChild(cap);
            var row = el('div', 'acc-group-tasks');
            grp.tasks.forEach(function (tk) {
                row.appendChild(self.taskRowEl(tk, false));
                // ACC-2b (user directive): the LM-Eval twin of a classic
                // suite no longer renders beside its classic twin here.
                // The grid shows oMLX Classic cards ONLY; every harness
                // card lives in the 'Additional suites' fold, which paints
                // it as the very same variant card it always was.
            });
            wrap.appendChild(row);
            grid.appendChild(wrap);
        });
        this.applyEngineLabels();   // U68: labels are fresh DOM
    },

    taskRowEl: function (tk, variant) {
        var self = this;
        var key = variant ? tk.key + '|h' : tk.key;
        var sizeSel = el('select');
        sizeSel.dataset.key = key;
        tk.sizes.forEach(function (n) {
            var o = el('option', null, String(n)); o.value = String(n); sizeSel.appendChild(o);
        });
        // U51: {count} lives INSIDE the translated key
        // (classic fills it the same way); the old concat showed
        // the raw placeholder + a paren for non-en locales
        // U69: 'Full' (0 = entire dataset) stays on oMLX Classic cards
        // ONLY. On an LM-Eval twin, lm_eval semantics would make it the
        // FULL set PER SUBTASK (mmlu: 14,042 x 57 requests) — an hours-
        // long accident one mis-click away, and the classic twin already
        // runs the same questions in full. Harness cards are for
        // controlled sample counts; the total line shows their cost.
        if (!variant) {
            var fullOpt = el('option', null,
                t('acc_bench.config.full_option', 'Full ({count})')
                    .replace('{count}', tk.full_size.toLocaleString()));
            fullOpt.value = '0';
            sizeSel.appendChild(fullOpt);
        }
        sizeSel.value = String(tk.sizes[Math.min(2, tk.sizes.length - 1)]);
        // U51: keyboard-operable card (was a click-only div). The
        // size select lives inside as its own focus target; a
        // click that lands on it must not double-toggle the card.
        var card = taskCard(tk.label,
            tk.desc ? t(tk.desc, tk.desc_literal || tk.key) : (tk.desc_literal || ''),
            null, function (on) {
                self.state.selected[key] = on;
                self.applyEngineLabels();   // U68: totals hint
            }, { d: tk.desc || null });
        card.dataset.key = key;
        // U69: engine caption inside the card — the list must read the
        // engine per benchmark (classic doctrine: oMLX Classic vs the
        // community lm-eval harness)
        var cap = el('div', 'acc-task-engine',
            variant ? t('uplift.bench.engine_harness', 'LM-Eval')
                    : t('uplift.bench.engine_classic', 'oMLX Classic'));
        cap.dataset.i18n = variant ? 'uplift.bench.engine_harness'
                                   : 'uplift.bench.engine_classic';
        cap.dataset.en = cap.textContent;   // U59 repair marker
        card.appendChild(cap);
        if (variant) card.classList.add('acc-task-harness');
        card.appendChild(sizeSel);
        sizeSel.addEventListener('click', function (ev) { ev.stopPropagation(); });
        sizeSel.addEventListener('change', function () {
            // choosing a size implies picking the task (U53: the
            // select stays operable on unselected cards — classic
            // disabled it, which made the FIRST click dead)
            if (!card.classList.contains('on')) {
                card.classList.add('on');
                card.setAttribute('aria-pressed', 'true');
                self.state.selected[key] = true;
            }
            self.state.sizes[key] = Number(sizeSel.value);
            self.applyEngineLabels();       // U68: totals hint
        });
        return card;
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
        // U69: engine is per CARD now ('key' classic, 'key|h' harness).
        // This call carries the classic part; the harness part rides as a
        // second queue entry (add() posts both) so mixed picks work and a
        // harness rejection (external/thinking) can't eat the classic run.
        var hBody = {};
        // ACC-2a: an extras pick (server upload_ok:false — the omlx.ai
        // leaderboard only knows the classic 16) leaves in ITS OWN queue
        // entry with upload forced off. The U69 upload opt-in can never
        // reach a local-only suite, not even when both are picked at once.
        var xBody = {};
        Object.keys(body.benchmarks).forEach(function (k) {
            if (k.indexOf('|h') > 0) {
                var bare = k.slice(0, k.indexOf('|h'));
                if (EXTRAS.isExtra(g, bare) && !EXTRAS.uploadOk(g, bare))
                    xBody[bare] = body.benchmarks[k];
                else
                    hBody[bare] = body.benchmarks[k];
                delete body.benchmarks[k];
            }
        });
        body.engine = 'classic';
        body._harness = Object.keys(hBody).length
            ? JSON.parse(JSON.stringify(Object.assign({}, body,
                  { benchmarks: hBody, engine: 'harness' })))
            : null;
        body._extras = Object.keys(xBody).length
            ? JSON.parse(JSON.stringify(Object.assign({}, body,
                  { benchmarks: xBody, engine: 'harness', upload: false })))
            : null;
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
        // U69: 'mmlu|h' variant cards resolve to the same task default
        var bare = key.indexOf('|h') > 0 ? key.slice(0, key.indexOf('|h')) : key;
        var out = 100;
        (this.state.groups || []).forEach(function (grp) {
            grp.tasks.forEach(function (tk) {
                if (tk.key === bare) out = tk.sizes[Math.min(2, tk.sizes.length - 1)];
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
        if (!Object.keys(body.benchmarks).length && !body._harness
            && !body._extras) {
            d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
            return;
        }
        var rel = busyLabel(gid('bench-acc-add'));
        var harness = body._harness;
        var extras = body._extras;   // ACC-2a: local-only, upload off
        delete body._harness;
        delete body._extras;
        var posted = 0, err = null;
        try {
            if (Object.keys(body.benchmarks).length) {
                await d.postJson(api() + '/bench/accuracy/add', body);
                posted++;
            }
            if (harness) {
                await d.postJson(api() + '/bench/accuracy/add', harness);
                posted++;
            }
            if (extras) {
                await d.postJson(api() + '/bench/accuracy/add', extras);
                posted++;
            }
        } catch (e) { err = String((e && e.message) || e); }
        rel();
        if (posted) d.toast(t('uplift.bench.queued', 'Added to queue'));
        if (err) d.toast(err, 'error');
        if (posted) this.refreshQueue();
        // BENCHQ: Intelligence already had its own queue toast — reuse it and
        // push the GLOBAL box to the new state without waiting for the poll
        if (posted) BENCHQ.refresh();
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
            this.state.boardPhase = st.phase || null;
            this.syncBoard(st);
            if (st.running) this.pollCatchup(st);
            this.renderQueue(st);
            if (st.running && !wasRunning && st.current_bench_id) this.startStream(st.current_bench_id);
            if (!st.running && wasRunning) { stopStream(); this.refreshResults(); }
        } catch (e) { /* board offline */ }
    },

    /* ACC-STALL: everything the 4s poll does while a run is live. Called
       right after syncBoard (so the entries exist) and before renderQueue
       (so a seed is visible in the same frame). */
    pollCatchup: function (st) {
        this.seedFromPoll(st);
        this.pollStatus(st);
        if (typeof st.event_count !== 'number') return;
        var restart = needsStreamRestart(st.event_count, this.state.seenN,
                                         this.state.pollN);
        this.state.pollN = st.event_count;
        if (restart) this.restartStream(st);
    },

    seedFromPoll: function (st) {
        // Forward-only seeding: a poll progress that is NEWER than the live
        // bar of that suite is fed through the normal event path. Harness
        // leaf restarts (cur below the live bar) are NOT seeded — banking a
        // leaf boundary belongs to the stream or to a full replay, never to
        // a single out-of-order snapshot.
        var lp = st && st.last_progress;
        if (!lp || lp.type !== 'progress' || lp.phase !== 'eval') return false;
        if (lp.bench_current == null) return false;
        var b = lp.benchmark || (lp.data && lp.data.benchmark) || '';
        if (!b) return false;
        var run = null;
        var entries = this.state.board || [];
        for (var i = 0; i < entries.length; i++)
            if (entries[i].running) run = entries[i];
        if (!run) return false;
        var bar = (run.bar || {})[b];
        if (bar && !(lp.bench_current > bar.cur)) return false;
        this.boardEvent(lp);
        return true;
    },

    restartStream: function (st) {
        var id = st.current_bench_id || this.state.benchId;
        if (!id) return;
        var entries = this.state.board || [];
        for (var i = 0; i < entries.length; i++)
            if (entries[i].running) resetBoardEntry(entries[i],
                this.state.harnessSizes, this.state.groups);
        this.startStream(id);
    },

    pollStatus: function (st) {
        // The stream paints message + counters off events; a silent stream
        // paints the very same shape off the poll (both read one event
        // source, so the line can only move forward).
        var lp = st && st.last_progress;
        if (!lp) return;
        var node = gid('bench-acc-status');
        if (!node || node.classList.contains('bench-status-error')) return;
        var msg = String(lp.message || lp.phase || '');
        if (msg !== this.state.lastMsg) {
            this.state.lastMsg = msg;
            this.state.lastAct = Date.now();      // the board IS moving
        }
        node.textContent = msg + this.statusCounterText(lp) + this.stallSuffix();
    },

    stallSuffix: function () {
        // Honesty, not decoration: polls keep answering but nothing has
        // changed for >90s, so the frozen line says so instead of lying.
        var s = this.state;
        if (!s.running || !s.lastAct) return '';
        var idle = Date.now() - s.lastAct;
        if (idle <= ACC_STALL_MS) return '';
        return ' — ' + t('uplift.bench.board_stalled',
                         'No progress events for {n}s')
            .replace('{n}', String(Math.round(idle / 1000)));
        // NO dataset.i18n here: a {placeholder} node would repaint raw (SAY-2c)
    },

    /* U83: board entries = the RUNNING entry (new queue_status field) +
       waiting entries. Progress state (suite fill, quiet notes) survives
       re-polls by merging on model|engine — the stream mutates between. */
    syncBoard: function (st) {
        var self = this;
        var prev = this.state.board || [];
        var groups = this.state.groups;
        var mk = function (q, running) {
            var key = q.model_id + '|' + (q.engine || 'classic') + '|' +
                      Object.keys(q.sizes || {}).sort().join(',');
            var old = null;
            for (var i = 0; i < prev.length; i++)
                if (prev[i].key === key) old = prev[i];
            var qs = boardQuestions(q.sizes || {}, q.engine || 'classic',
                                   self.state.harnessSizes, groups);
            var meta = {};
            Object.keys(q.sizes || {}).forEach(function (k) {
                meta[k] = boardSuiteMeta(groups, k, self.state.extraSuites);
            });
            var e = {
                key: key, model_id: q.model_id, engine: q.engine || 'classic',
                external: !!q.external, running: !!running, sizes: q.sizes || {},
                qper: qs.per, meta: meta,
                suiteState: (old && old.suiteState) || {},
                suiteDone: (old && old.suiteDone) || {},
                suiteQuiet: (old && old.suiteQuiet) || {},
            };
            // first paint: running entry's suites are 'running' (or the
            // first is — others queued), waiting entries all queued
            if (!Object.keys(e.suiteState).length) {
                var first = true;
                Object.keys(e.sizes).forEach(function (k) {
                    e.suiteState[k] = (running && first) ? 'running' : 'queued';
                    first = false;
                });
            } else if (running && !Object.keys(e.sizes).some(function (k) {
                    return e.suiteState[k] === 'running'
                        || e.suiteState[k] === 'preparing'; })) {
                // reload/refresh between suites: the moment no bar is
                // active, the first still-queued suite IS the live one
                var nxt = Object.keys(e.sizes).filter(function (k) {
                    return e.suiteState[k] === 'queued'; })[0];
                if (nxt) e.suiteState[nxt] = 'running';
            }
            return e;
        };
        var entries = [];
        if (st.running && st.running_entry) entries.push(mk(st.running_entry, true));
        else if (st.running && st.current_model)   // old server shape: honest fallback
            entries.push(mk({ model_id: st.current_model, sizes: {} }, true));
        (st.queue || []).forEach(function (q) { entries.push(mk(q, false)); });
        this.state.board = entries;
    },

    /* stream event -> board mutation (pure data, render is separate) */
    boardEvent: function (ev) {
        var entries = this.state.board || [];
        var run = null;
        for (var i = 0; i < entries.length; i++) if (entries[i].running) run = entries[i];
        if (!run) return;
        var b = ev.benchmark || (ev.data && ev.data.benchmark) || '';
        if (ev.type === 'progress') {
            if (b) {
                if (ev.bench_total && (run.qper[b] | 0) < ev.bench_total
                        && (ev.bench_total <= (run.qper[b] | 0) * 4 || !run.qper[b]))
                    run.qper[b] = ev.bench_total;      // classic's own total wins
                if (ev.phase === 'eval' && ev.bench_current != null) {
                    // Harness suites replay 'Requesting API' once PER LEAF
                    // subtask (mmlu: 57 bars of N). A bar that restarts
                    // (cur < last cur) closed the previous leaf — bank its
                    // total. Classic suites have ONE bar per suite, so the
                    // accumulator just rides it. (Interleaved same-suite
                    // bars do not occur in either engine's eval phase.)
                    run.bar = run.bar || {};
                    var prev = run.bar[b];
                    var acc = prev ? prev.acc : 0;
                    if (prev && ev.bench_current < prev.cur) acc += prev.tot;
                    run.bar[b] = { cur: ev.bench_current, tot: ev.bench_total || prev && prev.tot || 0, acc: acc };
                    run.suiteDone[b] = acc + ev.bench_current;
                    run.suiteState[b] = 'running';
                    delete run.suiteQuiet[b];
                }
                else if (ev.phase === 'prepare' || ev.phase === 'download') {
                    run.suiteState[b] = 'preparing';
                    run.suiteQuiet[b] = ev.quiet_s || null;
                }
            }
        } else if (ev.type === 'result') {
            if (b) {
                run.suiteState[b] = 'done';
                var banked = run.bar && run.bar[b]
                    ? run.bar[b].acc + (run.bar[b].tot || run.bar[b].cur) : 0;
                run.suiteDone[b] = (ev.data && ev.data.total) || banked
                    || run.suiteDone[b] || 0;
                if ((run.qper[b] | 0) < run.suiteDone[b]) run.qper[b] = run.suiteDone[b];
                // next suite of THIS entry starts when classic says so;
                // board pre-marks the first still-queued box as running
                var nxt = Object.keys(run.sizes).filter(function (k) {
                    return run.suiteState[k] === 'queued'; })[0];
                if (nxt) run.suiteState[nxt] = 'running';
            }
        } else if (ev.type === 'error') {
            Object.keys(run.sizes).forEach(function (k) {
                if (run.suiteState[k] === 'running' || run.suiteState[k] === 'preparing')
                    run.suiteState[k] = 'error';
            });
        }
    },

    renderQueue: function (st) {
        var wrap = gid('bench-acc-queue');
        if (!wrap) return;
        var self = this;
        var entries = this.state.board || [];
        var empty = !st.running && !(st.queue || []).length;
        /* ACC-STALL: the queue poll now runs every 4s while a run is live.
           The SHAPE (which entries, which suite boxes, the phase chip) only
           changes at transitions, so an unchanged shape repaints the numbers
           IN PLACE (boardPaint) instead of rebuilding — rebuilding under the
           pointer killed hover, and the board was built to survive 1 Hz
           events exactly for that reason. */
        var sig = (st.phase || '') + '|' + entries.map(function (e) {
            return (e.running ? '>' : '') + e.key + '[' +
                   Object.keys(e.sizes || {}).join(',') + ']';
        }).join(';');
        if (sig === this._qSig && !(empty && !wrap.hidden)) {
            if (!empty) this.boardPaint();
            return;
        }
        this._qSig = sig;
        wrap.replaceChildren();
        if (empty) { wrap.hidden = true; return; }
        wrap.hidden = false;
        wrap.appendChild(el('div', 'bench-label',
            t('acc_bench.config.queue_label', 'Queue')));
        var d = dom();
        var skip = entries.length && entries[0].running ? 1 : 0;
        entries.forEach(function (e, idx) {
            var row = el('div', 'acc-board-entry' + (e.running ? ' running' : ''));
            row.dataset.key = e.key;
            var head = el('div', 'acc-board-head');
            head.appendChild(el('span', 'acc-board-model',
                (e.running ? '▸ ' : (idx - skip + 1) + '. ') + e.model_id +
                (e.external ? ' [' + t('acc_bench.results.external_badge', 'external') + ']' : '')));
            var eng = el('span', 'acc-board-engine ' + (e.engine === 'harness' ? 'h' : 'c'),
                t(e.engine === 'harness' ? 'uplift.bench.engine_harness'
                                         : 'uplift.bench.engine_classic',
                  e.engine === 'harness' ? 'LM-Eval' : 'oMLX Classic'));
            head.appendChild(eng);
            if (e.running && st.phase)
                head.appendChild(el('span', 'acc-board-phase', st.phase));
            else if (!e.running) {
                var rm = el('button', 'acc-queue-remove', '×');
                rm.type = 'button';
                rm.title = t('models.queue.remove_tooltip', 'Remove');
                rm.addEventListener('click', async function () {
                    try { await d.deleteJson(api() + '/bench/accuracy/queue/' + (idx - skip)); self.refreshQueue(); }
                    catch (err) { d.toast(String((err && err.message) || err), 'error'); }
                });
                head.appendChild(rm);
            }
            row.appendChild(head);
            var boxes = el('div', 'acc-board-suites');
            Object.keys(e.sizes).forEach(function (k) {
                boxes.appendChild(self.suiteBoxEl(e, k));
            });
            row.appendChild(boxes);
            wrap.appendChild(row);
        });
    },

    /* suite box: '[ MMLU  28/300 ]' with a left-to-right fill underlay.
       Updated IN PLACE from the stream (widths/text only) so hovering and
       scroll survive 1 Hz events. */
    suiteBoxEl: function (e, k) {
        var box = el('div', 'acc-suite st-' + (e.suiteState[k] || 'queued'));
        box.dataset.k = k;
        var fill = el('div', 'acc-suite-fill');
        var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
        fill.style.width = (e.suiteState[k] === 'done' ? 100
            : (tot ? Math.min(100, Math.round(done / tot * 100)) : 0)) + '%';
        var lab = el('span', 'acc-suite-name', (e.meta[k] && e.meta[k].label) || k);
        var cnt = el('span', 'acc-suite-count', this.suiteCountText(e, k));
        box.append(fill, lab, cnt);
        box.title = this.suiteTitle(e, k);
        return box;
    },
    suiteCountText: function (e, k) {
        var stt = e.suiteState[k] || 'queued';
        var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
        if (stt === 'done') return tot ? tot + '/' + tot : '✓';
        if (stt === 'queued') return tot ? '0/' + tot : '—';
        return tot ? done + '/' + tot : (stt === 'preparing' ? '…' : '—');
    },
    suiteTitle: function (e, k) {
        var stt = e.suiteState[k] || 'queued';
        if (stt === 'preparing') {
            var q = e.suiteQuiet[k];
            return q ? t('uplift.bench.board_preparing_quiet',
                'Preparing dataset — lm-eval silent {n}s (download/build)')
                .replace('{n}', q)
                : t('uplift.bench.board_preparing', 'Preparing dataset…');
        }
        return ({ running: t('uplift.bench.board_running', 'Running'),
                  done: t('uplift.bench.board_done', 'Done'),
                  error: t('uplift.bench.board_error', 'Error'),
                  queued: t('uplift.bench.board_queued', 'Queued') })[stt] || stt;
    },
    /* in-place repaint from the board data (no rebuild) */
    boardPaint: function () {
        var wrap = gid('bench-acc-queue');
        if (!wrap || wrap.hidden) return;
        var entries = this.state.board || [];
        var rows = wrap.querySelectorAll('.acc-board-entry');
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var r = null;
            for (var j = 0; j < rows.length; j++)
                if (rows[j].dataset.key === e.key) r = rows[j];
            if (!r) continue;
            Object.keys(e.sizes).forEach(function (k) {
                var box = r.querySelector('.acc-suite[data-k="' + k + '"]');
                if (!box) return;
                var stt = e.suiteState[k] || 'queued';
                box.className = 'acc-suite st-' + stt;
                var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
                var pct = tot ? Math.min(100, Math.round(done / tot * 100)) : 0;
                if (stt === 'done') pct = 100;
                var f = box.querySelector('.acc-suite-fill');
                if (f) f.style.width = pct + '%';
                var c = box.querySelector('.acc-suite-count');
                if (c) c.textContent = ACC.suiteCountText(e, k);
                box.title = ACC.suiteTitle(e, k);
            });
        }
    },

    statusCounterText: function (ev) {
        // user shape: [running-suite/total-suites · done-q/total-q] over
        // the WHOLE board (both engine entries); falls back to the entry
        // fields when no board data exists (classic-page runs)
        var c = boardCounters(this.state.board || []);
        if (!c.total && ev && ev.total) {
            return ' [' + ((ev.current | 0) + 1) + '/' + ev.total + ' suites]';
        }
        if (!c.total) return '';
        var qs = c.qTotal ? ' · ' + c.qDone.toLocaleString() + '/' +
                   c.qTotal.toLocaleString() + ' q' : '';
        return ' [' + c.cur + '/' + c.total + ' suites' + qs + ']';
    },

    startStream: function (benchId) {
        var self = this;
        stopStream();
        // ACC-STALL: a replay restarts the consumed counter — events are
        // counted from index 0 again, which is exactly what the server sends
        var arm = function () {
            if (_poll) clearInterval(_poll);
            _poll = setInterval(function () { self.refreshQueue(); },
                                 ACC_POLL_MS);
        };
        this.state.seenN = 0;
        this.state.pollN = null;
        if (!W().EventSource) { arm(); return; }
        try {
            _es = new EventSource(api() + '/bench/accuracy/' + encodeURIComponent(benchId) + '/stream');
            _es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            // U83: onerror fires when the server dies AND when a proxy
            // half-closes the socket; EventSource then retries silently,
            // so the board froze on the last event with a live queue (the
            // 'stuck' half that was NOT the harness). Interrupt visibly and
            // poll for truth: refreshQueue restarts the stream once the run
            // reappears or marks the board done when it does not.
            _es.onerror = function () {
                streamInterrupted('bench-acc-status');
                arm();
            };
            // ACC-STALL: the socket can also die SILENTLY (half-open after a
            // proxy blip: no error event, no data, EventSource thinks it is
            // connected). The stream is never the only source of truth — the
            // 4s queue poll runs alongside it whenever it is open, and
            // pollCatchup decides whether the stream has to be rebuilt.
            arm();
        } catch (e) { arm(); }
    },

    onEvent: function (ev) {
        var st = gid('bench-acc-status');
        // ACC-STALL: the poll compares this counter against the server's
        // event_count to spot a stream that stopped delivering
        this.state.seenN = (this.state.seenN | 0) + 1;
        this.state.lastAct = Date.now();
        // U83: every event first mutates the board data, then the widgets
        // paint from it — counters and boxes can never disagree with each
        // other because they read the same source
        this.boardEvent(ev);
        if (ev.type === 'progress') {
            if (st) st.textContent = (ev.message || ev.phase || '') +
                this.statusCounterText(ev);
            this.state.lastMsg = String(ev.message || ev.phase || '');
            // U-PROG: the queue box fills per suite; the top bar tracks the
            // whole board (same counters the text reads from)
            var c = boardCounters(this.state.board || []);
            var denom = c.qTotal || c.total;
            if (denom) setBar('bench-acc-status',
                (c.qTotal ? c.qDone / c.qTotal : c.cur / c.total) * 100);
            this.boardPaint();
        } else if (ev.type === 'result') {
            this.boardPaint();
            this.refreshResults();
        } else if (ev.type === 'error') {
            if (st) { st.textContent = String(ev.message || 'error');
                      st.classList.add('bench-status-error'); }
            this.state.running = false;
            stopStream();
            this.boardPaint();
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
        var self = this;
        var wrap = gid('bench-acc-results');
        if (!wrap) return;
        var rows = this.state.results;
        if (!rows.length) { wrap.replaceChildren(); return; }
        var tbl = el('table', 'bench-table');
        var head = el('tr');
        [t('bench.config.model', 'Model'), t('acc_bench.results.category', 'Benchmark'),
         t('acc_bench.results.correct_line', '{correct} of {total} in {time}s'),
         t('acc_bench.results.total_accuracy', 'Total accuracy'),
         t('acc_bench.results.download', 'Download')].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        tbl.appendChild(head);
        rows.forEach(function (r) {
            var tr = el('tr');
            var badges = '';
            // U68: the engine word told users nothing; badge the real names
            if (r.engine === 'harness') badges += ' [' + t('uplift.bench.badge_harness', 'LM-Eval') + ']';
            else if (r.engine === 'classic') badges += ' [' + t('uplift.bench.badge_classic', 'Built-in') + ']';
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
            var dlCell = el('td');
            // U70: classic's per-row Download menu (JSON/CSV/TXT in
            // classic's exact formats and classic i18n labels)
            dlCell.appendChild(dlMenu(function () {
                return String(r.model_id || 'run') + '_' + String(r.benchmark || '');
            }, [
                [function (name) { dlFile(name + '.json', 'application/json', accExportJson(r)); },
                 'acc_bench.results.download_json', 'JSON'],
                [function (name) { dlFile(name + '.csv', 'text/csv', accExportCsv(r)); },
                 'acc_bench.results.download_csv', 'CSV'],
                [function (name) { dlFile(name + '.txt', 'text/plain', accExportTxt(r)); },
                 'acc_bench.results.download_txt', 'TXT'],
            ]));
            tr.append(
                el('td', null, String(r.model_id || '')),
                el('td', null, String(r.benchmark || '')),
                el('td', null, line + (up ? ' ' + up : '')),
                el('td', null, ((r.accuracy || 0) * 100).toFixed(1) + '% ' + badges),
                dlCell);
            tbl.appendChild(tr);
        });
        // U49: Copy of the whole matrix in classic's own export format
        wrap.replaceChildren(
            resultsHead(function () {
                return buildAccuracyText(rows, self.state.groups);
            }, 'acc_bench.results.text_export.section_label',
               'Benchmark Results (Text — Copy & Paste)'),
            tbl);
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
                if (BENCHQ.isQueued(r)) { BENCHQ.note(); return; }
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
                _es.onerror = function () { streamInterrupted(prefix + '-status'); };
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
            self.renderStatus('⚠ ' + String((e && e.message) || e));
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
            if (BENCHQ.isQueued(r)) { BENCHQ.note(); return; }
            this.state.running = true;
            this.state.runId = r.run_id;
            this.setButtons();
            this.startStream(r.run_id);
        } catch (e) {
            rel();
            d.toast(String((e && e.message) || e), 'error');
        }
    },

    cancel: async function () {
        var d = dom();
        if (!this.state.runId) return;
        try { await d.postJson(api() + '/bench/decision/'
            + encodeURIComponent(this.state.runId) + '/cancel', {}); }
        catch (e) { d.toast(String((e && e.message) || e), 'error'); }
    },

    clearResults: async function () {
        var d = dom();
        try {
            await d.postJson(api() + '/bench/decision/results/reset', {});
            this.refreshResults();
        } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
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
            _es = new EventSource(api() + '/bench/decision/'
                + encodeURIComponent(runId) + '/stream');
            _es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            _es.onerror = function () { streamInterrupted('bench-dec-status'); };
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

function stopStream() {
    if (_es) { try { _es.close(); } catch (_) {} _es = null; }
    if (_poll) { clearInterval(_poll); _poll = null; }
    if (typeof ANE !== 'undefined' && ANE.stopTimer) ANE.stopTimer();
}

return { mount: mount, isMounted: function () { return _mounted; },
         showSub: showSub, tp: TP,
         // BENCHQ test seam: the global queue box (mount/render/remove are
         // pure DOM + one GET, so a node harness can replay payloads)
         BENCHQ: BENCHQ,
         // U83 test seams: the queue board model (pure) + ACC methods so
         // a node harness can replay status payloads + event sequences
         _board: { boardSuiteMeta: boardSuiteMeta, boardQuestions: boardQuestions,
                   boardSuiteBoxes: boardSuiteBoxes, boardCounters: boardCounters,
                   // ACC-STALL: the two pure helpers behind the stall-proof
                   // poll (restart decision + replay-safe accumulator reset)
                   needsStreamRestart: needsStreamRestart,
                   resetBoardEntry: resetBoardEntry },
         // U49 structural test seams: panel modules + the shared export
         // builders, so a DOM-free harness can prove every panel wires
         // resultsHead/advancedSection (card's Verify: 'import graph or
         // DOM assertion in the mount-test harness')
         _panels: { ctx: CTX, ane: ANE, acc: ACC, dec: DEC,
                    // BENCHQ: mtebPanel is the instance CACHE (showSub uses
                    // it too), so a harness reaches the panel on screen
                    mteb: mtebPanel },
         // ACC-2a test seam: the extras module (its pure helpers are
         // asserted directly; the section itself is proven through the
         // mount harness in tests/acc2a-extras.test.cjs)
         _extras: EXTRAS,
         _u49: { resultsHead: resultsHead, buildTableText: buildTableText,
                 buildAccuracyText: buildAccuracyText,
                 ctxResultPairs: ctxResultPairs,
                 // U-CPY clipboard/export generators
                 toMarkdown: toMarkdown, csvText: csvText, dropMenu: dropMenu,
                 advancedSection: advancedSection,
                 // TP-TABLES: the painter both the live panel and the
                 // history cards use (needs the harness DOM)
                 buildTpTables: buildTpTables, simpleTable: simpleTable },
         // U47 test seams (pure text-export plumbing; U49 reuses)
         _benchText: { buildThroughputText: buildThroughputText,
                       fmtNum: fmtNum, fmtMemory: fmtMemory,
                       singleTestLabel: singleTestLabel,
                       batchPromptSummary: batchPromptSummary,
                       outTokens: outTokens, outCell: outCell,
                       ctxTargetOptions: ctxTargetOptions,
                       // TP-TABLES: the classic two-table spec (pure data —
                       // heads, catalog keys, tooltips, cell formatters) the
                       // live panel and the history cards both paint from,
                       // plus the concatenated export column list
                       tpTableSpecs: tpTableSpecs, tpDlCols: tpDlCols,
                       tpSingles: tpSingles, tpBatch: tpBatch,
                       tpBaseline: tpBaseline, tpPpPerReq: tpPpPerReq,
                       tpCacheOffNote: tpCacheOffNote } };
});
