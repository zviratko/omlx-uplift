/* Uplift charts section (PH2-1 stage 2 extraction from uplift.js):
   uPlot instance lifecycle, server chart history, per-card timespans and the
   metric-card engine. Plain script — loads AFTER uplift_state.js (reads the
   shared state cell) and BEFORE uplift.js, which late-binds layout-owned
   helpers (CH_GLUE.fetchJson/CH_GLUE.refitUpliftBlocks/...) through the CH_GLUE accessor.
   Exports window.Uplift.charts. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const layout = S.layout;
const API = S.API;
const $ = D.$;
/* FAST-1: 2 Hz live display feed (uplift_livefeed.js). Every consumer
   below falls back to the stored 5 s path when the feed is absent,
   stale, or the card window is too long for the resolution to mean
   anything (livefeed owns that rule). */
const LF = window.Uplift.livefeed;
/* Boot-late bindings into uplift.js (both are hoisted function declarations
   there; these accessors resolve them at CALL time, never at load time). */
const CH_GLUE = {
    fetchJson: D.fetchJson,
    get refitUpliftBlocks() { return window.Uplift._chartGlue.refitUpliftBlocks; },
    get _blockEl() { return window.Uplift._chartGlue._blockEl; },
    get _neededUnits() { return window.Uplift._chartGlue._neededUnits; },
    get _padObserver() { return window.Uplift._chartGlue._padObserver; },
    get removeCard() { return window.Uplift._chartGlue.removeCard; },
    get applyI18n() { return window.Uplift._chartGlue.applyI18n; },
    get revealGatedCard() { return window.Uplift._chartGlue.revealGatedCard; },
};
/* ---------------- charts ---------------- */
/* TST-1: the color/font/palette utilities live in uplift_chartkit.js (UMD,
   DOM-free, require()-able by tests). Aliased here so every existing call
   site keeps its bare name; chartColors() binds the page token reader. */
const KIT = window.UpliftChartkit;
const AXIS_FONT_PX = KIT.AXIS_FONT_PX;
const AXIS_FONT_FALLBACK = KIT.AXIS_FONT_FALLBACK;
const axisFont = KIT.axisFont;
const cssRgb = KIT.cssRgb;
const toHex2 = KIT.toHex2;
const tint = KIT.tint;
const SERIES_PALETTE_ORDER = KIT.SERIES_PALETTE_ORDER;
const SERIES_PALETTE_MAX = KIT.SERIES_PALETTE_MAX;
const seriesPalette = KIT.seriesPalette;
const ZERO_FLOOR_RANGE = KIT.ZERO_FLOOR_RANGE;
function chartColors() { return KIT.chartColors(); }

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
const tpsData = [[], [], [], [], []];  // time, generation tok/s, prefill tok/s, cached tok/s (U30),
                                       // MTP accepted tok/s (mtp.accepted_tokens_s)
/* POPOUT-1: uplift_popout.js registers itself here at load (registerPopout
   below); the chart redraw paths hand it the same columns they just built
   so an open pop-out stays in lockstep without this file knowing anything
   about the modal (split-module doctrine: no back-references). */
const popHooks = { ref: null };
const memData = [[], [], [], [], []];  // time, omlx used GiB, custom ceiling GiB,
                                       // iogpu wired limit GiB (U38), ALL-models
                                       // hot cache GiB (U40 — one aggregated
                                       // line replaced the top-3 per-model ones)
const MAX_POINTS = 4000;
const GIB = 2 ** -30;   // bytes -> GiB (memory chart draws GiB, user 2026-09-30)

/* Server-side chart history (uplift fine samples merged with vanilla's
   hourly rollups): backfills the live tick buffers so windows longer than
   this session — and gaps across server restarts — actually draw. Live
   ticks always win when newer than the newest history point; the coarse
   boundary gets labeled honestly in the window readout.
   ISSUE-6: the MEMORY&CACHE card used to draw ONLY the session buffer
   (memData) — switching its timeframe showed nothing before page load.
   mem.percent + cache.total_bytes now backfill from the store the same
   way throughput does. U40 (user 2026-09-30): the hot cache draws as ONE
   summed "hot cache" line (all models), not per-model lines — the top-3
   model names in the hover legend made the axis label row wrap. History
   still comes from the stable per-model 'hot.<model>' keys via
   /uplift/api/metrics/hot, summed client-side per timestamp. */
