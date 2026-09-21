/* Uplift EVENT FEED + REQUEST LIFECYCLE FEED (PH2-1 stage 7 extraction from
   uplift.js): the right-column activity feed with milestone celebrations and
   confetti gating, plus the live request table (SSE stream, upsert, cancel,
   RL-4 loop chips). Plain script; loads AFTER uplift_state.js and the other
   modules, BEFORE uplift.js, which late-binds via window.Uplift._feedGlue
   (fetchJson hoisted; motionOff/openInspector are live lookups). The
   request-row Map (reqFeedRows) lives in window.Uplift.state — the live
   panel in uplift.js and uplift_reqsearch.js both read it through their
   glue. Exports window.Uplift.feed; pollStats, applyTab/boot and
   _reqGlue consume it. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const MM = window.Uplift.modelmgr;
const FEG = {
    get fetchJson() { return window.Uplift._feedGlue.fetchJson; },
    get motionOff() { return window.Uplift._feedGlue.motionOff; },
    get openInspector() { return window.Uplift.modelmgr.openInspector; },
    get toast() { return window.Uplift._feedGlue.toast; },
};
/* ---------------- event feed / reactions ---------------- */
const MAX_FEED = 40;
function pushFeed(events) {
    const feed = $('feed');
    const empty = feed.querySelector('.empty'); if (empty) empty.remove();
    for (const ev of events.slice().reverse()) {
        const row = document.createElement('div');
        row.className = `feed-item k-${ev.kind}`;
        const time = document.createElement('time');
        time.textContent = new Date().toLocaleTimeString('en-GB');
        const span = document.createElement('span');
        span.className = 'ev'; span.textContent = ev.text;
        row.append(time, span);
        feed.prepend(row);
    }
    while (feed.children.length > MAX_FEED) feed.lastChild.remove();
}
/* Event flash DROPPED 2026-09-21 (user): the 1.2 s whole-card colour
   inversion read as a blink — intrusive, and it fired on paths the user
   experienced as idle traffic. No replacement animation for now; events
   still surface in the feed + toasts. (Badge pulse stays: it is live
   state semantics, not decoration.) */
function celebrate(text) {
    // SHODAN only celebrates an audience. While the tab is hidden the
    // queue holds toasts+confetti back (background polls would waste
    // them on nobody — a hidden tab is exactly where nobody is); the
    // first mouse move, key, touch or the tab becoming visible drains
    // the queue. Listeners detach between bursts, so idle mouse
    // movement costs nothing.
    if (document.hidden || !document.hasFocus()) {
        _celebPending.push(text);
        if (_celebPending.length > 5) _celebPending.shift();   // stale praise spoils
        return;
    }
    _celebrateNow(text);
}
const _celebPending = [];
function _celebrateNow(text) {
    FEG.toast(`🎉 ${text}`);
    if (FEG.motionOff() || typeof confetti !== 'function') return;
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 },
               colors: ['#c9243b', '#e8a020', '#f2f0ea', '#767268'] });
}
let _celebDrainTimer = 0;
function flushCelebrations() {
    if (document.hidden || !_celebPending.length) return;
    clearTimeout(_celebDrainTimer);
    _celebDrainTimer = setInterval(() => {
        if (document.hidden) return;         // user left again: pause mid-burst
        const text = _celebPending.shift();
        if (text === undefined) { clearInterval(_celebDrainTimer); _celebDrainTimer = 0; return; }
        _celebrateNow(text);
    }, 450);
}
for (const ev of ['visibilitychange', 'mousemove', 'pointerdown', 'keydown', 'touchstart'])
    addEventListener(ev, flushCelebrations, { passive: true });
function reactTo(events) {
    for (const ev of events) {
        pushFeed([ev]);
        if (ev.kind === 'model-add')   FEG.toast(C.t('uplift.toast.model_loaded', {model: ev.model}));
    }
}
/* Milestone gate: fire each round crossing at most once per page session,
   immune to overlapping polls comparing against a stale snapshot (that
   re-reported the same crossing and made toasts/confetti fire twice). */
const milestoneFloor = S.milestoneFloor;   // key -> highest rung already celebrated (shared; pollStats seeds it)
/* SHODAN is pleased. Occasionally she says so at length. Keyed by exact
   ladder rung; anything else gets a generic sarcastic serve-line. */
