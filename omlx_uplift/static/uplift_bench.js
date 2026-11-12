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
    // SPLIT-3: the bench is the core below plus one part file per bench
    // panel (uplift_bench_*.js). In the browser the parts load first and
    // register on UpliftBenchParts; the core calls each part factory with a
    // bridge to its own helpers and state.
    if (typeof module !== 'undefined' && module.exports) module.exports = factory({
        tp: require('./uplift_bench_tp.js'),
        ctx: require('./uplift_bench_ctx.js'),
        ane: require('./uplift_bench_ane.js'),
        acc: require('./uplift_bench_acc.js'),
        mteb: require('./uplift_bench_mteb.js'),
        dec: require('./uplift_bench_dec.js') });
    else root.UpliftNativeBench = factory(root.UpliftBenchParts || {});
})(typeof self !== 'undefined' ? self : this, function (PARTS) {
'use strict';

var _mounted = false;
var _sub = 'throughput';
var _es = null;          // throughput SSE
var _poll = null;        // fallback poll timer while SSE unavailable
var _curPanel = null;    // BENCHQ: the panel instance showSub() painted

function W() { return (typeof window !== 'undefined') ? window : null; }
function C() { return W() && W().UpliftCore ? W().UpliftCore : null; }
function dom() { return W() && W().UpliftDom ? W().UpliftDom : null; }
/* UP-52 (ratchet closed for this file): anything a human reads from a caught
   error goes through the kit's errText. domkit keeps the internal
   '<route> -> <status>: reason' shape on the error for console/tests and
   publishes `.userMessage` route-free (UP-49), so a bench toast or status line
   can no longer spell our URL layout to the operator. The no-kit branch covers
   headless harnesses that stub UpliftDom without the UP-49 seam; it applies the
   SAME leading-route cut, so the test path cannot leak the shape either. */
function errText(e) {
    var d = dom();
    if (d && d.errText) return d.errText(e);
    if (e == null) return '';
    if (e.userMessage) return e.userMessage;
    // No kit seam (headless harness): String(err) carries a 'TypeError: ' style
    // constructor prefix the show sites never had — drop it so the text matches
    // what the kit would have returned, then cut the leading route the same way.
    var s = (typeof e === 'string') ? e
        : String(e).replace(/^[A-Za-z][\w$]*(?:Error|Exception): /, '');
    var i = s.indexOf(' -> ');
    return i >= 0 ? s.slice(i + 4) : s;
}
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

/* ta(): a RE-PAINTABLE label in one call — the catalog key, the English it
   was painted from, and the resolved text. Call sites write the literals
   through ta() on purpose: the locale-sync gate (tests/test_locale_sync.py
   D5) only sees `t('key'…)`/`tf`/`ta`/`tr` calls and
   `dataset.i18n = 'key'` assignments, so a label assembled from variables
   is invisible to it and can ship with no catalog entry at all. */
function ta(key, en) { return { k: key, en: en, s: t(key, en) }; }

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

    /* SYNC-1 fire9 (upstream d59d797 #4855): classic warns on both bench
       forms that a model's stored GPU power cap does not apply while the
       benchmark runs (bench.config.gpu_power_limit_note, _bench.html +
       _bench_context.html). Placeholder-substituted text → paint with
       tf().replace, never data-i18n (SAY-2c). */
    function benchGpuWatts(rows, id) {
        if (!id) return 0;
        var m = (rows || []).filter(function (r) {
            return (r.id || r.model_id) === id; })[0];
        return (m && m.settings && m.settings.gpu_power_limit_w) || 0;
    }
    function gpuNoteText(w) {
        return t('bench.config.gpu_power_limit_note',
            "This model's {watts} W GPU power limit does not apply to benchmarks.")
            .replace('{watts}', String(w));
    }
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
     ['accuracy', t('uplift.bench.accuracy', 'Accuracy')],
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
    var titles = { accuracy: ['uplift.bench.accuracy', 'Accuracy'],
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
    accuracy:   ['uplift.bench.accuracy', 'Accuracy'],
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
            t('uplift.bench.queue_title', 'Benchmark queue'));
        // U59 doctrine: labels painted before the locale fetch land carry
        // their key + the English shown, so applyI18n() repairs them — the
        // header is built once per mount and never re-rendered by the poll.
        head.dataset.i18n = 'uplift.bench.queue_title';
        head.dataset.en = t('uplift.bench.queue_title', 'Benchmark queue');
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
                if (d) d.toast(errText(err), 'error');
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
            + pad(t('acc_bench.results.text_export.think', 'Think'), 8)
            + pad('MaxTok', 9));
        lines.push('-'.repeat(71));
        rows.filter(function (r) { return r.model_id === m; }).forEach(function (r) {
            lines.push(
                rpad(String(r.benchmark).toUpperCase(), 16)
                + pad((r.accuracy * 100).toFixed(1) + '%', 10)
                + pad(r.correct, 10) + pad(r.total, 8) + pad(r.time_s, 10)
                + pad(r.thinking_used
                    ? t('acc_bench.results.text_export.yes', 'Yes')
                    : t('acc_bench.results.text_export.no', 'No'), 8)
                + pad(r.external ? '-' : (r.max_tokens || '-'), 9));
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
                    .catch(function (e) { d.toast(errText(e), 'error'); });
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
        max_tokens: r.max_tokens,
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

// ---- tp: moved to uplift_bench_tp.js (SPLIT-3) ----
var BENCH_TP = PARTS.tp({
    W: W,
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    ta: ta,
    benchGpuWatts: benchGpuWatts,
    gpuNoteText: gpuNoteText,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    check: check,
    checkI18n: checkI18n,
    gid: gid,
    streamInterrupted: streamInterrupted,
    statusLine: statusLine,
    setBar: setBar,
    advancedSection: advancedSection,
    checkedVals: checkedVals,
    fmtNum: fmtNum,
    fmtMemory: fmtMemory,
    buildThroughputText: buildThroughputText,
    simpleTable: simpleTable,
    loadHistory: loadHistory,
    resultsHead: resultsHead,
    tpTip: tpTip,
    tpDlCols: tpDlCols,
    buildTpTables: buildTpTables,
    tpHistoryBody: tpHistoryBody,
    stopStream: stopStream,
    get _es() { return _es; }, set _es(v) { _es = v; },
    get _poll() { return _poll; }, set _poll(v) { _poll = v; },
    get PROMPT_LENGTHS() { return PROMPT_LENGTHS; },
    get BATCH_SIZES() { return BATCH_SIZES; },
    get GEN_LENGTHS() { return GEN_LENGTHS; },
    get PROFILES() { return PROFILES; },
    get PROFILE_FALLBACK() { return PROFILE_FALLBACK; },
    get BENCHQ() { return BENCHQ; }
});
var PF_MIN_TOKENS = BENCH_TP.PF_MIN_TOKENS,
    PF_MAX_PARALLEL = BENCH_TP.PF_MAX_PARALLEL, pfBody = BENCH_TP.pfBody,
    PF = BENCH_TP.PF, TP = BENCH_TP.TP;


// ---- ctx: moved to uplift_bench_ctx.js (SPLIT-3) ----
var BENCH_CTX = PARTS.ctx({
    W: W,
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    ctxTargetOptions: ctxTargetOptions,
    benchGpuWatts: benchGpuWatts,
    gpuNoteText: gpuNoteText,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    gid: gid,
    streamInterrupted: streamInterrupted,
    statusLine: statusLine,
    setBar: setBar,
    ctxResultPairs: ctxResultPairs,
    buildTableText: buildTableText,
    historyEmptyNote: historyEmptyNote,
    loadHistory: loadHistory,
    resultsHead: resultsHead,
    stopStream: stopStream,
    get _es() { return _es; }, set _es(v) { _es = v; },
    get _poll() { return _poll; }, set _poll(v) { _poll = v; },
    get CTX_CUSTOM_MIN() { return CTX_CUSTOM_MIN; },
    get BENCHQ() { return BENCHQ; }
});
var CTX = BENCH_CTX.CTX;

// ---- ane: moved to uplift_bench_ane.js (SPLIT-3) ----
var BENCH_ANE = PARTS.ane({
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    check: check,
    gid: gid,
    statusLine: statusLine,
    setBar: setBar,
    advancedSection: advancedSection,
    buildTableText: buildTableText,
    simpleTable: simpleTable,
    historyEmptyNote: historyEmptyNote,
    loadHistory: loadHistory,
    resultsHead: resultsHead,
    dlCols: dlCols
});
var ANE = BENCH_ANE.ANE;


// ---- acc: moved to uplift_bench_acc.js (SPLIT-3) ----
var BENCH_ACC = PARTS.acc({
    W: W,
    C: C,
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    check: check,
    gid: gid,
    taskCard: taskCard,
    loadingNote: loadingNote,
    streamInterrupted: streamInterrupted,
    statusLine: statusLine,
    setBar: setBar,
    boardSuiteMeta: boardSuiteMeta,
    boardQuestions: boardQuestions,
    boardCounters: boardCounters,
    advancedSection: advancedSection,
    buildAccuracyText: buildAccuracyText,
    dlFile: dlFile,
    accExportJson: accExportJson,
    accExportCsv: accExportCsv,
    accExportTxt: accExportTxt,
    dlMenu: dlMenu,
    resultsHead: resultsHead,
    stopStream: stopStream,
    get _es() { return _es; }, set _es(v) { _es = v; },
    get _poll() { return _poll; }, set _poll(v) { _poll = v; },
    get BENCHQ() { return BENCHQ; }
});
var EXTRAS = BENCH_ACC.EXTRAS, ACC_PICKS_KEY = BENCH_ACC.ACC_PICKS_KEY,
    accLoadPicks = BENCH_ACC.accLoadPicks,
    accSavePicks = BENCH_ACC.accSavePicks,
    accValidatePicks = BENCH_ACC.accValidatePicks,
    needsStreamRestart = BENCH_ACC.needsStreamRestart,
    resetBoardEntry = BENCH_ACC.resetBoardEntry, ACC = BENCH_ACC.ACC;

// ---- mteb: moved to uplift_bench_mteb.js (SPLIT-3) ----
var BENCH_MTEB = PARTS.mteb({
    W: W,
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    gid: gid,
    taskCard: taskCard,
    loadingNote: loadingNote,
    streamInterrupted: streamInterrupted,
    statusLine: statusLine,
    setBar: setBar,
    buildTableText: buildTableText,
    resultsHead: resultsHead,
    stopStream: stopStream,
    get _es() { return _es; }, set _es(v) { _es = v; },
    get _poll() { return _poll; }, set _poll(v) { _poll = v; },
    get BENCHQ() { return BENCHQ; }
});
var MTEB = BENCH_MTEB.MTEB;

// ---- dec: moved to uplift_bench_dec.js (SPLIT-3) ----
var BENCH_DEC = PARTS.dec({
    W: W,
    dom: dom,
    errText: errText,
    api: api,
    t: t,
    el: el,
    busyLabel: busyLabel,
    labeled: labeled,
    gid: gid,
    taskCard: taskCard,
    loadingNote: loadingNote,
    streamInterrupted: streamInterrupted,
    statusLine: statusLine,
    setBar: setBar,
    fmtMs: fmtMs,
    msPerItem: msPerItem,
    buildTableText: buildTableText,
    thHelp: thHelp,
    resultsHead: resultsHead,
    stopStream: stopStream,
    get _es() { return _es; }, set _es(v) { _es = v; },
    get BENCHQ() { return BENCHQ; }
});
var DEC = BENCH_DEC.DEC;

function stopStream() {
    if (_es) { try { _es.close(); } catch (_) {} _es = null; }
    if (_poll) { clearInterval(_poll); _poll = null; }
    if (typeof ANE !== 'undefined' && ANE.stopTimer) ANE.stopTimer();
}

return { mount: mount, isMounted: function () { return _mounted; },
         showSub: showSub, tp: TP,
         // PREFILL (user item 4) test seams: the probe panel object + its
         // pure body collector/validator (bounds mirrored from
         // bench_prefill.py, so a node test can pin both ends of that
         // contract without a DOM)
         prefill: PF, _prefillBody: pfBody,
         _prefillBounds: { MIN_TOKENS: PF_MIN_TOKENS, MAX_PARALLEL: PF_MAX_PARALLEL },
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
         // REMEMBER (user 2026-11-01) test seam: the accuracy-picks
         // persistence helpers (pure; drive them with a map-backed
         // localStorage stub)
         _accPicks: { KEY: ACC_PICKS_KEY, load: accLoadPicks,
                      save: accSavePicks, validate: accValidatePicks },
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