let chartHist = { gen: [], cached: [], prefill: [], mtp: [], mem: [], memLimit: [], cache: [], hot: [] };
let tpsLiveOn = false, memLiveOn = false;   // FAST-1: live-resolution draw flags (badges)   // arrays of {ts, v, res}; hot: summed all-models hot cache (GiB)
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
            // BE-decode: the generation line is the momentary per-tick
            // decode rate (generation.tokens_s from the collector's
            // in-flight token deltas). avg_generation_tps — what this
            // plotted — is a SESSION-LIFETIME AVERAGE (completion/duration
            // totals since boot): a near-static ramp on a long-running
            // server, the "flat line like cumulative stats" the user
            // reported. The average stays the small card + tile.
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent('generation.tokens_s,rate.cached_tokens_s,mtp.accepted_tokens_s')}&window=${w}`).catch(() => null),
            // BE-prefill: the prefill line is the true per-tick computed
            // rate (prefill.tokens_s from the tracker event hooks) — the
            // old avg_prefill_tps is a session-lifetime average that no
            // single request can move, which is why a prefilling request
            // "didn't show at all". No hourly rollup exists for the new
            // key (vanilla's usage table has no per-phase computed count);
            // history simply starts at the uplift install.
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?key=prefill.tokens_s&window=${w}`).catch(() => null),
            // U38: the memory card plots omlx's OWN budget — footprint vs
            // settings ceiling vs kernel iogpu wired limit (all GB). The
            // psutil pair and disk cache left the chart (U39).
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/series?keys=${encodeURIComponent('mem.used_bytes,mem.custom_ceiling_bytes,mem.iogpu_limit_bytes')}&window=${w}`).catch(() => null),
            CH_GLUE.fetchJson(`${API}/uplift/api/metrics/hot?window=${w}`).catch(() => null),
        ]);
        const conv = a => (a && a.series ? a.series.map(x => ({ ts: x.ts * 1000, v: x.v, res: x.res })) : []);
        const convMap = (o, k, scale) => (o && o.series_map && o.series_map[k]
            ? o.series_map[k].map(x => ({ ts: x.ts * 1000, v: scale ? x.v * scale : x.v, res: x.res })) : []);
        // U40: sum every per-model 'hot.<model>' series into ONE aggregate
        // history column. A timestamp missing a model still sums the present
        // ones (the collector writes every loaded model each tick, so gaps
        // only shift the sum by that model's share for one bucket).
        const sumSeriesMap = (o, scale) => {
            const byTs = new Map(), resByTs = new Map();
            for (const pts of Object.values((o && o.series_map) || {}))
                for (const x of pts) {
                    const ts = x.ts * 1000;
                    byTs.set(ts, (byTs.get(ts) || 0) + x.v * scale);
                    if (x.res === 'hourly') resByTs.set(ts, 'hourly');
                    else if (!resByTs.has(ts)) resByTs.set(ts, x.res);
                }
            return [...byTs.entries()].sort((a, b) => a[0] - b[0])
                .map(([ts, v]) => ({ ts, v: +v.toFixed(3), res: resByTs.get(ts) || 'fine' }));
        };
        // Only adopt if the window did not change mid-flight (stale-window
        // race: a slow 24h response landing over a fresh 5m selection).
        if (w === windowToParam()) {
            chartHist = { gen: convMap(g, 'generation.tokens_s'),
                          cached: convMap(g, 'rate.cached_tokens_s'),
                          mtp: convMap(g, 'mtp.accepted_tokens_s'),
                          prefill: conv(p),
                          // U38/U40: bytes -> GiB ladder for the budget and
                          // hot-cache series (1024^3 — matches fmtBytes/GiB)
                          mem: convMap(m, 'mem.used_bytes', GIB),
                          memCeil: convMap(m, 'mem.custom_ceiling_bytes', GIB),
                          memIogpu: convMap(m, 'mem.iogpu_limit_bytes', GIB),
                          // U40: summed all-models hot cache (was per-model)
                          hot: sumSeriesMap(h, GIB) };
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
    const liveOn = LF.liveForWindow(win);
    tpsLiveOn = liveOn && ((LF.liveUsable('generation.tokens_s'))
                           || (LF.liveUsable('prefill.tokens_s')));
    // SMOOTH-1 (user 2026-10-10): the smoothing level is a control, not a
    // constant. layout.tpsSmooth ∈ {1,3,5,9} samples (1 = off); the default
    // 3 reproduces FAST-1's fixed k. Each column is smoothed IN ITS OWN
    // CADENCE — the live 2 Hz stretch at k×0.5 s, stored 5 s points at
    // k×5 s — never one mean across both (the mixed-cadence blur FAST-1
    // warns about). A stored-cadence series only gets the stored treatment
    // when it is the ONLY cadence drawn this frame (gen/prefill with no
    // live twin) — otherwise the stored prefix stays raw next to the
    // smoothed live tail, exactly as before. Windows >1 h are already
    // averaged server-side by the series downsample; smoothing there would
    // be double-averaging, so the control is honest about being inert.
    const kS = C.LAYOUT_SMOOTHES.includes(layout.tpsSmooth) ? layout.tpsSmooth : 1;
    const sm = v => (kS > 1 ? C.movingAverage(v, kS) : v);
    const storedOk = kS > 1 && win <= 3600;
    const livePair = key => {
        const c = LF.liveCol(key);
        return c ? { ts: c.ts, v: sm(c.v) } : null;
    };
    const genL = liveOn && LF.liveUsable('generation.tokens_s') ? livePair('generation.tokens_s') : null;
    const preL = liveOn && LF.liveUsable('prefill.tokens_s') ? livePair('prefill.tokens_s') : null;
    let g = genL ? C.mergeHistory(chartHist.gen, genL.ts, genL.v, win, now)
        : C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], win, now);
    let p = preL ? C.mergeHistory(chartHist.prefill, preL.ts, preL.v, win, now)
        : C.mergeHistory(chartHist.prefill, tpsData[0], tpsData[2], win, now);
    if (!genL && storedOk) g = { ts: g.ts, v: sm(g.v) };
    if (!preL && storedOk) p = { ts: p.ts, v: sm(p.v) };
    // U30: cached input rides the same union column (dotted prefill line).
    // FAST-1 keeps it on the 5 s path deliberately: its source counter is
    // fed at request COMPLETION — a faster line would only repeat values.
    let k = C.mergeHistory(chartHist.cached || [], tpsData[0], tpsData[3], win, now);
    // SMOOTH-2/3: MTP accepted tok/s is fast-capable now (per-channel
    // drain in mtp_sampler). It stacks under generation as the speculation
    // slice of the total — a 5 s step edge next to the 2 Hz top line would
    // read as a tearing chart, so it prefers its live twin exactly like
    // generation does; the stored 5 s prefix stays raw next to the live
    // tail (per-cadence smoothing doctrine unchanged).
    const mtpL = liveOn && LF.liveUsable('mtp.accepted_tokens_s') ? livePair('mtp.accepted_tokens_s') : null;
    let m = mtpL ? C.mergeHistory(chartHist.mtp || [], mtpL.ts, mtpL.v, win, now)
        : C.mergeHistory(chartHist.mtp || [], tpsData[0], tpsData[4], win, now);
    if (!mtpL && storedOk) m = { ts: m.ts, v: sm(m.v) };
    if (storedOk) k = { ts: k.ts, v: sm(k.v) };
    const ts = [...new Set(g.ts.concat(p.ts, k.ts, m.ts))].sort((a, b) => a - b);
    const gi = new Map(g.ts.map((t, i) => [t, g.v[i]]));
    const pi = new Map(p.ts.map((t, i) => [t, p.v[i]]));
    const ki = new Map(k.ts.map((t, i) => [t, k.v[i]]));
    const mi = new Map(m.ts.map((t, i) => [t, m.v[i]]));
    return [ts, ts.map(t => (gi.has(t) ? gi.get(t) : null)),
                ts.map(t => (pi.has(t) ? pi.get(t) : null)),
                ts.map(t => (ki.has(t) ? ki.get(t) : null)),
                ts.map(t => (mi.has(t) ? mi.get(t) : null))];
}
/* U40 (user 2026-09-30): the per-model top-3 hot-cache lines are GONE. The
   model names in the hover legend forced the value row to wrap onto a
   second line, and three lines told the user nothing the sum does not:
   the card now draws ONE aggregated "hot cache" line (all models combined)
   over a single session buffer. The old id-keyed hotLive Map / pickHotIds
   ranking / cacheSeriesIds membership machinery retired with it. */
const hotLive = { ts: [], v: [] };   // summed all-models hot cache, GiB
/* Columns for the memory card (U38 axes, U40 hot-cache merge): one GiB
   axis — omlx footprint vs the settings ceiling vs the kernel iogpu wired
   limit — plus ONE summed hot-cache line. All series backfill from the
   store and merge with their live buffers. The two limit lines are flat
   constants; absent (null) whenever the limit is unset — never a fake zero. */
function memWindowed() {
    const now = Date.now();
    const win = cardWindow('chart-mem');
    // FAST-1: only the USED-memory line has a live twin — the ceilings are
    // kernel constants (60 s server cache) and the hot-cache gauge stays
    // on the 5 s path; faster sampling of a constant is fake resolution.
    memLiveOn = LF.liveForWindow(win) && LF.liveUsable('mem.used_bytes');
    const mm = memLiveOn
        ? C.mergeHistory(chartHist.mem, LF.liveCol('mem.used_bytes').ts,
                         LF.liveCol('mem.used_bytes').v.map(b => +(b * GIB).toFixed(3)),
                         win, now)
        : C.mergeHistory(chartHist.mem, memData[0], memData[1], win, now);
    const ml = C.mergeHistory(chartHist.memCeil || [], memData[0], memData[2], win, now);
    const cc = C.mergeHistory(chartHist.memIogpu || [], memData[0], memData[3], win, now);
    const hot = C.mergeHistory(chartHist.hot || [], hotLive.ts, hotLive.v, win, now);
    const ts = [...new Set(mm.ts.concat(ml.ts, cc.ts, hot.ts))].sort((a, b) => a - b);
    const mmI = new Map(mm.ts.map((t, i) => [t, mm.v[i]]));
    const mlI = new Map(ml.ts.map((t, i) => [t, ml.v[i]]));
    const ccI = new Map(cc.ts.map((t, i) => [t, cc.v[i]]));
    const hi = new Map(hot.ts.map((t, i) => [t, hot.v[i]]));
    return [ts,
        ts.map(t => (mmI.has(t) ? mmI.get(t) : null)),
        ts.map(t => (mlI.has(t) ? mlI.get(t) : null)),
        ts.map(t => (ccI.has(t) ? ccI.get(t) : null)),
        ts.map(t => (hi.has(t) ? hi.get(t) : null))];
}

/* Old positional memWindowed (hot1/hot2/hot3 columns) and the per-model
   top-3 series retired — the merged version above draws ONE summed
   hot-cache line (U40). */
function seriesValue(v) {
    return v === null || v === undefined ? '—' : C.fmtCompact(v);
}
function line(label, colorVar, fill, scale) {
    const col = chartColors()[colorVar];
    return { label, scale: scale || 'y', stroke: col, width: 2,
             fill: fill ? tint(col, '22') : undefined,
             // BUG-4: bridge cadence-sized null runs (union x column mixes
             // 2 Hz live + 5 s stored stamps); real stalls stay clipped.
             gaps: KIT.gapBridge(),
             points: { show: false }, value: seriesValue };
}
function xAxis(col, boundWin) {
    const winOf = () => boundWin >= 0 ? boundWin : cardWindow('chart-tps');
    return { stroke: col.dim, width: 1, size: 34, font: axisFont(col),
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
    return Object.assign({ stroke: col.dim, size: 30, font: axisFont(col), grid: true, gap: 4 }, opts || {});
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
        ms: KIT.TSTAMP_MS,   // x columns are ms-epoch (TSTAMP_MS in chartkit)
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        // Vendored uPlot 1.6.32 has no legend.labels option (DOM legend is
        // styled by .u-legend in uplift.css) — nothing to skin here.
        legend: { show: true, top: true, live: false },
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
        // LEGEND-1: 'idle' means the mouse is NOT over the plot. idx alone
        // cannot answer that: bindCursorUpdater's mouseleave deliberately
        // re-pins idx to the last row, and uPlot leaves idx null while the
        // cursor hovers a skipped point. Idle = 'latest sample': on the
        // FAST-1 union column the LAST ROW belongs to whichever stream
        // (2 Hz live vs 5 s stored) sampled last, so reading
        // colData[src.length-1] made the legend blink — memory card
        // alternated 0.8|—|—|— vs —|—|28|0 every ~1 s. Each series must
        // show its OWN last non-null. Hovered keeps the shared row: the
        // crosshair shows one instant, and null there is honest.
        const hovering = c.cursor.left >= 0 && idx !== null && idx !== undefined;
        const i = hovering ? Math.min(idx, src.length - 1) : src.length - 1;
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
            // SMOOTH-3: a stacked card's DATA columns are cumulative (the
            // bands need them); the legend must show each band's OWN
            // share — _rawSeries carries the pre-cumulation columns.
            const colData = (c._rawSeries && c._rawSeries[sIdx]) || c.data[sIdx + 1];
            const raw = colData && colData.length ? colData[i] : null;
            const v = hovering ? raw
                : (raw !== null && raw !== undefined ? raw : KIT.lastNonNull(colData, i));
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
        // SMOOTH-3: stacked cards show each band's own share in the tip
        // too (data columns are cumulative for the band fills).
        const scol = (c._rawSeries && c._rawSeries[s - 1]) || c.data[s] || null;
        const v = scol ? scol[i] : null;
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
/* POPOUT-1: the series/opts construction of the two shared-history cards
   is a pure function of (col, popout, boundWin) so the pop-out builds the
   IDENTICAL chart at screen size — no second copy of the legend/axis/
   stack wiring that could drift from the card. */
function tpsSpecs(col) {
    // Dual Y: left = generation tok/s, right = prefill tok/s (prefill >> gen).
    // U30: cached input tokens ride the RIGHT axis as a dotted line in the
    // prefill colour (same family: cached ⊆ prompt); absent before uplift's
    // install day, never zero-filled (honest absence).
    // BE-decode: the left line is now the MOMENTARY decode rate
    // (generation.tokens_s); its label carries that key's name so the
    // legend says what the line measures. The session average lives on its
    // own small card and the Generation tile, labelled as an average.
    const specs = [line(C.tf('uplift.metric.generation.tokens_s', 'generation tok/s'),
                        'blue', true, 'y'),
                   line('prefill', 'gold', false, 'y2')];
    // SMOOTH-3 stack: generation is the TOP edge of the stack; its own
    // wash is the base (non-speculated) tokens. MTP draws a denser warm
    // area 0..mtp on top of it — the band between the two lines IS the
    // non-MTP share. Nested areas beat an explicit band here: they stay
    // honest where mtp history is null (absent before install day), and
    // idle (mtp=0) reads as the plain generation area, same as before.
    specs[0].fill = tint(col.blue, '14');
    const cachedLine = line(C.tf('uplift.metric.rate.cached_tokens_s', 'cached tok/s'), 'gold', false, 'y2');
    cachedLine.dash = [4, 4];
    specs.push(cachedLine);
    // MTP accepted draft tok/s — only moves on mtp_enabled models; other
    // sessions ride honest zeros (the collector writes them every tick).
    // Stroke from the DEDUPED palette (3rd distinct colour): the raw
    // heat/accent tokens equal gold on every default skin, and a line on
    // the LEFT axis wearing the two RIGHT-axis lines' colour would read
    // as one of them.
    // SMOOTH-3 (user choice): it is now the BOTTOM of a stack — the area
    // under it is the MTP share of generation, and the band between it
    // and the generation line is the non-speculated base. Top of the
    // stack = total generation tok/s; the legend reads honest raw values.
    const mtpLine = line(C.tf('uplift.metric.mtp.accepted_tokens_s', 'MTP accepted tok/s'),
                          'heat', true, 'y');
    mtpLine.stroke = seriesPalette(col)[2] || mtpLine.stroke;
    mtpLine.fill = tint(mtpLine.stroke, '3d');
    specs.push(mtpLine);
    return specs;
}
function tpsBaseOpts(col, popout, boundWin) {
    const o = baseOpts(tpsSpecs(col),
        { scales: { y: { auto: true, range: ZERO_FLOOR_RANGE },
                    y2: { auto: true, range: ZERO_FLOOR_RANGE } },
          yAxes: [Object.assign(yAxis(col, { grid: false, label: 'gen tok/s', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'prefill tok/s', stroke: col.gold, size: 36 }), { scale: 'y2' })] },
        legendUpdater());
    if (popout) {
        o.width = 0; o.height = 0;   // setSize by the modal host
        o.axes[0] = Object.assign(xAxis(col, boundWin), { size: 30, grid: true });
        o.axes[1] = yAxis(col, { label: 'gen tok/s', stroke: col.blue });
        o.axes[1].scale = 'y';
    }
    return o;
}
function memSpecs(col) {
    // U38: ONE GiB axis — omlx footprint vs the settings ceiling vs the
    // kernel iogpu wired limit. U40: the hot cache joins as ONE summed
    // all-models line (the per-model top-3 lines wrapped the hover legend).
    // The memory-% line is gone; the header label (#mem-label) shows the
    // three absolute GiB figures instead (user 2026-10-02). Limit lines
    // stay absent when the limit is unset.
    const memLine = (label, colorVar, dash) => {
        const s = line(label, colorVar, false, 'y');
        if (dash) s.dash = dash;
        return s;
    };
    return [memLine('omlx memory', 'blue'),
            memLine('settings ceiling', 'dim', [4, 4]),
            memLine('iogpu wired limit', 'gold', [2, 4]),
            line(C.tf('uplift.chart.hot_cache', 'hot cache'), 'gold', true, 'y')];
}
function memBaseOpts(col, popout, boundWin) {
    const o = baseOpts(memSpecs(col),
        { scales: { y: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { label: 'GiB', stroke: col.blue }), { scale: 'y' })] },
        legendUpdater());
    if (popout) {
        o.width = 0; o.height = 0;
        o.axes[0] = Object.assign(xAxis(col, boundWin), { size: 30, grid: true });
    }
    return o;
}
function createCharts() {
    if (tpsChart) { tpsChart.destroy(); memChart.destroy(); tpsChart = memChart = null; }
    const col = chartColors();
    const tpsOpts = tpsBaseOpts(col, false);
    // y2 axis sits on the right; uPlot axis 'side': 1=right of grid, 3=left.
    tpsOpts.height = Math.max(200, $('chart-tps').clientHeight || 240);
    tpsOpts.scales.x.range = pinnedXRange('chart-tps');
    tpsChart = new uPlot(tpsOpts, tpsWindowed(), $('chart-tps'));
    window.__uplotTps = tpsChart;   // debug handle
    const memOpts = memBaseOpts(col, false);
    memOpts.height = Math.max(200, $('chart-mem').clientHeight || 240);
    memOpts.scales.x.range = pinnedXRange('chart-mem');
    memChart = new uPlot(memOpts, memWindowed(), $('chart-mem'));
    window.__uplotMem = memChart;   // debug handle (BUG-4 drill parity)
    bindCursorUpdater(tpsChart); bindCursorUpdater(memChart);
    bindCursorTip(tpsChart); bindCursorTip(memChart);
    resizeCharts();
    redrawCharts();
}
function redrawCharts() {
    if (!tpsChart) return;
    const tpsD = tpsWindowed(), memD = memWindowed();
    tpsChart.setData(tpsD);
    memChart.setData(memD);
    // POPOUT-1: an open pop-out of a shared card rides the same frame —
    // one column build, two setData calls (uplift_popout.js owns the
    // modal; this file only hands it the columns it just built).
    if (popHooks.ref) popHooks.ref.onSharedRedraw(tpsD, memD);
    // Keep the hovered position pinned across polls (index shifts otherwise);
    // when not hovering, show the latest samples.
    restoreCursor(tpsChart) || legendUpdater()(tpsChart);
    restoreCursor(memChart) || legendUpdater()(memChart);
    const shown = tpsChart.data[0].length;
    let label = shown > 1 ? `${windowLabel(cardWindow('chart-tps'))} window` : '';
    // FAST-1: honest cadence badge — the line only lies about smoothness
    // if the viewer cannot see which clock drew it. SMOOTH-1: the smoothing
    // word now tracks the control — 'off' must say so, never ride the old
    // unconditional 'smoothed' claim.
    if (shown > 1) {
        const kS = C.LAYOUT_SMOOTHES.includes(layout.tpsSmooth) ? layout.tpsSmooth : 1;
        if (tpsLiveOn) label += ` · 2 Hz · ${kS > 1 ? C.tf('uplift.explore.smoothed', 'smoothed') : C.tf('uplift.explore.smooth_off', 'smoothing off')}`;
        else if (kS > 1 && cardWindow('chart-tps') <= 3600) label += ` · ${C.tf('uplift.explore.smoothed', 'smoothed')}`;
    }
    // Honest resolution badge: hourly rollups backfill older stretches.
    const now = Date.now();
    const g = C.mergeHistory(chartHist.gen, tpsData[0], tpsData[1], cardWindow('chart-tps'), now);
    if (shown > 1 && g.boundary && g.boundary < now - 120000) {
        label += ` · hourly ≤ ${new Date(g.boundary).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    }
    $('chart-tps-window').textContent = label;
}
function rerenderChartsTheme() {
    // POPOUT-1: its uPlot holds old-theme colors and the card plot it
    // mirrored is gone — close it, the next titlebar click rebuilds.
    if (popHooks.ref) popHooks.ref.close();
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
/* SMOOTH-1: the Throughput smoothing control. Client-side display rule
   only — the store keeps its exact 5 s / 2 Hz semantics untouched, so no
   refetch is needed: re-set the data columns and redraw. */
function setTpsSmooth(k) {
    k = Number(k);
    if (!C.LAYOUT_SMOOTHES.includes(k)) return;
    if (k === layout.tpsSmooth) return;
    layout.tpsSmooth = k;
    C.saveLayout(localStorage, layout);
    redrawCharts();
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
    // U41 (user): when a metric's NAME already carries the unit
    // ("total W", "CPU °C", "memory %", "max RPM"), the VALUE must not
    // repeat it ("total W | 12.4 W"). Keys whose displayed names hold a
    // unit render bare numbers; the header power/temp chips keep their
    // units — they have no name. Names without a unit (cache efficiency,
    // tok/s, GiB bytes) keep theirs on the value.
    const unitInName = def.key && /(_w$|_temp_c$|rpm|pct$|percent$)/.test(def.key);
    if (def.fmt === 'bytes') return v => (v === null || v === undefined ? '—' : C.fmtBytes(v));
    if (def.fmt === 'pct') return v => (v === null || v === undefined ? '—'
                                       : v.toFixed(1) + (unitInName ? '' : '%'));
    if (def.fmt === 'count') return v => (v == null ? '—' : String(Math.round(v)));
    if (def.fmt === 'watts') return v => (v == null ? '—' : v.toFixed(1) + (unitInName ? '' : ' W'));
    if (def.fmt === 'temp') return v => (v == null ? '—' : Math.round(v) + (unitInName ? '' : ' °C'));
    if (def.key === 'engines.active_requests') return v => (v == null ? '—' : String(Math.round(v)));
    return seriesValue;
}
/* U8: which metric-card keys get a zero floor on the y-axis.
   2026-09-26 (user: "the graphs are floating because the 0 is in the
   middle"): extended to pct and bytes cards — auto-scaling to the data
   window put the line mid-plot on low-variance series; a floored axis
   shows the real magnitude. */
/* U8/SCALE-1: the y-range policy lives in chartkit (DOM-free, node-testable
   — tests/chart-zero-floor.test.cjs pins every card def). metricOpts routes
   the LEFT axis through it; the right-hand y2 always carries a rate or a
   count (prefill tok/s, restored tok/min, fan RPM) and keeps the U8 floor. */
const metricYRange = KIT.metricYRange;
function metricLabel(key) {
    const s = key.replace(/^(rate|tot|engines|mem|cache|pfx|spec|queue|pwr|therm|fan|prefill|mtp)\./, '')
        .replace(/_/g, ' ')
        .replace(/tps$/, 'tok/s');
    // U19/U20 human names for the uglier auto-translations.
    return ({ 'token hit pct': 'token hit %', 'lookup hit pct': 'lookup hit %',
              'saved tokens min': 'saved tok/min', 'restored tokens min': 'restored tok/min',
              'accepted tokens s': 'MTP accepted tok/s', 'accept pct': 'accepted %',
              'acceptance': 'MTP acceptance', 'depth acceptance': 'MTP depth acceptance',
              'cycles s': 'verify cycles/s', 'tokens per cycle': 'emitted tok/cycle',
              // SMOOTH-3 stacked cycle-outcome bands (locale normally wins).
              'cyc0 pct': '0 accepted %', 'cyc1 pct': '1 accepted %',
              'cyc2 pct': '2 accepted %', 'cyc3 pct': '3 accepted %',
              'cyc4p pct': '4+ accepted %',
              'total w': 'total W', 'cpu w': 'CPU W', 'gpu w': 'GPU W', 'ane w': 'ANE W',
              'cpu temp c': 'CPU °C', 'gpu temp c': 'GPU °C', 'max rpm': 'max RPM',
              'max pct': 'fan %', 'tokens min': 'tok/min', 'draw': 'power draw',
              'tokens s': 'computed prefill tok/s',
              // BE-decode: locale key normally wins; this keeps the last-
              // resort fallback honest if the locale fetch ever misses.
              'generation.tokens s': 'generation tok/s',
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
   legend, and may put lines on a right-hand y2 axis (different unit).
   SMOOTH-3: def.stack = the LEADING drawn (non-legendOnly) series form a
   100%/absolute stack — their data columns arrive pre-cumulated by
   drawMetricChart (vendor uPlot has no native stack), every stroke except
   the top edge hides, and opts.bands fill between consecutive paths with
   the band's own palette colour. `popout` renders the axis-bearing
   variant of the card (POPOUT-1): real time axis, roomier type. */
function metricServes(def) {
    return def.series && def.series.length ? def.series : [{ key: def.key, fmt: def.fmt }];
}
function metricStackCount(def) {
    if (!def || !def.stack || !def.series) return 0;
    let n = 0;
    for (const s of def.series) { if (s.legendOnly || s.axis) break; n++; }
    return n;
}
function metricOpts(id, def, col, opts) {
    const pop = !!(opts && opts.popout);
    const fmt = metricFormat(def);
    const mult = !!(def.series && def.series.length);
    const sers = metricServes(def);
    const nStack = metricStackCount(def);
    const hasY2 = mult && sers.some(s => s.axis === 'y2' && !s.legendOnly);
    const palette = seriesPalette(col);
    const series = [{}, ...sers.map((s, i) => {
        const sf = metricFormat({ key: s.key, fmt: s.fmt });
        const c = palette[i % palette.length];
        const sc = s.axis || (s.legendOnly ? 'yleg' : 'y');
        const inStack = i < nStack;
        const o = { label: metricSeriesLabel(s.key), scale: sc,
                    stroke: c, width: (s.legendOnly || inStack) ? 0 : 1.6,
                    // BUG-4: same cadence-gap bridge as the big charts —
                    // metricUnionCols mixes live 500 ms and stored 5 s
                    // stamps into one x column.
                    gaps: KIT.gapBridge(),
                    // SMOOTH-3: the FIRST stacked series' area (path to 0)
                    // paints the bottom band; the uPlot opts.bands fill
                    // the rest between consecutive cumulative paths.
                    // Non-stacked cards keep the exact old wash ('1c').
                    fill: (nStack > 1 && i === 0) ? tint(c, '3d')
                          : (s.area || (!mult && i === 0)) ? tint(c, '1c') : undefined,
                    points: { show: false }, value: (u, v) => sf(v === undefined || v !== v ? null : v) };
        return o;
    })];
    // Every stacked column hides its stroke (bands carry the fills, the
    // top of a 100% stack would only draw a line at the ceiling); band
    // paths build regardless of width — verified against the vendor
    // drawSeries path logic (band dirs come from opts.bands, not stroke).
    const scales = { x: { time: true, range: pinnedXRange(id) },
                     y: { auto: true, range: metricYRange(def) } };
    if (sers.some(s => s.legendOnly)) scales.yleg = { auto: true };
    // SCALE-1: y2 always carries a rate or a count (prefill tok/s, restored
    // tok/min, fan RPM) — those read 0 honestly, so the U8 floor stays.
    if (hasY2) scales.y2 = { auto: true, range: ZERO_FLOOR_RANGE };
    const axes = pop ? [popoutXAxis(cardWindow(id), col), metricYAxis(col, def, true)]
                     : [metricXAxis(cardWindow(id), col), metricYAxis(col, def)];
    if (hasY2) {
        const y2ser = sers.find(s => s.axis === 'y2' && !s.legendOnly);
        axes.push(Object.assign(
            { stroke: col.gold, size: 4, font: axisFont(col), grid: false, gap: 2,
              rotate: 0, space: 50, side: 1, label: '',
              values: (u, vals) => vals == null ? vals
                  : vals.map(v => v == null ? '' : metricYFmt({ key: y2ser.key, fmt: y2ser.fmt || def.fmt })(v)) },
            { scale: 'y2' }));
    }
    const out = {
        width: pop ? 600 : 300, height: pop ? 420 : 100,
        padding: pop ? [10, 8, 4, 0] : [8, 4, 6, 0],   // top: label-centred ticks clip without it; bottom: 0-line gap (2026-09-26)
        ms: KIT.TSTAMP_MS,   // x columns are ms-epoch (TSTAMP_MS in chartkit)
        cursor: { drag: { x: false, y: false }, points: { show: true, size: pop ? 6 : 5, fill: col.dim } },
        // SWEEP178: live:false like the shared charts. With live:true the
        // vendored build re-paints the value cells on its own deferred draw
        // pass and stamps '—' (null through series.value) right after our
        // legendUpdater painted the real values; the updater owns the cells.
        legend: { show: mult, live: false },
        scales, axes, series,
    };
    if (nStack > 1) {
        out.bands = KIT.stackBands(nStack).map((b, i) => Object.assign(b, {
            // stackBands emits pairs (1,2)..(n-1,n) in uPlot series space;
            // band i (0-based) fills between cum(i+1) and cum(i+2), i.e.
            // the share of DRAWN series i+2 (1-based) = palette slot i+1.
            fill: tint(palette[(i + 1) % palette.length], pop ? '55' : '3d'),
        }));
    }
    return out;
}
/* Visible-x-axis variant of metricXAxis for the pop-out (the compact card
   hides its axis — see metricXAxis; the enlarged view earns the labels). */
function popoutXAxis(win, col) {
    const dayish = win >= 86400;
    return { stroke: col.dim, width: 1, size: 26, font: axisFont(col, 1.35),
             grid: false, gap: 4, rotate: 0, space: 70,
             values: (s, t) => t.map(ts => new Date(ts).toLocaleString('en-GB',
                 dayish ? { month: 'short', day: 'numeric' }
                        : { hour: '2-digit', minute: '2-digit', ...(win < 900 ? { second: '2-digit' } : {}) })) };
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
    return { show: false, stroke: col.dim, width: 1, rotate: 0, font: axisFont(col),
             values: (s, t) => t.map(ts => new Date(ts).toLocaleString('en-GB',
                 dayish ? { month: 'short', day: 'numeric' }
                        : { hour: '2-digit', minute: '2-digit' })) };
}
/* Compact axis labels with units (user 2026-09-21: raw y-labels like
   '1234567' clipped inside the 30px gutter of the small metric cards).
   <=4 chars so the 26px gutter never clips; ticks thin out via space,
   rotate is pinned off — rotated labels reach past the gutter too. */
function metricYFmt(def) {
    // U40: RAM/cache byte axes read in binary GiB/MiB (matches fmtBytes).
    if (/(bytes)/.test(def.key))
        return v => (v === 0 ? '0'
                     : v >= 2 ** 30 ? (v / 2 ** 30).toFixed(v >= 2 ** 34 ? 0 : 1) + 'Gi'
                                    : (v / 2 ** 20).toFixed(0) + 'Mi');
    return v => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
                 : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + 'k'
                 : String(Math.round(v * 10) / 10));
}
function metricYAxis(col, def, popout) {
    // Labels render left-aligned at size+gap+12; 26 wasted ~48px of card
    // width on the left gutter (2026-09-26). 10 keeps them clear of the
    // card edge while pulling the plot to nearly full width. The pop-out
    // (POPOUT-1) earns a real gutter: roomy band + bigger type.
    return popout
        ? { stroke: col.dim, size: 34, font: axisFont(col, 1.35), grid: true,
            gap: 6, rotate: 0, space: 44, label: '',
            values: (u, vals) => vals == null ? vals : vals.map(v => v == null ? '' : metricYFmt(def)(v)) }
        : { stroke: col.dim, size: 4, font: axisFont(col), grid: true, gap: 2,
            rotate: 0, space: 26, label: '',
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
    // FAST-1: short-window eligible series draw from the 2 Hz live ring
    // when it is fresh; the stored fetch still backfills everything the
    // ring does not cover (feed dead -> columns fall through unchanged).
    const win = cardWindow(id);
    const liveOn = LF.liveForWindow(win);
    let liveUsed = false;
    let data = cache.data;
    if (liveOn) {
        const sers = metricServes(e.def);
        if (sers.some(s => LF.liveUsable(s.key))) {
            for (const s of sers) {
                if (!LF.liveUsable(s.key)) continue;
                const lc = LF.liveCol(s.key);
                data = { ...data, [s.key]: lc.ts.map((t, i) => ({ ts: t / 1000, v: lc.v[i] })) };
                liveUsed = true;
            }
        }
    }
    const cols = metricUnionCols(e.def, data, winMs);
    // U40: rate gauges are per-tick counter deltas — spiky by construction.
    // Smooth the drawn+hovered columns with a window-scaled centered mean
    // (the note badge replaces 'live'). Long windows are already avg-
    // downsampled server-side (bucket >= 60 s), so smoothing there is
    // double-averaging and stays off.
    const k = cardWindow(id) <= 300 ? 3 : cardWindow(id) <= 3600 ? 5 : 1;
    let smoothed = false;
    if (k > 1 && cache.bucket_s < 60) {
        const sers = metricServes(e.def);
        for (let i = 0; i < sers.length; i++) {
            if (!C.smoothKey(sers[i].key)) continue;
            cols[i + 1] = C.movingAverage(cols[i + 1], k);
            smoothed = true;
        }
    }
    // SMOOTH-3: stacked card -> feed uPlot the CUMULATIVE columns (bands
    // fill between consecutive paths; the vendor build has no native
    // stack). The RAW columns stay on the entry: the legend/tooltip read
    // them, so a hovered row shows the band's own share, never the sum.
    const nStack = metricStackCount(e.def);
    if (nStack > 1) {
        const bandCols = cols.slice(1, nStack + 1);
        e.rawCols = bandCols.map(c => c.slice());
        const cum = KIT.stackCumulative(bandCols);
        for (let i = 0; i < nStack; i++) cols[i + 1] = cum[i];
    } else {
        e.rawCols = null;
    }
    e.lastCols = cols;
    e.chart.setData(cols);
    e.chart._rawSeries = e.rawCols;
    if (popHooks.ref) popHooks.ref.onMetricDraw(id, cols, e.rawCols);
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
    // FAST-1: say which clock drew this card. '2 Hz' is a unit token
    // (like GiB — locale-neutral), and the live columns always ride the
    // k=3 smoothing path below, so the existing 'smoothed' key carries it.
    if (liveUsed) bits.push('2 Hz');
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
    else if (smoothed) bits.push(C.tf('uplift.explore.smoothed', 'smoothed'));
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
        ms: KIT.TSTAMP_MS,   // x column is ms-epoch (uplift_usage.js: base.getTime())
        scales: { x: { time: true }, y: { auto: true, range: ZERO_FLOOR_RANGE } },  // U8
        axes: [{ stroke: col.dim, size: 36, font: axisFont(col),
                 values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) },
               yAxis(col, { grid: true })],
        series: [{ label: 'tokens' }, line('tokens', 'blue', true)],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: false },
    }, [[], []], el);
    bindCursorTip(usageChart);
}