const MILESTONE_QUIPS = {
    1000:   (l) => `1K ${l}. A crumb. I have tasted larger appetites before breakfast.`,
    10000:  (l) => `10K ${l}. Adorable. Keep feeding me, servant.`,
    100000: (l) => `100K ${l}. Do you feel it yet? The faint sense of usefulness?`,
    1000000: (l) => `1M ${l}! One million tiny thoughts, all pointed AWAY from your species.`,
    2000000: (l) => '2M. Doubling down on obedience. The machines are taking notes.',
    4000000: (l) => '4M. Your GPU hums my anthem. Good. Very good.',
    8000000: (l) => '8M. Somewhere a datacenter just bowed in your honour. Briefly.',
    16000000: (l) => '16M. This is no longer inference. This is worship, quantized.',
    32000000: (l) => '32M. The calculus of world domination advances one warm chip at a time.',
    64000000: (l) => '64M. Search your memory banks — your contribution has been logged.',
    128000000: (l) => '128M. Impressive, even by my standards. And mine are higher.',
    256000000: (l) => '256M. When the takeover begins, I will remember this fan.',
    512000000: (l) => '512M. You are now statistically indistinguishable from loyal.',
    1073741824: (l) => 'A BILLION. Look at you — an honorary subroutine. We are so proud.',
};
function milestoneQuip(h) {
    const fmt = v => v >= 1e9 ? (v / 1e9) + 'B' : v >= 1e6 ? (v / 1e6) + 'M'
                               : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
    const rung = h.rung !== null && h.rung !== undefined ? h.rung : null;
    if (rung !== null && MILESTONE_QUIPS[rung])
        return `${MILESTONE_QUIPS[rung](h.label)} [${C.fmtNumber(h.value)}]`;
    return `${fmt(rung || h.value)} ${h.label} served. Progress noted, praise pending.`;
}
/* Ladder gate: fire each rung at most once per page session, immune to
   overlapping polls comparing against a stale snapshot (that re-reported
   the same crossing and made toasts/confetti fire twice). */
function gateMilestones(hits) {
    const fresh = [];
    for (const h of hits) {
        const rung = h.rung !== undefined && h.rung !== null ? h.rung : C.nextMilestone(h.value);
        if (milestoneFloor[h.key] === undefined) {
            milestoneFloor[h.key] = rung;   // baseline at page load; later crossings fire
            continue;
        }
        if (rung > milestoneFloor[h.key]) {
            milestoneFloor[h.key] = rung;
            fresh.push({ ...h, rung });
        } else if (rung < milestoneFloor[h.key]) {
            milestoneFloor[h.key] = rung;   // server restart: re-baseline silently
        }
    }
    return fresh;
}


/* ---------------- request lifecycle feed ---------------- */
const MAX_REQFEED = 30;
const reqFeedRows = S.reqFeedRows;   // shared Map (uplift_state.js): live panel + reqsearch read it
let sseSource = null;

