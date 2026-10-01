/* Uplift DOM primitives (FE-1, SWEEP183 C1+C2): the five shared helpers
   that used to live in uplift.js and leak into every extracted module
   through near-duplicate late-bound glue getters. They now live HERE, as
   the single real implementation, loaded right after core.js. Modules
   alias what they need: `const { $, fetchJson, toast } = UpliftDom;`.

   Why a separate file instead of core.js: core.js is contractually pure
   (no DOM, no network) so node tests can require() it directly; domkit
   is the thin DOM/network shell around that core. It keeps the same
   dual-export shape — requiring it in node gives the pure pieces
   (errorText re-export, URL plumbing) without touching the browser.

   Every function below captures NOTHING from a page scope; call sites
   run after boot, so load-order identity holds: there is exactly one
   fetchJson, one toast, etc. across the whole app. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftDom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const C = (typeof window !== 'undefined' && window.UpliftCore) ||
          (typeof module !== 'undefined' && require('./core.js'));

const $ = id => document.getElementById(id);

/* JSON fetch with the server's real failure reason preserved (UP-4):
   FastAPI `detail` (string or 422 array) is flattened by core.errorText
   so every catch site inherits a readable message, not "-> 422". */
async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) {
        let reason = '';
        try { reason = C.errorText(await res.clone().json()); }
        catch (_) { try { reason = (await res.text()).slice(0, 200); } catch (__) {} }
        throw new Error(reason ? `${url} -> ${res.status}: ${reason}` : `${url} -> ${res.status}`);
    }
    return res.json();
}

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.status + ' ' + r.statusText);
    return d;
}

function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
}

function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }

function emptyMsg(host, msg) {   // error text goes through textContent, never innerHTML
    host.textContent = '';
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = msg; host.append(d);
}

return { $, fetchJson, postJson, toast, cell, emptyMsg };
});
