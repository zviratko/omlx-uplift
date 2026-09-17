/* Uplift UI controller. Reads via the mock gateway (default :11437), which
   proxies real oMLX and intercepts writes into a shadow layer. ?api= overrides. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);

/* API base: the gateway is the single source for the UI. It reads real oMLX
   and layers simulated data. Override with ?api= (e.g. =http://127.0.0.1:11435
   to bypass, or empty when served by oMLX itself in future hosting). */
const qp = new URLSearchParams(location.search);
// Served by oMLX itself (/uplift/ or legacy /admin/uplift/) or by the
// standalone `omlx-uplift view` server (/uplift/)? Either way our own
// origin IS the API (the viewer proxies it). Only the old dev mock
// gateway (:11437) default remains, for ?api= harness sessions.
const NATIVE = location.pathname.startsWith('/uplift')
    || location.pathname.startsWith('/admin/uplift');
const API_DEFAULT = NATIVE ? ''
    : location.protocol + '//' + location.hostname + ':11437';
const API = qp.has('api') ? qp.get('api') : API_DEFAULT;

const prefs = C.loadPrefs(localStorage);
const layout = C.loadLayout(localStorage);
const tracker = C.createRequestTracker(2000);

/* ---------------- i18n bootstrap (classic pattern) ---------------------
   GET /uplift/api/locale -> {lang, strings}: classic's catalog merged
   with uplift's overlay (package locales/*.json). Until the fetch lands
   everything renders via key-fallback (English literals stay in place as
   data-en fallbacks, see applyI18n). window.t alias = classic parity for
   anything copied over from dashboard.js. */
window.t = (key, vars) => C.t(key, vars);
function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (el.dataset.en === undefined) el.dataset.en = el.textContent;
        const s = C.t(key);
        el.textContent = s === key ? el.dataset.en : s;
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        if (el.dataset.enTitle === undefined) el.dataset.enTitle = el.getAttribute('title') || '';
        const s = C.t(key);
        el.setAttribute('title', s === key ? el.dataset.enTitle : s);
    });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach(el => {
        const key = el.dataset.i18nPh;
        if (el.dataset.enPh === undefined) el.dataset.enPh = el.getAttribute('placeholder') || '';
        const s = C.t(key);
        el.setAttribute('placeholder', s === key ? el.dataset.enPh : s);
    });
}
async function loadLocale(lang) {
    try {
        const url = API + '/uplift/api/locale' + (lang ? '?lang=' + encodeURIComponent(lang) : '');
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('locale HTTP ' + r.status);
        const j = await r.json();
        C.setLocale(j.lang, j.strings);
        gsLocalize();
        applyI18n(document);
        document.documentElement.lang = j.lang;
    } catch (e) {
        /* key-fallback keeps the UI fully English; not worth a toast */
        console.warn('uplift locale load failed:', e);
    }
}

let stats = null, prevStats = null, failCount = 0, timer = null;
let usageRange = qp.get('range') || 'today';
const PERCENTILES = { p50: 50, p90: 90, p95: 95, p99: 99 };
if (!(layout.percentile in PERCENTILES)) layout.percentile = 'p95';

/* ---------------- tabs (hash routing, like the classic dashboard) --------- */
const TABS = ['status', 'models', 'usage', 'logs', 'settings'];
const SUBS = {
    models: ['manager', 'helper', 'downloader', 'uploader', 'quantizer'],
    settings: ['global'],
};
const SUB_LABELS = {
    manager: 'Models', downloader: 'Downloader', quantizer: 'oQ(e) Quantization',
    uploader: 'Uploader', helper: 'Helper Models',
    global: 'Server Settings',
};
function currentTab() {
    const t = (location.hash || '').replace('#', '').split('/')[0];
    return TABS.includes(t) ? t : 'status';
}
function currentSub(tab) {
    const parts = (location.hash || '').replace('#', '').split('/');
    const list = SUBS[tab] || [];
    return list.includes(parts[1]) ? parts[1] : list[0];
}
function applyTab() {
    const tab = currentTab();
    const sub = currentSub(tab);
    document.documentElement.dataset.tab = tab;
    document.documentElement.dataset.sub = sub;
    for (const a of $('tabs').querySelectorAll('[data-tab]')) {
        const hit = a.dataset.tab === tab;
        a.classList.toggle('active', hit);
        if (a.classList.contains('dd-btn')) a.textContent = '';
    }
    // dropdown button label gets rebuilt (textContent above wiped it)
    {
        const dd = 'dd-models-btn';
        let lbl = t('uplift.tab.models');
        if (lbl === 'uplift.tab.models') lbl = 'Models';   // pre-catalog fallback
        $(dd).replaceChildren();   // clear (no innerHTML; labels are textContent-only)
        const span = document.createElement('span');
        span.dataset.i18n = 'uplift.tab.models'; span.textContent = lbl;
        const caret = document.createElement('span');
        caret.className = 'dd-caret'; caret.textContent = '▾';
        $(dd).append(span, ' ', caret);
    }
    for (const card of cards) {
        const show = (card.dataset.tab || 'status') === tab &&
            (!card.dataset.sub || card.dataset.sub === sub);
        card.style.display = show ? '' : 'none';
    }
    // dropdown open state reset on navigation (dropdown click keeps its menu open)
    if (ddForceOpen !== 'dd-models-menu') $('dd-models-menu').hidden = true;
    ddForceOpen = null;
    requestAnimationFrame(resizeCharts);   // charts may have become visible
    if (tab === 'usage') pollUsage();
    if (tab === 'logs') pollLogs();
    if (tab === 'models') {
        renderModelAdmin();
        if (sub === 'downloader') initDownloader();
        if (sub === 'quantizer') renderQuantizer();
        if (sub === 'uploader') renderUploader();
        if (sub === 'helper') renderHelperModels();
        if (sub === 'manager') renderTemplatesBox();
    }
    if (tab === 'settings') pollGlobalSettings();
}
addEventListener('hashchange', applyTab);

/* dropdown menus: hover opens, click toggles, outside click / Escape closes */
let ddForceOpen = null;
const ddTimers = {};
function ddOpen(menuId, open) { $(menuId).hidden = !open; }
function bindDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    const wrap = btn.closest('.dd');
    btn.onclick = e => {
        e.preventDefault();
        clearTimeout(ddTimers[menuId]);
        const open = menu.hidden;
        if (currentTab() !== btn.dataset.tab) {
            ddForceOpen = menuId;              // re-open after the tab switch
            location.hash = '#' + btn.dataset.tab;
        }
        ddOpen(menuId, open);
    };
    // hover behaviour (like the classic navbar)
    wrap.addEventListener('mouseenter', () => {
        clearTimeout(ddTimers[menuId]);
        ddOpen(menuId, true);
    });
    wrap.addEventListener('mouseleave', () => {
        clearTimeout(ddTimers[menuId]);
        ddTimers[menuId] = setTimeout(() => { menu.hidden = true; }, 250);
    });
    for (const a of menu.querySelectorAll('a'))
        a.addEventListener('click', e => {
            e.preventDefault();
            menu.hidden = true;
            location.hash = '#' + btn.dataset.tab + '/' + a.dataset.sub;
        });
}
bindDropdown('dd-models-btn', 'dd-models-menu');
document.addEventListener('click', e => {
    const menu = $('dd-models-menu');
    if (!menu.hidden && !menu.contains(e.target) && !$('dd-models-btn').contains(e.target))
        menu.hidden = true;
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('dd-models-menu').hidden = true;
});

// Keyboard: 1–5 jump to tabs (ignored while typing in inputs).
document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const i = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (i >= 0) location.hash = '#' + TABS[i];
});

/* ---------------- theme & motion ---------------- */
const THEME_CYCLE = ['auto', 'light', 'dark', 'enhanced', 'cockpit'];
function applyPrefs() {
    const t = prefs.theme;
    let eff = t;
    if (t === 'auto') eff = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = eff;
    const motionOff = prefs.motion === 'off' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.motion = motionOff ? 'off' : 'auto';
    $('btn-motion').style.opacity = motionOff ? 0.4 : 1;
    if (typeof syncThemeMenu === 'function') syncThemeMenu();
    rerenderChartsTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

const motionOff = () => document.documentElement.dataset.motion === 'off';
/* Theme picker: dropdown menu (hover opens like the navbar dropdowns);
   the current selection is marked. The old click-to-cycle is gone. */
function syncThemeMenu() {
    // NB data-pick, NOT data-theme: [data-theme="light"] token blocks would
    // match the anchor itself and poison its own --ink (invisible Day text)
    const want = prefs.theme || 'auto';
    for (const a of $('dd-theme-menu').querySelectorAll('a'))
        a.classList.toggle('active', a.dataset.pick === want);
}
for (const a of $('dd-theme-menu').querySelectorAll('a'))
    a.addEventListener('click', e => {
        e.preventDefault();
        prefs.theme = a.dataset.pick;
        C.savePrefs(localStorage, prefs); applyPrefs();
        $('dd-theme-menu').hidden = true;
        toast(C.t('uplift.toast.theme_set', {theme: prefs.theme}));
    });
{
    const wrap = $('dd-theme'), menu = $('dd-theme-menu');
    let t = null;
    $('btn-theme').onclick = e => { e.preventDefault(); clearTimeout(t); menu.hidden = !menu.hidden; };
    wrap.addEventListener('mouseenter', () => { clearTimeout(t); menu.hidden = false; });
    wrap.addEventListener('mouseleave', () => { clearTimeout(t); t = setTimeout(() => { menu.hidden = true; }, 250); });
}
document.addEventListener('click', e => {
    const menu = $('dd-theme-menu');
    if (!menu.hidden && !menu.contains(e.target) && !$('btn-theme').contains(e.target))
        menu.hidden = true;
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('dd-theme-menu').hidden = true;
});
$('btn-motion').onclick = () => {
    prefs.motion = document.documentElement.dataset.motion === 'off' ? 'auto' : 'off';
    C.savePrefs(localStorage, prefs); applyPrefs();
};

/* ---------------- layout engine (popover + collapse + columns + DnD) ------ */
const cards = [...document.querySelectorAll('.card')];
const DEFAULT_ORDER = cards.map(c => c.dataset.id);   // markup document order = truth

function applyOrder() {
    const grid = $('grid');
    const known = new Set(DEFAULT_ORDER);
    const ordered = layout.order.filter(id => known.has(id));
    const rest = DEFAULT_ORDER.filter(id => !ordered.includes(id));
    // Sort within tab groups so cross-tab drags cannot interleave tabs.
    for (const id of [...ordered, ...rest]) {
        const card = grid.querySelector(`.card[data-id="${id}"]`);
        if (card) grid.append(card);
    }
}
function readOrder() {
    layout.order = [...$('grid').querySelectorAll('.card')].map(c => c.dataset.id);
}
for (const card of cards) {
    const grip = document.createElement('button');
    grip.className = 'grip'; grip.title = 'Drag to move'; grip.textContent = '⠿';
    card.querySelector('h2').prepend(grip);
    card.querySelector('.collapse').after(grip);   // order: collapse, grip, title
}

/* Pointer-Events drag (NOT HTML5 DnD: unreliable in Safari/WebKit). */
(function enableDrag() {
    const DRAG_THRESHOLD = 4;
    let drag = null;
    const cleanup = () => {
        if (!drag) return;
        drag.card.classList.remove('dragging');
        drag.card.style.cssText = '';
        drag.card.style.display = '';           // reflow safety after move
        drag.marker?.remove();
        document.body.classList.remove('dragging-in-progress');
        drag = null;
    };
    document.addEventListener('pointerdown', e => {
        const grip = e.target.closest('.grip');
        if (!grip || e.button !== 0) return;
        const card = grip.closest('.card');
        const rect = card.getBoundingClientRect();
        drag = { card, marker: null, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
                 startX: e.clientX, startY: e.clientY, width: rect.width, height: rect.height,
                 tab: card.dataset.tab || 'status', active: false };
        e.preventDefault();
    });
    window.addEventListener('pointermove', e => {
        if (!drag) return;
        if (!drag.active) {
            const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
            if (moved < DRAG_THRESHOLD) return;
            drag.active = true;
            document.body.classList.add('dragging-in-progress');
            drag.marker = document.createElement('div');
            drag.marker.className = 'drop-marker';
            drag.card.after(drag.marker);
            drag.card.classList.add('dragging');
            drag.card.style.position = 'fixed';
            drag.card.style.width = drag.width + 'px';
            drag.card.style.height = drag.height + 'px';
            drag.card.style.zIndex = 50;
        }
        drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
        drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
        const grid = $('grid');
        let target = null;
        for (const other of grid.querySelectorAll('.card:not(.dragging)')) {
            if ((other.dataset.tab || 'status') !== drag.tab) continue;  // same tab only
            if (other.style.display === 'none') continue;
            const r = other.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2 ||
                (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)) {
                target = other; break;
            }
        }
        grid.insertBefore(drag.marker, target);
        const edge = 60;
        if (e.clientY < edge) window.scrollBy(0, -12);
        else if (e.clientY > innerHeight - edge) window.scrollBy(0, 12);
    }, true);
    const finish = () => {
        if (!drag) return;
        if (drag.active && drag.marker) {
            drag.card.classList.remove('dragging');
            drag.card.style.cssText = '';
            drag.marker.replaceWith(drag.card);
            readOrder();
            C.saveLayout(localStorage, layout);
        }
        cleanup();
    };
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', () => cleanup(), true);
    window.addEventListener('blur', () => cleanup(), true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cleanup(); });
    addEventListener('resize', () => { if (drag?.active) cleanup(); }, true);
})();

function fillSelect(sel, options, value) {
    sel.innerHTML = '';
    for (const [v, label] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (String(v) === String(value)) o.selected = true;
        sel.append(o);
    }
}
function applyLayout() {
    document.documentElement.style.setProperty('--cols', layout.cols);
    for (const card of cards) {
        const id = card.dataset.id;
        const want = Number(card.dataset.cols) || 1;
        card.style.setProperty('--span', card.dataset.full ? layout.cols : C.clampSpan(want, layout.cols));
        const collapsed = layout.collapsed[id] === true;
        card.classList.toggle('is-collapsed', collapsed);
        card.querySelector('.collapse').textContent = collapsed ? '+' : '–';
    }
    requestAnimationFrame(resizeCharts);
    C.saveLayout(localStorage, layout);
}
for (const card of cards) {
    card.querySelector('.collapse').onclick = () => {
        const id = card.dataset.id;
        layout.collapsed[id] = !(layout.collapsed[id] === true);
        applyLayout();
    };
}
fillSelect($('opt-cols'), [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], layout.cols);
$('opt-cols').onchange = e => { layout.cols = Number(e.target.value); applyLayout(); resizeCharts(); };
fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, s >= 3600 ? `${s / 3600} hour` : `${s / 60} min`]), layout.chartWindowSec);
$('opt-window').onchange = e => { layout.chartWindowSec = Number(e.target.value); historyDirty = true; loadChartHistory(); C.saveLayout(localStorage, layout); };
fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
$('opt-interval').onchange = e => { layout.intervalMs = Number(e.target.value); C.saveLayout(localStorage, layout); restartPolling(); };
$('opt-hide-debug').checked = layout.logsHideDebug;
$('opt-hide-debug').onchange = e => { layout.logsHideDebug = e.target.checked; C.saveLayout(localStorage, layout); };
$('btn-layout-reset').onclick = () => {
    Object.assign(layout, C.LAYOUT_DEFAULTS, { collapsed: {} });
    applyLayout();
    applyOrder();   // F-017: defaults mean markup order; without this the
                    // dragged order stays on screen until a manual reload
    fillSelect($('opt-cols'), [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], layout.cols);
    fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, s >= 3600 ? `${s / 3600} hour` : `${s / 60} min`]), layout.chartWindowSec);
    historyDirty = true; loadChartHistory();
    fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
    $('opt-hide-debug').checked = layout.logsHideDebug;
    restartPolling();
    resizeCharts();
};
$('btn-expand-all').onclick = () => { layout.collapsed = {}; applyLayout(); };
$('btn-layout').onclick = e => {
    e.stopPropagation();
    $('layout-pop').hidden = !$('layout-pop').hidden;
};
document.addEventListener('click', e => {
    if (!$('layout-pop').hidden && !$('layout-pop').contains(e.target) && e.target !== $('btn-layout'))
        $('layout-pop').hidden = true;
});

/* ---------------- animated counters (lightweight rAF tween) --------------- */
const counters = {};
function counter(elId, format) {
    counters[elId] = { el: $(elId), format, value: null, raf: 0 };
}
function setCounter(elId, target) {
    const c = counters[elId];
    if (!c) return;
    if (target === null) { c.el.textContent = '—'; c.value = null; return; }
    if (c.value === null || motionOff() || c.value === target) { c.value = target; c.el.textContent = c.format(target); return; }
    cancelAnimationFrame(c.raf);
    const from = c.value, start = performance.now(), dur = 600;
    const step = now => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) ** 3;               // easeOutCubic
        c.el.textContent = c.format(from + (target - from) * eased);
        if (t < 1) c.raf = requestAnimationFrame(step);
        else c.el.textContent = c.format(target);
    };
    c.value = target;
    c.raf = requestAnimationFrame(step);
}
counter('v-gentps',     v => v.toFixed(1));
counter('v-prefilltps', v => v.toFixed(0));
counter('v-requests',   v => C.fmtNumber(v));
counter('v-tokens',     v => C.fmtCompact(v));
counter('v-cacheeff',   v => v.toFixed(1) + '%');
counter('v-prompt-avg', v => C.fmtCompact(v));
counter('v-prompt-pct', v => C.fmtCompact(v));
counter('v-compl-avg',  v => C.fmtCompact(v));
counter('v-compl-pct',  v => C.fmtCompact(v));
counter('v-ttft',       v => C.fmtNumber(v));
counter('v-errrate',    v => v.toFixed(2) + '%');
counter('v-u-req',      v => C.fmtNumber(v));
counter('v-u-tok',      v => C.fmtCompact(v));
counter('v-u-prompt',   v => C.fmtCompact(v));
counter('v-u-compl',    v => C.fmtCompact(v));

/* ---------------- charts ---------------- */
const axisFont = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
/* Remember where the mouse is hovering, by TIMESTAMP not index: setData on a
   sliding window shifts indices, which made hovered values snap to the latest
   sample after the next poll (looked like hover only worked on data points). */
const hoverTs = new WeakMap();       // chart -> hovered timestamp (ms) | null
function rememberHover(c) {
    if (c.cursor.idx === null || c.cursor.idx === undefined) { hoverTs.set(c, null); return; }
    const ts = c.data[0][c.cursor.idx];
    if (typeof ts === 'number') hoverTs.set(c, ts);
}
function restoreCursor(c) {
    const t = hoverTs.get(c);
    if (t === null || t === undefined) return;
    const xs = c.data[0];
    if (!xs.length) return;
    let i = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) {
        const d = Math.abs(xs[k] - t);
        if (d < best) { best = d; i = k; }
    }
    c.setCursor({ idx: i }, false);  // fires hooks + moves the focus point
}
const tpsData = [[], [], []];        // time, generation tok/s, prefill tok/s
const memData = [[], [], [], [], [], []];  // time, memory %, cache GB, hot1, hot2, hot3
const MAX_POINTS = 4000;

/* Server-side chart history (uplift fine samples merged with vanilla's
   hourly rollups): backfills the live tick buffers so windows longer than
   this session — and gaps across server restarts — actually draw. Live
   ticks always win when newer than the newest history point; the coarse
   boundary gets labeled honestly in the window readout. */
let chartHist = { gen: [], prefill: [] };   // arrays of {ts, v, res}
let historyDirty = true, historyLoading = false;
function windowToParam() {
    const w = layout.chartWindowSec;
    return w >= 86400 ? '24h' : w >= 21600 ? '6h' : w >= 3600 ? '1h'
         : w >= 900 ? '15m' : '5m';
}
async function loadChartHistory() {
    if (historyLoading) return;
    historyLoading = true;
    try {
        const w = windowToParam();
        const [g, p] = await Promise.all([
            fetchJson(`${API}/uplift/api/metrics/series?key=avg_generation_tps&window=${w}`).catch(() => null),
            fetchJson(`${API}/uplift/api/metrics/series?key=avg_prefill_tps&window=${w}`).catch(() => null),
        ]);
        const conv = a => (a && a.series ? a.series.map(x => ({ ts: x.ts * 1000, v: x.v, res: x.res })) : []);
        // Only adopt if the window did not change mid-flight (stale-window
        // race: a slow 24h response landing over a fresh 5m selection).
        if (w === windowToParam()) {
            chartHist = { gen: conv(g), prefill: conv(p) };   // server ts is epoch SECONDS -> ms
            historyDirty = false;
            if (tpsChart) redrawCharts();
        } else {
            historyDirty = true;
        }
    } finally {
        historyLoading = false;
        if (historyDirty) loadChartHistory();   // a newer window was requested mid-flight
    }
}
/* Columns for the throughput chart: windowed history+live, value-aligned
   on the union of timestamps (uPlot requires one shared x column). */
function tpsWindowed() {
    const now = Date.now();
    const g = C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], layout.chartWindowSec, now);
    const p = C.mergeHistory(chartHist.prefill, tpsData[0], tpsData[2], layout.chartWindowSec, now);
    const ts = [...new Set(g.ts.concat(p.ts))].sort((a, b) => a - b);
    const gi = new Map(g.ts.map((t, i) => [t, g.v[i]]));
    const pi = new Map(p.ts.map((t, i) => [t, p.v[i]]));
    return [ts, ts.map(t => (gi.has(t) ? gi.get(t) : null)),
                ts.map(t => (pi.has(t) ? pi.get(t) : null))];
}
let cacheSeriesIds = [];             // top-3 models currently drawn on mem chart

function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return { dim: cs.getPropertyValue('--dim').trim() || '#a5a096',
             grid: cs.getPropertyValue('--grid').trim() || '#3a3b40',
             blue: cs.getPropertyValue('--chart-1').trim() || '#f2f0ea',
             gold: cs.getPropertyValue('--chart-2').trim() || '#e8a020' };
}
function windowedData(data) {
    const cutoff = Date.now() - layout.chartWindowSec * 1000;
    let i = 0;
    while (i < data[0].length && data[0][i] < cutoff) i++;
    return data.map(col => col.slice(i));
}
function seriesValue(v) {
    return v === null || v === undefined ? '—' : C.fmtCompact(v);
}
function line(label, colorVar, fill, scale) {
    const col = chartColors()[colorVar];
    return { label, scale: scale || 'y', stroke: col, width: 2,
             fill: fill ? col + '22' : undefined,
             points: { show: false }, value: seriesValue };
}
function xAxis(col) {
    return { stroke: col.dim, width: 1, size: 42, font: axisFont,
             values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB',
                 { hour: '2-digit', minute: '2-digit', ...(layout.chartWindowSec < 900 ? { second: '2-digit' } : {}) })) };
}
function yAxis(col, opts) {
    // size includes tick labels AND the rotated axis label; 40 was too tight
    // for the right axes and the label overlapped the ticks.
    return Object.assign({ stroke: col.dim, size: 40, font: axisFont, grid: true, gap: 6 }, opts || {});
}
function baseOpts(specs, axes, legendHook) {
    const col = chartColors();
    return {
        width: 0, height: 240, padding: [6, 8, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: true, top: true, live: false, labels: { fontSize: '10px' } },
        scales: Object.assign({ x: { time: true }, y: { auto: true } }, axes.scales || {}),
        axes: [xAxis(col), ...axes.yAxes],
        hooks: legendHook ? { cursor: { subscribe: [legendHook] } } : undefined,
        series: [{}, ...specs],
    };
}
/* Legend value updater: latest sample when idle, hovered sample on mouse-over.
   With live:false uPlot renders no value cells (vendor CSS hides them), so we
   append our own to each series row and fill them. Reads c.data — the windowed
   slice currently displayed — so indices always match c.cursor.idx. */
function legendUpdater() {
    return c => {
        rememberHover(c);
        const rows = [...c.root.querySelectorAll('.u-legend .u-series')];
        if (!rows.length) return;
        const hasTimeRow = rows[0] && rows[0].querySelector('.u-label')?.textContent === 'Time';
        const seriesRows = hasTimeRow ? rows.slice(1) : rows;
        const idx = c.cursor.idx;
        const src = c.data[0];
        const i = (idx === null || idx === undefined) ? src.length - 1 : Math.min(idx, src.length - 1);
        seriesRows.forEach((row, sIdx) => {
            let cell = row.querySelector('.u-value');
            if (!cell) {
                cell = document.createElement('td');
                cell.className = 'u-value';
                row.append(cell);
            }
            const colData = c.data[sIdx + 1];
            const v = colData && colData.length ? colData[i] : null;
            cell.textContent = (v === null || v === undefined) ? '—' : seriesValue(v);
        });
    };
}
/* Nearest-sample lookup for the tooltip: computes the index from the mouse X
   via posToVal (fallback: pixel->timestamp scan of data[0]), so it works even
   if uPlot's own cursor bookkeeping is off. Values snap to the nearest
   collected sample, never interpolated. */
function nearestIndexByX(c, clientX) {
    const xs = c.data[0];
    if (!xs || !xs.length) return null;
    let t = null;
    try {
        // .u-over canvas spans the plot area exactly: its left edge is x-min.
        const r = c.over.getBoundingClientRect();
        t = c.posToVal(clientX - r.left, 'x');
    } catch (_) { /* fallback below */ }
    if (typeof t !== 'number' || !isFinite(t)) {
        const r = c.over.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
        t = xs[0] + frac * (xs[xs.length - 1] - xs[0]);
    }
    let i = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) {
        const d = Math.abs(xs[k] - t);
        if (d < best) { best = d; i = k; }
    }
    return i;
}
function chartStroke(c, s) {
    try { return typeof c.series[s].stroke === 'string' ? c.series[s].stroke : 'inherit'; }
    catch (_) { return 'inherit'; }
}
/* Floating value bubble at the cursor. The crosshair is already painted;
   the bubble rides beside it and shows the value(s) aligned with it: time
   plus every series at the nearest collected sample. HTML built with DOM
   nodes only (no innerHTML) so labels/values from data cannot inject. */
function tipEl(c) {
    if (!c._tip) {
        const d = document.createElement('div');
        d.className = 'u-tip';
        d.hidden = true;
        c.over.append(d);           // .u-over spans the plot area and is positioned
        c._tip = d;
    }
    return c._tip;
}
function showTip(c, ev, i) {
    const tip = tipEl(c);
    tip.textContent = '';
    const t = document.createElement('div');
    t.className = 'ut-time';
    t.textContent = new Date(c.data[0][i]).toLocaleTimeString('en-GB');
    tip.append(t);
    for (let s = 1; s < c.series.length; s++) {
        const v = c.data[s] ? c.data[s][i] : null;
        if (v === undefined) continue;
        const row = document.createElement('div');
        row.className = 'ut-row';
        const lab = document.createElement('b');
        lab.textContent = (c.series[s] && c.series[s].label) || ('s' + s);
        lab.style.color = chartStroke(c, s);
        const val = document.createElement('span');
        val.textContent = (v === null) ? '—' : seriesValue(v);
        row.append(lab, document.createTextNode(' '), val);
        tip.append(row);
    }
    tip.hidden = false;
    // Position beside the pointer; flip near plot edges so it stays visible.
    const r = c.over.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx = ev.clientX - r.left + 14;
    let ly = ev.clientY - r.top + 12;
    if (lx + tw > r.width - 4) lx = ev.clientX - r.left - tw - 14;
    if (ly + th > r.height - 4) ly = Math.max(2, ev.clientY - r.top - th - 12);
    tip.style.left = lx + 'px';
    tip.style.top = ly + 'px';
}
function bindCursorTip(c) {
    if (!c || !c.over) return;
    c.over.addEventListener('mousemove', ev => {
        const i = (c.cursor.idx != null) ? c.cursor.idx : nearestIndexByX(c, ev.clientX);
        hoverTs.set(c, c.data[0][i]);              // pin across poll re-windowing
        showTip(c, ev, i);
    });
    c.over.addEventListener('mouseleave', () => {
        hoverTs.set(c, null);
        if (c._tip) c._tip.hidden = true;
    });
}
/* The vendored uPlot build does not dispatch hooks.cursor.subscribe (no
   'subscribe' in the bundle) — a legend updater wired via hooks only ran on
   redraw, so hover never updated it. Bind the updater directly to the
   cursor overlay instead; uPlot's own mousemove handler is registered first
   (during init), so cursor.idx is already fresh when our listener runs. */
