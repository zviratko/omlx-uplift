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
const { fetchJson, applyPrefs, loadLocale, applyTab, restartPolling,
        pollStats, pollGatewayInfo, renderTasks, loadSkins, renderSkinsMenu,
        currentTab, currentSub, boardVisible } = window.Uplift._bootGlue;
fetchJson(`${API}/admin/api/device-info`).then(d => {
    // RAM is sold decimal but reported by the OS in binary; Apple's own
    // instruments say GiB (32 GB modules = 32 GiB on Apple Silicon).
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GiB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});
/* U10: header shows which keg is serving. Identity comes from the server
   (GET identity) — never inferred from files on disk, which exist even when
   the other keg answers. 'DEV' is brand text (like 'Uplift'): untranslated,
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
        if (!d || !d.installed || !(d.keg || d.base_sha)) return;
        const patches = d.patches || [];
        const el = $('logo-build');
        el.textContent = '';
        const main = document.createElement('span'); main.className = 'lb-main';
        // KEG-VERSIONED: the active keg name IS the build identity —
        // '<utc-stamp>.<commit7>' (when it was built, what it was built
        // from). Legacy HEAD-<sha> kegs show their name too; a keg predating
        // both schemes falls back to the base commit line.
        main.textContent = d.keg
            || (d.base_sha.slice(0, 7)
                + (d.omlx_version ? ' · omlx v' + d.omlx_version : ''));
        el.append(main);
        // the enabled-patch ids are NOT a header line (user 2026-10-21:
        // the '4 patches' row between the two version lines was dropped)
        // — they ride the tooltip below and live on the patches page.
        el.title = C.tf('uplift.ui.dev_build_info', 'DEV build')
            + (d.keg ? ': keg ' + d.keg : '')
            + '\nomlx ' + (d.omlx_version || '?')
            + ' @ ' + (d.base_sha ? d.base_sha.slice(0, 12) : '?')
            + ' (' + (d.sync_ref || '') + ')'
            + (d.built_at ? '\nbuilt ' + d.built_at : '')
            + (d.built_sha ? '\nuplift-dev @ ' + d.built_sha.slice(0, 12) : '')
            + (patches.length ? '\n' + patches.map(p => p.id + ' v' + p.version).join('\n') : '');
        el.hidden = false;
        // line 2 of the build column: the vanilla base this dev keg tracks
        // (user 2026-10-20 asked for it back; 2026-10-21 moved it up from
        // under the tagline to the line RIGHT BELOW the keg stamp — the
        // free strip alongside the OMLX DEV banner fits both). It rides
        // INSIDE the superscript box as an absolute sub-line: auto-aligns
        // to the stamp wherever the wordmark ends, and can never grow the
        // header.
        const baseTxt = d.omlx_version
            ? 'omlx v' + d.omlx_version
              + (d.base_sha ? ' \u00b7 ' + d.base_sha.slice(0, 7) : '')
            : (d.base_sha ? 'omlx @ ' + d.base_sha.slice(0, 7) : '');
        if (baseTxt) {
            const bl = document.createElement('span');
            bl.className = 'logo-base';
            bl.textContent = baseTxt;
            bl.title = el.title;
            el.append(bl);
            // the skin's ::after suffix (e.g. artelight's ': WARM') centres
            // itself on the stamp+version pair only once BOTH lines are
            // actually painted (user 2026-10-21)
            el.parentElement?.classList.add('has-build-lines');
            /* A skin can paint its own tagline into .logo::after, and that box
               is INLINE — it starts just right of the stamp. The version line
               hangs from the stamp's left edge and is allowed 200px, so with a
               long-enough tagline the two collide: measured 2026-10-25 on the
               'discovery-one' skin (' // H-A-L 9000', suffix starting x327)
               over 'omlx v0.7.3.dev2 · 78fa08b' (ending x336) — 9x7px of ink on
               ink. Bound line 2 to the stamp's own column plus the suffix's
               gutter, so the ellipsis takes any tail and the full string stays
               in this element's tooltip. No-op for skins that paint nothing.
               THE MEASUREMENT IS THE DANGER: this runs the moment the build
               info arrives, and if the header has no layout yet (page not
               mounted, tab hidden, or a narrow window where the CSS hides this
               whole column) the width reads 0 — which set max-width to the
               gutter alone and clipped the version line down to an invisible
               stub. Reported by the user on 2026-10-25 as "no version strings
               visible at all". So: measure after layout, and apply the cap
               ONLY when the measured column is credibly wide. */
            const suffixCs = getComputedStyle(el.parentElement, '::after');
            const tagline = suffixCs.content;
            if (tagline && tagline !== 'none' && tagline !== 'normal') {
                const cap = () => {
                    const w = el.getBoundingClientRect().width;
                    if (w < 40) return;          // no layout yet — leave it alone
                    const gutter = Math.round(w) + (parseFloat(suffixCs.marginLeft) || 0);
                    if (gutter > 60 && gutter < 200) bl.style.maxWidth = gutter + 'px';
                };
                if (document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(cap).catch(() => {});
                }
                requestAnimationFrame(cap);
            }
        }
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
// STATUS-SPLIT: About lives under the Status tab but shows no charts, so the
// history refresh belongs to the two board views only.
setInterval(() => { if (!document.hidden && boardVisible()) CH.loadChartHistory(); }, 60000);
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
setInterval(() => { if (!document.hidden && boardVisible()) CH.probeGatedCards(); }, 60000);
CH.refreshPowerChips();
setInterval(() => { if (!document.hidden) CH.refreshPowerChips(); }, 30000);
/* ---- PAT-4 patches page: extracted to uplift_patches.js (PH2-1 stage 8) and
   lazy-loaded on #settings/patches entry (FE-8); runPatches() in uplift.js
   calls initPatchesPage() once on load. ---- */

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
/* FEED-1 fallback + ACT-SLEEP-1 watchdog, slowed by POLL-BATCH-2 (user:
   "polling of requests" seen while a tab was unfocused): the requests
   stream is audience-owned (HANG-1), and this chain fed audience-less tabs
   every 2 s. Events for a tab WITHOUT an audience are not watched live
   anyway — toasts and the feed panel catch up from the server ring on
   reopen, so 10 s is the honest background poll cadence. The watchdog runs
   at 5 s though: its cheap path is a boolean check while the stream is
   healthy, and its jobs are REPAIR (reopen a stream EventSource gave up
   on; drop a half-open socket that stays silent past the server's tick
   budget — the router pushes a ~15 s tick frame for exactly this) — a
   dead link should be caught fast, not once a minute. */
setInterval(() => FE.feedWatchdog(), 5000);  // FEED-1 / ACT-SLEEP-1
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