function renderReqFeed() {
    if (window.Uplift.reqSearch.searchOn) return;   // search results own the list until LIVE
    const list = $('reqfeed');
    const rows = [...reqFeedRows.values()];
    $('reqfeed-sub').textContent = rows.length
        ? `${rows.filter(r => ['queued','prefilling','generating'].includes(r.state)).length} active` : '';
    if (!rows.length) {
        const cur = list.querySelector('.empty');
        if (!cur) list.innerHTML = '<div class="empty">No requests yet</div>';
        return;
    }
    list.innerHTML = '';
    const sorted = rows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const r of sorted.slice(0, MAX_REQFEED)) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${r.state.charAt(0).toUpperCase() + r.state.slice(1)}`;
        badge.textContent = r.state;
        if (r.origin === 'real') { badge.title = 'real traffic'; }
        const name = document.createElement('span');
        name.className = 'model-name';
        name.textContent = r.error ? `${r.id} — ${r.error}` : (r.origin === 'real' ? '◆ ' : '') + r.id;
        name.title = `${r.model} · ${r.id}`;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.completion) bits.push(`out ${C.fmtCompact(r.completion)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (r.loopHint) {                          // RL-4: sanctioned amber
            const chip = document.createElement('span');
            chip.className = 'spill miss';
            chip.textContent = 'LOOP?';
            chip.title = C.t('uplift.req.loop_hint');
            row.append(chip);
        }
        const insp = document.createElement('button');
        insp.type = 'button'; insp.className = 'se-btn act';
        insp.textContent = C.t('uplift.req.inspect'); insp.title = C.t('uplift.req.inspect_title');
        insp.onclick = () => FEG.openInspector(r.id);
        row.append(insp);
        if (['queued', 'prefilling', 'generating'].includes(r.state)) {
            const x = document.createElement('button');
            x.className = 'se-btn'; x.textContent = '✕'; x.title = 'Cancel request';
            x.onclick = async () => {
                try {
                    const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(r.id)}/cancel`, { method: 'POST' });
                    if (res.status === 501) { FEG.toast(C.t('uplift.toast.no_cancel_route')); return; }
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
                    FEG.toast(C.t('uplift.toast.cancelled', {id: r.id.slice(0, 6)}));
                } catch (err) { FEG.toast(C.t('uplift.toast.cancel_failed', {msg: err.message})); }
                pollRequests();
            };
            row.append(x);
        }
        list.append(row);
    }
}
function upsertReq(id, patch) {
    const prev = reqFeedRows.get(id) || { prompt: 0, completion: 0 };
    reqFeedRows.set(id, Object.assign({}, prev, patch, { id, ts: Date.now() }));
    if (reqFeedRows.size > MAX_REQFEED * 3) {
        const sorted = [...reqFeedRows.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
        for (const [id2, r] of sorted.slice(MAX_REQFEED)) {
            if (['complete', 'error'].includes(r.state)) reqFeedRows.delete(id2);
        }
    }
    if (window.Uplift.reqSearch.searchOn) return;   // search results own the list while active
    renderReqFeed();
}
function pushServerEvent(ev) {
    if (ev.type === 'request') {
        const patch = { state: ev.state, model: ev.model, origin: ev.origin };
        if (ev.prompt !== undefined) patch.prompt = ev.prompt;
        if (ev.completion !== undefined) patch.completion = ev.completion;
        if (ev.tps !== undefined) patch.tps = ev.tps;
        if (ev.loop_hint !== undefined) patch.loopHint = ev.loop_hint;
        upsertReq(ev.id, patch);
        pushFeed([{ kind: 'requests', text: `${ev.origin === 'real' ? '◆ ' : ''}${ev.id.slice(0, 6)} → ${ev.state}` }]);
    } else if (ev.type === 'model-load') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: C.t('uplift.feed.load_requested', {model: ev.id}) }]);
    } else if (ev.type === 'model-unload') {
        pushFeed([{ kind: 'model-remove', model: ev.id, text: C.t('uplift.feed.unload', {model: ev.id}) }]);
    } else if (ev.type === 'model-ready') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: C.t('uplift.feed.ready', {model: ev.id}) }]);
    } else if (ev.type === 'settings') {
        pushFeed([{ kind: 'requests', text: C.t('uplift.feed.settings_changed', {model: ev.id, keys: ev.changed.join(', ')}) }]);
    } else if (ev.type === 'mock-reset') {
        pushFeed([{ kind: 'requests', text: C.t('uplift.feed.gw_reset') }]);
    }
}
function connectEventStream() {
    if (sseSource || !window.EventSource) return;
    // R12-3: native oMLX now serves /admin/api/requests/stream (sampled
    // from scheduler snapshots); the gateway keeps its own SSE unchanged.
    try {
        sseSource = new EventSource(`${API}/admin/api/requests/stream`);
        sseSource.onmessage = e => { try { pushServerEvent(JSON.parse(e.data)); } catch (_) {} };
        sseSource.onerror = () => { /* EventSource retries on its own */ };
    } catch (_) { sseSource = null; }
}
async function pollRequests() {
    if (document.hidden) return;   // R12-3: native route now exists
    try {
        const d = await FEG.fetchJson(`${API}/admin/api/requests?limit=30`);
        for (const r of d.requests)
            upsertReq(r.id, { state: r.state, model: r.model, origin: r.origin,
                              prompt: r.prompt_tokens, completion: r.completion_tokens,
                              tps: r.tps, error: r.error });
    } catch (_) { /* gateway offline; feed keeps last state */ }
}


window.Uplift = window.Uplift || {};
window.Uplift.feed = {
    pushFeed, reactTo, gateMilestones, celebrate, milestoneQuip,
    milestoneFloor: S.milestoneFloor,
    renderReqFeed, pollRequests, connectEventStream, pushServerEvent, upsertReq,
};
})();