function bindCursorUpdater(c) {
    if (!c || !c.over) return;
    c.over.addEventListener('mousemove', () => legendUpdater()(c));
    c.over.addEventListener('mouseleave', () => {
        hoverTs.set(c, null);
        if (c.data[0].length) c.setCursor({ idx: c.data[0].length - 1 }, false);
        legendUpdater()(c);
    });
}
let tpsChart = null, memChart = null, usageChart = null;
function createCharts() {
    if (tpsChart) { tpsChart.destroy(); memChart.destroy(); tpsChart = memChart = null; }
    const col = chartColors();
    // Dual Y: left = generation tok/s, right = prefill tok/s (prefill >> gen).
    const tpsOpts = baseOpts(
        [line('generation', 'blue', true, 'y'), line('prefill', 'gold', false, 'y2')],
        { scales: { y2: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { grid: false, label: 'gen tok/s', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'prefill tok/s', stroke: col.gold, size: 58 }), { scale: 'y2' })] },
        legendUpdater());
    // y2 axis sits on the right; uPlot axis 'side': 1=right of grid, 3=left.
    tpsChart = new uPlot(tpsOpts, tpsWindowed(), $('chart-tps'));
    window.__uplotTps = tpsChart;   // debug handle
    // Memory % left; runtime cache GB (total + top-3 models' hot cache) right.
    const memSpecs = [line('model memory', 'blue', true, 'y'),
                      line('cache total', 'gold', false, 'y2')];
    for (let i = 0; i < cacheSeriesIds.length; i++) {
        const shortId = cacheSeriesIds[i].length > 14
            ? cacheSeriesIds[i].slice(0, 13) + '…' : cacheSeriesIds[i];
        const s = line('hot:' + shortId, ['gold', 'blue', 'dim'][i], false, 'y2');
        s.dash = [4, 4];
        memSpecs.push(s);
    }
    const memOpts = baseOpts(memSpecs,
        { scales: { y2: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { label: 'memory %', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'cache GB', stroke: col.gold, size: 58 }), { scale: 'y2' })] },
        legendUpdater());
    memOpts.scales.y = { range: [0, 100] };
    memChart = new uPlot(memOpts, windowedData(memData), $('chart-mem'));
    bindCursorUpdater(tpsChart); bindCursorUpdater(memChart);
    bindCursorTip(tpsChart); bindCursorTip(memChart);
    resizeCharts();
    redrawCharts();
}
function redrawCharts() {
    if (!tpsChart) return;
    tpsChart.setData(tpsWindowed());
    memChart.setData(windowedData(memData));
    // Keep the hovered position pinned across polls (index shifts otherwise);
    // when not hovering, show the latest samples.
    restoreCursor(tpsChart) || legendUpdater()(tpsChart);
    restoreCursor(memChart) || legendUpdater()(memChart);
    const shown = tpsChart.data[0].length;
    let label = shown > 1
        ? `${layout.chartWindowSec >= 3600 ? layout.chartWindowSec / 3600 + 'h' : layout.chartWindowSec / 60 + 'm'} window` : '';
    // Honest resolution badge: hourly rollups backfill older stretches.
    const now = Date.now();
    const g = C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], layout.chartWindowSec, now);
    if (shown > 1 && g.boundary && g.boundary < now - 120000) {
        label += ` · hourly ≤ ${new Date(g.boundary).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    }
    $('chart-tps-window').textContent = label;
}
function rerenderChartsTheme() { createCharts(); if (usageChart) createUsageChart(); }
function resizeCharts() {
    if (!tpsChart) return;
    const w1 = $('chart-tps').clientWidth, w2 = $('chart-mem').clientWidth;
    if (w1 > 0) tpsChart.setSize({ width: w1, height: 240 });
    if (w2 > 0) memChart.setSize({ width: w2, height: 240 });
    const w3 = $('chart-usage')?.clientWidth;
    if (usageChart && w3 > 0) usageChart.setSize({ width: w3, height: 200 });
}
new ResizeObserver(resizeCharts).observe($('grid'));
// The grid box itself does not change size when only the column count changes
// (columns shrink inside it), so observe the chart hosts directly as well —
// otherwise canvases keep the old, wider size and overflow narrow columns.
for (const id of ['chart-tps', 'chart-mem', 'chart-usage'])
    if ($(id)) new ResizeObserver(resizeCharts).observe($(id));
/* Pointer left the plot: drop the pinned hover so legends show latest again. */
for (const sel of ['#chart-tps', '#chart-mem']) {
    const el = $(sel.slice(1));
    if (el) el.addEventListener('mouseleave', () => {
        hoverTs.set(sel === '#chart-tps' ? tpsChart : memChart, null);
        const c = sel === '#chart-tps' ? tpsChart : memChart;
        if (c) { c.setCursor({ idx: c.data[0].length - 1 }, false); }
    });
}

/* ---------------- event feed / reactions ---------------- */
const MAX_FEED = 40;
function pushFeed(events) {
    const feed = $('feed');
    const empty = feed.querySelector('.empty'); if (empty) empty.remove();
    for (const ev of events.slice().reverse()) {
        const row = document.createElement('div');
        row.className = `feed-item k-${ev.kind}`;
        const time = document.createElement('time');
        time.textContent = new Date().toLocaleTimeString('en-GB');
        const span = document.createElement('span');
        span.className = 'ev'; span.textContent = ev.text;
        row.append(time, span);
        feed.prepend(row);
    }
    while (feed.children.length > MAX_FEED) feed.lastChild.remove();
}
function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
}
function flashCard(id, tone) {
    const el = $(id); if (!el) return;
    const card = el.closest('.card'); if (!card || motionOff()) return;
    card.classList.add(`flash-${tone}`);
    setTimeout(() => card.classList.remove(`flash-${tone}`), 1200);
}
function celebrate(text) {
    toast(`🎉 ${text}`);
    if (motionOff() || typeof confetti !== 'function') return;
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 },
               colors: ['#c9243b', '#e8a020', '#f2f0ea', '#767268'] });
}
function reactTo(events) {
    for (const ev of events) {
        pushFeed([ev]);
        if (ev.kind === 'model-add')   { toast(C.t('uplift.toast.model_loaded', {model: ev.model})); flashCard('v-requests', 'ok'); }
        if (ev.kind === 'model-remove') flashCard('v-requests', 'warn');
        if (ev.kind === 'restart')      flashCard('v-gentps', 'bad');
        if (ev.kind === 'pressure' && ev.text.includes('hard')) flashCard('mem-label', 'bad');
    }
}
/* Milestone gate: fire each round crossing at most once per page session,
   immune to overlapping polls comparing against a stale snapshot (that
   re-reported the same crossing and made toasts/confetti fire twice). */
const milestoneFloor = {};   // key -> highest multiple already celebrated
function milestoneStep(key) { return key === 'requests' ? 1000 : 1e6; }
function gateMilestones(hits) {
    const fresh = [];
    for (const h of hits) {
        const step = milestoneStep(h.key);
        const crossed = Math.floor(h.value / step);
        if (milestoneFloor[h.key] === undefined) {
            milestoneFloor[h.key] = crossed;   // baseline at page load; later crossings fire
            continue;
        }
        if (crossed > milestoneFloor[h.key]) {
            milestoneFloor[h.key] = crossed;
            fresh.push(h);
        } else if (crossed < milestoneFloor[h.key]) {
            milestoneFloor[h.key] = crossed;   // server restart: re-baseline silently
        }
    }
    return fresh;
}

/* ---------------- rendering ---------------- */
function render(s) {
    setCounter('v-gentps', s.genTps);
    setCounter('v-prefilltps', s.prefillTps);
    setCounter('v-requests', s.requests);
    setCounter('v-tokens', s.totalTokens);
    setCounter('v-cacheeff', s.cacheEfficiency);
    $('v-tokens-sub').textContent = s.completionTokens !== null
        ? `${C.fmtCompact(s.completionTokens)} generated · ${C.fmtCompact(s.cachedTokens)} cached` : '';
    $('chip-uptime').textContent = `up ${C.fmtDuration(s.uptime)}`;
    $('v-active2').textContent = s.active === null ? '—' : s.active;
    $('v-waiting2').textContent = s.waiting === null ? '—' : s.waiting;

    const dot = $('status-dot');
    dot.classList.toggle('bad', s.pressure === 'hard');

    const mem = $('meter-cache');
    mem.classList.toggle('warn', s.memPercent !== null && s.memPercent >= 70);
    mem.classList.toggle('bad', s.memPercent !== null && s.memPercent >= 90);
    $('cache-sub').textContent = s.memUsed !== null
        ? `models ${C.fmtBytes(s.memUsed)} / ${C.fmtBytes(s.memMax)} · disk cache ${C.fmtBytes(s.cacheBytes)}${s.cachePercent !== null ? ' (' + s.cachePercent.toFixed(0) + '%)' : ''}`
        : '';
    $('mem-label').textContent = s.memPercent !== null ? `${s.memPercent.toFixed(1)}% ${s.pressure || ''}` : '';

    renderLive(s);
    renderRequestStats(s);

    // Chart buffers (window pruning happens at draw time).
    tpsData[0].push(s.time); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    while (tpsData[0].length > MAX_POINTS) { tpsData[0].shift(); tpsData[1].shift(); tpsData[2].shift(); }
    const cacheGB = s.cacheBytes === null ? null : +(s.cacheBytes / 1e9).toFixed(3);
    // Per-model hot cache (GB): keep a stable top-3 set; rebuild chart on change.
    const hotSorted = (s.cacheModels || []).slice()
        .sort((a, b) => (b.hotBytes || 0) - (a.hotBytes || 0)).slice(0, 3);
    const hotIds = hotSorted.map(m => m.id);
    if (hotIds.join('|') !== cacheSeriesIds.join('|')) {
        cacheSeriesIds = hotIds;
        // Reset per-model columns so old series values do not mislabel.
        for (let ci = 3; ci < memData.length; ci++) memData[ci] = memData[0].map(() => null);
        createCharts();
    }
    memData[0].push(s.time); memData[1].push(s.memPercent === null ? null : +s.memPercent.toFixed(2));
    memData[2].push(cacheGB);
    for (let i = 0; i < 3; i++) {
        const m = hotSorted[i];
        memData[3 + i].push(m && m.hotBytes !== null ? +(m.hotBytes / 1e9).toFixed(3) : null);
    }
    while (memData[0].length > MAX_POINTS) for (const col of memData) col.shift();
    redrawCharts();
}

function renderLive(s) {
    const list = $('live-list');
    const rows = [];
    for (const m of s.models) {
        for (const p of m.prefilling) rows.push({ model: m.id, kind: C.t('uplift.inflight.prefilling'), prompt: p.prompt, progress: p.progress });
        for (const g of m.generating) rows.push({ model: m.id, kind: C.t('uplift.inflight.generating'), prompt: g.prompt, generated: g.generated, tps: g.tps });
    }
    $('live-count').textContent = rows.length ? `${rows.length}` : '';
    if (!rows.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">Idle</div>';
        return;
    }
    list.innerHTML = '';
    for (const r of rows) {
        const row = document.createElement('div'); row.className = 'model-row';
        row.style.flexWrap = 'wrap';
        const badge = document.createElement('span');
        badge.className = `badge ${r.kind}`; badge.textContent = r.kind;
        const name = document.createElement('span');
        name.className = 'model-name'; name.textContent = r.model; name.title = r.model;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.generated !== undefined) bits.push(`out ${C.fmtCompact(r.generated)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        if (r.progress !== undefined && r.progress !== null) bits.push(`${Math.round(r.progress * 100)}%`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (r.progress !== undefined && r.progress !== null) {
            const bar = document.createElement('div');
            bar.className = 'meter'; bar.style.flex = '1 0 100%'; bar.style.marginTop = '4px';
            const fill = document.createElement('div');
            fill.style.width = Math.round(r.progress * 100) + '%';
            bar.append(fill);
            row.append(bar);
        }
        list.append(row);
    }
}

/* Request sizes: prefer server-side full-population stats (gateway overlay);
   fall back to client-side session tracker when absent. */
let usageAvg = null;
function renderRequestStats(s) {
    fillSelectOnce();
    const p = PERCENTILES[layout.percentile];
    const server = s && s.requestStats ? s.requestStats : null;
    const pick = (blk, key) => blk && blk[key] !== undefined && blk[key] !== null ? blk[key] : null;
    const pKey = layout.percentile;
    // Labels must follow the selector in BOTH paths (F-021: server-stats path
    // updated the values but left "p95 …" text under a p99 number).
    $('lbl-prompt-pct').textContent = `${layout.percentile} prompt tok`;
    $('lbl-compl-pct').textContent = `${layout.percentile} completion tok`;

    if (server) {
        const pt = server.prompt_tokens || {}, ct = server.completion_tokens || {};
        setCounter('v-prompt-avg', pt.avg ?? null);
        setCounter('v-compl-avg', ct.avg ?? null);
        setCounter('v-prompt-pct', pick(pt, pKey));
        setCounter('v-compl-pct', pick(ct, pKey));
        const ft = server.first_token_ms || {};
        setCounter('v-ttft', pick(ft, pKey) ?? ft.avg ?? null);
        const n = (pt.n || 0), errs = server.errors_total || 0;
        setCounter('v-errrate', (n + errs) > 0 ? errs / (n + errs) * 100 : null);
        $('reqstats-note').textContent =
            `server stats · ${n} samples` +
            (server.observed_real !== undefined ? ` (${server.observed_real} real, ${server.simulated} simulated)` : '') +
            (server.source ? ` · ${server.source}` : '');
        return;
    }
    const promptSamples = tracker.samples.prompt, complSamples = tracker.samples.completion;
    setCounter('v-prompt-avg', usageAvg ? usageAvg.prompt : (C.mean(promptSamples) ?? null));
    setCounter('v-compl-avg', usageAvg ? usageAvg.completion : (C.mean(complSamples) ?? null));
    setCounter('v-prompt-pct', C.percentile(promptSamples, p));
    setCounter('v-compl-pct', C.percentile(complSamples, p));
    setCounter('v-ttft', null);
    setCounter('v-errrate', null);
    $('lbl-prompt-pct').textContent = `${layout.percentile} prompt tok`;
    $('lbl-compl-pct').textContent = `${layout.percentile} completion tok`;
    const n = Math.max(promptSamples.length, complSamples.length);
    $('reqstats-note').textContent =
        `avg: usage aggregates (${usageRange}) · p: session samples (${n}, cap 2000)` +
        (n === 0 ? ' — waiting for requests to complete while this page is open' : '');
}
let fillSelectDone = false;
function fillSelectOnce() {
    if (fillSelectDone) return;
    fillSelectDone = true;
    fillSelect($('opt-percentile'), Object.keys(PERCENTILES).map(k => [k, k.toUpperCase()]), layout.percentile);
    $('opt-percentile').onchange = e => { layout.percentile = e.target.value; C.saveLayout(localStorage, layout); renderRequestStats(stats); };
}

/* ---------------- polling ---------------- */
async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
async function putModelSettings(model, settings) {
    const body = await trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings) });
        return res.json().catch(() => ({ detail: 'http ' + res.status }));
    });
    if (body.detail && body.success !== true) throw new Error(JSON.stringify(body.detail));
    if (body.success === false) throw new Error(JSON.stringify(body.detail || body));
    return body;
}
async function postModelAction(model, action) {
    const body = await trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/${action}`,
            { method: 'POST' });
        return res.json().catch(() => ({ detail: 'http ' + res.status }));
    });
    if (body.detail && body.success !== true && body.deleted !== true)
        throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail));
    return body;
}
async function pollStats() {
    if (document.hidden) return;
    try {
        const s = C.normalize(await fetchJson(`${API}/admin/api/stats`));
        failCount = 0;
        document.body.classList.remove('stale');
        $('banner').classList.remove('show');
        const events = C.eventsBetween(prevStats, s);
        const miles = C.milestonesBetween(prevStats, s);
        prevStats = stats; stats = s;
        if (milestoneFloor.requests === undefined && s.requests !== null)
            milestoneFloor.requests = Math.floor(s.requests / milestoneStep('requests'));
        if (milestoneFloor.totalTokens === undefined && s.totalTokens !== null)
            milestoneFloor.totalTokens = Math.floor(s.totalTokens / milestoneStep('totalTokens'));
        tracker.observe(s);
        render(s);
        reactTo(events);
        for (const mi of gateMilestones(miles)) celebrate(`${C.fmtNumber(mi.value)} ${mi.label}`);
    } catch (err) {
        if (++failCount >= 2) {
            document.body.classList.add('stale');
            $('banner-text').textContent = `Cannot reach API at ${API || location.origin}: ${err.message}`;
            $('banner').classList.add('show');
        }
    }
}
function restartPolling() {
    clearInterval(timer);
    pollStats();
    timer = setInterval(pollStats, layout.intervalMs);
}

/* ---------------- gateway status chip ---------------- */
// Native hosting writes go straight to real oMLX — same truth as LIVE mode.
let GW_LIVE = typeof NATIVE !== 'undefined' && NATIVE;   // true when the gateway runs in --live-writes mode
let gsSavedAt = 0;     // last save banner timestamp (updateModeLabels keeps it briefly)
/* Every page that claims 'shadow' must say so truthfully per gateway mode. */
function updateModeLabels() {
    const live = GW_LIVE;
    const dl = $('dl-mode'); if (dl) dl.textContent = live
        ? C.t('uplift.mode.dl_live') : C.t('uplift.mode.dl_shadow');
    const qz = $('qz-mode'); if (qz) qz.textContent = live
        ? C.t('uplift.mode.qz_live')
        : C.t('uplift.mode.qz_shadow');
    const up = $('up-mode'); if (up) up.textContent = live
        ? C.t('uplift.mode.up_live')
        : C.t('uplift.mode.up_shadow');
    const gs = $('gs-sub');
    // R10-2: this is the real dashboard now — live mode needs no banner.
    if (gs && Date.now() - gsSavedAt > 5000) gs.textContent = live
        ? '' : C.t('uplift.mode.gs_shadow');
    const hm = $('hm-sub');
    if (hm && hm.dataset.count) hm.textContent =
        C.t('uplift.mode.hm_sub', { n: hm.dataset.count, mode: live ? C.t('uplift.mode.live') : C.t('uplift.mode.shadow') });
}
async function pollGatewayInfo() {
    const chip = $('chip-gateway');
    // R11: native hosting = same-origin API, no gateway involved at all.
    if (NATIVE || API !== API_DEFAULT) {
        // 'direct' meant "talks to the server directly" — remnant of the old
        // mock-gateway era; in native mode the chip is meaningless, keep hidden
        if (chip) chip.hidden = true;
        if (NATIVE) updateModeLabels();   // labels must say the truth for real writes
        return;
    }
    if (chip) chip.hidden = false;
    try {
        const d = await fetchJson(`${API}/admin/api/mock/info`);
        GW_LIVE = !!d.live_writes;
        updateModeLabels();
        chip.textContent = d.ok
            ? (GW_LIVE ? 'gw↑LIVE' : `gw↑ok · r${d.observed_real}/s${d.simulated}`)
            : 'gw↑down';
        chip.classList.toggle('state-ok', !!d.ok);
        chip.title = `gateway → ${d.upstream}: ${d.ok ? C.t('uplift.gw.reachable') : (d.last_error || C.t('uplift.gw.unreachable'))}\n` +
                     (GW_LIVE ? ''
                              : `shadow overrides: ${Object.keys(d.overrides || {}).length} · `) +
                     `sim ${d.sim_rate}/s`;
    } catch (_) { chip.textContent = 'gw?'; chip.classList.remove('state-ok'); }
}

/* ---------------- request lifecycle feed ---------------- */
const MAX_REQFEED = 30;
let reqFeedRows = new Map();
let sseSource = null;

function renderReqFeed() {
    const list = $('reqfeed');
    const rows = [...reqFeedRows.values()];
    $('reqfeed-sub').textContent = rows.length
        ? `${rows.filter(r => ['queued','prefilling','generating'].includes(r.state)).length} active` : '';
    if (!rows.length) {
        const cur = list.querySelector('.empty');
        if (!cur) list.innerHTML = '<div class="empty">No requests yet</div>';
        return;
    }
    list.innerHTML = '';
    const sorted = rows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const r of sorted.slice(0, MAX_REQFEED)) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${r.state.charAt(0).toUpperCase() + r.state.slice(1)}`;
        badge.textContent = r.state;
        if (r.origin === 'real') { badge.title = 'real traffic'; }
        const name = document.createElement('span');
        name.className = 'model-name';
        name.textContent = r.error ? `${r.id} — ${r.error}` : (r.origin === 'real' ? '◆ ' : '') + r.id;
        name.title = `${r.model} · ${r.id}`;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.completion) bits.push(`out ${C.fmtCompact(r.completion)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (['queued', 'prefilling', 'generating'].includes(r.state)) {
            const x = document.createElement('button');
            x.className = 'se-btn'; x.textContent = '✕'; x.title = 'Cancel request';
            x.onclick = async () => {
                try {
                    const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(r.id)}/cancel`, { method: 'POST' });
                    if (res.status === 501) { toast(C.t('uplift.toast.no_cancel_route')); return; }
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
                    toast(C.t('uplift.toast.cancelled', {id: r.id.slice(0, 6)}));
                } catch (err) { toast(C.t('uplift.toast.cancel_failed', {msg: err.message})); }
                pollRequests();
            };
            row.append(x);
        }
        list.append(row);
    }
}
function upsertReq(id, patch) {
    const prev = reqFeedRows.get(id) || { prompt: 0, completion: 0 };
    reqFeedRows.set(id, Object.assign({}, prev, patch, { id, ts: Date.now() }));
    if (reqFeedRows.size > MAX_REQFEED * 3) {
        const sorted = [...reqFeedRows.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
        for (const [id2, r] of sorted.slice(MAX_REQFEED)) {
            if (['complete', 'error'].includes(r.state)) reqFeedRows.delete(id2);
        }
    }
    renderReqFeed();
}
function pushServerEvent(ev) {
    if (ev.type === 'request') {
        upsertReq(ev.id, { state: ev.state, model: ev.model, origin: ev.origin });
        pushFeed([{ kind: 'requests', text: `${ev.origin === 'real' ? '◆ ' : ''}${ev.id.slice(0, 6)} → ${ev.state}` }]);
        if (ev.state === 'error') flashCard('v-errrate', 'bad');
        if (ev.state === 'complete') flashCard('v-requests', 'ok');
    } else if (ev.type === 'model-load') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: C.t('uplift.feed.load_requested', {model: ev.id}) }]);
    } else if (ev.type === 'model-unload') {
        pushFeed([{ kind: 'model-remove', model: ev.id, text: C.t('uplift.feed.unload', {model: ev.id}) }]);
    } else if (ev.type === 'model-ready') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: C.t('uplift.feed.ready', {model: ev.id}) }]);
    } else if (ev.type === 'settings') {
        pushFeed([{ kind: 'requests', text: C.t('uplift.feed.settings_changed', {model: ev.id, keys: ev.changed.join(', ')}) }]);
    } else if (ev.type === 'mock-reset') {
        pushFeed([{ kind: 'requests', text: C.t('uplift.feed.gw_reset') }]);
    }
}
function connectEventStream() {
    if (sseSource || !window.EventSource) return;
    // R12-3: native oMLX now serves /admin/api/requests/stream (sampled
    // from scheduler snapshots); the gateway keeps its own SSE unchanged.
    try {
        sseSource = new EventSource(`${API}/admin/api/requests/stream`);
        sseSource.onmessage = e => { try { pushServerEvent(JSON.parse(e.data)); } catch (_) {} };
        sseSource.onerror = () => { /* EventSource retries on its own */ };
    } catch (_) { sseSource = null; }
}
async function pollRequests() {
    if (document.hidden) return;   // R12-3: native route now exists
    try {
        const d = await fetchJson(`${API}/admin/api/requests?limit=30`);
        for (const r of d.requests)
            upsertReq(r.id, { state: r.state, model: r.model, origin: r.origin,
                              prompt: r.prompt_tokens, completion: r.completion_tokens,
                              tps: r.tps, error: r.error });
    } catch (_) { /* gateway offline; feed keeps last state */ }
}

/* ---------------- model manager (Models tab) ---------------- */
let seModel = null, seValues = {};   // seValues = live form state (modelspec shape)
let GRAMMAR_PARSERS = null;          // R10-7: cached /admin/api/grammar/parsers payload
async function loadGrammarParsers() {
    if (GRAMMAR_PARSERS) return;
    try {
        const d = await fetchJson(`${API}/admin/api/grammar/parsers`);
        if (Array.isArray(d)) GRAMMAR_PARSERS = d;
    } catch (_) { /* offline/upstream missing: fall back to model-reported list */ }
}
let seOrig = {};                     // baseline snapshot for dirty tracking
/* Fields that only take effect when the engine is (re)built: changing one
   of these on a LOADED model shows RESTART MODEL in the editor Save button
   (server semantics: PUT replies requires_reload for exactly these). */
const SE_RESTART_KEYS = new Set([
    'model_type_override', 'index_cache_freq', 'dflash_enabled',
    'dflash_draft_model', 'dflash_draft_quant_enabled',
    'dflash_draft_quant_weight_bits', 'dflash_draft_quant_activation_bits',
    'dflash_draft_quant_group_size', 'dflash_max_ctx', 'dflash_in_memory_cache',
    'dflash_in_memory_cache_max_entries', 'dflash_in_memory_cache_max_bytes',
    'dflash_ssd_cache', 'dflash_ssd_cache_max_bytes', 'trust_remote_code',
    'mtp_enabled', 'vlm_mtp_enabled', 'vlm_mtp_draft_model',
    'vlm_mtp_draft_block_size']);
function seDirtyKeys() {                     // dirty keys of the ACTIVE tab
    const t = seTab();
    return t ? [...t.dirty] : [];
}
function seNeedsRestart() {
    return seDirtyKeys().some(k => SE_RESTART_KEYS.has(k));
}
function seAnyTabDirty() {
    for (const t of seTabs) {
        if (t.dirty.size) return true;
        if (t.id !== 'base') {
            if ((t._origExpose || false) !== !!t.expose_as_model ||
                (t._origApi || '') !== (t.api_name || '')) return true;
        }
    }
    return false;
}
function seUpdateSaveBtn() {
    const b = document.getElementById('se-save'); if (!b) return;
    const n = seDirtyKeys().length;
    const restart = seNeedsRestart() && isBaseTabActive() &&
        !!(seFormModel && (seFormModel.loaded || seFormModel.is_loading));
    function isBaseTabActive() { return seIsBaseTab(); }
    b.classList.toggle('queued', n > 0);
    b.classList.toggle('restart-mode', restart);
    const tabTxt = seIsBaseTab() ? '' : ' PROFILE';
    b.textContent = n ? (restart ? '▶ RESTART MODEL (' + n + ')'
                                 : 'SAVE' + tabTxt + ' (' + n + ')')
                      : (seIsBaseTab() ? 'SAVE' : 'SAVE PROFILE');
    b.title = restart
        ? C.t('uplift.se.restart_title') : '';
    renderEdChanges();
}
/* CHANGES box above the editor buttons: yaml-style key: old -> key: new,
   including inherit flips for profile tabs and the expose/api lines */
function renderEdChanges() {
    const box = document.getElementById('se-changes'); if (!box) return;
    const t = seTab();
    const lines = [];
    const shown = new Set();
    if (seIsBaseTab()) {
        for (const k of t.dirty) {
            const sec = SECRET_KEYS.has(k) ? '••• CHANGED' : null;
            lines.push(k + ': ' + (sec || gsDisplay(seOrig[k])) + ' → ' +
                       k + ': ' + (sec || gsDisplay(seValues[k])));
            shown.add(k);
        }
    } else {
        for (const k of t.dirty) {
            const sec = SECRET_KEYS.has(k) ? '••• CHANGED' : null;
            const o = SE_INHERIT_KEYS.has(k) ? seOvSnap(t)[k] : t.origVals[k];
            lines.push(k + ': ' + (sec || gsDisplay(o)) + ' \u2192 ' +
                       k + ': ' + (sec || gsDisplay(seValues[k])));
            shown.add(k);
        }
    }
    // edited-back fields whose diff lives only in widgets: drop from box too
    for (const el of document.querySelectorAll('#se-fields .diff-out')) {
        const key = el.closest('label.se-row')?.dataset.key;
        if (!key || shown.has(key)) continue;
    }
    if (!seIsBaseTab()) {
        if ((t._origExpose || false) !== !!t.expose_as_model)
            lines.unshift('expose_as_model: ' + gsDisplay(!!t._origExpose) +
                          ' → expose_as_model: ' + gsDisplay(!!t.expose_as_model));
        if ((t._origApi || '') !== (t.api_name || ''))
            lines.unshift('api_name: ' + gsDisplay(t._origApi) +
                          ' → api_name: ' + gsDisplay(t.api_name));
    }
    box.hidden = !lines.length;
    box.textContent = '';
    if (!lines.length) return;
    const head = document.createElement('div'); head.className = 'ch-head';
    head.textContent = C.tf('uplift.ui.changes', 'CHANGES (') + lines.length + ')';
    box.append(head);
    for (const ln of lines) {
        const d = document.createElement('div'); d.className = 'ch-line';
        d.textContent = ln;
        box.append(d);
    }
}
function renderEdList() { renderEdChanges(); }

/* ---- spec-driven settings form (parity with classic _modal_model_settings) ---- */
/* seValues holds the modelspec form state (UpliftModelSpec.buildState shape).
   Widgets write straight into seValues and re-run renderEditorFields() so the
   same conditional visibility the classic modal uses (x-show rules) applies. */
let seFormModel = null;      // the /admin/api/models entry this editor is for

/* ---- editor profile tabs -------------------------------------------------
   The editor edits a STACK of targets: the Base model settings plus one tab
   per model profile. Profile tabs hold sparse overrides: keys absent from a
   profile are INHERITED from the base at request time (server does exactly
   this: merged = base.to_dict(); merged.update(profile.settings)). The UI
   mirrors that — an empty input shows the base value as placeholder
   "value (inherited)", a filled input is an override. Only overrides are
   persisted, so changing the base never needs manual syncing. */
let seTabs = [];            // [{id:'base',dirty:Set}|{id,name,display_name,
                            //   expose_as_model,api_name,overrides:{},base?,
                            //   template?,dirty:Set}]
let seActiveTab = 'base';
let seBaseVals = null;      // base modelspec-shape state (source of inherit display)
/* Sampling keys are inheritable on profile tabs (empty = follow base). */
const SE_INHERIT_KEYS = new Set(['temperature', 'top_p', 'top_k',
    'repetition_penalty', 'min_p', 'presence_penalty']);
function seOvSnap(t) {                       // frozen stored-override snapshot
    if (!t._ovSnap) t._ovSnap = JSON.parse(JSON.stringify(t.overrides || {}));
    return t._ovSnap;
}
function seInitSnap(t) { t._ovSnap = JSON.parse(JSON.stringify(t.overrides || {})); return t; }
function seTab() { return seTabs.find(t => t.id === seActiveTab) || seTabs[0]; }
function seIsBaseTab() { return seTab().id === 'base'; }

function seBind(kind, key, opts) {
    /* one labeled field bound to seValues[key]; matches classic addRow() but
       writes the modelspec state shape and supports selects/options/text */
    const label = document.createElement('label');
    label.className = 'se-row';
    const name = document.createElement('span');
    // localize by field key; the passed literal is the English fallback
    name.textContent = C.tf('uplift.se.' + key, opts && opts.label ? opts.label : key);
    let input;
    if (kind === 'select') {
        input = document.createElement('select');
        for (const o of (opts.options || [])) {
            const el = document.createElement('option');
            el.value = o.value;
            el.textContent = C.tf('uplift.se.' + key + '.opt.' + o.value,
                                   o.label != null ? o.label : o.value);
            if (String(seValues[key]) === String(o.value)) el.selected = true;
            input.append(el);
        }
        if (opts.picker) {              // draft-model picker: selected value may not be in pool
            const cur = seValues[key];
            if (cur && ![...input.options].some(el => el.value === cur)) {
                const el = document.createElement('option');
                el.value = cur; el.textContent = cur + ' (current)'; el.selected = true;
                input.prepend(el);
            }
        }
    } else if (kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = seValues[key] === true;
    } else if (kind === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = seValues[key] == null ? '' : seValues[key];
    } else if (kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = seValues[key] == null ? '' : seValues[key];
    } else if (kind === 'inheritable-number') {
        // profile-tab number: value comes from the tab's OVERRIDES only;
        // empty = inherit, placeholder shows the base value
        kind = 'number';
        input = document.createElement('input');
        input.type = 'number';
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        if (opts && opts.min != null) input.min = opts.min;
        if (opts && opts.max != null) input.max = opts.max;
        if (opts && opts.step != null) input.step = opts.step;
        const cur = seTab() && seTab().overrides[key];
        input.value = cur == null || cur === '' ? '' : cur;
        // U3: never a blind empty — base value, else the server's own default
        if (bv != null) input.placeholder = String(bv) + ' (inherited)';
        else input.placeholder = (opts && opts.effHint) || '(default)';
    } else if (kind === 'inheritable-text') {
        kind = 'text';
        input = document.createElement('input');
        input.type = 'text';
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        const cur = seTab() && seTab().overrides[key];
        input.value = cur == null ? '' : cur;
        if (bv != null && bv !== '') input.placeholder = String(bv) + ' (inherited)';
        else input.placeholder = (opts && opts.effHint) || '(default)';
    } else if (kind === 'inheritable-bool') {
        // three-state: override-on / override-off / inherit (empty)
        input = document.createElement('select');
        const cur = seTab() && seTab().overrides[key];
        const on = document.createElement('option');
        on.value = 'true';  on.textContent = 'Yes (override)';
        const off = document.createElement('option');
        off.value = 'false'; off.textContent = 'No (override)';
        const inh = document.createElement('option');
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        inh.value = ''; inh.textContent = 'Inherited: ' + (bv === true ? 'Yes' : bv === false ? 'No' : '—');
        input.append(inh, on, off);
        input.value = cur === true || cur === 'true' ? 'true' : cur === false || cur === 'false' ? 'false' : '';
    } else {
        input = document.createElement('input');
        input.type = 'number';
        if (opts) { if (opts.min != null) input.min = opts.min;
                    if (opts.max != null) input.max = opts.max;
                    if (opts.step != null) input.step = opts.step; }
        const cur = seValues[key];
        input.value = (cur === null || cur === undefined) ? '' : cur;
        // U3: an empty number is NOT zero — the server falls back to the
        // model's own default (generation_config.json / builtin). We do not
        // read those files, so say so honestly instead of showing nothing.
        if (input.value === '') input.placeholder = (opts && opts.effHint) || '(default)';
    }
    if (opts && opts.disabled) input.disabled = true;
    const evt = (kind === 'textarea' || kind === 'text' || kind === 'number') ? 'input' : 'change';
    input.addEventListener(evt, () => {
        const t = seTab();
        if (kind === 'bool') seValues[key] = input.checked;
        else if (kind === 'number') {
            // inheritable numbers keep "" = inherit (undefined), otherwise value
            if (input.value === '') seValues[key] = (t && t.id !== 'base') ? undefined : null;
            else seValues[key] = Number(input.value);
        }
        else if (kind === 'select') seValues[key] = input.value;
        else seValues[key] = input.value;
        // inherited-bool tri-state maps '' -> undefined (inherit)
        if (input.tagName === 'SELECT' && input.dataset.inherit === '1')
            seValues[key] = input.value === '' ? undefined : input.value === 'true';
        // keep the tab override map live so re-renders show typed values
        if (t && t.id !== 'base') {
            if (seValues[key] === undefined) delete t.overrides[key];
            else t.overrides[key] = seValues[key];
        }
        // dirty marking against the tab's ORIGINAL baseline (for inheritable
        // profile fields the original is the STORED override, possibly absent)
        const lab2 = input.closest('label.se-row');
        if (lab2) {
            const orig = (t && t.id !== 'base' && SE_INHERIT_KEYS.has(key))
                ? seOvSnap(t)[key]
                : (t && t.origVals ? t.origVals[key] : seOrig[key]);
            const changed = JSON.stringify(seValues[key]) !== JSON.stringify(orig);
            if (changed) t && t.dirty.add(key); else t && t.dirty.delete(key);
            lab2.classList.toggle('dirty', changed);
            lab2.classList.toggle('restartq', changed && SE_RESTART_KEYS.has(key));
            const rd = lab2.querySelector('.diff-out');
            if (rd) {
                rd.hidden = !changed;
                if (changed && SECRET_KEYS.has(key)) {
                    // secret stays masked: only say that it changed
                    rd.classList.add('masked');
                    rd.querySelector('.diff-o').textContent = '••• CHANGED';
                } else if (changed) {
                    rd.classList.remove('masked');
                    rd.querySelector('.diff-o').textContent = gsDisplay(orig);
                }
            }
        }
        seUpdateSaveBtn();
        if (opts && opts.onChange) opts.onChange(seValues);
    });
    label.dataset.key = key;
    if (input.tagName === 'SELECT' && ['true','false',''].includes(input.value)
        && opts && opts.inherit) input.dataset.inherit = '1';
    const slot = document.createElement('span'); slot.className = 'se-slot';
    const rd = document.createElement('span'); rd.className = 'diff-out'; rd.hidden = true;
    const o = document.createElement('span'); o.className = 'diff-o';
    o.title = C.tf('uplift.ui.click_to_revert', 'Click to revert');
    o.onclick = (ev) => {
        ev.preventDefault();
        const t = seTab(); if (!t) return;
        const origV = (t.id !== 'base' && SE_INHERIT_KEYS.has(key))
            ? seOvSnap(t)[key]
            : ((t.origVals || seOrig)[key]);
        seValues[key] = origV === undefined ? (t.id !== 'base' ? undefined : seOrig[key]) : origV;
        t.dirty.delete(key);
        if (t.id !== 'base') {
            // revert an override back to inherit/original override
            if (origV === undefined) delete t.overrides[key];
            else t.overrides[key] = origV;
        }
        renderEditorFields(document.getElementById('se-fields'));
        seUpdateSaveBtn();
    };
    // the NEW value is the live input itself; the slot only carries the
    // |original| chip pointing at it, so the input never jumps
    rd.append(o, document.createTextNode('→'));
    slot.append(rd);
    const ctlBox = document.createElement('span'); ctlBox.className = 'se-ctl';
    ctlBox.append(input);
    label.append(name, slot, ctlBox);
    if (opts && opts.hint) {
        const h = document.createElement('small');
        h.className = 'se-hint';
        h.textContent = C.tf('uplift.se.' + key + '.hint', opts.hint);
        label.append(h);
    }
    return label;
}

