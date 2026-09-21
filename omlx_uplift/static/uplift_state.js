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
    PT_DATA: null,   // last /patches view
    PT_BUSY: false,
};
})();
