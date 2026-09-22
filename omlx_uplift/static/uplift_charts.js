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
const tpsData = [[], [], []];        // time, generation tok/s, prefill tok/s
const memData = [[], [], [], [], [], []];  // time, memory %, cache GB, hot1, hot2, hot3
const MAX_POINTS = 4000;

/* Server-side chart history (uplift fine samples merged with vanilla's
   hourly rollups): backfills the live tick buffers so windows longer than
   this session — and gaps across server restarts — actually draw. Live
   ticks always win when newer than the newest history point; the coarse
   boundary gets labeled honestly in the window readout.
   ISSUE-6: the MEMORY&CACHE card used to draw ONLY the session buffer
   (memData) — switching its timeframe showed nothing before page load.
   mem.percent + cache.total_bytes now backfill from the store the same
   way throughput does. Per-model hot-cache lines stay session-live-only
   (their series keys rotate with the model set; honest gap, no fake line). */
let chartHist = { gen: [], prefill: [], mem: [], cache: [] };   // arrays of {ts, v, res}
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
        const [g, p, m] = await Promise.all([
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?key=avg_generation_tps&window=${w}`).catch(() => null),
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?key=avg_prefill_tps&window=${w}`).catch(() => null),
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent('mem.percent,cache.total_bytes')}&window=${w}`).catch(() => null),
        ]);
        const conv = a => (a && a.series ? a.series.map(x => ({ ts: x.ts * 1000, v: x.v, res: x.res })) : []);
        const convMap = (o, k, scale) => (o && o.series_map && o.series_map[k]
            ? o.series_map[k].map(x => ({ ts: x.ts * 1000, v: scale ? x.v * scale : x.v, res: x.res })) : []);
        // Only adopt if the window did not change mid-flight (stale-window
        // race: a slow 24h response landing over a fresh 5m selection).
        if (w === windowToParam()) {
            chartHist = { gen: conv(g), prefill: conv(p),
                          mem: convMap(m, 'mem.percent'),
                          // bytes -> GB: the card's right axis is GB (issue 6)
                          cache: convMap(m, 'cache.total_bytes', 1e-9) };   // server ts is epoch SECONDS -> ms
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
/* Columns for the memory card: same union-timestamp alignment as the
   throughput chart. Series 1 (memory %) and 2 (cache GB) get server
   backfill; the three per-model hot-cache lines only ever exist for this
   session (issue 6: honest gap instead of pretending history). */
function memWindowed() {
    const now = Date.now();
    const win = cardWindow('chart-mem');
    const mm = C.mergeHistory(chartHist.mem, memData[0], memData[1], win, now);
    const cc = C.mergeHistory(chartHist.cache, memData[0], memData[2], win, now);
    const hot = [3, 4, 5].map(ci => ({ ts: memData[0], v: memData[ci] }));
    const ts = [...new Set(mm.ts.concat(cc.ts))].sort((a, b) => a - b);
    const mmI = new Map(mm.ts.map((t, i) => [t, mm.v[i]]));
    const ccI = new Map(cc.ts.map((t, i) => [t, cc.v[i]]));
    const hotI = hot.map(h => {
        const m = new Map();
        for (let i = 0; i < h.ts.length; i++) if (h.v[i] != null) m.set(h.ts[i], h.v[i]);
        return m;
    });
    const cols = [ts,
        ts.map(t => (mmI.has(t) ? mmI.get(t) : null)),
        ts.map(t => (ccI.has(t) ? ccI.get(t) : null))];
    for (const h of hotI) cols.push(ts.map(t => (h.has(t) ? h.get(t) : null)));
    return cols;
}
/* windowedData() retired 2026-09-22 (issue 6): the memory card draws
   memWindowed() now, which merges server history with the session buffer. */
function seriesValue(v) {
    return v === null || v === undefined ? '—' : C.fmtCompact(v);
}
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
        // Honour a series' own value formatter (explorer bytes/%), else compact.
        const fn = (c.series[s] && typeof c.series[s].value === 'function')
            ? c.series[s].value : seriesValue;
        val.textContent = (v === null) ? '—' : fn(v);
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
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'prefill tok/s', stroke: col.gold, size: 36 }), { scale: 'y2' })] },
        legendUpdater());
    // y2 axis sits on the right; uPlot axis 'side': 1=right of grid, 3=left.
    tpsOpts.height = Math.max(200, $('chart-tps').clientHeight || 240);
    tpsOpts.scales.x.range = pinnedXRange('chart-tps');
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
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'cache GB', stroke: col.gold, size: 36 }), { scale: 'y2' })] },
        legendUpdater());
    memOpts.scales.y = { range: [0, 100] };
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
/* fetch cache keyed by windowParam (cards sharing a window share bytes),
   each entry {data: series_map, at, fails, bucket_s} */
const metricCache = {};
const _fetching = new Set();
const _seq = {};

function metricFormat(def) {
    if (def.fmt === 'bytes') return v => (v === null || v === undefined ? '—' : C.fmtBytes(v));
    if (def.fmt === 'pct') return v => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
    if (def.key === 'engines.active_requests') return v => (v == null ? '—' : String(Math.round(v)));
    return seriesValue;
}
function metricLabel(key) {
    return key.replace(/^(rate|tot|engines|mem|cache)\./, '').replace(/_/g, ' ')
        .replace(/tps$/, 'tok/s');
}
/* Build the DOM for one metric card (called once per card, at boot; the
   element is what the grid parks/places from then on). */
function createMetricCard(def) {
    const id = C.metricBlockId ? C.metricBlockId(def.key) : 'met-' + def.key.replace(/[._]/g, '-');
    if (document.querySelector(`#grid .card[data-block="${id}"]`)) return;
    const sec = document.createElement('section');
    sec.className = 'card grid-stack-item';
    sec.dataset.id = id; sec.dataset.tab = 'status'; sec.dataset.block = id;
    sec.setAttribute('gs-id', id);
    const content = document.createElement('div'); content.className = 'grid-stack-item-content';
    const frame = document.createElement('div'); frame.className = 'card-frame metric-card';
    const chrome = document.createElement('div'); chrome.className = 'card-chrome';
    const handle = document.createElement('div'); handle.className = 'card-handle';
    const hatch = document.createElement('span'); hatch.className = 'hatch'; hatch.dataset.icon = 'grip';
    const hText = document.createElement('span');
    hText.setAttribute('data-i18n', 'uplift.metric.' + def.key);
    hText.textContent = metricLabel(def.key);
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
    title.setAttribute('data-i18n', 'uplift.metric.' + def.key);
    title.textContent = metricLabel(def.key);
    title.dataset.en = metricLabel(def.key);
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
    const opts = {
        width: 300, height: 100, padding: [2, 0, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 5, fill: col.dim } },
        legend: { show: false },
        scales: { x: { time: true, range: pinnedXRange(id) }, y: { auto: true } },
        axes: [metricXAxis(cardWindow(id), col), metricYAxis(col, def)],
        series: [{}, { label: metricLabel(def.key), stroke: col.blue, width: 1.6,
                       fill: col.blue + '1c', points: { show: false },
                       value: v => fmt(v === undefined ? null : v) }],
    };
    const chart = new uPlot(opts, [[], []], host);
    bindCursorTip(chart);
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
function reinitMetricPlot(id) {
    const e = metricCharts.get(id);
    if (!e) return;
    try { e.chart.destroy(); } catch (_) {}
    e.host.textContent = '';
    const col = chartColors();
    const opts = {
        width: 300, height: 100, padding: [2, 0, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 5, fill: col.dim } },
        legend: { show: false },
        scales: { x: { time: true, range: pinnedXRange(id) }, y: { auto: true } },
        axes: [metricXAxis(cardWindow(id), col), metricYAxis(col, e.def)],
        series: [{}, { label: metricLabel(e.def.key), stroke: col.blue, width: 1.6,
                       fill: col.blue + '1c', points: { show: false },
                       value: v => e.fmt(v === undefined ? null : v) }],
    };
    e.chart = new uPlot(opts, e.chart.data && e.chart.data.length ? e.chart.data : [[], []], e.host);
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
    let h = 64;
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
    return { stroke: col.dim, width: 1, size: 26, font: axisFont,
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
    return { stroke: col.dim, size: 26, font: axisFont, grid: true, gap: 4,
             rotate: 0, space: 50, label: '',
             values: (u, vals) => vals == null ? vals : vals.map(v => v == null ? '' : metricYFmt(def)(v)) };
}
function metricFetch(id, force) {
    const e = metricCharts.get(id);
    if (!e) return;
    const w = windowParam(cardWindow(id));
    const key = e.def.key;
    const cache = metricCache[w] || (metricCache[w] = { data: {}, at: 0, fails: 0, bucket_s: 0 });
    const ttl = cardWindow(id) >= 604800 ? 60000 : 10000;
    const stale = cache.fails > 2 ? Date.now() - cache.at > 30000 : Date.now() - cache.at > ttl;
    if (!force && !stale) { drawMetricChart(id); return; }
    const sk = w + '|' + key;
    if (_fetching.has(sk)) return;
    _fetching.add(sk);
    const seq = (_seq[sk] = (_seq[sk] || 0) + 1);
    CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent(key)}&window=${w}`)
        .then(d => {
            cache.at = Date.now(); cache.fails = 0;
            Object.assign(cache.data, d.series_map || {});
            cache.bucket_s = d.bucket_s || 0;
        })
        .catch(() => { cache.fails++; cache.at = Date.now(); })
        .finally(() => {
            _fetching.delete(sk);
            if (_seq[sk] === seq) drawMetricChart(id);   // newest response wins
        });
}
function drawMetricChart(id) {
    const e = metricCharts.get(id);
    if (!e) return;
    const w = windowParam(cardWindow(id));
    const cache = metricCache[w] || { data: {}, bucket_s: 0 };
    const pts = (cache.data[e.def.key] || []).filter(p =>
        p.ts * 1000 >= Date.now() - cardWindow(id) * 1000 - 60000);
    const ts = pts.map(p => p.ts * 1000), vs = pts.map(p => p.v);
    e.chart.setData([ts, vs]);
    // per-card x-axis format follows this card's window
    e.chart.axes[0] = metricXAxis(cardWindow(id), chartColors());
    const last = vs.length ? vs[vs.length - 1] : null;
    e.nowEl.textContent = fmtLast(e.fmt, last);
    const bits = [];
    if (cache.bucket_s >= 60) bits.push(`${C.tf('uplift.explore.avg', 'averaged')} ≤ ${fmtSpan(Math.max(60, cache.bucket_s))}`);
    if (pts.length && pts[pts.length - 1].res === 'hourly') bits.push(C.tf('uplift.explore.hourly', 'hourly rollups'));
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
        e.chart.series[1].label = metricLabel(e.def.key);
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

function markHistoryDirty() { historyDirty = true; loadChartHistory(); }
function pushStatusSample(s, cacheGB, hotSorted) {
    // Chart buffers (window pruning happens at draw time).
    tpsData[0].push(s.time); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    while (tpsData[0].length > MAX_POINTS) { tpsData[0].shift(); tpsData[1].shift(); tpsData[2].shift(); }
    // Per-model hot cache (GB): keep a stable top-3 set; rebuild chart on change.
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
    fitAllMetricPlots: fitAllMetricPlots, clearMainChartHover: clearMainChartHover,
    get usageChart() { return usageChart; },
};
})();
