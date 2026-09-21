/* Uplift UI controller. Reads via the mock gateway (default :11437), which
   proxies real oMLX and intercepts writes into a shadow layer. ?api= overrides. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);

/* PH2-1 stage 1: shared state (API base, prefs, layout, tracker, PT_*)
   moved to uplift_state.js -> window.Uplift.state. index.html loads the
   state file BEFORE this one, which preserves the PAT-4 property: boot can
   reach pollPatches() via applyTab() (#settings/patches deep link) and the
   state is already initialized — no temporal dead zone. The PT_* mutation
   sites below go through S so every file shares one storage cell. */
const S = window.Uplift.state;
const qp = S.qp;
const NATIVE = S.NATIVE;
const API_DEFAULT = S.API_DEFAULT;
const API = S.API;
const prefs = S.prefs;
const layout = S.layout;
const tracker = S.tracker;
/* PH2-1 stage 2: charts/timespans/metric cards extracted to
   uplift_charts.js (loaded before this file). CH is that module's export;
   the glue lets it late-bind hoisted helpers that stay here. */
const CH = window.Uplift.charts;
window.Uplift._chartGlue = {
    get fetchJson() { return fetchJson; },
    get refitUpliftBlocks() { return refitUpliftBlocks; },
    get _blockEl() { return _blockEl; },
    get _neededUnits() { return _neededUnits; },
    get _padObserver() { return _padObserver; },
    get removeCard() { return removeCard; },
    get applyI18n() { return applyI18n; },
};

/* PH2-1 stage 3: usage + logs tabs live in uplift_usage.js. The glue lets
   that module late-bind hoisted helpers that stay here (stats is a mutable
   let cell -> getter, the rest are function declarations). */
/* PH2-1 stage 4: request-history search lives in uplift_reqsearch.js; it
   reads the feed through this late-bind glue (fetchJson/openInspector/
   renderReqFeed are hoisted there, reqFeedRows is a mutable let -> getter). */
/* PH2-1 stage 5: model manager lives in uplift_modelmgr.js. Helpers that
   must stay in uplift.js (shared with the settings pages) late-bind through
   this glue; stats is a mutable let -> getter, SECRET_KEYS/cell/emptyMsg are
   stable, putModelSettings/postModelAction are hoisted above trackWrite. */
window.Uplift._modelGlue = {
    get toast() { return toast; },
    get fetchJson() { return fetchJson; },
    get stats() { return stats; },
    get SECRET_KEYS() { return SECRET_KEYS; },
    get gsDisplay() { return gsDisplay; },
    get cell() { return cell; },
    get emptyMsg() { return emptyMsg; },
    get putModelSettings() { return putModelSettings; },
    get postModelAction() { return postModelAction; },
};
const MM = window.Uplift.modelmgr;

window.Uplift._reqGlue = {
    get fetchJson() { return fetchJson; },
    get openInspector() { return window.Uplift.modelmgr.openInspector; },
    get renderReqFeed() { return renderReqFeed; },
    get reqFeedRows() { return reqFeedRows; },
};
const UUP = window.Uplift.usage;
window.Uplift._usageGlue = {
    get fetchJson() { return fetchJson; },
    get cell() { return cell; },
    get setCounter() { return setCounter; },
    get fillSelect() { return fillSelect; },
    get currentTab() { return currentTab; },
    get renderRequestStats() { return renderRequestStats; },
    get stats() { return stats; },
};

const PT_STATE_CLASS = {
    applied: 'pt-st-applied', pending: 'pt-st-pending',
    update_available: 'pt-st-update', needs_review: 'pt-st-warn',
    failed: 'pt-st-warn', obsolete: 'pt-st-dim', disabled: 'pt-st-dim',
};

/* ---------------- i18n bootstrap (classic pattern) ---------------------
   GET /uplift/api/locale -> {lang, strings}: classic's catalog merged
   with uplift's overlay (package locales/*.json). Until the fetch lands
   everything renders via key-fallback (English literals stay in place as
   data-en fallbacks, see applyI18n). window.t alias = classic parity for
   anything copied over from dashboard.js. */
window.t = (key, vars) => C.t(key, vars);
function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (el.dataset.en === undefined) el.dataset.en = el.textContent;
        const s = C.t(key);
        el.textContent = s === key ? el.dataset.en : s;
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        if (el.dataset.enTitle === undefined) el.dataset.enTitle = el.getAttribute('title') || '';
        const s = C.t(key);
        el.setAttribute('title', s === key ? el.dataset.enTitle : s);
    });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach(el => {
        const key = el.dataset.i18nPh;
        if (el.dataset.enPh === undefined) el.dataset.enPh = el.getAttribute('placeholder') || '';
        const s = C.t(key);
        el.setAttribute('placeholder', s === key ? el.dataset.enPh : s);
    });
}
async function loadLocale(lang) {
    try {
        const url = API + '/uplift/api/locale' + (lang ? '?lang=' + encodeURIComponent(lang) : '');
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('locale HTTP ' + r.status);
        const j = await r.json();
        C.setLocale(j.lang, j.strings);
        gsLocalize();
        applyI18n(document);
        CH.relabelExplore();   // JS-built labels (chips, cell titles) too
        updateModeLabels(); // UPLOADER-1: mode badges are JS-built, same re-label need
        document.documentElement.lang = j.lang;
    } catch (e) {
        /* key-fallback keeps the UI fully English; not worth a toast */
        console.warn('uplift locale load failed:', e);
    }
}

let stats = null, prevStats = null, failCount = 0, timer = null;
const PERCENTILES = { p50: 50, p90: 90, p95: 95, p99: 99 };
if (!(layout.percentile in PERCENTILES)) layout.percentile = 'p95';

/* ---------------- tabs (hash routing, like the classic dashboard) --------- */
const TABS = ['status', 'cluster', 'models', 'usage', 'logs', 'bench', 'chat', 'settings'];
const SUBS = {
    models: ['manager', 'helper', 'downloader', 'uploader', 'quantizer'],
    bench: ['throughput', 'accuracy', 'context'],
    settings: ['global', 'patches'],
    chat: ['chat'],
    cluster: ['cluster'],
};
const SUB_LABELS = {
    manager: 'Models', downloader: 'Downloader', quantizer: 'oQ(e) Quantization',
    uploader: 'Uploader', helper: 'Helper Models',
    throughput: 'Throughput', accuracy: 'Accuracy', context: 'Context',
    chat: 'Chat', cluster: 'Cluster',
    global: 'Server Settings', patches: 'Patches',
};
function currentTab() {
    const t = (location.hash || '').replace('#', '').split('/')[0];
    return TABS.includes(t) ? t : 'status';
}
function currentSub(tab) {
    const parts = (location.hash || '').replace('#', '').split('/');
    const list = SUBS[tab] || [];
    return list.includes(parts[1]) ? parts[1] : list[0];
}
function applyTab() {
    // classic parity: Cluster exists only while distributed inference is
    // active; deep-links/shortcuts to a dormant Cluster fall back to
    // Status and rewrite the stale hash before anything reads it.
    let tab = currentTab();
    if (tab === 'cluster' && $('nav-cluster').hidden) {
        history.replaceState(null, '', location.pathname + location.search + '#status');
        tab = 'status';
    }
    const sub = currentSub(tab);
    document.documentElement.dataset.tab = tab;
    document.documentElement.dataset.sub = sub;
    for (const a of $('tabs').querySelectorAll('[data-tab]')) {
        const hit = a.dataset.tab === tab;
        a.classList.toggle('active', hit);
    }
    // dropdown button labels get rebuilt (the toggle above may wipe them)
    for (const dd of [['dd-models-btn', 'uplift.tab.models', 'Models'],
                      ['dd-bench-btn', 'navbar.tab.bench', 'Bench'],
                      ['dd-settings-btn', 'uplift.tab.settings', 'Server Settings']]) {
        const btn = $(dd[0]);
        if (!btn) continue;
        let lbl = t(dd[1]);
        if (lbl === dd[1]) lbl = dd[2];   // pre-catalog fallback
        btn.replaceChildren();   // clear (no innerHTML; labels are textContent-only)
        const span = document.createElement('span');
        span.dataset.i18n = dd[1]; span.textContent = lbl;
        const caret = document.createElement('span');
        caret.className = 'dd-caret'; caret.textContent = '▾';
        btn.append(span, ' ', caret);
    }
    for (const card of pageCards) {
        const show = (card.dataset.tab || 'status') === tab &&
            (!card.dataset.sub || card.dataset.sub === sub);
        card.style.display = show ? '' : 'none';
    }
    // Status = the GridStack board; page cards live in #pages (outside it).
    $('grid').style.display = tab === 'status' ? '' : 'none';
    $('btn-customize').hidden = tab !== 'status' || dashEditing;
    if (tab !== 'status' && dashEditing) cancelDashEdit();
    // dropdown open state reset on navigation (dropdown click keeps its menu open)
    for (const m of ['dd-models-menu', 'dd-bench-menu'])
        if (ddForceOpen !== m) $(m).hidden = true;
    ddForceOpen = null;
    requestAnimationFrame(CH.resizeCharts);   // charts may have become visible
    if (tab === 'status') requestAnimationFrame(ensureUpliftGrid);
    if (tab === 'usage') UUP.pollUsage();
    if (tab === 'logs') UUP.pollLogs();
    if (tab === 'models') {
        MM.render();
        if (sub === 'downloader') initDownloader();
        if (sub === 'quantizer') renderQuantizer();
        if (sub === 'uploader') renderUploader();
        if (sub === 'helper') renderHelperModels();
        if (sub === 'manager') MM.renderTemplates();
    }
    if (tab === 'settings') {
        pollGlobalSettings(); pollEnvTunables();
        if (sub === 'patches') pollPatches();
    }
    if (tab === 'bench' || tab === 'chat' || tab === 'cluster') showEmbedPage(tab, sub);
}
addEventListener('hashchange', applyTab);

/* ---- embedded classic pages (Bench sub-tabs, Chat) ----------------------
   Same-origin iframes REUSE the original dashboard components verbatim —
   the user's explicit decision against duplicating or reimplementing the
   ~9k lines of Alpine bench/chat UI. The classic dashboard reads its tab
   from the URL (?tab=bench&benchTab=...), the chat page is a standalone
   route. Iframes load lazily on first visit and keep their state after. */
// No embed= style flag: the classic surface is byte-frozen, it simply
// renders its normal self (own navbar included) inside the frame.
const EMBED_TARGETS = {
    'bench-tp-page': '/admin/dashboard?tab=bench&benchTab=throughput',
    'bench-acc-page': '/admin/dashboard?tab=bench&benchTab=accuracy',
    'bench-ctx-page': '/admin/dashboard?tab=bench&benchTab=context',
    'chat-page': '/admin/chat',
    'cluster-page': '/admin/dashboard?tab=cluster',
};
function showEmbedPage(tab, sub) {
    const card = pageCards.find(c => c.dataset.id === EMBED_PAGE_IDS[tab]?.[sub]);
    if (!card) return;
    const id = card.dataset.id;
    const frame = card.querySelector('.embed-frame');
    const link = card.querySelector('.embed-open');
    const path = EMBED_TARGETS[id];
    if (link) link.href = API + path;
    if (!frame) return;
    // round 6 item 11: the embedded classic dashboard reads its theme from
    // same-origin localStorage keys — mirror the uplift theme into them
    // before the frame loads: day -> light, enhanced -> dark + enhanced
    // readability, everything else (auto/dark/cockpit) -> dark
    syncEmbedTheme();
    if (frame.dataset.loaded) { frame.hidden = false; return; }
    // Standalone `omlx-uplift view` proxies the API only — it cannot serve
    // the classic HTML pages; the open-in-new-tab link points at upstream.
    if (!NATIVE && !qp.has('api') && API === location.origin) {
        frame.hidden = true;
        return;
    }
    frame.src = API + path;
    frame.dataset.loaded = '1';
}
const EMBED_PAGE_IDS = {
    bench: { throughput: 'bench-tp-page', accuracy: 'bench-acc-page', context: 'bench-ctx-page' },
    chat: { chat: 'chat-page' },
    cluster: { cluster: 'cluster-page' },
};

/* dropdown menus: hover opens, click toggles, outside click / Escape closes */
let ddForceOpen = null;
const ddTimers = {};
function ddOpen(menuId, open) { $(menuId).hidden = !open; }
function bindDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    const wrap = btn.closest('.dd');
    btn.onclick = e => {
        e.preventDefault();
        clearTimeout(ddTimers[menuId]);
        const open = menu.hidden;
        if (currentTab() !== btn.dataset.tab) {
            ddForceOpen = menuId;              // re-open after the tab switch
            location.hash = '#' + btn.dataset.tab;
        }
        ddOpen(menuId, open);
    };
    // hover behaviour (like the classic navbar)
    wrap.addEventListener('mouseenter', () => {
        clearTimeout(ddTimers[menuId]);
        ddOpen(menuId, true);
    });
    wrap.addEventListener('mouseleave', () => {
        clearTimeout(ddTimers[menuId]);
        ddTimers[menuId] = setTimeout(() => { menu.hidden = true; }, 250);
    });
    for (const a of menu.querySelectorAll('a'))
        a.addEventListener('click', e => {
            e.preventDefault();
            menu.hidden = true;
            location.hash = '#' + btn.dataset.tab + '/' + a.dataset.sub;
        });
}
bindDropdown('dd-models-btn', 'dd-models-menu');
bindDropdown('dd-bench-btn', 'dd-bench-menu');
bindDropdown('dd-settings-btn', 'dd-settings-menu');
document.addEventListener('click', e => {
    for (const [btnId, menuId] of [['dd-models-btn', 'dd-models-menu'], ['dd-bench-btn', 'dd-bench-menu'],
                                    ['dd-settings-btn', 'dd-settings-menu']]) {
        const menu = $(menuId);
        if (!menu.hidden && !menu.contains(e.target) && !$(btnId).contains(e.target))
            menu.hidden = true;
    }
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('dd-models-menu').hidden = true; $('dd-bench-menu').hidden = true; $('dd-settings-menu').hidden = true; }
});

// Keyboard: 1–8 jump to tabs (ignored while typing in inputs).
document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const i = ['1', '2', '3', '4', '5', '6', '7', '8'].indexOf(e.key);
    if (i >= 0) location.hash = '#' + TABS[i];
});