function seSection(title) {
    // R10-5: sections read as framed boxes (same language as the settings
    // page gs-boxes / model list rows): inverted header strip, tinted body.
    const box = document.createElement('div');
    box.className = 'se-box';
    const h = document.createElement('h5');
    h.className = 'se-section';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.textContent = C.tf('uplift.se.section.' + slug, title);
    const body = document.createElement('div');
    body.className = 'se-box-body';
    box.append(h, body);
    box.__body = body;
    return box;
}

function renderEditorFields(container) {
    const S = window.UpliftModelSpec;
    const m = seFormModel || {};
    // profile tabs edit overrides-on-base; base tab edits the model itself
    const tab = seTab();
    if (tab && tab.id !== 'base' && seBaseVals) {
        const mergedState = Object.assign({}, seBaseVals,
            JSON.parse(JSON.stringify(tab.workVals || {})));
        seNormalizeKwargs(mergedState);   // R10-6: raw kwargs shape -> editor entries
        seValues = mergedState;
        seOrig = tab.origVals || Object.assign({}, seBaseVals);
    }
    container.textContent = '';
    let sect = null;
    // R10-5: sections are framed boxes; grid() appends into the open one.
    const section = (title) => { sect = seSection(title); container.append(sect); return sect.__body; };
    const grid = () => { const g = document.createElement('div'); g.className = 'pair';
        (sect ? sect.__body : container).append(g); return g; };
    // R10-14: a toggle's child controls go into an indented sub-block so
    // the parent/child relationship reads visually; nestable.
    const sub = (parent) => { const d = document.createElement('div');
        d.className = 'se-sub'; parent.append(d); return d; };

    /* ---- basic ---- */
    if (!seIsBaseTab()) {
        const ban = document.createElement('div'); ban.className = 'se-profile-banner';
        const t = seTab();
        const exp = document.createElement('label'); exp.className = 'se-prof-expose';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = !!t.expose_as_model;
        const lbl = document.createElement('span'); lbl.textContent = ' EXPOSE AS API MODEL ';
        cb.onchange = () => { t.expose_as_model = cb.checked; seUpdateSaveBtn(); };
        const api = document.createElement('input'); api.type = 'text';
        api.placeholder = 'api_name'; api.value = t.api_name || '';
        api.style.width = '180px';
        api.oninput = () => { t.api_name = api.value.trim(); seUpdateSaveBtn(); };
        exp.append(cb, lbl, api);
        ban.append(exp);
        if (t._new || !t.profileId) {
            const nmIn = document.createElement('input');
            nmIn.type = 'text'; nmIn.className = 'se-newname';
            nmIn.value = t.display_name || t.name || '';
            nmIn.style.width = '200px';
            nmIn.oninput = () => { t.name = nmIn.value.trim(); t.display_name = t.name;
                seUpdateSaveBtn();
                const strip = document.querySelector('.se-tabs');
                if (strip) seRenderTabs(document.querySelector('.modal.editor')); };
            exp.prepend(nmIn);
        }
        const hint = document.createElement('small'); hint.className = 'dim';
        hint.textContent = t.template
            ? 'Global template copy: applies to this model only when saved as a profile.'
            : 'Empty fields inherit the base model (shown greyed as "value (inherited)").';
        ban.append(hint);
        container.append(ban);
    }
    section('Sampling');
    let g = grid();
    if (seIsBaseTab() || !seTab().template)
        g.append(seBind('text', 'model_alias', { label: 'Display Name' }));
    g.append(seBind('select', 'model_type_override', {
        label: 'Model Type',
        options: [{ value: '', label: 'Auto-detect' },
                  ...S.MODEL_TYPE_OPTIONS.map(v => ({ value: v }))] }));
    const sampling = [
        ['temperature', 0, 2, 0.05, 'Temperature'], ['top_p', 0, 1, 0.05, 'Top P'],
        ['top_k', 0, null, 1, 'Top K'], ['repetition_penalty', 0.5, 2, 0.01, 'Repetition Penalty'],
        ['min_p', 0, 1, 0.01, 'Min P'], ['presence_penalty', -2, 2, 0.05, 'Presence Penalty']];
    const inheritOn = !seIsBaseTab();
    if (!S.isDiffusion(m)) for (const [k, mn, mx, st, lab] of sampling) {
        if (inheritOn) {
            g.append(seBind('inheritable-number', k, { label: lab, min: mn, max: mx, step: st }));
            continue;
        }
        g.append(seBind('number', k, { label: lab, min: mn, max: mx, step: st }));
    }
    g.append(seBind('bool', 'force_sampling', { label: 'Force Sampling',
        hint: 'Override request sampling parameters with configured values' }));

    /* ---- thinking & reasoning (R10-5 split out of Advanced) ---- */
    section('Thinking & Reasoning');
    g = grid();
    if (!S.isDiffusion(m)) {
        if (m.thinking_default !== undefined && m.thinking_default !== null || seValues.enable_thinking != null) {
            const tv = seValues.enable_thinking;
            g.append(seBind('select', 'enable_thinking', {
                label: C.tf('uplift.ui.enable_thinking', 'Enable Thinking'), disabled: !!m.thinking_forced,
                hint: 'Enable reasoning/thinking mode for this model.',
                options: [{ value: '', label: m.thinking_default === true
                               ? 'Using model default (on)' : 'Using model default (off)' },
                          { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }],
            }));
            // select needs string values; store real bool/null back
            const sel = g.lastChild.querySelector('select');
            sel.value = tv === true ? 'true' : tv === false ? 'false' : '';
            sel.addEventListener('change', () => {
                seValues.enable_thinking = sel.value === '' ? null : sel.value === 'true'; });
        }
        // NOTE: preserve_thinking has NO widget in the classic modal (it only
        // appears in the diffusion unsupported-field lists) — parity: none here.
        if (seValues.reasoning_parser !== undefined || m.reasoning_parsers) {
            // R10-7: classic fills this list from /admin/api/grammar/parsers
            // (xgrammar builtin registry); model-reported list is usually empty.
            const seen = new Set();
            const rp = [{ value: '', label: 'None' }];
            const add = (value, label) => {
                if (!value || seen.has(value)) return;
                seen.add(value); rp.push({ value, label: label != null ? label : value });
            };
            (GRAMMAR_PARSERS || []).forEach(p => add(p.value,
                p.label + (p.models && p.models.length ? ' (' + p.models.join(', ') + ')' : '')));
            (m.reasoning_parsers || []).forEach(v => add(v));
            add(seValues.reasoning_parser || '');
            g.append(seBind('select', 'reasoning_parser', { label: 'Reasoning Parser', options: rp }));
        }
        g.append(seBind('bool', 'enableThinkingBudget', { label: 'Thinking Budget',
            hint: 'Limit thinking tokens for reasoning models.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableThinkingBudget)
            sub(g).append(seBind('number', 'thinking_budget_tokens',
                { label: C.tf('uplift.ui.thinking_budget_tokens', 'Thinking budget (tokens)'), min: 1, step: 1 }));
        // cache_reasoning_output: tri-state (null = auto: cache when history
        // preserves <think>). Upstream #3525; classic modal has no widget —
        // additive, same keys as the API.
        {
            const cv = seValues.cache_reasoning_output;
            g.append(seBind('select', 'cache_reasoning_output', {
                label: C.tf('uplift.ui.cache_reasoning_output', 'Cache Reasoning Output'),
                hint: 'Cache <think> output for the next turn. Auto = only when history keeps it.',
                options: [{ value: '', label: 'Auto' },
                          { value: 'true', label: 'Always' },
                          { value: 'false', label: 'Never' }],
            }));
            const sel = g.lastChild.querySelector('select');
            sel.value = cv === true ? 'true' : cv === false ? 'false' : '';
            sel.addEventListener('change', () => {
                seValues.cache_reasoning_output =
                    sel.value === '' ? null : sel.value === 'true'; });
        }
        g.append(seBind('bool', 'enableToolResultLimit', { label: 'Limit Tool Result Tokens',
            hint: 'Truncate large tool results (e.g. file reads) to a token limit.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableToolResultLimit)
            sub(g).append(seBind('number', 'max_tool_result_tokens',
                { label: C.tf('uplift.ui.tool_result_token_limit', 'Tool result token limit'), min: 1, step: 1 }));
    }
    /* ---- grammar (R10-5: own section, wide mono textarea) ---- */
    section('Grammar');
    g = grid();
    if (!S.isDiffusion(m)) {
        const ggWrap = seBind('textarea', 'guided_grammar', {
            label: C.tf('uplift.ui.guided_grammar', 'Guided Grammar'),
            hint: 'EBNF / regex / JSON-schema grammar applied to generation when enabled.' });
        ggWrap.classList.add('se-wide');
        const ggInp = ggWrap.querySelector('textarea');
        // U2: EBNF in a 3-row box is unworkable — EXPAND opens a roomy
        // full-width grammar well. Edits flow back through the textarea's
        // own input event so dirty-marking and tab bookkeeping stay exact.
        const expandB = document.createElement('button');
        expandB.type = 'button'; expandB.className = 'se-btn act';
        expandB.textContent = 'EXPAND ⤢'; expandB.title = C.tf('uplift.ui.edit_the_grammar_in_a_larger_window', 'Edit the grammar in a larger window');
        expandB.onclick = () => openGrammarPop(ggInp, expandB);
        // R10-9: preset examples. Shape is server-pluggable later: keep it
        // a list of {id, display_name, grammar} so a route can replace this.
        const GRAMMAR_PRESETS = [
            { id: 'json-object', display_name: 'JSON object envelope', grammar:
                'root   ::= "{" ws "\\"name\\"" ws ":" ws string ws "," ws "score" ws ":" ws number ws "}"\n'
              + 'string ::= "\\"" [^"\\\\]* "\\"\\" | "\\\\" any "\\\\" any\n'
              + 'number ::= "-"? [0-9]+ ("." [0-9]+)?\nws       ::= " "*' },
            { id: 'regex-date', display_name: 'Regex: ISO date', grammar:
                'root ::= [0-9] [0-9] [0-9] [0-9] "-" [0-1] [0-9] "-" [0-3] [0-9]' },
            { id: 'ebnf-calc', display_name: 'EBNF: math expression', grammar:
                'root     ::= expr\nexpr     ::= term (("+" / "-") term)*\nterm     ::= atom (("*" / "/") atom)*\natom     ::= [0-9]+ / "(" expr ")"' },
        ];
        const presetSel = document.createElement('select');
        presetSel.title = C.tf('uplift.ui.insert_an_example_grammar', 'Insert an example grammar');
        const ph = document.createElement('option');
        ph.value = ''; ph.textContent = 'Insert example…';
        presetSel.append(ph, ...GRAMMAR_PRESETS.map(p => {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.display_name; return o; }));
        presetSel.onchange = () => {
            const p = GRAMMAR_PRESETS.find(x => x.id === presetSel.value);
            presetSel.value = '';
            if (!p) return;
            // go through the widgets' own events so dirty-marking and tab
            // override bookkeeping happen exactly like manual editing
            if (ggInp.disabled) {
                const en = document.querySelector(
                    '#se-fields [data-key="guided_grammar_enabled"] input[type=checkbox]');
                if (en && !en.checked) en.click();   // flips seValues + enables textarea
            }
            ggInp.value = p.grammar;
            ggInp.dispatchEvent(new Event('input', { bubbles: true }));
        };
        // R10-14: grammar toggle + textarea + preset dropdown form one
        // framed unit; the box is always present, visibly disabled when off
        const gsb = sub(g);
        gsb.classList.add('se-sub-keep');
        gsb.append(seBind('bool', 'guided_grammar_enabled', { label: 'Guided Grammar',
            hint: 'Apply an EBNF grammar by default for this model.',
            // toggle must NOT reflow the form: the grammar box is always
            // present, just visibly disabled while the feature is off
            onChange: v => { ggInp.disabled = !v.guided_grammar_enabled; } }));
        ggInp.disabled = !seValues.guided_grammar_enabled;
        // R10-9: example dropdown docks inside the grammar field's control
        // box (below the textarea) so toggle + textarea + presets read as one unit
        ggWrap.querySelector('.se-ctl').append(presetSel, expandB);
        gsb.append(ggWrap);
    }

    /* chat-template kwargs (subset: key/value rows, add/remove) */
    if (!S.isDiffusion(m)) renderCtKwargs(section('Chat Template Kwargs'));

    /* ---- acceleration (kept: engine-level, not spec decode) ---- */
    section('Acceleration');
    g = grid();
    if (!S.isDiffusion(m)) {
        g.append(seBind('bool', 'enableIndexCache', { label: 'Index Cache',
            hint: 'Skip redundant indexer computation in DSA layers (DeepSeek V3/GLM-5).',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableIndexCache)
            sub(g).append(seBind('number', 'index_cache_freq',
                { label: C.tf('uplift.ui.frequency_every_nth_layer_keeps_indexer', 'Frequency (every Nth layer keeps indexer)'), min: 1, step: 1 }));
    }
    if (seValues.turboquant_kv_enabled !== undefined && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'turboquant_kv_enabled', { label: 'TurboQuant KV Cache',
            hint: 'Compress KV cache using vector quantization. Lower bits = more compression.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.turboquant_kv_enabled)
            sub(g).append(seBind('number', 'turboquant_kv_bits',
                { label: C.tf('uplift.ui.bits_per_channel', 'Bits per channel'), min: 2, max: 8, step: 0.25 }));
    }
    if (m.qwen4_ple_ssd_offload_supported || seValues.qwen4_ple_ssd_offload)
        g.append(seBind('bool', 'qwen4_ple_ssd_offload', { label: 'SSD N-gram Offload (Qwen4 only)',
            hint: m.qwen4_ple_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep the large PLE N-gram table on SSD and read only the required rows.',
            disabled: !!m.qwen4_ple_ssd_offload_forced }));
    if (seValues.deepseek_v41_ced_prefill_supported)
        g.append(seBind('bool', 'deepseek_v41_ced_prefill_enabled',
            { label: C.tf('uplift.ui.ced_prefill_acceleration_deepseek_v4_1', 'CED Prefill Acceleration (DeepSeek V4.1)'),
              hint: 'Improves prefill speed by approximately 74-79% in tested configuration.' }));
    if (m.deepseek_v41_engram_ssd_offload_supported)
        g.append(seBind('bool', 'deepseek_v41_engram_ssd_offload', {
            label: C.tf('uplift.ui.ssd_n_gram_offload_deepseek_v4_1', 'SSD N-gram Offload (DeepSeek V4.1)'),
            hint: m.deepseek_v41_engram_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep Engram tables on SSD and prefetch required rows. Saves memory; speed depends on storage.',
            disabled: !!m.deepseek_v41_engram_ssd_offload_forced }));
    if (m.moe_expert_offload_supported && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'moe_expert_offload_enabled', { label: 'MoE Expert Offload',
            hint: 'Stream Mixture-of-Experts weights from the checkpoint on demand, keeping only part resident.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.moe_expert_offload_enabled)
            sub(g).append(seBind('number', 'moe_expert_offload_resident_fraction',
                { label: C.tf('uplift.ui.resident_experts_fraction', 'Resident experts (fraction)'), min: 0.01, max: 1, step: 0.01 }));
    }
    if (S.isQwenOqA8(m)) {
        g.append(seBind('bool', 'qwen35_oq_a8_enabled', { label: 'Qwen INT8 Activation Prefill',
            hint: 'Experimental GPU INT8 activation quantization for supported Q4/Q5 prefill.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.qwen35_oq_a8_enabled)
            sub(g).append(seBind('number', 'qwen35_oq_a8_min_tokens',
                { label: C.tf('uplift.ui.minimum_prompt_tokens', 'Minimum prompt tokens'), min: 1, step: 1 }));
    }
    if (m.ane_prefill_backend && !S.isDiffusion(m)) renderAne(container, g);

    /* ---- speculative decode (R10-5 rename) ---- */
    section('Speculative Decoding');
    g = grid();
    const models = adminModels.length ? adminModels : [];
    const S_ = window.UpliftModelSpec;
    if (!S_.isDiffusion(m)) {
        if (seValues.specprefill_enabled !== undefined) {
            g.append(seBind('bool', 'specprefill_enabled', { label: 'SpecPrefill',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.specprefill_enabled) {
                const sb = sub(g);
                const pool = S_.specprefillCandidates(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'specprefill_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                sb.append(seBind('select', 'specprefill_keep_pct', { label: 'Keep Rate', options: [
                    { value: '0.1', label: '10% — Aggressive (~5-7x, some quality loss)' },
                    { value: '0.2', label: '20% — Balanced (~3x, recommended)' },
                    { value: '0.25', label: '25% — Conservative+ (~2.5x)' },
                    { value: '0.3', label: '30% — Conservative (~2.2x)' },
                    { value: '0.4', label: '40% — Mild (~1.8x)' },
                    { value: '0.5', label: '50% — Minimal (~1.5x)' }], picker: true }));
                sb.append(seBind('number', 'specprefill_threshold',
                    { label: C.tf('uplift.ui.threshold_tokens', 'Threshold (tokens)'), min: 1024, max: 131072, step: 1024 }));
            }
        }
        if (seValues.dflash_enabled !== undefined) {
            g.append(seBind('bool', 'dflash_enabled', { label: 'DFlash',
                hint: m.dflash_compatible === false ? (m.dflash_compatibility_reason || 'not compatible') : '',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.dflash_enabled) {
                const sb = sub(g);
                const pool = S_.dflashCandidates(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'dflash_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                sb.append(seBind('bool', 'dflash_draft_quant_enabled', { label: 'Quantization',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_draft_quant_enabled) {
                    sb.append(seBind('select', 'dflash_draft_quant_weight_bits', { label: 'Weight Bits', options: [
                        { value: 2, label: '2-bit' }, { value: 4, label: '4-bit' }, { value: 8, label: '8-bit' }], picker: true }));
                    sb.append(seBind('select', 'dflash_draft_quant_activation_bits', { label: 'Activation Bits', options: [
                        { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }], picker: true }));
                    sb.append(seBind('number', 'dflash_draft_quant_group_size', { label: 'Group Size', min: 16, max: 256, step: 16 }));
                }
                sb.append(seBind('number', 'dflash_max_ctx', { label: 'Max Context (fallback threshold)', step: 1 }));
                sb.append(seBind('bool', 'dflash_in_memory_cache', { label: 'In-memory cache',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_in_memory_cache) {
                    sb.append(seBind('number', 'dflash_in_memory_cache_max_entries',
                        { label: C.tf('uplift.ui.in_memory_cache_max_entries', 'In-memory cache max entries'), min: 1, step: 1 }));
                    sb.append(seBind('number', 'dflash_in_memory_cache_max_gib',
                        { label: C.tf('uplift.ui.in_memory_cache_size_gib', 'In-memory cache size (GiB)'), min: 1, step: 1,
                          hint: 'Byte budget for L1 snapshots; LRU evicts when exceeded.' }));
                    if (seValues.dflash_ssd_cache_available) {
                        sb.append(seBind('bool', 'dflash_ssd_cache', { label: 'SSD cache',
                            hint: 'Requires in-memory cache to be enabled.' }));
                        if (seValues.dflash_ssd_cache)
                            sb.append(seBind('number', 'dflash_ssd_cache_max_gib',
                                { label: C.tf('uplift.ui.ssd_cache_size_gib', 'SSD cache size (GiB)'), min: 1, step: 1 }));
                    }
                }
                sb.append(seBind('number', 'dflash_draft_window_size', { label: 'Draft window size' }));
                sb.append(seBind('number', 'dflash_draft_sink_size', { label: 'Draft sink size', min: 0, step: 1 }));
                sb.append(seBind('number', 'dflash_block_size', { label: 'Runtime block size', step: 1 }));
                sb.append(seBind('select', 'dflash_verify_mode', { label: 'Verify mode', options: [
                    { value: 'adaptive', label: 'adaptive (default)' },
                    { value: 'dflash', label: 'dflash' },
                    { value: 'ddtree', label: 'ddtree' }], picker: true }));
            }
        }
        if (seValues.mtp_enabled !== undefined) {
            g.append(seBind('bool', 'mtp_enabled', { label: 'Lightning MTP',
                hint: m.mtp_compatible
                    ? "Drafts several tokens per step with the model's built-in MTP head."
                    : (m.mtp_compatibility_reason || 'Not compatible with this model'),
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.mtp_enabled)
                sub(g).append(seBind('number', 'mtp_num_draft_tokens', {
                    label: C.tf('uplift.ui.max_draft_tokens_per_cycle', 'Max draft tokens per cycle'), min: 1, step: 1,
                    hint: 'Speculative depth. Empty = model default (usually 3); '
                        + 'an adaptive controller picks 1..max from acceptance rates. '
                        + 'Set 1 to fix depth-1 cycles.' }));
        }
        const drafterType = (m.config_model_type || '').toLowerCase().replace(/-/g, '_');
        if (seValues.vlm_mtp_enabled !== undefined &&
            S_.VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES.has(drafterType)) {
            g.append(seBind('bool', 'vlm_mtp_enabled', { label: 'VLM MTP',
                hint: 'Speculative decoding via an external MTP drafter model.',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.vlm_mtp_enabled) {
                const sb = sub(g);
                const pool = S_.vlmMtpDrafters(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'vlm_mtp_draft_model', { label: 'Drafter model', options: [
                    { value: '', label: 'Select an assistant or MTP drafter…' }, ...pool], picker: true }));
                sb.append(seBind('number', 'vlm_mtp_draft_block_size',
                    { label: C.tf('uplift.ui.draft_block_size_tokens_per_round_blank_4', 'Draft block size (tokens per round, blank = 4)'), step: 1 }));
            }
        }
    }

    /* ---- context & limits (R10-5: pulled out of Basic/Advanced) ---- */
    section('Context & Limits');
    g = grid();
    g.append(seBind('number', 'max_context_window', { label: 'Ctx Window', step: 1 }));
    g.append(seBind('number', 'max_tokens', { label: 'Max Tokens', step: 1 }));
    g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)', step: 1 }));
    g.append(seBind('bool', 'trust_remote_code', { label: 'Trust Remote Code',
        hint: 'Lets the model repo run arbitrary Python at load. Only enable for trusted repos.' }));
}

/* ANE prompt processing (classic modal renders a Qwen variant and, for
   ane_prefill_backend === 'k2', a K2 variant with different labels). */
function renderAne(container, g) {
    const k2 = (seFormModel && seFormModel.ane_prefill_backend) === 'k2';
    g.append(seBind('bool', 'qwen35_ane_prefill_enabled', {
        label: k2 ? 'K2 ANE Prompt Processing' : 'Qwen ANE Prompt Processing',
        hint: k2 ? 'Use ANE for K2 prompt processing, including MoVA. Decode stays on GPU.'
                 : 'Split eligible Qwen 3.5/3.6/3.8 prompt-processing work across both ANEs and the GPU.',
        onChange: renderEditorFields.bind(null, container) }));
    if (!seValues.qwen35_ane_prefill_enabled) return;
    const sbA = (function () { const d = document.createElement('div');
        d.className = 'se-sub'; g.append(d); return d; })();
    sbA.append(seBind('number', 'qwen35_ane_prefill_sequence_length',
        { label: C.tf('uplift.ui.prompt_block', 'Prompt block'), min: 1024, step: 64 }));
    if (!k2) sbA.append(seBind('number', 'qwen35_ane_prefill_tail_padding_min_tokens',
        { label: C.tf('uplift.ui.pad_tails_from', 'Pad tails from'), min: 0, step: 1 }));
    sbA.append(seBind('number', 'qwen35_ane_prefill_fraction',
        { label: C.tf('uplift.ui.mlp_on_ane', 'MLP on ANE'), min: 0, max: 1, step: 0.01 }));
    sbA.append(seBind('number', 'qwen35_ane_prefill_shared_fraction',
        { label: C.tf('uplift.ui.shared_mlp_on_ane', 'Shared MLP on ANE'), min: 0, max: 1, step: 0.01 }));
    if (!k2) {
        sbA.append(seBind('number', 'qwen35_ane_prefill_max_layers',
            { label: C.tf('uplift.ui.mlp_layer_limit', 'MLP layer limit'), min: 1, step: 1 }));
        sbA.append(seBind('bool', 'qwen35_ane_prefill_dual_ane',
            { label: C.tf('uplift.ui.use_both_anes', 'Use both ANEs'), hint: 'Pin one resident program to each physical ANE instance.' }));
    }
    sbA.append(seBind('bool', 'qwen35_ane_prefill_gdn',
        { label: C.tf('uplift.ui.accelerate_gdn', 'Accelerate GDN'), hint: 'Also split eligible GDN input projections across the ANEs and GPU.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_gdn) {
        sbA.append(seBind('number', 'qwen35_ane_prefill_gdn_fraction',
            { label: C.tf('uplift.ui.gdn_on_ane_fraction', 'GDN on ANE (fraction)'), min: 0, max: 1, step: 0.01 }));
        sbA.append(seBind('number', 'qwen35_ane_prefill_gdn_max_layers',
            { label: C.tf('uplift.ui.gdn_layer_limit', 'GDN layer limit'), min: 0, step: 1 }));
    }
    sbA.append(seBind('bool', 'qwen35_ane_prefill_cpu_enabled',
        { label: C.tf('uplift.ui.share_mlp_work_with_cpu', 'Share MLP work with CPU'),
          hint: 'Requires a separate Qwen q4 checkpoint clone with floating tensors converted.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_cpu_enabled) {
        const sbC = (function () { const d = document.createElement('div');
            d.className = 'se-sub'; sbA.append(d); return d; })();
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_fraction',
            { label: C.tf('uplift.ui.mlp_on_cpu_fraction', 'MLP on CPU (fraction)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_down_fraction',
            { label: C.tf('uplift.ui.down_projection_on_cpu_fraction_0_disabled', 'Down projection on CPU (fraction, 0 = disabled)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_gdn_fraction',
            { label: C.tf('uplift.ui.gdn_on_cpu_fraction', 'GDN on CPU (fraction)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_threads',
            { label: C.tf('uplift.ui.cpu_workers_0_automatic', 'CPU workers (0 = automatic)'), min: 0, step: 1 }));
        sbC.append(seBind('bool', 'qwen35_ane_prefill_cpu_shared_resource',
            { label: C.tf('uplift.ui.performance_aware_scheduling', 'Performance-aware scheduling'),
              hint: "Uses Apple's shared-resource scheduler hint and falls back automatically." }));
    }
}

/* chat_template_kwargs editor: value kinds per classic modal */
/* R10-6: renderCtKwargs mutates entry objects; push the list back to the
   active tab's workVals so re-renders (conditional toggles, tab switches)
   show the edits instead of rebuilding from a stale clone. */
function seSyncKwEntries() {
    const t = seTab();
    if (!t) return;
    t.workVals = t.workVals || {};
    t.workVals.ctKwargEntries = seValues.ctKwargEntries;
    // entries are now the single source of truth for this tab
    delete t.workVals.chat_template_kwargs;
    delete t.workVals.forced_ct_kwargs;
}

function renderCtKwargs(container) {   // R10-5: container is the section body
    const S = window.UpliftModelSpec;
    const hint = document.createElement('div');
    hint.className = 'se-hint';
    hint.textContent = C.tf('uplift.ui.parameters_passed_to_chat_template_force_api_req', 'Parameters passed to chat template. Force: API requests cannot override this value.');
    container.append(hint);
    const g = document.createElement('div');
    g.className = 'pair'; container.append(g);
    const entries = seValues.ctKwargEntries || [];
    entries.forEach((e, idx) => {
        if (e.force) {
            const l = document.createElement('label'); l.className = 'se-row';
            const fk = document.createElement('span'); fk.textContent = `${e.key} (forced)`;
            const fv = document.createElement('span'); fv.className = 'stat-sub'; fv.textContent = String(e.value);
            l.append(fk, fv);
            g.append(l); return;
        }
        const row = document.createElement('div');
        row.className = 'se-row se-kwarg';
        const key = document.createElement('input');
        key.type = 'text'; key.value = e.key || ''; key.placeholder = 'key';
        key.addEventListener('input', () => { e.key = key.value; });
        let val;
        if (e.type === 'enable_thinking') {
            val = document.createElement('select');
            ['true', 'false'].forEach(v => { const o = document.createElement('option'); o.value = v; val.append(o); });
            val.value = String(e.value);
            val.addEventListener('change', () => { e.value = val.value; });
        } else if (e.type === 'reasoning_effort') {
            val = document.createElement('select');
            // R10-10: offer the model-reported effort options; fall back to
            // the standard preset list, current value always selectable
            const opts = ((seFormModel || {}).reasoning_effort_options || []).length
                ? [...seFormModel.reasoning_effort_options]
                : ['low', 'medium', 'high', 'xhigh', 'max'];
            if (!e.custom && !opts.includes(e.value)) opts.unshift(e.value);
            opts.concat(['__custom__']).forEach(v => {
                const o = document.createElement('option');
                o.value = v; o.textContent = v === '__custom__' ? 'custom…' : v; val.append(o); });
            val.value = e.custom ? '__custom__' : e.value;
            val.addEventListener('change', () => {
                if (val.value === '__custom__') { e.custom = true; } else { e.custom = false; e.value = val.value; }
                renderEditorFields(container);
            });
            if (e.custom) {
                const cv = document.createElement('input');
                cv.type = 'text'; cv.value = e.customValue || '';
                cv.addEventListener('input', () => { e.customValue = cv.value; });
                row.append(key, val, cv);
            }
        } else {
            val = document.createElement('input');
            val.type = 'text'; val.placeholder = 'value';
            val.value = String(e.value == null ? '' : e.value);
            val.addEventListener('input', () => { e.value = val.value; });
        }
        const rm = document.createElement('button');
        rm.className = 'se-btn'; rm.textContent = '×';
        rm.addEventListener('click', () => {
            seValues.ctKwargEntries.splice(idx, 1);
            renderEditorFields(container);
        });
        if (!row.children.length) row.append(key, val);
        row.append(rm);
        g.append(row);
    });
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'se-hint'; empty.textContent = 'No kwargs configured';
        g.append(empty);
    }
    const add = document.createElement('button');
    add.className = 'se-btn'; add.textContent = '+ Add';
    // R10-10: classic's Add menu — offer typed defaults, not just a blank row
    const addMenu = document.createElement('span');
    addMenu.className = 'se-addmenu'; addMenu.hidden = true;
    const mkItem = (label, make, show) => {
        if (!show) return;
        const it = document.createElement('button');
        it.className = 'se-btn'; it.textContent = label;
        it.onclick = () => {
            seValues.ctKwargEntries.push(make());
            seSyncKwEntries();
            addMenu.hidden = true;
            renderEditorFields(container);
        };
        addMenu.append(it);
    };
    const m = seFormModel || {};
    mkItem('Enable Thinking', () => ({ type: 'enable_thinking', value: 'true', force: false }),
        !S.isDiffusion(m) && !m.thinking_forced
        && !entries.some(e => e.type === 'enable_thinking'));
    mkItem('Reasoning Effort', () => ({ type: 'reasoning_effort',
        value: (m.reasoning_effort_default || 'low'), custom: false, customValue: '', force: false }),
        !S.isDiffusion(m)
        && !entries.some(e => e.type === 'reasoning_effort'
            || (e.type === 'custom' && (e.key || '').trim() === 'reasoning_effort')));
    mkItem('Custom', () => ({ type: 'custom', key: '', value: '', force: false }), true);
    add.addEventListener('click', () => { addMenu.hidden = !addMenu.hidden; });
    g.append(add, addMenu);
    seSyncKwEntries();   // R10-6: keep the edited list live on the tab
}

function editorNode() {
    const panel = document.createElement('div');
    panel.className = 'modal nasa editor';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.textContent = (seFormModel && seFormModel.model_alias ? seFormModel.model_alias + ' \u2192 ' : '') + seModel;
    const tabsRow = document.createElement('div');
    tabsRow.className = 'se-tabs';
    // F-013: profile/template management rows need their own container —
    // seRenderTabs() wipes .se-tabs on every tab switch and used to erase them.
    const profsRow = document.createElement('div');
    profsRow.className = 'se-profs';
    const scroll = document.createElement('div');
    scroll.className = 'editor-scroll';
    const fields = document.createElement('div');
    fields.id = 'se-fields';
    scroll.append(fields);
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    // CHANGES lives to the RIGHT of the form, not below it: when changes are
    // queued the panel widens and the box appears as a side rail
    const bodyRow = document.createElement('div');
    bodyRow.className = 'editor-body';
    const changes = document.createElement('div');
    changes.id = 'se-changes'; changes.className = 'changelist ed'; changes.hidden = true;
    bodyRow.append(scroll, changes);
    const save = document.createElement('button');
    save.className = 'se-btn'; save.textContent = 'Save'; save.id = 'se-save';
    const close = document.createElement('button');
    close.className = 'se-btn'; close.textContent = 'Close'; close.id = 'se-cancel';
    const msg = document.createElement('span');
    msg.className = 'stat-sub'; msg.id = 'se-msg';
    bar.append(save, close, msg);
    panel.append(head, tabsRow, profsRow, bodyRow, bar);
    save.onclick = saveEditor;
    close.onclick = () => closeEditor();
    return panel;
}
/* U2: roomy grammar editing pop-out over the model editor. OK copies the
   text back into the small textarea through its own 'input' event, so the
   bound listener does dirty-marking / override bookkeeping exactly as if
   the user typed it there. Cancel discards the draft. */
function openGrammarPop(srcTa, btn) {
    const existing = document.querySelector('.grammar-pop-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay grammar-pop-overlay';
    overlay.style.zIndex = '90';                 // above the editor modal (70)
    const panel = document.createElement('div');
    panel.className = 'modal nasa grammar-pop';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.textContent = C.tf('uplift.ui.guided_grammar', 'GUIDED GRAMMAR — ') + seModel;
    const ta = document.createElement('textarea');
    ta.value = srcTa.value;
    ta.spellcheck = false;
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    const ok = document.createElement('button');
    ok.className = 'se-btn'; ok.textContent = 'OK';
    const cancel = document.createElement('button');
    cancel.className = 'se-btn'; cancel.textContent = 'Cancel';
    const stat = document.createElement('span'); stat.className = 'stat-sub';
    const count = () => { stat.textContent = ta.value.split('\n').length + ' lines · '
                                   + ta.value.length + ' chars'; };
    ta.addEventListener('input', count); count();
    ok.onclick = () => {
        srcTa.value = ta.value;
        srcTa.dispatchEvent(new Event('input', { bubbles: true }));
        overlay.remove();
    };
    cancel.onclick = () => overlay.remove();
    bar.append(ok, cancel, stat);
    panel.append(head, ta, bar);
    overlay.append(panel);
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });
    document.body.append(overlay);
    ta.focus();
}
function closeEditor() {
    if (seModel) delete profilesCache[seModel];   // tree must show new profiles
    seModel = null; seFormModel = null;
    renderModelAdmin(); // rows were frozen while the editor was open
    document.querySelectorAll('.editor-overlay').forEach(n => n.remove());
    document.querySelectorAll('.row-editor').forEach(n => n.remove());
    document.querySelectorAll('.urow.expanded').forEach(r => r.classList.remove('expanded'));
    const fb = $('model-editor-fallback');
    if (fb) { fb.hidden = true; fb.querySelector('.row-editor')?.remove(); }
}
async function openEditor(model) {
    closeEditor();
    seModel = model;
    await loadGrammarParsers().catch(() => {});   // R10-7: fill the reasoning-parser list (classic does the same)
    let row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
        .find(r => r.dataset.mid === model);
    if (!row) { await renderModelAdmin(true);
        row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
            .find(r => r.dataset.mid === model); }
    let settings = {}, entry = null;
    try {
        const d = await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`);
        settings = d.settings || {};
    } catch (_) { settings = {}; }
    try {
        const list = adminModels.length ? adminModels
            : (await fetchJson(`${API}/admin/api/models`)).models;
        entry = list.find(x => x.id === model) || null;
    } catch (_) { entry = null; }
    seFormModel = entry || { id: model };
    seValues = window.UpliftModelSpec.buildState(seFormModel, settings);
    seOrig = JSON.parse(JSON.stringify(seValues));
    seBaseVals = JSON.parse(JSON.stringify(seValues));
    seTabs = [{ id: 'base', dirty: new Set(), origVals: JSON.parse(JSON.stringify(seOrig)) }];
    seActiveTab = 'base';
    // is_hidden/is_favorite/is_default/pinned are toggled from the models ROW
    // (classic _models.html), never in the settings modal — parity: not here.
    // popup modal, not an inline accordion: stable size for long forms
    const panel = editorNode();
    renderEditorFields(panel.querySelector('#se-fields'));
    seLoadProfiles(model, panel.querySelector('.se-profs')).then(() => seRenderTabs(panel));
    panel._reRender = () => {
        renderEditorFields(panel.querySelector('#se-fields'));
        seRenderTabs(panel);
        seUpdateSaveBtn();
    };
    if (!row) $('se-msg') && ($('se-msg').textContent = `Model ${model} not listed`);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay editor-overlay';
    overlay.append(panel);
    document.body.append(overlay);
    panel.tabIndex = -1;
    panel.focus();
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeEditor();
    });
}

function seRenderTabs(panel) {
    const strip = panel.querySelector('.se-tabs');
    if (!strip) return;
    strip.textContent = '';
    for (const t of seTabs) {
        const b = document.createElement('button');
        b.className = 'se-tab' + (t.id === seActiveTab ? ' active' : '');
        let mark = '';
        const nameChanged = t.id !== 'base' &&
            ((t._origExpose || false) !== !!t.expose_as_model ||
             (t._origApi || '') !== (t.api_name || ''));
        if (t.dirty.size || nameChanged) mark = ' ●';
        const nm = t.id === 'base' ? 'BASE'
            : (t.template ? '◱ ' : '') + (t.display_name || t.name || t.id);
        b.textContent = nm + mark;
        b.title = t.id === 'base' ? 'Model settings (base)'
            : (t.template ? 'Global template (copy, unsaved)' : 'Profile: ' + (t.name || ''));
        b.onclick = () => {
            seCaptureTab();                 // save edits of the tab we leave
            seActiveTab = t.id;
            if (t.id !== 'base') seRestoreTab(t);
            else { seValues = Object.assign({}, t.workVals || seBaseVals);
                   seOrig = t.origVals || seOrig; }
            renderEditorFields(document.getElementById('se-fields'));
            seRenderTabs(panel);
            seUpdateSaveBtn();
        };
        if (t.id !== 'base' && !t.template) {
            const x = document.createElement('span');
            x.className = 'se-tab-x'; x.textContent = '✕'; x.title = 'Close this tab (profile stays on server)';
            x.onclick = (ev) => {
                ev.stopPropagation();
                seTabs = seTabs.filter(z => z.id !== t.id);
                if (seActiveTab === t.id) { seActiveTab = 'base';
                    seValues = JSON.parse(JSON.stringify(seBaseVals));
                    seOrig = JSON.parse(JSON.stringify(seTabs[0].origVals)); }
                renderEditorFields(document.getElementById('se-fields'));
                seRenderTabs(panel); seUpdateSaveBtn();
            };
            b.append(x);
        }
        strip.append(b);
    }
    // New profile: focused input with incremental "Model profile X", values
    // inherited from the tab we were on, dropdown of global templates + models
    const nb = document.createElement('button');
    nb.className = 'se-tab se-new'; nb.textContent = '+ NEW PROFILE';
    nb.onclick = () => seNewProfile(panel);
    strip.append(nb);
    const drop = document.createElement('select');
    drop.className = 'se-tab-drop';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'apply from…';
    drop.append(ph);
    // grouped: bundled GLOBAL PRESETS (qwen3.5/…, gemma4, llama4 …), then
    // user templates, then copy-from-other-model
    const g1 = document.createElement('optgroup'); g1.label = 'Global presets';
    for (const p of (window.__sePresets || [])) {
        const o = document.createElement('option'); o.value = 'pre:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name); g1.append(o);
    }
    if (g1.children.length) drop.append(g1);
    const g2 = document.createElement('optgroup'); g2.label = 'Model profiles (this model)';
    // U4: this model's own stored profiles live HERE now (apply values into
    // the active tab, no tab of their own). seLoadProfiles fills the list
    // async and re-renders the strip once loaded.
    for (const p of (window.__seProfiles || [])) {
        const o = document.createElement('option'); o.value = 'own:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name) + ' (profile)'; g2.append(o);
    }
    for (const t of (window.__seTemplates || [])) {
        const o = document.createElement('option'); o.value = 'tpl:' + t.name;
        o.textContent = '◱ ' + (t.display_name || t.name) + ' (template)'; g2.append(o);
    }
    if (g2.children.length) drop.append(g2);
    const g3 = document.createElement('optgroup'); g3.label = 'Copy settings from model';
    for (const mm of (adminModels || [])) {
        if (mm.id === seModel) continue;
        const o = document.createElement('option'); o.value = 'mdl:' + mm.id;
        o.textContent = '⊕ ' + (mm.display_name || mm.id); g3.append(o);
        // the model's aliases/profiles carry their own settings — copyable too
        for (const ep of (mm.exposed_profiles || [])) {
            const po = document.createElement('option');
            po.value = 'mpr:' + encodeURIComponent(mm.id) + '|' + ep.name;
            po.textContent = '⊕ ' + (mm.display_name || mm.id) + ' ▸ ' + (ep.api_name || ep.name);
            g3.append(po);
        }
    }
    if (g3.children.length) drop.append(g3);
    drop.onchange = () => {
        const v = drop.value; if (!v) return;
        drop.value = '';
        const kind = v.slice(0, 3), id = v.slice(4);
        if (kind === 'own') {
            const p = (window.__seProfiles || []).find(x => x.name === id);
            if (p) seApplyIntoActiveTab(p.settings || {}, p.display_name || p.name);
        } else if (kind === 'mpr') {
            // U4: model profile -> apply values into the ACTIVE tab, no new
            // tab. Settings are already local in adminModels.
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            const mm = (adminModels || []).find(x => x.id === mid);
            const ep = mm && (mm.exposed_profiles || []).find(x => x.name === pname);
            if (ep) seApplyIntoActiveTab(ep.settings || {}, mid + ' ▸ ' + pname);
        } else if (kind === 'pre') {
            const pre = (window.__sePresets || []).find(x => x.name === id);
            if (pre) seApplyIntoActiveTab(pre.settings || {}, pre.display_name || pre.name);
        } else if (kind === 'tpl') {
            const tpl = (window.__seTemplates || []).find(x => x.name === id);
            if (tpl) seApplyIntoActiveTab(tpl.settings || {}, tpl.display_name || tpl.name);
        } else {
            toast(C.t('uplift.toast.loading_settings', {id: id}));
            fetchJson(`${API}/admin/api/models/${encodeURIComponent(id)}/settings`)
                .then(d => seApplyIntoActiveTab(d.settings || {}, id))
                .catch(e => toast('Load failed: ' + e.message));
        }
    };
    strip.append(drop);
}
/* U4: merge a settings blob INTO the active tab as unsaved edits —
   profile tabs receive overrides (empty-able via inherit), the base tab
   receives plain values. Dirty bookkeeping mirrors the widgets' own logic
   so SAVE counts, the CHANGES rail and revert all stay exact. */
function seApplyIntoActiveTab(rawSettings, sourceLabel) {
    const t = seTab();
    const st = window.UpliftModelSpec.buildState(seFormModel || { id: seModel },
        JSON.parse(JSON.stringify(rawSettings || {})));
    const base = seIsBaseTab() ? seOrig : (t.id !== 'base' ? t.origVals : seOrig);
    const ovSnap = !seIsBaseTab() && SE_INHERIT_KEYS.size ? seOvSnap(t) : null;
    let n = 0;
    for (const [k, v] of Object.entries(st)) {
        if (k === 'ctKwargEntries' || k === 'model_alias' || v === undefined) continue;
        const origV = (t.id !== 'base' && SE_INHERIT_KEYS.has(k)) ? ovSnap[k] : base[k];
        const changed = JSON.stringify(origV) !== JSON.stringify(v);
        if (changed) { t.dirty.add(k); n++; } else t.dirty.delete(k);
        if (t.id !== 'base') {
            // inheritable key applied with the base value == inherit (drop override)
            const inheritVal = seBaseVals ? seBaseVals[k] : undefined;
            if (SE_INHERIT_KEYS.has(k) && JSON.stringify(v) === JSON.stringify(inheritVal)) {
                delete t.overrides[k];
                continue;
            }
            t.overrides[k] = v;
        }
    }
    // chat-template kwargs ride the entries list; replace it wholesale when
    // the source defines any (classic apply is a full-merge too)
    if (st.ctKwargEntries && st.ctKwargEntries.length) {
        seValues.ctKwargEntries = st.ctKwargEntries;
        if (t.id !== 'base') t.overrides.ctKwargEntries = st.ctKwargEntries;
        if (!t._origKwargs) t._origKwargs = JSON.parse(JSON.stringify(seValues.ctKwargEntries));
    }
    Object.assign(seValues, st, { ctKwargEntries: seValues.ctKwargEntries });
    seNormalizeKwargs(seValues);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(document.querySelector('.modal.editor'));
    seUpdateSaveBtn();
    toast(n ? C.t('uplift.toast.applied_review', {source: sourceLabel, target: seIsBaseTab() ? 'BASE' : (t.display_name || t.name), n: n})
            : `${sourceLabel}: nothing to change on this tab`);
}
function seCaptureTab() {
    // pull live widget values into the active tab before switching
    const t = seTab(); if (!t) return;
    if (t.id === 'base') { t.workVals = Object.assign({}, seValues); return; }
    t.workVals = Object.assign({}, seValues);
    for (const k of Object.keys(seValues)) {
        if (seValues[k] === undefined) delete t.workVals[k];
    }
    // overrides = keys whose value differs from base. R10-6: ctKwargEntries
    // and model_alias are UI/internal fields, never real profile settings —
    // persisting them corrupts the kwargs editor after a tab switch.
    const ov = {};
    for (const [k, v] of Object.entries(t.workVals)) {
        if (k === 'ctKwargEntries' || k === 'model_alias') continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    // keep overrides that were captured but reverted-to-inherit out
    for (const k of Object.keys(t.overrides)) if (!(k in ov)) delete t.overrides[k];
    t.overrides = Object.assign({}, t.overrides, ov);
    seNormalizeKwargs(t.overrides);
}
function seNormalizeKwargs(vals) {
    // R10-6: raw settings payloads (profiles/templates) carry
    // chat_template_kwargs + forced_ct_kwargs; the editor works on the
    // modelspec ctKwargEntries shape. Convert so kwargs render editable;
    // when entries already exist, drop the raw twins so a save can't write
    // a stale chat_template_kwargs alongside the edited entries.
    if (!vals) return;
    const hasRaw = vals.chat_template_kwargs || vals.forced_ct_kwargs;
    if (vals.ctKwargEntries && vals.ctKwargEntries.length && !hasRaw) return;
    if (!hasRaw) return;
    // raw kwargs present: they win over entries built from base;
    // base entries for keys the raw payload doesn't mention are kept.
    // (After the first kwargs render, seSyncKwEntries has removed the raw
    // twins from workVals, so re-renders keep the user's edited entries.)
    const raw = vals.chat_template_kwargs || {};
    const rebuilt = window.UpliftModelSpec.buildCtKwargEntries(raw, vals.forced_ct_kwargs, false);
    const keep = (vals.ctKwargEntries || []).filter(e => !(e.key in raw));
    vals.ctKwargEntries = rebuilt.concat(keep);
    delete vals.chat_template_kwargs;
    delete vals.forced_ct_kwargs;
}
function seRestoreTab(t) {
    seValues = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(t.workVals || t.overrides || {})));
    seNormalizeKwargs(seValues);
}
function seNextAutoName() {
    let i = 1;
    const used = new Set(seTabs.filter(t => t.name).map(t => (t.name || '').toLowerCase()));
    while (used.has('model-profile-' + i)) i++;
    // Must satisfy server validate_profile_name ^[a-z0-9][a-z0-9_-]{0,31}$ —
    // "Model profile 1" (space + caps) was rejected on save.
    return 'model-profile-' + i;
}
function seAddTab(t) {
    seTabs.push(t); seCaptureTab();          // capture previous tab first
    seActiveTab = t.id;
    return t;
}
function seNewProfile(panel) {
    seCaptureTab();
    const from = seValues;                   // inherited from current tab
    const name = seNextAutoName();
    const ov = {};
    if (seActiveTab !== 'base') {
        const src = seTab();
        Object.assign(ov, JSON.parse(JSON.stringify(src.overrides || {})));
    }
    const t = { id: 'new' + Date.now(), name, display_name: name,
        expose_as_model: false, api_name: '', overrides: ov,
        workVals: JSON.parse(JSON.stringify(from)),
        origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
        dirty: new Set(), _new: true, _origExpose: false, _origApi: '' };
    seInitSnap(t);
    seTabs.push(t);
    seActiveTab = t.id;
    seRestoreTab(t);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(panel); seUpdateSaveBtn();
    // focus the name input for incremental rename
    const inp = panel.querySelector('.se-newname');
    if (inp) { inp.focus(); inp.select(); }
}
function seOpenTemplateTab(panel, tpl) {
    seCaptureTab();
    const t = { id: 'tpl' + Date.now(), name: tpl.name, display_name: tpl.display_name || tpl.name,
        template: tpl.name, expose_as_model: false, api_name: '',
        overrides: JSON.parse(JSON.stringify(tpl.settings || {})),
        workVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(tpl.settings || {}))),
        origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(tpl.settings || {}))),
        dirty: new Set(), _origExpose: false, _origApi: '' };
    seInitSnap(t);
    seTabs.push(t); seActiveTab = t.id; seRestoreTab(t);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(panel); seUpdateSaveBtn();
}
function seOpenModelCopyTab(panel, modelId, settings) {
    seCaptureTab();
    const st = window.UpliftModelSpec.buildState({ id: modelId }, settings);
    const ov = {};
    for (const [k, v] of Object.entries(st)) {
        if (k === 'ctKwargEntries') continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    const short = modelId.split('/').pop();
    const t = { id: 'mdl' + Date.now(), name: 'from-' + short, display_name: 'Copy of ' + short,
        expose_as_model: false, api_name: '', overrides: ov, workVals: st,
        origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
        dirty: new Set(), _origExpose: false, _origApi: '' };
    seInitSnap(t);
    seTabs.push(t); seActiveTab = t.id; seRestoreTab(t);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(panel); seUpdateSaveBtn();
}

/* ---- per-model profiles (sidebar of the classic editor) ----
   U4 (user round): selecting a profile must NOT open a tab (the classic
   quirk duplicated tabs and looked like "create new profile"). Profiles
   live in the editor's 'apply from…' dropdown and apply their values into
   the ACTIVE tab as unsaved edits; a new profile is created only through
   '+ NEW PROFILE'. This host keeps management rows only (delete / save
   current as). */
async function seLoadProfiles(model, host) {
    let profs = [];
    try { profs = (await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles`)).profiles || []; } catch (_) {}
    host.textContent = '';
    window.__seProfiles = profs;
    const oldPt = null;
    const row = document.createElement('div');
    row.className = 'se-prof-row';
    const sel = document.createElement('select');
    const none = document.createElement('option'); none.value = ''; none.textContent = 'profiles…';
    sel.append(none, ...profs.map(p => { const o = document.createElement('option');
        o.value = p.name; o.textContent = p.display_name || p.name; return o; }));
    // U4: no Apply button here — applying values lives in the 'apply from…'
    // dropdown (client-side, into the active tab). This row manages profiles.
    const delB = document.createElement('button'); delB.className = 'se-btn'; delB.textContent = 'Delete';
    const saveAs = document.createElement('input');
    saveAs.type = 'text'; saveAs.placeholder = 'save current as…'; saveAs.className = 'se-prof-name';
    const saveB = document.createElement('button'); saveB.className = 'se-btn'; saveB.textContent = 'Save';
    const write = async (path, opts) => {          // detail-aware JSON call
        const res = await fetch(path, Object.assign({ cache: 'no-store' }, opts));
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(C.errorText(body) || String(res.status));
        return body;
    };
    delB.onclick = async () => {
        if (!sel.value) return;
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(sel.value)}`,
                { method: 'DELETE' });
            toast(C.t('uplift.toast.deleted_profile', {name: sel.value}));
            seLoadProfiles(model, host);
        } catch (e) { toast(C.t('uplift.toast.delete_failed', {msg: e.message})); }
    };
    saveB.onclick = async () => {
        const name = saveAs.value.trim();
        if (!name) { toast(C.t('uplift.toast.profile_name_required')); return; }
        const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, settings: payload }) });
            toast(C.t('uplift.toast.saved_profile', {name: name}));
            seLoadProfiles(model, host);
        } catch (e) { toast(C.t('uplift.toast.profile_error', {msg: e.message})); }
    };
    row.append(sel, delB, saveAs, saveB);
    host.append(row);
    // keep the 'apply from…' strip in sync: own-profile options were just
    // (re)loaded or changed
    const stripPanel = document.querySelector('.modal.editor');
    if (stripPanel) seRenderTabs(stripPanel);
    // Global templates (global_templates.json): apply or snapshot into a template.
    let tpls = [];
    try { tpls = (await fetchJson(`${API}/admin/api/profile-templates`)).templates || []; } catch (_) {}
    window.__seTemplates = tpls;
    // Bundled global presets (same source as the classic editor's preset
    // menu: /admin/static/omlx_preset.json), cached 1 day like classic does.
    if (!window.__sePresets) {
        try {
            const cached = JSON.parse(localStorage.getItem('omlx_preset_cache') || 'null');
            if (cached && cached.presets) window.__sePresets = cached.presets;
            else {
                const d = await fetchJson(`${API}/admin/static/omlx_preset.json`);
                window.__sePresets = d.presets || [];
                localStorage.setItem('omlx_preset_cache', JSON.stringify(d));
            }
        } catch (_) { window.__sePresets = []; }
    }
    if (tpls.length || true) {
        const trow = document.createElement('div');
        trow.className = 'se-prof-row';
        const tsel = document.createElement('select');
        const tnone = document.createElement('option'); tnone.value = ''; tnone.textContent = 'templates…';
        tsel.append(tnone, ...tpls.map(t => { const o = document.createElement('option');
            o.value = t.name; o.textContent = t.display_name || t.name; return o; }));
        const tApply = document.createElement('button'); tApply.className = 'se-btn'; tApply.textContent = 'Apply';
        const tSnap = document.createElement('button'); tSnap.className = 'se-btn'; tSnap.textContent = 'Snapshot as';
        const uniFields = async () => {
            try { return (await fetchJson(`${API}/admin/api/profile-fields`)).universal || []; } catch (_) { return []; }
        };
        tApply.onclick = async () => {
            if (!tsel.value) return;
            try {
                // Classic applyTemplateToForm: template is source of truth —
                // upsert the model profile from it, then apply the profile.
                const tpl = tpls.find(t => t.name === tsel.value) || {};
                const prof = `${API}/admin/api/models/${encodeURIComponent(model)}/profiles`;
                let pname = tpl.name;
                await write(prof, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: pname, display_name: tpl.display_name || tpl.name,
                                           description: tpl.description || null,
                                           settings: tpl.settings || {}, source_template: tpl.name }) });
                await write(`${prof}/${encodeURIComponent(pname)}/apply`, { method: 'POST' });
                toast(C.t('uplift.toast.applied_template', {name: pname}));
                openEditor(model);
            } catch (e) { toast(C.t('uplift.toast.template_apply_failed', {msg: e.message})); }
        };
        tSnap.onclick = async () => {
            const typed = saveAs.value.trim() || tsel.value;
            if (!typed) { toast(C.t('uplift.toast.type_save_name_first')); return; }
            // Classic contract (dashboard.js createTemplate): `name` is the
            // machine slug, `display_name` the human text — POST 422s without
            // display_name (F-019). Slug must match ^[a-z0-9][a-z0-9_-]{0,31}$.
            const slug = typed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
            const name = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug)
                ? slug : 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
            const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
            const uni = new Set(await uniFields());
            const settings = {};
            for (const [k, v] of Object.entries(full)) if (uni.has(k)) settings[k] = v;
            try {
                await write(`${API}/admin/api/profile-templates`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name, display_name: typed, description: null, settings }) });
                toast(C.t('uplift.toast.saved_template', {name: typed}));
                seLoadProfiles(model, host);
            } catch (e) { toast(C.t('uplift.toast.template_error', {msg: e.message})); }
        };
        const tt = document.createElement('div');
        tt.className = 'se-hint'; tt.textContent = 'Templates (global)';
        host.append(tt);
        trow.append(tsel, tApply, tSnap);
        host.append(trow);
    }
}

async function saveEditor() {
    if (!seModel) return;
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    seCaptureTab();
    if (!seIsBaseTab()) return saveProfileTab(panel);
    const msg = panel.querySelector('#se-msg');
    const errors = window.UpliftModelSpec.validate(seValues);
    if (errors.length) {
        msg.textContent = errors[0];
        toast(errors[0]);
        return;
    }
    const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    // boolean management flags ride the same PUT (real API accepts them too)
    if ('is_hidden' in seValues) payload.is_hidden = !!seValues.is_hidden;
    if ('is_favorite' in seValues) payload.is_favorite = !!seValues.is_favorite;
    msg.textContent = 'saving…';
    try {
        const r = await putModelSettings(seModel, payload);
        const savedNote = r._shadow ? 'saved ✓ (shadow)' : 'saved ✓';
        const note = r.requires_reload ? 'saved ✓ reload required' : savedNote;
        msg.textContent = note;
        toast(C.t('uplift.toast.settings_saved_model', {model: seModel}));
        if (r.requires_reload) {
            // same flow as Server Settings: SAVE becomes the reload action
            seOrig = JSON.parse(JSON.stringify(seValues));
            if (seFormModel) seFormModel.loaded = true;
            const b = document.getElementById('se-save');
            if (b) { b.classList.add('restart-mode'); b.classList.remove('queued');
                     b.textContent = '▶ RESTART MODEL';
                     b.onclick = async () => {
                        b.disabled = true;
                        // The server auto-unloads on save of a reload-key
                        // field, so the unload here usually 400s ("Model
                        // not loaded"). That is expected — tolerate it and
                        // go straight to load; only a failed LOAD is fatal.
                        try { await postModelAction(seModel, 'unload'); }
                        catch (_) { /* already unloaded by the server */ }
                        try { await postModelAction(seModel, 'load');
                              toast(C.t('uplift.toast.reloaded_with_settings', {model: seModel}));
                              closeEditor(); }
                        catch (e) { toast(C.t('uplift.toast.reload_failed', {msg: e.message})); b.disabled = false; }
                     }; }
            return;   // keep the popup open so RESTART MODEL stays visible
        }
        setTimeout(closeEditor, 1200);
    } catch (err) {
        msg.textContent = `error: ${err.message}`;
        toast(C.t('uplift.toast.save_failed', {msg: err.message}));
    }
}
async function saveProfileTab(panel) {
    const msg = panel.querySelector('#se-msg');
    const t = seTab();
    const name = (t.name || '').trim();
    if (!name) { toast(C.t('uplift.toast.profile_name_required')); return; }
    // full modelspec-shaped settings + inheritable validation via base merge
    const mergedForValidate = Object.assign({}, seBaseVals,
        JSON.parse(JSON.stringify(t.workVals || {})));
    seNormalizeKwargs(mergedForValidate);   // R10-6
    const errors = window.UpliftModelSpec.validate(mergedForValidate);
    if (errors.length) { msg.textContent = errors[0]; toast(errors[0]); return; }
    // R10-6: convert the tab's edited kwargs entries back to the raw
    // settings shape so the inheritance diff below can persist them
    if (t.workVals && t.workVals.ctKwargEntries) {
        const kw = window.UpliftModelSpec.buildPayload(t.workVals, seFormModel);
        t.workVals.chat_template_kwargs = kw.chat_template_kwargs;
        t.workVals.forced_ct_kwargs = kw.forced_ct_kwargs;
    }
    // only keys that differ from base persist (inheritance semantics)
    const ov = {};
    for (const [k, v] of Object.entries(t.workVals || {})) {
        if (k === 'ctKwargEntries' || k === 'model_alias') continue;
        if (v === undefined) continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    msg.textContent = 'saving profile…';
    const body = { name, display_name: t.display_name || name, settings: ov,
        expose_as_model: !!t.expose_as_model, api_name: t.api_name || null };
    try {
        const path = `${API}/admin/api/models/${encodeURIComponent(seModel)}/profiles` +
            (t.profileId ? '/' + encodeURIComponent(t.profileId) : '');
        const r = await fetch(path, { method: t.profileId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t.profileId
                ? { settings: ov, display_name: t.display_name || name,
                    expose_as_model: !!t.expose_as_model, api_name: t.api_name || null }
                : body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.detail || d.error || String(r.status));
        toast(C.t('uplift.toast.saved_profile', {name: name}));
        t.profileId = name; t.dirty = new Set();
        t._origExpose = !!t.expose_as_model; t._origApi = t.api_name || '';
        t.name = name; t.display_name = name;
        t.origVals = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(t.workVals || {})));
        t._ovSnap = JSON.parse(JSON.stringify(ov));   // saved overrides are the new original
        msg.textContent = 'saved ✓';
        seRenderTabs(panel); seUpdateSaveBtn();
    } catch (e) {
        msg.textContent = 'error: ' + e.message;
        toast(C.t('uplift.toast.profile_save_failed', {msg: e.message}));
    }
}

let adminModels = [];
let pendingWrites = 0;   // in-flight settings/action writes; ticks must not paint stale state
/* The gateway's model snapshot refreshes on a poll (10 s live mode), so a
   successful flag write can briefly paint back the OLD value ("pin does not
   react"). Remember what we just wrote and overlay it until the fetched
   model agrees, then the override expires on its own. */
const flagOverrides = {};
function flagSet(mid, patch) {
    flagOverrides[mid] = Object.assign(flagOverrides[mid] || {}, patch);
}
async function flagWrite(mid, patch, write) {
    flagSet(mid, patch);
    try { await write(); }
    catch (e) { if (flagOverrides[mid]) for (const k of Object.keys(patch)) delete flagOverrides[mid][k]; throw e; }
}
async function trackWrite(fn) {
    pendingWrites++;
    try { return await fn(); } finally { pendingWrites--; }
}
/* ---------------- model manager table (sorting, filters, row chips) ------ */
let sortKey = (prefs.tableSort && prefs.tableSort.key) || 'name';
let sortDir = (prefs.tableSort && prefs.tableSort.dir) || 1;      // 1 asc, -1 desc

function saveTableSort() {
    prefs.tableSort = { key: sortKey, dir: sortDir };
    localStorage.setItem('omlx-uplift-prefs-v1', JSON.stringify(prefs));
}

function stateRank(m) { return m.loaded ? 0 : (m.is_loading ? 1 : 2); }
function sortModels(rows) {
    // Match classic dashboard.js semantics (F-027/F-028): favorites pin
    // first regardless of column/direction; name keys are lowercased so
    // 'bge' and 'Ternary' interleave the way the column reads.
    const key = (a, b) => a.id.localeCompare(b.id);
    // uplift ids ARE the leaf names (display_name carries the owner/
    // prefix); the column shows the leaf, so lowerCase the id.
    const lo = m => (m.id || '').toLowerCase();
    const nameCmp = (a, b) => {
        const x = lo(a), y = lo(b);
        return x < y ? -1 : x > y ? 1 : key(a, b);
    };
    const cmp = {
        name: nameCmp,
        type: (a, b) => (a.model_type || '').toLowerCase().localeCompare((b.model_type || '').toLowerCase()) || nameCmp(a, b),
        state: (a, b) => stateRank(a) - stateRank(b) || nameCmp(a, b),
        size: (a, b) => ((a.actual_size || a.estimated_size || 0) - (b.actual_size || b.estimated_size || 0)),
    }[sortKey] || nameCmp;
    const favFirst = (a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
    return rows.sort((a, b) => favFirst(a, b) || (cmp(a, b) || 0) * sortDir || key(a, b));
}

async function renderModelAdmin(force) {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (_) { $('model-admin').innerHTML = '<div class="empty">API unreachable</div>'; return; }
    adminModels = models;
    // expire/apply optimistic flag overrides against the fresh snapshot
    for (const m of models) {
        const ov = flagOverrides[m.id];
        if (!ov) continue;
        for (const [k, v] of Object.entries(ov)) {
            if (m[k] === v) delete ov[k]; else m[k] = v;
        }
        if (!Object.keys(ov).length) delete flagOverrides[m.id];
    }
    // editor open OR a write in flight: don't paint a possibly stale snapshot
    if ((seModel || pendingWrites) && !force) return;
    const filter = ($('ma-filter').value || '').toLowerCase().trim();
    const typeSel = $('ma-type');
    const type = typeSel.value || '';
    const onlyLoaded = $('ma-only-loaded').checked;
    const presentOnly = $('ma-present-only').checked;
    let shown = models.filter(m =>
        (!filter || m.id.toLowerCase().includes(filter) ||
         (m.display_name || '').toLowerCase().includes(filter) ||
         (m.settings && m.settings.model_alias || '').toLowerCase().includes(filter)) &&
        (!type || (m.model_type || '') === type) &&
        (!onlyLoaded || m.loaded || m.is_loading));
    shown = sortModels(shown);
    // settings store drives the Missing section below the present rows
    const onManager = document.documentElement.dataset.tab === 'models'
        && document.documentElement.dataset.sub === 'manager'
        && !!$('ma-present-only');
    let idx = { stored: adminModels.__idx ? adminModels.__idx.stored : 0, orphans: [], entries: [] };
    if (onManager) { try { idx = await fetchJson(`${API}/admin/api/model-settings-index`); } catch (_) {} }
    adminModels.__idx = idx;
    const orphan = new Set(idx.orphans || []);
    const knownIds = new Set(models.map(m => m.id));
    const missingAll = (idx.entries || []).filter(e => !knownIds.has(e.id));
    let missing = missingAll.filter(e => !filter || e.id.toLowerCase().includes(filter) ||
        (e.alias || '').toLowerCase().includes(filter));
    if (presentOnly) missing = [];
    const loadedN = models.filter(m => m.loaded).length;
    if (onManager) renderTemplatesBox();
    // stored/missing never follow the filters; shown counts every visible row
    $('models-admin-sub').textContent = `${loadedN}/${models.length} loaded \u00b7 `
        + `${idx.stored} stored \u00b7 ${missingAll.length} missing \u00b7 `
        + `${shown.length + missing.length} shown`;
    const memUsed = stats ? stats.memUsed : null;
    $('ma-mem').textContent = memUsed !== null
        ? `memory ${C.fmtBytes(memUsed)} / ${C.fmtBytes(stats.memMax)}` : '';
    if (typeSel.dataset.built !== '1') {
        const types = [...new Set(models.map(m => m.model_type).filter(Boolean))].sort();
        for (const t of types) {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            typeSel.append(o);
        }
        typeSel.dataset.built = '1';
    }

    const table = $('model-admin');
    table.innerHTML = '';
    if (!shown.length && !missing.length) {
        table.innerHTML = '<div class="empty">No match</div>'; return; }
    const head = document.createElement('div'); head.className = 'urow head admin';
    for (const [label, key] of [['model', 'name'], ['type', 'type'], ['state', 'state'],
                                 ['size', 'size'], ['', null]]) {
        const c = cell(label + (sortKey === key ? (sortDir === 1 ? ' \u25b2' : ' \u25bc') : ''));
        if (key) {
            c.classList.add('sortable');
            c.onclick = () => {
                if (sortKey === key) sortDir = -sortDir;
                else { sortKey = key; sortDir = key === 'size' ? -1 : 1; }
                saveTableSort();
                renderModelAdmin(true);
            };
        }
        head.append(c);
    }
    table.append(head);
    for (const m of shown) {
        const mbox = document.createElement('div'); mbox.className = 'mbox';
        const row = document.createElement('div'); row.className = 'urow admin';
        row.dataset.mid = m.id;
        const name = document.createElement('span');
        name.className = 'uname'; name.title = m.model_path || m.id;
        const nmain = document.createElement('span'); nmain.className = 'nmain';
        const fav = document.createElement('button');
        fav.className = 'lamp favlamp' + (m.is_favorite ? ' on' : '');
        fav.textContent = 'FAVOURITE'; fav.title = m.is_favorite ? 'Unfavorite' : 'Favorite';
        tapBtn(fav, () => flagWrite(m.id, { is_favorite: !m.is_favorite },
            () => putModelSettings(m.id, { is_favorite: !m.is_favorite })));
        const uid = cell(m.id); uid.className = 'uid';
        nmain.append(fav, uid, copyBtn(m.id, 'Copy model id'));
        name.append(nmain);
        // PINNED / DEFAULT cockpit lamp stack: every row shows both lamps
        const lamps = document.createElement('span'); lamps.className = 'lampstack';
        const lamp = (label, lit, title, fn) => {
            const b = document.createElement('button');
            b.className = 'lamp' + (lit ? ' on' : '');
            b.textContent = label; b.title = title;
            tapBtn(b, fn);
            return b;
        };
        lamps.append(
            lamp('PINNED', !!m.pinned, m.pinned ? 'Unpin (allow unload)' : 'Keep loaded (pin)',
                // R10-B1: classic-compat write path — is_pinned via PUT
                // settings (the pin/unpin POSTs were mock-only sugar)
                () => flagWrite(m.id, { pinned: !m.pinned },
                    () => putModelSettings(m.id, { is_pinned: !m.pinned }))),
            lamp('DEFAULT', !!m.is_default,
                m.is_default ? 'Clear default model' : 'Make default model',
                () => {
                    if (!m.is_default) for (const o of adminModels)
                        if (o.id !== m.id && o.is_default) flagSet(o.id, { is_default: false });
                    return flagWrite(m.id, { is_default: !m.is_default },
                        () => putModelSettings(m.id, { is_default: !m.is_default }));
                }));
        const typeC = cell(m.model_type || '\u2014'); typeC.className = 'dim';
        // State: LOADED/IDLE rocker switch + API-name copy button. Clicking
        // the inactive half runs the transition (LOADED loads, IDLE unloads).
        const state = document.createElement('span');
        state.className = 'statewrap';
        const sw = document.createElement('span'); sw.className = 'lsw';
        if (m.is_loading) {
            const seg = document.createElement('span');
            seg.className = 'lsw-seg load'; seg.textContent = 'LOADING';
            sw.append(seg);
        } else {
            const lo = document.createElement('button');
            lo.className = 'lsw-seg' + (m.loaded ? ' on' : '');
            lo.textContent = 'LOADED';
            lo.title = m.loaded ? 'Model is loaded' : 'Load this model';
            lo.disabled = !!m.loaded;
            if (!m.loaded) tapBtn(lo, () => postModelAction(m.id, 'load'));
            const idl = document.createElement('button');
            idl.className = 'lsw-seg' + (m.loaded ? ' lit' : '');
            idl.textContent = 'IDLE';
            idl.title = m.loaded ? 'Unload this model' : 'Model is idle';
            idl.disabled = !m.loaded;
            if (m.loaded) tapBtn(idl, () => postModelAction(m.id, 'unload'));
            sw.append(lo, idl);
        }
        state.append(sw);
        const size = cell(m.loaded ? (m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size))
                        : C.fmtBytes(m.estimated_size));
        size.className = 'usize';
        // right group: settings chips + actions, separate shaded box
        const box = document.createElement('span');
        box.className = 'settings-box';
        const s = m.settings || {};
        // R10-13: fixed chip set. SET values render with their value;
        // toggles render ON/OFF; unset keys show a dimmed label + em dash
        // (inherited from server defaults). TRUST REMOTE CODE is red when on.
        const bits = [];
        const val = (label, v) => bits.push([v === null || v === undefined
            ? label + ' —' : label + ' ' + v,
            v === null || v === undefined ? 'dim' : '']);
        const tog = (label, on) => bits.push([label + (on ? ' ON' : ' OFF'), on ? 'on' : 'dim']);
        val('CTX', s.max_context_window);
        val('MAX', s.max_tokens);
        tog('THINK', !!s.enable_thinking);
        tog('MTP', !!(s.mtp_enabled || s.vlm_mtp_enabled));
        tog('GRAMMAR', !!s.guided_grammar_enabled);
        bits.push(['TRC ' + (s.trust_remote_code ? 'ON' : 'OFF'),
            s.trust_remote_code ? 'danger' : 'dim']);
        tog('SPECPREFILL', !!s.specprefill_enabled);
        tog('DFLASH', !!s.dflash_enabled);
        if (m.is_hidden) bits.push(['HIDDEN', '']);
        for (const [txt, cls] of bits) {
            const chip = document.createElement('span');
            chip.className = 'schip ' + cls; chip.textContent = txt;
            box.append(chip);
        }
        const actions = document.createElement('span');
        actions.className = 'rowacts';
        const btn = (label, fn, title, noRerender) => {
            const b = document.createElement('button');
            b.className = 'se-btn act';
            if (label.indexOf('DELETE') === 0) b.classList.add('danger');
            b.textContent = label; b.title = title || label;
            b.onclick = async () => {
                b.disabled = true;    // no double-toggle while the write is in flight
                try { await fn(); } catch (err) {
                    console.error(`${label} failed:`, err);   // stack in devtools
                    toast(C.t('uplift.toast.action_failed', {action: label, msg: err.message})); b.disabled = false; return; }
                if (!noRerender) renderModelAdmin(true); else b.disabled = false;
            };
            return b;
        };
        actions.append(btn(m.is_hidden ? 'SHOW' : 'HIDE',
            () => flagWrite(m.id, { is_hidden: !m.is_hidden },
                () => putModelSettings(m.id, { is_hidden: !m.is_hidden })),
            m.is_hidden ? 'Unhide' : 'Hide from pickers'));
        actions.append(btn('EDIT', () => openEditor(m.id), 'Edit settings', true));
        actions.append(btn('DELETE SETTINGS', () => confirmDialog('Delete settings',
            `Remove the stored configuration of ${m.id}? The model stays on disk; its `
            + 'settings return to server defaults when saved again. This cannot be undone.',
            () => deleteStoredSettings(m.id), `Settings deleted: ${m.id}`),
            'Delete stored settings (model stays on disk)', true));
        actions.append(btn('DELETE MODEL', () => confirmDialog('Delete model',
            `Delete ${m.id} from disk? A loaded instance is unloaded first, then the `
            + 'model directory and its stored settings are removed. This cannot be undone.',
            () => deleteModelFromDisk(m.id), `Deleted ${m.id}`), 'Delete model from disk'));
        box.append(lamps, actions);
        row.append(name, typeC, state, size, box);
        mbox.append(row);
        const tree = aliasTree(m);       // aliases hang off the trunk below
        if (tree) mbox.append(tree);
        table.append(mbox);
    }
    if (missing.length) {
        const sep = cell('Missing \u2014 stored settings, model not on disk');
        sep.className = 'sec-div';
        table.append(sep);
        for (const e of missing) {
            const mbox = document.createElement('div'); mbox.className = 'mbox missing';
            const row = document.createElement('div'); row.className = 'urow admin';
            const name = document.createElement('span'); name.className = 'uname';
            const nmain = document.createElement('span'); nmain.className = 'nmain';
            const uid = cell(e.id); uid.className = 'uid';
            nmain.append(uid, copyBtn(e.id, 'Copy model id'));
            name.append(nmain);
            const st = cell(orphan.has(e.id) ? 'MISSING' : 'EXTERNAL');
            if (orphan.has(e.id)) st.className = 'spill miss';   // caution amber
            else st.className = 'dim';
            const box = document.createElement('span'); box.className = 'settings-box';
            const acts = document.createElement('span'); acts.className = 'rowacts';
            const ds = document.createElement('button');
            ds.className = 'se-btn act danger'; ds.textContent = 'DELETE SETTINGS';
            ds.title = C.tf('uplift.ui.delete_stored_settings_for_this_missing_model', 'Delete stored settings for this missing model');
            ds.onclick = () => confirmDialog('Delete settings',
                `Remove stored configuration for ${e.id}? The model is not on disk; `
                + 'its settings record is deleted. This cannot be undone.',
                async () => { await deleteStoredSettings(e.id); },
                `Deleted settings for ${e.id}`);
            const dm = document.createElement('button');
            dm.className = 'se-btn act danger'; dm.textContent = 'DELETE MODEL';
            dm.disabled = true;
            dm.title = 'Nothing on disk to delete \u2014 only the settings record exists';
            acts.append(ds, dm);
            box.append(acts);
            row.append(name, cell('\u2014'), st, cell('\u2014'), box);
            mbox.append(row);
            if (e.alias) {
                const tree = document.createElement('div'); tree.className = 'alias-tree';
                const al = document.createElement('div'); al.className = 'alias-line';
                const mk = cell(e.alias); mk.className = 'alias-name';
                al.append(mk, copyBtn(e.alias, 'Copy alias "' + e.alias + '"'));
                tree.append(al); mbox.append(tree);
            }
            table.append(mbox);
        }
    }
}

/* shared informed-confirmation modal; runs act() on confirm, then refreshes */
function confirmDialog(title, msg, act, okMsg) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3'); h.textContent = title;
    const sub = document.createElement('div'); sub.className = 'se-hint';
    sub.textContent = msg;
    const bar = document.createElement('div'); bar.className = 'row buttons';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    const ok = document.createElement('button');
    ok.className = 'danger'; ok.textContent = 'Confirm';
    ok.onclick = async () => {
        ok.disabled = true; cancel.disabled = true;
        try {
            await act(); toast(okMsg || title); overlay.remove();
            if (seModel) closeEditor();
            renderModelAdmin(true);
        }
        catch (err) { ok.disabled = false; cancel.disabled = false; toast(C.t('uplift.toast.failed', {msg: err.message})); }
    };
    bar.append(document.createElement('span'), cancel, ok);
    box.append(h, sub, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.append(overlay);
    ok.focus();
}

/* Cockpit row controls: lamp/rocker tap handler, clipboard fallback, alias
   tree lines, DELETE cover. "Reset settings" is gone — DELETE > SETTINGS
   (drops the record; behaviour returns to server defaults) covers it. */
function tapBtn(b, fn, noRerender) {
    b.onclick = async () => {
        b.disabled = true;    // no double-toggle while the write is in flight
        try { await fn(); } catch (err) {
            toast(C.t('uplift.toast.action_failed', {action: b.textContent || 'action', msg: err.message}));
            b.disabled = false; return;
        }
        if (!noRerender) renderModelAdmin(true); else b.disabled = false;
    };
}
function copyText(t) {   // plain-http LAN origins lack navigator.clipboard
    if (navigator.clipboard && window.isSecureContext)
        return navigator.clipboard.writeText(t);
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
}
/* Properties of an alias/exposed profile that diverge from the model's own
   settings — rendered as indicator chips next to the alias tree line. */
/* cached per-model profile lists for the row alias tree (30 s TTL; editor
   writes invalidate immediately) */
const profilesCache = {};
function aliasDiffChips(prof, base) {
    const SHORT = { temperature: 'TEMP', top_p: 'TOP_P', top_k: 'TOP_K',
        max_tokens: 'MAX', max_context_window: 'CTX', enable_thinking: 'THINK',
        reasoning_effort: 'R', mtp_enabled: 'MTP', dflash_enabled: 'DFLASH',
        turboquant_kv_enabled: 'TQ', ttl_seconds: 'TTL', trust_remote_code: 'TRC' };
    const out = [];
    const b = base || {};
    for (const [k, v] of Object.entries(prof || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (b[k] === v) continue;
        const label = SHORT[k] || k.toUpperCase();
        out.push(label + (v === true ? '' : ' ' + v));
    }
    return out;
}
function copyBtn(textToCopy, title) {
    const b = document.createElement('button');
    b.className = 'copybtn'; b.textContent = '\u29c9'; b.title = title;
    b.onclick = async (e) => {
        e.stopPropagation();
        await copyText(textToCopy);
        b.textContent = '\u2713'; b.disabled = true;
        setTimeout(() => { b.textContent = '\u29c9'; b.disabled = false; }, 1200);
    };
    return b;
}
/* Aliases branch off the model on a visible trunk line: an .alias-tree box
   hanging below the main row inside the same model box. */
function aliasTree(m) {
    const lines = [];
    const line = (alias, chips, tip) => {
        const l = document.createElement('div'); l.className = 'alias-line';
        const mk = cell(alias); mk.className = 'alias-name';
        mk.title = tip || ('Serves this model on the API under the name "' + alias + '"');
        l.append(mk, copyBtn(alias, 'Copy alias "' + alias + '"'));
        for (const txt of chips) {
            const chip = document.createElement('span');
            chip.className = 'schip'; chip.textContent = txt; l.append(chip);
        }
        lines.push(l);
    };
    if (m.settings && m.settings.model_alias) line(m.settings.model_alias, []);
    for (const p of (m.exposed_profiles || []))
        line(p.api_name || p.name, aliasDiffChips(p.settings, m.settings),
             'Serves this model on the API under the name "' + (p.api_name || p.name) + '"');
    // stored (not-yet-exposed) profiles: dim chips so they are not invisible.
    // Cached briefly; invalidated whenever the editor writes a profile.
    const profHost = document.createElement('div');
    profHost.className = 'prof-lines';
    profHost.dataset.mid = m.id;
    const renderProfiles = (profs) => {
        for (const p of profs) {
            if ((m.exposed_profiles || []).some(e => e.name === p.name)) continue;
            const l = document.createElement('div'); l.className = 'alias-line dim-line';
            const tag = document.createElement('span');
            tag.className = 'schip'; tag.textContent = 'PROFILE';
            const mk = cell(p.display_name || p.name); mk.className = 'alias-name dim';
            mk.title = 'Stored profile — expose it as an API model from the editor to serve requests under its name';
            l.append(tag, mk);
            for (const txt of aliasDiffChips(p.settings, m.settings)) {
                const chip = document.createElement('span');
                chip.className = 'schip'; chip.textContent = txt; l.append(chip);
            }
            profHost.append(l);
        }
        if (!profHost.children.length) profHost.remove();
    };
    const c = profilesCache[m.id];
    if (c && Date.now() - c.t < 30000) { renderProfiles(c.profs); }
    else fetchJson(`${API}/admin/api/models/${encodeURIComponent(m.id)}/profiles`)
        .then(d => { profilesCache[m.id] = { t: Date.now(), profs: d.profiles || [] };
                     renderProfiles(d.profiles || []); })
        .catch(() => profHost.remove());
    if (!lines.length) {
        // no aliases yet: the tree box appears only once profiles resolve
        const t = document.createElement('div'); t.className = 'alias-tree';
        t.append(profHost); t.hidden = true;
        profHost.dataset.needsShow = '1';
        const obs = new MutationObserver(() => {
            if (profHost.children.length) { t.hidden = false; obs.disconnect(); }
        });
        obs.observe(profHost, { childList: true });
        return t;
    }
    const t = document.createElement('div'); t.className = 'alias-tree';
    lines.forEach(l => t.append(l));
    t.append(profHost);
    return t;
}

async function deleteStoredSettings(model) {
    return trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`,
            { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail ? JSON.stringify(body.detail) : 'http ' + res.status);
        return body;
    });
}
async function deleteModelFromDisk(model) {
    return trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/hf/models/${encodeURIComponent(model)}`,
            { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || 'http ' + res.status);
        return body;
    });
}
function renderTemplatesBox() {
    const host = $('ms-templates');
    if (!host) return;
    fetchJson(`${API}/admin/api/profile-templates`)
        .then(d => d.templates || []).catch(() => []).then(templates => {
        host.innerHTML = '';   // empty string + static markup only, no user data
        if (!templates.length) { host.innerHTML = '<div class="empty">No global templates</div>'; return; }
        for (const t of templates) {
            const row = document.createElement('div'); row.className = 'urow usage';
            const name = cell(t.display_name || t.name); name.className = 'uname';
            row.append(name, cell(t.description || ''), cell((t.updated_at || '').slice(0, 10)));
            host.append(row);
        }
    });
}
function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }
function emptyMsg(host, msg) {   // error text goes through textContent, never innerHTML
    host.textContent = '';
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = msg; host.append(d);
}
$('ma-filter').oninput = () => {
    // the filter felt dead while the editor was open: close the editor on filter
    if (seModel) closeEditor();
    renderModelAdmin(true);
};
$('ma-type').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-only-loaded').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-present-only').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };

/* ---------------- usage (Usage tab) ---------------- */
function createUsageChart() {
    const el = $('chart-usage');
    if (!el) return;
    if (usageChart) usageChart.destroy();
    const col = chartColors();
    usageChart = new uPlot({
        width: el.clientWidth || 600, height: 200,
        scales: { x: { time: true }, y: { auto: true } },
        axes: [{ stroke: col.dim, size: 36, font: axisFont,
                 values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) },
               yAxis(col, { grid: true })],
        series: [{ label: 'tokens' }, line('tokens', 'blue', true)],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: false },
    }, [[], []], el);
    bindCursorTip(usageChart);
}
async function pollUsage() {
    if (document.hidden) return;
    try {
        const u = await fetchJson(`${API}/admin/api/usage?range=${usageRange}`);
        const tot = u.totals || {};
        setCounter('v-u-req', tot.requests ?? null);
        setCounter('v-u-tok', tot.total_tokens ?? null);
        setCounter('v-u-prompt', tot.prompt_tokens ?? null);
        setCounter('v-u-compl', tot.completion_tokens ?? null);
        usageAvg = tot.requests > 0
            ? { prompt: tot.prompt_tokens / tot.requests, completion: tot.completion_tokens / tot.requests }
            : null;
        usageRange = u.range || usageRange;

        // Heatmap: single row for day ranges, full day×hour grid for 7d+.
        const hm = u.heatmap || [];
        const heat = $('heat');
        const multi = hm.length > 1;
        heat.classList.toggle('multi', multi);
        heat.style.gridTemplateRows = multi ? `repeat(${hm.length}, auto)` : '';
        const want = hm.length * 24;
        if (heat.children.length !== want) {
            heat.innerHTML = '';
            for (let i = 0; i < want; i++) heat.append(document.createElement('i'));
        }
        const allMax = Math.max(1, ...hm.flatMap(d => d.tokens || [0]));
        let cells = [...heat.children];
        hm.forEach((day, dIdx) => {
            (day.tokens || []).slice(0, 24).forEach((v, hIdx) => {
                const c = cells[dIdx * 24 + hIdx];
                if (!c) return;
                const a = v > 0 ? 0.15 + 0.85 * Math.sqrt(v / allMax) : 0;
                c.style.background = v > 0 ? `color-mix(in oklab, var(--heat) ${Math.round(a * 100)}%, transparent)` : '';
                c.title = `${day.date || ''} ${String(hIdx).padStart(2, '0')}:00 — ${C.fmtCompact(v)} tokens`;
            });
        });
        $('usage-sub').textContent = tot.requests !== undefined
            ? `${C.fmtNumber(tot.requests)} req · ${C.fmtCompact(tot.total_tokens)} tok · cached ${C.fmtCompact(tot.cached_tokens)}` : '';

        // Hourly tokens chart (last day of the range).
        if (!usageChart) createUsageChart();
        const lastDay = hm[hm.length - 1];
        const hours = lastDay ? (lastDay.tokens || []).slice(0, 24) : [];
        if (usageChart && hours.length === 24) {
            const base = new Date(); base.setHours(0, 0, 0, 0);
            const ts = hours.map((_, i) => base.getTime() + i * 3600e3);
            usageChart.setData([ts, hours.slice()]);
        }

        // Per-model table (all, sorted by tokens).
        const table = $('usage-models');
        table.innerHTML = '';
        const models = (u.models || []).slice()
            .sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
        if (models.length) {
            const head = document.createElement('div'); head.className = 'urow head admin';
            for (const h of ['model', 'req', 'prompt', 'completion', 'cached', 'avg t/req']) head.append(cell(h));
            table.append(head);
            for (const m of models) {
                const row = document.createElement('div'); row.className = 'urow admin';
                const name = cell(m.model_id); name.className = 'uname'; name.title = m.model_id;
                row.append(name, cell(C.fmtNumber(m.requests)), cell(C.fmtCompact(m.prompt_tokens)),
                           cell(C.fmtCompact(m.completion_tokens)), cell(C.fmtCompact(m.cached_tokens)),
                           cell(m.requests ? C.fmtCompact((m.prompt_tokens + m.completion_tokens) / m.requests) : '—'));
                table.append(row);
            }
        }
        if (currentTab() === 'status') renderRequestStats(stats);
    } catch (_) { /* usage may be disabled; keep last data */ }
}
fillSelect($('opt-usage-range'), [['today', 'today'], ['yesterday', 'yesterday'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']], usageRange);
$('opt-usage-range').onchange = e => { usageRange = e.target.value; pollUsage(); };

/* ---------------- logs (Logs tab) ---------------- */
let logsFilesLoaded = false, logsFollow = true;
async function pollLogs() {
    if (document.hidden && !logsFollow) return;
    try {
        const lines = Number($('logs-lines').value || 300);
        const file = $('logs-file').value;
        let url = `${API}/admin/api/logs?lines=${lines}`;
        if (file) url += `&file=${encodeURIComponent(file)}`;
        const d = await fetchJson(url);
        if (!logsFilesLoaded && Array.isArray(d.available_files)) {
            fillSelect($('logs-file'), d.available_files.map(f => [f, f]), d.log_file || d.available_files[0]);
            logsFilesLoaded = true;
        }
        let rows = String(d.logs || '').split('\n').filter(Boolean);
        const level = $('logs-level').value;
        const grep = ($('logs-grep').value || '').toLowerCase();
        rows = rows.filter(l => {
            if (level && !l.includes(` - ${level} - `)) return false;
            if (!level && layout.logsHideDebug && / - (DEBUG|TRACE) - /.test(l)) return false;
            if (grep && !l.toLowerCase().includes(grep)) return false;
            return true;
        });
        const pre = $('logs');
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const line of rows.slice(-800)) {
            const span = document.createElement('span');
            const lv = / - (ERROR|WARNING|TRACE|DEBUG) - /.exec(line);
            if (lv) span.className = `lv-${lv[1]}`;
            span.textContent = line + '\n';
            frag.append(span);
        }
        pre.append(frag);
        if (logsFollow || atBottom) pre.scrollTop = pre.scrollHeight;
        $('logs-sub').textContent = `${rows.length} lines${d.log_file ? ' · ' + d.log_file : ''}`;
    } catch (_) { /* keep tail */ }
}
$('logs-level').onchange = () => pollLogs();
$('logs-lines').onchange = () => pollLogs();
$('logs-file').onchange = () => pollLogs();
$('logs-grep').oninput = C.debounce ? C.debounce(pollLogs, 300) : (() => { let t; return () => { clearTimeout(t); t = setTimeout(pollLogs, 300); }; })();
$('logs-follow').onchange = e => { logsFollow = e.target.checked; };
$('logs-dl').onclick = () => {
    const blob = new Blob([$('logs').textContent], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uplift-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
};

/* ---------------- settings (Settings tab: read-only server preview) ------ */
/* ---- Server settings: editable form mirroring the classic Settings page.
   Same 11 sections, same fields, labels, hints, restart badges and
   conditional visibility (i18n strings copied from the original catalog).
   Saves replicate classic saveGlobalSettings(): full flat payload POSTed to
   global-settings — the gateway shadows it, real oMLX is never modified. */
/* ---------------- global-settings labels i18n ----------------
   GS_LABELS holds the English literals. When a non-en catalog lands we
   overwrite in place (deep walk; keys = 'uplift.gs.' + dotted path;
   option arrays localize their second element). Missing key -> the
   English literal stays (same fallback semantics as C.tf). Language
   self-names and path placeholders are never translated. */
const GS_EN = JSON.parse(JSON.stringify({}));   // filled on first localize: pristine EN
function gsLocalize() {
    const strings = C.getLocale().strings;
    if (!Object.keys(GS_EN).length) Object.assign(GS_EN, JSON.parse(JSON.stringify(GS_LABELS)));
    (function walk(en, cur, prefix) {
        for (const k of Object.keys(en)) {
            const ev = en[k], cv = cur[k];
            const path = prefix + k;
            if (ev && typeof ev === 'object' && !Array.isArray(ev)) { walk(ev, cv, path + '.'); continue; }
            if (/^lang\.|_placeholder$/.test(path)) continue;
            if (typeof ev === 'string') {
                const s = strings['uplift.gs.' + path];
                cur[k] = (typeof s === 'string' && s) ? s : ev;      // restore-or-translate, idempotent
            } else if (Array.isArray(ev) && Array.isArray(ev[0])) {  // [[value,label],…]
                cur[k] = ev.map(([v, lbl]) => {
                    const s = strings['uplift.gs.' + path + '.' + v];
                    return [v, (typeof s === 'string' && s) ? s : lbl];
                });
            }
        }
    })(GS_EN, GS_LABELS, '');
}

const GS_LABELS = {
    lang: { en: 'English', zh: '中文（简体）', 'zh-TW': '中文（繁體）', ko: '한국어',
            ja: '日本語', ru: 'Русский', es: 'Español', fr: 'Français',
            'pt-BR': 'Português (Brasil)' },
    auth: { api_key: 'API Key',
        api_key_hint: 'Clients must send this key in the Authorization header.',
        api_key_placeholder: C.tf('uplift.ui.enter_new_api_key', 'Enter new API key'),
        base_path: 'Base Path',
        base_path_hint: 'URL prefix when served behind a reverse proxy (e.g. /omlx).',
        skip: 'Skip API key verification',
        skip_hint: 'Disable authentication for local development.',
        skip_warning: 'Anyone on the network can call this server.' },
    server: { host: 'Host', host_placeholder: '127.0.0.1',
        port: 'Port', log_level: 'Log level',
        auto_start: 'Start on Login', auto_start_hint: 'Launch oMLX automatically when this Mac signs in.',
        aliases: 'Server Aliases',
        aliases_hint: 'Names this server answers to (one per line).',
        levels: [['error','Error'],['warning','Warning'],['info','Info'],
                 ['debug','Debug'],['trace','Trace']] },
    model: { dirs: 'Model Directories', ph_primary: '/path/to/models',
        ph_additional: 'Additional directory…',
        fallback: 'Model Fallback', fallback_desc: C.tf('uplift.ui.alias_to_use_when_the_requested_model_is_unavail', 'Alias to use when the requested model is unavailable.'),
        hide_helper: 'Hide helper models', hide_helper_desc: C.tf('uplift.ui.keep_drafters_and_assistants_out_of_model_lists', 'Keep drafters and assistants out of model lists.'),
        hf_cache: 'Hugging Face cache', hf_cache_desc: C.tf('uplift.ui.reuse_downloaded_models_from_the_local_hf_cache', 'Reuse downloaded models from the local HF cache.'),
        idle: 'Idle Timeout', idle_desc: C.tf('uplift.ui.unload_a_model_after_it_has_been_unused_for_this', 'Unload a model after it has been unused for this long.'),
        idle_opts: [['','Never'],['900','15 minutes'],['1800','30 minutes'],
                    ['3600','1 hour'],['7200','2 hours'],['28800','8 hours'],
                    ['86400','24 hours']] },
    res: { max_conc: 'Max Concurrent Requests',
        max_conc_hint: 'Requests admitted at once; others queue.',
        batch: 'Embedding Batch Size',
        batch_hint: 'Texts encoded per embedding forward pass.',
        chunked: 'Chunked Prefill', chunked_desc: C.tf('uplift.ui.split_long_prompts_to_interleave_with_decode', 'Split long prompts to interleave with decode.'),
        fairness: 'Decode Fairness', fairness_desc: C.tf('uplift.ui.round_robin_decode_slots_across_requests', 'Round-robin decode slots across requests.'),
        prio: 'Prefill Priority', prio_speed: 'Speed', prio_context: 'Max Context',
        guard: 'Prefill Memory Guard',
        guard_desc: C.tf('uplift.ui.refuse_prefill_when_free_memory_is_below_the_gua', 'Refuse prefill when free memory is below the guard.'),
        tier: 'Memory Guard Tier',
        tiers: [['safe','Safe'],['balanced','Balanced'],['aggressive','Aggressive'],
                ['custom','Custom']],
        custom: 'Custom Ceiling (GB)',
        custom_ph: 'e.g. 48',
        cold: 'Cold Cache Limit',
        cold_desc: C.tf('uplift.ui.cap_on_non_hot_kv_cache_blocks', 'Cap on non-hot KV cache blocks.'),
        hot: 'Hot Cache Limit' },
    cache: { enabled: 'KV Cache', enabled_hint: 'Keep KV blocks between requests.',
        hot_only: 'Hot Cache Only',
        hot_only_hint: 'Never spill cached KV to SSD.',
        ssd_dir: 'SSD Cache Directory',
        ssd_max: 'SSD Cache Max Size',
        ssd_max_hint: 'Example: 64GB (blank = OS default).',
        hot_max: 'Hot Cache Max Size',
        hot_max_hint: '"0" disables, example: 8GB.',
        gdn_split: 'GDN SSD Split',
        gdn_split_hint: 'Split GDN snapshots to SSD next to the pending limit.' },
    cc: { mode: 'Mode', mode_hint: 'Local routes Claude Code through this server; cloud uses Anthropic directly.',
        local: 'Local', cloud: 'Cloud',
        opus: 'Opus Model', sonnet: 'Sonnet Model', haiku: 'Haiku Model',
        ph: 'Pick or type a model' },
    gen: { max_ctx: 'Max Context Window',
        max_ctx_hint: 'Largest context a request may claim.',
        max_policy: 'Max Context Policy',
        max_policy_hint: 'Override applied to model default (blank = model decides).',
        max_tokens: 'Max Tokens',
        temperature: 'Temperature', temperature_hint: 'Sampling randomness (0 = greedy).',
        top_p: 'Top-P (Nucleus)', top_p_hint: 'Cumulative probability mass kept.',
        top_k: 'Top-K', top_k_hint: '0 disables top-K.',
        rep_pen: 'Repetition Penalty', rep_pen_hint: 'Penalty for reusing recent tokens (1 = off).' },
    mcp: { path: 'MCP Config Path',
        ph: '~/.mcp.json',
        expose: 'Expose MCP Tools',
        expose_hint: 'Serve built-in tools over Model Context Protocol.' },
    usage: { history: 'Usage History',
        history_hint: 'Record per-model token usage for the Usage tab.' },
    net: { http_proxy: 'HTTP Proxy', proxy_hint: 'Example: http://proxy.company.com:8080',
        hf_ep: 'Hugging Face Endpoint',
        hf_ep_hint: 'Mirror or Hub instance used for downloads (blank = huggingface.co).',
        ms_ep: 'ModelScope Endpoint',
        ms_ep_hint: 'ModelScope mirror for downloads (blank = modelscope.cn).',
        https_proxy: 'HTTPS Proxy',
        no_proxy: 'No Proxy', no_proxy_hint: 'Comma-separated hosts to bypass proxy',
        ca_bundle: 'CA Bundle',
        ca_hint: 'Path to PEM file for corporate TLS interception' },
    adv: { distributed: 'Distributed Inference',
        distributed_enabled: 'Enable distributed inference',
        distributed_hint: 'Split layers across multiple machines (experimental).',
        perf: 'Performance', streaming: 'Streaming', uploads: 'Uploads',
        burst: 'Burst Decode',
        burst_hint: 'Speculative decode aggressiveness for burst throughput.',
        burst_opts: [['off','Off'],['light','Light'],['balanced','Balanced'],
                     ['aggressive','Aggressive']],
        sse: 'SSE Keepalive Mode',
        sse_hint: 'How keepalives are emitted on streaming responses.',
        sse_opts: [['chunk','Chunk'],['comment','Comment'],['off','Off']],
        mid_sys: 'Preserve Mid-System Cache',
        mid_sys_hint: 'Keep cached KV for system prompts placed mid-conversation.',
        audio: 'Maximum Audio Upload Size (MB)',
        audio_hint: 'Reject audio attachments above this size.',
        ane: 'ANE Compile Cache',
        ane_hint: 'Cache CoreML compiled graphs on the Neural Engine.',
        wt: 'Hot Cache Write-Through',
        wt_hint: 'Write hot blocks to SSD immediately.',
        blocks: 'Initial Cache Blocks',
        blocks_hint: 'KV blocks allocated at startup.',
        gdn_store: 'GDN Snapshot Storage',
        gdn_store_hint: 'Where Gated-DeltaNet state snapshots go.',
        gdn_store_opts: [['auto','Auto'],['ssd_sidecar','SSD Sidecar'],
                         ['embedded','Embedded']],
        gdn_pend: 'GDN Pending Write Limit',
        gdn_pend_hint: 'Max queued SSD writes before backpressure.',
        gdn_prec: 'GDN Sidecar State Precision',
        gdn_prec_hint: 'Quantisation of sidecar-held recurrent state.',
        gdn_prec_opts: [['fp32','FP32'],['rht_int16','RHT INT16'],['bf16','BF16'],
                        ['int8','INT8'],['rht_int8','RHT INT8']],
        gdn_prec_warning: 'INT8/RHT INT8 state precision may degrade long-context quality.' },
    badge: 'RESTART REQUIRED',
    restart_notice: 'Host and port changes take effect after a restart.',
};

// shadow key -> nested [section, field] map (mirrors GlobalSettingsRequest)
const GS_MAP = {
    host: ['server','host'], port: ['server','port'],
    log_level: ['server','log_level'],
    sse_keepalive_mode: ['server','sse_keepalive_mode'],
    burst_decode_mode: ['server','burst_decode_mode'],
    preserve_mid_system_cache: ['server','preserve_mid_system_cache'],
    distributed_inference_enabled: ['server','distributed_inference_enabled'],
    max_audio_upload_size: ['server','max_audio_upload_size'],
    model_dirs: ['model','model_dirs'], model_fallback: ['model','model_fallback'],
    hide_helper_models: ['model','hide_helper_models'],
    idle_timeout_seconds: ['idle_timeout','idle_timeout_seconds'],
    hf_cache_enabled: ['huggingface','hf_cache_enabled'],
    memory_prefill_memory_guard: ['memory','prefill_memory_guard'],
    memory_guard_tier: ['memory','memory_guard_tier'],
    memory_guard_custom_ceiling_gb: ['memory','memory_guard_custom_ceiling_gb'],
    max_concurrent_requests: ['scheduler','max_concurrent_requests'],
    embedding_batch_size: ['scheduler','embedding_batch_size'],
    chunked_prefill: ['scheduler','chunked_prefill'],
    prefill_priority: ['scheduler','prefill_priority'],
    decode_fairness: ['scheduler','decode_fairness'],
    cache_enabled: ['cache','enabled'],
    ssd_cache_dir: ['cache','ssd_cache_dir'],
    hot_cache_only: ['cache','hot_cache_only'],
    hot_cache_write_through: ['cache','hot_cache_write_through'],
    ane_compile_cache: ['cache','ane_compile_cache'],
    initial_cache_blocks: ['cache','initial_cache_blocks'],
    gdn_snapshot_storage: ['cache','gdn_snapshot_storage'],
    gdn_ssd_pending_max_size: ['cache','gdn_ssd_pending_max_size'],
    gdn_sidecar_precision: ['cache','gdn_sidecar_precision'],
    sampling_max_context_window: ['sampling','max_context_window'],
    sampling_max_context_window_policy: ['sampling','max_context_window_policy'],
    sampling_max_tokens: ['sampling','max_tokens'],
    sampling_temperature: ['sampling','temperature'],
    sampling_top_p: ['sampling','top_p'], sampling_top_k: ['sampling','top_k'],
    sampling_repetition_penalty: ['sampling','repetition_penalty'],
    mcp_config: ['mcp','config_path'], mcp_expose_tools: ['mcp','expose_tools'],
    usage_history: ['usage','usage_history'],
    network_http_proxy: ['network','http_proxy'],
    network_https_proxy: ['network','https_proxy'],
    network_no_proxy: ['network','no_proxy'],
    network_ca_bundle: ['network','ca_bundle'],
    ui_language: ['ui','language'],
    api_key: ['auth','api_key'],
    skip_api_key_verification: ['auth','skip_api_key_verification'],
    // P1A parity with classic GlobalSettingsRequest (79 keys)
    server_aliases: ['server','server_aliases'],
    auto_start_on_launch: ['server','auto_start_on_launch'],
    hf_endpoint: ['huggingface','endpoint'],
    ms_endpoint: ['modelscope','endpoint'],
    ssd_cache_max_size: ['cache','ssd_cache_max_size'],
    hot_cache_max_size: ['cache','hot_cache_max_size'],
    // gdn_ssd_split_enabled is legacy: upstream 400s when sent together with
    // gdn_snapshot_storage (always in the full payload, classic parity), so
    // it is intentionally not mapped or saved.
    claude_code_mode: ['claude_code','mode'],
    claude_code_opus_model: ['claude_code','opus_model'],
    claude_code_sonnet_model: ['claude_code','sonnet_model'],
    claude_code_haiku_model: ['claude_code','haiku_model'],
};
/* Keys the classic saveGlobalSettings() includes in its full payload.
   base_path is launch-time only (read-only row); api_key is sent masked and
   skipped upstream when unchanged — sending the masked value would corrupt it. */
/* ui_dashboard_layout is the CLASSIC dashboard's saved block layout —
   Uplift has its own localStorage layout and must never round-trip or
   clobber the classic one. Omitting it from the payload means "keep"
   (routes.py only applies keys present in model_fields_set). */
const GS_PAYLOAD_SKIP = new Set(['base_path', 'api_key', 'ui_dashboard_layout']);

let GS = null;   // merged working copy (upstream + shadow)
/* Dirty tracking for the deferred-SAVE flow: GS_ORIG is the snapshot at page
   load / last save; gsDirty holds queued-but-unsaved flat->value edits.
   Fields whose change only takes effect after a server restart are flagged
   red (!) and force the sticky SAVE button into RESTART SERVER once the
   queue is saved. Which fields restart: mirrors the classic template's
   restart badges (server host/port/auto-start, max concurrent requests,
   cache enable, MCP config, distributed + CA bundle, proxy endpoints). */
let GS_ORIG = {};
const gsDirty = {};
let gsRestartPending = false;   // queued edits were saved; server restart still owed
const GS_RESTART_FIELDS = new Set([
    'host', 'port', 'auto_start_on_launch', 'max_concurrent_requests',
    'cache_enabled', 'mcp_config', 'distributed_inference_enabled',
    'network_ca_bundle', 'hf_endpoint', 'ms_endpoint']);
function gsQueueSave(flat, val) {           // edit -> queue, no fetch yet
    markFieldDirty(flat, val);
    if (['custom_model_prefixes'].includes(flat)) renderGlobalSettings();
}
function gsFlatOf(sec, field) {
    return Object.keys(GS_MAP).find(k => GS_MAP[k][0] === sec && GS_MAP[k][1] === field);
}
function gsOrigFlat(flat) {
    const map = GS_MAP[flat];
    if (!map) return GS_ORIG[flat];
    return (GS_ORIG[map[0]] || {})[map[1]];
}
function gsValFlat(flat) {
    const map = GS_MAP[flat];
    if (map) return gsGet(map[0], map[1]);
    return GS._shadow ? GS._shadow[flat] : undefined;
}
function gsDisplay(v) {
    if (v === null || v === undefined || v === '') return '(unset)';
    return String(Array.isArray(v) ? v.join(',') : v);
}
/* fields whose values are secrets: diff chips and the CHANGES list say
   CHANGED instead of printing the value (API key stays masked everywhere) */
const SECRET_KEYS = new Set(['api_key', 'cloud_token', 'hf_token']);
function markFieldDirty(flat, val) {
    const orig = gsOrigFlat(flat);
    const cur = val === undefined ? gsValFlat(flat) : val;
    const changed = JSON.stringify(orig) !== JSON.stringify(cur);
    if (changed) gsDirty[flat] = cur;
    else delete gsDirty[flat];               // edited back = no longer queued
    const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
    if (row) {
        row.classList.toggle('dirty', changed);
        row.classList.toggle('restartq', changed && GS_RESTART_FIELDS.has(flat));
        const rd = row.querySelector('.diff-out');
        if (rd) {
            rd.hidden = !changed;
            if (changed && SECRET_KEYS.has(flat)) {
                // masked field (API key): indicate the change, not the value
                rd.classList.add('masked');
                rd.querySelector('.diff-o').textContent = '••• CHANGED';
            } else if (changed) {
                rd.classList.remove('masked');
                rd.querySelector('.diff-o').textContent = gsDisplay(orig);
            }
        }
    }
    gsUpdateSaveBtn();
    gsMarkSections();
    renderDirtyList();
}
function revertField(flat) {                // click on |original| chip
    delete gsDirty[flat];
    renderGlobalSettings();                 // inputs rebuild from the baseline
    renderDirtyList();
}
function gsMarkSections() {
    for (const box of document.querySelectorAll('#gs-body .gs-box')) {
        const rows = [...box.querySelectorAll('[data-flat].dirty')];
        const head = box.querySelector('.gs-box-title');
        if (!head) continue;
        const anyRestart = rows.some(r => r.classList.contains('restartq'));
        head.classList.toggle('sec-dirty', rows.length > 0 && !anyRestart);
        head.classList.toggle('sec-restart', anyRestart);
        let warn = head.querySelector('.rqnow');
        if (!warn) { warn = document.createElement('span'); warn.className = 'rqnow'; head.append(warn); }
        // U8 (user round): amber hot-apply banner for queued-but-hot edits;
        // red restart banner takes precedence
        warn.textContent = anyRestart ? ' RESTART REQUIRED ' : ' ⚡ HOT APPLY ON SAVE ';
        warn.style.display = rows.length ? '' : 'none';
    }
}
function renderDirtyList() {
    const box = document.getElementById('gs-changes');
    if (!box) return;
    const keys = Object.keys(gsDirty);
    box.hidden = !keys.length;
    box.textContent = '';
    if (!keys.length) return;
    const head = document.createElement('div'); head.className = 'ch-head';
    head.textContent = C.tf('uplift.ui.changes', 'CHANGES (') + keys.length + ')';
    box.append(head);
    for (const k of keys) {
        const line = document.createElement('div'); line.className = 'ch-line';
        const secret = SECRET_KEYS.has(k);
        const a = document.createElement('span'); a.textContent = k + ': ' + (secret ? '•••' : gsDisplay(gsOrigFlat(k)));
        const arrow = document.createTextNode(' → ');
        const b2 = document.createElement('span'); b2.textContent = k + ': ' + (secret ? '••• CHANGED' : gsDisplay(gsDirty[k]));
        b2.className = 'ch-new';
        line.append(a, arrow, b2);
        box.append(line);
    }
}
function gsSaveBtn() { return document.getElementById('gs-save'); }
function gsUpdateSaveBtn() {
    const b = gsSaveBtn(); if (!b) return;
    const n = Object.keys(gsDirty).length;
    const restartQ = gsRestartPending ||
        Object.keys(gsDirty).some(k => GS_RESTART_FIELDS.has(k));
    b.classList.toggle('queued', n > 0);
    // the red RESTART state only arms after a save that left a restart owed;
    // while edits are merely queued the button stays amber SAVE (user's flow:
    // click SAVE -> saved -> button becomes RESTART SERVER)
    b.classList.toggle('restart-mode', gsRestartPending);
    b.textContent = n
        ? (restartQ ? '▶ SAVE + RESTART (' + n + ')' : 'SAVE (' + n + ')')
        : (gsRestartPending ? '▶ RESTART SERVER' : 'SAVE');
    b.title = n ? (restartQ
        ? 'Some queued changes need a server restart to take effect. First click saves; the button then becomes RESTART SERVER.'
        : 'Apply ' + n + ' queued change' + (n > 1 ? 's' : ''))
        : 'No queued changes';
}
async function gsCommit() {
    const fields = Object.assign({}, gsDirty);
    const okAll = await gsSaveNow(fields);
    if (okAll) {
        Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
        // a save that touched restart-requiring fields leaves the server
        // owing a restart: arm the red RESTART SERVER button (user flow)
        if (Object.keys(fields).some(k => GS_RESTART_FIELDS.has(k))) gsRestartPending = true;
    }
    // re-render inputs from the new baseline; keeps still-queued edits shown
    renderGlobalSettings();
    gsUpdateSaveBtn();
    renderDirtyList();
}
async function gsRestartServer() {
    const b = gsSaveBtn(); if (!b) return;
    b.disabled = true;
    try {
        const d = await postJson(`${API}/admin/api/server/restart`, {});
        gsRestartPending = false;   // restart requested; button goes back to SAVE
        toast(d.restarting === false && d.detail
            ? ('restart: ' + d.detail) : 'Restart requested — server respawns in ~5 s');
        $('banner').classList.add('show');
        $('banner-text').textContent = C.tf('uplift.ui.server_restarting_dashboard_reconnecting', 'Server restarting — dashboard reconnecting…');
    } catch (e) { toast(C.t('uplift.toast.restart_failed', {msg: e.message})); }
    b.disabled = false;
    gsUpdateSaveBtn();
}
function gsSaveOrRestart() {                 // one button, two states
    const b = gsSaveBtn(); if (!b) return;
    if (b.classList.contains('restart-mode')) {
        if (Object.keys(gsDirty).length) { gsCommit().then(gsUpdateSaveBtn); return; }
        gsRestartServer();
    } else gsCommit();
}
async function gsSaveNow(fields) {
    // classic saveGlobalSettings(): send the FULL mapped payload built from
    // the working copy (GET response + shadow), not just changed fields —
    // omitted keys would never be written by a live save (P1A-6).
    const body = {};
    for (const flat of Object.keys(GS_MAP)) {
        if (GS_PAYLOAD_SKIP.has(flat)) continue;
        const [sec, field] = GS_MAP[flat];
        const v = gsGet(sec, field);
        if (v !== undefined) body[flat] = v;
    }
    Object.assign(body, GS._shadow || {}, fields);
    try {
        const r = await fetch(`${API}/admin/api/global-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) { toast(C.t('uplift.toast.save_failed_http', {status: r.status})); return false; }
        GS._shadow = body;
        for (const k of Object.keys(fields)) {
            const map = GS_MAP[k];
            if (map) GS[map[0]][map[1]] = fields[k];
        }
        // saved: the response values become the new baseline
        GS_ORIG = JSON.parse(JSON.stringify(GS));
        if (GS._shadow) GS_ORIG._shadow = body;
        gsSavedAt = Date.now();
        // Language change -> hot-reload our catalog (classic refreshes
        // its Jinja globals on language change; our endpoint re-reads
        // files per request, so just re-fetch + re-apply).
        if ('ui_language' in fields) loadLocale(fields.ui_language);
        $('gs-sub').textContent = GW_LIVE
            ? 'saved ✓'
            : 'saved ✓ (shadow — real oMLX untouched)';
        toast(C.t('uplift.toast.settings_saved_n', {n: Object.keys(fields).length}));
        return true;
    } catch (err) { toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
}

function gsGet(sec, field) {
    const sh = GS._shadow || {};
    const flat = Object.keys(GS_MAP).find(k =>
        GS_MAP[k][0] === sec && GS_MAP[k][1] === field);
    if (flat && flat in sh) return sh[flat];
    const v = (GS[sec] || {})[field];
    return v;
}


function gsBadge() {
    const b = document.createElement('span');
    // unified indicator-chip geometry (.rqchip matches the cockpit lamps:
    // same height/stroke everywhere), never clipped by the label cell
    b.className = 'rqchip';
    const bang = document.createElement('span');
    bang.className = 'rqmark'; bang.textContent = '!';
    b.append(bang, document.createTextNode(' ' + GS_LABELS.badge));
    b.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
    return b;
}

function gsRow(sec, labelTxt, hint, control, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'urow settings';
    if (opts.flat) row.dataset.flat = opts.flat;
    const lab = cell(labelTxt); lab.className = 'uname';
    // The restart warning sits immediately RIGHT OF THE TITLE (user), the
    // description follows after it — previously the chip was appended after
    // the hint and wrapped onto a line below the description.
    if (opts.badge) lab.append(gsBadge());
    else if (opts.flat && GS_RESTART_FIELDS.has(opts.flat)) {
        // permanent red ! on fields whose change needs a server restart
        const m = document.createElement('span');
        m.className = 'rqmark'; m.textContent = '!';
        m.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
        lab.append(m);
    }
    if (hint) {
        const h = document.createElement('small');
        h.className = 'dim'; h.textContent = hint;   // sits beside the name
        lab.append(h);
    }
    // fixed 3-column layout: name+hint | diff slot (reserved, never moves
    // the control) | control — the input keeps its place when it goes dirty
    const slot = document.createElement('span'); slot.className = 'diffslot';
    const rd = document.createElement('span'); rd.className = 'diff-out'; rd.hidden = true;
    const o = document.createElement('span'); o.className = 'diff-o';
    o.title = C.tf('uplift.ui.click_to_revert_to_the_original_value', 'Click to revert to the original value');
    o.onclick = () => { if (opts.flat) revertField(opts.flat); };
    // the new value is the live control itself; slot shows |original| → only
    rd.append(o, document.createTextNode('→'));
    slot.append(rd);
    const ctl = cell(''); ctl.className = 'gctl';
    ctl.append(control);
    row.append(lab, slot, ctl);
    return row;
}

function gsText(sec, field, flat, L, extra) {
    const inp = document.createElement('input');
    inp.type = (extra && extra.type) || 'text';
    if (extra && extra.placeholder) inp.placeholder = extra.placeholder;
    if (extra && extra.list) inp.setAttribute('list', extra.list);
    if (extra && extra.min !== undefined) inp.min = extra.min;
    if (extra && extra.max !== undefined) inp.max = extra.max;
    if (extra && extra.step !== undefined) inp.step = extra.step;
    const v = gsGet(sec, field);
    inp.value = v == null ? '' : v;
    if (extra && extra.range) {
        // R10-1: the old readout span duplicated the value in a second
        // bordered box that looked like another input. The control itself
        // shows the value; a number input gives the native stepper instead.
        inp.type = 'number';
        const queueRange = () => gsQueueSave(flat, inp.value === '' ? null : Number(inp.value));
        inp.oninput = queueRange;
        inp.onchange = queueRange;
        return inp;
    }
    const queue = (ev) => {
        let val = inp.value;
        if (extra && extra.number) val = val === '' ? null : Number(val);
        if (extra && extra.bool) val = inp.checked;
        gsQueueSave(flat, val);
        // conditional-row refresh only on commit (blur/change): a full
        // re-render on every keystroke would steal the input's focus
        if (extra && extra.reload && (!ev || ev.type === 'change')) renderGlobalSettings();
    };
    inp.addEventListener('input', queue);
    inp.addEventListener('change', queue);
    return inp;
}

function gsToggle(flat, on) {
    const t = document.createElement('input');
    t.type = 'checkbox'; t.checked = !!on;
    t.onchange = () => gsQueueSave(flat, t.checked);
    return t;
}

function gsSelect(flat, options, cur) {
    const sel = document.createElement('select');
    for (const [v, t] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; sel.append(o);
    }
    sel.value = cur == null ? '' : String(cur);
    sel.onchange = () => {
        // numeric baseline (e.g. idle_timeout_seconds): keep the payload numeric
        let v = sel.value === '' ? null : sel.value;
        if (v !== null && typeof cur === 'number') v = Number(v);
        gsQueueSave(flat, v);
        renderGlobalSettings();       // refresh conditional rows (x-show parity)
    };
    return sel;
}

function gsTitle(t) {
    const h = document.createElement('div');
    // section titles localize via slug key; English literal is fallback
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.className = 'gs-title'; h.textContent = C.tf('uplift.gs.title.' + slug, t);
    return h;
}

async function pollGlobalSettings() {
    let d;
    try { d = await fetchJson(`${API}/admin/api/global-settings`); }
    catch (err) { emptyMsg($('gs-body'), 'global-settings not served (' + err.message + ')'); return; }
    // never clobber queued edits with a background poll; merge server state
    // under the dirty overrides so inputs stay put until SAVE
    if (Object.keys(gsDirty).length) {
        for (const [flat, val] of Object.entries(gsDirty)) {
            const map = GS_MAP[flat];
            if (map && d[map[0]]) d[map[0]][map[1]] = val;
            if (d._shadow) d._shadow[flat] = val;
        }
    }
    GS = d;   // gateway already overlaid the shadow; resave accumulates
    if (!Object.keys(gsDirty).length) GS_ORIG = JSON.parse(JSON.stringify(d));
    renderGlobalSettings();
}

function renderGlobalSettings() {
    const body = document.createElement('div');   // staged; grouped into boxes below
    body.textContent = '';
    const L = GS_LABELS;

    // (the old "Global" restart-notice box was removed; the RESTART chip,
    //  red field marks and the RESTART SERVER button carry that meaning now)

    // ---- Language
    body.append(gsTitle('Language'));
    body.append(gsRow('ui', C.t('uplift.gs.ui.interface_language'), '',
        gsSelect('ui_language', Object.entries(L.lang), gsGet('ui','language')),
        { flat: 'ui_language' }));

    // ---- Claude Code (classic renders this on Status; Uplift keeps it with settings)
    body.append(gsTitle('Claude Code'));
    const ccLocal = (gsGet('claude_code','mode') || 'local') !== 'cloud';
    body.append(gsRow('claude_code', L.cc.mode, L.cc.mode_hint,
        gsSelect('claude_code_mode', [['local', L.cc.local], ['cloud', L.cc.cloud]],
                 ccLocal ? 'local' : 'cloud'), { flat: 'claude_code_mode' }));
    if (ccLocal) {
        const dl = document.createElement('datalist'); dl.id = 'cc-models';
        body.append(dl);
        fetchJson(`${API}/admin/api/models`).then(d => {
            for (const m of d.models || []) {
                const o2 = document.createElement('option');
                o2.value = m.name || m.id || ''; dl.append(o2);
            }
        }).catch(() => { /* picker list optional */ });
        body.append(gsRow('claude_code', L.cc.opus, '',
            gsText('claude_code','opus_model','claude_code_opus_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_opus_model' }));
        body.append(gsRow('claude_code', L.cc.sonnet, '',
            gsText('claude_code','sonnet_model','claude_code_sonnet_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_sonnet_model' }));
        body.append(gsRow('claude_code', L.cc.haiku, '',
            gsText('claude_code','haiku_model','claude_code_haiku_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_haiku_model' }));
    }

    // ---- Auth
    body.append(gsTitle('Auth'));
    body.append(gsRow('auth', L.auth.api_key, L.auth.api_key_hint,
        gsText('auth','api_key','api_key', L, { type: 'password',
            placeholder: L.auth.api_key_placeholder, reload: true }),
        { flat: 'api_key' }));
    const bpIn = document.createElement('input');
    bpIn.type = 'text'; bpIn.value = GS.base_path || '';
    bpIn.disabled = true;
    bpIn.title = C.tf('uplift.ui.set_at_launch_base_path_read_only', 'Set at launch (--base-path); read-only');
    body.append(gsRow('auth', L.auth.base_path, L.auth.base_path_hint, bpIn));
    body.append(gsRow('auth', L.auth.skip, L.auth.skip_hint + ' ' + L.auth.skip_warning,
        gsToggle('skip_api_key_verification', gsGet('auth','skip_api_key_verification')),
        { flat: 'skip_api_key_verification' }));

    // ---- Server
    body.append(gsTitle('Server'));
    body.append(gsRow('server', L.server.host, '',
        gsText('server','host','host', L, { placeholder: L.server.host_placeholder }),
        { badge: true, flat: 'host' }));
    body.append(gsRow('server', L.server.port, '',
        gsText('server','port','port', L, { number: true }), { badge: true, flat: 'port' }));
    body.append(gsRow('server', L.server.log_level, '',
        gsSelect('log_level', L.server.levels, gsGet('server','log_level')),
        { flat: 'log_level' }));
    body.append(gsRow('server', L.server.auto_start, L.server.auto_start_hint,
        gsToggle('auto_start_on_launch', gsGet('server','auto_start_on_launch')),
        { badge: true, flat: 'auto_start_on_launch' }));
    // server_aliases: one alias per line (classic editor keeps a list; same payload)
    const aliasInp = document.createElement('textarea');
    aliasInp.rows = 2; aliasInp.spellcheck = false;
    aliasInp.value = (gsGet('server','server_aliases') || []).join('\n');
    aliasInp.onchange = () => gsQueueSave('server_aliases',
        aliasInp.value.split('\n').map(s => s.trim()).filter(Boolean));
    body.append(gsRow('server', L.server.aliases, L.server.aliases_hint, aliasInp,
        { flat: 'server_aliases' }));

    // ---- Model
    body.append(gsTitle('Model'));
    const dirs = gsGet('model','model_dirs') || [];
    const dl = document.createElement('div');
    dl.className = 'gs-dirs';
    dirs.forEach((d, i) => {
        const one = document.createElement('div');
        one.className = 'gs-dir';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = d;
        inp.placeholder = i === 0 ? L.model.ph_primary : L.model.ph_additional;
        const rm = document.createElement('button');
        rm.className = 'se-btn act'; rm.textContent = '×';
        rm.style.display = dirs.length > 1 ? '' : 'none';
        rm.onclick = async () => {
            const nd = dirs.filter((_, j) => j !== i);
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        inp.onchange = async () => {
            const nd = dirs.slice(); nd[i] = inp.value;
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        one.append(inp, rm);
        dl.append(one);
    });
    const add = document.createElement('button');
    add.className = 'se-btn act'; add.textContent = C.t('uplift.gs.model.add_directory');
    add.onclick = async () => {
        if (await gsSaveNow({ model_dirs: dirs.concat('') })) renderGlobalSettings();
    };
    dl.append(add);
    body.append(gsRow('model', L.model.dirs, '', dl));
    body.append(gsRow('model', L.model.fallback, L.model.fallback_desc,
        gsText('model','model_fallback','model_fallback', L),
        { flat: 'model_fallback' }));
    body.append(gsRow('model', L.model.hide_helper, L.model.hide_helper_desc,
        gsToggle('hide_helper_models', gsGet('model','hide_helper_models')),
        { flat: 'hide_helper_models' }));
    body.append(gsRow('model', L.model.hf_cache, L.model.hf_cache_desc,
        gsToggle('hf_cache_enabled', gsGet('huggingface','hf_cache_enabled')),
        { flat: 'hf_cache_enabled' }));
    const hfp = cell((GS.huggingface || {}).hf_cache_path || '—');
    hfp.className = 'dim';
    body.append(gsRow('model', C.t('uplift.gs.model.hf_path_label'), '', hfp));
    body.append(gsRow('model', L.model.idle, L.model.idle_desc,
        gsSelect('idle_timeout_seconds', L.model.idle_opts,
                 gsGet('idle_timeout','idle_timeout_seconds') ?? ''),
        { flat: 'idle_timeout_seconds' }));

    // ---- Generation Defaults
    body.append(gsTitle('Generation Defaults'));
    const temp = gsText('sampling','temperature','sampling_temperature', L,
        { range: true, min: 0, max: 2, step: 0.1 });
    body.append(gsRow('gen', L.gen.temperature, L.gen.temperature_hint, temp,
        { flat: 'sampling_temperature' }));
    const topp = gsText('sampling','top_p','sampling_top_p', L,
        { range: true, min: 0, max: 1, step: 0.05 });
    body.append(gsRow('gen', L.gen.top_p, L.gen.top_p_hint, topp,
        { flat: 'sampling_top_p' }));
    body.append(gsRow('gen', L.gen.top_k, L.gen.top_k_hint,
        gsText('sampling','top_k','sampling_top_k', L, { number: true, min: 0 }),
        { flat: 'sampling_top_k' }));
    body.append(gsRow('gen', L.gen.max_tokens, '',
        gsText('sampling','max_tokens','sampling_max_tokens', L,
               { number: true, min: 1, max: 131072 }),
        { flat: 'sampling_max_tokens' }));
    body.append(gsRow('gen', L.gen.max_ctx, L.gen.max_ctx_hint,
        gsText('sampling','max_context_window','sampling_max_context_window', L,
               { number: true, min: 1, max: 2097152 }),
        { flat: 'sampling_max_context_window' }));
    body.append(gsRow('gen', L.gen.max_policy, L.gen.max_policy_hint,
        gsText('sampling','max_context_window_policy',
               'sampling_max_context_window_policy', L,
               { number: true, min: 1, max: 2097152, placeholder: 'None' }),
        { flat: 'sampling_max_context_window_policy' }));
    body.append(gsRow('gen', L.gen.rep_pen, L.gen.rep_pen_hint,
        gsText('sampling','repetition_penalty','sampling_repetition_penalty', L,
               { number: true, min: 1, step: 0.05 }),
        { flat: 'sampling_repetition_penalty' }));

    // ---- Resource Management
    body.append(gsTitle('Resource Management'));
    body.append(gsRow('res', L.res.max_conc, L.res.max_conc_hint,
        gsText('scheduler','max_concurrent_requests','max_concurrent_requests', L,
               { number: true, min: 1 }),
        // U7: it is in GS_RESTART_FIELDS (the scheduler pool size is read at
        // boot) but only showed a bare "!" — the server routes say so too.
        // Full badge with text, same as host/port.
        { flat: 'max_concurrent_requests', badge: true }));
    body.append(gsRow('res', L.res.batch, L.res.batch_hint,
        gsText('scheduler','embedding_batch_size','embedding_batch_size', L,
               { number: true, min: 1 }),
        { flat: 'embedding_batch_size' }));
    body.append(gsRow('res', L.res.chunked, L.res.chunked_desc,
        gsToggle('chunked_prefill', gsGet('scheduler','chunked_prefill')),
        { flat: 'chunked_prefill' }));
    body.append(gsRow('res', L.res.prio, '',
        gsSelect('prefill_priority', [['speed', L.res.prio_speed],
                                      ['context', L.res.prio_context]],
                 gsGet('scheduler','prefill_priority')),
        { flat: 'prefill_priority' }));
    body.append(gsRow('res', L.res.fairness, L.res.fairness_desc,
        gsToggle('decode_fairness', gsGet('scheduler','decode_fairness')),
        { flat: 'decode_fairness' }));
    body.append(gsRow('res', L.res.guard, L.res.guard_desc,
        gsToggle('memory_prefill_memory_guard', gsGet('memory','prefill_memory_guard')),
        { flat: 'memory_prefill_memory_guard' }));
    const tierSel = gsSelect('memory_guard_tier', L.res.tiers,
                             gsGet('memory','memory_guard_tier'));
    body.append(gsRow('res', L.res.tier, '', tierSel, { flat: 'memory_guard_tier' }));
    if (gsGet('memory','memory_guard_tier') === 'custom') {
        body.append(gsRow('res', L.res.custom, '',
            gsText('memory','memory_guard_custom_ceiling_gb',
                   'memory_guard_custom_ceiling_gb', L,
                   { number: true, min: 1, step: 1, placeholder: L.res.custom_ph }),
            { flat: 'memory_guard_custom_ceiling_gb' }));
    }

    // ---- Cache
    body.append(gsTitle('Cache'));
    body.append(gsRow('cache', L.cache.enabled, L.cache.enabled_hint,
        gsToggle('cache_enabled', gsGet('cache','enabled')),
        { flat: 'cache_enabled', badge: true }));
    body.append(gsRow('cache', L.cache.hot_only, L.cache.hot_only_hint,
        gsToggle('hot_cache_only', gsGet('cache','hot_cache_only')),
        { flat: 'hot_cache_only' }));
    body.append(gsRow('cache', L.cache.ssd_dir, '',
        gsText('cache','ssd_cache_dir','ssd_cache_dir', L),
        { flat: 'ssd_cache_dir' }));
    body.append(gsRow('cache', L.cache.ssd_max, L.cache.ssd_max_hint,
        gsText('cache','ssd_cache_max_size','ssd_cache_max_size', L,
               { placeholder: '64GB' }),
        { flat: 'ssd_cache_max_size' }));
    body.append(gsRow('cache', L.cache.hot_max, L.cache.hot_max_hint,
        gsText('cache','hot_cache_max_size','hot_cache_max_size', L,
               { placeholder: '8GB' }),
        { flat: 'hot_cache_max_size' }));

    // ---- MCP
    body.append(gsTitle('MCP'));
    body.append(gsRow('mcp', L.mcp.path, '',
        gsText('mcp','config_path','mcp_config', L, { placeholder: L.mcp.ph }),
        { badge: true, flat: 'mcp_config' }));
    body.append(gsRow('mcp', L.mcp.expose, L.mcp.expose_hint,
        gsToggle('mcp_expose_tools', gsGet('mcp','expose_tools')),
        { flat: 'mcp_expose_tools' }));

    // ---- Usage & Network
    body.append(gsTitle('Usage & Network'));
    body.append(gsRow('usage', L.usage.history, L.usage.history_hint,
        gsToggle('usage_history', gsGet('usage','usage_history')),
        { flat: 'usage_history' }));
    body.append(gsRow('net', L.net.hf_ep, L.net.hf_ep_hint,
        gsText('huggingface','endpoint','hf_endpoint', L,
               { placeholder: 'https://huggingface.co' }),
        { flat: 'hf_endpoint', badge: true }));
    body.append(gsRow('net', L.net.ms_ep, L.net.ms_ep_hint,
        gsText('modelscope','endpoint','ms_endpoint', L,
               { placeholder: 'https://www.modelscope.cn' }),
        { flat: 'ms_endpoint', badge: true }));
    body.append(gsRow('net', L.net.http_proxy, L.net.proxy_hint,
        gsText('network','http_proxy','network_http_proxy', L),
        { flat: 'network_http_proxy' }));
    body.append(gsRow('net', L.net.https_proxy, L.net.proxy_hint,
        gsText('network','https_proxy','network_https_proxy', L),
        { flat: 'network_https_proxy' }));
    body.append(gsRow('net', L.net.no_proxy, L.net.no_proxy_hint,
        gsText('network','no_proxy','network_no_proxy', L),
        { flat: 'network_no_proxy' }));
    body.append(gsRow('net', L.net.ca_bundle, L.net.ca_hint,
        gsText('network','ca_bundle','network_ca_bundle', L),
        { flat: 'network_ca_bundle', badge: true }));

    // ---- Advanced
    body.append(gsTitle('Advanced'));
    body.append(gsRow('adv', L.adv.distributed_enabled, L.adv.distributed_hint,
        gsToggle('distributed_inference_enabled',
                 gsGet('server','distributed_inference_enabled')),
        { flat: 'distributed_inference_enabled', badge: true }));
    body.append(gsRow('adv', L.adv.burst, L.adv.burst_hint,
        gsSelect('burst_decode_mode', L.adv.burst_opts,
                 gsGet('server','burst_decode_mode')),
        { flat: 'burst_decode_mode' }));
    body.append(gsRow('adv', L.adv.sse, L.adv.sse_hint,
        gsSelect('sse_keepalive_mode', L.adv.sse_opts,
                 gsGet('server','sse_keepalive_mode')),
        { flat: 'sse_keepalive_mode' }));
    body.append(gsRow('adv', L.adv.mid_sys, L.adv.mid_sys_hint,
        gsToggle('preserve_mid_system_cache', gsGet('server','preserve_mid_system_cache')),
        { flat: 'preserve_mid_system_cache' }));
    body.append(gsRow('adv', L.adv.audio, L.adv.audio_hint,
        gsText('server','max_audio_upload_size','max_audio_upload_size', L,
               { number: true, min: 1 }),
        { flat: 'max_audio_upload_size' }));
    body.append(gsRow('adv', L.adv.ane, L.adv.ane_hint,
        gsToggle('ane_compile_cache', gsGet('cache','ane_compile_cache')),
        { flat: 'ane_compile_cache' }));
    body.append(gsRow('adv', L.adv.wt, L.adv.wt_hint,
        gsToggle('hot_cache_write_through', gsGet('cache','hot_cache_write_through')),
        { flat: 'hot_cache_write_through' }));
    body.append(gsRow('adv', L.adv.blocks, L.adv.blocks_hint,
        gsText('cache','initial_cache_blocks','initial_cache_blocks', L,
               { number: true, min: 1 }),
        { flat: 'initial_cache_blocks' }));
    const gsel = gsSelect('gdn_snapshot_storage', L.adv.gdn_store_opts,
                          gsGet('cache','gdn_snapshot_storage'));
    body.append(gsRow('adv', L.adv.gdn_store, L.adv.gdn_store_hint, gsel,
        { flat: 'gdn_snapshot_storage' }));
    if (gsGet('cache','gdn_snapshot_storage') === 'ssd_sidecar') {
        body.append(gsRow('adv', L.adv.gdn_pend, L.adv.gdn_pend_hint,
            gsText('cache','gdn_ssd_pending_max_size','gdn_ssd_pending_max_size', L,
                   { placeholder: '512MB' }),
            { flat: 'gdn_ssd_pending_max_size' }));
        const prow = gsRow('adv', L.adv.gdn_prec, L.adv.gdn_prec_hint,
            gsSelect('gdn_sidecar_precision', L.adv.gdn_prec_opts,
                     gsGet('cache','gdn_sidecar_precision')),
            { flat: 'gdn_sidecar_precision' });
        if (['int8','rht_int8'].includes(gsGet('cache','gdn_sidecar_precision'))) {
            const w = document.createElement('small');
            w.className = 'fhint warn'; w.textContent = L.adv.gdn_prec_warning;
            prow.querySelector('.uname').append(w);
        }
        body.append(prow);
    }

    // group staged children into bordered section boxes; each gs-title
    // starts a new box. U5 fix (user round): the old CSS multicol
    // (column-width masonry) tore tall boxes apart — the fragment landed at
    // the top of the next column and pushed its boxes down (staggered column
    // tops that looked like a leftover banner). Boxes are now distributed by
    // JS into equal flex columns: balanced fill order is preserved (same
    // reading flow as column-fill:balance) but every column starts flush and
    // a box is never split.
    const wrap = $('gs-body');
    const wasDirty = Object.assign({}, gsDirty);
    wrap.textContent = '';
    wrap.classList.add('gs-wrap');
    const items = [];   // gs-boxes (and stray nodes) in document order
    let box = null, bbody = null, ord = 0;
    for (const n of Array.from(body.childNodes)) {
        if (n.nodeType === 1 && n.classList.contains('gs-title')) {
            box = document.createElement('div');
            box.className = 'gs-box';
            box.dataset.ord = ord++;   // stable order for resize re-layout
            const h = document.createElement('div');
            h.className = 'gs-box-title';
            h.textContent = n.textContent;
            bbody = document.createElement('div');
            bbody.className = 'gs-box-body';
            box.append(h, bbody);
            items.push(box);
        } else if (bbody) {
            bbody.append(n);
        } else {
            items.push(n);
        }
    }
    // column layout: JS-distributed flex columns (U5 fix — see above).
    gsLayoutColumns(items);
    // section header click scrolls to the SAVE bar (item 10); header also
    // carries the section dirty/restart state color (item 8)
    for (const h of wrap.querySelectorAll('.gs-box-title')) {
        h.classList.add('clickable');
        h.onclick = () => {
            const bar = document.getElementById('gs-savebar');
            if (bar) { bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                       const b = gsSaveBtn(); if (b) b.focus(); }
        };
    }
    // persistent SAVE / RESTART SERVER bar below the form (item 9/10)
    let bar = document.getElementById('gs-savebar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gs-savebar';
        bar.className = 'savebar';
        const changes = document.createElement('div');
        changes.id = 'gs-changes'; changes.className = 'changelist'; changes.hidden = true;
        const rowb = document.createElement('div'); rowb.className = 'savebar-row';
        const b = document.createElement('button');
        b.id = 'gs-save'; b.className = 'se-btn savebtn'; b.textContent = 'SAVE';
        b.onclick = gsSaveOrRestart;
        const clr = document.createElement('button');
        clr.id = 'gs-discard'; clr.className = 'se-btn'; clr.textContent = 'DISCARD';
        clr.onclick = () => {
            Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
            renderGlobalSettings(); gsUpdateSaveBtn(); renderDirtyList();
        };
        rowb.append(clr, b);
        bar.append(changes, rowb);
        wrap.parentElement.append(bar);
    }
    // re-apply still-queued dirty marks after re-render
    for (const flat of Object.keys(wasDirty)) {
        markFieldDirty(flat, wasDirty[flat]);
        // re-render rebuilds inputs from the server baseline; put the
        // queued (unsaved) value back so the edit stays visible while typing
        const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
        const ctl = row && (row.querySelector('input[type=checkbox]') || row.querySelector('select') || row.querySelector('input'));
        if (ctl) {
            if (ctl.type === 'checkbox') ctl.checked = !!wasDirty[flat];
            else ctl.value = wasDirty[flat] == null ? '' : wasDirty[flat];
        }
    }
    gsMarkSections();
    gsUpdateSaveBtn();
    renderDirtyList();
    const clrB = document.getElementById('gs-discard');
    if (clrB) clrB.style.display = Object.keys(gsDirty).length ? '' : 'none';
}

function gsLayoutColumns(forced) {
    // U5 fix: distribute section boxes into equal-width flex columns.
    // Balanced sequential fill reproduces the old column-fill:balance reading
    // order, but boxes never split and every column top is flush.
    const wrap = document.getElementById('gs-body');
    if (!wrap) return;
    let items = (forced && forced.length) ? forced.slice()
        : [...wrap.querySelectorAll('.gs-box')].sort((a, b) => (a.dataset.ord | 0) - (b.dataset.ord | 0));
    if (!items.length) return;
    // alternate box shading by GLOBAL index (nth-of-type restarts per column)
    items.forEach((it, i) => it.classList.toggle('alt', i % 2 === 1));
    for (const c of wrap.querySelectorAll('.gs-col')) c.remove();
    const gap = 14, cw = 380;
    const avail = wrap.clientWidth || (document.documentElement.clientWidth - 48);
    let nCols = Math.max(1, Math.floor((avail + gap) / (cw + gap)));
    nCols = Math.min(nCols, items.length);
    const colW = Math.floor((Math.min(avail, 1500) - gap * (nCols - 1)) / nCols);
    const cols = [];
    for (let i = 0; i < nCols; i++) {
        const d = document.createElement('div');
        d.className = 'gs-col'; d.style.width = colW + 'px';
        cols.push(d);
    }
    wrap.append(...cols);
    // measure pass: all boxes in col 0 — every column has the same width so
    // heights measured here are the heights they'll have in their final column
    for (const it of items) cols[0].append(it);
    const hs = items.map(it => it.offsetHeight + gap);
    const target = hs.reduce((a, b) => a + b, 0) / nCols;
    let ci = 0, acc = 0;
    for (let i = 0; i < items.length; i++) {
        cols[ci].append(items[i]);
        acc += hs[i];
        if (acc >= target && ci < nCols - 1 && i < items.length - (nCols - 1 - ci)) { ci++; acc = 0; }
    }
    if (!window.__gsResizeHooked) {
        window.__gsResizeHooked = true;
        let t = 0;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                if (document.querySelector('#gs-body.gs-wrap .gs-col')) gsLayoutColumns();
            }, 150);
        });
    }
}

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.status + ' ' + r.statusText);
    return d;
}
function taskRow(t) {
    const row = document.createElement('div'); row.className = 'urow usage';
    const st = (t.status || 'unknown').toUpperCase();
    // progress arrives as 0..100 already (hf/ms/oq task dicts) — classic does
    // Math.round(task.progress); the old x100 here showed "2280%"
    const pct = Math.round(t.progress || 0);
    const activeSt = ['downloading', 'quantizing', 'uploading'].includes((t.status || '').toLowerCase());
    // size column: downloaded/total while running (classic parity), final size when done
    const total = t.total_size || t.size || t.output_size || 0;
    const done = t.downloaded_size != null ? t.downloaded_size : (t.size || t.output_size || 0);
    const sizeTxt = activeSt && total
        ? `${C.fmtBytes(done)} / ${C.fmtBytes(total)}`
        : (t.size_formatted || C.fmtBytes(total));
    row.append(cell(t.name || t.model_name || t.repo_id || t.model || t.model_path || '—'),
               cell(t.dest || t.target_repo || ''),
               cell(st + (activeSt ? ` ${Math.min(pct, 100)}%` : '')),
               cell(t.error || sizeTxt));
    return row;
}
function renderTasks(hostId, kind) {
    fetchJson(`${API}/admin/api/${kind}/tasks`).then(d => {
        const host = $(hostId);
        host.innerHTML = '';
        const tasks = d.tasks || [];
        if (!tasks.length) { host.innerHTML = '<div class="empty">No tasks</div>'; return; }
        let active = false;
        for (const t of tasks) {
            const r = taskRow(t);
            // API field is task_id (older mock data used id) — a wrong value
            // here POSTed /cancel/undefined and the control silently failed
            const tid = t.task_id || t.id;
            // controls render as real buttons in the house action column so
            // they align right with the other row actions (they used to be
            // bare spans wrapping onto a stray grid track at bottom-left)
            const acts = document.createElement('span'); acts.className = 'rowacts';
            const mkAct = (label, title, fn) => {
                const x = document.createElement('button');
                x.className = 'se-btn act'; x.textContent = label; x.title = title;
                x.onclick = fn; acts.append(x);
            };
            if (['downloading', 'quantizing', 'uploading', 'queued', 'pending'].includes(t.status)) {
                active = true;
                mkAct('CANCEL', 'Stop this task', () => postJson(`${API}/admin/api/${kind}/cancel/${tid}`, {})
                    .then(() => renderTasks(hostId, kind)).catch(e => toast('cancel: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            } else if (kind === 'hf' && ['failed', 'cancelled', 'canceled', 'error'].includes((t.status || '').toLowerCase())) {
                // U11 parity: classic offers retry (resumes partial files)
                mkAct('RETRY', 'Resume this download from existing files', () =>
                    postJson(`${API}/admin/api/hf/retry/${tid}`,
                        { hf_token: ($('dl-token') ? $('dl-token').value.trim() : '') })
                        .then(() => renderTasks(hostId, kind)).catch(e => toast('retry: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            }
            host.append(r);
        }
        if (active) {   // gentle live progress while an entry is still running
            setTimeout(() => {
                const card = host.closest('section');
                if (card && card.style.display !== 'none' && !document.hidden)
                    renderTasks(hostId, kind);
            }, 2000);
        }
    }).catch(e => emptyMsg($(hostId), e.message));
}

let dlInit = false;
const DL = {
    tab: 'trending',                 // trending | popular | search
    rec: { trending: null, popular: null },   // cached suggested lists
    search: [],
    page: { trending: 1, popular: 1, search: 1 },
    size: 10,
    sort: { key: 'rank', dir: 1 },   // client column sort (classic parity)
    q: '',
    busy: false,
};
function dlPageSize() {
    // classic parity: fit ~10..30 rows in the available window height
    const h = window.innerHeight || 800;
    return Math.max(10, Math.min(30, Math.floor((h - 320) / 34 / 10) * 10 || 10));
}
function dlSortModels(list, key, dir, fallbackKey) {
    const rows = list.slice();
    if (key === 'rank' || !key) {
        if (fallbackKey) rows.sort((a, b) => (b[fallbackKey] || 0) - (a[fallbackKey] || 0));
        return rows;
    }
    rows.sort((a, b) => {
        let x = a[key], y = b[key];
        if (key === 'name') { x = (x || '').toLowerCase(); y = (y || '').toLowerCase();
            return dir * (x < y ? -1 : x > y ? 1 : 0); }
        if (key === 'size') { x = a.size || 0; y = b.size || 0; }
        if (key === 'params') { x = a.params || 0; y = b.params || 0; }
        if (x == null) x = -Infinity; if (y == null) y = -Infinity;
        return dir * (x - y);
    });
    return rows;
}
function initDownloader() {
    const $dl = id => document.getElementById(id);
    const token = () => ($dl('dl-token') || {}).value?.trim() || '';
    const queueDownload = (repoId, fromBtn) => {
        if (!repoId) { toast(C.t('uplift.toast.repo_id_required')); return; }
        if (fromBtn) { fromBtn.disabled = true; fromBtn.textContent = 'queued…'; }
        postJson(`${API}/admin/api/hf/download`,
            { repo_id: repoId, hf_token: token() }).then(r => {
                // live: {success, task:{task_id}} · shadow: {task_id}
                const tid = (r.task && r.task.task_id) || r.task_id || r.id || '';
                toast(C.t('uplift.toast.download_queued', {repo: repoId}) + (tid ? ` #${String(tid).slice(0, 8)}` : ''));
                renderTasks('dl-tasks', 'hf');
            }).catch(e => { toast('download: ' + e.message);
                if (fromBtn) { fromBtn.disabled = false; fromBtn.textContent = 'download'; } });
    };
    function setTab(tab) {
        DL.tab = tab;
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t); if (b) b.classList.toggle('on', t === tab);
        }
        DL.page[tab] = DL.page[tab] || 1;
        if (tab === 'search' && !DL.search.length && DL.q) doSearch();
        renderDlPage();
    }
    function renderDlPage() {
        const host = $dl('dl-results'); if (!host) return;
        const sub = $dl('dl-sub');
        host.innerHTML = '';
        const list = DL.tab === 'search' ? DL.search : DL.rec[DL.tab];
        if (list == null) { host.innerHTML = '<div class="empty">Loading suggestions…</div>'; return; }
        if (!list.length) {
            host.innerHTML = '<div class="empty">' + (DL.tab === 'search' ? 'No results — try another query.' : 'HF suggested models unavailable.') + '</div>';
            const pg = $dl('dl-pager'); if (pg) pg.innerHTML = '';
            return;
        }
        const fallback = DL.tab === 'popular' ? 'downloads' : 'trending_score';
        const rows = dlSortModels(list, DL.sort.key, DL.sort.dir, DL.tab === 'search' ? null : fallback);
        DL.size = dlPageSize();
        const pages = Math.max(1, Math.ceil(rows.length / DL.size));
        if (DL.page[DL.tab] > pages) DL.page[DL.tab] = pages;
        const start = (DL.page[DL.tab] - 1) * DL.size;
        // header (sortable, classic parity)
        const cols = [['rank', '#'], ['name', 'Model'], ['params', 'Params'],
                      ['size', 'Size'], ['downloads', 'Downloads'], ['likes', 'Likes'], [null, '']];
        const head = document.createElement('div'); head.className = 'urow usage head';
        for (const [key, label] of cols) {
            const s = cell(label + (DL.sort.key === key && key ? (DL.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
            if (key) { s.className = 'sortable' + (DL.sort.key === key ? ' sorted' : '');
                s.onclick = () => {
                    if (DL.sort.key === key) DL.sort.dir = -DL.sort.dir;
                    else { DL.sort.key = key; DL.sort.dir = (key === 'name' || key === 'rank') ? 1 : -1; }
                    renderDlPage();
                };
            }
            head.append(s);
        }
        host.append(head);
        for (const m of rows.slice(start, start + DL.size)) {
            const row = document.createElement('div'); row.className = 'urow usage';
            const rank = cell(m.rank ? '#' + m.rank : '');
            const name = cell(m.name || m.repo_id); name.className = 'uname';
            name.title = m.repo_id;
            row.append(rank, name,
                cell(m.params_formatted || (m.params ? C.fmtNumber(m.params) : '')),
                cell(m.size_formatted || C.fmtBytes(m.size || 0)),
                cell(m.downloads != null ? C.fmtNumber(m.downloads) : ''),
                cell(m.likes != null ? C.fmtNumber(m.likes) : ''));
            const act = document.createElement('span'); act.className = 'rowacts';
            const b = document.createElement('button');
            b.className = 'se-btn act'; b.textContent = 'download';
            b.onclick = () => queueDownload(m.repo_id, b);
            act.append(b); row.append(act);
            host.append(row);
        }
        if (sub) {
            const extra = DL.tab === 'search' ? `“${DL.q}”` : (DL.rec.trending && true ? 'suggested by HF' : '');
            const inv = (DL._invalid || DL.rec._invalid) ? ' · HF token rejected — listed anonymously' : '';
            sub.textContent = `${rows.length} results ${extra}${inv}`;
        }
        // pager
        const pg = $dl('dl-pager'); if (!pg) return;
        pg.innerHTML = '';
        if (pages <= 1) return;
        const mk = (label, page, dis) => {
            const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis;
            b.onclick = () => { DL.page[DL.tab] = page; renderDlPage();
                $dl('dl-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
            pg.append(b);
        };
        mk('«', 1, DL.page[DL.tab] === 1);
        mk('‹', DL.page[DL.tab] - 1, DL.page[DL.tab] === 1);
        mk('›', DL.page[DL.tab] + 1, DL.page[DL.tab] === pages);
        mk('»', pages, DL.page[DL.tab] === pages);
        const info = document.createElement('span'); info.className = 'pinfo';
        info.textContent = `${DL.page[DL.tab]} / ${pages} · ${rows.length} models`;
        pg.append(info);
    }
    // safe empty-state (server error text goes through textContent, never innerHTML)
    function setEmpty(msg) {
        const host = $dl('dl-results'); if (!host) return;
        host.innerHTML = '';
        const d = document.createElement('div'); d.className = 'empty'; d.textContent = msg;
        host.append(d);
    }
    function loadRecommended(force) {
        if (DL.busy) return;
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        if (!force && DL.rec.trending && DL.rec._mlx === mlx) { renderDlPage(); return; }
        DL.busy = true;
        fetchJson(`${API}/admin/api/hf/recommended?mlx_only=${mlx}`).then(d => {
            DL.rec = {
                trending: (d.trending || []).map((m, i) => ({ ...m, rank: i + 1 })),
                popular: (d.popular || []).map((m, i) => ({ ...m, rank: i + 1 })),
                _mlx: mlx,
            };
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            if (DL.tab !== 'search') { DL.page[DL.tab] = 1; DL.sort = { key: 'rank', dir: 1 }; }
            renderDlPage();
        }).catch(e => {
            DL.busy = false;
            DL.rec.trending = DL.rec.trending || [];
            DL.rec.popular = DL.rec.popular || [];
            const host = $dl('dl-results');
            if (host && DL.tab !== 'search') setEmpty('Suggestions failed: ' + e.message);
        });
    }
    function doSearch() {
        const q = ($dl('dl-q') || {}).value?.trim();
        if (!q) { toast(C.t('uplift.toast.type_query')); return; }
        const sort = $dl('dl-sort').value || 'trending';
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        DL.q = q; DL.busy = true;
        const sub = $dl('dl-sub'); if (sub) sub.textContent = 'searching…';
        const host = $dl('dl-results'); if (host) host.innerHTML = '<div class="empty">Searching huggingface.co…</div>';
        fetchJson(`${API}/admin/api/hf/search?q=${encodeURIComponent(q)}&limit=100&sort=${sort}&mlx_only=${mlx}`).then(d => {
            DL.search = (d.models || []).map((m, i) => ({ ...m, rank: i + 1 }));
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            DL.page.search = 1; DL.sort = { key: 'rank', dir: 1 };
            setTab('search');
        }).catch(e => {
            DL.busy = false; DL.search = [];
            if (sub) sub.textContent = '';
            setEmpty('Search failed: ' + e.message);
        });
    }
    if (!dlInit) {
        dlInit = true;
        // token: persisted in this browser only (user preference: localStorage)
        const tk = $dl('dl-token');
        try { tk.value = localStorage.getItem('uplift.hf_token') || ''; } catch (_) {}
        tk.addEventListener('change', () => {
            try { localStorage.setItem('uplift.hf_token', tk.value.trim()); } catch (_) {}
        });
        $dl('dl-go').onclick = doSearch;
        $dl('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        $dl('dl-sort').onchange = () => { if (DL.tab === 'search' && DL.q) doSearch(); };
        $dl('dl-mlx').onchange = () => {
            if (DL.tab === 'search') doSearch(); else loadRecommended(true);
        };
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t);
            if (b) b.onclick = () => {
                if (t === 'search' && !DL.q) { toast(C.t('uplift.toast.type_query_press_search')); $dl('dl-q').focus(); return; }
                setTab(t);
            };
        }
        $dl('dl-direct').onclick = () => queueDownload($dl('dl-repo').value.trim(), $dl('dl-direct'));
        $dl('dl-repo').addEventListener('keydown', e => {
            if (e.key === 'Enter') queueDownload($dl('dl-repo').value.trim()); });
    }
    if (DL.tab === 'search' && DL.search.length) renderDlPage();
    else loadRecommended();
    renderTasks('dl-tasks', 'hf');
}

/* ---- oQ quantizer: faithful port of the classic page's form.
   All option lists come from the server (/oq/models); the candidate
   filters mirror oqSensitivityModelCandidates / oqMtpAssistantCandidates
   in dashboard.js; estimate mirrors oqRefreshEstimate (300 ms debounce,
   preserve_mtp param) including the client-side sensitivity-model memory
   approximation (size x 1.5 + 5 GB). Labels from models.oq.* in i18n. -- */
const OQ_LEVELS = [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8];
function oqMtpFamily(t) {
    if (!t) return null;
    if (t.startsWith('qwen3_6')) return 'qwen3_6';
    if (t.startsWith('qwen3_5')) return 'qwen3_5';
    return null;
}
function qzField(host, label, ctl, hint) {
    const row = document.createElement('label');
    row.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    row.append(t);
    if (ctl) row.append(ctl);
    if (hint) { const h = document.createElement('small'); h.textContent = hint; row.append(h); }
    host.append(row);
    return row;
}
function qzSelect(placeholder) {
    const sel = document.createElement('select');
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.append(o);
    return sel;
}

function renderQuantizer() {
    const host = $('qz-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        host.append(g);

        const st = { all: [], models: [] };
        const selModel = qzSelect('Select a model...');
        qzField(g, 'Source Model', selModel, 'full precision only');
        const rowSens = qzField(g, 'Sensitivity Model', null,
            'Use a quantized version of the source model to analyze layer sensitivity with ~4x less memory.');
        const selSens = qzSelect('None (use source model)');
        rowSens.insertBefore(selSens, rowSens.querySelector('small'));
        const selLevel = qzSelect(null);
        selLevel.remove(0);
        for (const l of OQ_LEVELS) {
            const o = document.createElement('option');
            o.value = l; selLevel.append(o);
        }
        selLevel.value = '4';
        const rowLevel = qzField(g, 'oQ Level', selLevel);
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start';
        g.append(rowLevel);

        // enhanced (oQe) block
        const cbEnh = document.createElement('input'); cbEnh.type = 'checkbox';
        qzField(g, 'Enhanced quantization (oQe)', cbEnh,
            'Use imatrix calibration to weight affine quantization by activation importance.');
        const rowEnhOnly = document.createElement('div');
        rowEnhOnly.className = 'qz-enh-only'; rowEnhOnly.hidden = true;
        const cbReuse = document.createElement('input'); cbReuse.type = 'checkbox'; cbReuse.checked = true;
        qzField(rowEnhOnly, 'Reuse imatrix cache', cbReuse,
            'Use a compatible cached imatrix when available; otherwise collect a new one.');
        const inpCache = document.createElement('input');
        inpCache.type = 'text'; inpCache.placeholder = 'Automatic';
        qzField(rowEnhOnly, 'Imatrix cache path', inpCache);
        const cbStrict = document.createElement('input'); cbStrict.type = 'checkbox';
        qzField(rowEnhOnly, 'Strict imatrix coverage', cbStrict,
            'Fail when a quantized tensor has no matching imatrix entry instead of falling back.');
        g.append(rowEnhOnly);

        // advanced block
        const adv = document.createElement('div');
        adv.className = 'qz-adv';
        const advT = document.createElement('div');
        advT.className = 'qz-adv-title'; advT.textContent = 'Advanced Settings';
        adv.append(advT);
        const dtypes = document.createElement('div');
        dtypes.className = 'qz-toggle';
        const dtype = { v: 'bfloat16' };
        for (const d of ['bfloat16', 'float16']) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = d;
            b.className = d === dtype.v ? 'on' : '';
            b.onclick = () => {
                dtype.v = d;
                for (const x of dtypes.children) x.classList.toggle('on', x.textContent === d);
            };
            dtypes.append(b);
        }
        qzField(adv, 'Non-quant weight dtype', dtypes,
            'float16 gives ~20% faster prefill on M1/M2 Apple Silicon (native fp16). bfloat16 is safer for newer models.').dataset.k = 'dtype';
        const cbMtp = document.createElement('input'); cbMtp.type = 'checkbox';
        const rowMtp = qzField(adv, 'Preserve MTP weights', cbMtp,
            'Keep mtp.* tensors and config fields in the output model so the Lightning MTP drafter still works.');
        const mtpNa = document.createElement('small');
        mtpNa.className = 'warn-text'; mtpNa.textContent = 'Source model has no MTP heads.';
        mtpNa.hidden = true; rowMtp.append(mtpNa);
        const selCombine = qzSelect('None');
        const rowCombine = qzField(adv, 'Combine other model\u2019s MTP head', selCombine,
            'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).');
        const cbText = document.createElement('input'); cbText.type = 'checkbox';
        const rowText = qzField(adv, 'Text only', cbText);
        const vlmWarn = document.createElement('small');
        vlmWarn.className = 'warn-text';
        vlmWarn.textContent = C.tf('uplift.ui.selected_model_is_a_vlm_vision_tower_will_be_ski', 'Selected model is a VLM — vision tower will be skipped.');
        vlmWarn.hidden = true; rowText.append(vlmWarn);
        g.append(adv);

        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '\u2014';
        g.append(est, start);

        const levelLabel = l => 'oQ' + l + (cbEnh.checked ? 'e' : '');
        const refreshLevelLabels = () => {
            for (const o of selLevel.options) o.textContent = levelLabel(o.value);
        };

        let estTimer = null;
        function refreshEst() {
            clearTimeout(estTimer);
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { est.textContent = '\u2014'; return; }
            estTimer = setTimeout(() => {
                const params = new URLSearchParams({
                    model_path: m.path, oq_level: selLevel.value,
                    preserve_mtp: (m.has_mtp_heads && cbMtp.checked) ? 'true' : 'false',
                });
                fetchJson(`${API}/admin/api/oq/estimate?${params}`).then(e => {
                    let mem = e.memory_streaming_formatted || '';
                    const sens = st.all.find(x => x.path === selSens.value);
                    if (sens) {   // client-side approximation, same as classic page
                        const bytes = Math.round(sens.size * 1.5) + 5 * 1024 ** 3;
                        mem = bytes > 1024 ** 3
                            ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
                            : Math.round(bytes / 1024 ** 2) + ' MB';
                    }
                    est.textContent = `est: ${e.output_size_formatted || C.fmtBytes(e.output_size_bytes)}` +
                        ` \u00b7 ${e.effective_bpw} bpw \u00b7 stream ${mem}`;
                }).catch(err => { est.textContent = 'estimate: ' + err.message; });
            }, 300);
        }

        function fill(sel, items, label) {
            const keep = sel.value;
            for (const o of [...sel.options].slice(1)) o.remove();
            for (const m of items) {
                const o = document.createElement('option');
                o.value = m.path; o.textContent = label(m);
                sel.append(o);
            }
            sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
        }

        function updateConditional() {
            const m = st.models.find(x => x.path === selModel.value);
            // sensitivity candidates: quantized, same model_type, not the source
            const sens = m ? st.all.filter(x => x.path !== m.path && x.is_quantized &&
                x.model_type === m.model_type) : [];
            fill(selSens, sens, x => `${x.name} (${x.size_formatted})`);
            rowSens.hidden = sens.length === 0;
            // preserve MTP availability
            const hasMtp = !!(m && m.has_mtp_heads);
            cbMtp.disabled = !hasMtp;
            if (!hasMtp) cbMtp.checked = false;
            mtpNa.hidden = hasMtp || !m;
            // MTP donor / gemma4 assistant candidates (mirror the classic filter)
            let comb = [];
            if (m && m.model_type === 'gemma4') {
                comb = st.all.filter(x => x.model_type === 'gemma4_assistant');
                rowCombine.querySelector('span').textContent = 'Combine assistant model as MTP head';
                rowCombine.querySelector('small').textContent =
                    'Merge a separate gemma4_assistant checkpoint into the output as a Lightning MTP head.';
            } else if (m && oqMtpFamily(m.model_type) && !(hasMtp && cbMtp.checked)) {
                comb = st.all.filter(x => x.path !== m.path && x.has_mtp_heads &&
                    oqMtpFamily(x.model_type) === oqMtpFamily(m.model_type) &&
                    (!x.hidden_size || !m.hidden_size || x.hidden_size === m.hidden_size));
                rowCombine.querySelector('span').textContent = 'Combine other model\u2019s MTP head';
                rowCombine.querySelector('small').textContent =
                    'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).';
            }
            fill(selCombine, comb, x => `${x.name} (${x.size_formatted})`);
            rowCombine.hidden = comb.length === 0;
            // VLM text-only warning
            vlmWarn.hidden = !(m && m.is_vlm && cbText.checked);
            refreshEst();
        }

        fetchJson(`${API}/admin/api/oq/models`).then(d => {
            st.all = d.all_models || d.models || [];
            st.models = st.all.filter(m => !m.is_quantized);
            fill(selModel, st.models,
                m => `${m.source_repo_id || m.name} (${m.size_formatted})`);
            $('qz-sub').textContent = `${st.models.length} quantizable models`;
            refreshLevelLabels();
            updateConditional();
        }).catch(e => emptyMsg(host, e.message));

        selModel.onchange = updateConditional;
        selSens.onchange = refreshEst;
        selLevel.onchange = refreshEst;
        cbMtp.onchange = () => { updateConditional(); };
        cbText.onchange = updateConditional;
        cbEnh.onchange = () => {
            rowEnhOnly.hidden = !cbEnh.checked;
            refreshLevelLabels();     // labels gain the 'e' suffix, like the classic page
            refreshEst();
        };

        start.onclick = () => {
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { toast(C.t('uplift.toast.select_a_model')); return; }
            const donor = st.all.find(x => x.path === selCombine.value);
            start.disabled = true;
            const payload = {
                model_path: m.path,
                oq_level: parseFloat(selLevel.value),
                group_size: 64,
                sensitivity_model_path: selSens.value || '',
                text_only: cbText.checked,
                dtype: dtype.v,
                preserve_mtp: m.has_mtp_heads ? cbMtp.checked : false,
                mtp_assistant_model_path: donor ? donor.path : '',
            };
            if (cbEnh.checked) {
                payload.enhanced = true;
                payload.imatrix_reuse_cache = cbReuse.checked;
                payload.imatrix_cache_path = inpCache.value.trim();
                payload.imatrix_strict = cbStrict.checked;
            }
            postJson(`${API}/admin/api/oq/start`, payload).then(() => {
                toast(`quantize queued${GW_LIVE ? '' : ' (shadow)'}: ` + m.name);
                renderTasks('qz-tasks', 'oq');
            }).catch(e => toast('quantize: ' + e.message))
              .finally(() => { start.disabled = false; });
        };
    }
    renderTasks('qz-tasks', 'oq');
}


/* ---- oQ uploader: faithful port. Token -> validate-token (shadow:
   never forwarded, so a real token is never leaked to the real server's
   response path; username/orgs are simulated), model list comes from
   upload/oq-models, upload opens the same modal fields as the classic
   page (repo name prefilled namespace/name, README source, re-download
   notice only when no README source, private). -- */
function renderUploader() {
    const host = $('up-form');
    if (host.dataset.built) { renderTasks('up-tasks', 'upload'); return; }
    host.dataset.built = '1';
    host.innerHTML = '';
    const st = { validated: false, ns: '', models: [] };
    const g = document.createElement('div');
    g.className = 'qz-form';
    host.append(g);
    const tokWrap = document.createElement('div');
    tokWrap.className = 'qz-inline';
    const tok = document.createElement('input');
    tok.type = 'password'; tok.placeholder = 'Enter HF write token (hf_...)';
    const vbtn = document.createElement('button');
    vbtn.className = 'se-btn'; vbtn.textContent = 'Validate';
    const vmsg = document.createElement('span');
    vmsg.className = 'stat-sub';
    tokWrap.append(tok, vbtn, vmsg);
    qzField(g, 'HuggingFace Token', tokWrap);
    const list = document.createElement('div');
    list.className = 'admin-table';
    const listT = document.createElement('div');
    listT.className = 'se-hint'; listT.textContent = 'oQ Models';
    host.append(listT, list);
    const tasksT = document.createElement('h3');
    tasksT.textContent = C.tf('uplift.ui.upload_queue', 'Upload Queue'); tasksT.style.margin = '16px 0 6px';

    function loadModels() {
        fetchJson(`${API}/admin/api/upload/oq-models`).then(d => {
            st.models = d.oq_models || [];
            $('up-sub').textContent = `${st.models.length} oQ models`;
            list.innerHTML = '';
            if (!st.models.length) { list.innerHTML = '<div class="empty">No oQ models found in model directories.</div>'; return; }
            for (const m of st.models) {
                const row = document.createElement('div'); row.className = 'urow usage';
                const name = cell(m.name); name.className = 'uname';
                row.append(name, cell(m.size_formatted || C.fmtBytes(m.size || 0)));
                const act = document.createElement('span'); act.className = 'rowacts';
                const b = document.createElement('button');
                b.className = 'se-btn act'; b.textContent = 'upload';
                b.disabled = !st.validated;
                b.onclick = () => uploadModal(m);
                act.append(b); row.append(act);
                list.append(row);
            }
            vbtn.disabledMsg = null;
        }).catch(e => emptyMsg(list, e.message));
    }

    vbtn.onclick = () => {
        if (!tok.value.trim()) { vmsg.textContent = C.tf('uplift.ui.invalid_token_ensure_it_has_write_access', 'Invalid token. Ensure it has write access.'); return; }
        vbtn.disabled = true; vmsg.textContent = 'Validating...';
        postJson(`${API}/admin/api/upload/validate-token`, { hf_token: tok.value.trim() })
            .then(d => {
                st.validated = true; st.ns = d.username || 'you';
                vmsg.textContent = C.tf('uplift.ui.authenticated_as', 'Authenticated as ') + st.ns;
                tok.value = tok.value;   // stays in the browser only
                loadModels();
            })
            .catch(e => { st.validated = false; vmsg.textContent = e.message; })
            .finally(() => { vbtn.disabled = false; });
    };
    tok.addEventListener('keydown', e => { if (e.key === 'Enter') vbtn.onclick(); });

    function uploadModal(m) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const box = document.createElement('div');
        box.className = 'modal nasa';
        const h = document.createElement('h3'); h.textContent = 'Upload to HuggingFace';
        const repo = document.createElement('input');
        repo.type = 'text'; repo.value = st.ns + '/' + m.name;
        const readme = qzSelect('Auto-generate basic README');
        const rdSel = document.createElement('div');
        rdSel.append(readme);   // only auto-README is meaningful in the sandbox
        const cbRe = document.createElement('input'); cbRe.type = 'checkbox';
        const cbPr = document.createElement('input'); cbPr.type = 'checkbox';
        const bCancel = document.createElement('button'); bCancel.textContent = 'Cancel';
        const bGo = document.createElement('button'); bGo.className = 'danger'; bGo.textContent = 'Upload';
        bCancel.onclick = () => overlay.remove();
        bGo.onclick = () => {
            if (!repo.value.trim()) { toast(C.t('uplift.toast.repo_name_required')); return; }
            bGo.disabled = true;
            postJson(`${API}/admin/api/upload/start`, {
                model_path: m.path, repo_id: repo.value.trim(), hf_token: tok.value.trim(),
                readme_source_path: '', auto_readme: true,
                redownload_notice: cbRe.checked, private: cbPr.checked,
            }).then(() => {
                toast(`upload queued${GW_LIVE ? '' : ' (shadow)'}: ` + repo.value.trim());
                overlay.remove();
                renderTasks('up-tasks', 'upload');
            }).catch(e => toast('upload: ' + e.message))
              .finally(() => { bGo.disabled = false; });
        };
        const bar = document.createElement('div');
        bar.className = 'row buttons';
        bar.append(document.createElement('span'), bCancel, bGo);
        qzField(box, 'Repository Name', repo);
        qzField(box, 'README Source', rdSel);
        qzField(box, 'Show re-download notice', cbRe,
            'Add a notice at the top of README asking previous users to re-download');
        qzField(box, 'Private Repository', cbPr);
        box.append(h, bar);
        overlay.append(box);
        overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
        document.body.append(overlay);
    }

    vmsg.textContent = C.tf('uplift.ui.enter_a_token_to_list_uploadable_oq_models', 'Enter a token to list uploadable oQ models.');
    renderTasks('up-tasks', 'upload');
}

/* ------- stored settings: prune dialog (the list merged into Models) ---- */

async function openPruneDialog() {
    let orphans = [];
    try {
        const idx = await fetchJson(`${API}/admin/api/model-settings-index`);
        orphans = idx.orphans || [];
    } catch (err) { toast('prune check failed: ' + err.message); return; }
    if (!orphans.length) { toast(C.t('uplift.toast.nothing_to_prune')); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = `Prune model settings (${orphans.length})`;
    const sub = document.createElement('div');
    sub.className = 'se-hint';
    sub.textContent = C.tf('uplift.ui.stored_configuration_for_models_that_no_longer_e', 'Stored configuration for models that no longer exist on disk. ')
        + (GW_LIVE
            ? 'Removed entries are deleted from this server\'s model_settings.json.'
            : 'Removed entries are deleted from the sandbox model_settings.json.');
    const list = document.createElement('div');
    list.className = 'prune-list';
    const checks = orphans.map(id => {
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = id;
        lbl.append(cb, cell(id));
        list.append(lbl);
        return cb;
    });
    const bar = document.createElement('div');
    bar.className = 'row buttons';
    const all = document.createElement('button');
    all.textContent = C.tf('uplift.ui.select_all', 'Select all');
    all.onclick = () => checks.forEach(c => c.checked = true);
    const none = document.createElement('button');
    none.textContent = C.tf('uplift.ui.select_none', 'Select none');
    none.onclick = () => checks.forEach(c => c.checked = false);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    const doIt = document.createElement('button');
    doIt.className = 'danger';
    doIt.textContent = C.tf('uplift.ui.prune_selected', 'Prune selected');
    doIt.onclick = async () => {
        const ids = checks.filter(c => c.checked).map(c => c.value);
        if (!ids.length) { toast(C.t('uplift.toast.nothing_selected')); return; }
        try {
            const r = await postJson(`${API}/admin/api/prune-model-settings`, { ids });
            toast(`Pruned ${r.removed.length} setting record(s)` +
                (r.removed_templates && r.removed_templates.length
                    ? `, ${r.removed_templates.length} template(s)` : ''));
            overlay.remove();
            renderModelAdmin(true);
        } catch (err) { toast('prune failed: ' + err.message); }
    };
    bar.append(all, none, document.createElement('span'), cancel, doIt);
    box.append(h, sub, list, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.append(overlay);
}
$('btn-prune').onclick = openPruneDialog;




/* ---------------- models sub-page: helper models -------- */
/* used_by resolver: overlay route provides row.used_by; vanilla rows lack
   it but carry their full settings dict — derive the reverse map here so
   the page works identically against a vanilla upstream. */
function usedBy(m) {
    if (Array.isArray(m.used_by)) return m.used_by;
    const users = new Set();
    for (const x of adminModels || []) {
        if (x.id === m.id) continue;
        const s = x.settings || {};
        for (const k of ['specprefill_draft_model', 'dflash_draft_model',
                         'vlm_mtp_draft_model'])
            if (s[k] === m.id) users.add(x.id);
    }
    return [...users].sort();
}

async function renderHelperModels() {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (e) { emptyMsg($('hm-list'), e.message); return; }
    const mk = models.filter(m => m.engine_type === 'markitdown' || m.model_type === 'markitdown');
    const helpers = models.filter(m => !mk.includes(m) && (m.is_helper ||
        /dflash|assistant/i.test(m.id)));
    $('hm-sub').textContent = `${helpers.length} helpers · ${mk.length} markitdown`;
    $('hm-sub').dataset.count = helpers.length;

    // Integrations, same fields / labels / conditionals as the classic
    // Settings -> Integrations tab. MarkItDown gets the special box at the
    // top (separate role gets separate space), then Web Search, then the
    // helper model list.
    const box = $('hm-markitdown');
    box.textContent = '';
    let integ = {};
    let modelList = [];
    try {
        integ = (await fetchJson(`${API}/admin/api/global-settings`)).integrations || {};
    } catch (_) {}
    modelList = models;

    // save exactly like classic saveIntegrationSettings(): flat body where
    // ONLY the CLI-assistant keys carry the integrations_ prefix; markitdown_*
    // and web_search_* are sent bare (real oMLX drops unknown fields with a
    // silent success:true, so a blanket prefix looked saved but did nothing).
    const INTEG_PREFIXED = new Set(['copilot_model', 'codex_model', 'opencode_model',
        'openclaw_model', 'hermes_model', 'pi_model', 'openclaw_tools_profile']);
    async function saveIntegration(overrides) {
        Object.assign(integ, overrides || {});
        const body = {};
        for (const [k, v] of Object.entries(integ))
            body[INTEG_PREFIXED.has(k) ? 'integrations_' + k : k] = v;
        try {
            const r = await fetch(`${API}/admin/api/global-settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const res = await r.json().catch(() => ({}));
            if (res.success === false) throw new Error(res.message || 'rejected');
            toast(C.t('uplift.toast.integration_saved'));
            return true;
        } catch (err) { toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
    }
    function integField(label, hint, control) {
        const f = document.createElement('label');
        f.className = 'field';
        const lab = document.createElement('span');
        lab.textContent = label;
        f.append(lab, control);
        if (hint) {
            const h = document.createElement('small');
            h.className = 'fhint dim'; h.textContent = hint;
            f.append(h);
        }
        return f;
    }
    function integSelect(opts, val, onchange) {
        const sel = document.createElement('select');
        for (const [v, t] of opts) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            sel.append(o);
        }
        sel.value = val;
        sel.onchange = () => onchange(sel.value);
        return sel;
    }
    function integNumber(key, min, max) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = min; inp.max = max;
        inp.value = integ[key] ?? '';
        inp.onchange = async () => {
            const v = Number(inp.value);
            if (await saveIntegration({ [key]: v })) renderHelperModels();
        };
        return inp;
    }

    /* ---- MarkItDown box ---- */
    const mkCard = document.createElement('div');
    mkCard.className = 'mk-box';
    const head = document.createElement('div');
    head.className = 'mk-head';
    const title = document.createElement('div');
    title.className = 'mk-title';
    title.textContent = 'MarkItDown';
    head.append(title);
    for (const m of mk) {
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : 'off');
        state.textContent = m.loaded ? 'LOADED' : 'IDLE';
        head.append(state);
    }
    mkCard.append(head);
    const mkGrid = document.createElement('div');
    mkGrid.className = 'mk-fields';

    const enabledInp = document.createElement('input');
    enabledInp.type = 'checkbox';
    enabledInp.checked = !!integ.markitdown_enabled;
    enabledInp.onchange = async () => {
        if (await saveIntegration({ markitdown_enabled: enabledInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Enable MarkItDown',
        'Preprocess supported file attachments before LLM requests.', enabledInp));

    const exposeInp = document.createElement('input');
    exposeInp.type = 'checkbox';
    exposeInp.checked = !!integ.markitdown_expose_model;
    exposeInp.disabled = !integ.markitdown_enabled;
    exposeInp.onchange = async () => {
        if (await saveIntegration({ markitdown_expose_model: exposeInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Show as model',
        'Expose MarkItDown in model lists for direct Markdown conversion requests.', exposeInp));

    mkGrid.append(integField('Max file size (MB)',
        'Reject larger document attachments before conversion.',
        integNumber('markitdown_max_file_size_mb', 1, 1024)));
    mkGrid.append(integField('Max files per request',
        'Limit document attachments converted in one request.',
        integNumber('markitdown_max_files_per_request', 1, 50)));

    // pdf engine: MarkItDown + OCR-capable models (classic: config_model_type contains 'ocr')
    const pdfOpts = [['markitdown', 'MarkItDown']];
    for (const m of modelList)
        if (String(m.config_model_type || '').toLowerCase().includes('ocr'))
            pdfOpts.push([m.id, m.id]);
    const pdfSel = integSelect(pdfOpts, integ.markitdown_pdf_processing_engine || 'markitdown',
        async v => { if (await saveIntegration({ markitdown_pdf_processing_engine: v })) renderHelperModels(); });
    const pdfField = integField('PDF processing engine',
        'Process PDF requests by MarkItDown itself or by an OCR engine.', pdfSel);
    if (integ.markitdown_pdf_processing_engine === 'markitdown') {
        const warn = document.createElement('small');
        warn.className = 'fhint warn';
        warn.textContent = C.tf('uplift.ui.scanned_or_image_only_pdfs_will_fail_when_markit', 'Scanned or image-only PDFs will fail when MarkItDown is selected, ')
            + 'and PDFs with tables may not be processed correctly.';
        pdfField.append(warn);
    }
    mkGrid.append(pdfField);
    mkCard.append(mkGrid);
    box.append(mkCard);

    /* ---- CLI assistants (classic binds these on the Status launcher;
       Uplift edits them where integrations live). Keys save with the
       integrations_ prefix exactly like saveIntegrationSettings(). ---- */
    const cliCard = document.createElement('div');
    cliCard.className = 'mk-box';
    const cliHead = document.createElement('div');
    cliHead.className = 'mk-head';
    const cliTitle = document.createElement('div');
    cliTitle.className = 'mk-title';
    cliTitle.textContent = C.tf('uplift.ui.cli_assistants', 'CLI Assistants');
    const cliHint = document.createElement('small');
    cliHint.className = 'dim';
    cliHint.textContent = 'Model each launched CLI assistant defaults to (blank = ask every launch).';
    cliHead.append(cliTitle, cliHint);
    const cliGrid = document.createElement('div');
    cliGrid.className = 'mk-grid';
    const cliModel = (key, label) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.spellcheck = false;
        inp.setAttribute('list', 'cli-models');
        inp.value = integ[key] || '';
        inp.placeholder = 'Ask every launch';
        inp.onchange = async () => { await saveIntegration({ [key]: inp.value || null }); };
        return integField(label, '', inp);
    };
    cliGrid.append(
        cliModel('copilot_model', 'GitHub Copilot'),
        cliModel('codex_model', 'Codex'),
        cliModel('opencode_model', 'OpenCode'),
        cliModel('openclaw_model', 'OpenClaw'),
        integField('OpenClaw tools profile', 'Tool set the launcher passes to openclaw.',
            integSelect([['minimal','Minimal'],['coding','Coding'],['messaging','Messaging'],['full','Full']],
                        integ.openclaw_tools_profile || 'coding',
                        v => saveIntegration({ openclaw_tools_profile: v }))),
        cliModel('hermes_model', 'Hermes Agent'),
        cliModel('pi_model', 'Pi'));
    // model datalist for the assistant pickers
    const cliDl = document.createElement('datalist'); cliDl.id = 'cli-models';
    for (const m of modelList) {
        const o2 = document.createElement('option'); o2.value = m.id || m.name || ''; cliDl.append(o2);
    }
    cliCard.append(cliHead, cliDl, cliGrid);
    box.append(cliCard);

    /* ---- Web Search ---- */
    const wsCard = document.createElement('div');
    wsCard.className = 'mk-box';
    const wsHead = document.createElement('div');
    wsHead.className = 'mk-head';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'mk-title';
    wsTitle.textContent = C.tf('uplift.ui.web_search', 'Web Search');
    wsHead.append(wsTitle);
    const wsGrid = document.createElement('div');
    wsGrid.className = 'mk-fields';

    const provSel = integSelect([
        ['ddgs', 'DDGS Total'], ['ddgs_custom', 'DDGS Custom'],
        ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'],
        ['searxng', 'SearXNG'],
    ], integ.web_search_provider || 'ddgs', async v => {
        if (await saveIntegration({ web_search_provider: v })) renderHelperModels();
    });
    wsGrid.append(integField('Search provider',
        'Backend used by the chat web search tool. DDGS Total queries every available engine and needs no key.',
        provSel));

    if (integ.web_search_provider === 'ddgs_custom') {
        const be = document.createElement('input');
        be.type = 'text';
        be.placeholder = 'e.g. duckduckgo,brave,mojeek';
        be.value = integ.web_search_ddgs_backends || '';
        be.onchange = async () => {
            if (await saveIntegration({ web_search_ddgs_backends: be.value })) renderHelperModels();
        };
        wsGrid.append(integField('Search engines',
            'Comma-separated engines to query. All of these work without an API key.', be));
    }
    if (integ.web_search_provider === 'brave') {
        const key = document.createElement('input');
        key.type = 'password';
        key.placeholder = 'BSA…';
        key.value = integ.web_search_brave_api_key || '';
        key.onchange = async () => {
            if (await saveIntegration({ web_search_brave_api_key: key.value })) renderHelperModels();
        };
        wsGrid.append(integField('Brave API key',
            'Subscription token from the Brave Search API dashboard. Stored locally, never echoed.', key));
    }
    if (integ.web_search_provider === 'searxng') {
        const url = document.createElement('input');
        url.type = 'text';
        url.placeholder = 'http://127.0.0.1:8080';
        url.value = integ.web_search_searxng_url || '';
        url.onchange = async () => {
            if (await saveIntegration({ web_search_searxng_url: url.value })) renderHelperModels();
        };
        wsGrid.append(integField('SearXNG instance URL',
            'Base URL of a SearXNG instance with the JSON output format enabled.', url));
    }

    wsGrid.append(integField('Results per search',
        'How many sources one web_search call returns (1-10).',
        integNumber('web_search_max_results', 1, 10)));

    const modeSel = integSelect([
        ['snippet', 'Snippets only'], ['full', 'Full page content'],
    ], integ.web_search_content_mode || 'snippet', async v => {
        if (await saveIntegration({ web_search_content_mode: v })) renderHelperModels();
    });
    wsGrid.append(integField('Result content',
        'Snippets keep the prompt small. Full page content fetches and inlines each result page.',
        modeSel));

    if (integ.web_search_content_mode === 'full') {
        const tr = document.createElement('input');
        tr.type = 'checkbox';
        tr.checked = !!integ.web_search_content_truncate;
        tr.onchange = async () => {
            if (await saveIntegration({ web_search_content_truncate: tr.checked })) renderHelperModels();
        };
        wsGrid.append(integField('Truncate page content',
            'Cut each fetched page at the limit below. Turning this off can flood the model context.', tr));
        if (integ.web_search_content_truncate) {
            wsGrid.append(integField('Content limit (chars)',
                'Maximum characters kept per fetched page.',
                integNumber('web_search_content_max_chars', 500, 200000)));
        }
    }

    // Test search: classic uses the real API; through the gateway it hits the real backend read-only.
    const testRow = document.createElement('div');
    testRow.className = 'row buttons';
    const testBtn = document.createElement('button');
    testBtn.className = 'se-btn';
    testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    const testOut = cell('');
    testOut.className = 'dim';
    testBtn.onclick = async () => {
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
        try {
            // Classic contract (dashboard.js testWebSearch): the endpoint tests
            // the PENDING form values and 422s without a JSON body. This page
            // autosaves every change, so last-loaded `integ` + live controls
            // ARE the pending state.
            const pickVal = ph => { const el = [...wsGrid.querySelectorAll('input')]
                    .find(i => i.placeholder === ph); return el ? el.value : ''; };
            const body = {
                provider: provSel.value || integ.web_search_provider || 'ddgs',
                brave_api_key: pickVal('BSA…') || integ.web_search_brave_api_key || '',
                searxng_url: pickVal('http://127.0.0.1:8080') || integ.web_search_searxng_url || '',
                ddgs_backends: pickVal('e.g. duckduckgo,brave,mojeek') || integ.web_search_ddgs_backends || '',
                max_results: Number(integ.web_search_max_results) || 5,
            };
            const r = await fetchJson(`${API}/admin/api/web-search/test`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body) });
            testOut.textContent = r.ok
                ? `Search OK: ${(r.results || []).length} results`
                : ('Search test failed: ' + ((r.error && r.error.message) || 'unknown'));
        } catch (err) {
            testOut.textContent = C.tf('uplift.ui.search_test_failed', 'Search test failed: ') + err.message;
        }
        testBtn.disabled = false; testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    };
    testRow.append(testBtn, testOut);
    testRow.className = 'mk-row';
    wsGrid.append(testRow);
    wsCard.append(wsHead, wsGrid);
    box.append(wsCard);

    $('hm-sub').textContent = `${helpers.length} helpers · integrations editable${GW_LIVE ? ' (live)' : ' (shadow)'}`;
    $('hm-sub').dataset.count = helpers.length;

    const host = $('hm-list');
    host.textContent = '';
    if (!helpers.length) { host.innerHTML = '<div class="empty">No helper models</div>'; return; }
    for (const m of helpers) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(m.id); name.className = 'uname';
        name.title = m.model_path || m.id;
        const kind = /dflash/i.test(m.id) ? 'DFLASH DRAFTER'
            : /assistant/i.test(m.id) ? 'ASSISTANT (MTP)' : 'HELPER';
        // U10 (user round): a drafter rides its consumers' engine — its own
        // loaded flag does not mean anything useful and the load button was
        // wrong. Show WHO uses it and light the lamp from the consumers.
        // used_by comes from our overlay route; on vanilla installs (viewer
        // mode) it is absent and derived here from each model's embedded
        // settings blob instead.
        const users = usedBy(m).map(uid => {
            const u = (adminModels || []).find(x => x.id === uid);
            return { id: uid, loaded: !!(u && (u.loaded || u.is_loading)),
                     name: (u && (u.display_name || u.id)) || uid };
        });
        const active = users.filter(u => u.loaded);
        const state = document.createElement('span');
        state.className = 'spill ' + (active.length ? 'on' : 'off');
        state.textContent = users.length
            ? (active.length ? `IN USE ×${active.length}` : `SET FOR ×${users.length}`)
            : 'UNUSED';
        state.title = users.length
            ? 'Used by: ' + users.map(u => u.name + (u.loaded ? ' (loaded)' : '')).join(', ')
            : 'No model config references this drafter';
        row.append(name, cell(m.model_type || ''), cell(kind),
                   cell(m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size || 0)), state);
        const act = document.createElement('span'); act.className = 'rowacts';
        for (const u of users.slice(0, 3)) {
            const chip = document.createElement('button');
            chip.className = 'se-btn act' + (u.loaded ? ' on' : '');
            chip.textContent = u.name.split('/').pop().slice(0, 22);
            chip.title = (u.loaded ? 'loaded — ' : 'not loaded — ') + u.id;
            chip.onclick = () => { location.hash = '#models/manager'; renderModelAdmin(true); };
            act.append(chip);
        }
        if (users.length > 3) act.append(cell('+' + (users.length - 3)));
        if (!users.length) {
            const hint = document.createElement('span');
            hint.className = 'dim'; hint.style.fontSize = '10px';
            hint.textContent = 'assign it in a model\'s settings (DFlash / MTP / SpecPrefill)';
            act.append(hint);
        }
        row.append(act);
        host.append(row);
    }
}

/* ---------------- boot ---------------- */
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollGatewayInfo();
    if (currentTab() === 'usage') pollUsage();
    if (currentTab() === 'logs') pollLogs();
    // task-list poll chains self-terminate while hidden; kick the current one again
    const TASK_HOSTS = { downloader: ['dl-tasks', 'hf'], quantizer: ['qz-tasks', 'oq'], uploader: ['up-tasks', 'upload'] };
    if (currentTab() === 'models') {
        const pair = TASK_HOSTS[currentSub('models')];
        if (pair) renderTasks(pair[0], pair[1]);
    }
    resizeCharts();
});

applyPrefs();
applyOrder();
applyLayout();
// ?lang=xx overrides the locale (testing/demo; server setting is default)
loadLocale(new URLSearchParams(location.search).get('lang') || undefined);
createCharts();
resizeCharts();
applyTab();
restartPolling();
pollGatewayInfo();
loadChartHistory();
setInterval(() => { if (!document.hidden) loadChartHistory(); }, 60000);
pollUsage(); pollLogs();
connectEventStream();
setInterval(pollGatewayInfo, 10000);
setInterval(() => { if (!document.hidden) pollRequests(); }, 2000);
setInterval(() => { if (!document.hidden && !seModel) renderModelAdmin(); }, 8000);
setInterval(() => { if (!document.hidden && currentTab() === 'usage') pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && logsFollow) pollLogs(); }, 5000);
})();
