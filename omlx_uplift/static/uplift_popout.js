/* POPOUT-1 (user 2026-10-10): "could we make any graph pop up when the
   titlebar is clicked, so it fills the screen and is focused and
   readable?" — one enlarged clone of any chart card, opened by clicking
   its titlebar, closed by × / backdrop / Escape (the GLOBAL dialog
   handler in uplift_state.js reaches it through __upliftModalClose, so
   this module registers no keydown listener of its own — the
   modal-escape guard in tests/ keeps exactly one).

   Lives in its OWN file (split-module doctrine, like uplift_inspector):
   uplift_charts.js only hands columns through popHooks; everything
   modal-shaped is here. The chart is built by the SAME opts
   constructors as the card (metricOpts / tpsBaseOpts / memBaseOpts with
   the popout variant), so a style, stack, or axis change lands in both
   views by construction — there is no second palette to forget.

   Live data: the card paths push the columns they just built
   (onSharedRedraw / onMetricDraw) AND a 1 s timer repaints the pinned
   window (window edges move every second even when no sample arrives),
   so the pop-out never shows a stale right edge.

   Layout-edit mode is excluded at the click site — the handle is the
   GridStack drag handle and must stay pure while customizing. */
(function () {
'use strict';
const C = window.UpliftCore;
const uPlot = window.uPlot;

let popout = null;   // { id, chart, overlay, note, ro, timer }
function glue() { return window.Uplift.charts; }
function PG() { return window.Uplift.charts.popGlue; }

function close() {
    if (!popout) return;
    clearInterval(popout.timer);
    if (popout.ro) popout.ro.disconnect();
    try { popout.chart.destroy(); } catch (_) {}
    if (popout.overlay) popout.overlay.remove();
    popout = null;
}
function dataFor(id) {
    const pg = PG();
    if (id === 'chart-tps') return pg.tpsWindowed();
    if (id === 'chart-mem') return pg.memWindowed();
    const e = pg.metricEntry(id);
    return e ? (e.lastCols || pg.multInitData(e.def)) : [[]];
}
function paint(c, id) {
    c.setData(dataFor(id));
    const pg = PG(), e = pg.metricEntry(id);
    c._rawSeries = (id !== 'chart-tps' && id !== 'chart-mem' && e) ? e.rawCols : null;
    pg.legendUpdater()(c);
    // Honest resolution note: mirror the card's OWN badge text (2 Hz /
    // averaged / hourly / no data) — one source, never a second opinion.
    if (popout && popout.note) {
        const src = id === 'chart-tps' ? document.getElementById('chart-tps-window')
            : id === 'chart-mem' ? null
            : (pg.metricEntry(id) || {}).noteEl;
        popout.note.textContent = (src && src.textContent) || '';
    }
}
function titleFor(id) {
    const pg = PG();
    const e = pg.metricEntry(id);
    if (e) {
        const tk = e.def.titleKey || e.def.key;
        return (C.tf && C.tf('uplift.metric.' + tk, pg.metricLabel(tk))) || pg.metricLabel(tk);
    }
    return id === 'chart-tps' ? C.tf('uplift.card.throughput', 'Throughput')
                              : C.tf('uplift.card.memory_cache', 'Memory & cache');
}
function open(id) {
    const pg = PG();
    if (popout && popout.id === id) { close(); return; }
    close();
    if (!(id === 'chart-tps' || id === 'chart-mem' || pg.hasMetric(id))) return;
    const col = pg.chartColors();
    const win = pg.cardWindow(id);
    const e = pg.metricEntry(id);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay chart-pop-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa chart-pop';
    const head = document.createElement('div'); head.className = 'chart-pop-head';
    const title = document.createElement('h3');
    title.textContent = titleFor(id);
    const note = document.createElement('span'); note.className = 'chart-pop-note';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'chart-pop-x'; btn.textContent = '\u00d7';
    btn.setAttribute('aria-label', 'Close');
    head.append(title, note, btn);
    const host = document.createElement('div'); host.className = 'chart-pop-plot';
    box.append(head, host);
    overlay.append(box);
    document.body.append(overlay);

    // Build the chart the SAME way the card does, popout variant.
    let opts = e ? pg.metricOpts(id, e.def, col, { popout: true })
        : id === 'chart-tps' ? pg.tpsBaseOpts(col, true, win)
        : pg.memBaseOpts(col, true, win);
    opts.scales.x.range = pg.pinnedXRange(id);
    // Size AFTER mount (a fresh uPlot starts at width 0 — integration
    // note); the host is the flex child, its box is the plot's box.
    opts.width = Math.max(320, host.clientWidth - 8);
    opts.height = Math.max(240, host.clientHeight || 480);
    const chart = new uPlot(opts, dataFor(id), host);
    if (e) chart._rawSeries = e.rawCols;
    pg.bindCursorTip(chart);
    pg.bindCursorUpdater(chart);

    const ro = new ResizeObserver(() => {
        const w = Math.max(320, host.clientWidth - 8);
        const h = Math.max(240, host.clientHeight || 240);
        chart.setSize({ width: w, height: h });
        const wrap = host.querySelector('.uplot');
        if (wrap) wrap.style.height = h + 'px';   // setSize only ever grows it
    });
    ro.observe(host);

    popout = { id, chart, overlay, note, ro, timer: setInterval(() => paint(chart, id), 1000) };
    paint(chart, id);
    btn.onclick = close;
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    overlay.__upliftModalClose = close;
}

/* Delegated title click: any chart card pops out. The target is the h2
   TITLE text (the visible titlebar) — .card-handle lives in the chrome
   strip that only renders in layout-edit mode, where clicks must stay
   pure drag input, so the handle path is skipped entirely while
   editing. Never on the remove button or the timespan chips inside h2
   (those are separate controls with their own handlers). */
document.addEventListener('click', ev => {
    if (document.body.classList.contains('layout-editing')) return;
    const t = ev.target && ev.target.closest ? ev.target.closest('h2 span[data-i18n], .card-handle') : null;
    if (!t || t.tagName === 'BUTTON' || t.closest('.ts-row') || t.closest('.right')) return;
    const card = t.closest('[data-block]');
    const id = card && card.dataset.block;
    if (!id) return;
    const pg = PG();
    if (pg && (id === 'chart-tps' || id === 'chart-mem' || pg.hasMetric(id))) {
        ev.preventDefault();
        open(id);
    }
});

window.Uplift.popout = {
    open, close,
    /* Registered into uplift_charts.js's popHooks on load — the card
       redraw paths call these with the columns they just built. */
    onSharedRedraw(tpsD, memD) {
        if (!popout) return;
        if (popout.id === 'chart-tps') popout.chart.setData(tpsD);
        else if (popout.id === 'chart-mem') popout.chart.setData(memD);
        else return;
        PG().legendUpdater()(popout.chart);
    },
    onMetricDraw(id, cols, rawCols) {
        if (!popout || popout.id !== id) return;
        popout.chart.setData(cols);
        popout.chart._rawSeries = rawCols;
        PG().legendUpdater()(popout.chart);
        if (popout.note) {
            const src = (PG().metricEntry(id) || {}).noteEl;
            popout.note.textContent = (src && src.textContent) || '';
        }
    },
};
if (glue() && glue().registerPopout) glue().registerPopout(window.Uplift.popout);
})();