/* ---------------- theme & motion ---------------- */
function applyPrefs() {
    const t = prefs.theme;
    let eff = t;
    if (t === 'auto') eff = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = eff;
    const motionOff = prefs.motion === 'off' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.motion = motionOff ? 'off' : 'auto';
    $('btn-motion').style.opacity = motionOff ? 0.4 : 1;
    if (typeof syncThemeMenu === 'function') syncThemeMenu();
    CH.rerenderChartsTheme();
    if (typeof syncEmbedTheme === 'function') syncEmbedTheme();   // round 6 item 11
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

/* round 6 item 11: mirror the uplift theme into the embedded classic pages
   (benchmarks, chat, cluster iframes). Classic reads omlx-chat-theme and
   omlx-enhanced-readability from same-origin localStorage at boot; frames
   already loaded get the attribute pushed directly (same-origin). Mapping:
   day -> light; enhanced -> dark + enhanced readability; auto/dark/cockpit
   -> dark. */
function embedThemeState() {
    const t = prefs.theme === 'auto'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : (prefs.theme || 'dark');
    const light = t === 'light';
    return { theme: light ? 'light' : 'dark', enhanced: t === 'enhanced' };
}
function syncEmbedTheme() {
    const st = embedThemeState();
    try {
        localStorage.setItem('omlx-chat-theme', st.theme);
        localStorage.setItem('omlx-enhanced-readability', st.enhanced ? 'on' : 'off');
    } catch (_) {}
    for (const f of document.querySelectorAll('.embed-frame')) {
        if (!f.dataset.loaded) continue;
        try {   // same-origin: push live so an already-open iframe follows
            const de = f.contentDocument && f.contentDocument.documentElement;
            if (!de) continue;
            de.setAttribute('data-theme', st.theme);
            if (st.enhanced) de.setAttribute('data-enhanced-readability', '');
            else de.removeAttribute('data-enhanced-readability');
        } catch (_) {}
    }
}

const motionOff = () => document.documentElement.dataset.motion === 'off';
/* Theme picker: dropdown menu (hover opens like the navbar dropdowns);
   the current selection is marked. The old click-to-cycle is gone. */
function syncThemeMenu() {
    // NB data-pick, NOT data-theme: [data-theme="light"] token blocks would
    // match the anchor itself and poison its own --ink (invisible Day text)
    const want = prefs.theme || 'auto';
    for (const a of $('dd-theme-menu').querySelectorAll('a'))
        a.classList.toggle('active', a.dataset.pick === want);
}
for (const a of $('dd-theme-menu').querySelectorAll('a'))
    a.addEventListener('click', e => {
        e.preventDefault();
        prefs.theme = a.dataset.pick;
        C.savePrefs(localStorage, prefs); applyPrefs();
        $('dd-theme-menu').hidden = true;
        toast(C.t('uplift.toast.theme_set', {theme: prefs.theme}));
    });
{
    const wrap = $('dd-theme'), menu = $('dd-theme-menu');
    let t = null;
    $('btn-theme').onclick = e => { e.preventDefault(); clearTimeout(t); menu.hidden = !menu.hidden; };
    wrap.addEventListener('mouseenter', () => { clearTimeout(t); menu.hidden = false; });
    wrap.addEventListener('mouseleave', () => { clearTimeout(t); t = setTimeout(() => { menu.hidden = true; }, 250); });
}
document.addEventListener('click', e => {
    const menu = $('dd-theme-menu');
    if (!menu.hidden && !menu.contains(e.target) && !$('btn-theme').contains(e.target))
        menu.hidden = true;
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('dd-theme-menu').hidden = true;
});
$('btn-motion').onclick = () => {
    prefs.motion = document.documentElement.dataset.motion === 'off' ? 'auto' : 'off';
    C.savePrefs(localStorage, prefs); applyPrefs();
};

/* ---------------- layout engine (GridStack, classic #3694 parity) -------- */
/* Same mechanism as the classic dashboard: GridStack 13 in 24-column,
   size-to-content mode; a Customize button opens an edit mode with drag
   handles, edge resizers, a remove/restore tray, width presets, reset and
   save. The contract lives in uplift_layout.js (uplift twin of classic's
   dashboard_layout.js — the classic file is vanilla-owned, R11 rule c).
   Persistence is localStorage (user decision), NOT settings.json. */
const cards = [...document.querySelectorAll('#grid .card')];
const pageCards = [...document.querySelectorAll('#pages .card')];
const UPL = window.UpliftLayout;

// Effective block layout (normalised): stored blocks or shipped default.
// Blocks introduced by a later release are appended once at the bottom of
// an existing saved layout (ids already merged are remembered, so a block
// the user then removes stays removed).
function currentBlockLayout(saved) {
    if (saved && Array.isArray(saved.blocks)) {
        const blocks = saved.blocks.slice();
        const merged = Array.isArray(saved.mergedBlocks) ? saved.mergedBlocks : [];
        const have = new Set([...blocks.map(b => b && b.id), ...merged]);
        const present = new Set(blocks.map(b => b && b.id));
        for (const def of UPL.defaultLayout().blocks) {
            if (have.has(def.id)) { merged.includes(def.id) || merged.push(def.id); continue; }
            merged.push(def.id);
            const bottom = blocks.reduce((m, b) => Math.max(m, (b.y || 0) + (b.h || 0)), 0);
            blocks.push({ ...def, y: bottom + 1 });
        }
        saved.mergedBlocks = merged;
        if (!present.size) return UPL.normalizeLayout({ width: saved.width, blocks: saved.blocks });
        return UPL.normalizeLayout({ width: saved.width, blocks });
    }
    return UPL.normalizeLayout(saved && saved.blocks
        ? { width: saved.width, blocks: saved.blocks } : null);
}
let upLayout = currentBlockLayout(layout);
C.saveLayout(localStorage, layout);   // persist mergedBlocks so merge is one-shot
applyWidthEarly();   // page width must be right before first paint/tab switch
function applyWidthEarly() {
    if (UPL) document.documentElement.dataset.layoutWidth = UPL.widthClass(upLayout.width);
}
let dashGrid = null, dashEditing = false, dashDraft = null, dashSaving = false;
let dashPlacedIds = [];
let dashRefitFrame = 0, dashRefitTimer = 0;
let _padObserver = null;   // set in ensureUpliftGrid; createMetricCard extends it
let dashApplying = false;   // board (re)build in progress — no refit re-entry
let _watchdogQueued = false;

const $grid = () => $('grid');
function _blockEl(id) {
    return $grid().querySelector(`.card[data-block="${id}"]`) || null;
}

/* Creates the grid the first time the status tab is visible; GridStack
   needs a measurable width. Later calls only refit block heights. */
function ensureUpliftGrid() {
    if (!UPL || typeof GridStack === 'undefined' || currentTab() !== 'status') return;
    if (dashGrid) { refitUpliftBlocks(); return; }
    const el = $grid();
    if (!el || !el.offsetWidth) return;
    dashGrid = GridStack.init({
        column: UPL.COLUMNS,
        cellHeight: 8,
        margin: 2,
        // sizeToContent OFF on purpose: it re-grows each card on every
        // content update and shoves the row below around (misalignment,
        // "reset moves cards down"). We measure content ourselves once per
        // apply and give a whole row one shared height — see _rowAlign.
        sizeToContent: false,
        float: true,   // freeform: dropped cards stay where they are put (no vertical compaction)
        animate: true,
        minRow: 1,
        disableDrag: true,
        disableResize: true,
        acceptWidgets: '.dash-tray-pill',
        draggable: { handle: '.card-handle', appendTo: 'body' },
        resizable: { handles: 'e, w, se' },
        columnOpts: {
            columnMax: UPL.COLUMNS,
            breakpointForWindow: true,
            breakpoints: [{ w: 752, c: 1, layout: 'list' }],
        },
    }, el);
    window.__upliftGrid = dashGrid;   // debug handle
    dashGrid.on('dropped', (event, previous, node) => _onTrayDrop(node));
    // Watchdog: outside edit mode the layout is the source of truth.
    // resizeToContent's growth can shift a node off its cell; snap it back
    // on the next tick (batched). Edit mode is user-driven — never snapped.
    dashGrid.on('change', () => {
        if (dashEditing || dashApplying || _watchdogQueued) return;
        _watchdogQueued = true;
        setTimeout(() => {
            _watchdogQueued = false;
            if (dashEditing || dashApplying) return;
            let moved = false;
            const narrow = dashGrid.getColumn() === 1;   // F-036
            for (const block of upLayout.blocks) {
                const n = _blockEl(block.id)?.gridstackNode;
                if (!n) continue;
                const tx = narrow ? 0 : block.x, tw = narrow ? 1 : block.w;
                if (n.x !== tx || n.y !== block.y || n.w !== tw) {
                    dashGrid.moveNode(n, { x: tx, y: block.y, w: tw });
                    moved = true;
                }
            }
            if (moved) CH.resizeCharts();
        }, 50);
    });
    dashGrid.on('dragstop resizestop', () => { CH.renderCardTsRows(true); refitUpliftBlocks(); CH.resizeCharts(); });
    GridStack.setupDragIn('.dash-tray-pill', { appendTo: 'body', helper: 'clone' });
    if (typeof ResizeObserver !== 'undefined') {
        const obs = new ResizeObserver(() => refitUpliftBlocks());
        // Observe the pad AND its children: when a narrow viewport wraps
        // stat rows, the pad's own box stays pinned by the card flex — only
        // its children grow. Watching pads alone froze the classic
        // "content grows, row never does" bug.
        el.querySelectorAll('.card-pad').forEach(pad => {
            obs.observe(pad);
            pad.querySelectorAll(':scope > *').forEach(ch => obs.observe(ch));
        });
        _padObserver = obs;
    }
    const narrow = window.matchMedia('(max-width: 751.98px)');
    const syncNarrow = () => {
        $('btn-customize').disabled = narrow.matches;
        if (narrow.matches && dashEditing) cancelDashEdit();
    };
    narrow.addEventListener('change', syncNarrow);
    syncNarrow();
    applyUpliftLayout(upLayout);
}

/* Geometry source of truth = the layout (saved or default). This pass
   only does two things: (1) rows whose CONTENT no longer fits grow, and
   every row below them shifts down accordingly (never sideways);
   (2) cards sharing a y always share the resulting height and top, so
   rows render as aligned horizontal bands. Stored gaps are preserved:
   a row keeps max(its saved height, what content needs) at
   max(saved y, cursor). Idempotent on settled content — that is why
   Reset renders identically every time now. */
function _neededUnits(el) {
    const pad = el.querySelector('.card-pad');
    if (!pad) return 8;
    // .fill-card list bodies stretch to their box by design (the fill
    // chain), so their rect measures the box, not the content. Demand =
    // header band + the list's natural rows, but CAPPED like the old
    // max-height rule: a 30-row feed must never drag the whole row band
    // taller — the box caps the list via overflow instead.
    if (el.classList.contains('fill-card')) {
        const ptop = pad.getBoundingClientRect().top;
        let fb = 0;
        for (const child of pad.children) {
            const r = child.getBoundingClientRect();
            if (child.tagName === 'H2') { fb = Math.max(fb, r.bottom - ptop); continue; }
            const list = child.querySelector('#live-list, #reqfeed, .feed');
            if (!list) { fb = Math.max(fb, r.bottom - ptop); continue; }
            const lr = list.getBoundingClientRect();
            let inner = 0;
            for (const row of list.children)
                inner = Math.max(inner, row.getBoundingClientRect().bottom - lr.top);
            fb = Math.max(fb, r.top - ptop + Math.min(320, Math.max(60, inner)));
        }
        const fpad = parseFloat(getComputedStyle(pad).paddingBottom) || 0;
        return Math.min(60, Math.max(4, Math.ceil(Math.max(fb + fpad + 2, 32) / 8)));
    }
    // The pad stretches to fill its card, so scrollHeight can't shrink
    // below the box. Union of children rects = natural content height,
    // plus the handle bar above the pad.
    const pr = pad.getBoundingClientRect();
    let bottom = 0;
    for (const child of pad.children) {
        const mb = parseFloat(getComputedStyle(child).marginBottom) || 0;
        const plot = child.querySelector && (child.querySelector('.metric-plot')
            || child.querySelector('.chart-box'));
        if (plot) {
            // Chart bodies stretch to their card, so their rect measures
            // yesterday's size — demand = the CSS min-height floor instead.
            // Otherwise a grown card can never shrink (rect ratchet).
            const lg = plot.parentElement.querySelector('.u-legend');
            const floor = plot.classList.contains('metric-plot') ? 64
                : Math.max(210, parseFloat(getComputedStyle(plot).minHeight) || 210)
                  + (lg ? 20 : 0);
            bottom = Math.max(bottom, child.getBoundingClientRect().top - pr.top + floor);
            continue;
        }
        const r = child.getBoundingClientRect();
        // getBoundingClientRect ignores margins; the next child starts
        // below them, so rect.bottom alone undercounts every stacked row
        if (r.height > 0) bottom = Math.max(bottom, r.bottom - pr.top + pad.scrollTop + mb);
    }
    const padBottom = parseFloat(getComputedStyle(pad).paddingBottom) || 0;
    // +2: minimum slack so a row sized exactly to content still paints
    // its bottom border inside the box (GridStack margins live outside
    // the content box). (S1 2026-09-19: was +8 — one full cell of dead
    // band under every row; the user wants rows to butt together.)
    const px = Math.max(bottom + padBottom + 2, 32);
    // cellHeight is 8px; clamp guards runaway canvas growth
    return Math.min(60, Math.max(4, Math.ceil(px / 8)));
}
function _rowAlign() {
    if (!dashGrid || dashApplying || dashEditing || currentTab() !== 'status') return;
    const rows = new Map();
    for (const b of upLayout.blocks) {
        if (!_blockEl(b.id)) continue;
        if (!rows.has(b.y)) rows.set(b.y, []);
        rows.get(b.y).push(b);
    }
    const ys = [...rows.keys()].sort((a, b) => a - b);
    let cursor = 0;
    const plan = [];                       // {members, y, h}
    for (const y of ys) {
        const members = rows.get(y);
        let h = 0;
        for (const m of members) {
            const el = _blockEl(m.id);
            // Metric cards always hug their content: the chart fills all
            // leftover space, so an oversized saved box is just padding.
            // Every other card keeps the saved height as a floor.
            const demand = el ? _neededUnits(el) : 0;
            h = Math.max(h, C.blockMetricKey && C.blockMetricKey(m.id)
                ? demand : Math.max(m.h, demand));
        }
        const rowY = Math.max(y, cursor);                // keep gaps, push down only
        plan.push({ members, y: rowY, h });
        cursor = rowY + h;
    }
    let changed = false;
    dashApplying = true;
    try {
        for (const { members, y, h } of plan) {
            for (const m of members) {
                if (m.y !== y || m.h !== h) { m.y = y; m.h = h; changed = true; }
                const el = _blockEl(m.id);
                const n = el?.gridstackNode;
                // F-036: same 1-col clamp as apply — never write 24-col
                // x/w at the narrow breakpoint or cards overflow again.
                const narrow = dashGrid.getColumn() === 1;
                const px = narrow ? 0 : m.x, pw = narrow ? 1 : m.w;
                if (n && (n.x !== px || n.y !== m.y || n.w !== pw || n.h !== m.h)) {
                    n.x = px; n.y = m.y; n.w = pw; n.h = m.h;
                    dashGrid._writePosAttr(el, n);
                }
            }
        }
        if (changed) dashGrid._updateContainerHeight();
    } finally {
        dashApplying = false;
    }
    if (changed) CH.resizeCharts();
    CH.fitAllMetricPlots();   // row grew/shrank: hand the delta to the charts
    // Rows are only measurable once cards are placed (parked rows have
    // clientWidth 0): re-evaluate chip fit after every settle pass (the
    // render is idempotent — rows that already fit or stay collapsed are
    // untouched, so this cannot feed the ResizeObserver loop).
    CH.renderCardTsRows();
}

/* Card content grows after first paint (charts render, feeds fill).
   Debounced so a burst of polling updates triggers one align pass. */
function refitUpliftBlocks() {
    if (!dashGrid || currentTab() !== 'status' || dashApplying) return;
    if (!dashRefitFrame) {
        dashRefitFrame = requestAnimationFrame(() => { dashRefitFrame = 0; _rowAlign(); });
    }
    clearTimeout(dashRefitTimer);
    dashRefitTimer = setTimeout(_rowAlign, 400);
}

function _parkCard(el) {
    dashGrid.removeWidget(el, false, false);
    el.classList.add('card-parked');
}
function _placeCard(id, pos, h) {
    const el = _blockEl(id);
    if (!el || el.gridstackNode) return null;
    el.classList.remove('card-parked');
    dashGrid.makeWidget(el, { id, x: pos.x, y: pos.y, w: pos.w, h: h || 1, minW: UPL.minWFor(id) });
    if (!dashPlacedIds.includes(id)) dashPlacedIds = [...dashPlacedIds, id];
    return el;
}
function applyUpliftLayout(saved) {
    if (!dashGrid || !UPL) return;
    upLayout = UPL.normalizeLayout(saved && saved.blocks
        ? { width: saved.width, blocks: saved.blocks } : saved);
    dashGrid.setAnimation(false);
    dashGrid.getGridItems().forEach(item => _parkCard(item));
    dashPlacedIds = [];
    // Freeform (float: true): exact saved cell per block, no compaction.
    // Widgets get their REAL h up front (from the layout) — the earlier
    // scatter came from h:1 cards growing via resizeToContent and colliding
    // with the row below, which made GridStack push them away. With honest
    // initial geometry nothing overlaps, so nothing moves. refitUpliftBlocks
    // then corrects heights to content; in float mode a growing card only
    // takes empty space below itself.
    dashApplying = true;
    try {
        upLayout.blocks.forEach(block => {
            const el = _blockEl(block.id);
            if (!el) return;
            el.classList.remove('card-parked');   // un-park before placement
            if (!el.gridstackNode) {
                dashGrid.makeWidget(el, { id: block.id, x: block.x, y: block.y, w: block.w, h: block.h, minW: UPL.minWFor(block.id) });
            }
            // Teleport: freeform collision resolution pushes overlaps to
            // new cells — which is exactly the "snaps to weird places"
            // users saw on re-apply. Positions in a saved layout are
            // trusted as-is; assign the node and redraw its box.
            const n = el.gridstackNode;
            // F-036: at the c=1 breakpoint a saved 24-col w means N× the
            // viewport width — clamp to the single column. The 24-col
            // geometry stays untouched in upLayout, so wide viewports
            // restore the user's exact layout.
            const narrow = dashGrid.getColumn() === 1;
            n.x = narrow ? 0 : block.x; n.y = block.y;
            n.w = narrow ? 1 : block.w; n.h = block.h;
            dashGrid._writePosAttr(el, n);   // this build's DOM-position writer
            if (!dashPlacedIds.includes(block.id)) dashPlacedIds.push(block.id);
        });
        dashGrid._updateContainerHeight();
    } finally {
        dashApplying = false;
    }
    dashGrid.setAnimation(true);
    applyWidth();
    renderTray();
    refitUpliftBlocks();   // aligns row heights once content is measurable
}
function collectUpliftLayout() {
    // NOT dashGrid.save(): this GridStack build's saveRemoveDefaults pass
    // deletes `w` whenever w === minW (and `h` when h === minH or 1) — our
    // stat tiles have minW 4 and default w 4, so save() returned
    // {w: undefined} for them and the normaliser's fallback silently
    // widened them to 24. Saving an untouched board "broke" it. Read the
    // live engine nodes instead — x/y/w/h are always present there.
    const blocks = dashGrid.engine.nodes
        .filter(n => n.el && n.el.dataset.block)
        .map(n => ({ id: n.el.dataset.block, x: n.x, y: n.y, w: n.w, h: n.h }));
    return UPL.normalizeLayout({ version: 1, width: dashDraft?.width ?? upLayout.width, blocks });
}
// TRAY-1: geometry of cards removed this edit session, keyed by block id.
// The tray pill is a fixed gs-w=12 stub; re-adding must restore the width
// the card actually had when it left the board (a removed full-width card
// came back as a half-width one otherwise). x/y still come from the drop.
const _trayGeo = new Map();
function _onTrayDrop(node) {
    if (!dashGrid || !UPL || !node?.el) return;
    const id = node.el.dataset.block;
    // The dropped element is GridStack's clone of the tray pill.
    dashGrid.removeWidget(node.el, true, false);
    if (!UPL.BLOCK_IDS.includes(id) || !dashEditing) return;
    const geo = _trayGeo.get(id);
    _trayGeo.delete(id);
    const pos = { x: node.x, y: node.y, w: geo ? geo.w : node.w };
    _placeCard(id, pos);
    renderTray();   // F-035: the pill must leave the tray once its block is back
    refitUpliftBlocks();
}
function removeCard(id) {
    const el = _blockEl(id);
    if (!dashGrid || !dashEditing || !el?.gridstackNode) return;
    _trayGeo.set(id, { w: el.gridstackNode.w });
    _parkCard(el);
    dashPlacedIds = dashPlacedIds.filter(p => p !== id);
    // Freeform: no compaction — the gap the card leaves is the user's gap.
    renderTray();
}

/* ---- tray: draggable pills for blocks not on the board ---- */
function blockLabel(id) {
    const span = _blockEl(id)?.querySelector('.card-handle span[data-i18n], .card-handle span:not(.hatch)');
    return span ? span.textContent : id;
}
function renderTray() {
    const tray = $('layout-tray');
    if (!tray) return;
    tray.querySelectorAll('.dash-tray-pill').forEach(p => p.remove());
    const hint = tray.querySelector('.lt-hint'), label = tray.querySelector('.lt-label');
    for (const id of UPL.BLOCK_IDS) {
        if (dashPlacedIds.includes(id)) continue;
        const pill = document.createElement('div');
        pill.className = 'dash-tray-pill grid-stack-item';
        pill.setAttribute('gs-w', '12'); pill.setAttribute('gs-h', '1');
        pill.setAttribute('gs-min-w', '6'); pill.dataset.block = id;
        const inner = document.createElement('div');
        inner.className = 'grid-stack-item-content dash-tray-pill-content';
        const gripMark = document.createElement('span'); gripMark.className = 'hatch';
        const text = document.createElement('span'); text.textContent = blockLabel(id);
        inner.append(gripMark, text);
        pill.append(inner);
        tray.append(pill);   // pills after label/empty; hint sits last via CSS order
    }
    const empty = UPL.BLOCK_IDS.every(id => dashPlacedIds.includes(id));
    tray.querySelector('.lt-empty').hidden = !empty;
    // F-035b: setupDragIn binds ONCE to elements matching at call time (grid
    // init, line ~414) — pills created now would never be draggable, so
    // tray-restore was silently dead on every fresh page. Re-run it per
    // render; GridStack skips already-bound pills (isDraggable guard).
    GridStack.setupDragIn('.dash-tray-pill', { appendTo: 'body', helper: 'clone' });
    void label;
}

/* ---- width presets (classic's max-w ladder, tokenised for our CSS) ---- */
function applyWidth() {
    document.documentElement.dataset.layoutWidth =
        UPL.widthClass(dashEditing && dashDraft ? dashDraft.width : upLayout.width);
}
function renderWidthSeg() {
    const seg = $('lt-widths');
    if (!seg || seg.childElementCount) return;
    for (const id of UPL.WIDTH_IDS) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.width = id;
        b.textContent = C.tf(`uplift.layout.width_${id}`, id);
        b.onclick = () => {
            if (!dashEditing) return;
            dashDraft.width = id;
            renderWidthSeg(); applyWidth();
            requestAnimationFrame(() => { dashGrid?.onResize(); refitUpliftBlocks(); CH.resizeCharts(); });
        };
        seg.append(b);
    }
    const active = dashEditing && dashDraft ? dashDraft.width : upLayout.width;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.width === active));
}

/* ---- edit mode lifecycle (classic parity) ---- */
function _afterLayoutChange() {
    requestAnimationFrame(() => { dashGrid?.onResize(); refitUpliftBlocks(); CH.resizeCharts(); });
}
function startDashEdit() {
    if (!dashGrid || !upLayout || dashEditing || $('btn-customize').disabled) return;
    dashDraft = { width: upLayout.width };
    $('lt-error').hidden = true;
    dashEditing = true;
    document.body.classList.add('layout-editing');
    $('btn-customize').hidden = true;
    $('layout-toolbar').hidden = false;
    $('layout-tray').hidden = false;
    dashGrid.enable();
    renderWidthSeg(); renderTray();
    _afterLayoutChange();
}
function cancelDashEdit() {
    if (!dashEditing) return;
    dashEditing = false; dashDraft = null;
    $('lt-error').hidden = true;
    document.body.classList.remove('layout-editing');
    $('btn-customize').hidden = false;
    $('layout-toolbar').hidden = true;
    $('layout-tray').hidden = true;
    if (dashGrid) { dashGrid.disable(); applyUpliftLayout(upLayout); }
    _afterLayoutChange();
}
function resetDashLayout() {
    if (!dashEditing || !UPL) return;
    dashDraft.width = 'default';
    applyUpliftLayout(UPL.defaultLayout());
    renderWidthSeg();
    _afterLayoutChange();
}
function saveDashLayout() {
    if (!dashGrid || !dashEditing || dashSaving) return;
    const next = collectUpliftLayout();
    dashSaving = true;
    $('lt-error').hidden = true;
    try {
        layout.blocks = next.blocks;
        layout.width = next.width;
        C.saveLayout(localStorage, layout);
        upLayout = next;
        dashEditing = false; dashDraft = null;
        document.body.classList.remove('layout-editing');
        $('btn-customize').hidden = false;
        $('layout-toolbar').hidden = true;
        $('layout-tray').hidden = true;
        dashGrid.disable();
        _afterLayoutChange();
    } catch (err) {
        console.error('Failed to save layout:', err);
        const e = $('lt-error');
        e.textContent = C.t('uplift.layout.save_failed'); e.hidden = false;
    } finally {
        dashSaving = false;
    }
}
$('btn-customize').onclick = startDashEdit;
$('lt-cancel').onclick = cancelDashEdit;
$('lt-save').onclick = saveDashLayout;
$('lt-reset').onclick = resetDashLayout;
for (const card of cards) {
    card.querySelector('.card-remove').onclick = () => removeCard(card.dataset.block);
}

/* ---- settings popover (window / interval / hide-debug / reset) ---- */
function fillSelect(sel, options, value) {
    sel.innerHTML = '';
    for (const [v, label] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (String(v) === String(value)) o.selected = true;
        sel.append(o);
    }
}
fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, CH.windowLabel(s)]), layout.chartWindowSec);
$('opt-window').onchange = e => CH.setGlobalWindow(Number(e.target.value));
fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
$('opt-interval').onchange = e => { layout.intervalMs = Number(e.target.value); C.saveLayout(localStorage, layout); restartPolling(); };
$('opt-hide-debug').checked = layout.logsHideDebug;
$('opt-hide-debug').onchange = e => { layout.logsHideDebug = e.target.checked; C.saveLayout(localStorage, layout); };
/* Server-side retention (RL-0): reads/writes the uplift store, not localStorage. */
async function loadRetention() {
    try {
        const r = await fetchJson(`${API}/uplift/api/retention`);
        $('opt-retention-metrics').value = r.metrics_days;
        $('opt-retention-log').value = r.log_days;
        $('opt-retention-metrics').dataset.prev = r.metrics_days;
        $('opt-retention-log').dataset.prev = r.log_days;
    } catch (e) { /* endpoint absent on older servers — leave inputs blank */ }
}
async function saveRetention(which) {
    const m = $('opt-retention-metrics'), l = $('opt-retention-log');
    const body = which === 'm' ? { metrics_days: Number(m.value) } : { log_days: Number(l.value) };
    try {
        const r = await postJson(`${API}/uplift/api/retention`, body);
        m.value = r.metrics_days; l.value = r.log_days;
        m.dataset.prev = r.metrics_days; l.dataset.prev = r.log_days;
    } catch (e) { toast('retention: ' + e.message, 4000); loadRetention(); }
}
$('opt-retention-metrics').onchange = () => saveRetention('m');
$('opt-retention-log').onchange = () => saveRetention('l');
loadRetention();
$('btn-layout-reset').onclick = () => {
    Object.assign(layout, C.LAYOUT_DEFAULTS);
    upLayout = UPL.defaultLayout();
    layout.blocks = upLayout.blocks; layout.width = upLayout.width;
    C.saveLayout(localStorage, layout);
    if (dashGrid) applyUpliftLayout(upLayout);
    renderTray();
    fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, CH.windowLabel(s)]), layout.chartWindowSec);
    CH.renderCardTsRows(); CH.drawAllMetricCharts();
    fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
    $('opt-hide-debug').checked = layout.logsHideDebug;
    CH.markHistoryDirty();
    restartPolling();
    CH.resizeCharts();
};
$('btn-layout').onclick = e => {
    e.stopPropagation();
    $('layout-pop').hidden = !$('layout-pop').hidden;
};
document.addEventListener('click', e => {
    if (!$('layout-pop').hidden && !$('layout-pop').contains(e.target) && e.target !== $('btn-layout'))
        $('layout-pop').hidden = true;
});

/* ---------------- animated counters (lightweight rAF tween) --------------- */
const counters = {};
function counter(elId, format) {
    counters[elId] = { el: $(elId), format, value: null, raf: 0 };
}
function setCounter(elId, target) {
    const c = counters[elId];
    if (!c) return;
    if (target === null) { c.el.textContent = '—'; c.value = null; return; }
    if (c.value === null || motionOff() || c.value === target) { c.value = target; c.el.textContent = c.format(target); return; }
    cancelAnimationFrame(c.raf);
    const from = c.value, start = performance.now(), dur = 600;
    const step = now => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) ** 3;               // easeOutCubic
        c.el.textContent = c.format(from + (target - from) * eased);
        if (t < 1) c.raf = requestAnimationFrame(step);
        else c.el.textContent = c.format(target);
    };
    c.value = target;
    c.raf = requestAnimationFrame(step);
}
counter('v-gentps',     v => v.toFixed(1));
counter('v-prefilltps', v => v.toFixed(0));
counter('v-requests',   v => C.fmtNumber(v));
counter('v-tokens',     v => C.fmtCompact(v));
counter('v-cacheeff',   v => v.toFixed(1) + '%');
counter('v-prompt-avg', v => C.fmtCompact(v));
counter('v-prompt-pct', v => C.fmtCompact(v));
counter('v-compl-avg',  v => C.fmtCompact(v));
counter('v-compl-pct',  v => C.fmtCompact(v));
counter('v-ttft',       v => C.fmtNumber(v));
counter('v-errrate',    v => v.toFixed(2) + '%');
counter('v-u-req',      v => C.fmtNumber(v));
counter('v-u-tok',      v => C.fmtCompact(v));
counter('v-u-prompt',   v => C.fmtCompact(v));
counter('v-u-compl',    v => C.fmtCompact(v));

/* ---- charts + timespans + metric cards: extracted to uplift_charts.js
   (PH2-1 stage 2); the window.Uplift.charts aliases live at the top. ---- */

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
function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
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
    toast(`🎉 ${text}`);
    if (motionOff() || typeof confetti !== 'function') return;
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
        if (ev.kind === 'model-add')   toast(C.t('uplift.toast.model_loaded', {model: ev.model}));
    }
}
/* Milestone gate: fire each round crossing at most once per page session,
   immune to overlapping polls comparing against a stale snapshot (that
   re-reported the same crossing and made toasts/confetti fire twice). */
const milestoneFloor = {};   // key -> highest ladder rung already celebrated
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

/* ---------------- rendering ---------------- */
function render(s) {
    setCounter('v-gentps', s.genTps);
    setCounter('v-prefilltps', s.prefillTps);
    setCounter('v-requests', s.requests);
    setCounter('v-tokens', s.totalTokens);
    setCounter('v-cacheeff', s.cacheEfficiency);
    $('v-tokens-sub').textContent = s.completionTokens !== null
        ? `${C.fmtCompact(s.completionTokens)} generated · ${C.fmtCompact(s.cachedTokens)} cached` : '';
    $('chip-uptime').textContent = `up ${C.fmtDuration(s.uptime)}`;
    $('v-active2').textContent = s.active === null ? '—' : s.active;
    $('v-waiting2').textContent = s.waiting === null ? '—' : s.waiting;

    const dot = $('status-dot');
    dot.classList.toggle('bad', s.pressure === 'hard');

    const mem = $('meter-cache');
    mem.classList.toggle('warn', s.memPercent !== null && s.memPercent >= 70);
    mem.classList.toggle('bad', s.memPercent !== null && s.memPercent >= 90);
    $('cache-sub').textContent = s.memUsed !== null
        ? `models ${C.fmtBytes(s.memUsed)} / ${C.fmtBytes(s.memMax)} · disk cache ${C.fmtBytes(s.cacheBytes)}${s.cachePercent !== null ? ' (' + s.cachePercent.toFixed(0) + '%)' : ''}`
        : '';
    $('mem-label').textContent = s.memPercent !== null ? `${s.memPercent.toFixed(1)}% ${s.pressure || ''}` : '';

    renderLive(s);
    renderRequestStats(s);

    const cacheGB = s.cacheBytes === null ? null : +(s.cacheBytes / 1e9).toFixed(3);
    const hotSorted = (s.cacheModels || []).slice()
        .sort((a, b) => (b.hotBytes || 0) - (a.hotBytes || 0)).slice(0, 3);
    CH.pushStatusSample(s, cacheGB, hotSorted);   // buffers + redraw (uplift_charts.js)
}