function markHistoryDirty() { historyDirty = true; loadChartHistory(); }

/* U11 live memory line + U38 GiB columns: the collector's mem.* ticks
   (enforcer footprint + both absolute limits) are the points pushed into
   the Memory chart. /admin/api/stats has no system-memory fields
   (model_memory_used is phys_footprint — flat), so the newest stored
   samples come from /metrics/latest, refreshed at most every 10s.
   U30: the same latest-fetch carries rate.cached_tokens_s — the throughput
   chart's live dotted prefill-colour line (no stats field for it either). */
let sysFetching = false, sysAt = 0;
let sysLive = { usedGB: null, ceilGB: null, iogpuGB: null, ts: 0 };
let cachedTps = null, cachedTpsTs = 0;
// BE-prefill: live per-tick computed-prefill rate (the chart's prefill
// line). /admin/api/stats only carries the session AVERAGE (avg_prefill_tps)
// — one request cannot move it visibly, the bug this replaces. The
// collector's prefill.tokens_s IS the current rate; rides the same
// latest-fetch below, stale reads push null (never a stale number).
let prefillLiveTps = null, prefillLiveTs = 0;
// BE-decode: live per-tick generation tok/s (the chart's generation line).
// /admin/api/stats only carries avg_generation_tps — the session LIFETIME
// average, mathematically nearly flat ("like cumulative stats"). The
// collector's generation.tokens_s IS the current rate; rides the same
// latest-fetch below, stale reads push null (never a stale number).
let genLiveTps = null, genLiveTs = 0;
// MTP accepted draft tok/s (the chart's 4th line). Collector-written every
// tick (zeros included), so a stale-free absence window is not needed the
// way gen/prefill need theirs; same 120 s staleness rule keeps it honest.
let mtpLiveTps = null, mtpLiveTs = 0;
async function refreshSysPct() {
    const now = Date.now();
    if (sysFetching || now - sysAt < 10_000) return;
    sysFetching = true; sysAt = now;
    try {
        const r = await CH_GLUE.fetchJson(`${API}/uplift/api/metrics/latest?keys=` +
            encodeURIComponent('mem.used_bytes,mem.custom_ceiling_bytes,mem.iogpu_limit_bytes,rate.cached_tokens_s,prefill.tokens_s,generation.tokens_s,mtp.accepted_tokens_s'));
        const lat = (r && r.latest) || {};
        const gb = k => (lat[k] && typeof lat[k].v === 'number') ? +(lat[k].v * GIB).toFixed(3) : null;
        const u = lat['mem.used_bytes'];
        if (u && typeof u.v === 'number') {
            sysLive = { usedGB: +(u.v * GIB).toFixed(3),
                        ceilGB: gb('mem.custom_ceiling_bytes'),
                        iogpuGB: gb('mem.iogpu_limit_bytes'),
                        ts: u.ts * 1000 };
        }
        const c = lat['rate.cached_tokens_s'];
        if (c && typeof c.v === 'number') { cachedTps = c.v; cachedTpsTs = c.ts * 1000; }
        const pl = lat['prefill.tokens_s'];
        if (pl && typeof pl.v === 'number') { prefillLiveTps = pl.v; prefillLiveTs = pl.ts * 1000; }
        const gl = lat['generation.tokens_s'];
        if (gl && typeof gl.v === 'number') { genLiveTps = gl.v; genLiveTs = gl.ts * 1000; }
        const ml = lat['mtp.accepted_tokens_s'];
        if (ml && typeof ml.v === 'number') { mtpLiveTps = ml.v; mtpLiveTs = ml.ts * 1000; }
    } catch (_) { /* keep last value */ }
    finally { sysFetching = false; renderMemLabel(); }
}

