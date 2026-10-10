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
// 2048..524288 integers; the runner still clamps to native + floors to
// 2k, so an over-native custom value is safe, just capped at run time).
var CTX_CUSTOM_MIN = 2048;
var CTX_CUSTOM_MAX = 524288;
function ctxTargetOptions(native, ladder) {
    // native values ABOVE the accepted ceiling are floored to it and the
    // label tells the truth ('1,048,576 -> testing 524,288'): never silent
    // rounding. Below-ceiling natives (135,168) pass through untouched -
    // the uplift server side accepts any whole number in the range, so no
    // nearest-power-of-two fallback is needed (card step-1 assumed the
    // whitelist would stay; step 2 removed that constraint).
    var out = [];
    var list = ladder || TARGET_TOKENS;
    if (native && native > 0) {
        var test = Math.min(native, CTX_CUSTOM_MAX);
        var label = native.toLocaleString();
        if (test !== native) label += ' \u2192 ' + test.toLocaleString();
        out.push({ value: String(test), label: label, native: true });
        list.filter(function (tk) { return tk < native && tk <= test; })
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
function statusLine(id) {
    var st = el('div', 'bench-status'); st.id = id;
    st.setAttribute('role', 'status');
    st.setAttribute('aria-live', 'polite');
    return st;
}
// U51: ms-per-question with locale separators + one decimal (a raw
// 568.75 next to formatted columns reads like a machine dump)
function fmtMs(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString(undefined,
        { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
function boardSuiteMeta(groups, key) {
    // classic card truth sources: label for the box, full_size for a
    // 'Full' selection (size 0); unknown -> null (board renders '?')
    for (const g of (groups || []))
        for (const tk of (g.tasks || []))
            if (tk.key === key) return { label: tk.label || key, full: tk.full_size || 0 };
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
    host.append(strip, panel);
    showSub(_sub);
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
    if (sub === 'throughput') TP.render(panel);
    else if (sub === 'accuracy') ACC.render(panel);
    else if (sub === 'context') CTX.render(panel);
    else if (sub === 'ane') ANE.render(panel);
    else if (sub === 'embed') MTEB('embed').render(panel);
    else if (sub === 'rerank') MTEB('rerank').render(panel);
    else if (sub === 'decision') DEC.render(panel);
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
function simpleTable(cols, rows) {
    var tbl = el('table', 'bench-table');
    var head = el('tr');
    cols.forEach(function (c) { head.appendChild(el('th', null, c[1])); });
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
    a.remove();
    w.URL.revokeObjectURL(url);
    return true;
}

function dlJson(nameBase, value) {
    return dlFile(nameBase + '.json', 'application/json',
        JSON.stringify(value, null, 2));
}

// CSV from a column spec — shared by every surface's Download CSV
function dlCsv(nameBase, cols, rows) {
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
    return dlFile(nameBase + '.csv', 'text/csv', out.join('\n'));
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
                f[0](makeName());
                open.remove(); open = null;
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

// U49: one Copy button factory for all result cards (classic's export
// blocks all say the same 'Copy' with the section label as hover text)
function resultsHead(buildText, titleKey, titleFb, dl) {
    var head = el('div', 'bench-results-head');
    var btn = el('button', 'btn', t('bench.results.text_export.copy', 'Copy'));
    btn.type = 'button';
    btn.title = t(titleKey || 'bench.results.text_export.section_label',
                  titleFb || 'Benchmark Results (Text — Copy & Paste)');
    btn.addEventListener('click', function () {
        copyPlainText(buildText(),
            t('bench.results.text_export.copied', 'Copied!'));
    });
    head.appendChild(btn);
    // U70: whole-result set downloads for EVERY surface (user asked for
    // classic's availability everywhere, not just Intelligence). dl =
    // {name(): file stem, rows(), cols(): [{head, get}]}
    if (dl) {
        var dlBtn = el('button', 'btn', t('acc_bench.results.download', 'Download'));
        dlBtn.type = 'button';
        var open = null;
        dlBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (open) { open.remove(); open = null; return; }
            open = el('div', 'bench-dl-menu');
            [['json', 'acc_bench.results.download_json', 'JSON',
              function () { dlJson(dl.name(), dl.rows()); }],
             ['csv', 'acc_bench.results.download_csv', 'CSV',
              function () { dlCsv(dl.name(), dl.cols(), dl.rows()); }]]
              .forEach(function (f) {
                var b = el('button', null, t(f[1], f[2]));
                b.type = 'button';
                b.addEventListener('click', function (ev2) {
                    ev2.stopPropagation();
                    f[3]();
                    open.remove(); open = null;
                });
                open.appendChild(b);
            });
            head.appendChild(open);
            var dismiss = function () {
                if (open) { open.remove(); open = null; }
                document.removeEventListener('click', dismiss);
            };
            setTimeout(function () { document.addEventListener('click', dismiss); }, 0);
        });
        head.appendChild(dlBtn);
    }
    return head;
}

// U70: standard cols from the shared [key, label] tables
function dlCols(defs) {
    return defs.map(function (c) {
        return { head: c[1], get: function (r) { return r[c[0]]; } };
    });
}

// U64: one column definition for the live table AND history snapshots
function TP_COLS_DEF() {
    return [
        ['pp', 'PP'], ['tg', 'TG'],
        ['ttft_ms', t('bench.metrics.ttft.name', 'TTFT')],
        ['processing_tps', t('bench.metrics.pp_tps.name', 'pp TPS')],
        ['gen_tps', t('bench.metrics.tg_tps.name', 'tg TPS')],
        ['total_throughput', t('bench.metrics.throughput.name', 'Throughput')],
        ['tpot_ms', t('bench.metrics.tpot.name', 'TPOT')],
        ['e2e_latency_s', t('bench.metrics.e2e.name', 'E2E')],
        ['batch_size', t('bench.metrics.batch_size.name', 'Batch Size')],
    ];
}
var TP_COLS = null;   // resolved on first render (catalog may load later)

function tpHistoryBody(e) {
    var card = el('div', 'bench-result card');
    var ctx = { model: e.model_id || '',
                profile: (e.meta && e.meta.context_profile) || 'code_python',
                forceLm: false,
                external: (e.meta && e.meta.external) ? { model: e.model_id } : null };
    var rows = e.rows || [];
    if (!TP_COLS) TP_COLS = TP_COLS_DEF();
    if (!rows.length) {
        card.appendChild(historyEmptyNote());
        return card;
    }
    card.appendChild(simpleTable(TP_COLS.map(function (c) {
        return [c[0], c[1], function (v) {
            return v == null ? '\u2014'
                : (typeof v === 'number' ? TP.fmt(c[0], v) : String(v));
        }];
    }), rows));
    card.prepend(resultsHead(function () {
        return buildThroughputText(ctx, rows);
    }));
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
        var adv = advancedSection([
            check('bench-tp-ane', t('bench.config.ane_aligned_prompt', 'ANE-aligned prompts (+1 token)'), false),
            check('bench-tp-lm', t('bench.config.force_lm_engine', 'Force mlx-lm engine'), false),
            check('bench-tp-ext', t('bench.config.external', 'Use external OpenAI API endpoint'), false),
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
            });
            var gen = gid('bench-tp-gen');
            if (gen) gen.addEventListener('change', function (ev) {
                if (ev.target && ev.target.checked && batchHint)
                    batchHint.textContent = t('bench.config.batch_hint',
                        'Batch tests use pp1024 / tg128')
                        .replace('tg128', 'tg' + Number(ev.target.value).toLocaleString());
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
            this.state.benchId = out.bench_id;
            rel();
            this.startStream(out.bench_id);
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
        TP_COLS = TP_COLS_DEF();   // U64: labels track the catalog
        var wrap = gid('bench-tp-results');
        if (!wrap) return;
        var rows = this.state.results;
        if (!rows.length) { wrap.replaceChildren(); return; }
        var self = this;
        var tbl = simpleTable(TP_COLS.map(function (c) {
            return [c[0], c[1], function (v) {
                return v == null ? '\u2014'
                    : (typeof v === 'number' ? self.fmt(c[0], v) : String(v));
            }];
        }), rows);
        // U47: classic has a Copy of the whole result set as plain text
        // ("Benchmark Results (Text — Copy & Paste)"); mirror it above the
        // table with the classic format (buildThroughputText).
        wrap.replaceChildren(
            resultsHead(function () {
                return buildThroughputText(self.state.ctx, self.state.results);
            }, null, null, {
                name: function () { return 'uplift_throughput_'
                    + String((self.state.ctx && self.state.ctx.model) || 'run'); },
                rows: function () { return self.state.results; },
                cols: function () { return dlCols(TP_COLS || TP_COLS_DEF()); },
            }), tbl);
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
        this.loadHist();   // U64: the run is in history now — show it
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
        customInp.min = String(CTX_CUSTOM_MIN); customInp.max = String(CTX_CUSTOM_MAX);
        customInp.step = '1';
        customInp.placeholder = t('uplift.bench.ctx_custom_placeholder',
            'tokens (2,048 – 524,288)');
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
        if (!isFinite(v) || v !== Math.floor(v)
            || v < CTX_CUSTOM_MIN || v > CTX_CUSTOM_MAX) {
            d.toast(t('uplift.bench.ctx_custom_range',
                'Custom target must be a whole number between 2,048 and 524,288 tokens.'));
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
                       selected: {}, sizes: {}, results: [],
                       // U68: {suite: leaf subtask count}; harness --limit
                       // applies PER subtask, the labels must say so
                       harnessSizes: ACC._sizesCache || null,
                       harnessTasks: ACC._tasksCache || [],
                       engine: 'classic' };
        panel.appendChild(this.form());
        var queue = el('div', 'acc-queue'); queue.id = 'bench-acc-queue';
        var status = statusLine('bench-acc-status');
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
            'oMLX Classic samples N questions total. LM-Eval runs N PER SUBTASK — MMLU has 57 subtasks, so 30 becomes 1710 requests. The number of requests for your LM-Eval picks is shown below the list.'));
        engNote.id = 'bench-acc-engine-hint';
        var totNote = el('p', 'native-stub-note'); totNote.id = 'bench-acc-engine-total';
        f.append(grid, engNote, totNote);
        self.loadHarnessSizes();

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
        if (gdoc) gdoc.querySelectorAll('#bench-acc-tasks .acc-task').forEach(function (card) {
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
            self.renderGrid();
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
                // U69: lm-eval variant appears IN the list beside its
                // built-in twin, not behind a mode switch
                if ((self.state.harnessTasks || []).indexOf(tk.key) >= 0)
                    row.appendChild(self.taskRowEl(tk, true));
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
        Object.keys(body.benchmarks).forEach(function (k) {
            if (k.indexOf('|h') > 0) {
                hBody[k.slice(0, k.indexOf('|h'))] = body.benchmarks[k];
                delete body.benchmarks[k];
            }
        });
        body.engine = 'classic';
        body._harness = Object.keys(hBody).length
            ? JSON.parse(JSON.stringify(Object.assign({}, body,
                  { benchmarks: hBody, engine: 'harness' })))
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
        if (!Object.keys(body.benchmarks).length && !body._harness) {
            d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
            return;
        }
        var rel = busyLabel(gid('bench-acc-add'));
        var harness = body._harness;
        delete body._harness;
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
        } catch (e) { err = String((e && e.message) || e); }
        rel();
        if (posted) d.toast(t('uplift.bench.queued', 'Added to queue'));
        if (err) d.toast(err, 'error');
        if (posted) this.refreshQueue();
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
            this.renderQueue(st);
            if (st.running && !wasRunning && st.current_bench_id) this.startStream(st.current_bench_id);
            if (!st.running && wasRunning) { stopStream(); this.refreshResults(); }
        } catch (e) { /* board offline */ }
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
            Object.keys(q.sizes || {}).forEach(function (k) { meta[k] = boardSuiteMeta(groups, k); });
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
        wrap.replaceChildren();
        if (!st.running && !(st.queue || []).length) { wrap.hidden = true; return; }
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
            // U83: onerror fires when the server dies AND when a proxy
            // half-closes the socket; EventSource then retries silently,
            // so the board froze on the last event with a live queue (the
            // 'stuck' half that was NOT the harness). Interrupt visibly and
            // poll for truth: refreshQueue restarts the stream once the run
            // reappears or marks the board done when it does not.
            _es.onerror = function () {
                streamInterrupted('bench-acc-status');
                if (_poll) clearInterval(_poll);
                _poll = setInterval(function () { self.refreshQueue(); }, 4000);
            };
        } catch (e) {
            if (_poll) clearInterval(_poll);
            _poll = setInterval(function () { self.refreshQueue(); }, 4000);
        }
    },

    onEvent: function (ev) {
        var st = gid('bench-acc-status');
        // U83: every event first mutates the board data, then the widgets
        // paint from it — counters and boxes can never disagree with each
        // other because they read the same source
        this.boardEvent(ev);
        if (ev.type === 'progress') {
            if (st) st.textContent = (ev.message || ev.phase || '') +
                this.statusCounterText(ev);
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
                        var mSel = gid(prefix + '-model');
                        return 'uplift_' + kind + '_'
                            + String((mSel && mSel.value) || 'run');
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

var DEC = {
    state: null,

    render: function (panel) {
        this.state = { running: false, runId: null, packs: {},
                       selected: {}, limit: 0, results: [] };
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
        row.append(labeled(t('bench.config.model', 'Model'), modelSel),
                   labeled(t('uplift.bench.sample_limit', 'Sample limit'), limSel));
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

    loadModels: async function () {
        var d = dom();
        try {
            var data = await d.fetchJson(api() + '/models');
            var sel = gid('bench-dec-model');
            if (!sel) return;
            var usable = ((data && data.models) || []).filter(function (m) {
                return (m.engine_type || m.model_type) === 'decision';
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
            .filter(function (k) { return this.state.selected[k]; }, this);
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
        var rel = busyLabel(gid('bench-dec-run'));
        try {
            var r = await d.postJson(api() + '/bench/decision/start',
                { model_id: model, packs: packs, limit: this.state.limit });
            rel();
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
            // print them twice (caught in the live UI drill)
            this.renderStatus(ev.message || ev.phase || '');
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
        var runBtn = gid('bench-dec-run'), c = gid('bench-dec-cancel');
        if (runBtn) runBtn.disabled = this.state.running;
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
        [t('bench.config.model', 'Model'), t('acc_bench.config.benchmarks', 'Benchmarks'),
         t('uplift.bench.dec_accuracy', 'Accuracy'),
         t('uplift.bench.dec_brier', 'Brier'),
         t('uplift.bench.dec_ece', 'ECE'),
         t('uplift.bench.dec_agreement', 'Agreement'),
         t('uplift.bench.dec_latency', 'ms/question'),
         t('uplift.bench.samples', 'Samples'), ''].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        tbl.appendChild(head);
        var fmt = function (v) { return v == null ? '—' : Number(v).toFixed(4); };
        rows.forEach(function (r) {
            var tr = el('tr');
            var packName = r.pack || '';
            tr.append(
                el('td', null, String(r.model_id || '')),
                el('td', null, t('uplift.bench.pack.' + packName.replace(/-/g, '_'), packName)),
                el('td', null, fmt(r.accuracy)),
                el('td', null, fmt(r.brier)),
                el('td', null, fmt(r.ece)),
                el('td', null, fmt(r.agreement)),
                el('td', null, fmtMs(r.ms_per_question)),
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
                    [{ label: 'Model', get: function (r) { return String(r.model_id || ''); } },
                     { label: 'Benchmark', get: function (r) { return String(r.pack || ''); } },
                     { label: 'Accuracy', numeric: true, get: function (r) { return fmt4(r.accuracy); } },
                     { label: 'Brier', numeric: true, get: function (r) { return fmt4(r.brier); } },
                     { label: 'ECE', numeric: true, get: function (r) { return fmt4(r.ece); } },
                     { label: 'Agreement', numeric: true, get: function (r) { return fmt4(r.agreement); } },
                     { label: 'ms/question', numeric: true, get: function (r) {
                         return fmtMs(r.ms_per_question); } },
                     { label: 'Samples', numeric: true, get: function (r) {
                         return r.items != null
                             ? Number(r.items).toLocaleString() : '—'; } }],
                    selfD.state.results.slice().reverse());
            }, null, null, {
                name: function () {
                    var mSel = gid('bench-dec-model');
                    return 'uplift_decision_'
                        + String((mSel && mSel.value) || 'run');
                },
                rows: function () { return selfD.state.results.slice().reverse(); },
                cols: function () { return [
                    { head: 'Model', get: function (r) { return r.model_id || ''; } },
                    { head: 'Benchmark', get: function (r) { return r.pack || ''; } },
                    { head: 'Accuracy', get: function (r) { return r.accuracy; } },
                    { head: 'Brier', get: function (r) { return r.brier; } },
                    { head: 'ECE', get: function (r) { return r.ece; } },
                    { head: 'Agreement', get: function (r) { return r.agreement; } },
                    { head: 'ms/question', get: function (r) { return r.ms_per_question; } },
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
         // U83 test seams: the queue board model (pure) + ACC methods so
         // a node harness can replay status payloads + event sequences
         _board: { boardSuiteMeta: boardSuiteMeta, boardQuestions: boardQuestions,
                   boardSuiteBoxes: boardSuiteBoxes, boardCounters: boardCounters },
         // U49 structural test seams: panel modules + the shared export
         // builders, so a DOM-free harness can prove every panel wires
         // resultsHead/advancedSection (card's Verify: 'import graph or
         // DOM assertion in the mount-test harness')
         _panels: { ctx: CTX, ane: ANE, acc: ACC, dec: DEC },
         _u49: { resultsHead: resultsHead, buildTableText: buildTableText,
                 buildAccuracyText: buildAccuracyText,
                 ctxResultPairs: ctxResultPairs,
                 advancedSection: advancedSection },
         // U47 test seams (pure text-export plumbing; U49 reuses)
         _benchText: { buildThroughputText: buildThroughputText,
                       fmtNum: fmtNum, fmtMemory: fmtMemory,
                       singleTestLabel: singleTestLabel,
                       batchPromptSummary: batchPromptSummary,
                       ctxTargetOptions: ctxTargetOptions } };
});