function renderLive(s) {
    const list = $('live-list');
    const rows = [];
    for (const m of s.models) {
        for (const p of m.prefilling) rows.push({ model: m.id, kind: C.t('uplift.inflight.prefilling'), prompt: p.prompt, progress: p.progress, reqId: p.request_id });
        for (const g of m.generating) rows.push({ model: m.id, kind: C.t('uplift.inflight.generating'), prompt: g.prompt, generated: g.generated, tps: g.tps, reqId: g.request_id });
    }
    $('live-count').textContent = rows.length ? `${rows.length}` : '';
    if (!rows.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">Idle</div>';
        return;
    }
    list.innerHTML = '';
    for (const r of rows) {
        const row = document.createElement('div'); row.className = 'model-row';
        row.style.flexWrap = 'wrap';
        const badge = document.createElement('span');
        badge.className = `badge ${r.kind}`; badge.textContent = r.kind;
        const name = document.createElement('span');
        name.className = 'model-name'; name.textContent = r.model; name.title = r.model;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.generated !== undefined) bits.push(`out ${C.fmtCompact(r.generated)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        if (r.progress !== undefined && r.progress !== null) bits.push(`${Math.round(r.progress * 100)}%`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (r.reqId && reqFeedRows.get(r.reqId)?.loopHint) {   // RL-4 amber
            const chip = document.createElement('span');
            chip.className = 'spill miss';
            chip.textContent = 'LOOP?';
            chip.title = C.t('uplift.req.loop_hint');
            row.append(chip);
        }
        if (r.reqId && r.reqId !== 'rank0') {
            const insp = document.createElement('button');
            insp.type = 'button'; insp.className = 'se-btn act';
            insp.textContent = C.t('uplift.req.inspect'); insp.title = C.t('uplift.req.inspect_title');
            insp.onclick = () => MM.openInspector(r.reqId);
            row.append(insp);
        }
        if (r.progress !== undefined && r.progress !== null) {
            const bar = document.createElement('div');
            bar.className = 'meter'; bar.style.flex = '1 0 100%'; bar.style.marginTop = '4px';
            const fill = document.createElement('div');
            fill.style.width = Math.round(r.progress * 100) + '%';
            bar.append(fill);
            row.append(bar);
        }
        list.append(row);
    }
}

/* Request sizes: prefer server-side full-population stats (gateway overlay);
   fall back to client-side session tracker when absent. */
function renderRequestStats(s) {
    fillSelectOnce();
    const p = PERCENTILES[layout.percentile];
    const server = s && s.requestStats ? s.requestStats : null;
    const pick = (blk, key) => blk && blk[key] !== undefined && blk[key] !== null ? blk[key] : null;
    const pKey = layout.percentile;
    // Labels must follow the selector in BOTH paths (F-021: server-stats path
    // updated the values but left "p95 …" text under a p99 number).
    $('lbl-prompt-pct').textContent = `${layout.percentile} prompt tok`;
    $('lbl-compl-pct').textContent = `${layout.percentile} completion tok`;

    if (server) {
        const pt = server.prompt_tokens || {}, ct = server.completion_tokens || {};
        setCounter('v-prompt-avg', pt.avg ?? null);
        setCounter('v-compl-avg', ct.avg ?? null);
        setCounter('v-prompt-pct', pick(pt, pKey));
        setCounter('v-compl-pct', pick(ct, pKey));
        const ft = server.first_token_ms || {};
        setCounter('v-ttft', pick(ft, pKey) ?? ft.avg ?? null);
        const n = (pt.n || 0), errs = server.errors_total || 0;
        setCounter('v-errrate', (n + errs) > 0 ? errs / (n + errs) * 100 : null);
        $('reqstats-note').textContent =
            `server stats · ${n} samples` +
            (server.observed_real !== undefined ? ` (${server.observed_real} real, ${server.simulated} simulated)` : '') +
            (server.source ? ` · ${server.source}` : '');
        return;
    }
    const promptSamples = tracker.samples.prompt, complSamples = tracker.samples.completion;
    setCounter('v-prompt-avg', S.usageAvg ? S.usageAvg.prompt : (C.mean(promptSamples) ?? null));
    setCounter('v-compl-avg', S.usageAvg ? S.usageAvg.completion : (C.mean(complSamples) ?? null));
    setCounter('v-prompt-pct', C.percentile(promptSamples, p));
    setCounter('v-compl-pct', C.percentile(complSamples, p));
    setCounter('v-ttft', null);
    setCounter('v-errrate', null);
    $('lbl-prompt-pct').textContent = `${layout.percentile} prompt tok`;
    $('lbl-compl-pct').textContent = `${layout.percentile} completion tok`;
    const n = Math.max(promptSamples.length, complSamples.length);
    $('reqstats-note').textContent =
        `avg: usage aggregates (${S.usageRange}) · p: session samples (${n}, cap 2000)` +
        (n === 0 ? ' — waiting for requests to complete while this page is open' : '');
}
let fillSelectDone = false;
function fillSelectOnce() {
    if (fillSelectDone) return;
    fillSelectDone = true;
    fillSelect($('opt-percentile'), Object.keys(PERCENTILES).map(k => [k, k.toUpperCase()]), layout.percentile);
    $('opt-percentile').onchange = e => { layout.percentile = e.target.value; C.saveLayout(localStorage, layout); renderRequestStats(stats); };
}

/* ---------------- polling ---------------- */
async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
async function putModelSettings(model, settings) {
    const body = await S.trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings) });
        return res.json().catch(() => ({ detail: 'http ' + res.status }));
    });
    // missing (stored-only) models: the classic PUT 404s (no engine entry).
    // The uplift POST upserts the stored record directly (round 4: missing
    // settings are editable).
    if (body.detail && /not found/i.test(String(body.detail))) {
        return postJson(`${API}/uplift/api/models/${encodeURIComponent(model)}/settings`, settings);
    }
    if (body.detail && body.success !== true) throw new Error(JSON.stringify(body.detail));
    if (body.success === false) throw new Error(JSON.stringify(body.detail || body));
    return body;
}
async function postModelAction(model, action) {
    const body = await S.trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/${action}`,
            { method: 'POST' });
        return res.json().catch(() => ({ detail: 'http ' + res.status }));
    });
    if (body.detail && body.success !== true && body.deleted !== true)
        throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail));
    return body;
}
async function pollStats() {
    if (document.hidden) return;
    try {
        const s = C.normalize(await fetchJson(`${API}/admin/api/stats`));
        failCount = 0;
        document.body.classList.remove('stale');
        $('banner').classList.remove('show');
        const events = C.eventsBetween(prevStats, s);
        const miles = C.milestonesBetween(prevStats, s);
        prevStats = stats; stats = s;
        if (milestoneFloor.requests === undefined && s.requests !== null)
            milestoneFloor.requests = C.milestoneFloorOf(s.requests);
        if (milestoneFloor.totalTokens === undefined && s.totalTokens !== null)
            milestoneFloor.totalTokens = C.milestoneFloorOf(s.totalTokens);
        tracker.observe(s);
        render(s);
        reactTo(events);
        for (const mi of gateMilestones(miles)) celebrate(milestoneQuip(mi));
    } catch (err) {
        if (++failCount >= 2) {
            document.body.classList.add('stale');
            $('banner-text').textContent = `Cannot reach API at ${API || location.origin}: ${err.message}`;
            $('banner').classList.add('show');
        }
    }
}
function restartPolling() {
    clearInterval(timer);
    pollStats();
    timer = setInterval(pollStats, layout.intervalMs);
}

/* ---------------- gateway status chip ---------------- */
// Native hosting writes go straight to real oMLX — same truth as LIVE mode.
let GW_LIVE = typeof NATIVE !== 'undefined' && NATIVE;   // true when the gateway runs in --live-writes mode
let gsSavedAt = 0;     // last save banner timestamp (updateModeLabels keeps it briefly)
/* Every page that claims 'shadow' must say so truthfully per gateway mode. */
function updateModeLabels() {
    const live = GW_LIVE;
    const dl = $('dl-mode'); if (dl) dl.textContent = live
        ? C.t('uplift.mode.dl_live') : C.t('uplift.mode.dl_shadow');
    const qz = $('qz-mode'); if (qz) qz.textContent = live
        ? C.t('uplift.mode.qz_live')
        : C.t('uplift.mode.qz_shadow');
    const up = $('up-mode'); if (up) up.textContent = live
        ? C.t('uplift.mode.up_live')
        : C.t('uplift.mode.up_shadow');
    const gs = $('gs-sub');
    // R10-2: this is the real dashboard now — live mode needs no banner.
    if (gs && Date.now() - gsSavedAt > 5000) gs.textContent = live
        ? '' : C.t('uplift.mode.gs_shadow');
    const hm = $('hm-sub');
    if (hm && hm.dataset.count) hm.textContent =
        C.t('uplift.mode.hm_sub', { n: hm.dataset.count, mode: live ? C.t('uplift.mode.live') : C.t('uplift.mode.shadow') });
}
async function pollGatewayInfo() {
    const chip = $('chip-gateway');
    // R11: native hosting = same-origin API, no gateway involved at all.
    if (NATIVE || API !== API_DEFAULT) {
        // 'direct' meant "talks to the server directly" — remnant of the old
        // mock-gateway era; in native mode the chip is meaningless, keep hidden
        if (chip) chip.hidden = true;
        if (NATIVE) updateModeLabels();   // labels must say the truth for real writes
        return;
    }
    if (chip) chip.hidden = false;
    try {
        const d = await fetchJson(`${API}/admin/api/mock/info`);
        GW_LIVE = !!d.live_writes;
        updateModeLabels();
        chip.textContent = d.ok
            ? (GW_LIVE ? 'gw↑LIVE' : `gw↑ok · r${d.observed_real}/s${d.simulated}`)
            : 'gw↑down';
        chip.classList.toggle('state-ok', !!d.ok);
        chip.title = `gateway → ${d.upstream}: ${d.ok ? C.t('uplift.gw.reachable') : (d.last_error || C.t('uplift.gw.unreachable'))}\n` +
                     (GW_LIVE ? ''
                              : `shadow overrides: ${Object.keys(d.overrides || {}).length} · `) +
                     `sim ${d.sim_rate}/s`;
    } catch (_) { chip.textContent = 'gw?'; chip.classList.remove('state-ok'); }
}

/* ---------------- request lifecycle feed ---------------- */
const MAX_REQFEED = 30;
let reqFeedRows = new Map();
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
        insp.onclick = () => MM.openInspector(r.id);
        row.append(insp);
        if (['queued', 'prefilling', 'generating'].includes(r.state)) {
            const x = document.createElement('button');
            x.className = 'se-btn'; x.textContent = '✕'; x.title = 'Cancel request';
            x.onclick = async () => {
                try {
                    const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(r.id)}/cancel`, { method: 'POST' });
                    if (res.status === 501) { toast(C.t('uplift.toast.no_cancel_route')); return; }
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
                    toast(C.t('uplift.toast.cancelled', {id: r.id.slice(0, 6)}));
                } catch (err) { toast(C.t('uplift.toast.cancel_failed', {msg: err.message})); }
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
        const d = await fetchJson(`${API}/admin/api/requests?limit=30`);
        for (const r of d.requests)
            upsertReq(r.id, { state: r.state, model: r.model, origin: r.origin,
                              prompt: r.prompt_tokens, completion: r.completion_tokens,
                              tps: r.tps, error: r.error });
    } catch (_) { /* gateway offline; feed keeps last state */ }
}

/* ---- model manager + editor + inspector (Models tab): extracted to
   uplift_modelmgr.js (PH2-1 stage 5); window.Uplift.modelmgr aliases below. ---- */

function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }
function emptyMsg(host, msg) {   // error text goes through textContent, never innerHTML
    host.textContent = '';
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = msg; host.append(d);
}

/* ---- usage + logs tabs: extracted to uplift_usage.js (PH2-1 stage 3);
   window.Uplift.usage aliases live at the top. ---- */

/* ---------------- settings (Settings tab: read-only server preview) ------ */
/* ---- Server settings: editable form mirroring the classic Settings page.
   Same 11 sections, same fields, labels, hints, restart badges and
   conditional visibility (i18n strings copied from the original catalog).
   Saves replicate classic saveGlobalSettings(): full flat payload POSTed to
   global-settings — the gateway shadows it, real oMLX is never modified. */
/* ---------------- global-settings labels i18n ----------------
   GS_LABELS holds the English literals. When a non-en catalog lands we
   overwrite in place (deep walk; keys = 'uplift.gs.' + dotted path;
   option arrays localize their second element). Missing key -> the
   English literal stays (same fallback semantics as C.tf). Language
   self-names and path placeholders are never translated. */
const GS_EN = JSON.parse(JSON.stringify({}));   // filled on first localize: pristine EN
function gsLocalize() {
    const strings = C.getLocale().strings;
    if (!Object.keys(GS_EN).length) Object.assign(GS_EN, JSON.parse(JSON.stringify(GS_LABELS)));
    (function walk(en, cur, prefix) {
        for (const k of Object.keys(en)) {
            const ev = en[k], cv = cur[k];
            const path = prefix + k;
            if (ev && typeof ev === 'object' && !Array.isArray(ev)) { walk(ev, cv, path + '.'); continue; }
            if (/^lang\.|_placeholder$/.test(path)) continue;
            if (typeof ev === 'string') {
                const s = strings['uplift.gs.' + path];
                cur[k] = (typeof s === 'string' && s) ? s : ev;      // restore-or-translate, idempotent
            } else if (Array.isArray(ev) && Array.isArray(ev[0])) {  // [[value,label],…]
                cur[k] = ev.map(([v, lbl]) => {
                    const s = strings['uplift.gs.' + path + '.' + v];
                    return [v, (typeof s === 'string' && s) ? s : lbl];
                });
            }
        }
    })(GS_EN, GS_LABELS, '');
}

const GS_LABELS = {
    lang: { en: 'English', zh: '中文（简体）', 'zh-TW': '中文（繁體）', ko: '한국어',
            ja: '日本語', ru: 'Русский', es: 'Español', fr: 'Français',
            'pt-BR': 'Português (Brasil)' },
    auth: { api_key: 'API Key',
        api_key_hint: 'Clients must send this key in the Authorization header.',
        api_key_placeholder: C.tf('uplift.ui.enter_new_api_key', 'Enter new API key'),
        base_path: 'Base Path',
        base_path_hint: 'URL prefix when served behind a reverse proxy (e.g. /omlx).',
        skip: 'Skip API key verification',
        skip_hint: 'Disable authentication for local development.',
        skip_warning: 'Anyone on the network can call this server.' },
    server: { host: 'Host', host_placeholder: '127.0.0.1',
        port: 'Port', log_level: 'Log level',
        auto_start: 'Start on Login', auto_start_hint: 'Launch oMLX automatically when this Mac signs in.',
        aliases: 'Server Aliases',
        aliases_hint: 'Names this server answers to (one per line).',
        levels: [['error','Error'],['warning','Warning'],['info','Info'],
                 ['debug','Debug'],['trace','Trace']] },
    model: { dirs: 'Model Directories', ph_primary: '/path/to/models',
        ph_additional: 'Additional directory…',
        fallback: 'Model Fallback', fallback_desc: C.tf('uplift.ui.alias_to_use_when_the_requested_model_is_unavail', 'Alias to use when the requested model is unavailable.'),
        hide_helper: 'Hide helper models', hide_helper_desc: C.tf('uplift.ui.keep_drafters_and_assistants_out_of_model_lists', 'Keep drafters and assistants out of model lists.'),
        hf_cache: 'Hugging Face cache', hf_cache_desc: C.tf('uplift.ui.reuse_downloaded_models_from_the_local_hf_cache', 'Reuse downloaded models from the local HF cache.'),
        idle: 'Idle Timeout', idle_desc: C.tf('uplift.ui.unload_a_model_after_it_has_been_unused_for_this', 'Unload a model after it has been unused for this long.'),
        idle_opts: [['','Never'],['900','15 minutes'],['1800','30 minutes'],
                    ['3600','1 hour'],['7200','2 hours'],['28800','8 hours'],
                    ['86400','24 hours']] },
    res: { max_conc: 'Max Concurrent Requests',
        max_conc_hint: 'Requests admitted at once; others queue.',
        batch: 'Embedding Batch Size',
        batch_hint: 'Texts encoded per embedding forward pass.',
        chunked: 'Chunked Prefill', chunked_desc: C.tf('uplift.ui.split_long_prompts_to_interleave_with_decode', 'Split long prompts to interleave with decode.'),
        fairness: 'Decode Fairness', fairness_desc: C.tf('uplift.ui.round_robin_decode_slots_across_requests', 'Round-robin decode slots across requests.'),
        prio: 'Prefill Priority', prio_speed: 'Speed', prio_context: 'Max Context',
        guard: 'Prefill Memory Guard',
        guard_desc: C.tf('uplift.ui.refuse_prefill_when_free_memory_is_below_the_gua', 'Refuse prefill when free memory is below the guard.'),
        tier: 'Memory Guard Tier',
        tiers: [['safe','Safe'],['balanced','Balanced'],['aggressive','Aggressive'],
                ['custom','Custom']],
        custom: 'Custom Ceiling (GB)',
        custom_ph: 'e.g. 48',
        cold: 'Cold Cache Limit',
        cold_desc: C.tf('uplift.ui.cap_on_non_hot_kv_cache_blocks', 'Cap on non-hot KV cache blocks.'),
        hot: 'Hot Cache Limit' },
    cache: { enabled: 'KV Cache', enabled_hint: 'Keep KV blocks between requests.',
        hot_only: 'Hot Cache Only',
        hot_only_hint: 'Never spill cached KV to SSD.',
        ssd_dir: 'SSD Cache Directory',
        ssd_max: 'SSD Cache Max Size',
        ssd_max_hint: 'Example: 64GB (blank = OS default).',
        hot_max: 'Hot Cache Max Size',
        hot_max_hint: '"0" disables, example: 8GB.',
        gdn_split: 'GDN SSD Split',
        gdn_split_hint: 'Split GDN snapshots to SSD next to the pending limit.' },
    cc: { mode: 'Mode', mode_hint: 'Local routes Claude Code through this server; cloud uses Anthropic directly.',
        local: 'Local', cloud: 'Cloud',
        opus: 'Opus Model', sonnet: 'Sonnet Model', haiku: 'Haiku Model',
        ph: 'Pick or type a model' },
    gen: { max_ctx: 'Max Context Window',
        max_ctx_hint: 'Largest context a request may claim.',
        max_policy: 'Max Context Policy',
        max_policy_hint: 'Override applied to model default (blank = model decides).',
        max_tokens: 'Max Tokens',
        temperature: 'Temperature', temperature_hint: 'Sampling randomness (0 = greedy).',
        top_p: 'Top-P (Nucleus)', top_p_hint: 'Cumulative probability mass kept.',
        top_k: 'Top-K', top_k_hint: '0 disables top-K.',
        rep_pen: 'Repetition Penalty', rep_pen_hint: 'Penalty for reusing recent tokens (1 = off).' },
    mcp: { path: 'MCP Config Path',
        ph: '~/.mcp.json',
        expose: 'Expose MCP Tools',
        expose_hint: 'Serve built-in tools over Model Context Protocol.' },
    usage: { history: 'Usage History',
        history_hint: 'Record per-model token usage for the Usage tab.' },
    net: { http_proxy: 'HTTP Proxy', proxy_hint: 'Example: http://proxy.company.com:8080',
        hf_ep: 'Hugging Face Endpoint',
        hf_ep_hint: 'Mirror or Hub instance used for downloads (blank = huggingface.co).',
        ms_ep: 'ModelScope Endpoint',
        ms_ep_hint: 'ModelScope mirror for downloads (blank = modelscope.cn).',
        https_proxy: 'HTTPS Proxy',
        no_proxy: 'No Proxy', no_proxy_hint: 'Comma-separated hosts to bypass proxy',
        ca_bundle: 'CA Bundle',
        ca_hint: 'Path to PEM file for corporate TLS interception' },
    adv: { distributed: 'Distributed Inference',
        distributed_enabled: 'Enable distributed inference',
        distributed_hint: 'Split layers across multiple machines (experimental).',
        perf: 'Performance', streaming: 'Streaming', uploads: 'Uploads',
        burst: 'Burst Decode',
        burst_hint: 'Speculative decode aggressiveness for burst throughput.',
        burst_opts: [['off','Off'],['light','Light'],['balanced','Balanced'],
                     ['aggressive','Aggressive']],
        sse: 'SSE Keepalive Mode',
        sse_hint: 'How keepalives are emitted on streaming responses.',
        sse_opts: [['chunk','Chunk'],['comment','Comment'],['off','Off']],
        mid_sys: 'Preserve Mid-System Cache',
        mid_sys_hint: 'Keep cached KV for system prompts placed mid-conversation.',
        audio: 'Maximum Audio Upload Size (MB)',
        audio_hint: 'Reject audio attachments above this size.',
        ane: 'ANE Compile Cache',
        ane_hint: 'Cache CoreML compiled graphs on the Neural Engine.',
        wt: 'Hot Cache Write-Through',
        wt_hint: 'Write hot blocks to SSD immediately.',
        blocks: 'Initial Cache Blocks',
        blocks_hint: 'KV blocks allocated at startup.',
        gdn_store: 'GDN Snapshot Storage',
        gdn_store_hint: 'Where Gated-DeltaNet state snapshots go.',
        gdn_store_opts: [['auto','Auto'],['ssd_sidecar','SSD Sidecar'],
                         ['embedded','Embedded']],
        gdn_pend: 'GDN Pending Write Limit',
        gdn_pend_hint: 'Max queued SSD writes before backpressure.',
        gdn_prec: 'GDN Sidecar State Precision',
        gdn_prec_hint: 'Quantisation of sidecar-held recurrent state.',
        gdn_prec_opts: [['fp32','FP32'],['rht_int16','RHT INT16'],['bf16','BF16'],
                        ['int8','INT8'],['rht_int8','RHT INT8']],
        gdn_prec_warning: 'INT8/RHT INT8 state precision may degrade long-context quality.' },
    badge: 'RESTART REQUIRED',
    restart_notice: 'Host and port changes take effect after a restart.',
};

// shadow key -> nested [section, field] map (mirrors GlobalSettingsRequest)
const GS_MAP = {
    host: ['server','host'], port: ['server','port'],
    log_level: ['server','log_level'],
    sse_keepalive_mode: ['server','sse_keepalive_mode'],
    burst_decode_mode: ['server','burst_decode_mode'],
    preserve_mid_system_cache: ['server','preserve_mid_system_cache'],
    distributed_inference_enabled: ['server','distributed_inference_enabled'],
    max_audio_upload_size: ['server','max_audio_upload_size'],
    model_dirs: ['model','model_dirs'], model_fallback: ['model','model_fallback'],
    hide_helper_models: ['model','hide_helper_models'],
    idle_timeout_seconds: ['idle_timeout','idle_timeout_seconds'],
    hf_cache_enabled: ['huggingface','hf_cache_enabled'],
    memory_prefill_memory_guard: ['memory','prefill_memory_guard'],
    memory_guard_tier: ['memory','memory_guard_tier'],
    memory_guard_custom_ceiling_gb: ['memory','memory_guard_custom_ceiling_gb'],
    max_concurrent_requests: ['scheduler','max_concurrent_requests'],
    embedding_batch_size: ['scheduler','embedding_batch_size'],
    chunked_prefill: ['scheduler','chunked_prefill'],
    prefill_priority: ['scheduler','prefill_priority'],
    decode_fairness: ['scheduler','decode_fairness'],
    cache_enabled: ['cache','enabled'],
    ssd_cache_dir: ['cache','ssd_cache_dir'],
    hot_cache_only: ['cache','hot_cache_only'],
    hot_cache_write_through: ['cache','hot_cache_write_through'],
    ane_compile_cache: ['cache','ane_compile_cache'],
    initial_cache_blocks: ['cache','initial_cache_blocks'],
    gdn_snapshot_storage: ['cache','gdn_snapshot_storage'],
    gdn_ssd_pending_max_size: ['cache','gdn_ssd_pending_max_size'],
    gdn_sidecar_precision: ['cache','gdn_sidecar_precision'],
    sampling_max_context_window: ['sampling','max_context_window'],
    sampling_max_context_window_policy: ['sampling','max_context_window_policy'],
    sampling_max_tokens: ['sampling','max_tokens'],
    sampling_temperature: ['sampling','temperature'],
    sampling_top_p: ['sampling','top_p'], sampling_top_k: ['sampling','top_k'],
    sampling_repetition_penalty: ['sampling','repetition_penalty'],
    mcp_config: ['mcp','config_path'], mcp_expose_tools: ['mcp','expose_tools'],
    usage_history: ['usage','usage_history'],
    network_http_proxy: ['network','http_proxy'],
    network_https_proxy: ['network','https_proxy'],
    network_no_proxy: ['network','no_proxy'],
    network_ca_bundle: ['network','ca_bundle'],
    ui_language: ['ui','language'],
    api_key: ['auth','api_key'],
    skip_api_key_verification: ['auth','skip_api_key_verification'],
    // P1A parity with classic GlobalSettingsRequest (79 keys)
    server_aliases: ['server','server_aliases'],
    auto_start_on_launch: ['server','auto_start_on_launch'],
    hf_endpoint: ['huggingface','endpoint'],
    ms_endpoint: ['modelscope','endpoint'],
    ssd_cache_max_size: ['cache','ssd_cache_max_size'],
    hot_cache_max_size: ['cache','hot_cache_max_size'],
    // gdn_ssd_split_enabled is legacy: upstream 400s when sent together with
    // gdn_snapshot_storage (always in the full payload, classic parity), so
    // it is intentionally not mapped or saved.
    claude_code_mode: ['claude_code','mode'],
    claude_code_opus_model: ['claude_code','opus_model'],
    claude_code_sonnet_model: ['claude_code','sonnet_model'],
    claude_code_haiku_model: ['claude_code','haiku_model'],
};
/* Keys the classic saveGlobalSettings() includes in its full payload.
   base_path is launch-time only (read-only row); api_key is sent masked and
   skipped upstream when unchanged — sending the masked value would corrupt it. */
/* ui_dashboard_layout is the CLASSIC dashboard's saved block layout —
   Uplift has its own localStorage layout and must never round-trip or
   clobber the classic one. Omitting it from the payload means "keep"
   (routes.py only applies keys present in model_fields_set). */
const GS_PAYLOAD_SKIP = new Set(['base_path', 'api_key', 'ui_dashboard_layout']);

let GS = null;   // merged working copy (upstream + shadow)
/* Dirty tracking for the deferred-SAVE flow: GS_ORIG is the snapshot at page
   load / last save; gsDirty holds queued-but-unsaved flat->value edits.
   Fields whose change only takes effect after a server restart are flagged
   red (!) and force the sticky SAVE button into RESTART SERVER once the
   queue is saved. Which fields restart: mirrors the classic template's
   restart badges (server host/port/auto-start, max concurrent requests,
   cache enable, MCP config, distributed + CA bundle, proxy endpoints). */
let GS_ORIG = {};
const gsDirty = {};
let gsRestartPending = false;   // queued edits were saved; server restart still owed
const GS_RESTART_FIELDS = new Set([
    'host', 'port', 'auto_start_on_launch', 'max_concurrent_requests',
    'cache_enabled', 'mcp_config', 'distributed_inference_enabled',
    'network_ca_bundle', 'hf_endpoint', 'ms_endpoint']);
function gsQueueSave(flat, val) {           // edit -> queue, no fetch yet
    markFieldDirty(flat, val);
    if (['custom_model_prefixes'].includes(flat)) renderGlobalSettings();
}
function gsOrigFlat(flat) {
    const map = GS_MAP[flat];
    if (map) return (GS_ORIG[map[0]] || {})[map[1]];
    // env tunables: baseline is the uplift-stored value (they never live
    // in GS/GS_ORIG; isEnvFlat + ENV_VALUES are the source of truth).
    // unset normalises to null so clearing an empty row is not dirty.
    if (typeof isEnvFlat === 'function' && isEnvFlat(flat))
        return ENV_VALUES[flat] != null ? ENV_VALUES[flat] : null;
    return GS_ORIG[flat];
}
function gsValFlat(flat) {
    const map = GS_MAP[flat];
    if (map) return gsGet(map[0], map[1]);
    if (typeof isEnvFlat === 'function' && isEnvFlat(flat))
        return ENV_VALUES[flat] !== undefined ? ENV_VALUES[flat] : undefined;
    return GS._shadow ? GS._shadow[flat] : undefined;
}
function gsDisplay(v) {
    if (v === null || v === undefined || v === '') return '(unset)';
    return String(Array.isArray(v) ? v.join(',') : v);
}
/* fields whose values are secrets: diff chips and the CHANGES list say
   CHANGED instead of printing the value (API key stays masked everywhere) */
const SECRET_KEYS = new Set(['api_key', 'cloud_token', 'hf_token']);
function markFieldDirty(flat, val) {
    const orig = gsOrigFlat(flat);
    const cur = val === undefined ? gsValFlat(flat) : val;
    const changed = JSON.stringify(orig) !== JSON.stringify(cur);
    if (changed) gsDirty[flat] = cur;
    else delete gsDirty[flat];               // edited back = no longer queued
    const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
    if (row) {
        row.classList.toggle('dirty', changed);
        row.classList.toggle('restartq', changed && GS_RESTART_FIELDS.has(flat));
        const rd = row.querySelector('.diff-out');
        if (rd) {
            rd.hidden = !changed;
            if (changed && SECRET_KEYS.has(flat)) {
                // masked field (API key): indicate the change, not the value
                rd.classList.add('masked');
                rd.querySelector('.diff-o').textContent = '••• CHANGED';
            } else if (changed) {
                rd.classList.remove('masked');
                rd.querySelector('.diff-o').textContent = gsDisplay(orig);
            }
        }
    }
    gsUpdateSaveBtn();
    gsMarkSections();
    renderDirtyList();
}
function revertField(flat) {                // click on |original| chip
    delete gsDirty[flat];
    renderGlobalSettings();                 // inputs rebuild from the baseline
    renderDirtyList();
}
function gsMarkSections() {
    for (const box of document.querySelectorAll('#gs-body .gs-box')) {
        const rows = [...box.querySelectorAll('[data-flat].dirty')];
        const head = box.querySelector('.gs-box-title');
        if (!head) continue;
        const anyRestart = rows.some(r => r.classList.contains('restartq'));
        head.classList.toggle('sec-dirty', rows.length > 0 && !anyRestart);
        head.classList.toggle('sec-restart', anyRestart);
        let warn = head.querySelector('.rqnow');
        if (!warn) { warn = document.createElement('span'); warn.className = 'rqnow'; head.append(warn); }
        // U8 (user round): amber hot-apply banner for queued-but-hot edits;
        // red restart banner takes precedence
        warn.textContent = anyRestart ? ' RESTART REQUIRED ' : ' ⚡ HOT APPLY ON SAVE ';
        warn.style.display = rows.length ? '' : 'none';
    }
}
function renderDirtyList() {
    const box = document.getElementById('gs-changes');
    if (!box) return;
    const keys = Object.keys(gsDirty);
    box.hidden = !keys.length;
    box.textContent = '';
    if (!keys.length) return;
    const head = document.createElement('div'); head.className = 'ch-head';
    head.textContent = C.tf('uplift.ui.changes', 'CHANGES (') + keys.length + ')';
    box.append(head);
    for (const k of keys) {
        const line = document.createElement('div'); line.className = 'ch-line';
        const secret = SECRET_KEYS.has(k);
        const a = document.createElement('span'); a.textContent = k + ': ' + (secret ? '•••' : gsDisplay(gsOrigFlat(k)));
        const arrow = document.createTextNode(' → ');
        const b2 = document.createElement('span'); b2.textContent = k + ': ' + (secret ? '••• CHANGED' : gsDisplay(gsDirty[k]));
        b2.className = 'ch-new';
        line.append(a, arrow, b2);
        box.append(line);
    }
}
function gsSaveBtn() { return document.getElementById('gs-save'); }
function gsUpdateSaveBtn() {
    const b = gsSaveBtn(); if (!b) return;
    const n = Object.keys(gsDirty).length;
    const restartQ = gsRestartPending ||
        Object.keys(gsDirty).some(k => GS_RESTART_FIELDS.has(k));
    b.classList.toggle('queued', n > 0);
    // the red RESTART state only arms after a save that left a restart owed;
    // while edits are merely queued the button stays amber SAVE (user's flow:
    // click SAVE -> saved -> button becomes RESTART SERVER)
    b.classList.toggle('restart-mode', gsRestartPending);
    b.textContent = n
        ? (restartQ ? '▶ SAVE + RESTART (' + n + ')' : 'SAVE (' + n + ')')
        : (gsRestartPending ? '▶ RESTART SERVER' : 'SAVE');
    b.title = n ? (restartQ
        ? 'Some queued changes need a server restart to take effect. First click saves; the button then becomes RESTART SERVER.'
        : 'Apply ' + n + ' queued change' + (n > 1 ? 's' : ''))
        : 'No queued changes';
}
async function gsCommit() {
    const fields = Object.assign({}, gsDirty);
    // env tunables ride a different endpoint; classic fields keep the
    // full-payload global-settings save (P1A-6 semantics unchanged)
    const envFields = {}, classicFields = {};
    for (const [k, v] of Object.entries(fields))
        (isEnvFlat(k) ? envFields : classicFields)[k] = v;
    let okAll = true;
    if (Object.keys(classicFields).length) okAll = await gsSaveNow(classicFields);
    if (okAll && Object.keys(envFields).length) okAll = await envSave(envFields);
    if (okAll) {
        Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
        // a save that touched restart-requiring fields leaves the server
        // owing a restart: arm the red RESTART SERVER button (user flow)
        if (Object.keys(fields).some(k => GS_RESTART_FIELDS.has(k))) gsRestartPending = true;
    }
    // re-render inputs from the new baseline; keeps still-queued edits shown
    renderGlobalSettings();
    gsUpdateSaveBtn();
    renderDirtyList();
}
async function gsRestartServer() {
    const b = gsSaveBtn(); if (!b) return;
    b.disabled = true;
    try {
        const d = await postJson(`${API}/admin/api/server/restart`, {});
        gsRestartPending = false;   // restart requested; button goes back to SAVE
        toast(d.restarting === false && d.detail
            ? ('restart: ' + d.detail) : 'Restart requested — server respawns in ~5 s');
        $('banner').classList.add('show');
        $('banner-text').textContent = C.tf('uplift.ui.server_restarting_dashboard_reconnecting', 'Server restarting — dashboard reconnecting…');
    } catch (e) { toast(C.t('uplift.toast.restart_failed', {msg: e.message})); }
    b.disabled = false;
    gsUpdateSaveBtn();
}
function gsSaveOrRestart() {                 // one button, two states
    const b = gsSaveBtn(); if (!b) return;
    if (b.classList.contains('restart-mode')) {
        if (Object.keys(gsDirty).length) { gsCommit().then(gsUpdateSaveBtn); return; }
        gsRestartServer();
    } else gsCommit();
}
async function gsSaveNow(fields) {
    // classic saveGlobalSettings(): send the FULL mapped payload built from
    // the working copy (GET response + shadow), not just changed fields —
    // omitted keys would never be written by a live save (P1A-6).
    const body = {};
    for (const flat of Object.keys(GS_MAP)) {
        if (GS_PAYLOAD_SKIP.has(flat)) continue;
        const [sec, field] = GS_MAP[flat];
        const v = gsGet(sec, field);
        if (v !== undefined) body[flat] = v;
    }
    Object.assign(body, GS._shadow || {}, fields);
    // env tunables never belong in the global-settings payload (gsCommit
    // routes them to PUT /env-overrides; strip any residue defensively)
    for (const k of Object.keys(body)) if (isEnvFlat(k)) delete body[k];
    try {
        const r = await fetch(`${API}/admin/api/global-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) { toast(C.t('uplift.toast.save_failed_http', {status: r.status})); return false; }
        GS._shadow = body;
        for (const k of Object.keys(fields)) {
            const map = GS_MAP[k];
            if (map) GS[map[0]][map[1]] = fields[k];
        }
        // saved: the response values become the new baseline
        GS_ORIG = JSON.parse(JSON.stringify(GS));
        if (GS._shadow) GS_ORIG._shadow = body;
        gsSavedAt = Date.now();
        // Language change -> hot-reload our catalog (classic refreshes
        // its Jinja globals on language change; our endpoint re-reads
        // files per request, so just re-fetch + re-apply).
        if ('ui_language' in fields) loadLocale(fields.ui_language);
        $('gs-sub').textContent = GW_LIVE
            ? 'saved ✓'
            : 'saved ✓ (shadow — real oMLX untouched)';
        toast(C.t('uplift.toast.settings_saved_n', {n: Object.keys(fields).length}));
        return true;
    } catch (err) { toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
}

