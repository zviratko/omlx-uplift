/* FAST-1 (2026-10-06): high-frequency metric display sampler.
   Plain script; loads AFTER uplift_state.js and BEFORE uplift.js.

   The 5 s collector tick stays the ONLY writer to SQLite (one value per
   tick — the stored series semantics, including the hourly-backfill
   assumptions, are untouched). What lives here is a DISPLAY path: an SSE
   stream from /uplift/api/metrics/stream at ~2 Hz, buffered into per-key
   live columns that the throughput/memory cards draw when their window
   is short enough for the resolution to mean anything (≤ LIVE_MAX_WIN_S,
   i.e. the 60 s / 5 m chips; 15 m was the user's first guess, 5 m won).

   Only keys whose SOURCE actually moves faster qualify: the momentary
   decode/prefill rates (per engine step), queue/engines gauges, and
   used-memory. rate.* / avg_* (fed at request COMPLETION) and the memory
   CEILINGS + cached-token rate keep the 5 s path — faster sampling of
   them would only repeat readings or fake resolution.

   Transport rules mirror the request feed (SSE-PAUSE-1): close while the
   tab is hidden, reopen on resume; the first frame replays the server
   ring so a page refresh within the ring span (6 m) rebuilds the live
   window instead of starting empty. EventSource missing → probe
   /metrics/live once and stay on the stored cadence (graceful
   degradation, never a stall). Exports window.Uplift.livefeed. */
