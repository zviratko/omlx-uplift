/* NAT-3: native Chat surface bootstrap (thin).
   The real client lands on NAT-4 (vendored deep-chat component per the
   NAT-1 decision + the probe verdicts in out/NAT-1.*). This module owns
   only: mount on first visit, flag awareness, the not-implemented stub.
   When the kill-switch is off, uplift.js keeps routing the Chat tab to
   the classic iframe (embed path byte-identical) and this stays dormant. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftNativeChat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var _mounted = false;

function t(key, fallback) {
    var W = (typeof window !== 'undefined') ? window : null;
    var v = (W && W.C && W.C.t) ? W.C.t(key) : key;
    return v === key ? fallback : v;
}

function mount() {
    var host = document.getElementById('chat-native');
    if (!host || _mounted) return;
    _mounted = true;
    var card = document.createElement('div');
    card.className = 'native-stub card';
    var h = document.createElement('h2');
    h.textContent = t('navbar.tab.chat', 'Chat');
    var p = document.createElement('p');
    p.className = 'native-stub-note';
    p.dataset.i18n = 'uplift.chat.native_stub';
    p.textContent = t('uplift.chat.native_stub', 'Native surface — not implemented yet.');
    card.append(h, p);
    host.replaceChildren(card);
}

return { mount: mount, isMounted: function () { return _mounted; } };
});