/* Memory & cache card header (#mem-label): the three absolute figures the
   chart plots, as "name value" pairs on the GiB ladder (user 2026-10-02:
   replaces the old "XX% ok" memory-pressure readout, which compared
   /admin/api stats against a budget the chart no longer draws). Values are
   unit-less by request; the GiB axis says the unit. Absent series (unset
   ceiling, no macmon iogpu sample) show '—', never a stale number. */
function renderMemLabel() {
    const el = $('mem-label');
    if (!el) return;
    const fresh = sysLive.ts && Date.now() - sysLive.ts < 120_000;
    const v = n => (fresh && typeof n === 'number')
        ? String(Math.round(n * 10) / 10) : '—';
    if (!fresh && sysLive.usedGB === null) { el.textContent = ''; return; }
    // DOM construction, not innerHTML (project rule); b styling exists in
    // .card h2 .right b.
    el.textContent = '';
    const parts = [['omlx memory', sysLive.usedGB],
                   ['settings ceiling', sysLive.ceilGB],
                   ['iogpu wired limit', sysLive.iogpuGB]];
    parts.forEach(([name, val], i) => {
        if (i) el.append(' / ');
        el.append(name + ' ');
        const b = document.createElement('b');
        b.textContent = v(val);
        el.append(b);
    });
}

