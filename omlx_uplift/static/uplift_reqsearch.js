/* Uplift request-history SEARCH (PH2-1 stage 4 extraction from uplift.js,
   RL-3): server-side search over the request store, timespan chips clamped
   to retention, model filter from what the live feed saw. Loads AFTER
   uplift_state.js and BEFORE uplift.js; the live feed it overlays stays in
   uplift.js and is reached through window.Uplift._reqGlue (hoisted
   functions / stable lets — resolved at call time). Exports
   window.Uplift.reqSearch. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
/* RL-3 request history search: server-side over the store, presets clamp
   to RL-0 log retention. Results reuse feed row styling; click opens the
   RL-2 inspector (stored variant). */
let searchOn = false, reqRetainDays = 2;
const REQ_WINDOWS = [['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400]];
let reqWin = null;                       // null = retention window default

/* Buttons live in static index.html — bind handlers as soon as they exist
   (deferred scripts run before DOMContentLoaded fires in practice, but the
   listener covers every load order). */
function bindReqSearchControls() {
    const btn = $('req-search-btn'); if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = runReqSearch;
    $('req-live-btn').onclick = backToLiveFeed;
    $('req-q').onkeydown = e => { if (e.key === 'Enter') runReqSearch(); };
    $('req-model').onchange = () => searchOn && runReqSearch();
}
function bootReqSearch() {
    bindReqSearchControls();
    // ISSUE-4: the bar is visible from page load but its model dropdown and
    // timespan chips only appeared after pressing SEARCH. Populate eagerly;
    // failures keep the defaults and runReqSearch retries via initReqSearch.
    initReqSearch().then(syncReqModelOptions).catch(() => {});
}
if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', bootReqSearch);
else bootReqSearch();

async function initReqSearch() {
    const chips = $('req-timechips');
    if (!chips || chips.dataset.done) return;
    chips.dataset.done = '1';
    try {
        const ret = await window.Uplift._reqGlue.fetchJson(`${API}/uplift/api/retention`);
        reqRetainDays = Math.max(1, ret.log_days || 2);
    } catch (_) { /* default stays honest-ish at 2 d */ }
    const mk = (label, secs) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ts-chip'; b.textContent = label;
        b.dataset.secs = secs;
        b.onclick = () => {
            reqWin = secs;
            [...chips.children].forEach(x => x.classList.toggle('on', x === b));
            runReqSearch();
        };
        chips.append(b);
    };
    for (const [label, secs] of REQ_WINDOWS) if (secs <= reqRetainDays * 86400) mk(label, secs);
    mk(`${reqRetainDays}d`, reqRetainDays * 86400);
    chips.lastChild.classList.add('on'); reqWin = reqRetainDays * 86400;
    $('req-search-btn').onclick = runReqSearch;
    $('req-live-btn').onclick = backToLiveFeed;
    $('req-q').onkeydown = e => { if (e.key === 'Enter') runReqSearch(); };
    $('req-model').onchange = () => searchOn && runReqSearch();
}

async function runReqSearch() {
    await initReqSearch();
    syncReqModelOptions();
    const q = ($('req-q').value || '').trim();
    const model = $('req-model').value || '';
    const from = Date.now() / 1000 - (reqWin || reqRetainDays * 86400);
    searchOn = true;
    const note = $('req-search-note');
    let d;
    try {
        d = await window.Uplift._reqGlue.fetchJson(`${API}/uplift/api/requests-search?` + new URLSearchParams(
            { q, model, frm: from, limit: 50 }));
    } catch (err) {
        note.style.display = ''; note.style.flex = '0 0 100%';
        note.textContent = C.t('uplift.req.load_failed', { msg: err.message });
        return;
    }
    const list = $('reqfeed');
    list.innerHTML = '';
    const lb0 = $('req-live-btn'); if (lb0) lb0.style.display = '';
    const hits = d.results || [];
    note.style.display = '';
    if (!hits.length) {
        note.textContent = C.t('uplift.req.no_matches', { scope: `${reqWin / 3600 | 0}h · ${model || C.t('uplift.req.all_models')}` });
        return;
    }
    note.textContent = C.t('uplift.req.hits', { n: hits.length, mode: d.mode })
        + (q ? '' : ` · ${C.t('uplift.req.retention_note', { days: reqRetainDays })}`);
    for (const h of hits) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${h.state.charAt(0).toUpperCase() + h.state.slice(1)}`;
        badge.textContent = h.state;
        const name = document.createElement('span');
        name.className = 'model-name'; name.textContent = h.model || h.id;
        name.title = `${h.model} · ${h.id}`;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        meta.textContent = (h.excerpt || '').slice(0, 160);
        const insp = document.createElement('button');
        insp.type = 'button'; insp.className = 'se-btn act';
        insp.textContent = C.t('uplift.req.inspect');
        insp.onclick = () => window.Uplift._reqGlue.openInspector(h.id);
        row.append(badge, name, meta, insp);
        row.onclick = e => { if (e.target !== insp) window.Uplift._reqGlue.openInspector(h.id); };
        row.style.cursor = 'pointer';
        list.append(row);
    }
}

function backToLiveFeed() {
    if (!searchOn) return;
    searchOn = false;
    const note = $('req-search-note'); if (note) note.style.display = 'none';
    const lb = $('req-live-btn'); if (lb) lb.style.display = 'none';
    window.Uplift._reqGlue.renderReqFeed();
}

/* Model filter options come from STORED history (issue 4): a fresh page
   had an empty dropdown because the old source was this tab's live feed.
   Server says which models have rows inside the retention window; the live
   feed's models merge in as a union so a model seen live-but-unsaved is
   still offered. Falls back to the live set if the endpoint fails. */
let _modelsFetchedAt = 0, _storedModels = [];
async function syncReqModelOptions() {
    const sel = $('req-model'); if (!sel) return;
    const live = [...new Set([...window.Uplift._reqGlue.reqFeedRows.values()]
        .map(r => r.model).filter(Boolean))];
    if (Date.now() - _modelsFetchedAt > 60000) {
        try {
            const d = await window.Uplift._reqGlue.fetchJson(
                `${API}/uplift/api/requests-models?frm=${Date.now() / 1000 - reqRetainDays * 86400}`);
            _storedModels = (d.models || []);
            _modelsFetchedAt = Date.now();
        } catch (_) { /* keep last known + live union */ }
    }
    const models = [...new Set([..._storedModels, ...live])].sort();
    const cur = sel.value;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = C.t('uplift.req.all_models');
    sel.append(all);
    for (const m of models) {
        const o = document.createElement('option'); o.value = m; o.textContent = m;
        sel.append(o);
    }
    sel.value = models.includes(cur) ? cur : '';
}

window.Uplift.reqSearch = {
    run: runReqSearch,
    get searchOn() { return searchOn; },
};
})();
