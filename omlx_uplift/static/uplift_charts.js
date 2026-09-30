/* Uplift charts section (PH2-1 stage 2 extraction from uplift.js):
   uPlot instance lifecycle, server chart history, per-card timespans and the
   metric-card engine. Plain script — loads AFTER uplift_state.js (reads the
   shared state cell) and BEFORE uplift.js, which late-binds layout-owned
   helpers (CH_GLUE.fetchJson/CH_GLUE.refitUpliftBlocks/...) through the CH_GLUE accessor.
   Exports window.Uplift.charts. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const layout = S.layout;
const API = S.API;
const $ = id => document.getElementById(id);
/* Boot-late bindings into uplift.js (both are hoisted function declarations
   there; these accessors resolve them at CALL time, never at load time). */
const CH_GLUE = {
    get fetchJson() { return window.Uplift._chartGlue.fetchJson; },
    get refitUpliftBlocks() { return window.Uplift._chartGlue.refitUpliftBlocks; },
    get _blockEl() { return window.Uplift._chartGlue._blockEl; },
    get _neededUnits() { return window.Uplift._chartGlue._neededUnits; },
    get _padObserver() { return window.Uplift._chartGlue._padObserver; },
    get removeCard() { return window.Uplift._chartGlue.removeCard; },
    get applyI18n() { return window.Uplift._chartGlue.applyI18n; },
    get revealGatedCard() { return window.Uplift._chartGlue.revealGatedCard; },
};
/* ---------------- charts ---------------- */
const axisFont = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
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
const tpsData = [[], [], [], []];  // time, generation tok/s, prefill tok/s, cached tok/s (U30)
const memData = [[], [], [], []];  // time, used GB, limit GB, disk cache GB (U37 — % line retired)
const MAX_POINTS = 4000;

/* Server-side chart history (uplift fine samples merged with vanilla's
   hourly rollups): backfills the live tick buffers so windows longer than
   this session — and gaps across server restarts — actually draw. Live
   ticks always win when newer than the newest history point; the coarse
   boundary gets labeled honestly in the window readout.
   ISSUE-6: the MEMORY&CACHE card used to draw ONLY the session buffer
   (memData) — switching its timeframe showed nothing before page load.
   mem.percent + cache.total_bytes now backfill from the store the same
   way throughput does. Per-model hot-cache lines backfill too since
   2026-09-30: the collector writes stable 'hot.<model>' keys (zeros
   included), /uplift/api/metrics/hot discovers them, and a drained or
   freshly-loaded model keeps its line across refreshes — the old
   session-live-only rule existed only because the rank keys (hot1/2/3)
   rotated models through one series and made history meaningless. */
let chartHist = { gen: [], cached: [], prefill: [], mem: [], memLimit: [], cache: [], hot: {} };   // arrays of {ts, v, res}; hot: model -> points (GB)
let historyDirty = true, historyLoading = false;
/* The two shared-history cards backfill at the LARGEST window any of them
   uses (one fetch, superset cached); each card draws its own slice. */
function windowToParam() {
    let w = layout.chartWindowSec;
    for (const id of ['chart-tps', 'chart-mem'])
        if (CH_GLUE._blockEl(id)) w = Math.max(w, cardWindow(id));
    return windowParam(w);
}
async function loadChartHistory() {
    if (historyLoading) return;
    historyLoading = true;
    try {
        const w = windowToParam();
        const [g, p, m, h] = await Promise.all([
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent('avg_generation_tps,rate.cached_tokens_s')}&window=${w}`).catch(() => null),
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?key=avg_prefill_tps&window=${w}`).catch(() => null),
            // U37: the memory card plots GB (used vs limit vs disk cache) —
            // sys.percent left the chart, the series stays collected for the
            // cache-card meter + header label.
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent('sys.used_bytes,sys.total_bytes,cache.total_bytes')}&window=${w}`).catch(() => null),
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/hot?window=${w}`).catch(() => null),
        ]);
        const conv = a => (a && a.series ? a.series.map(x => ({ ts: x.ts * 1000, v: x.v, res: x.res })) : []);
        const convMap = (o, k, scale) => (o && o.series_map && o.series_map[k]
            ? o.series_map[k].map(x => ({ ts: x.ts * 1000, v: scale ? x.v * scale : x.v, res: x.res })) : []);
        // Only adopt if the window did not change mid-flight (stale-window
        // race: a slow 24h response landing over a fresh 5m selection).
        if (w === windowToParam()) {
            chartHist = { gen: convMap(g, 'avg_generation_tps'),
                          cached: convMap(g, 'rate.cached_tokens_s'), prefill: conv(p),
                          // U37: bytes -> GB ladder for all three memory
                          // series (one GB axis; decimal 1e-9 matches
                          // fmtBytes — the dashboard's byte convention)
                          mem: convMap(m, 'sys.used_bytes', 1e-9),
                          memLimit: convMap(m, 'sys.total_bytes', 1e-9),
                          cache: convMap(m, 'cache.total_bytes', 1e-9),   // server ts is epoch SECONDS -> ms
                          // per-model hot cache, bytes -> GB, keyed by model
                          // id (the 'hot.' prefix is part of the metric key)
                          hot: Object.fromEntries(Object.entries(
                              (h && h.series_map) || {})
                              .map(([k, pts]) => [k.slice('hot.'.length),
                                    pts.map(x => ({ ts: x.ts * 1000, v: x.v * 1e-9,
                                                    res: x.res }))])) };
            // Membership may have changed with the history (fresh model,
            // page just loaded): rebuild the series list before redraw.
            const ids = pickHotIds();
            if (ids.join('|') !== cacheSeriesIds.join('|')) {
                cacheSeriesIds = ids;
                createCharts();
            }
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
    const win = cardWindow('chart-tps');
    const g = C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], win, now);
    const p = C.mergeHistory(chartHist.prefill, tpsData[0], tpsData[2], win, now);
    // U30: cached input rides the same union column (dotted prefill line).
    const k = C.mergeHistory(chartHist.cached || [], tpsData[0], tpsData[3], win, now);
    const ts = [...new Set(g.ts.concat(p.ts, k.ts))].sort((a, b) => a - b);
    const gi = new Map(g.ts.map((t, i) => [t, g.v[i]]));
    const pi = new Map(p.ts.map((t, i) => [t, p.v[i]]));
    const ki = new Map(k.ts.map((t, i) => [t, k.v[i]]));
    return [ts, ts.map(t => (gi.has(t) ? gi.get(t) : null)),
                ts.map(t => (pi.has(t) ? pi.get(t) : null)),
                ts.map(t => (ki.has(t) ? ki.get(t) : null))];
}
let cacheSeriesIds = [];             // top-3 models currently drawn on mem chart
/* Per-model hot-cache session buffers: model -> {ts[], v[] (GB)}. Keyed by
   model id (not chart position) so a reshuffle of the top-3 never repaints
   one model's values under another's label — the old positional columns
   had to be wiped on every membership change. */
const hotLive = new Map();

/* Newest value of a hot series (live wins over history). Used to rank
   which models get a line — top-3 by hot-cache size, drained models rank
   last and simply disappear when three busier models push them out. */
