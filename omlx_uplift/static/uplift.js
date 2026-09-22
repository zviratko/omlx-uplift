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
    get SECRET_KEYS() { return window.Uplift.gsys.SECRET_KEYS; },
    get gsDisplay() { return window.Uplift.gsys.gsDisplay; },
    get cell() { return cell; },
    get emptyMsg() { return emptyMsg; },
    get putModelSettings() { return putModelSettings; },
    get postModelAction() { return postModelAction; },
};
const MM = window.Uplift.modelmgr;

/* PH2-1 stage 6: global-settings form lives in uplift_gsys.js. Helpers that
   must stay in uplift.js (boot sequence + gateway chip own them) late-bind
   through this glue; GW_LIVE is a mutable let -> getter. */
window.Uplift._gsysGlue = {
    get toast() { return toast; },
    get fetchJson() { return fetchJson; },
    get postJson() { return postJson; },
    get emptyMsg() { return emptyMsg; },
    get loadLocale() { return loadLocale; },
    get currentTab() { return currentTab; },
    get cell() { return cell; },
    get GW_LIVE() { return GW_LIVE; },
};
const GSY = window.Uplift.gsys;

window.Uplift._reqGlue = {
    get fetchJson() { return fetchJson; },
    get openInspector() { return window.Uplift.modelmgr.openInspector; },
    get renderReqFeed() { return window.Uplift.feed.renderReqFeed; },
    get reqFeedRows() { return S.reqFeedRows; },
};

/* PH2-1 stage 7: event feed + request lifecycle feed live in
   uplift_feed.js; fetchJson is hoisted here, motionOff reads live DOM state,
   openInspector resolves through modelmgr. */
window.Uplift._feedGlue = {
    get fetchJson() { return fetchJson; },
    get motionOff() { return motionOff; },
    get toast() { return toast; },
};
const FE = window.Uplift.feed;

/* PH2-1 stage 8: PAT-4 patches UI lives in uplift_patches.js. toast/
   fetchJson are hoisted here; currentTab/currentSub read the live hash. */
window.Uplift._patchesGlue = {
    get toast() { return toast; },
    get fetchJson() { return fetchJson; },
    get currentTab() { return currentTab; },
    get currentSub() { return currentSub; },
};
const PT = window.Uplift.patches;

/* PH2-1 stage 9a: downloader page + task helpers live in
   uplift_downloader.js; shared helpers late-bind through this glue. */
window.Uplift._downloaderGlue = {
    get fetchJson() { return fetchJson; },
    get postJson() { return postJson; },
    get toast() { return toast; },
    get emptyMsg() { return emptyMsg; },
    get cell() { return cell; },
};
const DLR = window.Uplift.downloader;

/* PH2-1 stage 9b: quantizer/uploader pages live in uplift_modelsops.js. */
window.Uplift._modelsopsGlue = {
    get fetchJson() { return fetchJson; },
    get postJson() { return postJson; },
    get toast() { return toast; },
    get cell() { return cell; },
    get emptyMsg() { return emptyMsg; },
    get GW_LIVE() { return GW_LIVE; },
};
const MOs = window.Uplift.modelsops;