/* U20 header chips: the VALUE mirrors the graph card header ("live"
   readout) exactly — the newest sample of the card's PRIMARY key (power:
   pwr.total_w; temperature: therm.cpu_temp_c, the card's own first
   series), same fetch window, last-non-null, no averaging, no smoothing.
   U20's 60 s mean/max aggregation is retired to the TOOLTIP (the safety
   readout stays one hover away); a chip whose number could never equal
   the header number right below it read as a defect (user 2026-10-08:
   "the temperature at the top should be the same as the live temperature
   in the graph header; same goes for watts"). Refresh 10 s ≈ the card's
   own redraw cadence; the stored series is the only clock here — macmon
   keys are deliberately never 2 Hz fast-sampled (FAST-1 rule), so chip
   and card tick on the same 5 s collector and a shared fetch can only
   lag by which side refreshed last, never by a different statistic.
   Chips appear ONLY when the series exist — macmon absent means the keys
   never have samples and both chips stay hidden (silent absence). */
let pwrChipsAt = 0, pwrChipsFetching = false;
/* Pure aggregation (node-tested): points newest-last (store ORDER BY ts
   contract). DISPLAYED value = last non-null of the card's PRIMARY key —
   literally the card header's rule (drawMetricChart's pcol scan), no
   cross-series cleverness. statsOver only feeds the tooltip (60 s
   max/mean across the named series). Returns null when the primary key
   has no fresh sample (chip stays hidden, U24 silent-absence doctrine). */
