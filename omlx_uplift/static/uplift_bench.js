/* NAT-3: native Bench surface bootstrap (thin).
   Real per-sub-tab engines land in REPL-1 (throughput), REPL-3
   (context + ANE), REPL-2 (accuracy), REPL-4 (new classes) — each in its
   own file (SPLIT-2 precedent, keep each < ~800 lines). This module owns
   only: mount on first visit, flag awareness, the not-implemented stub
   cards. When the kill-switch is off, showEmbedPage still runs the iframe
   path and this module stays dormant (uplift.js routes by
   document.documentElement.dataset.nativeSurfaces). */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftNativeBench = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var _mounted = false;

function t(key, fallback) {
    var W = (typeof window !== 'undefined') ? window : null;
    var v = (W && W.C && W.C.t) ? W.C.t(key) : key;
    return v === key ? fallback : v;
}

function stubCard(titleKey, titleFallback) {
    var card = document.createElement('div');
    card.className = 'native-stub card';
    var h = document.createElement('h2');
    h.textContent = t(titleKey, titleFallback);
    var p = document.createElement('p');
    p.className = 'native-stub-note';
    p.dataset.i18n = 'uplift.bench.native_stub';
    p.textContent = t('uplift.bench.native_stub', 'Native surface — not implemented yet.');
    card.append(h, p);
    return card;
}

function mount() {
    var host = document.getElementById('bench-native');
    if (!host || _mounted) return;
    _mounted = true;
    host.replaceChildren(
        stubCard('navbar.dropdown.performance', 'Throughput'),
        stubCard('navbar.dropdown.accuracy', 'Intelligence'),
        stubCard('navbar.dropdown.context', 'Context'),
        stubCard('uplift.bench.ane_tune', 'ANE Tune')
    );
}

return { mount: mount, isMounted: function () { return _mounted; } };
});