function hotLatest(id) {
    const lv = hotLive.get(id);
    if (lv && lv.ts.length) {
        for (let i = lv.v.length - 1; i >= 0; i--)
            if (lv.v[i] != null) return { v: lv.v[i], ts: lv.ts[i] };
    }
    const h = chartHist.hot[id];
    if (h && h.length) return { v: h[h.length - 1].v, ts: h[h.length - 1].ts };
    return null;
}
function pickHotIds() {
    const ids = new Set([...hotLive.keys(), ...Object.keys(chartHist.hot)]);
    const scored = [...ids].map(id => ({ id, s: hotLatest(id) }))
                       .filter(x => x.s)
                       .sort((a, b) => (b.s.v - a.s.v) || (b.s.ts - a.s.ts));
    return scored.slice(0, 3).map(x => x.id);
}
/* Columns for the memory card (U37): one GB axis — used vs limit vs disk
   cache — plus the per-model hot-cache lines on the same axis. All series
   backfill from the store and merge with their live buffers. */
function memWindowed() {
    const now = Date.now();
    const win = cardWindow('chart-mem');
    const mm = C.mergeHistory(chartHist.mem, memData[0], memData[1], win, now);
    const ml = C.mergeHistory(chartHist.memLimit || [], memData[0], memData[2], win, now);
    const cc = C.mergeHistory(chartHist.cache, memData[0], memData[3], win, now);
    const hot = cacheSeriesIds.map(id => {
        const lv = hotLive.get(id) || { ts: [], v: [] };
        return C.mergeHistory(chartHist.hot[id] || [], lv.ts, lv.v, win, now);
    });
    let allTs = mm.ts.concat(ml.ts, cc.ts);
    for (const h of hot) allTs = allTs.concat(h.ts);
    const ts = [...new Set(allTs)].sort((a, b) => a - b);
    const mmI = new Map(mm.ts.map((t, i) => [t, mm.v[i]]));
    const mlI = new Map(ml.ts.map((t, i) => [t, ml.v[i]]));
    const ccI = new Map(cc.ts.map((t, i) => [t, cc.v[i]]));
    const cols = [ts,
        ts.map(t => (mmI.has(t) ? mmI.get(t) : null)),
        ts.map(t => (mlI.has(t) ? mlI.get(t) : null)),
        ts.map(t => (ccI.has(t) ? ccI.get(t) : null))];
    for (const h of hot) {
        const hi = new Map(h.ts.map((t, i) => [t, h.v[i]]));
        cols.push(ts.map(t => (hi.has(t) ? hi.get(t) : null)));
    }
    return cols;
}

function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return { dim: cs.getPropertyValue('--dim').trim() || '#a5a096',
             grid: cs.getPropertyValue('--grid').trim() || '#3a3b40',
             blue: cs.getPropertyValue('--chart-1').trim() || '#f2f0ea',
             gold: cs.getPropertyValue('--chart-2').trim() || '#e8a020' };
}
/* Old positional memWindowed (hot1/hot2/hot3 columns, session-live-only)
   retired 2026-09-30 with the stable 'hot.<model>' keys — the merged
   version above draws per-model history + live buffers. */
function seriesValue(v) {
    return v === null || v === undefined ? '—' : C.fmtCompact(v);
}
/* U8: throughput/counter axes start at 0. Auto-scaling to the data window
   exaggerated tiny wiggles; a zero floor is honest for rate/count units.
   NOT applied to memory % (already 0-100) or cache GB (auto remains
   useful — values legitimately sit far from 0). */
// uPlot assigns the range() return values to scale.min/max VERBATIM
// (setScale does e.max=n[1]) — a null upper means "unbounded" to nothing
// here: the scale stays null and the line is never drawn (2026-09-25:
// U8 shipped [0, null] and every floored chart drew grid-less blank
// while the legend/hover still showed values). Upper must be concrete;
// idle all-zero windows get a readable 0..1 band.
const ZERO_FLOOR_RANGE = (u, dmin, dmax) =>
    [0, (dmax == null || dmax <= 0) ? 1 : dmax * 1.05];
