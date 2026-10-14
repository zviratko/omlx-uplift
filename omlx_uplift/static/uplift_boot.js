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
    renderDevBuild();
}).catch(() => {});
/* BUILD-1: superscript on the DEV wordmark — line 1: the omlx base commit +
   version the built keg tracks; line 2: the enabled build-scope patch ids.
   Server truth comes from /dev/build-info (cheap: file reads only). Honest by
   construction: an unreadable answer paints NOTHING, never a dash that looks
   like a build. Commit shas, versions and patch ids are technical brand text
   (like 'DEV' itself) and stay untranslated; only the labels go through i18n. */
function renderDevBuild() {
    fetchJson(`${API}/admin/api/dev/build-info`).then(d => {
        if (!d || !d.installed || !d.base_sha) return;
        const patches = d.patches || [];
        const el = $('logo-build');
        el.textContent = '';
        const main = document.createElement('span'); main.className = 'lb-main';
        main.textContent = d.base_sha.slice(0, 7)
            + (d.omlx_version ? ' · omlx v' + d.omlx_version : '');
        el.append(main);
        if (patches.length) {
            const ids = patches.map(p => p.id + ' v' + p.version).join(', ');
            const pl = document.createElement('span'); pl.className = 'lb-patches';
            pl.textContent = ids.length <= 30 ? ids
                : C.tf('uplift.ui.dev_n_patches', '{n} patches', { n: patches.length });
            el.append(pl);
        }
        el.title = C.tf('uplift.ui.dev_build_info', 'DEV build')
            + ': omlx ' + (d.omlx_version || '?')
            + ' @ ' + d.base_sha.slice(0, 12)
            + ' (' + (d.sync_ref || '') + ')'
            + (d.built_sha ? '\nuplift-dev @ ' + d.built_sha.slice(0, 12) : '')
            + (patches.length ? '\n' + patches.map(p => p.id + ' v' + p.version).join('\n') : '');
        el.hidden = false;
    }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    /* FEEL-LIVE-1 (user 2026-10-10: "when the browser tab is backgrounded,
       it takes a while to show the contents after selected again"): the
       hidden-gated pollers and the 5 s redraw interval leave the board
       showing whatever the LAST background tick painted — up to a full
       interval of visibly stale data after every tab switch. Draw FIRST
       from what the page already holds (stored columns + the live ring,
       which the (re)connecting feeds refill from the server's 6 min replay
       within one frame), THEN run the regular catch-up below. The streams
       themselves stay focus-gated on purpose (HANG-1: two forever streams
       per tab starve the browser's ~6-per-origin HTTP/1.1 budget — 'live
       all the time' for hidden tabs measured worse, not better; this path
       gives the same feel without the starvation cliff). */
    CH.redrawCharts();
    CH.drawAllMetricCharts();
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
/* STATS-SSE: the 60 s chart-history refetch feeds ONLY the Status charts —
   off-Status it painted hidden canvases every minute. Re-entry catch-up
   (age > 60 s) lives in applyTab's status branch (uplift.js), which the
   historyAge() hook in uplift_charts.js gates. */
setInterval(() => { if (!document.hidden && currentTab() === 'status') CH.loadChartHistory(); }, 60000);
// Metric cards: generate DOM from the catalogue BEFORE grid init so the
// board places them like any static block; boot fetch + keep-alive (the
// per-window cache TTL gates refetches: 4.5 s short (just under the 5 s
// collector tick — POP-PIN), 60 s week+).
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
/* POLL-BATCH-2: gated-card presence and the power/temp chips feed the
   Status board + header. macmon probe stays (60 s, Status-only — a card
   revealed by new data appears the next time you LOOK at the board);
   the header chips slow 12 s -> 30 s (user: "even that does not need to
   update as fast as if we were in stats"). */
setInterval(() => { if (!document.hidden && currentTab() === 'status') CH.probeGatedCards(); }, 60000);
CH.refreshPowerChips();
setInterval(() => { if (!document.hidden) CH.refreshPowerChips(); }, 30000);
/* ---- PAT-4 patches page: extracted to uplift_patches.js (PH2-1 stage 8);
   window.Uplift.patches aliases live at the top. initPatchesPage() boots
   its own listeners; pollPatches runs via applyTab. ---- */
PT.initPatchesPage();

CH.renderCardTsRows();
CH.drawAllMetricCharts();
// SERIES-QUIET: the live edge animates at 2 Hz off the metrics stream
// (FAST-1 live draws); this loop only re-syncs window history shape, so
// 60 s is plenty — and it is one batched fetch PER WINDOW, not per card
// (POLL-BATCH), values on the wire rounded to 6 sig digits (SQUEEZE).
// Tab entry redraws immediately (uplift.js applyTab).
setInterval(() => { if (!document.hidden && currentTab() === 'status') CH.drawAllMetricCharts(); }, 60_000);
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
/* FEED-1 fallback, slowed by POLL-BATCH-2 (user: "polling of requests"
   seen while a tab was unfocused): the requests stream is focus-owned
   (HANG-1), and this chain fed unfocused tabs every 2 s. Events for an
   UNFOCUSED tab are not watched live anyway — toasts and the feed panel
   catch up from the server ring on focus-reopen, so 10 s is the honest
   background cadence. Focused tabs never take this path. */
setInterval(() => { if (!document.hidden && !FE.sseOpen()) FE.pollRequests(); }, 10000);  // FEED-1
/* MODELS POLL REMOVED (user 2026-10-14: "I don't see a reason to poll
   /models — if something changes it's likely the user who did that and
   they will refresh the window"): the table refreshes on tab ENTRY
   (applyTab MM.render(true) — full fresh side-loads) and after every
   WRITE path (they all call render(true)); the consumer audit still
   holds (every S.adminModels reader renders on Models). No background
   timer here anymore. */
setInterval(() => { if (!document.hidden && currentTab() === 'usage') UUP.pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && UUP.logsFollow) UUP.pollLogs(); }, 5000);
})();
