/* Uplift BOOT SEQUENCE (PH2-1 stage 8 extraction from uplift.js): the tail
   that used to close uplift.js's IIFE, byte-identical in order — device
   chip, visibility kick, prefs/locale, chart init + ResizeObservers,
   applyTab, pollers, metric cards, module inits, interval registry.
   Loads LAST: uplift.js's IIFE has fully executed by then, so every
   hoisted internal (pollStats, applyTab, restartPolling, renderTasks,
   applyPrefs, loadLocale, currentTab/currentSub) is alive in
   window.Uplift._bootGlue (FE-1: fetchJson there resolves through
   window.UpliftDom, the single implementation), and every module alias (CH/MM/GSY/UUP/FE/PT)
   resolves. Sequencing note kept from the original: metric cards are
   generated BEFORE grid init runs (applyTab defers ensureUpliftGrid via
   requestAnimationFrame) so the board places them like static blocks. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const $ = D.$;
const API = window.Uplift.state.API;
const CH = window.Uplift.charts;
const MM = window.Uplift.modelmgr;
const GSY = window.Uplift.gsys;
const UUP = window.Uplift.usage;
const FE = window.Uplift.feed;
const LF = window.Uplift.livefeed;   // FAST-1 live display feed
const layout = window.Uplift.state.layout;
const PT = window.Uplift.patches;
const { fetchJson, applyPrefs, loadLocale, applyTab, restartPolling,
        pollStats, pollGatewayInfo, renderTasks, loadSkins, renderSkinsMenu,
        currentTab, currentSub } = window.Uplift._bootGlue;
fetchJson(`${API}/admin/api/device-info`).then(d => {
    // RAM is sold decimal but reported by the OS in binary; Apple's own
    // instruments say GiB (32 GB modules = 32 GiB on Apple Silicon).
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GiB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});
/* U10: header shows which keg is serving. Identity comes from the server
   (GET identity) — never inferred from files on disk, which exist even when
   the vanilla keg answers. 'DEV' is brand text (like 'Uplift'): untranslated,
   colour via --dev-accent so skins can restyle it. */
fetchJson(`${API}/admin/api/identity`).then(d => {
    if (!d || !d.dev) return;
    const f = $('logo-flavor');
    f.textContent = 'DEV';
    f.classList.add('dev-tag');
    document.querySelector('.logo')?.classList.add('is-dev');
    document.title = 'oMLX · DEV';
}).catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollGatewayInfo();
    if (currentTab() === 'usage') UUP.pollUsage();
    if (currentTab() === 'logs') UUP.pollLogs();
    // task-list poll chains self-terminate while hidden; kick the current one again
    const TASK_HOSTS = { downloader: ['dl-tasks', 'hf'], quantizer: ['qz-tasks', 'oq'], uploader: ['up-tasks', 'upload'] };
    if (currentTab() === 'models') {
        const pair = TASK_HOSTS[currentSub('models')];
        if (pair) renderTasks(pair[0], pair[1]);
    }
    CH.resizeCharts();
});

applyPrefs();
loadSkins();   // picker + data-theme resolve once the server listing lands
// ?lang=xx overrides the locale (testing/demo; server setting is default)
loadLocale(new URLSearchParams(location.search).get('lang') || undefined);
CH.createCharts();
CH.resizeCharts();
// PH2-1 stage 2: chart-host ResizeObservers (moved out of uplift_charts.js;
// resizeCharts() reads metricCharts there — const TDZ made load-time firing
// unsafe). The grid box drives the observer; chart hosts are observed too —
// column-count changes shrink boxes INSIDE the grid, and canvases would keep
// the old, wider size and overflow narrow columns.
new ResizeObserver(CH.resizeCharts).observe($('grid'));
for (const id of ['chart-tps', 'chart-mem', 'chart-usage'])
    if ($(id)) new ResizeObserver(CH.resizeCharts).observe($(id));
applyTab();
GSY.gateClusterFromServer();
restartPolling();
pollGatewayInfo();
CH.loadChartHistory();
setInterval(() => { if (!document.hidden) CH.loadChartHistory(); }, 60000);
// Metric cards: generate DOM from the catalogue BEFORE grid init so the
// board places them like any static block; boot fetch + keep-alive (the
// per-window cache TTL gates refetches: 10 s short, 60 s week+).
// U24: gated (macmon) cards are created too — born PARKED (hidden, no slot,
// no tray pill) until the probe has seen their data; they then take their
// DEFAULT slot without anything moving. Presence detection stays data-driven
// (probe below), never a layout rewrite, so saved custom layouts are untouched.
for (const def of C.EXPLORE_METRICS)
    CH.createMetricCard(def, !!(def.gated && !CH.gatedSeen(def.key)));
/* U24: gated (macmon) cards + header chips become visible only once the
   series actually have values — silent absence otherwise. Probe is cheap
   (one /metrics/latest); re-check every 60 s so a macmon installed
   mid-session lights up without a reload. */
CH.probeGatedCards();
setInterval(() => { if (!document.hidden) CH.probeGatedCards(); }, 60000);
CH.refreshPowerChips();
setInterval(() => { if (!document.hidden) CH.refreshPowerChips(); }, 12000);
/* ---- PAT-4 patches page: extracted to uplift_patches.js (PH2-1 stage 8);
   window.Uplift.patches aliases live at the top. initPatchesPage() boots
   its own listeners; pollPatches runs via applyTab. ---- */
PT.initPatchesPage();

CH.renderCardTsRows();
CH.drawAllMetricCharts();
setInterval(() => { if (!document.hidden && currentTab() === 'status') CH.drawAllMetricCharts(); }, 5000);
UUP.initUsageRange();   // seeds the range select now that glue helpers exist
UUP.pollUsage(); UUP.pollLogs();
FE.connectEventStream();
/* FAST-1: live display feed (2 Hz SSE, memory-only server side). HANG-1:
   the boot connects are focus-gated INSIDE connect() — a tab opened in the
   background keeps zero permanent streams; a browser allows ~6 concurrent
   connections per origin over HTTP/1.1 and two forever streams per visible
   tab starved the 4th tab's page load (measured). The unfocused 2 s poll
   and the 5 s stored redraw carry background tabs until they take focus.
   Redraw rule: shared charts every frame (~2 Hz — that is the point),
   metric cards at half rate (the grid renders many canvases; 1 Hz is
   already 5x the stored cadence and keeps a laptop tab cool). Both paths
   skip the store fetch — metricFetch's TTL still gates server hits. */
let _lfMainPending = false, _lfCardsAt = 0;
LF.onFrame(() => {
    if (document.hidden || currentTab() !== 'status') return;
    if (_lfMainPending) return;
    _lfMainPending = true;
    requestAnimationFrame(() => {
        _lfMainPending = false;
        CH.redrawCharts();
        const now = Date.now();
        // half rate for the grid: many canvases, and 1 Hz is already 5x
        // the stored cadence — keeps a laptop tab cool
        if (now - _lfCardsAt >= 900) { _lfCardsAt = now; CH.drawAllMetricCharts(); }
    });
});
if (layout.liveFeed) {
    LF.probe(fetchJson);
    if (window.EventSource) LF.connect();
}
setInterval(pollGatewayInfo, 10000);
setInterval(() => { if (!document.hidden && !FE.sseOpen()) FE.pollRequests(); }, 2000);  // FEED-1
setInterval(() => { if (!document.hidden && !MM.seModel) MM.render(); }, 8000);
setInterval(() => { if (!document.hidden && currentTab() === 'usage') UUP.pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && UUP.logsFollow) UUP.pollLogs(); }, 5000);
})();