function line(label, colorVar, fill, scale) {
    const col = chartColors()[colorVar];
    return { label, scale: scale || 'y', stroke: col, width: 2,
             fill: fill ? col + '22' : undefined,
             points: { show: false }, value: seriesValue };
}
function xAxis(col, boundWin) {
    const winOf = () => boundWin >= 0 ? boundWin : cardWindow('chart-tps');
    return { stroke: col.dim, width: 1, size: 34, font: axisFont,
             values: (s, t) => t.map(ts => {
                 const win = winOf();
                 return win >= 86400
                     ? new Date(ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
                     : new Date(ts).toLocaleTimeString('en-GB',
                         { hour: '2-digit', minute: '2-digit', ...(win < 900 ? { second: '2-digit' } : {}) });
             }) };
}
function yAxis(col, opts) {
    // size includes tick labels AND the rotated axis label; 36/44 read to
    // the user as dead side gaps inside the chart cards (2026-09-19 r3) —
    // tightened to the smallest size that still fits the rotated labels.
    return Object.assign({ stroke: col.dim, size: 30, font: axisFont, grid: true, gap: 4 }, opts || {});
}
/* ISSUE-1 (jumping timeframe): with an auto x-scale uPlot re-fits the axis
   to wherever the data happens to sit on every setData — sparse backfill
   points, 60 s history refetches (new bucket boundaries) and window slides
   each re-anchor the ticks: the chart "stretches, then jumps". Pinning the
   range to [now-window, now] makes the window scroll smoothly instead. */
function pinnedXRange(cardId) {
    return () => { const now = Date.now(); const w = cardWindow(cardId) * 1000;
                   return [now - w, now]; };
}
function baseOpts(specs, axes, legendHook) {
    const col = chartColors();
    return {
        width: 0, height: 240, padding: [4, 0, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: true, top: true, live: false, labels: { fontSize: '9px' } },
        scales: Object.assign({ x: { time: true }, y: { auto: true } }, axes.scales || {}),
        axes: [xAxis(col, -1), ...axes.yAxes],
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
        if (hasTimeRow && src.length) {
            /* SWEEP178: the vendored uPlot builds its legend Time cell with
               new Date(ts * 1000) — right only for second-based axes, so an
               ms x column printed year 58707. Fill the cell here (this
               updater runs after uPlot's own on every hover and every draw)
               with the window-appropriate format. */
            const cell = rows[0].querySelector('.u-value')
                || (() => { const td = document.createElement('td'); td.className = 'u-value'; rows[0].append(td); return td; })();
            const t = src[i];
            const dayish = src.length > 1 && (src[src.length - 1] - src[0]) > 2 * 86400e3;
            cell.textContent = (typeof t === 'number' && t > 0)
                ? new Date(t).toLocaleString('en-GB', dayish
                    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
                    : { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '--';
        }
        seriesRows.forEach((row, sIdx) => {
            let cell = row.querySelector('.u-value');
            if (!cell) {
                cell = document.createElement('td');
                cell.className = 'u-value';
                row.append(cell);
            }
            const colData = c.data[sIdx + 1];
            const v = colData && colData.length ? colData[i] : null;
            // Honour the series' own value formatter (U19/U20 multi-unit
            // cards: %, W, °C must not render as bare compact numbers).
            const ser = c.series[sIdx + 1];
            const fn = (ser && typeof ser.value === 'function') ? ser.value : seriesValue;
            // SWEEP178: uPlot calls series.value(u, v) — chart first. Custom
            // (u,v) formatters (U19 cards) got undefined as their value when
            // we passed fn(v), so idle legends printed '—' while hover (uPlot's
            // own call) painted fine. Route by arity: 2-arg formatters are the
            // uPlot-contract ones; 1-arg helpers (seriesValue) take the value.
            cell.textContent = (v === null || v === undefined) ? '—'
                : (fn.length >= 2 ? fn(c, v) : fn(v));
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
        // Honour a series' own value formatter (explorer bytes/%), else compact.
        const fn = (c.series[s] && typeof c.series[s].value === 'function')
            ? c.series[s].value : seriesValue;
        // SWEEP178: same (u,v)-vs-(v) arity split as legendUpdater.
        val.textContent = (v === null) ? '—' : (fn.length >= 2 ? fn(c, v) : fn(v));
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
    // U30: cached input tokens ride the RIGHT axis as a dotted line in the
    // prefill colour (same family: cached ⊆ prompt); absent before uplift's
    // install day, never zero-filled (honest absence).
    const tpsSpecs = [line('generation', 'blue', true, 'y'), line('prefill', 'gold', false, 'y2')];
    const cachedLine = line(C.tf('uplift.metric.rate.cached_tokens_s', 'cached tok/s'), 'gold', false, 'y2');
    cachedLine.dash = [4, 4];
    tpsSpecs.push(cachedLine);
    const tpsOpts = baseOpts(
        tpsSpecs,
        { scales: { y: { auto: true, range: ZERO_FLOOR_RANGE },
                    y2: { auto: true, range: ZERO_FLOOR_RANGE } },
          yAxes: [Object.assign(yAxis(col, { grid: false, label: 'gen tok/s', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'prefill tok/s', stroke: col.gold, size: 36 }), { scale: 'y2' })] },
        legendUpdater());
    // y2 axis sits on the right; uPlot axis 'side': 1=right of grid, 3=left.
    tpsOpts.height = Math.max(200, $('chart-tps').clientHeight || 240);
    tpsOpts.scales.x.range = pinnedXRange('chart-tps');
    tpsChart = new uPlot(tpsOpts, tpsWindowed(), $('chart-tps'));
    window.__uplotTps = tpsChart;   // debug handle
    // U37: ONE GB axis — used vs memory limit vs disk cache, plus the
    // per-model hot-cache lines. The memory-% line is gone (its number
    // lives on in the header label #mem-label + the cache-card meter).
    const memLine = (label, colorVar, dash) => {
        const s = line(label, colorVar, false, 'y');
        if (dash) s.dash = dash;
        return s;
    };
    const memSpecs = [memLine('memory used', 'blue'), memLine('memory limit', 'dim', [4, 4]),
                      memLine('disk cache', 'gold')];
    for (let i = 0; i < cacheSeriesIds.length; i++) {
        const shortId = cacheSeriesIds[i].length > 14
            ? cacheSeriesIds[i].slice(0, 13) + '…' : cacheSeriesIds[i];
        const s = line('hot:' + shortId, ['gold', 'blue', 'dim'][i], false, 'y');
        s.dash = [4, 4];
        memSpecs.push(s);
    }
    const memOpts = baseOpts(memSpecs,
        { scales: { y: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { label: 'GB', stroke: col.blue }), { scale: 'y' })] },
        legendUpdater());
    memOpts.height = Math.max(200, $('chart-mem').clientHeight || 240);
    memOpts.scales.x.range = pinnedXRange('chart-mem');
    memChart = new uPlot(memOpts, memWindowed(), $('chart-mem'));
    bindCursorUpdater(tpsChart); bindCursorUpdater(memChart);
    bindCursorTip(tpsChart); bindCursorTip(memChart);
    resizeCharts();
    redrawCharts();
}
function redrawCharts() {
    if (!tpsChart) return;
    tpsChart.setData(tpsWindowed());
    memChart.setData(memWindowed());
    // Keep the hovered position pinned across polls (index shifts otherwise);
    // when not hovering, show the latest samples.
    restoreCursor(tpsChart) || legendUpdater()(tpsChart);
    restoreCursor(memChart) || legendUpdater()(memChart);
    const shown = tpsChart.data[0].length;
    let label = shown > 1 ? `${windowLabel(cardWindow('chart-tps'))} window` : '';
    // Honest resolution badge: hourly rollups backfill older stretches.
    const now = Date.now();
    const g = C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], cardWindow('chart-tps'), now);
    if (shown > 1 && g.boundary && g.boundary < now - 120000) {
        label += ` · hourly ≤ ${new Date(g.boundary).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    }
    $('chart-tps-window').textContent = label;
}
function rerenderChartsTheme() {
    createCharts(); if (usageChart) createUsageChart();
    // ISSUE-2: rebuild each metric plot IN ITS HOST — createMetricCard's
    // exists-guard makes re-calling it a no-op once the card is in the grid,
    // which left every small metric card blank after the first rerender.
    for (const id of [...metricCharts.keys()]) reinitMetricPlot(id);
    // Rebuilt uPlots start at their default 300×100; the host ResizeObserver
    // does NOT fire (same box size), so fit them explicitly or they overflow.
    fitAllMetricPlots();
    drawAllMetricCharts();
}
function resizeCharts() {
    fitAllMetricPlots();
    if (!tpsChart) return;
    // Box-driven clamp (same rule as the metric plots): available height
    // comes from the GRID BOX, never the body's clientHeight — a flex body
    // reports its own drawn height and a flex body + auto-size chart would
    // otherwise feed back into itself and grow forever.
    for (const [ch, box, floor] of [[tpsChart, $('chart-tps'), 210], [memChart, $('chart-mem'), 210],
                                    [usageChart, $('chart-usage'), 180]]) {
        if (!ch || !box || box.clientWidth <= 0) continue;
        const cont = box.closest('.grid-stack-item-content');
        let h = floor;
        if (cont) {
            const pad = box.closest('.card-pad');
            const padBottom = pad ? (parseFloat(getComputedStyle(pad).paddingBottom) || 0) : 0;
            h = Math.max(floor, Math.round(cont.getBoundingClientRect().bottom - padBottom
                - box.getBoundingClientRect().top));
        }
        // The hover legend renders below the plot — reserve its row.
        const lg = box.querySelector('.u-legend');
        const lgH = lg ? Math.max(lg.getBoundingClientRect().height, 20) : 0;
        h = Math.max(floor, h - lgH);
        box.style.height = h + 'px';
        ch.setSize({ width: box.clientWidth, height: h });
        // uPlot.setSize grows its .uplot wrapper but never shrinks it —
        // pin it, or stale height bleeds past the clamped box.
        const wrap = box.querySelector('.uplot');
        if (wrap) wrap.style.height = h + 'px';
    }
}
/* PH2-1 stage 2: the ResizeObserver wiring for these hosts moved to the
   uplift.js boot tail — resizeCharts() reads metricCharts, a const declared
   below this point in this file (TDZ if the observer fired at load). */

/* ---------------- timespans + metric cards ----------------
   Every chart card owns its own timespan: layout.metricWin[blockId]
   overrides, absent = follow the global default (layout.chartWindowSec,
   set via the popover / new cards). Selecting a window in one section
   never shifts the others (user, 2026-09-18). Data is persistent:
   uplift's sqlite samples backfilled by vanilla's hourly rollups; long
   windows are server-downsampled (res='avg') and the note says so.
   One card per metric is GENERATED from the core.js catalogue — label,
   formatter and data wiring exist in exactly one place. */
function windowLabel(sec) {
    return sec >= 86400 ? `${sec / 86400}d`
         : sec >= 3600 ? `${sec / 3600}h` : `${sec / 60}m`;
}
/* Arbitrary durations (downsample buckets) get rounded human spans —
   windowLabel assumes exact chip values and would print 16.66̄m. */
function fmtSpan(sec) {
    return sec >= 7200 ? `${Math.round(sec / 3600)}h`
         : sec >= 120 ? `${Math.round(sec / 60)}m` : `${Math.round(sec)}s`;
}
function windowParam(sec) {
    return sec >= 2592000 ? '30d' : sec >= 604800 ? '7d' : sec >= 86400 ? '24h'
         : sec >= 21600 ? '6h' : sec >= 3600 ? '1h' : sec >= 900 ? '15m'
         : sec >= 300 ? '5m' : '1m';
}
function cardWindow(id) {
    return layout.metricWin[id] ?? layout.chartWindowSec;
}
function setGlobalWindow(sec) {
    if (!(sec > 0)) return;        // NaN/0 (bad select value) must not poison layout
    if (sec === layout.chartWindowSec) return;
    layout.chartWindowSec = sec;
    C.saveLayout(localStorage, layout);
    renderCardTsRows(true);
    historyDirty = true; loadChartHistory();
    redrawCharts();          // shared cards without an override follow
    for (const id of [...metricCharts.keys()]) {
        if (layout.metricWin[id] === undefined) metricFetch(id, true);
        else drawMetricChart(id);
    }
}
function setCardWindow(id, sec) {
    if (sec === layout.chartWindowSec) delete layout.metricWin[id];
    else layout.metricWin[id] = sec;
    C.saveLayout(localStorage, layout);
    if (id === 'chart-tps' || id === 'chart-mem') {
        // Shared-history cards: refetch history at the NEW window, redraw both
        historyDirty = true; loadChartHistory();
        redrawCharts();
    } else {
        metricFetch(id, true);
        drawMetricChart(id);
    }
    renderCardTsRows(true);
}
/* One shared popover for collapsed timespan rows (2026-09-21): when the
   chips do not fit the header, the row collapses to a ▾ icon that opens
   the same options as a click-menu — never a sideways scroll the user
   cannot see. Re-measured on every render; chips stay as soon as they
   fit again. */
let tsPop = null, tsPopOwner = null;
function closeTsPop() { if (tsPop) { tsPop.remove(); tsPop = null; tsPopOwner = null; } }
function openTsPop(row, id) {
    closeTsPop();
    const r = row.getBoundingClientRect();
    tsPop = document.createElement('div');
    tsPop.className = 'ts-pop';
    for (const sec of C.LAYOUT_WINDOWS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ts-pop-item' + (sec === cardWindow(id) ? ' on' : '');
        b.textContent = windowLabel(sec);
        b.onclick = () => { closeTsPop(); setCardWindow(id, sec); };
        tsPop.append(b);
    }
    document.body.append(tsPop);
    // open downward under the icon, right-aligned like dd-menu--right; flip
    // left at the viewport edge, up if there is no room below
    const pw = tsPop.offsetWidth, ph = tsPop.offsetHeight;
    let x = r.right - pw, y = r.bottom + 2;
    if (x < 4) x = 4;
    if (y + ph > innerHeight - 4) y = Math.max(4, r.top - ph - 2);
    tsPop.style.left = x + 'px'; tsPop.style.top = y + 'px';
    tsPopOwner = row;
}
document.addEventListener('click', e => {
    if (tsPop && !tsPop.contains(e.target) && tsPopOwner && !tsPopOwner.contains(e.target)) closeTsPop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTsPop(); });

function renderCardTsRows(force) {
    // Metric headers wrap (CSS): chips that fit the CARD get a header line of
    // their own instead of collapsing; only chips wider than the whole card
    // become the ▾ button. Measuring against the title-line remainder (my
    // first cut, and a 60% cap before it) collapsed rows that plainly fit
    // the card = the always-showing-button regression (user 2026-09-21).
    // Zero-width band = card not laid out yet (parked boot): skip, the settle
    // pass re-checks after placement.
    for (const row of document.querySelectorAll('.ts-row')) {
        const id = row.dataset.block;
        const win = cardWindow(id);
        const h2 = row.closest('h2');
        const bandW = h2 ? h2.clientWidth : row.parentElement.clientWidth;
        if (!bandW) continue;
        const avail = bandW - 24;   // h2 padding (16) + flex gap (8)
        const probe = document.createElement('div');
        probe.className = 'ts-row';
        probe.style.cssText = 'position:absolute;visibility:hidden;width:max-content;max-width:none;';
        (h2 || row.parentElement).append(probe);
        for (const sec of C.LAYOUT_WINDOWS) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'ts-chip'; b.textContent = windowLabel(sec);
            probe.append(b);
        }
        const shouldCollapse = probe.scrollWidth > avail + 1;
        probe.remove();
        const collapsed = row.classList.contains('ts-collapsed');
        // The row is ResizeObserver-watched by the row-height engine: only
        // rebuild on an actual state change (or a force pass — window-label
        // relabel). Same-state rebuilds re-fire the observer and loop the
        // row engine forever.
        if (row.children.length && collapsed === shouldCollapse && !force) continue;
        row.textContent = '';
        if (shouldCollapse) {
            row.classList.add('ts-collapsed');
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ts-more';
            b.title = windowLabel(win);
            b.setAttribute('aria-label', 'Timespan: ' + windowLabel(win));
            b.textContent = windowLabel(win) + ' ▾';
            b.onclick = e => {
                e.stopPropagation();
                if (tsPopOwner === row) closeTsPop(); else openTsPop(row, id);
            };
            row.append(b);
            continue;
        }
        row.classList.remove('ts-collapsed');
        for (const sec of C.LAYOUT_WINDOWS) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'ts-chip' + (sec === win ? ' on' : '');
            b.textContent = windowLabel(sec);
            b.title = windowLabel(sec);
            b.onclick = () => setCardWindow(id, sec);
            row.append(b);
        }
        // NOTE: no scrollIntoView here. The chips wrap (CSS), so scrolling
        // the active chip into view yanked the whole page to whichever card
        // was rebuilt last — "changing a timeframe jumps the screen"
        // (user 2026-09-22). The rebuild is a no-op for rows that already
        // render the right set.
    }
}

/* ---- metric card engine ----
   Chart cache: id -> {chart, host, fmt, nameEl, noteEl, nowEl, def}. */
const metricCharts = new Map();
/* U24 (user 2026-09-30): gated (macmon) presence memo. The power/temperature
   cards always exist like any other card — a session-scoped flag decides
   whether they sit in their default slots or stay hidden (card-parked), the
   same pattern the header chips use (they toggle `hidden` on the presence of
   fresh samples). Once data has been seen the flag sticks for the session:
   a later macmon stop lets the plots age out honestly instead of hiding
   cards that were real. */
const gateSeen = new Set();
/* True while a gated def stays hidden (data never seen this session). */
function _gateHidden(def) {
    return !!(def && def.gated && !gateSeen.has(def.key));
}
/* fetch cache keyed by windowParam (cards sharing a window share bytes),
   each entry {data: series_map, at, fails, bucket_s} */
const metricCache = {};
const _fetching = new Set();
const _seq = {};

function metricFormat(def) {
    if (def.fmt === 'bytes') return v => (v === null || v === undefined ? '—' : C.fmtBytes(v));
    if (def.fmt === 'pct') return v => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
    if (def.fmt === 'count') return v => (v == null ? '—' : String(Math.round(v)));
    if (def.fmt === 'watts') return v => (v == null ? '—' : v.toFixed(1) + ' W');
    if (def.fmt === 'temp') return v => (v == null ? '—' : Math.round(v) + ' °C');
    if (def.key === 'engines.active_requests') return v => (v == null ? '—' : String(Math.round(v)));
    return seriesValue;
}
/* U8: which metric-card keys get a zero floor on the y-axis.
   2026-09-26 (user: "the graphs are floating because the 0 is in the
   middle"): extended to pct and bytes cards — auto-scaling to the data
   window put the line mid-plot on low-variance series; a floored axis
   shows the real magnitude. */
function metricZeroFloor(key) {
    return true;   // every small metric card floors at 0
}
function metricLabel(key) {
    const s = key.replace(/^(rate|tot|engines|mem|cache|pfx|spec|queue|pwr|therm|fan)\./, '')
        .replace(/_/g, ' ')
        .replace(/tps$/, 'tok/s');
    // U19/U20 human names for the uglier auto-translations.
    return ({ 'token hit pct': 'token hit %', 'lookup hit pct': 'lookup hit %',
              'saved tokens min': 'saved tok/min', 'restored tokens min': 'restored tok/min',
              'total w': 'total W', 'cpu w': 'CPU W', 'gpu w': 'GPU W', 'ane w': 'ANE W',
              'cpu temp c': 'CPU °C', 'gpu temp c': 'GPU °C', 'max rpm': 'max RPM',
              'max pct': 'fan %', 'tokens min': 'tok/min', 'draw': 'power draw',
              'cache savings': 'prefill cache savings', 'efficiency': 'prefix cache efficiency',
              'savings': 'specprefill savings', 'depth': 'queue depth', 'temp': 'temperature' })[s] || s;
}
/* Series label for legends/tips: locale first (uplift.metric.<key>), auto
   fallback second. Chart series labels are JS-built, so they go through
   here rather than [data-i18n]. */
function metricSeriesLabel(key) {
    return (C.tf && C.tf('uplift.metric.' + key, metricLabel(key))) || metricLabel(key);
}
/* Build the DOM for one metric card (called once per card, at boot; the
   element is what the grid parks/places from then on). */
/* Options for one metric card, shared by create + reinit (theme/skin).
   Multi-series defs (U19/U20) draw every series on a union x column, get a
   legend, and may put lines on a right-hand y2 axis (different unit). */
function metricServes(def) {
    return def.series && def.series.length ? def.series : [{ key: def.key, fmt: def.fmt }];
}
function metricOpts(id, def, col) {
    const fmt = metricFormat(def);
    const mult = !!(def.series && def.series.length);
    const sers = metricServes(def);
    const hasY2 = mult && sers.some(s => s.axis === 'y2' && !s.legendOnly);
    const palette = [col.blue, col.gold, col.dim];
    const series = [{}, ...sers.map((s, i) => {
        const sf = metricFormat({ key: s.key, fmt: s.fmt });
        const c = palette[i % palette.length];
        const sc = s.axis || (s.legendOnly ? 'yleg' : 'y');
        const o = { label: metricSeriesLabel(s.key), scale: sc,
                    stroke: c, width: s.legendOnly ? 0 : 1.6,
                    fill: (s.area || (!mult && i === 0)) ? c + '1c' : undefined,
                    points: { show: false }, value: (u, v) => sf(v === undefined || v !== v ? null : v) };
        return o;
    })];
    const scales = { x: { time: true, range: pinnedXRange(id) },
                     y: Object.assign({ auto: true },
                         metricZeroFloor(def.key) ? { range: ZERO_FLOOR_RANGE } : null) };
    if (sers.some(s => s.legendOnly)) scales.yleg = { auto: true };
    if (hasY2) scales.y2 = { auto: true, range: ZERO_FLOOR_RANGE };
    const axes = [metricXAxis(cardWindow(id), col), metricYAxis(col, def)];
    if (hasY2) {
        const y2ser = sers.find(s => s.axis === 'y2' && !s.legendOnly);
        axes.push(Object.assign(
            { stroke: col.gold, size: 4, font: axisFont, grid: false, gap: 2,
              rotate: 0, space: 50, side: 1, label: '',
              values: (u, vals) => vals == null ? vals
                  : vals.map(v => v == null ? '' : metricYFmt({ key: y2ser.key, fmt: y2ser.fmt || def.fmt })(v)) },
            { scale: 'y2' }));
    }
    return {
        width: 300, height: 100, padding: [8, 4, 6, 0],   // top: label-centred ticks clip without it; bottom: 0-line gap (2026-09-26)
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 5, fill: col.dim } },
        // SWEEP178: live:false like the shared charts. With live:true the
        // vendored build re-paints the value cells on its own deferred draw
        // pass and stamps '—' (null through series.value) right after our
        // legendUpdater painted the real values; the updater owns the cells.
        legend: { show: mult, live: false },
        scales, axes, series,
    };
}
function createMetricCard(def, park) {
    const id = C.metricBlockId ? C.metricBlockId(def.key) : 'met-' + def.key.replace(/[._]/g, '-');
    if (document.querySelector(`#grid .card[data-block="${id}"]`)) return;
    const titleKey = def.titleKey || def.key;   // U19 flagship reads better under its own name
    const sec = document.createElement('section');
    sec.className = 'card grid-stack-item';
    // U24: a gated card whose data has not been seen yet is BORN parked —
    // hidden, no grid slot, no tray pill (renderTray skips unseen gated
    // ids). It keeps its DEFAULT geometry and the probe places it the
    // moment macmon samples appear; the row packer ignores parked cards,
    // so an absent macmon leaves no dead band.
    if (park) sec.classList.add('card-parked');
    sec.dataset.id = id; sec.dataset.tab = 'status'; sec.dataset.block = id;
    sec.setAttribute('gs-id', id);
    const content = document.createElement('div'); content.className = 'grid-stack-item-content';
    const frame = document.createElement('div'); frame.className = 'card-frame metric-card';
    const chrome = document.createElement('div'); chrome.className = 'card-chrome';
    const handle = document.createElement('div'); handle.className = 'card-handle';
    const hatch = document.createElement('span'); hatch.className = 'hatch'; hatch.dataset.icon = 'grip';
    const hText = document.createElement('span');
    hText.setAttribute('data-i18n', 'uplift.metric.' + titleKey);
    hText.textContent = metricLabel(titleKey);
    handle.append(hatch, hText);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'card-remove'; rm.dataset.icon = 'close';
    rm.title = 'Remove from dashboard';
    rm.setAttribute('data-i18n-title', 'uplift.layout.remove');
    rm.setAttribute('aria-label', 'Remove from dashboard');
    rm.textContent = '×';
    rm.onclick = () => CH_GLUE.removeCard(id);
    chrome.append(handle, rm);
    const pad = document.createElement('div'); pad.className = 'card-pad';
    const h2 = document.createElement('h2');
    const title = document.createElement('span');
    title.setAttribute('data-i18n', 'uplift.metric.' + titleKey);
    title.textContent = metricLabel(titleKey);
    title.dataset.en = metricLabel(titleKey);
    const now = document.createElement('b'); now.className = 'metric-now';
    const right = document.createElement('span'); right.className = 'right';
    right.append(now);
    const note = document.createElement('span'); note.className = 'metric-res';
    right.append(note);
    const tsRow = document.createElement('div');
    tsRow.className = 'ts-row'; tsRow.dataset.block = id;
    tsRow.setAttribute('role', 'group'); tsRow.setAttribute('aria-label', 'Timespan');
    const body = document.createElement('div'); body.className = 'card-body metric-body';
    if (CH_GLUE._padObserver) [h2, tsRow, body].forEach(ch => CH_GLUE._padObserver.observe(ch));
    const host = document.createElement('div'); host.className = 'metric-plot';
    host.id = id + '-plot';
    body.append(host);
    h2.append(title, right, tsRow);
    pad.append(h2, body);
    frame.append(chrome, pad); content.append(frame); sec.append(content);
    $('grid').append(sec);
    const col = chartColors();
    const fmt = metricFormat(def);
    const chart = new uPlot(metricOpts(id, def, col),
        multInitData(def), host);
    bindCursorTip(chart);
    // SWEEP178: legend live:false (see metricOpts) — hover must drive the
    // shared legendUpdater exactly like the tps/mem charts do; on mouseleave
    // it re-pins to the latest sample.
    if (def.series && def.series.length) bindCursorUpdater(chart);
    metricCharts.set(id, { chart, host, fmt, def, nameEl: title, nowEl: now, noteEl: note });
    if (!host._ro) {
        host._ro = new ResizeObserver(() => { fitMetricPlot(id); });
        host._ro.observe(host);
    }
}
/* ISSUE-2 (small metric cards blank after a theme/skin switch): the rerender
   path destroyed each uPlot and cleared its host, then called
   createMetricCard again — but the CARD DOM was still in the grid, so the
   exists-guard returned immediately and the host stayed empty forever.
   Rebuild the plot inside the existing host instead (colors re-read). */
/* reinit path (theme/skin): rebuild opts the same way create does. */
function reinitMetricPlot(id) {
    const e = metricCharts.get(id);
    if (!e) return;
    try { e.chart.destroy(); } catch (_) {}
    e.host.textContent = '';
    const col = chartColors();
    e.chart = new uPlot(metricOpts(id, e.def, col),
        e.chart.data && e.chart.data.length ? e.chart.data : multInitData(e.def), e.host);
    bindCursorTip(e.chart);
}
function fitMetricPlot(id) {
    const e = metricCharts.get(id);
    if (!e) return;
    // The card grows/shrinks via the row-height engine; the plot takes the
    // space left after title + timespan row. The floor keeps a bare card
    // readable; CH_GLUE._neededUnits() treats the .metric-plot floor as the
    // content demand, and metric cards size TO that demand exactly.
    const host = e.host;
    // Box-driven height: read what the CARD has left (pad bottom - body
    // top - pad's bottom padding), NOT host.clientHeight — a stretched
    // flex host reports the uPlot wrapper's stale inline size, which
    // locks the chart at its largest-ever height and bleeds past the box.
    const pad = e.host.closest('.card-pad');
    const cont = e.host.closest('.grid-stack-item-content');
    let h = 96;   // matches .metric-plot min-height (card taller for the 0-line, 2026-09-26)
    if (pad && cont) {
        // Bottom reference = the GRID BOX, never the pad: a stretched pad
        // reports its own stale grown height and the loop gets stuck at
        // the largest size it ever reached. The box is engine truth.
        const cs = getComputedStyle(pad);
        const padBottom = parseFloat(cs.paddingBottom) || 0;
        const border = parseFloat(getComputedStyle(e.host.closest('.card')).borderTopWidth) || 0;
        h = Math.max(64, Math.round(cont.getBoundingClientRect().bottom - border
            - e.host.parentElement.getBoundingClientRect().top - padBottom));
    }
    host.style.height = h + 'px';
    const wrap = host.querySelector('.uplot');
    if (wrap) wrap.style.height = h + 'px';   // setSize only ever grows it
    if (host.clientWidth > 0) e.chart.setSize({ width: host.clientWidth, height: h });
}
function fitAllMetricPlots() { for (const id of metricCharts.keys()) fitMetricPlot(id); }
function metricXAxis(win, col) {
    const dayish = win >= 86400;
    // Sparkline cards: uPlot never fitted readable time labels into the short
    // band (default 30° rotation + tick space), so its 26px band was dead
    // space that pushed the y=0 line to card mid-height. Hide the axis
    // entirely — the band collapses, the 0-line sits at the bottom with the
    // 6px plot padding keeping the label off the card edge. Timespans are
    // already selected by the 1m..30d buttons above each chart. (2026-09-26)
    return { show: false, stroke: col.dim, width: 1, rotate: 0, font: axisFont,
             values: (s, t) => t.map(ts => new Date(ts).toLocaleString('en-GB',
                 dayish ? { month: 'short', day: 'numeric' }
                        : { hour: '2-digit', minute: '2-digit' })) };
}
/* Compact axis labels with units (user 2026-09-21: raw y-labels like
   '1234567' clipped inside the 30px gutter of the small metric cards).
   <=4 chars so the 26px gutter never clips; ticks thin out via space,
   rotate is pinned off — rotated labels reach past the gutter too. */
function metricYFmt(def) {
    if (/(bytes)/.test(def.key))
        return v => (v === 0 ? '0'
                     : v >= 1e9 ? (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'G'
                                : (v / 1e6).toFixed(0) + 'M');
    return v => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
                 : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + 'k'
                 : String(Math.round(v * 10) / 10));
}
function metricYAxis(col, def) {
    // Labels render left-aligned at size+gap+12; 26 wasted ~48px of card
    // width on the left gutter (2026-09-26). 10 keeps them clear of the
    // card edge while pulling the plot to nearly full width.
    return { stroke: col.dim, size: 4, font: axisFont, grid: true, gap: 2,
             rotate: 0, space: 50, label: '',
             values: (u, vals) => vals == null ? vals : vals.map(v => v == null ? '' : metricYFmt(def)(v)) };
}
function metricFetch(id, force) {
    const e = metricCharts.get(id);
    if (!e) return;
    // U24: a gated card that has not been revealed yet (parked — no macmon
    // data) must not fetch or draw: no series cost, no empty-column cache
    // entries. Same network footprint as when the card did not exist.
    if (_gateHidden(e.def)) return;
    const w = windowParam(cardWindow(id));
    const keys = metricServes(e.def).map(s => s.key);
    const key = keys.join(',');
    const cache = metricCache[w] || (metricCache[w] = { data: {}, at: 0, fails: 0, bucket_s: 0 });
    const ttl = cardWindow(id) >= 604800 ? 60000 : 10000;
    const stale = cache.fails > 2 ? Date.now() - cache.at > 30000 : Date.now() - cache.at > ttl;
    // The cache is keyed by WINDOW and shared across cards. Gated cards
    // (temperature/power) are created after the boot fetch filled this
    // window with the older cards' keys — freshness alone then starved the
    // new card of its own series ("loads with no data on refresh; clicking
    // a timeframe fixes it"). A window whose cache is missing a requested
    // key is NOT fresh for this card, regardless of its timestamp.
    const missing = keys.some(k => !(k in cache.data));
    if (!force && !stale && !missing) { drawMetricChart(id); return; }
    const sk = w + '|' + key;
    if (_fetching.has(sk)) return;
    _fetching.add(sk);
    const seq = (_seq[sk] = (_seq[sk] || 0) + 1);
    CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent(key)}&window=${w}`)
        .then(d => {
            cache.at = Date.now(); cache.fails = 0;
            const map = d.series_map || {};
            Object.assign(cache.data, map);
            // Record every REQUESTED key as known — an answered-but-absent
            // key (collector stopped) gets an empty column, not a forever-
            // missing one. Without this the missing-key rule above would
            // re-fetch this window on every 5 s tick for data that never
            // comes. Failed fetches keep the keys missing (retry next tick).
            for (const k of keys) if (!(k in cache.data)) cache.data[k] = [];
            cache.bucket_s = d.bucket_s || 0;
        })
        .catch(() => { cache.fails++; cache.at = Date.now(); })
        .finally(() => {
            _fetching.delete(sk);
            if (_seq[sk] === seq) drawMetricChart(id);   // newest response wins
        });
}
/* Initial uPlot data: one column per series slot (multi defs reserve a
   column each so legend rows exist before the first fetch). */
function multInitData(def) {
    const n = metricServes(def).length;
    const cols = [[]];
    for (let i = 0; i < n; i++) cols.push([]);
    return cols;
}
/* Union-timestamp alignment (same rule as the throughput/memory charts:
   uPlot needs ONE shared x column): every series maps onto the sorted
   union of its key's sample timestamps; gaps stay null. */
function metricUnionCols(def, data, winMs) {
    const sers = metricServes(def);
    const cutoff = Date.now() - winMs;
    const cols0 = sers.map(s => (data[s.key] || []).filter(p => p.ts * 1000 >= cutoff));
    const ts = [...new Set(cols0.flatMap(p => p.map(q => q.ts * 1000)))].sort((a, b) => a - b);
    const cols = [ts];
    for (const col of cols0) {
        const m = new Map(col.map(q => [q.ts * 1000, q.v]));
        cols.push(ts.map(t => (m.has(t) ? m.get(t) : null)));
    }
    return cols;
}
function drawMetricChart(id) {
    const e = metricCharts.get(id);
    if (!e || _gateHidden(e.def)) return;   // U24: hidden gated card = no work
    const w = windowParam(cardWindow(id));
    const cache = metricCache[w] || { data: {}, bucket_s: 0 };
    const winMs = cardWindow(id) * 1000 + 60000;
    const cols = metricUnionCols(e.def, cache.data, winMs);
    e.chart.setData(cols);
    // SWEEP178: with legend.live:false the vendored build paints value
    // cells only on cursor events, so idle multi-series cards showed '—'
    // forever. Shared charts already refresh their legend after setData
    // (redrawCharts -> legendUpdater); metric cards must do the same.
    if (e.def.series && e.def.series.length) legendUpdater()(e.chart);
    // per-card x-axis format follows this card's window
    e.chart.axes[0] = metricXAxis(cardWindow(id), chartColors());
    // big readout = the card's primary key (last non-null on its own series)
    const pi = 1 + metricServes(e.def).findIndex(s => s.key === e.def.key);
    const pcol = cols[pi > 0 ? pi : 1] || [];
    let last = null;
    for (let i = pcol.length - 1; i >= 0; i--) if (pcol[i] != null) { last = pcol[i]; break; }
    e.nowEl.textContent = fmtLast(e.fmt, last);
    const bits = [];
    if (cache.bucket_s >= 60) bits.push(`${C.tf('uplift.explore.avg', 'averaged')} ≤ ${fmtSpan(Math.max(60, cache.bucket_s))}`);
    const ppts = cache.data[e.def.key] || [];
    if (ppts.length && ppts[ppts.length - 1].res === 'hourly') bits.push(C.tf('uplift.explore.hourly', 'hourly rollups'));
    // HONEST ABSENCE (user 2026-09-29: prefix-cache cards showed 0 forever):
    // when NO series arrived for this window the collector has gone quiet
    // (loaded engines stopped reporting those counters — e.g. pfx.* dies
    // when no block-aware-cache engine is resident). Saying 'live' over an
    // empty plot reads as "metric is alive and zero" — say it instead.
    const anyPts = metricServes(e.def).some(s => (cache.data[s.key] || []).length);
    if (!anyPts) bits.push(C.tf('uplift.explore.no_data', 'no data in window'));
    e.noteEl.textContent = bits.length ? bits.join(' · ') : 'live';
}
/* Latest reading gets real precision; hover stays compact. Both share one
   formatter so the legend and the big readout can never disagree. */
function fmtLast(fmt, v) {
    if (v === null || v === undefined) return '—';
    const s = fmt(v);
    if (/^\d+(\.\d+)?$/.test(s) && Math.abs(v) >= 10) return fmtNumberPrecise(v);
    return s;
}
function fmtNumberPrecise(v) { return C.fmtNumber(v); }
function drawAllMetricCharts() {
    for (const id of [...metricCharts.keys()]) { metricFetch(id, false); drawMetricChart(id); }
}
function relabelExplore() {
    // JS-built dynamic bits (window chips + per-card readouts); i18n-named
    // titles are [data-i18n] and covered by CH_GLUE.applyI18n already.
    renderCardTsRows(true);
    CH_GLUE.refitUpliftBlocks();   // chip rows just materialised: demand changed
    for (const [id, e] of metricCharts) {
        const sers = metricServes(e.def);
        for (let i = 0; i < sers.length; i++)
            e.chart.series[i + 1].label = metricSeriesLabel(sers[i].key);
        // uPlot writes legend label CELLS at init only (setSeries carries a
        // text update we do not fire) — cards created before the locale
        // fetch landed kept their English auto-labels forever (U33 merged
        // card showed 'sys.used bytes' after a relabel). Rewrite the cells.
        const rows = [...e.chart.root.querySelectorAll('.u-legend .u-series')];
        rows.forEach((row, i) => {
            const lab = row.querySelector('.u-label');
            if (lab && e.chart.series[i + 1]) lab.textContent = e.chart.series[i + 1].label;
        });
        drawMetricChart(id);
    }
}

function clearMainChartHover() {
    /* Pointer left the plot: drop the pinned hover so legends show latest again. */
    for (const sel of ['#chart-tps', '#chart-mem']) {
        const el = $(sel.slice(1));
        if (el) el.addEventListener('mouseleave', () => {
            hoverTs.set(sel === '#chart-tps' ? tpsChart : memChart, null);
            const c = sel === '#chart-tps' ? tpsChart : memChart;
            if (c) { c.setCursor({ idx: c.data[0].length - 1 }, false); }
        });
    }
}
clearMainChartHover();
function createUsageChart() {
    const el = $('chart-usage');
    if (!el) return;
    if (usageChart) usageChart.destroy();
    const col = chartColors();
    usageChart = new uPlot({
        width: el.clientWidth || 600, height: 200,
        scales: { x: { time: true }, y: { auto: true, range: ZERO_FLOOR_RANGE } },  // U8
        axes: [{ stroke: col.dim, size: 36, font: axisFont,
                 values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) },
               yAxis(col, { grid: true })],
        series: [{ label: 'tokens' }, line('tokens', 'blue', true)],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: false },
    }, [[], []], el);
    bindCursorTip(usageChart);
}

function markHistoryDirty() { historyDirty = true; loadChartHistory(); }

/* U11 live memory line + U37 GB columns: the collector's sys.* ticks
   (psutil) are the points pushed into the Memory chart. /admin/api/stats
   has no system-memory fields (model_memory_used is phys_footprint — flat),
   so the newest stored samples come from /metrics/latest, refreshed at
   most every 10s.
   U30: the same latest-fetch carries rate.cached_tokens_s — the throughput
   chart's live dotted prefill-colour line (no stats field for it either). */
let sysFetching = false, sysAt = 0;
let sysLive = { usedGB: null, limitGB: null, ts: 0 };
let cachedTps = null, cachedTpsTs = 0;
async function refreshSysPct() {
    const now = Date.now();
    if (sysFetching || now - sysAt < 10_000) return;
    sysFetching = true; sysAt = now;
    try {
        const r = await CH_GLUE.fetchJson(`${API}/uplift/api/metrics/latest?keys=` +
            encodeURIComponent('sys.used_bytes,sys.total_bytes,rate.cached_tokens_s'));
        const lat = (r && r.latest) || {};
        const u = lat['sys.used_bytes'], l = lat['sys.total_bytes'];
        if (u && typeof u.v === 'number') {
            sysLive = { usedGB: +(u.v * 1e-9).toFixed(3),
                        limitGB: (l && typeof l.v === 'number') ? +(l.v * 1e-9).toFixed(3) : null,
                        ts: u.ts * 1000 };
        }
        const c = lat['rate.cached_tokens_s'];
        if (c && typeof c.v === 'number') { cachedTps = c.v; cachedTpsTs = c.ts * 1000; }
    } catch (_) { /* keep last value */ }
    finally { sysFetching = false; }
}

/* U20 header chips: watts = mean over the last 60 s, temperature = MAX
   over the last 60 s (safety-relevant; mean goes to the tooltip). Chips
   appear ONLY when the series exist — macmon absent means the keys never
   have samples and both chips stay hidden (silent absence, user addendum).
   One 5m-window fetch every 10 s covers the whole 60 s mean/max window. */
let pwrChipsAt = 0, pwrChipsFetching = false;
async function refreshPowerChips() {
    const now = Date.now();
    if (pwrChipsFetching || now - pwrChipsAt < 10_000) return;
    pwrChipsFetching = true; pwrChipsAt = now;
    try {
        const d = await CH_GLUE.fetchJson(
            `${API}/uplift/api/metrics/series?keys=` +
            encodeURIComponent('pwr.total_w,therm.cpu_temp_c,therm.gpu_temp_c') +
            '&window=5m');
        const map = (d && d.series_map) || {};
        const fresh = k => (map[k] || []).filter(p => p.v != null && now - p.ts * 1000 < 60_000 + 15_000);
        const pw = fresh('pwr.total_w');
        const cp = document.getElementById('chip-power');
        const tc = document.getElementById('chip-temp');
        if (cp) {
            if (pw.length) {
                const mean = pw.reduce((a, p) => a + p.v, 0) / pw.length;
                cp.textContent = mean.toFixed(1) + ' W';
                cp.title = C.tf('uplift.chip.power_mean', 'Package power — 60 s mean');
                cp.hidden = false;
            } else cp.hidden = true;
        }
        if (tc) {
            const t = [...fresh('therm.cpu_temp_c'), ...fresh('therm.gpu_temp_c')];
            if (t.length) {
                const mx = Math.max(...t.map(p => p.v));
                const mean = t.reduce((a, p) => a + p.v, 0) / t.length;
                tc.textContent = Math.round(mx) + ' °C';
                tc.title = C.tf('uplift.chip.temp_max', 'Max CPU/GPU temp — 60 s max') +
                           ` · ${C.tf('uplift.chip.temp_mean', 'mean')} ${Math.round(mean)} °C`;
                tc.classList.toggle('chip-hot', mx >= 85);
                tc.hidden = false;
            } else { tc.hidden = true; tc.classList.remove('chip-hot'); }
        }
    } catch (_) { /* keep last render; absence stays silent */ }
    finally { pwrChipsFetching = false; }
}

function pushStatusSample(s, cacheGB, hotSorted) {
    refreshSysPct();   // fire-and-forget; lands in the next push
    // Chart buffers (window pruning happens at draw time). U30: column 3 =
    // cached tok/s from the metrics/latest poll (collector tick rate, ~10 s
    // fresh window; stale reads push null, never a stale number).
    tpsData[0].push(s.time); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    tpsData[3].push(cachedTps !== null && Date.now() - cachedTpsTs < 120_000 ? cachedTps : null);
    while (tpsData[0].length > MAX_POINTS) for (const col of tpsData) col.shift();
    // Per-model hot cache (GB): per-id session buffers, top-3 membership
    // recomputed from live + history (see hotLive/pickHotIds). Membership
    // changes rebuild the chart (legend + series list); values never move
    // between series because buffers are keyed by model, not position.
    for (const m of hotSorted) {
        if (m.hotBytes === null) continue;
        let lv = hotLive.get(m.id);
        if (!lv) { lv = { ts: [], v: [] }; hotLive.set(m.id, lv); }
        lv.ts.push(s.time); lv.v.push(+(m.hotBytes / 1e9).toFixed(3));
        while (lv.ts.length > MAX_POINTS) { lv.ts.shift(); lv.v.shift(); }
    }
    const hotIds = pickHotIds();
    if (hotIds.join('|') !== cacheSeriesIds.join('|')) {
        cacheSeriesIds = hotIds;
        createCharts();
    }
    // U37: used GB / limit GB (psutil via metrics/latest) + disk cache GB.
    const fresh = sysLive.ts && Date.now() - sysLive.ts < 120_000;
    memData[0].push(s.time);
    memData[1].push(fresh ? sysLive.usedGB : null);
    memData[2].push(fresh ? sysLive.limitGB : null);
    memData[3].push(cacheGB);
    while (memData[0].length > MAX_POINTS) for (const col of memData) col.shift();
    redrawCharts();
}

window.Uplift.charts = {
    line: line, yAxis: yAxis, seriesValue: seriesValue, bindCursorTip: bindCursorTip,
    axisFont: axisFont, chartColors: chartColors,
    tpsData: tpsData, memData: memData,
    pushStatusSample: pushStatusSample,
    createCharts: createCharts, redrawCharts: redrawCharts, resizeCharts: resizeCharts,
    rerenderChartsTheme: rerenderChartsTheme, createUsageChart: createUsageChart,
    loadChartHistory: loadChartHistory, markHistoryDirty: markHistoryDirty,
    relabelExplore: relabelExplore, windowLabel: windowLabel,
    setGlobalWindow: setGlobalWindow, renderCardTsRows: renderCardTsRows,
    createMetricCard: createMetricCard, drawAllMetricCharts: drawAllMetricCharts,
    legendUpdater: legendUpdater,   // SWEEP178: exposed for console testability
    fitAllMetricPlots: fitAllMetricPlots, clearMainChartHover: clearMainChartHover,
    refreshPowerChips: refreshPowerChips,
    /* U24 gated cards (macmon): the card DOM ALWAYS exists (boot creates it
       parked); this probe only FLIPS it visible once the series actually
       have values — the same data-driven flag the header chips use. Absence
       stays silent: parked card, no grid slot, no tray pill. Resolves once
       per session (gateSeen); a later macmon uninstall never hides live
       cards (they age out honestly). */
    gatedSeen: key => gateSeen.has(key),
    probeGatedCards: async function () {
        const defs = (C.EXPLORE_METRICS || []).filter(d => d.gated && !gateSeen.has(d.key));
        if (!defs.length) return;
        try {
            const r = await CH_GLUE.fetchJson(`${API}/uplift/api/metrics/latest?keys=` +
                encodeURIComponent(defs.map(d => d.key).join(',')));
            const lat = (r && r.latest) || {};
            for (const d of defs) {
                if (!(lat[d.key] && lat[d.key].v != null)) continue;
                gateSeen.add(d.key);
                const cid = C.metricBlockId(d.key);
                try {
                    CH_GLUE.revealGatedCard(cid);
                    // Don't wait for the next 5 s tick or the shared-window
                    // cache freshness: force-fill the just-revealed card now.
                    metricFetch(cid, true);
                } catch (err) {
                    /* one bad card must not kill the other gated defs */
                    console.warn('gated card reveal failed', d.key, err);
                }
            }
        } catch (_) { /* silent — absence stays silent */ }
    },
    get usageChart() { return usageChart; },
};
})();