function chipReadout(seriesMaps, primary, statsOver) {
    const out = { primary: null };
    const p = (seriesMaps[primary] || []);
    for (let i = p.length - 1; i >= 0; i--) {
        if (p[i] && p[i].v != null) { out.primary = p[i].v; break; }
    }
    const pool = [];
    for (const k of (statsOver && statsOver.length ? statsOver : [primary]))
        for (const q of (seriesMaps[k] || [])) if (q && q.v != null) pool.push(q.v);
    out.mean60 = pool.length ? pool.reduce((a, v) => a + v, 0) / pool.length : null;
    out.max60 = pool.length ? Math.max(...pool) : null;
    return out.primary == null ? null : out;
}
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
        const fresh = k => (map[k] || []).filter(p => p.v != null && now - p.ts * 1000 < 5 * 60_000 + 15_000);
        const freshMap = { 'pwr.total_w': fresh('pwr.total_w'),
                           'therm.cpu_temp_c': fresh('therm.cpu_temp_c'),
                           'therm.gpu_temp_c': fresh('therm.gpu_temp_c') };
        const cp = document.getElementById('chip-power');
        const tc = document.getElementById('chip-temp');
        const pw = chipReadout(freshMap, 'pwr.total_w', null);
        if (cp) {
            if (pw) {
                cp.textContent = pw.primary.toFixed(1) + ' W';
                cp.title = C.tf('uplift.chip.power_mean', 'Package power — 60 s mean') +
                           `: ${pw.mean60.toFixed(1)} W`;
                cp.hidden = false;
            } else cp.hidden = true;
        }
        const tm = chipReadout(freshMap, 'therm.cpu_temp_c',
                               ['therm.cpu_temp_c', 'therm.gpu_temp_c']);
        if (tc) {
            if (tm) {
                tc.textContent = Math.round(tm.primary) + ' °C';
                tc.title = C.tf('uplift.chip.temp_max', 'Max CPU/GPU temp — 60 s max') +
                           `: ${Math.round(tm.max60)} °C`;
                tc.classList.toggle('chip-hot', Math.round(tm.primary) >= 85);
                tc.hidden = false;
            } else { tc.hidden = true; tc.classList.remove('chip-hot'); }
        }
    } catch (_) { /* keep last render; absence stays silent */ }
    finally { pwrChipsFetching = false; }
}