/* PH2-1 stage 9c: helper page + prune dialog live in uplift_helper.js. */
window.Uplift._helperGlue = {
    get fetchJson() { return fetchJson; },
    get postJson() { return postJson; },
    get toast() { return toast; },
    get cell() { return cell; },
    get emptyMsg() { return emptyMsg; },
    get GW_LIVE() { return GW_LIVE; },
};
const HLP = window.Uplift.helper;
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
        GSY.gsLocalize();
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
        if (sub === 'downloader') DLR.initDownloader();
        if (sub === 'quantizer') MOs.renderQuantizer();
        if (sub === 'uploader') MOs.renderUploader();
        if (sub === 'helper') HLP.renderHelperModels();
        if (sub === 'manager') MM.renderTemplates();
    }
    if (tab === 'settings') {
        GSY.pollGlobalSettings(); GSY.pollEnvTunables();
        if (sub === 'patches') PT.pollPatches();
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

/* ---- event feed / reactions: extracted to uplift_feed.js (PH2-1 stage 7);
   window.Uplift.feed aliases live at the top. ---- */

/* toast is shared: 40+ call sites here plus every extracted module's glue
   (modelmgr/gsys/usage/reqsearch/feed) resolve it through the glues below. */
function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
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
        // normalize() exposes request ids as `rid`, not `request_id` —
        // reading the raw name left reqId undefined and every per-request
        // affordance (inspect badge, loop hint) dead.
        for (const p of m.prefilling) rows.push({ model: m.id, kind: C.t('uplift.inflight.prefilling'), prompt: p.prompt, progress: p.progress, reqId: p.rid });
        for (const g of m.generating) rows.push({ model: m.id, kind: C.t('uplift.inflight.generating'), prompt: g.prompt, generated: g.generated, tps: g.tps, reqId: g.rid });
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
        // ISSUE-5: the state badge doubles as the INSPECT affordance — the
        // row is already dense and a second button would crowd it. Only for
        // rows with a real request id (rank0 aggregate rows have none).
        if (r.reqId && r.reqId !== 'rank0') {
            badge.classList.add('act');
            badge.style.cursor = 'pointer';
            badge.title = C.t('uplift.req.inspect_title');
            badge.onclick = () => MM.openInspector(r.reqId);
        }
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
        if (r.reqId && S.reqFeedRows.get(r.reqId)?.loopHint) {   // RL-4 amber
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
        if (S.milestoneFloor.requests === undefined && s.requests !== null)
            S.milestoneFloor.requests = C.milestoneFloorOf(s.requests);
        if (S.milestoneFloor.totalTokens === undefined && s.totalTokens !== null)
            S.milestoneFloor.totalTokens = C.milestoneFloorOf(s.totalTokens);
        tracker.observe(s);
        render(s);
        FE.reactTo(events);
        for (const mi of FE.gateMilestones(miles)) FE.celebrate(FE.milestoneQuip(mi));
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
/* gsSavedAt -> S.gsSavedAt (shared cell, uplift_state.js; written by uplift_gsys.js save flow) */
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
    if (gs && Date.now() - S.gsSavedAt > 5000) gs.textContent = live
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

/* ---- request lifecycle feed: extracted to uplift_feed.js (PH2-1 stage 7). ---- */

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

/* ---- global settings (Settings tab form + env tunables + cluster gate):
   extracted to uplift_gsys.js (PH2-1 stage 6); window.Uplift.gsys alias
   lives at the top with the other glue. ---- */

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.status + ' ' + r.statusText);
    return d;
}
/* ---- task-row helpers + HF downloader page: extracted to
   uplift_downloader.js (PH2-1 stage 9a); window.Uplift.downloader alias
   lives at the top with the other glue. ---- */

/* ---- oQ quantizer + uploader pages: extracted to uplift_modelsops.js
   (PH2-1 stage 9b); window.Uplift.modelsops alias lives at the top. ---- */

/* ---- helper models page + prune dialog: extracted to uplift_helper.js
   (PH2-1 stage 9c); window.Uplift.helper alias lives at the top. ---- */

/* ---------------- boot: moved verbatim to uplift_boot.js (PH2-1 stage 8),
   loaded after this file; internals reach it through _bootGlue below. ---- */
/* PH2-1 stage 8: boot sequence (uplift_boot.js, loaded last) needs these
   hoisted internals + the tab readers. Function declarations — stable. */
window.Uplift._bootGlue = {
    fetchJson, applyPrefs, loadLocale, applyTab, restartPolling,
    pollStats, pollGatewayInfo, currentTab, currentSub,
    renderTasks: function () { return window.Uplift.downloader.renderTasks.apply(null, arguments); },
};
})();