function gsGet(sec, field) {
    const sh = GS._shadow || {};
    const flat = Object.keys(GS_MAP).find(k =>
        GS_MAP[k][0] === sec && GS_MAP[k][1] === field);
    if (flat && flat in sh) return sh[flat];
    const v = (GS[sec] || {})[field];
    return v;
}


function gsBadge() {
    const b = document.createElement('span');
    // unified indicator-chip geometry (.rqchip matches the cockpit lamps:
    // same height/stroke everywhere), never clipped by the label cell
    b.className = 'rqchip';
    const bang = document.createElement('span');
    bang.className = 'rqmark'; bang.textContent = '!';
    b.append(bang, document.createTextNode(' ' + GS_LABELS.badge));
    b.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
    return b;
}

function gsRow(sec, labelTxt, hint, control, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'urow settings';
    if (opts.flat) row.dataset.flat = opts.flat;
    const lab = cell(labelTxt); lab.className = 'uname';
    // The restart warning sits immediately RIGHT OF THE TITLE (user), the
    // description follows after it — previously the chip was appended after
    // the hint and wrapped onto a line below the description.
    if (opts.badge) lab.append(gsBadge());
    else if (opts.flat && GS_RESTART_FIELDS.has(opts.flat)) {
        // permanent red ! on fields whose change needs a server restart
        const m = document.createElement('span');
        m.className = 'rqmark'; m.textContent = '!';
        m.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
        lab.append(m);
    }
    if (hint) {
        const h = document.createElement('small');
        h.className = 'dim'; h.textContent = hint;   // sits beside the name
        lab.append(h);
    }
    // fixed 3-column layout: name+hint | diff slot (reserved, never moves
    // the control) | control — the input keeps its place when it goes dirty
    const slot = document.createElement('span'); slot.className = 'diffslot';
    const rd = document.createElement('span'); rd.className = 'diff-out'; rd.hidden = true;
    const o = document.createElement('span'); o.className = 'diff-o';
    o.title = C.tf('uplift.ui.click_to_revert_to_the_original_value', 'Click to revert to the original value');
    o.onclick = () => { if (opts.flat) revertField(opts.flat); };
    // the new value is the live control itself; slot shows |original| → only
    rd.append(o, document.createTextNode('→'));
    slot.append(rd);
    const ctl = cell(''); ctl.className = 'gctl';
    ctl.append(control);
    row.append(lab, slot, ctl);
    return row;
}

function gsText(sec, field, flat, L, extra) {
    const inp = document.createElement('input');
    inp.type = (extra && extra.type) || 'text';
    if (extra && extra.placeholder) inp.placeholder = extra.placeholder;
    if (extra && extra.list) inp.setAttribute('list', extra.list);
    if (extra && extra.min !== undefined) inp.min = extra.min;
    if (extra && extra.max !== undefined) inp.max = extra.max;
    if (extra && extra.step !== undefined) inp.step = extra.step;
    const v = gsGet(sec, field);
    inp.value = v == null ? '' : v;
    if (extra && extra.range) {
        // R10-1: the old readout span duplicated the value in a second
        // bordered box that looked like another input. The control itself
        // shows the value; a number input gives the native stepper instead.
        inp.type = 'number';
        const queueRange = () => gsQueueSave(flat, inp.value === '' ? null : Number(inp.value));
        inp.oninput = queueRange;
        inp.onchange = queueRange;
        return inp;
    }
    const queue = (ev) => {
        let val = inp.value;
        if (extra && extra.number) val = val === '' ? null : Number(val);
        if (extra && extra.bool) val = inp.checked;
        gsQueueSave(flat, val);
        // conditional-row refresh only on commit (blur/change): a full
        // re-render on every keystroke would steal the input's focus
        if (extra && extra.reload && (!ev || ev.type === 'change')) renderGlobalSettings();
    };
    inp.addEventListener('input', queue);
    inp.addEventListener('change', queue);
    return inp;
}

function gsToggle(flat, on) {
    const t = document.createElement('input');
    t.type = 'checkbox'; t.checked = !!on;
    t.onchange = () => gsQueueSave(flat, t.checked);
    return t;
}

function gsSelect(flat, options, cur) {
    const sel = document.createElement('select');
    for (const [v, t] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; sel.append(o);
    }
    sel.value = cur == null ? '' : String(cur);
    sel.onchange = () => {
        // numeric baseline (e.g. idle_timeout_seconds): keep the payload numeric
        let v = sel.value === '' ? null : sel.value;
        if (v !== null && typeof cur === 'number') v = Number(v);
        gsQueueSave(flat, v);
        renderGlobalSettings();       // refresh conditional rows (x-show parity)
    };
    return sel;
}

function gsTitle(t) {
    const h = document.createElement('div');
    // section titles localize via slug key; English literal is fallback
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.className = 'gs-title'; h.textContent = C.tf('uplift.gs.title.' + slug, t);
    return h;
}

async function pollGlobalSettings() {
    let d;
    try { d = await fetchJson(`${API}/admin/api/global-settings`); }
    catch (err) { emptyMsg($('gs-body'), 'global-settings not served (' + err.message + ')'); return; }
    // never clobber queued edits with a background poll; merge server state
    // under the dirty overrides so inputs stay put until SAVE
    if (Object.keys(gsDirty).length) {
        for (const [flat, val] of Object.entries(gsDirty)) {
            const map = GS_MAP[flat];
            if (map && d[map[0]]) d[map[0]][map[1]] = val;
            if (d._shadow) d._shadow[flat] = val;
        }
    }
    GS = d;   // gateway already overlaid the shadow; resave accumulates
    if (!Object.keys(gsDirty).length) GS_ORIG = JSON.parse(JSON.stringify(d));
    syncClusterGate(d);
    renderGlobalSettings();
}

// Classic shows the Cluster tab only while distributed_inference_active;
// same gate here, refreshed from any global-settings GET (and at boot).
function syncClusterGate(gs) {
    const active = !!(gs && gs.server && gs.server.distributed_inference_active);
    const nav = $('nav-cluster');
    if (nav) nav.hidden = !active;
    if (!active && currentTab() === 'cluster') location.hash = '#status';
}
async function gateClusterFromServer() {
    try { syncClusterGate(await fetchJson(`${API}/admin/api/global-settings`)); }
    catch (_) { /* dormant by default; the settings poll retries */ }
}

// ---------------------------------------------------------------------------
// ENV-2: experimental env tunables — uplift-owned OMLX_* overrides rendered
// as ordinary rows INSIDE the existing settings sections (scheduler/memory ->
// Resource Management, mtp -> Generation Defaults, engine -> Advanced).
// Each row: readable label + EXPERIMENTAL chip, description with [VAR] and
// the honest effect below. Edits queue into the same gsDirty/savebar flow as
// every other setting; gsCommit splits env keys onto PUT /env-overrides and
// the rest onto global-settings. Genuine launch env always wins (shadowed
// rows carry an amber warning; the stored value waits for the launch env to
// change).
// ---------------------------------------------------------------------------

let ENV_SPEC = [];        // allow-list from the server (single source of truth)
let ENV_VALUES = {};      // stored values (server view)
let ENV_SHADOW = {};      // name -> value_masked for genuine launch env

function envByName(flat) {
    return ENV_SPEC.find(a => a.name === flat) || null;
}
function isEnvFlat(flat) {
    return !!envByName(flat);
}

async function pollEnvTunables() {
    try {
        const d = await fetchJson(`${API}/uplift/api/env-overrides`);
        ENV_SPEC = d.allowed || [];
        ENV_VALUES = d.values || {};
        ENV_SHADOW = {};
        for (const s of (d.shadowed || [])) ENV_SHADOW[s.name] = s.value_masked;
        // rows appear once the spec lands, even if settings already rendered
        if (GS) renderGlobalSettings();
    } catch (_) { /* endpoint missing (old server): rows simply absent */ }
}

function envRows(...groups) {
    return ENV_SPEC.filter(a => groups.includes(a.group)).map(envRow);
}

function envRow(a) {
    const label = a.label || a.name;
    let hint = a.desc + ' \u2014 [' + a.name + '] \u00b7 ' +
        (a.effect === 'immediate'
            ? C.tf('uplift.env.applies_next_request', 'applies on next request')
            : a.effect === 'model'
                ? C.tf('uplift.env.restart_model', 'RESTART MODEL to apply')
                : C.tf('uplift.env.restart_server', 'RESTART SERVER to apply'));
    if (a.default) hint += ' \u00b7 ' + C.tf('uplift.env.stock_default', 'stock default') + ': ' + a.default;
    if (a.name in ENV_SHADOW) {
        hint += ' \u26a0 ' + C.tf('uplift.env.shadow_warn',
            'environment variable already set — it takes precedence until removed from the launch environment')
            + ' (' + ENV_SHADOW[a.name] + ')';
    }
    const cur = ENV_VALUES[a.name] != null ? ENV_VALUES[a.name] : '';
    let ctl;
    if (a.type === 'bool') {
        ctl = document.createElement('select');
        for (const [v, t] of [['', '\u2014'], ['1', C.tf('uplift.env.on', 'On')],
                               ['0', C.tf('uplift.env.off', 'Off')]]) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t; ctl.append(o);
        }
        ctl.value = cur;
        ctl.onchange = () => gsQueueSave(a.name, ctl.value === '' ? null : ctl.value);
    } else {
        ctl = document.createElement('input');
        ctl.type = (a.type === 'int' || a.type === 'float') ? 'number' : 'text';
        if (a.min !== undefined) ctl.min = a.min;
        if (a.max !== undefined) ctl.max = a.max;
        if (a.type === 'float') ctl.step = 'any';
        if (a.default) ctl.placeholder = a.default;
        ctl.value = cur;
        const queue = () => gsQueueSave(a.name, ctl.value === '' ? null : ctl.value);
        ctl.addEventListener('input', queue);
        ctl.addEventListener('change', queue);
    }
    const row = gsRow('env', label, hint, ctl, { flat: a.name });
    // EXPERIMENTAL signage right of the label, same slot as the restart chip
    const lab = row.querySelector('.uname');
    const chip = document.createElement('span');
    chip.className = 'rqchip env-badge';
    chip.textContent = C.tf('uplift.env.badge', 'EXPERIMENTAL');
    chip.title = C.tf('uplift.env.badge_hint',
        'Uplift-owned environment override; not part of oMLX settings');
    lab.insertBefore(chip, lab.querySelector('small'));
    if (a.name in ENV_SHADOW) row.classList.add('env-shadowed');
    return row;
}

async function envSave(fields) {
    try {
        const r = await fetchJson(`${API}/uplift/api/env-overrides`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fields) });
        for (const [name, outcome] of Object.entries(r.results || {})) {
            if (outcome === 'applied_live')
                toast(C.tf('uplift.env.applied_live', 'Applied on next request') + ': ' + name, 3000);
            else if (outcome === 'restart_model')
                toast(C.tf('uplift.env.stored_restart_model', 'Saved — RESTART MODEL to apply') + ': ' + name, 4000);
            else if (outcome === 'restart_server')
                toast(C.tf('uplift.env.stored_restart_server', 'Saved — RESTART SERVER to apply') + ': ' + name, 4000);
            else if (outcome === 'shadowed')
                toast(C.tf('uplift.env.shadowed_saved', 'Saved for later — the launch environment variable takes precedence') + ': ' + name, 5000);
        }
        // server-effect vars leave the restart owed: arm the same
        // RESTART SERVER button the classic fields use
        if (Object.values(r.results || {}).includes('restart_server'))
            gsRestartPending = true;
        ENV_VALUES = r.values || {};
        ENV_SHADOW = {};
        for (const s of (r.shadowed || [])) ENV_SHADOW[s.name] = s.value_masked;
        return true;
    } catch (err) {
        toast('env tunables: ' + err.message, 5000);
        return false;
    }
}