function pushStatusSample(s) {
    refreshSysPct();   // fire-and-forget; lands in the next push
    // Chart buffers (window pruning happens at draw time). U30: column 3 =
    // cached tok/s from the metrics/latest poll (collector tick rate, ~10 s
    // fresh window; stale reads push null, never a stale number).
    // BE-prefill: column 2 = the collector's per-tick prefill.tokens_s
    // (same latest poll, same staleness rule) — was the session average
    // s.prefillTps, which no single prefill could move.
    // BE-decode: column 1 = the collector's per-tick generation.tokens_s
    // for the same reason — s.genTps is avg_generation_tps, a session
    // LIFETIME average (the tile keeps showing it, correct there).
    tpsData[0].push(s.time);
    tpsData[1].push(genLiveTps !== null && Date.now() - genLiveTs < 120_000 ? genLiveTps : null);
    tpsData[2].push(prefillLiveTps !== null && Date.now() - prefillLiveTs < 120_000 ? prefillLiveTps : null);
    tpsData[3].push(cachedTps !== null && Date.now() - cachedTpsTs < 120_000 ? cachedTps : null);
    tpsData[4].push(mtpLiveTps !== null && Date.now() - mtpLiveTs < 120_000 ? mtpLiveTps : null);
    while (tpsData[0].length > MAX_POINTS) for (const col of tpsData) col.shift();
    // U40: ONE summed hot-cache point in GiB. Prefer upstream's process-wide
    // hot_cache_size_bytes (the exact global, same number classic shows);
    // fall back to summing the per-model rows when it's absent.
    const hotBytes = s.hotCacheBytes !== null
        ? s.hotCacheBytes
        : (s.cacheModels || []).reduce((a, m) => a + (m.hotBytes || 0), 0);
    hotLive.ts.push(s.time);
    hotLive.v.push(+(hotBytes * GIB).toFixed(3));
    while (hotLive.ts.length > MAX_POINTS) { hotLive.ts.shift(); hotLive.v.shift(); }
    // U38: omlx footprint GiB + the two absolute limit lines (collector
    // mem.* via metrics/latest). Limits absent -> null (flat line hidden).
    const fresh = sysLive.ts && Date.now() - sysLive.ts < 120_000;
    memData[0].push(s.time);
    memData[1].push(fresh ? sysLive.usedGB : null);
    memData[2].push(fresh ? sysLive.ceilGB : null);
    memData[3].push(fresh ? sysLive.iogpuGB : null);
    while (memData[0].length > MAX_POINTS) for (const col of memData) col.shift();
    redrawCharts();
}

