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
        // UP-5: JS-built labels the static applyI18n pass cannot reach.
        if (window.Uplift.usage) {
            window.Uplift.usage.relabelUsageRange();
            window.Uplift.usage.renderUsageSub();
        }
        if (typeof renderSkinsMenu === 'function' && SKIN_BASES.size) renderSkinsMenu();
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
        caret.dataset.icon = 'caret';   // skin icon hook (rebuilt spans need it too)
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
        if (sub === 'patches') { PT.pollPatches(); PT.pollDev && PT.pollDev(); }
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
    const skin = (typeof skinLookup === 'function') ? skinLookup(t) : null;
    let eff = t;
    if (t === 'auto') eff = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // a resolved skin scopes its own compiled CSS with html[data-theme="<dir>"]
    if (skin) eff = skin.dir;
    else if (typeof t === 'string' && C.SKIN_NAME_RE.test(t) && !C.THEMES.includes(t)) {
        // ISSUE-3 (skin -> theme dead): SKIN_NAME_RE also matches the plain
        // built-in names ('dark', 'light', ...). Without the THEMES guard a
        // click on Night re-read the cached skin dir and kept painting the
        // old skin — leaving a theme was impossible until localStorage died.
        // listing not loaded yet (boot order) or fetch failed: the cached
        // dir keeps data-theme scoped to the skin's stylesheet instead of
        // flashing the built-in theme until loadSkins() resolves (~0.8s)
        try {
            const cached = localStorage.getItem('omlx-uplift-skin-dir');
            if (cached && C.SKIN_NAME_RE.test(cached)) eff = cached;
        } catch (_) { /* storage may be denied */ }
    }
    // dir cache for the pre-paint boot script (index.html): newest-dir for
    // a base-name selection is only knowable after loadSkins(), so write it
    // every time it resolves and clear it for built-in selections
    try {
        if (skin) localStorage.setItem('omlx-uplift-skin-dir', skin.dir);
        else if (!C.SKIN_NAME_RE.test(t || '')) localStorage.removeItem('omlx-uplift-skin-dir');
    } catch (_) { /* storage may be denied */ }
    document.documentElement.dataset.theme = eff;
    // same dir decision for the <link>: passing null here would DELETE the
    // boot script's pre-paint link and re-flash before loadSkins() resolves
    const cssDir = skin ? skin.dir
        : (typeof t === 'string' && C.SKIN_NAME_RE.test(t) && typeof eff === 'string'
           && /-\d{10}$/.test(eff) ? eff : null);
    if (typeof applySkinCss === 'function') applySkinCss(cssDir);
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
    // a custom skin drives classic pages through its own classic: mapping
    // (server-computed, incl. the bg-luminance default); unknown or broken
    // selection -> dark is the safe default, not an invalid 'light' push
    const skin = (typeof skinLookup === 'function') ? skinLookup(prefs.theme) : null;
    if (skin) {
        return { theme: skin.classic && skin.classic.theme === 'light' ? 'light' : 'dark',
                 enhanced: !!(skin.classic && skin.classic.enhanced) };
    }
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

/* ---------------- user skins (skin system v1) ----------------------------
   Skins are CSS-only themes the user drops into ~/.omlx/uplift/skins/ as a
   <name>.yml crate; the server extracts/serves them (no restart). The
   listing lives server-side; we mirror it here for the picker and for
   data-theme resolution. prefs.theme stores the base name (follow newest)
   or an exact '<name>-<mtime>' (pin a version). Compiled theme.css rides on
   ONE <link id="uplift-skin-css"> revalidated by ETag — a refresh costs a
   304, same cache story as uplift.css. */