function renderGlobalSettings() {
    const body = document.createElement('div');   // staged; grouped into boxes below
    body.textContent = '';
    const L = GS_LABELS;

    // (the old "Global" restart-notice box was removed; the RESTART chip,
    //  red field marks and the RESTART SERVER button carry that meaning now)

    // ---- Language
    body.append(gsTitle('Language'));
    body.append(gsRow('ui', C.tf('uplift.gs.ui.interface_language', 'Interface language'), '',
        gsSelect('ui_language', Object.entries(L.lang), gsGet('ui','language')),
        { flat: 'ui_language' }));

    // ---- Claude Code (classic renders this on Status; Uplift keeps it with settings)
    body.append(gsTitle('Claude Code'));
    const ccLocal = (gsGet('claude_code','mode') || 'local') !== 'cloud';
    body.append(gsRow('claude_code', L.cc.mode, L.cc.mode_hint,
        gsSelect('claude_code_mode', [['local', L.cc.local], ['cloud', L.cc.cloud]],
                 ccLocal ? 'local' : 'cloud'), { flat: 'claude_code_mode' }));
    if (ccLocal) {
        const dl = document.createElement('datalist'); dl.id = 'cc-models';
        body.append(dl);
        fetchJson(`${API}/admin/api/models`).then(d => {
            for (const m of d.models || []) {
                const o2 = document.createElement('option');
                o2.value = m.name || m.id || ''; dl.append(o2);
            }
        }).catch(() => { /* picker list optional */ });
        body.append(gsRow('claude_code', L.cc.opus, '',
            gsText('claude_code','opus_model','claude_code_opus_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_opus_model' }));
        body.append(gsRow('claude_code', L.cc.sonnet, '',
            gsText('claude_code','sonnet_model','claude_code_sonnet_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_sonnet_model' }));
        body.append(gsRow('claude_code', L.cc.haiku, '',
            gsText('claude_code','haiku_model','claude_code_haiku_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_haiku_model' }));
    }

    // ---- Auth
    body.append(gsTitle('Auth'));
    body.append(gsRow('auth', L.auth.api_key, L.auth.api_key_hint,
        gsText('auth','api_key','api_key', L, { type: 'password',
            placeholder: L.auth.api_key_placeholder, reload: true }),
        { flat: 'api_key' }));
    const bpIn = document.createElement('input');
    bpIn.type = 'text'; bpIn.value = GS.base_path || '';
    bpIn.disabled = true;
    bpIn.title = C.tf('uplift.ui.set_at_launch_base_path_read_only', 'Set at launch (--base-path); read-only');
    body.append(gsRow('auth', L.auth.base_path, L.auth.base_path_hint, bpIn));
    body.append(gsRow('auth', L.auth.skip, L.auth.skip_hint + ' ' + L.auth.skip_warning,
        gsToggle('skip_api_key_verification', gsGet('auth','skip_api_key_verification')),
        { flat: 'skip_api_key_verification' }));

    // ---- Server
    body.append(gsTitle('Server'));
    body.append(gsRow('server', L.server.host, '',
        gsText('server','host','host', L, { placeholder: L.server.host_placeholder }),
        { badge: true, flat: 'host' }));
    body.append(gsRow('server', L.server.port, '',
        gsText('server','port','port', L, { number: true }), { badge: true, flat: 'port' }));
    body.append(gsRow('server', L.server.log_level, '',
        gsSelect('log_level', L.server.levels, gsGet('server','log_level')),
        { flat: 'log_level' }));
    body.append(gsRow('server', L.server.auto_start, L.server.auto_start_hint,
        gsToggle('auto_start_on_launch', gsGet('server','auto_start_on_launch')),
        { badge: true, flat: 'auto_start_on_launch' }));
    // server_aliases: one alias per line (classic editor keeps a list; same payload)
    const aliasInp = document.createElement('textarea');
    aliasInp.rows = 2; aliasInp.spellcheck = false;
    aliasInp.value = (gsGet('server','server_aliases') || []).join('\n');
    aliasInp.onchange = () => gsQueueSave('server_aliases',
        aliasInp.value.split('\n').map(s => s.trim()).filter(Boolean));
    body.append(gsRow('server', L.server.aliases, L.server.aliases_hint, aliasInp,
        { flat: 'server_aliases' }));

    // ---- Model
    body.append(gsTitle('Model'));
    const dirs = gsGet('model','model_dirs') || [];
    const dl = document.createElement('div');
    dl.className = 'gs-dirs';
    dirs.forEach((d, i) => {
        const one = document.createElement('div');
        one.className = 'gs-dir';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = d;
        inp.placeholder = i === 0 ? L.model.ph_primary : L.model.ph_additional;
        const rm = document.createElement('button');
        rm.className = 'se-btn act'; rm.textContent = '×';
        rm.style.display = dirs.length > 1 ? '' : 'none';
        rm.onclick = async () => {
            const nd = dirs.filter((_, j) => j !== i);
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        inp.onchange = async () => {
            const nd = dirs.slice(); nd[i] = inp.value;
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        one.append(inp, rm);
        dl.append(one);
    });
    const add = document.createElement('button');
    add.className = 'se-btn act'; add.textContent = C.tf('uplift.gs.model.add_directory', '+ add directory');
    add.onclick = async () => {
        if (await gsSaveNow({ model_dirs: dirs.concat('') })) renderGlobalSettings();
    };
    dl.append(add);
    body.append(gsRow('model', L.model.dirs, '', dl));
    body.append(gsRow('model', L.model.fallback, L.model.fallback_desc,
        gsText('model','model_fallback','model_fallback', L),
        { flat: 'model_fallback' }));
    body.append(gsRow('model', L.model.hide_helper, L.model.hide_helper_desc,
        gsToggle('hide_helper_models', gsGet('model','hide_helper_models')),
        { flat: 'hide_helper_models' }));
    body.append(gsRow('model', L.model.hf_cache, L.model.hf_cache_desc,
        gsToggle('hf_cache_enabled', gsGet('huggingface','hf_cache_enabled')),
        { flat: 'hf_cache_enabled' }));
    const hfp = cell((GS.huggingface || {}).hf_cache_path || '—');
    hfp.className = 'dim';
    body.append(gsRow('model', C.tf('uplift.gs.model.hf_path_label', 'HF cache path'), '', hfp));
    body.append(gsRow('model', L.model.idle, L.model.idle_desc,
        gsSelect('idle_timeout_seconds', L.model.idle_opts,
                 gsGet('idle_timeout','idle_timeout_seconds') ?? ''),
        { flat: 'idle_timeout_seconds' }));

    // ---- Generation Defaults
    body.append(gsTitle('Generation Defaults'));
    const temp = gsText('sampling','temperature','sampling_temperature', L,
        { range: true, min: 0, max: 2, step: 0.1 });
    body.append(gsRow('gen', L.gen.temperature, L.gen.temperature_hint, temp,
        { flat: 'sampling_temperature' }));
    const topp = gsText('sampling','top_p','sampling_top_p', L,
        { range: true, min: 0, max: 1, step: 0.05 });
    body.append(gsRow('gen', L.gen.top_p, L.gen.top_p_hint, topp,
        { flat: 'sampling_top_p' }));
    body.append(gsRow('gen', L.gen.top_k, L.gen.top_k_hint,
        gsText('sampling','top_k','sampling_top_k', L, { number: true, min: 0 }),
        { flat: 'sampling_top_k' }));
    body.append(gsRow('gen', L.gen.max_tokens, '',
        gsText('sampling','max_tokens','sampling_max_tokens', L,
               { number: true, min: 1, max: 131072 }),
        { flat: 'sampling_max_tokens' }));
    body.append(gsRow('gen', L.gen.max_ctx, L.gen.max_ctx_hint,
        gsText('sampling','max_context_window','sampling_max_context_window', L,
               { number: true, min: 1, max: 2097152 }),
        { flat: 'sampling_max_context_window' }));
    body.append(gsRow('gen', L.gen.max_policy, L.gen.max_policy_hint,
        gsText('sampling','max_context_window_policy',
               'sampling_max_context_window_policy', L,
               { number: true, min: 1, max: 2097152, placeholder: 'None' }),
        { flat: 'sampling_max_context_window_policy' }));
    body.append(gsRow('gen', L.gen.rep_pen, L.gen.rep_pen_hint,
        gsText('sampling','repetition_penalty','sampling_repetition_penalty', L,
               { number: true, min: 1, step: 0.05 }),
        { flat: 'sampling_repetition_penalty' }));
    // ENV-2: MTP experimental tunables join their semantic group
    for (const r of envRows('mtp')) body.append(r);

    // ---- Resource Management
    body.append(gsTitle('Resource Management'));
    body.append(gsRow('res', L.res.max_conc, L.res.max_conc_hint,
        gsText('scheduler','max_concurrent_requests','max_concurrent_requests', L,
               { number: true, min: 1 }),
        // U7: it is in GS_RESTART_FIELDS (the scheduler pool size is read at
        // boot) but only showed a bare "!" — the server routes say so too.
        // Full badge with text, same as host/port.
        { flat: 'max_concurrent_requests', badge: true }));
    body.append(gsRow('res', L.res.batch, L.res.batch_hint,
        gsText('scheduler','embedding_batch_size','embedding_batch_size', L,
               { number: true, min: 1 }),
        { flat: 'embedding_batch_size' }));
    body.append(gsRow('res', L.res.chunked, L.res.chunked_desc,
        gsToggle('chunked_prefill', gsGet('scheduler','chunked_prefill')),
        { flat: 'chunked_prefill' }));
    body.append(gsRow('res', L.res.prio, '',
        gsSelect('prefill_priority', [['speed', L.res.prio_speed],
                                      ['context', L.res.prio_context]],
                 gsGet('scheduler','prefill_priority')),
        { flat: 'prefill_priority' }));
    body.append(gsRow('res', L.res.fairness, L.res.fairness_desc,
        gsToggle('decode_fairness', gsGet('scheduler','decode_fairness')),
        { flat: 'decode_fairness' }));
    body.append(gsRow('res', L.res.guard, L.res.guard_desc,
        gsToggle('memory_prefill_memory_guard', gsGet('memory','prefill_memory_guard')),
        { flat: 'memory_prefill_memory_guard' }));
    const tierSel = gsSelect('memory_guard_tier', L.res.tiers,
                             gsGet('memory','memory_guard_tier'));
    body.append(gsRow('res', L.res.tier, '', tierSel, { flat: 'memory_guard_tier' }));
    if (gsGet('memory','memory_guard_tier') === 'custom') {
        body.append(gsRow('res', L.res.custom, '',
            gsText('memory','memory_guard_custom_ceiling_gb',
                   'memory_guard_custom_ceiling_gb', L,
                   { number: true, min: 1, step: 1, placeholder: L.res.custom_ph }),
            { flat: 'memory_guard_custom_ceiling_gb' }));
    }
    // ENV-2: scheduler/memory experimental tunables join their semantic group
    for (const r of envRows('scheduler', 'memory')) body.append(r);

    // ---- Cache
    body.append(gsTitle('Cache'));
    body.append(gsRow('cache', L.cache.enabled, L.cache.enabled_hint,
        gsToggle('cache_enabled', gsGet('cache','enabled')),
        { flat: 'cache_enabled', badge: true }));
    body.append(gsRow('cache', L.cache.hot_only, L.cache.hot_only_hint,
        gsToggle('hot_cache_only', gsGet('cache','hot_cache_only')),
        { flat: 'hot_cache_only' }));
    body.append(gsRow('cache', L.cache.ssd_dir, '',
        gsText('cache','ssd_cache_dir','ssd_cache_dir', L),
        { flat: 'ssd_cache_dir' }));
    body.append(gsRow('cache', L.cache.ssd_max, L.cache.ssd_max_hint,
        gsText('cache','ssd_cache_max_size','ssd_cache_max_size', L,
               { placeholder: '64GB' }),
        { flat: 'ssd_cache_max_size' }));
    body.append(gsRow('cache', L.cache.hot_max, L.cache.hot_max_hint,
        gsText('cache','hot_cache_max_size','hot_cache_max_size', L,
               { placeholder: '8GB' }),
        { flat: 'hot_cache_max_size' }));

    // ---- MCP
    body.append(gsTitle('MCP'));
    body.append(gsRow('mcp', L.mcp.path, '',
        gsText('mcp','config_path','mcp_config', L, { placeholder: L.mcp.ph }),
        { badge: true, flat: 'mcp_config' }));
    body.append(gsRow('mcp', L.mcp.expose, L.mcp.expose_hint,
        gsToggle('mcp_expose_tools', gsGet('mcp','expose_tools')),
        { flat: 'mcp_expose_tools' }));

    // ---- Usage & Network
    body.append(gsTitle('Usage & Network'));
    body.append(gsRow('usage', L.usage.history, L.usage.history_hint,
        gsToggle('usage_history', gsGet('usage','usage_history')),
        { flat: 'usage_history' }));
    body.append(gsRow('net', L.net.hf_ep, L.net.hf_ep_hint,
        gsText('huggingface','endpoint','hf_endpoint', L,
               { placeholder: 'https://huggingface.co' }),
        { flat: 'hf_endpoint', badge: true }));
    body.append(gsRow('net', L.net.ms_ep, L.net.ms_ep_hint,
        gsText('modelscope','endpoint','ms_endpoint', L,
               { placeholder: 'https://www.modelscope.cn' }),
        { flat: 'ms_endpoint', badge: true }));
    body.append(gsRow('net', L.net.http_proxy, L.net.proxy_hint,
        gsText('network','http_proxy','network_http_proxy', L),
        { flat: 'network_http_proxy' }));
    body.append(gsRow('net', L.net.https_proxy, L.net.proxy_hint,
        gsText('network','https_proxy','network_https_proxy', L),
        { flat: 'network_https_proxy' }));
    body.append(gsRow('net', L.net.no_proxy, L.net.no_proxy_hint,
        gsText('network','no_proxy','network_no_proxy', L),
        { flat: 'network_no_proxy' }));
    body.append(gsRow('net', L.net.ca_bundle, L.net.ca_hint,
        gsText('network','ca_bundle','network_ca_bundle', L),
        { flat: 'network_ca_bundle', badge: true }));

    // ---- Advanced
    body.append(gsTitle('Advanced'));
    body.append(gsRow('adv', L.adv.distributed_enabled, L.adv.distributed_hint,
        gsToggle('distributed_inference_enabled',
                 gsGet('server','distributed_inference_enabled')),
        { flat: 'distributed_inference_enabled', badge: true }));
    body.append(gsRow('adv', L.adv.burst, L.adv.burst_hint,
        gsSelect('burst_decode_mode', L.adv.burst_opts,
                 gsGet('server','burst_decode_mode')),
        { flat: 'burst_decode_mode' }));
    body.append(gsRow('adv', L.adv.sse, L.adv.sse_hint,
        gsSelect('sse_keepalive_mode', L.adv.sse_opts,
                 gsGet('server','sse_keepalive_mode')),
        { flat: 'sse_keepalive_mode' }));
    body.append(gsRow('adv', L.adv.mid_sys, L.adv.mid_sys_hint,
        gsToggle('preserve_mid_system_cache', gsGet('server','preserve_mid_system_cache')),
        { flat: 'preserve_mid_system_cache' }));
    body.append(gsRow('adv', L.adv.audio, L.adv.audio_hint,
        gsText('server','max_audio_upload_size','max_audio_upload_size', L,
               { number: true, min: 1 }),
        { flat: 'max_audio_upload_size' }));
    body.append(gsRow('adv', L.adv.ane, L.adv.ane_hint,
        gsToggle('ane_compile_cache', gsGet('cache','ane_compile_cache')),
        { flat: 'ane_compile_cache' }));
    body.append(gsRow('adv', L.adv.wt, L.adv.wt_hint,
        gsToggle('hot_cache_write_through', gsGet('cache','hot_cache_write_through')),
        { flat: 'hot_cache_write_through' }));
    body.append(gsRow('adv', L.adv.blocks, L.adv.blocks_hint,
        gsText('cache','initial_cache_blocks','initial_cache_blocks', L,
               { number: true, min: 1 }),
        { flat: 'initial_cache_blocks' }));
    const gsel = gsSelect('gdn_snapshot_storage', L.adv.gdn_store_opts,
                          gsGet('cache','gdn_snapshot_storage'));
    body.append(gsRow('adv', L.adv.gdn_store, L.adv.gdn_store_hint, gsel,
        { flat: 'gdn_snapshot_storage' }));
    if (gsGet('cache','gdn_snapshot_storage') === 'ssd_sidecar') {
        body.append(gsRow('adv', L.adv.gdn_pend, L.adv.gdn_pend_hint,
            gsText('cache','gdn_ssd_pending_max_size','gdn_ssd_pending_max_size', L,
                   { placeholder: '512MB' }),
            { flat: 'gdn_ssd_pending_max_size' }));
        const prow = gsRow('adv', L.adv.gdn_prec, L.adv.gdn_prec_hint,
            gsSelect('gdn_sidecar_precision', L.adv.gdn_prec_opts,
                     gsGet('cache','gdn_sidecar_precision')),
            { flat: 'gdn_sidecar_precision' });
        if (['int8','rht_int8'].includes(gsGet('cache','gdn_sidecar_precision'))) {
            const w = document.createElement('small');
            w.className = 'fhint warn'; w.textContent = L.adv.gdn_prec_warning;
            prow.querySelector('.uname').append(w);
        }
        body.append(prow);
    }
    // ENV-2: engine experimental tunables join Advanced (burst / batching)
    for (const r of envRows('engine')) body.append(r);

    // group staged children into bordered section boxes; each gs-title
    // starts a new box. U5 fix (user round): the old CSS multicol
    // (column-width masonry) tore tall boxes apart — the fragment landed at
    // the top of the next column and pushed its boxes down (staggered column
    // tops that looked like a leftover banner). Boxes are now distributed by
    // JS into equal flex columns: balanced fill order is preserved (same
    // reading flow as column-fill:balance) but every column starts flush and
    // a box is never split.
    const wrap = $('gs-body');
    const wasDirty = Object.assign({}, gsDirty);
    wrap.textContent = '';
    wrap.classList.add('gs-wrap');
    const items = [];   // gs-boxes (and stray nodes) in document order
    let box = null, bbody = null, ord = 0;
    for (const n of Array.from(body.childNodes)) {
        if (n.nodeType === 1 && n.classList.contains('gs-title')) {
            box = document.createElement('div');
            box.className = 'gs-box';
            box.dataset.ord = ord++;   // stable order for resize re-layout
            const h = document.createElement('div');
            h.className = 'gs-box-title';
            h.textContent = n.textContent;
            bbody = document.createElement('div');
            bbody.className = 'gs-box-body';
            box.append(h, bbody);
            items.push(box);
        } else if (bbody) {
            bbody.append(n);
        } else {
            items.push(n);
        }
    }
    // column layout: JS-distributed flex columns (U5 fix — see above).
    gsLayoutColumns(items);
    // section header click scrolls to the SAVE bar (item 10); header also
    // carries the section dirty/restart state color (item 8)
    for (const h of wrap.querySelectorAll('.gs-box-title')) {
        h.classList.add('clickable');
        h.onclick = () => {
            const bar = document.getElementById('gs-savebar');
            if (bar) { bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                       const b = gsSaveBtn(); if (b) b.focus(); }
        };
    }
    // persistent SAVE / RESTART SERVER bar below the form (item 9/10)
    let bar = document.getElementById('gs-savebar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gs-savebar';
        bar.className = 'savebar';
        const changes = document.createElement('div');
        changes.id = 'gs-changes'; changes.className = 'changelist'; changes.hidden = true;
        const rowb = document.createElement('div'); rowb.className = 'savebar-row';
        const b = document.createElement('button');
        b.id = 'gs-save'; b.className = 'se-btn savebtn'; b.textContent = 'SAVE';
        b.onclick = gsSaveOrRestart;
        const clr = document.createElement('button');
        clr.id = 'gs-discard'; clr.className = 'se-btn'; clr.textContent = 'DISCARD';
        clr.onclick = () => {
            Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
            renderGlobalSettings(); gsUpdateSaveBtn(); renderDirtyList();
        };
        rowb.append(clr, b);
        bar.append(changes, rowb);
        wrap.parentElement.append(bar);
    }
    // re-apply still-queued dirty marks after re-render
    for (const flat of Object.keys(wasDirty)) {
        markFieldDirty(flat, wasDirty[flat]);
        // re-render rebuilds inputs from the server baseline; put the
        // queued (unsaved) value back so the edit stays visible while typing
        const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
        const ctl = row && (row.querySelector('input[type=checkbox]') || row.querySelector('select') || row.querySelector('input'));
        if (ctl) {
            if (ctl.type === 'checkbox') ctl.checked = !!wasDirty[flat];
            else ctl.value = wasDirty[flat] == null ? '' : wasDirty[flat];
        }
    }
    gsMarkSections();
    gsUpdateSaveBtn();
    renderDirtyList();
    const clrB = document.getElementById('gs-discard');
    if (clrB) clrB.style.display = Object.keys(gsDirty).length ? '' : 'none';
}

function gsLayoutColumns(forced) {
    // U5 fix: distribute section boxes into equal-width flex columns.
    // Balanced sequential fill reproduces the old column-fill:balance reading
    // order, but boxes never split and every column top is flush.
    const wrap = document.getElementById('gs-body');
    if (!wrap) return;
    let items = (forced && forced.length) ? forced.slice()
        : [...wrap.querySelectorAll('.gs-box')].sort((a, b) => (a.dataset.ord | 0) - (b.dataset.ord | 0));
    if (!items.length) return;
    // alternate box shading by GLOBAL index (nth-of-type restarts per column)
    items.forEach((it, i) => it.classList.toggle('alt', i % 2 === 1));
    for (const c of wrap.querySelectorAll('.gs-col')) c.remove();
    const gap = 14, cw = 380;
    const avail = wrap.clientWidth || (document.documentElement.clientWidth - 48);
    let nCols = Math.max(1, Math.floor((avail + gap) / (cw + gap)));
    nCols = Math.min(nCols, items.length);
    const colW = Math.floor((Math.min(avail, 1500) - gap * (nCols - 1)) / nCols);
    const cols = [];
    for (let i = 0; i < nCols; i++) {
        const d = document.createElement('div');
        d.className = 'gs-col'; d.style.width = colW + 'px';
        cols.push(d);
    }
    wrap.append(...cols);
    // measure pass: all boxes in col 0 — every column has the same width so
    // heights measured here are the heights they'll have in their final column
    for (const it of items) cols[0].append(it);
    const hs = items.map(it => it.offsetHeight + gap);
    const target = hs.reduce((a, b) => a + b, 0) / nCols;
    let ci = 0, acc = 0;
    for (let i = 0; i < items.length; i++) {
        cols[ci].append(items[i]);
        acc += hs[i];
        if (acc >= target && ci < nCols - 1 && i < items.length - (nCols - 1 - ci)) { ci++; acc = 0; }
    }
    if (!window.__gsResizeHooked) {
        window.__gsResizeHooked = true;
        let t = 0;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                if (document.querySelector('#gs-body.gs-wrap .gs-col')) gsLayoutColumns();
            }, 150);
        });
    }
}

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.status + ' ' + r.statusText);
    return d;
}
function taskRow(t) {
    const row = document.createElement('div'); row.className = 'urow usage';
    const st = (t.status || 'unknown').toUpperCase();
    // progress arrives as 0..100 already (hf/ms/oq task dicts) — classic does
    // Math.round(task.progress); the old x100 here showed "2280%"
    const pct = Math.round(t.progress || 0);
    const activeSt = ['downloading', 'quantizing', 'uploading'].includes((t.status || '').toLowerCase());
    // size column: downloaded/total while running (classic parity), final size when done
    const total = t.total_size || t.size || t.output_size || 0;
    const done = t.downloaded_size != null ? t.downloaded_size : (t.size || t.output_size || 0);
    const sizeTxt = activeSt && total
        ? `${C.fmtBytes(done)} / ${C.fmtBytes(total)}`
        : (t.size_formatted || C.fmtBytes(total));
    row.append(cell(t.name || t.model_name || t.repo_id || t.model || t.model_path || '—'),
               cell(t.dest || t.target_repo || ''),
               cell(st + (activeSt ? ` ${Math.min(pct, 100)}%` : '')),
               cell(t.error || sizeTxt));
    return row;
}
function renderTasks(hostId, kind) {
    fetchJson(`${API}/admin/api/${kind}/tasks`).then(d => {
        const host = $(hostId);
        host.innerHTML = '';
        const tasks = d.tasks || [];
        if (!tasks.length) { host.innerHTML = '<div class="empty">No tasks</div>'; return; }
        let active = false;
        for (const t of tasks) {
            const r = taskRow(t);
            // API field is task_id (older mock data used id) — a wrong value
            // here POSTed /cancel/undefined and the control silently failed
            const tid = t.task_id || t.id;
            // controls render as real buttons in the house action column so
            // they align right with the other row actions (they used to be
            // bare spans wrapping onto a stray grid track at bottom-left)
            const acts = document.createElement('span'); acts.className = 'rowacts';
            const mkAct = (label, title, fn) => {
                const x = document.createElement('button');
                x.className = 'se-btn act'; x.textContent = label; x.title = title;
                x.onclick = fn; acts.append(x);
            };
            if (['downloading', 'quantizing', 'uploading', 'queued', 'pending'].includes(t.status)) {
                active = true;
                mkAct('CANCEL', 'Stop this task', () => postJson(`${API}/admin/api/${kind}/cancel/${tid}`, {})
                    .then(() => renderTasks(hostId, kind)).catch(e => toast('cancel: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            } else if (kind === 'hf' && ['failed', 'cancelled', 'canceled', 'error'].includes((t.status || '').toLowerCase())) {
                // U11 parity: classic offers retry (resumes partial files)
                mkAct('RETRY', 'Resume this download from existing files', () =>
                    postJson(`${API}/admin/api/hf/retry/${tid}`,
                        { hf_token: ($('dl-token') ? $('dl-token').value.trim() : '') })
                        .then(() => renderTasks(hostId, kind)).catch(e => toast('retry: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            }
            host.append(r);
        }
        if (active) {   // gentle live progress while an entry is still running
            setTimeout(() => {
                const card = host.closest('section');
                if (card && card.style.display !== 'none' && !document.hidden)
                    renderTasks(hostId, kind);
            }, 2000);
        }
    }).catch(e => emptyMsg($(hostId), e.message));
}

let dlInit = false;
const DL = {
    tab: 'trending',                 // trending | popular | search
    rec: { trending: null, popular: null },   // cached suggested lists
    search: [],
    page: { trending: 1, popular: 1, search: 1 },
    size: 10,
    sort: { key: 'rank', dir: 1 },   // client column sort (classic parity)
    q: '',
    busy: false,
};
function dlPageSize() {
    // classic parity: fit ~10..30 rows in the available window height
    const h = window.innerHeight || 800;
    return Math.max(10, Math.min(30, Math.floor((h - 320) / 34 / 10) * 10 || 10));
}
function dlSortModels(list, key, dir, fallbackKey) {
    const rows = list.slice();
    if (key === 'rank' || !key) {
        if (fallbackKey) rows.sort((a, b) => (b[fallbackKey] || 0) - (a[fallbackKey] || 0));
        return rows;
    }
    rows.sort((a, b) => {
        let x = a[key], y = b[key];
        if (key === 'name') { x = (x || '').toLowerCase(); y = (y || '').toLowerCase();
            return dir * (x < y ? -1 : x > y ? 1 : 0); }
        if (key === 'size') { x = a.size || 0; y = b.size || 0; }
        if (key === 'params') { x = a.params || 0; y = b.params || 0; }
        if (x == null) x = -Infinity; if (y == null) y = -Infinity;
        return dir * (x - y);
    });
    return rows;
}
function initDownloader() {
    const $dl = id => document.getElementById(id);
    const token = () => ($dl('dl-token') || {}).value?.trim() || '';
    const queueDownload = (repoId, fromBtn) => {
        if (!repoId) { toast(C.t('uplift.toast.repo_id_required')); return; }
        if (fromBtn) { fromBtn.disabled = true; fromBtn.textContent = 'queued…'; }
        postJson(`${API}/admin/api/hf/download`,
            { repo_id: repoId, hf_token: token() }).then(r => {
                // live: {success, task:{task_id}} · shadow: {task_id}
                const tid = (r.task && r.task.task_id) || r.task_id || r.id || '';
                toast(C.t('uplift.toast.download_queued', {repo: repoId}) + (tid ? ` #${String(tid).slice(0, 8)}` : ''));
                renderTasks('dl-tasks', 'hf');
            }).catch(e => { toast('download: ' + e.message);
                if (fromBtn) { fromBtn.disabled = false; fromBtn.textContent = 'download'; } });
    };
    function setTab(tab) {
        DL.tab = tab;
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t); if (b) b.classList.toggle('on', t === tab);
        }
        DL.page[tab] = DL.page[tab] || 1;
        if (tab === 'search' && !DL.search.length && DL.q) doSearch();
        renderDlPage();
    }
    function renderDlPage() {
        const host = $dl('dl-results'); if (!host) return;
        const sub = $dl('dl-sub');
        host.innerHTML = '';
        const list = DL.tab === 'search' ? DL.search : DL.rec[DL.tab];
        if (list == null) { host.innerHTML = '<div class="empty">Loading suggestions…</div>'; return; }
        if (!list.length) {
            host.innerHTML = '<div class="empty">' + (DL.tab === 'search' ? 'No results — try another query.' : 'HF suggested models unavailable.') + '</div>';
            const pg = $dl('dl-pager'); if (pg) pg.innerHTML = '';
            return;
        }
        const fallback = DL.tab === 'popular' ? 'downloads' : 'trending_score';
        const rows = dlSortModels(list, DL.sort.key, DL.sort.dir, DL.tab === 'search' ? null : fallback);
        DL.size = dlPageSize();
        const pages = Math.max(1, Math.ceil(rows.length / DL.size));
        if (DL.page[DL.tab] > pages) DL.page[DL.tab] = pages;
        const start = (DL.page[DL.tab] - 1) * DL.size;
        // header (sortable, classic parity)
        const cols = [['rank', '#'], ['name', 'Model'], ['params', 'Params'],
                      ['size', 'Size'], ['downloads', 'Downloads'], ['likes', 'Likes'], [null, '']];
        const head = document.createElement('div'); head.className = 'urow usage head';
        for (const [key, label] of cols) {
            const s = cell(label + (DL.sort.key === key && key ? (DL.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
            if (key) { s.className = 'sortable' + (DL.sort.key === key ? ' sorted' : '');
                s.onclick = () => {
                    if (DL.sort.key === key) DL.sort.dir = -DL.sort.dir;
                    else { DL.sort.key = key; DL.sort.dir = (key === 'name' || key === 'rank') ? 1 : -1; }
                    renderDlPage();
                };
            }
            head.append(s);
        }
        host.append(head);
        for (const m of rows.slice(start, start + DL.size)) {
            const row = document.createElement('div'); row.className = 'urow usage';
            const rank = cell(m.rank ? '#' + m.rank : '');
            const name = cell(m.name || m.repo_id); name.className = 'uname';
            name.title = m.repo_id;
            row.append(rank, name,
                cell(m.params_formatted || (m.params ? C.fmtNumber(m.params) : '')),
                cell(m.size_formatted || C.fmtBytes(m.size || 0)),
                cell(m.downloads != null ? C.fmtNumber(m.downloads) : ''),
                cell(m.likes != null ? C.fmtNumber(m.likes) : ''));
            const act = document.createElement('span'); act.className = 'rowacts';
            const b = document.createElement('button');
            b.className = 'se-btn act'; b.textContent = 'download';
            b.onclick = () => queueDownload(m.repo_id, b);
            act.append(b); row.append(act);
            host.append(row);
        }
        if (sub) {
            const extra = DL.tab === 'search' ? `“${DL.q}”` : (DL.rec.trending && true ? 'suggested by HF' : '');
            const inv = (DL._invalid || DL.rec._invalid) ? ' · HF token rejected — listed anonymously' : '';
            sub.textContent = `${rows.length} results ${extra}${inv}`;
        }
        // pager
        const pg = $dl('dl-pager'); if (!pg) return;
        pg.innerHTML = '';
        if (pages <= 1) return;
        const mk = (label, page, dis) => {
            const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis;
            b.onclick = () => { DL.page[DL.tab] = page; renderDlPage();
                $dl('dl-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
            pg.append(b);
        };
        mk('«', 1, DL.page[DL.tab] === 1);
        mk('‹', DL.page[DL.tab] - 1, DL.page[DL.tab] === 1);
        mk('›', DL.page[DL.tab] + 1, DL.page[DL.tab] === pages);
        mk('»', pages, DL.page[DL.tab] === pages);
        const info = document.createElement('span'); info.className = 'pinfo';
        info.textContent = `${DL.page[DL.tab]} / ${pages} · ${rows.length} models`;
        pg.append(info);
    }
    // safe empty-state (server error text goes through textContent, never innerHTML)
    function setEmpty(msg) {
        const host = $dl('dl-results'); if (!host) return;
        host.innerHTML = '';
        const d = document.createElement('div'); d.className = 'empty'; d.textContent = msg;
        host.append(d);
    }
    function loadRecommended(force) {
        if (DL.busy) return;
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        if (!force && DL.rec.trending && DL.rec._mlx === mlx) { renderDlPage(); return; }
        DL.busy = true;
        fetchJson(`${API}/admin/api/hf/recommended?mlx_only=${mlx}`).then(d => {
            DL.rec = {
                trending: (d.trending || []).map((m, i) => ({ ...m, rank: i + 1 })),
                popular: (d.popular || []).map((m, i) => ({ ...m, rank: i + 1 })),
                _mlx: mlx,
            };
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            if (DL.tab !== 'search') { DL.page[DL.tab] = 1; DL.sort = { key: 'rank', dir: 1 }; }
            renderDlPage();
        }).catch(e => {
            DL.busy = false;
            DL.rec.trending = DL.rec.trending || [];
            DL.rec.popular = DL.rec.popular || [];
            const host = $dl('dl-results');
            if (host && DL.tab !== 'search') setEmpty('Suggestions failed: ' + e.message);
        });
    }
    function doSearch() {
        const q = ($dl('dl-q') || {}).value?.trim();
        if (!q) { toast(C.t('uplift.toast.type_query')); return; }
        const sort = $dl('dl-sort').value || 'trending';
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        DL.q = q; DL.busy = true;
        const sub = $dl('dl-sub'); if (sub) sub.textContent = 'searching…';
        const host = $dl('dl-results'); if (host) host.innerHTML = '<div class="empty">Searching huggingface.co…</div>';
        fetchJson(`${API}/admin/api/hf/search?q=${encodeURIComponent(q)}&limit=100&sort=${sort}&mlx_only=${mlx}`).then(d => {
            DL.search = (d.models || []).map((m, i) => ({ ...m, rank: i + 1 }));
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            DL.page.search = 1; DL.sort = { key: 'rank', dir: 1 };
            setTab('search');
        }).catch(e => {
            DL.busy = false; DL.search = [];
            if (sub) sub.textContent = '';
            setEmpty('Search failed: ' + e.message);
        });
    }
    if (!dlInit) {
        dlInit = true;
        // token: persisted in this browser only (user preference: localStorage)
        const tk = $dl('dl-token');
        try { tk.value = localStorage.getItem('uplift.hf_token') || ''; } catch (_) {}
        tk.addEventListener('change', () => {
            try { localStorage.setItem('uplift.hf_token', tk.value.trim()); } catch (_) {}
        });
        $dl('dl-go').onclick = doSearch;
        $dl('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        $dl('dl-sort').onchange = () => { if (DL.tab === 'search' && DL.q) doSearch(); };
        $dl('dl-mlx').onchange = () => {
            if (DL.tab === 'search') doSearch(); else loadRecommended(true);
        };
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t);
            if (b) b.onclick = () => {
                if (t === 'search' && !DL.q) { toast(C.t('uplift.toast.type_query_press_search')); $dl('dl-q').focus(); return; }
                setTab(t);
            };
        }
        $dl('dl-direct').onclick = () => queueDownload($dl('dl-repo').value.trim(), $dl('dl-direct'));
        $dl('dl-repo').addEventListener('keydown', e => {
            if (e.key === 'Enter') queueDownload($dl('dl-repo').value.trim()); });
    }
    if (DL.tab === 'search' && DL.search.length) renderDlPage();
    else loadRecommended();
    renderTasks('dl-tasks', 'hf');
}

/* ---- oQ quantizer: faithful port of the classic page's form.
   All option lists come from the server (/oq/models); the candidate
   filters mirror oqSensitivityModelCandidates / oqMtpAssistantCandidates
   in dashboard.js; estimate mirrors oqRefreshEstimate (300 ms debounce,
   preserve_mtp param) including the client-side sensitivity-model memory
   approximation (size x 1.5 + 5 GB). Labels from models.oq.* in i18n. -- */
const OQ_LEVELS = [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8];
function oqMtpFamily(t) {
    if (!t) return null;
    if (t.startsWith('qwen3_6')) return 'qwen3_6';
    if (t.startsWith('qwen3_5')) return 'qwen3_5';
    return null;
}
function qzField(host, label, ctl, hint) {
    const row = document.createElement('label');
    row.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    row.append(t);
    if (ctl) row.append(ctl);
    if (hint) { const h = document.createElement('small'); h.textContent = hint; row.append(h); }
    host.append(row);
    return row;
}
function qzSelect(placeholder) {
    const sel = document.createElement('select');
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.append(o);
    return sel;
}

function renderQuantizer() {
    const host = $('qz-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        host.append(g);

        const st = { all: [], models: [] };
        const selModel = qzSelect('Select a model...');
        qzField(g, 'Source Model', selModel, 'full precision only');
        const rowSens = qzField(g, 'Sensitivity Model', null,
            'Use a quantized version of the source model to analyze layer sensitivity with ~4x less memory.');
        const selSens = qzSelect('None (use source model)');
        rowSens.insertBefore(selSens, rowSens.querySelector('small'));
        const selLevel = qzSelect(null);
        selLevel.remove(0);
        for (const l of OQ_LEVELS) {
            const o = document.createElement('option');
            o.value = l; selLevel.append(o);
        }
        selLevel.value = '4';
        const rowLevel = qzField(g, 'oQ Level', selLevel);
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start';
        g.append(rowLevel);

        // enhanced (oQe) block
        const cbEnh = document.createElement('input'); cbEnh.type = 'checkbox';
        qzField(g, 'Enhanced quantization (oQe)', cbEnh,
            'Use imatrix calibration to weight affine quantization by activation importance.');
        const rowEnhOnly = document.createElement('div');
        rowEnhOnly.className = 'qz-enh-only'; rowEnhOnly.hidden = true;
        const cbReuse = document.createElement('input'); cbReuse.type = 'checkbox'; cbReuse.checked = true;
        qzField(rowEnhOnly, 'Reuse imatrix cache', cbReuse,
            'Use a compatible cached imatrix when available; otherwise collect a new one.');
        const inpCache = document.createElement('input');
        inpCache.type = 'text'; inpCache.placeholder = 'Automatic';
        qzField(rowEnhOnly, 'Imatrix cache path', inpCache);
        const cbStrict = document.createElement('input'); cbStrict.type = 'checkbox';
        qzField(rowEnhOnly, 'Strict imatrix coverage', cbStrict,
            'Fail when a quantized tensor has no matching imatrix entry instead of falling back.');
        g.append(rowEnhOnly);

        // advanced block
        const adv = document.createElement('div');
        adv.className = 'qz-adv';
        const advT = document.createElement('div');
        advT.className = 'qz-adv-title'; advT.textContent = 'Advanced Settings';
        adv.append(advT);
        const dtypes = document.createElement('div');
        dtypes.className = 'qz-toggle';
        const dtype = { v: 'bfloat16' };
        for (const d of ['bfloat16', 'float16']) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = d;
            b.className = d === dtype.v ? 'on' : '';
            b.onclick = () => {
                dtype.v = d;
                for (const x of dtypes.children) x.classList.toggle('on', x.textContent === d);
            };
            dtypes.append(b);
        }
        qzField(adv, 'Non-quant weight dtype', dtypes,
            'float16 gives ~20% faster prefill on M1/M2 Apple Silicon (native fp16). bfloat16 is safer for newer models.').dataset.k = 'dtype';
        const cbMtp = document.createElement('input'); cbMtp.type = 'checkbox';
        const rowMtp = qzField(adv, 'Preserve MTP weights', cbMtp,
            'Keep mtp.* tensors and config fields in the output model so the Lightning MTP drafter still works.');
        const mtpNa = document.createElement('small');
        mtpNa.className = 'warn-text'; mtpNa.textContent = 'Source model has no MTP heads.';
        mtpNa.hidden = true; rowMtp.append(mtpNa);
        const selCombine = qzSelect('None');
        const rowCombine = qzField(adv, 'Combine other model\u2019s MTP head', selCombine,
            'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).');
        const cbText = document.createElement('input'); cbText.type = 'checkbox';
        const rowText = qzField(adv, 'Text only', cbText);
        const vlmWarn = document.createElement('small');
        vlmWarn.className = 'warn-text';
        vlmWarn.textContent = C.tf('uplift.ui.selected_model_is_a_vlm_vision_tower_will_be_ski', 'Selected model is a VLM — vision tower will be skipped.');
        vlmWarn.hidden = true; rowText.append(vlmWarn);
        g.append(adv);

        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '\u2014';
        g.append(est, start);

        const levelLabel = l => 'oQ' + l + (cbEnh.checked ? 'e' : '');
        const refreshLevelLabels = () => {
            for (const o of selLevel.options) o.textContent = levelLabel(o.value);
        };

        let estTimer = null;
        function refreshEst() {
            clearTimeout(estTimer);
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { est.textContent = '\u2014'; return; }
            estTimer = setTimeout(() => {
                const params = new URLSearchParams({
                    model_path: m.path, oq_level: selLevel.value,
                    preserve_mtp: (m.has_mtp_heads && cbMtp.checked) ? 'true' : 'false',
                });
                fetchJson(`${API}/admin/api/oq/estimate?${params}`).then(e => {
                    let mem = e.memory_streaming_formatted || '';
                    const sens = st.all.find(x => x.path === selSens.value);
                    if (sens) {   // client-side approximation, same as classic page
                        const bytes = Math.round(sens.size * 1.5) + 5 * 1024 ** 3;
                        mem = bytes > 1024 ** 3
                            ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
                            : Math.round(bytes / 1024 ** 2) + ' MB';
                    }
                    est.textContent = `est: ${e.output_size_formatted || C.fmtBytes(e.output_size_bytes)}` +
                        ` \u00b7 ${e.effective_bpw} bpw \u00b7 stream ${mem}`;
                }).catch(err => { est.textContent = 'estimate: ' + err.message; });
            }, 300);
        }

        function fill(sel, items, label) {
            const keep = sel.value;
            for (const o of [...sel.options].slice(1)) o.remove();
            for (const m of items) {
                const o = document.createElement('option');
                o.value = m.path; o.textContent = label(m);
                sel.append(o);
            }
            sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
        }

        function updateConditional() {
            const m = st.models.find(x => x.path === selModel.value);
            // sensitivity candidates: quantized, same model_type, not the source
            const sens = m ? st.all.filter(x => x.path !== m.path && x.is_quantized &&
                x.model_type === m.model_type) : [];
            fill(selSens, sens, x => `${x.name} (${x.size_formatted})`);
            rowSens.hidden = sens.length === 0;
            // preserve MTP availability
            const hasMtp = !!(m && m.has_mtp_heads);
            cbMtp.disabled = !hasMtp;
            if (!hasMtp) cbMtp.checked = false;
            mtpNa.hidden = hasMtp || !m;
            // MTP donor / gemma4 assistant candidates (mirror the classic filter)
            let comb = [];
            if (m && m.model_type === 'gemma4') {
                comb = st.all.filter(x => x.model_type === 'gemma4_assistant');
                rowCombine.querySelector('span').textContent = 'Combine assistant model as MTP head';
                rowCombine.querySelector('small').textContent =
                    'Merge a separate gemma4_assistant checkpoint into the output as a Lightning MTP head.';
            } else if (m && oqMtpFamily(m.model_type) && !(hasMtp && cbMtp.checked)) {
                comb = st.all.filter(x => x.path !== m.path && x.has_mtp_heads &&
                    oqMtpFamily(x.model_type) === oqMtpFamily(m.model_type) &&
                    (!x.hidden_size || !m.hidden_size || x.hidden_size === m.hidden_size));
                rowCombine.querySelector('span').textContent = 'Combine other model\u2019s MTP head';
                rowCombine.querySelector('small').textContent =
                    'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).';
            }
            fill(selCombine, comb, x => `${x.name} (${x.size_formatted})`);
            rowCombine.hidden = comb.length === 0;
            // VLM text-only warning
            vlmWarn.hidden = !(m && m.is_vlm && cbText.checked);
            refreshEst();
        }

        fetchJson(`${API}/admin/api/oq/models`).then(d => {
            st.all = d.all_models || d.models || [];
            st.models = st.all.filter(m => !m.is_quantized);
            fill(selModel, st.models,
                m => `${m.source_repo_id || m.name} (${m.size_formatted})`);
            $('qz-sub').textContent = `${st.models.length} quantizable models`;
            refreshLevelLabels();
            updateConditional();
        }).catch(e => emptyMsg(host, e.message));

        selModel.onchange = updateConditional;
        selSens.onchange = refreshEst;
        selLevel.onchange = refreshEst;
        cbMtp.onchange = () => { updateConditional(); };
        cbText.onchange = updateConditional;
        cbEnh.onchange = () => {
            rowEnhOnly.hidden = !cbEnh.checked;
            refreshLevelLabels();     // labels gain the 'e' suffix, like the classic page
            refreshEst();
        };

        start.onclick = () => {
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { toast(C.t('uplift.toast.select_a_model')); return; }
            const donor = st.all.find(x => x.path === selCombine.value);
            start.disabled = true;
            const payload = {
                model_path: m.path,
                oq_level: parseFloat(selLevel.value),
                group_size: 64,
                sensitivity_model_path: selSens.value || '',
                text_only: cbText.checked,
                dtype: dtype.v,
                preserve_mtp: m.has_mtp_heads ? cbMtp.checked : false,
                mtp_assistant_model_path: donor ? donor.path : '',
            };
            if (cbEnh.checked) {
                payload.enhanced = true;
                payload.imatrix_reuse_cache = cbReuse.checked;
                payload.imatrix_cache_path = inpCache.value.trim();
                payload.imatrix_strict = cbStrict.checked;
            }
            postJson(`${API}/admin/api/oq/start`, payload).then(() => {
                toast(`quantize queued${GW_LIVE ? '' : ' (shadow)'}: ` + m.name);
                renderTasks('qz-tasks', 'oq');
            }).catch(e => toast('quantize: ' + e.message))
              .finally(() => { start.disabled = false; });
        };
    }
    renderTasks('qz-tasks', 'oq');
}


/* ---- oQ uploader: faithful port. Token -> validate-token (shadow:
   never forwarded, so a real token is never leaked to the real server's
   response path; username/orgs are simulated), model list comes from
   upload/oq-models, upload opens the same modal fields as the classic
   page (repo name prefilled namespace/name, README source, re-download
   notice only when no README source, private). -- */
function renderUploader() {
    const host = $('up-form');
    if (host.dataset.built) { renderTasks('up-tasks', 'upload'); return; }
    host.dataset.built = '1';
    host.innerHTML = '';
    const st = { validated: false, ns: '', models: [] };
    const g = document.createElement('div');
    g.className = 'qz-form';
    host.append(g);
    const tokWrap = document.createElement('div');
    tokWrap.className = 'qz-inline';
    const tok = document.createElement('input');
    tok.type = 'password'; tok.placeholder = 'Enter HF write token (hf_...)';
    const vbtn = document.createElement('button');
    vbtn.className = 'se-btn'; vbtn.textContent = 'Validate';
    const vmsg = document.createElement('span');
    vmsg.className = 'stat-sub';
    tokWrap.append(tok, vbtn, vmsg);
    qzField(g, 'HuggingFace Token', tokWrap);
    const list = document.createElement('div');
    list.className = 'admin-table';
    const listT = document.createElement('div');
    listT.className = 'se-hint'; listT.textContent = 'oQ Models';
    host.append(listT, list);
    const tasksT = document.createElement('h3');
    tasksT.textContent = C.tf('uplift.ui.upload_queue', 'Upload Queue'); tasksT.style.margin = '16px 0 6px';

    function loadModels() {
        fetchJson(`${API}/admin/api/upload/oq-models`).then(d => {
            st.models = d.oq_models || [];
            $('up-sub').textContent = `${st.models.length} oQ models`;
            list.innerHTML = '';
            if (!st.models.length) { list.innerHTML = '<div class="empty">No oQ models found in model directories.</div>'; return; }
            for (const m of st.models) {
                const row = document.createElement('div'); row.className = 'urow usage';
                const name = cell(m.name); name.className = 'uname';
                row.append(name, cell(m.size_formatted || C.fmtBytes(m.size || 0)));
                const act = document.createElement('span'); act.className = 'rowacts';
                const b = document.createElement('button');
                b.className = 'se-btn act'; b.textContent = 'upload';
                b.disabled = !st.validated;
                b.onclick = () => uploadModal(m);
                act.append(b); row.append(act);
                list.append(row);
            }
            vbtn.disabledMsg = null;
        }).catch(e => emptyMsg(list, e.message));
    }

    vbtn.onclick = () => {
        if (!tok.value.trim()) { vmsg.textContent = C.tf('uplift.ui.invalid_token_ensure_it_has_write_access', 'Invalid token. Ensure it has write access.'); return; }
        vbtn.disabled = true; vmsg.textContent = 'Validating...';
        postJson(`${API}/admin/api/upload/validate-token`, { hf_token: tok.value.trim() })
            .then(d => {
                st.validated = true; st.ns = d.username || 'you';
                vmsg.textContent = C.tf('uplift.ui.authenticated_as', 'Authenticated as ') + st.ns;
                tok.value = tok.value;   // stays in the browser only
                loadModels();
            })
            .catch(e => { st.validated = false; vmsg.textContent = e.message; })
            .finally(() => { vbtn.disabled = false; });
    };
    tok.addEventListener('keydown', e => { if (e.key === 'Enter') vbtn.onclick(); });

    function uploadModal(m) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const box = document.createElement('div');
        box.className = 'modal nasa';
        const h = document.createElement('h3'); h.textContent = 'Upload to HuggingFace';
        const repo = document.createElement('input');
        repo.type = 'text'; repo.value = st.ns + '/' + m.name;
        const readme = qzSelect('Auto-generate basic README');
        const rdSel = document.createElement('div');
        rdSel.append(readme);   // only auto-README is meaningful in the sandbox
        const cbRe = document.createElement('input'); cbRe.type = 'checkbox';
        const cbPr = document.createElement('input'); cbPr.type = 'checkbox';
        const bCancel = document.createElement('button'); bCancel.textContent = 'Cancel';
        const bGo = document.createElement('button'); bGo.className = 'danger'; bGo.textContent = 'Upload';
        bCancel.onclick = () => overlay.remove();
        bGo.onclick = () => {
            if (!repo.value.trim()) { toast(C.t('uplift.toast.repo_name_required')); return; }
            bGo.disabled = true;
            postJson(`${API}/admin/api/upload/start`, {
                model_path: m.path, repo_id: repo.value.trim(), hf_token: tok.value.trim(),
                readme_source_path: '', auto_readme: true,
                redownload_notice: cbRe.checked, private: cbPr.checked,
            }).then(() => {
                toast(`upload queued${GW_LIVE ? '' : ' (shadow)'}: ` + repo.value.trim());
                overlay.remove();
                renderTasks('up-tasks', 'upload');
            }).catch(e => toast('upload: ' + e.message))
              .finally(() => { bGo.disabled = false; });
        };
        const bar = document.createElement('div');
        bar.className = 'row buttons';
        bar.append(document.createElement('span'), bCancel, bGo);
        qzField(box, 'Repository Name', repo);
        qzField(box, 'README Source', rdSel);
        qzField(box, 'Show re-download notice', cbRe,
            'Add a notice at the top of README asking previous users to re-download');
        qzField(box, 'Private Repository', cbPr);
        box.append(h, bar);
        overlay.append(box);
        overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
        document.body.append(overlay);
    }

    vmsg.textContent = C.tf('uplift.ui.enter_a_token_to_list_uploadable_oq_models', 'Enter a token to list uploadable oQ models.');
    renderTasks('up-tasks', 'upload');
}

/* ------- stored settings: prune dialog (the list merged into Models) ---- */

async function openPruneDialog() {
    let orphans = [], profs = [];
    try {
        const idx = await fetchJson(`${API}/admin/api/model-settings-index`);
        S.settingsIdx = idx;
        orphans = idx.orphans || [];
        // round 4: profiles of orphaned bases AND of models that stay on
        // disk but whose profiles were left behind are all prune candidates
        const known = new Set(MM.adminModels.map(m => m.id));
        profs = (idx.profiles || []).filter(p => !known.has(p.base)
            || orphans.includes(p.base));
    } catch (err) { toast('prune check failed: ' + err.message); return; }
    if (!orphans.length && !profs.length) { toast(C.t('uplift.toast.nothing_to_prune')); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = `Prune model settings (${orphans.length + profs.length})`;
    const sub = document.createElement('div');
    sub.className = 'se-hint';
    sub.textContent = C.tf('uplift.ui.stored_configuration_for_models_that_no_longer_e', 'Stored configuration for models that no longer exist on disk. ')
        + C.tf('uplift.ui.profiles_shown_as_base_name', 'Profiles appear as "model:profile". ')
        + (GW_LIVE
            ? 'Removed entries are deleted from this server\'s model_settings.json.'
            : 'Removed entries are deleted from the sandbox model_settings.json.');
    const list = document.createElement('div');
    list.className = 'prune-list';
    const checks = [];
    for (const id of orphans) {
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = id; cb.dataset.kind = 'model';
        lbl.append(cb, cell(id));
        list.append(lbl);
        checks.push(cb);
    }
    for (const p of profs) {
        // profile of an orphaned base is covered by deleting the base record;
        // show it anyway (user must see what goes), uncheckable individually
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = p.name;
        cb.dataset.base = p.base; cb.dataset.kind = 'profile';
        lbl.append(cb, cell(p.base + ':' + (p.display_name || p.name)));
        list.append(lbl);
        checks.push(cb);
    }
    const bar = document.createElement('div');
    bar.className = 'row buttons';
    const all = document.createElement('button');
    all.textContent = C.tf('uplift.ui.select_all', 'Select all');
    all.onclick = () => checks.forEach(c => c.checked = true);
    const none = document.createElement('button');
    none.textContent = C.tf('uplift.ui.select_none', 'Select none');
    none.onclick = () => checks.forEach(c => c.checked = false);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    const doIt = document.createElement('button');
    doIt.className = 'danger';
    doIt.textContent = C.tf('uplift.ui.prune_selected', 'Prune selected');
    doIt.onclick = async () => {
        const sel = checks.filter(c => c.checked);
        const ids = sel.filter(c => c.dataset.kind === 'model').map(c => c.value);
        // profiles whose base record is also selected die with it (the
        // server's delete_settings drops both); a second delete_profile for
        // them is a harmless no-op, so send every checked profile anyway
        const idSet = new Set(ids);
        const profSel = sel.filter(c => c.dataset.kind === 'profile'
            && !idSet.has(c.dataset.base))
            .map(c => ({ base: c.dataset.base, name: c.value }));
        if (!ids.length && !profSel.length) { toast(C.t('uplift.toast.nothing_selected')); return; }
        try {
            const r = await postJson(`${API}/admin/api/prune-model-settings`,
                { ids, profiles: profSel });
            toast(`Pruned ${r.removed.length} setting record(s)`
                + (r.removed_profiles && r.removed_profiles.length
                    ? `, ${r.removed_profiles.length} profile(s)` : ''));
            overlay.remove();
            MM.render(true);
        } catch (err) { toast('prune failed: ' + err.message); }
    };
    bar.append(all, none, document.createElement('span'), cancel, doIt);
    box.append(h, sub, list, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.append(overlay);
}
$('btn-prune').onclick = openPruneDialog;




/* ---------------- models sub-page: helper models -------- */
/* used_by resolver: overlay route provides row.used_by; vanilla rows lack
   it but carry their full settings dict — derive the reverse map here so
   the page works identically against a vanilla upstream. */
function usedBy(m) {
    if (Array.isArray(m.used_by)) return m.used_by;
    const users = new Set();
    for (const x of MM.adminModels || []) {
        if (x.id === m.id) continue;
        const s = x.settings || {};
        for (const k of ['specprefill_draft_model', 'dflash_draft_model',
                         'vlm_mtp_draft_model'])
            if (s[k] === m.id) users.add(x.id);
    }
    return [...users].sort();
}

async function renderHelperModels() {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (e) { emptyMsg($('hm-list'), e.message); return; }
    const mk = models.filter(m => m.engine_type === 'markitdown' || m.model_type === 'markitdown');
    const helpers = models.filter(m => !mk.includes(m) && (m.is_helper ||
        /dflash|assistant/i.test(m.id)));
    $('hm-sub').textContent = `${helpers.length} helpers · ${mk.length} markitdown`;
    $('hm-sub').dataset.count = helpers.length;

    // Integrations, same fields / labels / conditionals as the classic
    // Settings -> Integrations tab. MarkItDown gets the special box at the
    // top (separate role gets separate space), then Web Search, then the
    // helper model list.
    const box = $('hm-markitdown');
    box.textContent = '';
    let integ = {};
    let modelList = [];
    try {
        integ = (await fetchJson(`${API}/admin/api/global-settings`)).integrations || {};
    } catch (_) {}
    modelList = models;

    // save exactly like classic saveIntegrationSettings(): flat body where
    // ONLY the CLI-assistant keys carry the integrations_ prefix; markitdown_*
    // and web_search_* are sent bare (real oMLX drops unknown fields with a
    // silent success:true, so a blanket prefix looked saved but did nothing).
    const INTEG_PREFIXED = new Set(['copilot_model', 'codex_model', 'opencode_model',
        'openclaw_model', 'hermes_model', 'pi_model', 'openclaw_tools_profile']);
    async function saveIntegration(overrides) {
        Object.assign(integ, overrides || {});
        const body = {};
        for (const [k, v] of Object.entries(integ))
            body[INTEG_PREFIXED.has(k) ? 'integrations_' + k : k] = v;
        try {
            const r = await fetch(`${API}/admin/api/global-settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const res = await r.json().catch(() => ({}));
            if (res.success === false) throw new Error(res.message || 'rejected');
            toast(C.t('uplift.toast.integration_saved'));
            return true;
        } catch (err) { toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
    }
    function integField(label, hint, control) {
        const f = document.createElement('label');
        f.className = 'field';
        const lab = document.createElement('span');
        lab.textContent = label;
        f.append(lab, control);
        if (hint) {
            const h = document.createElement('small');
            h.className = 'fhint dim'; h.textContent = hint;
            f.append(h);
        }
        return f;
    }
    function integSelect(opts, val, onchange) {
        const sel = document.createElement('select');
        for (const [v, t] of opts) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            sel.append(o);
        }
        sel.value = val;
        sel.onchange = () => onchange(sel.value);
        return sel;
    }
    function integNumber(key, min, max) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = min; inp.max = max;
        inp.value = integ[key] ?? '';
        inp.onchange = async () => {
            const v = Number(inp.value);
            if (await saveIntegration({ [key]: v })) renderHelperModels();
        };
        return inp;
    }

    /* ---- MarkItDown box ---- */
    const mkCard = document.createElement('div');
    mkCard.className = 'mk-box';
    const head = document.createElement('div');
    head.className = 'mk-head';
    const title = document.createElement('div');
    title.className = 'mk-title';
    title.textContent = 'MarkItDown';
    head.append(title);
    for (const m of mk) {
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : 'off');
        state.textContent = m.loaded ? 'LOADED' : 'IDLE';
        head.append(state);
    }
    mkCard.append(head);
    const mkGrid = document.createElement('div');
    mkGrid.className = 'mk-fields';

    const enabledInp = document.createElement('input');
    enabledInp.type = 'checkbox';
    enabledInp.checked = !!integ.markitdown_enabled;
    enabledInp.onchange = async () => {
        if (await saveIntegration({ markitdown_enabled: enabledInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Enable MarkItDown',
        'Preprocess supported file attachments before LLM requests.', enabledInp));

    const exposeInp = document.createElement('input');
    exposeInp.type = 'checkbox';
    exposeInp.checked = !!integ.markitdown_expose_model;
    exposeInp.disabled = !integ.markitdown_enabled;
    exposeInp.onchange = async () => {
        if (await saveIntegration({ markitdown_expose_model: exposeInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Show as model',
        'Expose MarkItDown in model lists for direct Markdown conversion requests.', exposeInp));

    mkGrid.append(integField('Max file size (MB)',
        'Reject larger document attachments before conversion.',
        integNumber('markitdown_max_file_size_mb', 1, 1024)));
    mkGrid.append(integField('Max files per request',
        'Limit document attachments converted in one request.',
        integNumber('markitdown_max_files_per_request', 1, 50)));

    // pdf engine: MarkItDown + OCR-capable models (classic: config_model_type contains 'ocr')
    const pdfOpts = [['markitdown', 'MarkItDown']];
    for (const m of modelList)
        if (String(m.config_model_type || '').toLowerCase().includes('ocr'))
            pdfOpts.push([m.id, m.id]);
    const pdfSel = integSelect(pdfOpts, integ.markitdown_pdf_processing_engine || 'markitdown',
        async v => { if (await saveIntegration({ markitdown_pdf_processing_engine: v })) renderHelperModels(); });
    const pdfField = integField('PDF processing engine',
        'Process PDF requests by MarkItDown itself or by an OCR engine.', pdfSel);
    if (integ.markitdown_pdf_processing_engine === 'markitdown') {
        const warn = document.createElement('small');
        warn.className = 'fhint warn';
        warn.textContent = C.tf('uplift.ui.scanned_or_image_only_pdfs_will_fail_when_markit', 'Scanned or image-only PDFs will fail when MarkItDown is selected, ')
            + 'and PDFs with tables may not be processed correctly.';
        pdfField.append(warn);
    }
    mkGrid.append(pdfField);
    mkCard.append(mkGrid);
    box.append(mkCard);

    /* ---- CLI assistants (classic binds these on the Status launcher;
       Uplift edits them where integrations live). Keys save with the
       integrations_ prefix exactly like saveIntegrationSettings(). ---- */
    const cliCard = document.createElement('div');
    cliCard.className = 'mk-box';
    const cliHead = document.createElement('div');
    cliHead.className = 'mk-head';
    const cliTitle = document.createElement('div');
    cliTitle.className = 'mk-title';
    cliTitle.textContent = C.tf('uplift.ui.cli_assistants', 'CLI Assistants');
    const cliHint = document.createElement('small');
    cliHint.className = 'dim';
    cliHint.textContent = 'Model each launched CLI assistant defaults to (blank = ask every launch).';
    cliHead.append(cliTitle, cliHint);
    const cliGrid = document.createElement('div');
    cliGrid.className = 'mk-grid';
    const cliModel = (key, label) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.spellcheck = false;
        inp.setAttribute('list', 'cli-models');
        inp.value = integ[key] || '';
        inp.placeholder = 'Ask every launch';
        inp.onchange = async () => { await saveIntegration({ [key]: inp.value || null }); };
        return integField(label, '', inp);
    };
    cliGrid.append(
        cliModel('copilot_model', 'GitHub Copilot'),
        cliModel('codex_model', 'Codex'),
        cliModel('opencode_model', 'OpenCode'),
        cliModel('openclaw_model', 'OpenClaw'),
        integField('OpenClaw tools profile', 'Tool set the launcher passes to openclaw.',
            integSelect([['minimal','Minimal'],['coding','Coding'],['messaging','Messaging'],['full','Full']],
                        integ.openclaw_tools_profile || 'coding',
                        v => saveIntegration({ openclaw_tools_profile: v }))),
        cliModel('hermes_model', 'Hermes Agent'),
        cliModel('pi_model', 'Pi'));
    // model datalist for the assistant pickers
    const cliDl = document.createElement('datalist'); cliDl.id = 'cli-models';
    for (const m of modelList) {
        const o2 = document.createElement('option'); o2.value = m.id || m.name || ''; cliDl.append(o2);
    }
    cliCard.append(cliHead, cliDl, cliGrid);
    box.append(cliCard);

    /* ---- Web Search ---- */
    const wsCard = document.createElement('div');
    wsCard.className = 'mk-box';
    const wsHead = document.createElement('div');
    wsHead.className = 'mk-head';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'mk-title';
    wsTitle.textContent = C.tf('uplift.ui.web_search', 'Web Search');
    wsHead.append(wsTitle);
    const wsGrid = document.createElement('div');
    wsGrid.className = 'mk-fields';

    const provSel = integSelect([
        ['ddgs', 'DDGS Total'], ['ddgs_custom', 'DDGS Custom'],
        ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'],
        ['searxng', 'SearXNG'],
    ], integ.web_search_provider || 'ddgs', async v => {
        if (await saveIntegration({ web_search_provider: v })) renderHelperModels();
    });
    wsGrid.append(integField('Search provider',
        'Backend used by the chat web search tool. DDGS Total queries every available engine and needs no key.',
        provSel));

    if (integ.web_search_provider === 'ddgs_custom') {
        const be = document.createElement('input');
        be.type = 'text';
        be.placeholder = 'e.g. duckduckgo,brave,mojeek';
        be.value = integ.web_search_ddgs_backends || '';
        be.onchange = async () => {
            if (await saveIntegration({ web_search_ddgs_backends: be.value })) renderHelperModels();
        };
        wsGrid.append(integField('Search engines',
            'Comma-separated engines to query. All of these work without an API key.', be));
    }
    if (integ.web_search_provider === 'brave') {
        const key = document.createElement('input');
        key.type = 'password';
        key.placeholder = 'BSA…';
        key.value = integ.web_search_brave_api_key || '';
        key.onchange = async () => {
            if (await saveIntegration({ web_search_brave_api_key: key.value })) renderHelperModels();
        };
        wsGrid.append(integField('Brave API key',
            'Subscription token from the Brave Search API dashboard. Stored locally, never echoed.', key));
    }
    if (integ.web_search_provider === 'searxng') {
        const url = document.createElement('input');
        url.type = 'text';
        url.placeholder = 'http://127.0.0.1:8080';
        url.value = integ.web_search_searxng_url || '';
        url.onchange = async () => {
            if (await saveIntegration({ web_search_searxng_url: url.value })) renderHelperModels();
        };
        wsGrid.append(integField('SearXNG instance URL',
            'Base URL of a SearXNG instance with the JSON output format enabled.', url));
    }

    wsGrid.append(integField('Results per search',
        'How many sources one web_search call returns (1-10).',
        integNumber('web_search_max_results', 1, 10)));

    const modeSel = integSelect([
        ['snippet', 'Snippets only'], ['full', 'Full page content'],
    ], integ.web_search_content_mode || 'snippet', async v => {
        if (await saveIntegration({ web_search_content_mode: v })) renderHelperModels();
    });
    wsGrid.append(integField('Result content',
        'Snippets keep the prompt small. Full page content fetches and inlines each result page.',
        modeSel));

    if (integ.web_search_content_mode === 'full') {
        const tr = document.createElement('input');
        tr.type = 'checkbox';
        tr.checked = !!integ.web_search_content_truncate;
        tr.onchange = async () => {
            if (await saveIntegration({ web_search_content_truncate: tr.checked })) renderHelperModels();
        };
        wsGrid.append(integField('Truncate page content',
            'Cut each fetched page at the limit below. Turning this off can flood the model context.', tr));
        if (integ.web_search_content_truncate) {
            wsGrid.append(integField('Content limit (chars)',
                'Maximum characters kept per fetched page.',
                integNumber('web_search_content_max_chars', 500, 200000)));
        }
    }

    // Test search: classic uses the real API; through the gateway it hits the real backend read-only.
    const testRow = document.createElement('div');
    testRow.className = 'row buttons';
    const testBtn = document.createElement('button');
    testBtn.className = 'se-btn';
    testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    const testOut = cell('');
    testOut.className = 'dim';
    testBtn.onclick = async () => {
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
        try {
            // Classic contract (dashboard.js testWebSearch): the endpoint tests
            // the PENDING form values and 422s without a JSON body. This page
            // autosaves every change, so last-loaded `integ` + live controls
            // ARE the pending state.
            const pickVal = ph => { const el = [...wsGrid.querySelectorAll('input')]
                    .find(i => i.placeholder === ph); return el ? el.value : ''; };
            const body = {
                provider: provSel.value || integ.web_search_provider || 'ddgs',
                brave_api_key: pickVal('BSA…') || integ.web_search_brave_api_key || '',
                searxng_url: pickVal('http://127.0.0.1:8080') || integ.web_search_searxng_url || '',
                ddgs_backends: pickVal('e.g. duckduckgo,brave,mojeek') || integ.web_search_ddgs_backends || '',
                max_results: Number(integ.web_search_max_results) || 5,
            };
            const r = await fetchJson(`${API}/admin/api/web-search/test`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body) });
            testOut.textContent = r.ok
                ? `Search OK: ${(r.results || []).length} results`
                : ('Search test failed: ' + ((r.error && r.error.message) || 'unknown'));
        } catch (err) {
            testOut.textContent = C.tf('uplift.ui.search_test_failed', 'Search test failed: ') + err.message;
        }
        testBtn.disabled = false; testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    };
    testRow.append(testBtn, testOut);
    testRow.className = 'mk-row';
    wsGrid.append(testRow);
    wsCard.append(wsHead, wsGrid);
    box.append(wsCard);

    $('hm-sub').textContent = `${helpers.length} helpers · integrations editable${GW_LIVE ? ' (live)' : ' (shadow)'}`;
    $('hm-sub').dataset.count = helpers.length;

    const host = $('hm-list');
    host.textContent = '';
    if (!helpers.length) { host.innerHTML = '<div class="empty">No helper models</div>'; return; }
    for (const m of helpers) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(m.id); name.className = 'uname';
        name.title = m.model_path || m.id;
        const kind = /dflash/i.test(m.id) ? 'DFLASH DRAFTER'
            : /assistant/i.test(m.id) ? 'ASSISTANT (MTP)' : 'HELPER';
        // U10 (user round): a drafter rides its consumers' engine — its own
        // loaded flag does not mean anything useful and the load button was
        // wrong. Show WHO uses it and light the lamp from the consumers.
        // used_by comes from our overlay route; on vanilla installs (viewer
        // mode) it is absent and derived here from each model's embedded
        // settings blob instead.
        const users = usedBy(m).map(uid => {
            const u = (MM.adminModels || []).find(x => x.id === uid);
            return { id: uid, loaded: !!(u && (u.loaded || u.is_loading)),
                     name: (u && (u.display_name || u.id)) || uid };
        });
        const active = users.filter(u => u.loaded);
        const state = document.createElement('span');
        state.className = 'spill ' + (active.length ? 'on' : 'off');
        state.textContent = users.length
            ? (active.length ? `IN USE ×${active.length}` : `SET FOR ×${users.length}`)
            : 'UNUSED';
        state.title = users.length
            ? 'Used by: ' + users.map(u => u.name + (u.loaded ? ' (loaded)' : '')).join(', ')
            : 'No model config references this drafter';
        row.append(name, cell(m.model_type || ''), cell(kind),
                   cell(m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size || 0)), state);
        const act = document.createElement('span'); act.className = 'rowacts';
        for (const u of users.slice(0, 3)) {
            const chip = document.createElement('button');
            chip.className = 'se-btn act' + (u.loaded ? ' on' : '');
            chip.textContent = u.name.split('/').pop().slice(0, 22);
            chip.title = (u.loaded ? 'loaded — ' : 'not loaded — ') + u.id;
            chip.onclick = () => { location.hash = '#models/manager'; MM.render(true); };
            act.append(chip);
        }
        if (users.length > 3) act.append(cell('+' + (users.length - 3)));
        if (!users.length) {
            const hint = document.createElement('span');
            hint.className = 'dim'; hint.style.fontSize = '10px';
            hint.textContent = 'assign it in a model\'s settings (DFlash / MTP / SpecPrefill)';
            act.append(hint);
        }
        row.append(act);
        host.append(row);
    }
}

/* ---------------- boot ---------------- */
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollGatewayInfo();
    if (currentTab() === 'usage') UUP.pollUsage();
    if (currentTab() === 'logs') UUP.pollLogs();
    // task-list poll chains self-terminate while hidden; kick the current one again
    const TASK_HOSTS = { downloader: ['dl-tasks', 'hf'], quantizer: ['qz-tasks', 'oq'], uploader: ['up-tasks', 'upload'] };
    if (currentTab() === 'models') {
        const pair = TASK_HOSTS[currentSub('models')];
        if (pair) renderTasks(pair[0], pair[1]);
    }
    CH.resizeCharts();
});

applyPrefs();
// ?lang=xx overrides the locale (testing/demo; server setting is default)
loadLocale(new URLSearchParams(location.search).get('lang') || undefined);
CH.createCharts();
CH.resizeCharts();
// PH2-1 stage 2: chart-host ResizeObservers (moved out of uplift_charts.js;
// resizeCharts() reads metricCharts there — const TDZ made load-time firing
// unsafe). The grid box drives the observer; chart hosts are observed too —
// column-count changes shrink boxes INSIDE the grid, and canvases would keep
// the old, wider size and overflow narrow columns.
new ResizeObserver(CH.resizeCharts).observe($('grid'));
for (const id of ['chart-tps', 'chart-mem', 'chart-usage'])
    if ($(id)) new ResizeObserver(CH.resizeCharts).observe($(id));
applyTab();
gateClusterFromServer();
restartPolling();
pollGatewayInfo();
CH.loadChartHistory();
setInterval(() => { if (!document.hidden) CH.loadChartHistory(); }, 60000);
// Metric cards: generate DOM from the catalogue BEFORE grid init so the
// board places them like any static block; boot fetch + keep-alive (the
// per-window cache TTL gates refetches: 10 s short, 60 s week+).
for (const def of C.EXPLORE_METRICS) CH.createMetricCard(def);
/* ============================================================================
   PAT-4: PATCHES — declarative patch carrier UI (settings/patches).
   Every button hits a PAT-2 endpoint; nothing here writes the keg directly —
   enable/disable/promote/rollback/reconcile land at the NEXT omlx restart
   (the .pth engine, PAT-3). State chips reuse the cockpit-lamp vocabulary;
   the WARNING banner lights for needs_review/failed like an instrument flag.
   ========================================================================== */

function ptMsg(key, fb) { return C.tf(key, fb); }

async function pollPatches() {
    try {
        S.PT_DATA = await fetchJson(`${API}/uplift/api/patches`);
        renderPatches();
    } catch (e) {
        const list = $('pt-list');
        if (list) list.innerHTML = '';
        if (list) {
            const d = document.createElement('div');
            d.className = 'empty';
            // a 401 means the admin session cookie is missing/expired for
            // THIS origin — 'API unavailable' sent people hunting servers
            const denied = /-> 401/.test(String(e && e.message || e));
            d.textContent = (denied
                ? ptMsg('uplift.patches.load_auth', 'Sign in required — open /admin and log in, then reload')
                : ptMsg('uplift.patches.load_fail', 'Patches API unavailable'))
                + (denied ? '' : ' — ' + (e && e.message ? e.message : e));
            list.append(d);
        }
    }
}

function ptApi(path, body) {
    return fetchJson(`${API}/uplift/api/patches/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
}

async function ptAction(path, body, okMsg) {
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    try {
        const r = await ptApi(path, body);
        if (okMsg) toast(okMsg, 4000);
        if (r && r.reason) toast(r.reason, 5000);
        await pollPatches();
    } catch (e) {
        toast(ptMsg('uplift.patches.action_fail', 'Patch action failed') +
              ': ' + (e && e.message ? e.message : e), 6000);
    } finally {
        S.PT_BUSY = false;
    }
}

// Enable/promote with safeguard support: on HTTP 409 the backend lists the
// codes that need an explicit approval — we do NOT silently retry.
async function ptEnableWithApproval(p, approve) {
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    try {
        const body = { id: p.id };
        if (approve) body.approve = approve;
        const r = await ptApi('enable', body);
        toast(approve
            ? ptMsg('uplift.patches.approved_codes', 'approved: {codes}')
                  .replace('{codes}', (r.approved || []).join(', ') || approve)
            : ptMsg('uplift.patches.enabled_toast',
                    'Enabled — applies on next omlx restart'), 4000);
        await pollPatches();
    } catch (e) {
        toast(ptMsg('uplift.patches.approve_fail', 'Approval failed') +
              ': ' + (e && e.message ? e.message : e), 6000);
    } finally {
        S.PT_BUSY = false;
    }
}

// One diff line per problem + the autodetected root note (the paths stored
// in the manifest are the REWRITTEN ones — say so, or the diff view looks
// like it disagrees with the source URL).
function ptSafeguardLines(p) {
    const out = [];
    const ver = (p.versions || []).find(v => v.v === (p.desired_version ||
        Math.max(...(p.versions || []).map(x => x.v)))) || {};
    for (const pr of ((ver.safeguards || {}).problems || [])) {
        out.push({ text: pr.path + ' — ' + pr.message, code: pr.code });
    }
    if (ver.root_note) out.push({ text: ptMsg('uplift.patches.safeguard_note',
        'Root autodetected: {n}').replace('{n}', ver.root_note), code: null });
    return out;
}

function ptChip(text, cls, title) {
    const s = document.createElement('span');
    s.className = 'pt-chip ' + (cls || '');
    s.textContent = text;
    if (title) s.title = title;
    return s;
}

function renderPatches() {
    const d = S.PT_DATA;
    if (!d) return;
    const list = $('pt-list');
    list.innerHTML = '';

    // WARNING banner: any needs_review/failed patch (PAT-0 badge rule)
    const warn = $('pt-warn');
    warn.hidden = !d.warning;
    if (d.warning) {
        warn.textContent = ptMsg('uplift.patches.warn_banner',
            'WARNING — one or more patches need review after a vanilla update or failed to apply. oMLX runs without them until resolved.');
    }
    const ks = $('pt-killswitch');
    ks.hidden = !d.kill_switch_active;
    if (d.kill_switch_active) {
        ks.textContent = ptMsg('uplift.patches.killswitch_on',
            'Patch engine disabled (kill switch) — booting pristine vanilla, manifest untouched.');
    }

    // honesty badge: applied patches mean classic files are NOT byte-identical
    const nApplied = d.patches.filter(p => p.state === 'applied').length;
    $('pt-sub').textContent = nApplied
        ? ptMsg('uplift.patches.divergence',
                '{n} local patch(es) active — classic /admin/ files are NOT byte-identical')
            .replace('{n}', nApplied)
        : ptMsg('uplift.patches.pristine', 'vanilla — no local patches active');

    const auto = $('pt-auto-check');
    auto.checked = !!(d.config && d.config.auto_update_check);
    auto.onchange = async () => {
        try {
            await ptApi('config', { auto_update_check: auto.checked });
            await pollPatches();
        } catch (e) { toast(String(e), 4000); }
    };

    if (!d.patches.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = ptMsg('uplift.patches.none',
            'No patches yet. Add a GitHub PR, URL, or upload a .diff above.');
        list.append(empty);
    }
    for (const p of d.patches) list.append(patchCard(p, d));
}

function patchCard(p, view) {
    const card = document.createElement('div');
    card.className = 'pt-card' + (p.state === 'needs_review' || p.state === 'failed'
        ? ' pt-card-warn' : '');

    const head = document.createElement('div');
    head.className = 'pt-card-head';
    const title = document.createElement('span');
    title.className = 'pt-id';
    title.textContent = p.id;
    head.append(title);
    const cls = PT_STATE_CLASS[p.state] || 'pt-st-dim';
    head.append(ptChip((p.state || '').toUpperCase(), cls, p.state_detail || ''));
    const heldCodes = p.requires_approval || [];
    if (heldCodes.length) {
        head.append(ptChip(ptMsg('uplift.patches.safeguard_hold', 'AUTO-APPLY HELD'),
            'pt-st-warn', p.state_detail || ''));
    }
    if (p.keg_changed && p.enabled)
        head.append(ptChip(ptMsg('uplift.patches.keg_changed', 'KEG CHANGED'), 'pt-st-warn',
            ptMsg('uplift.patches.keg_changed_hint',
                  'vanilla omlx was upgraded — the patch re-validates on next start')));
    if (p.state_detail) {
        const det = document.createElement('span');
        det.className = 'pt-detail';
        det.textContent = p.state_detail;
        head.append(det);
    }
    card.append(head);

    // source line + advisory warnings (plaintext/credentials policy)
    const src = document.createElement('div');
    src.className = 'pt-src';
    const s = p.source || {};
    let srcTxt;
    if (s.kind === 'github_pr') srcTxt = `github PR ${s.repo || ''}#${s.pr || ''}`;
    else if (s.kind === 'url') srcTxt = s.url || 'url';
    else srcTxt = ptMsg('uplift.patches.source_upload', 'uploaded file');
    src.textContent = srcTxt;
    if (s.url) {
        const a = document.createElement('a');
        a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = ' ↗';
        src.append(a);
    }
    card.append(src);
    for (const adv of (p.advisories || [])) {
        const w = document.createElement('div');
        w.className = 'pt-advisories';
        w.textContent = '⚠ ' + adv;
        card.append(w);
    }

    // versions row: v<n> chips, applied one marked
    const vers = document.createElement('div');
    vers.className = 'pt-vers';
    for (const v of (p.versions || []).slice().sort((a, b) => a.v - b.v)) {
        const isApplied = p.applied_v === v.v;
        const isDesired = p.desired_version === v.v;
        const isCandidate = !isDesired && v.v === Math.max(...(p.versions || []).map(x => x.v));
        const chip = ptChip('v' + v.v + (isApplied ? ' ●' : isDesired ? ' ◐' : ''),
            isApplied ? 'pt-st-applied' : (isCandidate && p.state === 'update_available') ? 'pt-st-update' : 'pt-st-dim',
            (v.fetched_at || '') + (v.source_head_sha ? ' · ' + v.source_head_sha.slice(0, 12) : ''));
        chip.style.cursor = 'pointer';
        chip.title = ptMsg('uplift.patches.show_diff', 'show stored diff') + ' — ' + chip.title;
        chip.onclick = () => ptShowDiff(p.id, v.v);
        vers.append(chip);
    }
    card.append(vers);

    // safeguards: flagged problems, autodetected root, rebuild command,
    // per-code approvals (the note names the EXCEPTIONS, not a blanket off)
    const sgLines = ptSafeguardLines(p);
    const approved = p.safeguard_always || [];
    if (sgLines.length || approved.length) {
        const box = document.createElement('div');
        box.className = 'pt-safeguards';
        if (sgLines.length) {
            const t = document.createElement('div');
            t.className = 'pt-sg-title';
            t.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(t);
            for (const l of sgLines) {
                const row = document.createElement('div');
                row.className = 'pt-advisories';
                row.textContent = '⚠ ' + l.text;
                box.append(row);
            }
        }
        if (p.kernel_rebuild_hint) {
            const row = document.createElement('div');
            row.className = 'pt-sg-rebuild';
            const lbl = document.createElement('span');
            lbl.textContent = ptMsg('uplift.patches.safeguard_rebuild',
                'Native kernel rebuild (required for real effect):');
            const cmd = document.createElement('code');
            cmd.textContent = p.kernel_rebuild_hint;
            cmd.title = 'click to copy';
            cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); };
            row.append(lbl, document.createTextNode(' '), cmd);
            box.append(row);
        }
        if (approved.length) {
            const a = document.createElement('div');
            a.className = 'pt-detail';
            a.textContent = '✓ ' + ptMsg('uplift.patches.approved_codes',
                'approved: {codes}').replace('{codes}', approved.join(', '));
            box.append(a);
        }
        card.append(box);
    }

    // action row: buttons wired to PAT-2 endpoints
    const acts = document.createElement('div');
    acts.className = 'pt-acts';
    const btn = (label, cls, fn, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (cls ? ' ' + cls : '');
        b.textContent = label;
        if (title) b.title = title;
        b.onclick = fn;
        acts.append(b);
        return b;
    };
    if (!p.enabled) {
        if (heldCodes.length) {
            btn(ptMsg('uplift.patches.approve_once', 'Apply once anyway'), 'primary',
                () => ptEnableWithApproval(p, 'once'),
                ptMsg('uplift.patches.approve_once_title',
                      'Approve the flagged safeguards for this version only'));
            btn(ptMsg('uplift.patches.approve_always', 'Always allow ({codes})')
                    .replace('{codes}', heldCodes.join(', ')), 'primary',
                () => ptEnableWithApproval(p, 'always'),
                ptMsg('uplift.patches.approve_always_title',
                      'Remember these safeguard codes for future versions of this patch'));
        } else {
            btn(ptMsg('uplift.patches.enable', 'Enable'), 'primary',
                () => ptEnableWithApproval(p, null),
                ptMsg('uplift.patches.enabled_toast',
                      'Enabled — applies on next omlx restart'));
        }
    } else {
        btn(ptMsg('uplift.patches.disable', 'Disable'), '',
            () => ptAction('disable', { id: p.id },
                ptMsg('uplift.patches.disabled_toast', 'Disabled — files restored on next omlx restart')));
    }
    if (p.state === 'update_available') {
        const doPromote = (approve) => ptAction('promote',
            approve ? { id: p.id, approve } : { id: p.id },
            ptMsg('uplift.patches.promoted', 'Promoted — applies on next omlx restart'));
        if (heldCodes.length) {
            btn(ptMsg('uplift.patches.approve_once', 'Apply once anyway'), 'primary',
                () => doPromote('once'),
                ptMsg('uplift.patches.approve_once_title',
                      'Approve the flagged safeguards for this version only'));
            btn(ptMsg('uplift.patches.approve_always', 'Always allow ({codes})')
                    .replace('{codes}', heldCodes.join(', ')), 'primary',
                () => doPromote('always'),
                ptMsg('uplift.patches.approve_always_title',
                      'Remember these safeguard codes for future versions of this patch'));
        } else {
            btn(ptMsg('uplift.patches.promote', 'Promote update'), 'primary',
                () => doPromote(null));
        }
    }
    const vs = (p.versions || []).map(v => v.v).sort((a, b) => a - b);
    if (p.desired_version && vs.length > 1 && p.state !== 'disabled') {
        btn(ptMsg('uplift.patches.rollback', 'Rollback'), '',
            () => ptAction('rollback', { id: p.id },
                ptMsg('uplift.patches.rolledback', 'Rollback queued for next omlx restart')));
    }
    btn(ptMsg('uplift.patches.test', 'Test dry-run'), '', async () => {
        if (S.PT_BUSY) return;
        S.PT_BUSY = true;
        try {
            const r = await ptApi('test', { id: p.id });
            const bad = (r.files || []).filter(f => f.status === 'fail')
                .map(f => f.path + ': ' + (f.reason || 'fail'));
            toast(bad.length
                ? ptMsg('uplift.patches.test_fail', 'Dry-run FAILED') + ': ' + bad.join('; ')
                : ptMsg('uplift.patches.test_ok', 'Dry-run OK — patch applies cleanly now'),
                bad.length ? 7000 : 4000);
            await pollPatches();
        } catch (e) { toast(String(e), 5000); } finally { S.PT_BUSY = false; }
    });
    btn(ptMsg('uplift.patches.remove', 'Remove'), '', async () => {
        if (!confirm(ptMsg('uplift.patches.remove_confirm',
            'Remove this patch? Applied files are restored to vanilla bytes now.'))) return;
        await ptAction('remove', { id: p.id },
            ptMsg('uplift.patches.removed', 'Patch removed'));
    });
    card.append(acts);
    return card;
}

async function ptShowDiff(id, v) {
    try {
        const res = await fetch(`${API}/uplift/api/patches/diff/${id}/${v}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        $('pt-diff-title').textContent = `${id} · v${v}`;
        const body = $('pt-diff-body');
        body.innerHTML = '';
        for (const line of txt.split('\n')) {
            const s = document.createElement('span');
            s.className = line.startsWith('+') && !line.startsWith('+++') ? 'pt-diff-add'
                : line.startsWith('-') && !line.startsWith('---') ? 'pt-diff-del'
                : line.startsWith('@@') ? 'pt-diff-hunk' : '';
            s.textContent = line + '\n';
            body.append(s);
        }
        $('pt-diff').hidden = false;
        $('pt-diff').scrollIntoView({ block: 'nearest' });
    } catch (e) {
        toast(ptMsg('uplift.patches.diff_fail', 'Could not load diff') + ': ' + e, 5000);
    }
}

/* ---- add flow: kind-aware inputs -> preview (per-file gate table) -> enable */

function ptReadSource() {
    const kind = $('pt-src-kind').value;
    const insecure_tls = $('pt-insecure-tls').checked;
    if (kind === 'github_pr') {
        return { kind, repo: $('pt-src-repo').value.trim(),
                 pr: parseInt($('pt-src-pr').value, 10) || null, insecure_tls };
    }
    if (kind === 'url') return { kind, url: $('pt-src-url').value.trim(), insecure_tls };
    return { kind: 'upload' };   // data filled from file input below
}

function ptSyncKindUI() {
    const kind = $('pt-src-kind').value;
    $('pt-src-repo').hidden = kind !== 'github_pr';
    $('pt-src-pr').hidden = kind !== 'github_pr';
    $('pt-src-url').hidden = kind !== 'url';
    $('pt-src-file').hidden = kind !== 'upload';
}

async function ptPreview() {
    const id = $('pt-new-id').value.trim();
    if (!id) {
        toast(ptMsg('uplift.patches.need_id', 'Give the patch an id first'), 4000);
        return;
    }
    const src = ptReadSource();
    const body = { id, ...src };
    if (src.kind === 'upload') {
        const f = $('pt-src-file').files[0];
        if (!f) { toast(ptMsg('uplift.patches.need_file', 'Pick a .diff file'), 4000); return; }
        body.data = await f.text();
    }
    const box = $('pt-preview');
    const adv = $('pt-advisories');
    try {
        const r = await ptApi('add', body);
        adv.hidden = !(r.advisories && r.advisories.length);
        adv.innerHTML = '';
        for (const a of (r.advisories || [])) {
            const w = document.createElement('div');
            w.textContent = '⚠ ' + a;
            adv.append(w);
        }
        box.hidden = false;
        box.innerHTML = '';
        if (r.requires_approval && r.requires_approval.length) {
            const sgt = document.createElement('div');
            sgt.className = 'pt-sg-title';
            sgt.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(sgt);
            for (const pr of ((r.safeguards || {}).problems || [])) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + pr.path + ' — ' + pr.message;
                box.append(w);
            }
            if (r.note) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + ptMsg('uplift.patches.safeguard_note',
                    'Root autodetected: {n}').replace('{n}', r.note);
                box.append(w);
            }
        }
        const tbl = document.createElement('div');
        tbl.className = 'pt-gate';
        const head = document.createElement('div');
        head.className = 'pt-gate-row pt-gate-head';
        const ht = document.createElement('span');
        // r.ok is the verdict — never claim "gate passed" for a rejected
        // patch (a GNU `diff -ruN` upload once showed green on a parse fail)
        ht.textContent = !r.ok
            ? ptMsg('uplift.patches.preview_fail', 'REJECTED — gate failed')
            : r.adopted
            ? ptMsg('uplift.patches.adopted',
                'ALREADY APPLIED — stored as APPLIED, will re-apply after an omlx update')
            : r.obsolete
            ? ptMsg('uplift.patches.obsolete', 'ALREADY PRESENT upstream — patch looks obsolete')
            : (r.unchanged
                ? ptMsg('uplift.patches.unchanged', 'stored version already matches the source')
                : ptMsg('uplift.patches.preview_ok', 'VALIDATED — gate passed'));
        ht.className = (!r.ok || (r.obsolete && !r.adopted) || r.unchanged)
            ? 'pt-fail' : 'pt-ok';
        head.append(ht);
        tbl.append(head);
        if (!r.ok && r.reason) {
            const why = document.createElement('div');
            why.className = 'pt-gate-row';
            const w = document.createElement('span');
            w.className = 'pt-detail';
            w.textContent = r.reason;
            why.append(w);
            tbl.append(why);
        }
        for (const f of (r.files || [])) {
            const row = document.createElement('div');
            row.className = 'pt-gate-row';
            const st = document.createElement('span');
            st.className = 'pt-chip ' + (f.status === 'ok' ? 'pt-st-applied'
                : f.status === 'already' ? 'pt-st-update' : 'pt-st-warn');
            st.textContent = f.status.toUpperCase();
            const pth = document.createElement('span');
            pth.textContent = f.path;
            row.append(st, pth);
            if (f.reason) {
                const why = document.createElement('span');
                why.className = 'pt-detail';
                why.textContent = f.reason;
                row.append(why);
            }
            tbl.append(row);
        }
        box.append(tbl);
        if (r.ok && !r.unchanged && !r.adopted) {
            const en = document.createElement('button');
            en.type = 'button';
            en.className = 'btn primary';
            const held = r.requires_approval || [];
            en.textContent = held.length
                ? ptMsg('uplift.patches.approve_once', 'Apply once anyway')
                : ptMsg('uplift.patches.enable_now', 'Enable patch');
            en.onclick = async () => {
                await ptEnableWithApproval({ id }, held.length ? 'once' : null);
                box.hidden = true;
                $('pt-new-id').value = '';
            };
            box.append(en);
            if (held.length) {
                const al = document.createElement('button');
                al.type = 'button';
                al.className = 'btn primary';
                al.textContent = ptMsg('uplift.patches.approve_always',
                    'Always allow ({codes})').replace('{codes}', held.join(', '));
                al.onclick = async () => {
                    await ptEnableWithApproval({ id }, 'always');
                    box.hidden = true;
                    $('pt-new-id').value = '';
                };
                box.append(al);
            }
        }
    } catch (e) {
        adv.hidden = false;
        adv.innerHTML = '';
        const w = document.createElement('div');
        w.textContent = '✕ ' + (e && e.message ? e.message : e);
        adv.append(w);
        box.hidden = true;
    }
}

let PT_CHECK_TIMER = null;
function ptScheduleAutoCheck() {
    // hourly drift check while the page is open AND the user opted in (PAT-2
    // config flag drives the same endpoint the collector would use)
    clearInterval(PT_CHECK_TIMER);
    PT_CHECK_TIMER = setInterval(() => {
        if (!document.hidden && currentTab() === 'settings' && currentSub('settings') === 'patches'
                && S.PT_DATA && S.PT_DATA.config && S.PT_DATA.config.auto_update_check) {
            ptCheckNow(true);
        }
    }, 3600e3);
}

async function ptCheckNow(quiet) {
    const b = $('pt-check-btn');
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    const old = b.textContent;
    b.textContent = ptMsg('uplift.patches.checking', 'Checking…');
    b.disabled = true;
    try {
        const r = await ptApi('check', {});
        const reports = r.reports || {};
        const notes = Object.entries(reports).map(([id, rep]) => {
            if (rep.check === 'update_available')
                return id + ': ' + ptMsg('uplift.patches.update_avail_toast', 'update available (v{v})').replace('{v}', rep.v);
            if (rep.check === 'obsolete') return id + ': ' + ptMsg('uplift.patches.obsolete', 'obsolete');
            if (rep.check === 'error') return id + ': ' + ptMsg('uplift.patches.check_error', 'check failed') + ' — ' + rep.reason;
            return null;
        }).filter(Boolean);
        if (!quiet || notes.length)
            toast(notes.length ? notes.join(' · ')
                : ptMsg('uplift.patches.all_current', 'All patch sources current'), 6000);
        await pollPatches();
    } catch (e) {
        toast(ptMsg('uplift.patches.check_fail', 'Check failed') + ': ' + e, 5000);
    } finally {
        b.textContent = old;
        b.disabled = false;
        S.PT_BUSY = false;
    }
}

function initPatchesPage() {
    ptSyncKindUI();
    $('pt-src-kind').onchange = ptSyncKindUI;
    $('pt-preview-btn').onclick = ptPreview;
    $('pt-check-btn').onclick = () => ptCheckNow(false);
    $('pt-diff-close').onclick = () => { $('pt-diff').hidden = true; };
    ptScheduleAutoCheck();
}
initPatchesPage();

CH.renderCardTsRows();
CH.drawAllMetricCharts();
setInterval(() => { if (!document.hidden && currentTab() === 'status') CH.drawAllMetricCharts(); }, 5000);
UUP.initUsageRange();   // seeds the range select now that glue helpers exist
UUP.pollUsage(); UUP.pollLogs();
connectEventStream();
setInterval(pollGatewayInfo, 10000);
setInterval(() => { if (!document.hidden) pollRequests(); }, 2000);
setInterval(() => { if (!document.hidden && !MM.seModel) MM.render(); }, 8000);
setInterval(() => { if (!document.hidden && currentTab() === 'usage') UUP.pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && UUP.logsFollow) UUP.pollLogs(); }, 5000);
})();
