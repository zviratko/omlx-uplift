/* Uplift BOOT SEQUENCE (PH2-1 stage 8 extraction from uplift.js): the tail
   that used to close uplift.js's IIFE, byte-identical in order — device
   chip, visibility kick, prefs/locale, chart init + ResizeObservers,
   applyTab, pollers, metric cards, module inits, interval registry.
   Loads LAST: uplift.js's IIFE has fully executed by then, so every
   hoisted internal (pollStats, applyTab, restartPolling, renderTasks,
   applyPrefs, loadLocale, currentTab/currentSub) is alive in
   window.Uplift._bootGlue, and every module alias (CH/MM/GSY/UUP/FE/PT)
   resolves. Sequencing note kept from the original: metric cards are
   generated BEFORE grid init runs (applyTab defers ensureUpliftGrid via
   requestAnimationFrame) so the board places them like static blocks. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);
const API = window.Uplift.state.API;
const CH = window.Uplift.charts;
const MM = window.Uplift.modelmgr;
const GSY = window.Uplift.gsys;
const UUP = window.Uplift.usage;
const FE = window.Uplift.feed;
const PT = window.Uplift.patches;
const { fetchJson, applyPrefs, loadLocale, applyTab, restartPolling,
        pollStats, pollGatewayInfo, renderTasks, loadSkins, renderSkinsMenu,
        currentTab, currentSub } = window.Uplift._bootGlue;
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
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
for (const def of C.EXPLORE_METRICS) CH.createMetricCard(def);
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
setInterval(pollGatewayInfo, 10000);
setInterval(() => { if (!document.hidden) FE.pollRequests(); }, 2000);
setInterval(() => { if (!document.hidden && !MM.seModel) MM.render(); }, 8000);
setInterval(() => { if (!document.hidden && currentTab() === 'usage') UUP.pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && UUP.logsFollow) UUP.pollLogs(); }, 5000);
})();