(function () {
'use strict';
const S = window.Uplift.state;
const API = S.API;

const LIVE_MAX_WIN_S = 300;          // ≤ 5 m: draw live-resolution columns
const LIVE_KEEP_S = 330_000;         // ring span on the server is 360 s
/* Which stored keys have a faster live twin (server key -> live key).
   The live sampler writes the SAME key names (collect_* families are
   shared) — the map is identity today; it exists so the chart code names
   the eligible set explicitly and a key can be demoted without surgery. */
const LIVE_KEYS = {
    'generation.tokens_s': 'generation.tokens_s',
    'prefill.tokens_s': 'prefill.tokens_s',
    // EMBED-1: embedding work rides the same fast channel (per-channel
    // drain in embed_sampler) so its line moves at 2 Hz beside prefill.
    'embedding.tokens_s': 'embedding.tokens_s',
    // SMOOTH-2 (user 2026-10-10): the Throughput chart's MTP area stacks
    // under generation — a 5 s step edge next to a 2 Hz top line reads as
    // a tearing chart. The fast sampler now drains the MTP totals on
    // their own per-channel baseline (mtp_sampler.drain), so the MTP
    // edge moves at the same cadence as the line above it.
    'mtp.accepted_tokens_s': 'mtp.accepted_tokens_s',
    'mem.used_bytes': 'mem.used_bytes',
    'sys.used_bytes': 'sys.used_bytes',
    'queue.waiting': 'queue.waiting',
    'queue.prefilling': 'queue.prefilling',
    'queue.running': 'queue.running',
    'engines.active_requests': 'engines.active_requests',
};
/* Values are per-accumulator rates sampled over a 500 ms window — spiky
   by construction. k-point centered mean over the DRAWN live column
   (1.5 s window). The stored 5 s path keeps its own smoothing rules. */
const LIVE_SMOOTH_K = 3;

const live = {};           // key -> {ts: [], v: [], last: 0}
let source = null, probing = false, everLive = false;
/* Layout toggle (FAST-1): the user can turn the display path off without
   a reload. The server sampler keeps running (it costs 0.05 ms/tick and
   other tabs may read it); this client just stops connecting and stops
   answering the eligibility questions, so charts fall back to 5 s. */
let disabled = false;

function col(key) { return live[key] || (live[key] = { ts: [], v: [], last: 0 }); }

function prune(c) {
    const cutoff = Date.now() - LIVE_KEEP_S;
    let drop = 0;
    while (drop < c.ts.length && c.ts[drop] < cutoff) drop++;
    if (drop) { c.ts.splice(0, drop); c.v.splice(0, drop); }
}

/* Fold one server frame into the columns. First-frame `samples` replays
   the whole ring; `m` frames carry {key: [ts, v]}. */
function ingest(d) {
    if (!d || typeof d !== 'object') return;
    if (d.live === false) return;             // sampler dead: columns freeze
    everLive = true;
    const add = (key, ts, v) => {
        if (!(key in LIVE_KEYS)) return;
        if (typeof ts !== 'number' || typeof v !== 'number' || !isFinite(v)) return;
        const c = col(key);
        const ms = ts * 1000;
        if (ms <= c.last) return;             // monotonic per key
        c.last = ms;
        c.ts.push(ms); c.v.push(v);
    };
    if (d.samples) {
        for (const [key, pts] of Object.entries(d.samples))
            for (const p of pts) add(key, p[0], p[1]);
    }
    if (d.m) for (const [key, pv] of Object.entries(d.m)) add(key, pv[0], pv[1]);
    for (const c of Object.values(live)) prune(c);
    // Own listener list (no cross-file glue object — the QA-1 gate
    // reserves the _…Glue namespace for uplift.js-owned members).
    for (const fn of listeners) { try { fn(); } catch (_) {} }
}
const listeners = [];
function onFrame(fn) { if (typeof fn === 'function') listeners.push(fn); }

function connect() {
    // HANG-1: like the request feed, the 2 Hz stream belongs to the FOCUSED
    // tab only — visible-but-unfocused tabs used to burn a permanent slot of
    // the browser's ~6-per-origin HTTP/1.1 budget (2 streams x 3 tabs = the
    // 4th tab's page load starves; measured). Unfocused tabs fall back to
    // the 5 s stored cadence honestly: liveUsable()'s 15 s freshness gate
    // trips, and the charts keep drawing from the store.
    if (disabled || source || !window.EventSource || document.hidden || !document.hasFocus()) return;
    try {
        source = new EventSource(`${API}/uplift/api/metrics/stream`);
        source.onmessage = e => { try { ingest(JSON.parse(e.data)); } catch (_) {} };
        // EventSource reconnects on its own; the server replays the ring on
        // every (re)open, so the live columns refill without a page reload.
        source.onerror = () => {};
    } catch (_) { source = null; }
}
function close() {
    if (source) { source.close(); source = null; }
}

/* One-shot capability probe for browsers without EventSource and for the
   'is the fast sampler even running' question at boot. A snapshot lands
   through the same ingest path (its `metrics` shape carries samples). */
async function probe(fetchJson) {
    if (probing) return;
    probing = true;
    try {
        const d = await fetchJson(`${API}/uplift/api/metrics/live`);
        if (d && d.live && d.metrics) {
            everLive = true;
            for (const [key, o] of Object.entries(d.metrics))
                for (const p of (o.samples || [])) ingest0(key, p[0], p[1]);
            for (const c of Object.values(live)) prune(c);
            for (const fn of listeners) { try { fn(); } catch (_) {} }
        }
    } catch (_) { /* server without FAST-1: stay on the 5 s path */ }
    finally { probing = false; }
}
function ingest0(key, ts, v) {
    if (!(key in LIVE_KEYS)) return;
    const c = col(key);
    const ms = ts * 1000;
    if (ms <= c.last) return;
    c.last = ms; c.ts.push(ms); c.v.push(v);
}

/* ---------- consumer API (charts call these) ---------- */

/* True when this key has live data that is actually fresh — the chart
   falls back to the 5 s path on a gap (stream died, sampler restarted). */
function liveUsable(key) {
    if (disabled || !(key in LIVE_KEYS)) return false;
    const c = live[key];
    return !!(c && c.ts.length && Date.now() - c.ts[c.ts.length - 1] < 15_000);
}
function liveCol(key) {
    const c = live[key];
    if (!c || !c.ts.length) return null;
    return { ts: c.ts, v: c.v };
}
/* Smoothing is the charts' job (movingAverage lives in core.js); the
   feed only exposes the window rule so every card gates consistently. */
function liveForWindow(winSec) { return !disabled && winSec <= LIVE_MAX_WIN_S; }
function disable() {
    disabled = true;
    close();
    for (const k of Object.keys(live)) delete live[k];   // freeze = fall back
}
function enable() { disabled = false; }
function smoothK() { return LIVE_SMOOTH_K; }
function isLive() { return everLive; }

/* Pause/resume with the tab, exactly like the request feed. HANG-1: blur
   also releases the slot; focus takes it back (the ring replays on connect,
   so the live columns refill without a reload). */
window.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
    else connect();
});
window.addEventListener('focus', () => connect());
window.addEventListener('blur', () => close());

window.Uplift.livefeed = {
    connect, close, probe, liveUsable, liveCol, liveForWindow, smoothK, isLive,
    disable, enable, onFrame,
    LIVE_KEYS, LIVE_MAX_WIN_S,
};
})();
