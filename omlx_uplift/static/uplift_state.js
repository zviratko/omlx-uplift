/* PH2-1 stage 1 — Uplift shared state. MUST load BEFORE uplift.js
   (index.html order guarantees it): everything boot can touch lives here so
   no consumer can hit a temporal dead zone.

   PAT-4 note (kept from uplift.js): PT_* must be declared BEFORE boot
   because applyTab() (deep link #settings/patches) can reach pollPatches()
   while later files have not executed yet — a `let` declared further down
   would still be in its temporal dead zone ('Cannot access PT_DATA before
   initialization') and the poll's catch mislabelled that as
   'Patches API unavailable'. Load order now guarantees the property. */
(function () {
'use strict';
const C = window.UpliftCore;

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

window.Uplift = window.Uplift || {};
window.Uplift.state = {
    qp: qp,
    NATIVE: NATIVE,
    API_DEFAULT: API_DEFAULT,
    API: API,
    prefs: C.loadPrefs(localStorage),
    layout: C.loadLayout(localStorage),
    tracker: C.createRequestTracker(2000),
    usageRange: qp.get('range') || 'today',
    usageAvg: null,   // usage-tab averages (uplift_usage.js writes)
    settingsIdx: { stored: 0, orphans: [], entries: [], profiles: [] },
    // PH2-1 stage 6: last global-settings save timestamp. Written by
    // uplift_gsys.js save flow, read by updateModeLabels in uplift.js.
    gsSavedAt: 0,
    // PH2-1 stage 5: in-flight model writes counter, shared by
    // uplift_modelmgr.js (renderModelAdmin guard) and the
    // putModelSettings/postModelAction helpers still in uplift.js.
    pendingWrites: 0,
    trackWrite: async function (fn) {
        window.Uplift.state.pendingWrites++;
        try { return await fn(); } finally { window.Uplift.state.pendingWrites--; }
    },
    // PH2-1 stage 7: shared mutable containers for the feeds —
    // uplift_feed.js owns both, the live panel in uplift.js and
    // uplift_reqsearch.js (render loop) read them. Never reassigned.
    reqFeedRows: new Map(),
    // IN-FLIGHT card (redesign): request lines persist until page refresh.
    // rid -> slot record (DOM + last known data); models/expanded queued
    // lines keyed by first-seen order. Declared here for TDZ safety.
    ifSlots: new Map(),
    ifModels: [],
    ifExpanded: new Set(),
    milestoneFloor: {},
    PT_DATA: null,   // last /patches view
    PT_BUSY: false,
};

/* Escape closes the frontmost modal dialog — ONE global handler for every
   .modal-overlay in the app. A dialog with teardown state (editor re-render,
   inspector timers) registers its close function on the overlay as
   __upliftModalClose; a plain dialog needs nothing (the fallback removes
   the overlay). This replaces the old per-dialog listeners, which only
   fired while focus stayed inside the dialog — Escape after a backdrop
   click did nothing, and dialogs that took no focus (upload modal) had no
   handler at all. Frontmost = highest computed z-index (grammar popover 90
   > base modal 80 > editor 70), DOM order breaks ties. Keypresses already
   consumed below (IME cancel, nested pickers calling preventDefault) are
   respected. */
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const open = document.querySelectorAll('.modal-overlay');
    if (!open.length) return;
    const z = el => {
        const v = parseInt(getComputedStyle(el).zIndex, 10);
        return Number.isFinite(v) ? v : 0;
    };
    let top = open[0];
    for (const el of open) if (z(el) >= z(top)) top = el;
    if (typeof top.__upliftModalClose === 'function') top.__upliftModalClose();
    else top.remove();
});
})();