const SKINS = new Map();          // dir name -> entry
const SKIN_BASES = new Map();     // base name -> newest entry
function skinLookup(sel) {
    if (!sel || C.THEMES.includes(sel)) return null;
    if (!C.SKIN_NAME_RE.test(sel)) return null;
    return SKINS.get(sel) || SKIN_BASES.get(sel) || null;
}
async function loadSkins() {
    try {
        const d = await fetchJson(`${API}/uplift/api/skins`);
        SKINS.clear(); SKIN_BASES.clear();
        for (const e of (d.skins || [])) {
            if (!e.dir) continue;           // broken crate: no working copy
            SKINS.set(e.dir, e);
            const base = e.name.replace(/-\d{10}$/, '');
            const cur = SKIN_BASES.get(base);
            if (!cur || e.ts > cur.ts) SKIN_BASES.set(base, e);
        }
        renderSkinsMenu();
        applyPrefs();                        // selection may now resolve
    } catch (_) { /* no skins endpoint (viewer mode?) — built-ins only */ }
}
function renderSkinsMenu() {
    const menu = $('dd-theme-menu');
    menu.querySelectorAll('.skin-entry,.skin-sep').forEach(n => n.remove());
    const all = [...SKINS.values()].sort((a, b) => {
        const ba = a.name.replace(/-\d{10}$/, ''), bb = b.name.replace(/-\d{10}$/, '');
        return ba < bb ? -1 : ba > bb ? 1 : b.ts - a.ts;   // base, then newest first
    });
    if (!all.length) return;
    const sep = document.createElement('span');
    sep.className = 'skin-sep';
    sep.textContent = C.t('uplift.theme.skins_heading');
    menu.appendChild(sep);
    const want = prefs.theme || 'auto';
    for (const e of all) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'skin-entry';
        a.dataset.pick = e.name;             // base name or pinned version dir
        // newest shows its label under the base name; older versions show
        // the exact pinned name (what clicking stores) — design section 2.3
        a.textContent = e.stale ? e.dir : e.label;
        a.classList.toggle('active', e.name === want);
        const hints = [];
        if (e.stale) hints.push(C.t('uplift.theme.stale_hint',
            { date: new Date(e.ts * 1000).toLocaleString() }));
        if (e.yml_newer) hints.push(C.t('uplift.theme.yml_newer'));
        if (hints.length) a.title = hints.join(' — ');
        menu.appendChild(a);
    }
}
// delegated: skin entries are rendered after the static anchors' listeners
$('dd-theme-menu').addEventListener('click', e => {
    const a = e.target.closest('a.skin-entry');
    if (!a) return;
    e.preventDefault();
    prefs.theme = a.dataset.pick;
    C.savePrefs(localStorage, prefs); applyPrefs();
    $('dd-theme-menu').hidden = true;
    toast(C.t('uplift.toast.theme_set', {theme: prefs.theme}));
});
function applySkinCss(dir) {
    let link = document.getElementById('uplift-skin-css');
    if (!dir) { if (link) link.remove(); return; }
    const href = `${API}/uplift/api/skins/${encodeURIComponent(dir)}/theme.css`;
    if (!link) {
        link = document.createElement('link');
        link.id = 'uplift-skin-css';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

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
        const gripMark = document.createElement('span'); gripMark.className = 'hatch'; gripMark.dataset.icon = 'grip';
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

/* IN-FLIGHT card (redesign): every loaded model gets a header line; each
   request gets ONE indented line that persists until page refresh — rows
   are reused across polls, never rebuilt, and keep their last data with a
   terminal badge (DONE/ABORTED/REFUSED) when the request leaves. Queued
   requests collapse into one expandable summary line per model whose child
   lines exist only while waiting. Clicking a request line opens INSPECT;
   ABORT sits at the line end (and in the inspector). */
// Terminal lines kept per model. 50 was a DOM cap that read as litter:
// an idle model kept its whole request history as DONE rows (user: "idle
// slots show DONE and accumulate"). 5 recent outcomes answer the only
// question a DONE row answers ("what just finished?"); older ones are
// dropped (never deleted elsewhere — the full record lives in the feed).
const IF_MAX_TERMINAL = 5;
/* ISSUE-4 (DONE rows on refresh): the ring buffer replay used to create a
   DONE line for every history row the server still remembers, so a page
   load painted 5 finished requests nobody watched and (worse) the newest
   of them looked live. Only requests THIS session saw arrive (a slot was
   created while they were queued/prefilling/generating) may end as DONE. */
const ifSawLive = new Set();     // rids observed active this page session
let ifSeq = 0;                   // ISSUE-5: monotonic birth order — a row's
                                 // place in the card is fixed at creation and
                                 // never changes when neighbours land/prune

function ifTerminal(rid) {
    const fr = S.reqFeedRows.get(rid);
    if (!fr) return null;
    const fin = String(fr.finish || '');
    if (fr.state === 'complete') return /abort/i.test(fin) ? 'aborted' : 'done';
    if (fr.state === 'error') {
        if (fr.errorCode) return 'refused';         // memory-guard refusal
        if (/abort/i.test(fin)) return 'aborted';
        return 'error';
    }
    return null;                                    // queued/generating = live
}

const IF_LINGER_MS = 8000;   // ISSUE-4: how long a landed row stays readable
/* U16 (user): "is specprefill indicated in the in-flight? I don't see it —
   it was there before." The redesign dropped any speculative marker and the
   stats snapshot never carried one per request (upstream gap). The engine's
   actual settings ARE available — poll /uplift/api/speculative once a
   minute and badge the model header in the card. */
const ifSpecBy = new Map();      // model id -> 'specprefill'|'dflash'|'vlm_mtp'|'mtp'
let ifSpecAt = 0, ifSpecFetching = false;
function ifSpecPoll() {
    const now = Date.now();
    if (ifSpecFetching || now - ifSpecAt < 60_000) return;
    ifSpecFetching = true; ifSpecAt = now;
    fetchJson(`${API}/uplift/api/speculative`)
        .then(d => {
            ifSpecBy.clear();
            for (const [mid, kind] of Object.entries((d && d.models) || {}))
                if (kind) ifSpecBy.set(mid, kind);
        })
        .catch(() => { ifSpecAt = 0; })          // retry on next poll
        .finally(() => { ifSpecFetching = false; });
}
function ifLand(sl, tstate, now) {
    // One path for every terminal transition: latch the badge, stamp the
    // landing time (eviction is timed from here), keep nothing else sticky.
    sl.terminal = true; sl.tstate = tstate; sl.termAt = now;
    ifPrune(sl.model);       // burst guard: cap terminal rows per model
}

function ifGroup(model) {
    let g = S.ifModels.find(x => x.model === model);
    if (g) return g;
    const el = document.createElement('div'); el.className = 'if-group';
    const h = document.createElement('div'); h.className = 'if-model';
    const nm = document.createElement('span'); nm.textContent = model; nm.title = model;
    h.append(nm);
    // U12: per-model memory line — the honest numbers upstream gives:
    // resident weights size + SSD cache + hot-cache bytes. No KV/prefill
    // split exists per model (upstream gap, see U12 ticket finding).
    const mm = document.createElement('span'); mm.className = 'if-mem-meta';
    h.append(mm);
    // U16: speculative-decoding badge on the model header (SPECPREFILL /
    // DFLASH / VLM MTP / MTP) — driven by ifSpecPoll(), hidden when the
    // model runs plain decode.
    const spec = document.createElement('span');
    spec.className = 'spill miss if-spec'; spec.style.display = 'none';
    h.append(spec);
    // QUEUED requests are ordinary slot rows now (see renderLive): one line
    // per request with #position · in · wait, exactly like the classic
    // active-models card. The old "QUEUED ×N (+)" summary collapsed them
    // behind a toggle nobody noticed — the counts it hid were the point.
    const wrap = document.createElement('div');
    el.append(h, wrap);
    const list = $('live-list');
    const ph = list.querySelector('.empty'); if (ph) ph.remove();
    list.append(el);
    g = { model, el, wrap, mm, spec };
    S.ifModels.push(g);
    return g;
}

function ifSlot(model, rid) {
    let sl = S.ifSlots.get(rid);
    if (sl) return sl;
    const g = ifGroup(model);
    sl = { model, rid, state: null, terminal: false, tstate: null,
           prompt: null, out: null, tps: null, elapsed: null, eta: null,
           processed: null, total: null, cached: null, qpos: null,
           lastSeen: Date.now(),
           seq: ++ifSeq };        // ISSUE-5: fixed birth position (see ifPaint)
    const row = document.createElement('div'); row.className = 'if-row';
    row.dataset.ifseq = String(sl.seq);      // ISSUE-5: stable order key
    const badge = document.createElement('span'); badge.className = 'badge Idle';
    const pbar = document.createElement('div'); pbar.className = 'pbar'; pbar.style.display = 'none';
    const pc = document.createElement('div'); pc.className = 'p-cached';
    pc.title = C.t('uplift.inflight.cached_prefix');
    const pl = document.createElement('div'); pl.className = 'p-live';
    pbar.append(pc, pl);
    const meta = document.createElement('span'); meta.className = 'if-meta';
    const chip = document.createElement('span'); chip.className = 'spill miss if-loop';
    chip.textContent = 'LOOP?'; chip.title = C.t('uplift.req.loop_hint'); chip.style.display = 'none';
    const idEl = document.createElement('span'); idEl.className = 'if-id';
    idEl.textContent = rid === 'rank0' ? 'rank0' : rid.slice(0, 8);
    idEl.title = rid;
    const abort = document.createElement('button');
    abort.type = 'button'; abort.className = 'se-btn act danger';
    abort.textContent = C.t('uplift.inflight.abort'); abort.title = C.t('uplift.req.cancel');
    abort.style.display = 'none';
    if (rid !== 'rank0') {
        abort.onclick = (e) => { e.stopPropagation(); ifAbort(rid, sl); };
        row.onclick = () => MM.openInspector(rid);   // item 6: line -> INSPECT
        row.title = C.t('uplift.req.inspect_title');
    }
    row.append(badge, pbar, meta, chip, idEl, abort);
    Object.assign(sl, { el: row, badge, pbar, pc, pl, meta, chip, abort });
    S.ifSlots.set(rid, sl);
    g.wrap.append(row);
    ifPrune(model);
    return sl;
}

function ifPrune(model) {
    const term = [...S.ifSlots.values()].filter(x => x.model === model && x.terminal);
    if (term.length <= IF_MAX_TERMINAL) return;
    for (const sl of term.slice(0, term.length - IF_MAX_TERMINAL)) {
        sl.el.remove(); S.ifSlots.delete(sl.rid);
    }
}

function ifAbort(rid, sl) {
    sl.abort.disabled = true;
    fetch(`${API}/admin/api/requests/${encodeURIComponent(rid)}/cancel`, { method: 'POST' })
        .then(async res => {
            if (res.status === 501) { toast(C.t('uplift.toast.no_cancel_route')); return; }
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
            toast(C.t('uplift.toast.cancelled', { id: rid.slice(0, 6) }));
        })
        .catch(err => { toast(C.t('uplift.toast.cancel_failed', { msg: err.message })); })
        .finally(() => { sl.abort.disabled = false; });
}

function ifPaint(sl) {
    const b = sl.badge;
    // relabel locale strings every tick (slots created before the locale
    // catalog loaded would otherwise pin the raw key forever)
    sl.abort.textContent = C.t('uplift.inflight.abort');
    sl.abort.title = C.t('uplift.req.cancel');
    sl.pc.title = C.t('uplift.inflight.cached_prefix');
    let label, cls;
    if (sl.terminal)      { label = C.t('uplift.inflight.' + sl.tstate); cls = sl.tstate; }
    else if (sl.state === 'prefilling') { label = C.t('uplift.inflight.prefilling'); cls = 'Prefilling'; }
    else if (sl.state === 'generating') { label = C.t('uplift.inflight.generating'); cls = 'Generating'; }
    else                  { label = C.t('uplift.inflight.queued'); cls = 'Queued'; }
    b.className = 'badge ' + cls; b.textContent = label;
    sl.el.classList.toggle('term', !!sl.terminal);
    // PREFILLING box fills from the left; cached prefix and computed prefill
    // are separate fills (cached only known on spec-prefill rows — then the
    // rest of the bar is honest single-colour).
    if (!sl.terminal && sl.state === 'prefilling' && sl.total > 0) {
        const cached = Math.min(sl.cached || 0, sl.total);
        const doneToks = Math.max(sl.processed || 0, cached);
        sl.pbar.style.display = '';
        sl.pc.style.width = (cached / sl.total * 100).toFixed(1) + '%';
        sl.pl.style.width = ((doneToks - cached) / sl.total * 100).toFixed(1) + '%';
    } else {
        sl.pbar.style.display = 'none';
    }
    const bits = [];
    // QUEUED (classic active-models parity): position, prompt size and the
    // wait so far — the three numbers that answer "why hasn't it started?"
    if (!sl.terminal && sl.state === 'queued') {
        if (sl.qpos) bits.push(`#${sl.qpos}`);
        if (sl.prompt) bits.push(`in ${C.fmtCompact(sl.prompt)}`);
        if (sl.elapsed != null) bits.push(`wait ${C.fmtDuration(Math.round(sl.elapsed))}`);
    } else {
        if (sl.prompt) bits.push(`in ${C.fmtCompact(sl.prompt)}`);
        if (sl.out) bits.push(`out ${C.fmtCompact(sl.out)}`);
        if (sl.tps) bits.push(`${Math.round(sl.tps)} t/s`);
        if (!sl.terminal && sl.state === 'prefilling' && sl.total > 0)
            bits.push(`${Math.round((sl.processed || 0) / sl.total * 100)}%`);
        if (!sl.terminal && sl.eta != null) bits.push(`eta ${C.fmtDuration(Math.round(sl.eta))}`);
        if (sl.elapsed != null) bits.push(C.fmtDuration(Math.round(sl.elapsed)));
    }
    sl.meta.textContent = bits.join(' · ');
    sl.chip.style.display = (!sl.terminal && sl.rid !== 'rank0' && S.reqFeedRows.get(sl.rid)?.loopHint) ? '' : 'none';
    sl.abort.style.display = (!sl.terminal && sl.rid !== 'rank0') ? '' : 'none';
}

function renderLive(s) {
    const now = Date.now();
    ifSpecPoll();          // U16: once a minute; renders with whatever landed
    const seen = new Set();
    const waitingBy = new Map();
    const cacheBy = new Map((s.cacheModels || []).map(cm => [cm.id, cm]));
    for (const m of s.models) {
        const g = ifGroup(m.id);             // item 1: every loaded model, always
        // U12: per-model memory meta — resident weights + SSD cache + hot
        // cache. Upstream has no per-model KV/prefill split (finding).
        const cm = cacheBy.get(m.id);
        const parts = [];
        if (m.sizeText || m.size) parts.push(C.t('uplift.inflight.mem_weights', { size: m.sizeText || C.fmtBytes(m.size) }));
        if (cm && cm.totalBytes) parts.push(C.t('uplift.inflight.mem_cache', { size: C.fmtBytes(cm.totalBytes) }));
        if (cm && cm.hotBytes) parts.push(C.t('uplift.inflight.mem_hot', { size: C.fmtBytes(cm.hotBytes) }));
        g.mm.textContent = parts.join(' · ');
        // U16: speculative badge — label straight from the kind (never
        // translated: SPECPREFILL/DFLASH/MTP are engine setting names).
        const kind = ifSpecBy.get(m.id);
        if (kind && g.spec) {
            g.spec.textContent = kind.toUpperCase().replace('_', ' ');
            g.spec.title = C.t('uplift.inflight.spec_hint', { kind });
            g.spec.style.display = '';
        } else if (g.spec) g.spec.style.display = 'none';
        waitingBy.set(m.id, m.waiting || []);
        for (const p of m.prefilling) {
            seen.add(p.rid);
            ifSawLive.add(p.rid);       // ISSUE-4: birth observed this session
            const sl = ifSlot(m.id, p.rid);
            if (sl.terminal) { sl.terminal = false; sl.tstate = null; }  // RESURRECT: stats show it live again — a latched DONE must unlatch or the badge lies while counters run
            sl.state = 'prefilling';
            if (p.prompt != null) sl.prompt = p.prompt;
            if (p.processed != null) sl.processed = p.processed;
            if (p.total != null) sl.total = p.total;
            if (p.cached != null) sl.cached = p.cached;
            if (p.progress != null && sl.total == null) { sl.total = 1; sl.processed = p.progress; }
            if (p.eta != null) sl.eta = p.eta;
            if (p.elapsed != null) sl.elapsed = p.elapsed;
            sl.lastSeen = now;
        }
        for (const gg of m.generating) {
            seen.add(gg.rid);
            ifSawLive.add(gg.rid);      // ISSUE-4 (same as prefilling above)
            const sl = ifSlot(m.id, gg.rid);
            if (sl.terminal) { sl.terminal = false; sl.tstate = null; }  // RESURRECT (same as prefilling above)
            sl.state = 'generating'; sl.eta = null;
            if (gg.prompt != null) sl.prompt = gg.prompt;
            if (gg.generated != null) sl.out = gg.generated;
            if (gg.tps != null) sl.tps = gg.tps;
            if (gg.elapsed != null) sl.elapsed = gg.elapsed;
            sl.lastSeen = now;
        }
    }
    // vanished active rows -> terminal label from the feed (exact when known,
    // else frozen last data + DONE after a grace window — spec: keep line)
    for (const [rid, sl] of S.ifSlots) {
        if (sl.terminal || seen.has(rid)) continue;
        const t = ifTerminal(rid);
        if (t) { ifLand(sl, t, now); }
        // A QUEUED row absent from the queue for 15 s drained without a
        // terminal feed event (client disconnect, server-side drop); its
        // feed row can sit at state='queued' forever, so it gets its own
        // stale window instead of pinning the row indefinitely.
        else if (sl.state === 'queued' && now - sl.lastSeen > 15000) {
            ifLand(sl, 'done', now);
        }
        else if (!S.reqFeedRows.has(rid) && now - sl.lastSeen > 15000) {
            ifLand(sl, 'done', now);
        }
    }
    // short requests only the SSE/poll feed ever saw: brief terminal line
    for (const [rid, fr] of S.reqFeedRows) {
        const sl = S.ifSlots.get(rid);
        if (sl) {
            if (!sl.terminal && fr.state === 'complete') {
                ifLand(sl, ifTerminal(rid) || 'done', now);
            }
            continue;
        }
        // ISSUE-4: the /requests poll replays the server ring on every page
        // load — rows this session never saw arrive are history, not
        // in-flight outcomes. Never paint a terminal line for them.
        if (!ifSawLive.has(rid)) continue;
        const t = ifTerminal(rid);
        if (!t) continue;                    // live rows land via stats next tick
        const sl2 = ifSlot(fr.model || '?', rid);
        sl2.prompt = fr.prompt || null; sl2.out = fr.completion || null; sl2.tps = fr.tps || null;
        ifLand(sl2, t, now);
    }
    // ISSUE-4: the card shows IN-FLIGHT only. Terminal rows stay a few seconds
    // so the landing badge is readable, then leave — no DONE accumulation.
    for (const [rid, sl] of [...S.ifSlots]) {
        if (sl.terminal && now - sl.termAt > IF_LINGER_MS) {
            sl.el.remove(); S.ifSlots.delete(rid);
        }
    }
    // one QUEUED slot row per model — #position · in · wait, visible
    // without any expand (one line per request, classic-style). Queued
    // requests ride the same slot machinery as prefilling/generating.
    for (const [model, wait] of waitingBy) {
        // U15 (user: "queued requests jump order with each refresh"): the
        // scheduler snapshot exposes the waiting list in arbitrary order,
        // and slot birth order IS display order (seq). Create slots in the
        // server's queue-position order so a refresh reproduces FIFO order
        // instead of re-drawing whatever order the snapshot happened to
        // iterate. Rows already born keep their seq (place never moves in
        // a live session — ISSUE-5 unchanged).
        const ordered = wait.slice(0, 30).sort((a, b) =>
            (a.pos ?? Infinity) - (b.pos ?? Infinity));
        for (const w of ordered) {
            seen.add(w.rid);
            ifSawLive.add(w.rid);
            const sl = ifSlot(model, w.rid);
            if (sl.terminal) { sl.terminal = false; sl.tstate = null; }  // RESURRECT (same as prefilling above)
            sl.state = 'queued';
            if (w.pos != null) sl.qpos = w.pos;
            if (w.prompt != null) sl.prompt = w.prompt;
            if (w.waited != null) sl.elapsed = w.waited;
            sl.lastSeen = now;
        }
    }
    // ISSUE-5 (random order after a landing): rows must keep their birth
    // slot in the card. DOM append order already equals seq order for rows
    // born live, but a pruned-then-recaptured row would re-append at the
    // bottom; re-sort by seq so the list order never changes on a landing.
    for (const g of S.ifModels) {
        const kids = [...g.wrap.children].sort((a, b) => {
            const sa = +a.dataset.ifseq || 0, sb = +b.dataset.ifseq || 0;
            return sa - sb;
        });
        for (const k of kids) g.wrap.append(k);   // append moves in order
    }
    // ISSUE-4: hide model groups with nothing to show — no live row, nothing
    // queued. Loaded-but-idle models must not clutter the IN-FLIGHT card.
    for (const g of S.ifModels) {
        const busy = g.wrap.children.length || (waitingBy.get(g.model) || []).length;
        g.el.style.display = busy ? '' : 'none';
    }
    for (const sl of S.ifSlots.values()) ifPaint(sl);
    // every live row (queued, prefilling, generating) counts — queued
    // requests are slots now, so no separate queue tally
    let act = 0;
    for (const sl of S.ifSlots.values()) if (!sl.terminal) act++;
    const total = act;
    $('live-count').textContent = total ? String(total) : '';
    // ISSUE-4: honest placeholder whenever the card has nothing to show —
    // no models loaded, or every loaded model idle (groups hidden).
    const list = $('live-list');
    let ph = list.querySelector('.empty');
    if (!total) {
        if (!ph) {
            ph = document.createElement('div'); ph.className = 'empty';
            list.append(ph);
        }
        ph.textContent = C.t('uplift.empty.idle');   // relabel: catalog may load late
        ph.style.display = '';
    } else if (ph) ph.style.display = 'none';
}

/* Request sizes: prefer server-side full-population stats (gateway overlay);
   fall back to client-side session tracker when absent. */
/* U17 (user: percentile/completion/prompt tok and queue→first tok all read
   '—' while the model served): the client tracker only sees requests that
   COMPLETE inside a page-open session and resets on refresh. Pull full
   population stats from /uplift/api/requests/stats over the card's window,
   refetch on window change or every 15 s (percentile switches render from
   the cached response — it already carries p50..p99). */
let reqStatsCache = null, reqStatsAt = 0, reqStatsWin = '', reqStatsFetching = false;
function reqStatsParam() {
    // Same resolution as charts' cardWindow(): per-card override else global.
    const sec = layout.metricWin['reqstats'] ?? layout.chartWindowSec;
    const m = Math.max(1, Math.round(sec / 60));
    return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}
function reqStatsPoll() {
    const w = reqStatsParam();
    const now = Date.now();
    if (reqStatsFetching || (w === reqStatsWin && now - reqStatsAt < 15_000)) return;
    reqStatsFetching = true;
    fetchJson(`${API}/uplift/api/requests/stats?window=${w}`)
        .then(d => {
            if (d && d.prompt_tokens) { reqStatsCache = d; reqStatsWin = w; }
        })
        .catch(() => { reqStatsCache = null; })   // honest: no overlay, tracker fallback
        .finally(() => { reqStatsFetching = false; reqStatsAt = Date.now(); });
}
function renderRequestStats(s) {
    fillSelectOnce();
    reqStatsPoll();
    const p = PERCENTILES[layout.percentile];
    const server = (reqStatsCache && reqStatsWin === reqStatsParam())
        ? reqStatsCache : (s && s.requestStats ? s.requestStats : null);
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
    if (!res.ok) {
        // UP-4: the server's reason (FastAPI `detail`, incl. 422 arrays) was
        // thrown away — every failure read as a bare "-> 422". errorText()
        // (core.js, F-019) already flattens those bodies; use it here so all
        // catch sites (patch preview, toasts, downloader/uploader) inherit it.
        let reason = '';
        try { reason = C.errorText(await res.clone().json()); }
        catch (_) { try { reason = (await res.text()).slice(0, 200); } catch (__) {} }
        throw new Error(reason ? `${url} -> ${res.status}: ${reason}` : `${url} -> ${res.status}`);
    }
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
    pollStats, pollGatewayInfo, currentTab, currentSub, loadSkins,
    renderSkinsMenu,
    renderTasks: function () { return window.Uplift.downloader.renderTasks.apply(null, arguments); },
};
})();