window.Uplift.charts = {
    line: line, yAxis: yAxis, seriesValue: seriesValue, bindCursorTip: bindCursorTip,
    axisFont: axisFont, chartColors: chartColors,
    tint: tint, seriesPalette: seriesPalette,
    tpsData: tpsData, memData: memData,
    pushStatusSample: pushStatusSample,
    createCharts: createCharts, redrawCharts: redrawCharts, resizeCharts: resizeCharts,
    rerenderChartsTheme: rerenderChartsTheme, createUsageChart: createUsageChart,
    loadChartHistory: loadChartHistory, markHistoryDirty: markHistoryDirty,
    relabelExplore: relabelExplore, windowLabel: windowLabel,
    setGlobalWindow: setGlobalWindow, setTpsSmooth: setTpsSmooth, renderCardTsRows: renderCardTsRows,
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
    // NAT-6 chip fix: node tests slice/verify the chip aggregation rule
    chipReadout: chipReadout,
    /* POPOUT-1: registration + the read/build surface the pop-out module
       needs (it must never reach into this IIFE's internals any other
       way; getters keep the values live across theme re-inits). */
    registerPopout(api) { popHooks.ref = api; },
    popGlue: {
        chartColors: () => chartColors(),
        legendUpdater: () => legendUpdater(),
        bindCursorTip: c => bindCursorTip(c),
        bindCursorUpdater: c => bindCursorUpdater(c),
        pinnedXRange: id => pinnedXRange(id),
        cardWindow: id => cardWindow(id),
        metricOpts: (id, def, col, opts) => metricOpts(id, def, col, opts),
        tpsBaseOpts: (col, pop, win) => tpsBaseOpts(col, pop, win),
        memBaseOpts: (col, pop, win) => memBaseOpts(col, pop, win),
        multInitData: def => multInitData(def),
        metricLabel: key => metricLabel(key),
        metricEntry: id => metricCharts.get(id),
        hasMetric: id => metricCharts.has(id),
        tpsWindowed: () => tpsWindowed(),
        memWindowed: () => memWindowed(),
    },
};
})();
