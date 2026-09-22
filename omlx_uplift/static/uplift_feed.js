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
/* ISSUE-2 (Events card): one row per key, updated in place. Request
   transitions used to push a fresh line for every state change, so a single
   request accumulated queued→prefilling→generating→complete as four lines.
   Keyed rows keep their POSITION (user: rows must not reshuffle); only the
   time + state text refresh. New keys prepend. */
function pushFeed(events, keyFor) {
    const feed = $('feed');
    if (!feed) return;   // Events card retired 2026-09-22 — host may be gone
    const empty = feed.querySelector('.empty'); if (empty) empty.remove();
    for (const ev of events.slice().reverse()) {
        const key = keyFor ? keyFor(ev) : null;
        let row = key ? feed.querySelector(`[data-evkey="${CSS.escape(key)}"]`) : null;
        if (row) {
            const t = row.querySelector('time');
            if (t) t.textContent = new Date().toLocaleTimeString('en-GB');
            const s = row.querySelector('.ev');
            if (s) s.textContent = ev.text;
            row.className = `feed-item k-${ev.kind}`;
            if (ev.model) row.dataset.model = ev.model;
            continue;
        }
        row = document.createElement('div');
        row.className = `feed-item k-${ev.kind}`;
        if (key) row.dataset.evkey = key;
        if (ev.model) row.dataset.model = ev.model;
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
    const activeN = rows.filter(r => ['queued','prefilling','generating'].includes(r.state)).length;
    // ISSUE-7: header count — what the session tracks and what's active.
    // (What's actually drawn is in the list footer, per page/box fit.)
    $('reqfeed-sub').textContent = rows.length
        ? `${rows.length} tracked · ${activeN} active` : '';
    if (!rows.length) {
        const cur = list.querySelector('.empty');
        if (!cur) list.innerHTML = '<div class="empty">No requests yet</div>';
        return;
    }
    // ISSUE-2 (feed order): sort by BIRTH, never by ts (last update). Rows
    // used to reshuffle on every SSE tick as their ts refreshed, so live
    // requests bounced around the list. Birth is the server's started_at
    // when known (ISSUE-8 — exact, survives refresh), first-seen client time
    // otherwise. Active rows own the top band (user: "live requests should
    // stay on top"), each band birth-ordered newest-first. A row's place
    // inside its band is fixed until page refresh (one request = one line).
    list.innerHTML = '';
    const active = [], done = [];
    for (const r of rows) {
        (['queued', 'prefilling', 'generating'].includes(r.state) ? active : done).push(r);
    }
    const birthOf = r => (r.startedAt ? r.startedAt * 1000 : (r.reqTs || r.ts || 0));
    const byBirth = (a, b) => birthOf(a) - birthOf(b);
    active.sort(byBirth); done.sort(byBirth);
    const sorted = active.reverse().concat(done.reverse()).slice(0, MAX_REQFEED);
    // ISSUE-7 (overflow + pagination): draw only what fits the card box —
    // rows adapt to its height (measured, ~30px typical) — and page the
    // rest behind a footer control. The old unbounded list painted past the
    // card border (the Events-card failure all over again). The box height
    // comes from the grid engine, never from content, so this cannot loop.
    // ISSUE-7: box height comes from the fixed grid item, not from content
    // (in MORE mode the list itself is stretched — clientHeight would lie).
    // available = card-pad inner height − the band above the list (header,
    // search bar). That distance is content-independent.
    let boxH = 0;
    const pad = list.closest('.card-pad');
    if (pad) {
        const pr = pad.getBoundingClientRect();
        const above = list.getBoundingClientRect().top - pr.top;
        boxH = Math.floor(pr.height - above);
    }
    boxH = boxH > 60 ? boxH : (list.clientHeight || 240);
    const rowH = list._rowH || 30;           // measured after first draw
    const wantAll = list._showAll === true;  // footer toggled: scroll instead
    // Pin the scroll box so content can never push past the grid box (the
    // Events-card overflow again); re-measured every fit render so a user
    // resizing the card adapts.
    list._boxH = boxH;
    list.style.maxHeight = boxH + 'px';
    let limit = sorted.length;
    if (!wantAll) {
        const foot = sorted.length ? 24 : 0;
        limit = Math.max(3, Math.floor((boxH - foot) / rowH));
        limit = Math.min(limit, sorted.length);
    }
    const shown = sorted.slice(0, limit);
    for (const r of shown) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${r.state.charAt(0).toUpperCase() + r.state.slice(1)}`;
        badge.textContent = r.state;
        if (r.origin === 'real') { badge.title = 'real traffic'; }
        // ISSUE-8: start time BEFORE the request id (user ask). HH:MM:SS,
        // server-side birth when known, first-seen time otherwise.
        const born = document.createElement('span');
        born.className = 'req-start';
        const bt = r.startedAt ? r.startedAt * 1000 : (r.reqTs || r.ts);
        born.textContent = bt ? new Date(bt).toLocaleTimeString('en-GB') : '--:--:--';
        born.title = r.endedAt
            ? C.tf('uplift.req.started_ended', 'started · ended') + ': '
              + new Date(r.endedAt * 1000).toLocaleTimeString('en-GB')
            : C.tf('uplift.req.started', 'started');
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
        row.append(badge, born, name, meta);
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
    // ISSUE-7 footer: how many rows fit vs exist, with a show-more toggle.
    if (sorted.length > shown.length || list._showAll) {
        const foot = document.createElement('div');
        foot.className = 'req-foot';
        const lab = document.createElement('span');
        lab.textContent = list._showAll
            ? C.tf('uplift.req.showing_all', 'showing all') + ` (${shown.length})`
            : `${shown.length} / ${sorted.length}`;
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'se-btn act';
        more.textContent = list._showAll
            ? C.tf('uplift.req.show_fit', 'FIT BOX')
            : C.tf('uplift.req.show_more', 'MORE');
        more.onclick = () => { list._showAll = !list._showAll; renderReqFeed(); };
        foot.append(lab, more);
        list.append(foot);
    }
    // Measure one real row once per session so later draws adapt to the box
    // exactly (font/skin sizes differ — 30px is only the first-draw guess).
    if (!list._rowH && list.firstElementChild && list.firstElementChild.offsetHeight)
        list._rowH = list.firstElementChild.offsetHeight;
}
function upsertReq(id, patch) {
    const prev = reqFeedRows.get(id) || { prompt: 0, completion: 0 };
    // reqTs = first-seen birth stamp (immutable). Feed ordering keys on it
    // so a row never moves when its counters/state tick (issue 2).
    reqFeedRows.set(id, Object.assign({}, prev, patch,
        { id, ts: Date.now(), reqTs: prev.reqTs || Date.now() }));
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
        // IN-FLIGHT terminal labels: DONE vs ABORTED vs REFUSED keys off
        // finish/error_code, not the coarse complete|error state.
        if (ev.finish !== undefined) patch.finish = ev.finish;
        if (ev.error_code !== undefined) patch.errorCode = ev.error_code;
        if (ev.error) patch.error = ev.error;
        // ISSUE-8: server lifecycle stamps ride along (epoch seconds).
        if (ev.started_at !== undefined) patch.startedAt = ev.started_at;
        if (ev.ended_at !== undefined) patch.endedAt = ev.ended_at;
        upsertReq(ev.id, patch);
        // one Events-card line per request, state updated in place (issue 2)
        pushFeed([{ kind: 'requests', reqKey: 'req:' + ev.id,
                    text: `${ev.origin === 'real' ? '◆ ' : ''}${ev.id.slice(0, 6)} → ${ev.state}` }],
                  e => e.reqKey || null);
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
                              tps: r.tps, error: r.error, finish: r.finish,
                              errorCode: r.error_code,
                              startedAt: r.started_at, endedAt: r.ended_at });
    } catch (_) { /* gateway offline; feed keeps last state */ }
}


window.Uplift = window.Uplift || {};
window.Uplift.feed = {
    pushFeed, reactTo, gateMilestones, celebrate, milestoneQuip,
    milestoneFloor: S.milestoneFloor,
    renderReqFeed, pollRequests, connectEventStream, pushServerEvent, upsertReq,
};
})();
