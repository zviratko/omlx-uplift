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
        throw kitError(url, res, reason);
    }
    return res.json();
}

/* FE-2: every kit throw carries err.status so callers can branch on the
   HTTP code (cancel's 501, classic-PUT's 404-upsert fallback) without
   scraping the message. Messages are unified to `url -> status: reason`
   with detail flattened via C.errorText (UP-4) — postJson used to throw
   the raw detail, which is exactly the [object Object] toast class. */
function kitError(url, res, reason) {
    const e = new Error(reason ? `${url} -> ${res.status}: ${reason}` : `${url} -> ${res.status}`);
    e.status = res.status;
    return e;
}

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw kitError(url, r, C.errorText(d) || r.statusText);
    return d;
}

/* FE-2: PUT twin of postJson (same envelope) — mmeditor/profile save and
   the template editor had three private PUT fetches with divergent error
   handling. */
async function putJson(url, body) {
    const r = await fetch(url, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw kitError(url, r, C.errorText(d) || r.statusText);
    return d;
}

/* FE-1 completion: DELETE had no kit twin, so mmchips grew two private
   fetch wrappers with DIVERGENT detail handling (one stringified
   body.detail, the other took it raw) — the exact [object Object] toast
   this file exists to kill. detail is flattened via C.errorText like
   fetchJson does (UP-4). */
async function deleteJson(url) {
    const res = await fetch(url, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw kitError(url, res, C.errorText(d) || res.statusText);
    return d;
}

function toast(text, ms, cls) {
    // U51: ~30 call sites across bench/chat pass (msg, 'error') — a string
    // second arg hit setTimeout as NaN and the toast vanished instantly,
    // i.e. exactly the failures nobody could read. Accept the shape: a
    // non-numeric ms is the class.
    if (typeof ms === 'string') { cls = ms; ms = undefined; }
    const t = document.createElement('div');
    t.className = 'toast' + (cls ? ' ' + cls : ''); t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
}

function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }

function emptyMsg(host, msg) {   // error text goes through textContent, never innerHTML
    host.textContent = '';
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = msg; host.append(d);
}

return { $, fetchJson, postJson, putJson, deleteJson, toast, cell, emptyMsg };
});
