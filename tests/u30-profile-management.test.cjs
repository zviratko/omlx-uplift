/* UP-30 — profile-management depth in the model editor.
   vm-loads uplift_mmeditor.js + uplift_mmtemplates.js whole (the sanctioned
   dl1 pattern — the vm body concatenates ONLY the repository's own checked-in
   source, no external input) and drives the _u30 seams: the pure verbs
   behind classic's per-profile edit dialog (_modal_model_settings.html:
   202-235, dashboard.js:2472-2530), the two-step inline delete machine
   (classic delete_yes/delete_no — NEVER window.confirm), the RESYNC gate on
   p.source_template, the classic API-pill amber/green data (has_engine_fields,
   computed by the SERVER — omlx/model_settings.py:1389), and the real
   picker-row DOM through the stub. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_mmeditor.js'), 'utf8');
const TPL_SRC = fs.readFileSync(path.join(STATIC, 'uplift_mmtemplates.js'), 'utf8');

function makeDom() {
    function el(tag) {
        const node = {
            tagName: String(tag).toUpperCase(), children: [], _text: '',
            dataset: {}, style: {}, hidden: false, disabled: false,
            value: '', title: '', id: '', _classes: new Set(),
            parentNode: null,
        };
        node.classList = {
            add: (...cs) => cs.forEach(c => node._classes.add(c)),
            remove: (...cs) => cs.forEach(c => node._classes.delete(c)),
            toggle: (c, on) => {
                const want = on === undefined ? !node._classes.has(c) : !!on;
                if (want) node._classes.add(c); else node._classes.delete(c);
                return want;
            },
            contains: c => node._classes.has(c),
        };
        Object.defineProperty(node, 'className', {
            get() { return [...node._classes].join(' '); },
            set(v) { node._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
        });
        Object.defineProperty(node, 'textContent', {
            get() { return node._text; },
            set(v) {
                node._text = String(v);
                for (const c of node.children) c.parentNode = null;
                node.children.length = 0;   // real DOM: text wipes children
            },
        });
        node.append = (...cs) => {
            for (const c of cs) {
                if (c == null || typeof c !== 'object') continue;  // text children tolerated
                c.parentNode = node; node.children.push(c);
            }
        };
        node.remove = () => {
            if (!node.parentNode) return;
            const p = node.parentNode.children;
            const i = p.indexOf(node); if (i >= 0) p.splice(i, 1);
            node.parentNode = null;
        };
        node.addEventListener = () => {}; node.removeEventListener = () => {};
        node.setAttribute = () => {}; node.focus = () => {}; node.select = () => {};
        node.querySelector = sel => node.querySelectorAll(sel)[0] || null;
        node.querySelectorAll = sel => {
            const out = [];
            const want = String(sel).trim();
            const hit = c => (want.startsWith('.') && c._classes.has(want.slice(1)))
                || (want.startsWith('#') && c.id === want.slice(1))
                || c.tagName === want.toUpperCase();
            const walk = n => { for (const c of n.children) { if (hit(c)) out.push(c); walk(c); } };
            walk(node);
            return out;
        };
        return node;
    }
    const document = {
        body: el('body'),
        createElement: el,
        createTextNode: t => ({ _text: String(t), children: [], parentNode: null }),
        getElementById: () => null,
        querySelector: sel => document.body.querySelector(sel),
        querySelectorAll: sel => document.body.querySelectorAll(sel),
        addEventListener() {}, removeEventListener() {},
    };
    return { el, document };
}
function findAll(node, pred, out = []) {
    for (const c of node.children || []) {
        if (pred(c)) out.push(c);
        findAll(c, pred, out);
    }
    return out;
}

/* REAL stored-profile row shape from ModelSettingsManager.list_profiles
   (model_settings.py:1402-1413): name, display_name, description, api_name,
   expose_as_model, source_template, settings, model_id, has_engine_fields. */
const P_ENG = {
    name: 'fast', display_name: 'Fast', description: 'high-throughput',
    api_name: 'fast', expose_as_model: true, source_template: 'coding',
    model_id: 'M1:fast', has_engine_fields: true,
    settings: { temperature: 0.3 },
};
const P_PLAIN = {
    name: 'careful', display_name: 'Careful', description: '',
    api_name: '', expose_as_model: false, source_template: null,
    model_id: null, has_engine_fields: false,
    settings: { temperature: 1.0 },
};
const TPLS = [{ name: 'coding', display_name: 'Coding', description: 'd',
    settings: { temperature: 0.5 } }];

function load(routes) {
    const dom = makeDom();
    const calls = { fetch: [], post: [], put: [], del: [], toasts: [] };
    const R = routes || {};
    const route = (url, o) => {
        for (const k of Object.keys(R)) {
            if (url === k || url.endsWith(k)) {
                const v = R[k];
                if (typeof v === 'function') return v(url, o);
                if (v instanceof Error) throw v;
                return v;
            }
        }
        return {};
    };
    const win = { Uplift: { state: { API: '/adm' } } };
    win.UpliftCore = { t: k => k, tf: (k, en) => en, errorText: x => String(x) };
    win.UpliftDom = {
        $: id => dom.document.getElementById(id),
        fetchJson: async (url, o) => { calls.fetch.push([url, o]); return route(url, o); },
        postJson: async (url, b) => { calls.post.push([url, b]); return route(url, { method: 'POST' }); },
        putJson: async (url, b) => { calls.put.push([url, b]); return route(url, { method: 'PUT' }); },
        deleteJson: async (url) => { calls.del.push([url]); return route(url, { method: 'DELETE' }); },
        toast: (m, kind) => calls.toasts.push([m, kind]),
        cell: () => dom.el('span'), emptyMsg: () => {},
    };
    win.Uplift._modelGlue = {
        stats: () => 0, SECRET_KEYS: new Set(), gsDisplay: v => String(v),
        putModelSettings: async () => ({}),
        modelSettingsFields: async () => null,
        postModelAction: async () => ({}),
    };
    win.Uplift.mmChips = { clearProfileCache() {} };
    win.Uplift.mmTable = { render() {}, confirmDialog() {} };
    win.UpliftModelSpec = {
        RUNTIME_SETTING_KEYS: new Set(['mtp_enabled']),
        buildState: (m, s) => Object.assign({}, s),
        buildPayload: v => Object.assign({}, v),
        validate: () => [],
        adaptToServerSettings: o => o,
        runtimeDiff: () => [], requestDiff: () => [], mergeRawKwargs: () => [],
        llmLike: () => true, isDiffusion: () => false, showsA8Prefill: () => false,
        MODEL_TYPE_OPTIONS: [], TYPE_ONLY_KEYS: new Set(),
        VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES: new Set(),
        vlmMtpDrafters: () => [], dflashCandidates: () => [],
    };
    win.UpliftDirty = { applyRowState: () => false, renderChangesBox() {} };
    win.UpliftWidgets = { build: () => ({ el: dom.el('input'), kind: 'text' }) };
    vm.runInNewContext(SRC, {
        window: win, document: dom.document, console,
        localStorage: { _m: {}, getItem(k) { return this._m[k] || null; },
            setItem(k, v) { this._m[k] = String(v); } },
        setTimeout: f => setTimeout(f, 0), clearTimeout, URL, URLSearchParams,
    });
    return { seam30: win.Uplift.mmEditor._u30, seam20: win.Uplift.mmEditor._u20,
        dom, calls, win };
}

/* ---- pure verbs --------------------------------------------------------- */
test('api-name validation mirrors classic isValidProfileName (server rule ^[a-z0-9][a-z0-9_-]{0,31}$)', () => {
    const { seam30: U } = load();
    assert.ok(U.isValidProfileName('coding-v1'));
    assert.ok(U.isValidProfileName(' a_b9 '));       // trims
    assert.ok(!U.isValidProfileName('Coding'));
    assert.ok(!U.isValidProfileName('a b'));
    assert.ok(!U.isValidProfileName('-lead'));
    assert.ok(!U.isValidProfileName(''));
    assert.ok(!U.isValidProfileName(null));
    assert.ok(!U.isValidProfileName('x'.repeat(33)));
});
test('profileFieldsPatch mirrors classic updateProfileFromEdit: trimmed 4-field PUT body, classic errors', () => {
    const { seam30: U } = load();
    const r = U.profileFieldsPatch({ display_name: ' Fast ', api_name: ' fast ',
        description: ' hi ', expose_as_model: true, name: 'fast' });
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(JSON.stringify(r.patch), JSON.stringify(
        { display_name: 'Fast', api_name: 'fast', description: 'hi',
          expose_as_model: true }));
    // api_name empty → classic falls back to the stable internal name
    const r2 = U.profileFieldsPatch({ display_name: 'F', api_name: '',
        description: null, expose_as_model: undefined, name: 'fast' });
    assert.strictEqual(r2.patch.api_name, 'fast');
    assert.strictEqual(r2.patch.description, '', 'empty string clears server-side (None would KEEP)');
    assert.strictEqual(r2.patch.expose_as_model, false);
    assert.strictEqual(U.profileFieldsPatch({ display_name: '  ', name: 'x' }).error,
        'Name required');
    assert.strictEqual(U.profileFieldsPatch({ display_name: 'x', api_name: 'BAD NAME' }).error,
        'API name must be lowercase letters, digits, underscore, or dash (1-32 chars)');
});
test('sparse override diff: equal-to-base and undefined drop out, explicit null persists, UI keys never', () => {
    const { seam30: U, seam20: S } = load();
    S.inject({ seBaseVals: { temperature: 0.8, max_tokens: 4096 } });
    const ov = U.seProfileSettingsFrom({
        temperature: 0.8,                       // equal base → inherit
        max_tokens: 1024,                       // differs → override
        min_p: null,                            // explicit null vs undefined base → override
        presence_penalty: undefined,            // unset → skip
        ctKwargEntries: [{ k: 1 }],             // UI-internal → skip
        model_alias: 'a',                       // UI-internal → skip
        dflash_enabled: false,                  // false !== undefined → override
    });
    assert.strictEqual(JSON.stringify(ov), JSON.stringify(
        { max_tokens: 1024, min_p: null, dflash_enabled: false }));
});
test('two-step delete machine: ask arms, no disarms, yes fires ONLY while that row is armed', () => {
    const { seam30: U } = load();
    assert.strictEqual(U.nextDeleteState(null, 'p', 'ask'), 'p');
    assert.strictEqual(U.nextDeleteState('q', 'p', 'ask'), 'p', 'arm follows the last click');
    assert.strictEqual(U.nextDeleteState('p', 'p', 'yes'), 'FIRE');
    assert.strictEqual(U.nextDeleteState('p', 'r', 'yes'), null, 'foreign yes disarms, never fires');
    assert.strictEqual(U.nextDeleteState('p', 'p', 'no'), null);
    assert.strictEqual(U.nextDeleteState(null, 'p', 'yes'), null);
});
test('template-row machine (uplift_mmtemplates._u30): same shape — ask/no/FIRE', () => {
    const dom = makeDom();
    const win = { Uplift: { state: { API: '' } }, UpliftCore: { tf: (k, en) => en },
        UpliftDom: { $: () => dom.el('div'), fetchJson: async () => ({}),
            deleteJson: async () => ({}), toast() {}, cell: () => dom.el('span'),
            // kit seam added by UP-49 (mirrors domkit.errText)
            errText(e) { if (e == null) return ''; if (typeof e === 'string') return e.includes(' -> ') ? e.split(' -> ')[1] : e; if (e.userMessage) return e.userMessage; const m = e.message || String(e); return m.includes(' -> ') ? m.split(' -> ')[1] : m; },
            emptyMsg() {} } };
    vm.runInNewContext(TPL_SRC, { window: win, document: dom.document, console,
        setTimeout: f => setTimeout(f, 0), clearTimeout });
    const st = win.Uplift.mmTemplates._u30.u30DelState;
    assert.strictEqual(st(false, 'ask'), true);
    assert.strictEqual(st(true, 'no'), false);
    assert.strictEqual(st(true, 'yes'), 'FIRE');
    assert.strictEqual(st(false, 'yes'), false, 'unarmed yes never fires');
});
test('RESYNC gate: only a profile naming a LIVE template resyncs', () => {
    const { seam30: U } = load();
    assert.strictEqual(U.resyncTargetTemplate(P_ENG, TPLS), TPLS[0]);
    assert.strictEqual(U.resyncTargetTemplate(P_PLAIN, TPLS), null);
    assert.strictEqual(U.resyncTargetTemplate({ source_template: 'gone' }, TPLS), null);
    assert.strictEqual(U.resyncTargetTemplate(null, TPLS), null);
});
test('option label/title mirror classic: ⚠ for divergence, model_id + description + engine hint', () => {
    const { seam30: U } = load();
    assert.strictEqual(U.profileOptionLabel(P_ENG, false), 'Fast');
    assert.strictEqual(U.profileOptionLabel(P_ENG, true), 'Fast \u26a0');
    const title = U.profileOptionTitle(P_ENG);
    assert.ok(title.startsWith('M1:fast\nhigh-throughput\n'),
        'classic profileTooltip order: exposed id, then description');
    assert.ok(title.includes('Engine-level settings in this profile only take effect'),
        'amber engine-field warning (has_engine_fields)');
    const plain = U.profileOptionTitle(P_PLAIN);
    assert.strictEqual(plain, '', 'no expose → no API lines');
    const green = U.profileOptionTitle({ name: 'x', expose_as_model: true,
        has_engine_fields: false });
    assert.strictEqual(green, 'Use as API model');
});

/* ---- the real picker row + edit dialog (DOM drive) ---------------------- */
async function mounted() {
    const h = load({
        '/uplift/api/models/M1/profiles': { profiles: [P_ENG, P_PLAIN] },
        '/admin/api/profile-templates': { templates: TPLS },
        '/admin/static/omlx_preset.json': { presets: [] },
    });
    const host = h.dom.el('div');
    await h.seam30.seLoadProfiles('M1', host);
    await new Promise(r => setImmediate(r));   // let any store-refresh paint land
    h.sel = () => findAll(host, n => n.tagName === 'SELECT')[0];
    h.dlg = () => findAll(host, n => n._classes.has('se-pedit'))[0];
    h.btn = (txt, root) => findAll(root || host, n => n.tagName === 'BUTTON' && n.textContent === txt)[0];
    return Object.assign(h, { host });
}
test('picker row: API badges (amber engine-field ⚠), drift dot, two-step Delete', async () => {
    const h = await mounted();
    const { calls, host } = h;

    const sel = h.sel();
    const labels = sel.children.filter(c => c.value).map(c => c.textContent);
    assert.strictEqual(JSON.stringify(labels),
        JSON.stringify(['Fast (API\u26a0)', 'Careful']),
        'exposed+engine fields read API\u26a0, plain stays bare, title carries the hint');
    assert.ok(sel.children[1].title.includes('Engine-level settings'));
    const del = h.btn('Delete');
    const noB = h.btn('No');
    assert.ok(del && noB && noB.hidden, 'No starts hidden');
    sel.value = 'fast';
    del.onclick();                                   // step 1: arm
    assert.strictEqual(h.btn('Yes') === undefined, false);
    assert.strictEqual(noB.hidden, false);
    assert.strictEqual(calls.del.length, 0, 'arming never deletes');
    noB.onclick();                                   // cancel
    assert.strictEqual(del.textContent, 'Delete');
    assert.strictEqual(noB.hidden, true);
    del.onclick();                                   // arm again, then confirm
    await del.onclick();                             // second click = FIRE path
    assert.strictEqual(calls.del[calls.del.length - 1][0],
        '/adm/admin/api/models/M1/profiles/fast');
    // drift dot: hidden until the selected profile owns unsaved tab edits
    const dot = findAll(host, n => n._classes.has('se-drift-dot'))[0];
    assert.ok(dot, 'picker row carries the classic drift dot');
    assert.strictEqual(dot.hidden, true);
});
test('drift dot lights while the selected profile owns unsaved changes (classic active-pill dot)', async () => {
    const h = await mounted();
    const { host, seam20 } = h;
    const tab = { id: 'pt', profileId: 'careful', dirty: new Set(['temperature']),
        origVals: {}, workVals: { temperature: 0.2 }, name: 'careful' };
    seam20.inject({ seTabs: [{ id: 'base', dirty: new Set(), origVals: {},
        workVals: {} }, tab], seActiveTab: 'base', seBaseVals: { temperature: 0.8 } });
    const sel = h.sel();
    const dot = findAll(host, n => n._classes.has('se-drift-dot'))[0];
    sel.value = 'careful';
    sel.onchange();
    assert.strictEqual(dot.hidden, false);
    sel.value = 'fast';
    sel.onchange();
    assert.strictEqual(dot.hidden, true, 'a profile without an edited tab never fakes drift');
});
test('Edit dialog: three classic verbs over the picker target', async () => {
    const h = await mounted();
    const { host, calls, seam20 } = h;
    const reloads = [];
    seam20.reloadHook = m => { reloads.push(m); };
    const dlg0 = h.dlg();
    assert.ok(dlg0 && dlg0.hidden, 'dialog starts folded');
    const sel = h.sel();
    sel.value = 'careful';
    h.btn('Edit').onclick();
    assert.strictEqual(h.dlg().hidden, false);
    const texts = findAll(h.dlg(), n => n.tagName === 'BUTTON').map(b => b.textContent);
    assert.ok(texts.includes('Save') && texts.includes('Update to current form values'),
        'classic verbs');
    assert.ok(!texts.includes('Re-sync from template'),
        'source_template=null → no resync verb (checked with the templated profile below)');
    // verb 1 — SAVE fields: prefill is classic's _edit* defaults
    const inputs = findAll(h.dlg(), n => n.tagName === 'INPUT' && n.type === 'text');
    assert.strictEqual(inputs[0].value, 'Careful');
    assert.strictEqual(inputs[1].value, 'careful', 'api_name falls back to the name');
    inputs[0].value = 'Careful!';
    await h.btn('Save', h.dlg()).onclick();
    const put = calls.put.find(p => p[0].endsWith('/admin/api/models/M1/profiles/careful'));
    assert.strictEqual(JSON.stringify(put[1]), JSON.stringify(
        { display_name: 'Careful!', api_name: 'careful', description: '',
          expose_as_model: false }), 'exactly classic updateProfileFromEdit patch');
    // verb 2 — UPDATE SETTINGS FROM FORM: live form state, sparse vs base
    await new Promise(r => setImmediate(r));
    h.sel().value = 'careful';
    h.btn('Edit').onclick();
    seam20.inject({ seValues: { temperature: 0.1 },
        seBaseVals: { temperature: 0.8 },
        seTabs: [{ id: 'base', dirty: new Set(), origVals: {}, workVals: { temperature: 0.1 } }],
        seActiveTab: 'base' });
    await h.btn('Update to current form values', h.dlg()).onclick();
    const put2 = calls.put.find(p => p[1] && p[1].settings);
    assert.strictEqual(JSON.stringify(put2[1].settings),
        JSON.stringify({ temperature: 0.1 }), 'only the form-differs-from-base keys persist');
    // verb 3 — RESYNC: profile names a template → button appears, fires
    // the SAME upsert+apply pair as the templates row, then reloads
    await new Promise(r => setImmediate(r));
    h.sel().value = 'fast';
    h.btn('Edit').onclick();
    const resync = h.btn('Re-sync from template', h.dlg());
    assert.ok(resync, 'source_template=coding → resync verb renders');
    await resync.onclick();
    const ups = calls.post.find(p => p[0].endsWith('/admin/api/models/M1/profiles') &&
        p[1] && p[1].source_template === 'coding');
    assert.ok(ups, 'upsert the profile from the template');
    assert.ok(calls.post.some(p => p[0].endsWith('/profiles/coding/apply')),
        'then apply it server-side');
    assert.strictEqual(JSON.stringify(reloads), JSON.stringify(['M1']),
        'full editor refresh after resync');
});
test('classic errors surface inline in the dialog, never as a native box', async () => {
    const h = await mounted();
    const { calls } = h;
    h.sel().value = 'careful';
    h.btn('Edit').onclick();
    const inputs = findAll(h.dlg(), n => n.tagName === 'INPUT' && n.type === 'text');
    inputs[0].value = '   ';                       // display name required
    const errBefore = calls.put.length;
    await h.btn('Save', h.dlg()).onclick();
    const errLine = findAll(h.dlg(), n => n._classes.has('se-pedit-err'))[0];
    assert.strictEqual(errLine.textContent, 'Name required');
    assert.strictEqual(errLine.hidden, false);
    assert.strictEqual(calls.put.length, errBefore, 'no request on an invalid patch');
});

/* ---- source-shape pins -------------------------------------------------- */
test('template box delete: two-step inline replaces the old confirm-dialog call, POLL-BATCH invalidation intact', () => {
    assert.ok(!/MMF\.confirmDialog\(/.test(TPL_SRC),
        'the dialog-confirm template delete is retired (classic pill parity)');
    assert.ok(/_tpl = null;   \/\/ POLL-BATCH: a delete IS a write — invalidate/.test(TPL_SRC),
        'the invalidate line survived the rework verbatim');
    assert.ok(/u30DelState\(armed, 'yes'\) === 'FIRE'|u30DelState\(armed, 'yes'\) !== 'FIRE'/.test(TPL_SRC),
        'the row delete runs through the two-step machine');
    assert.ok(!/window\.confirm\s*\(|(^|[^.\w])alert\s*\(/m.test(TPL_SRC));
});
test('tab strip carries the classic amber/green API pill on stored exposed profiles', () => {
    assert.ok(/se-tab-api ' \+ \(sp\.has_engine_fields \? 'api-eng' : 'api-ok'\)/.test(SRC),
        'API badge class follows the server has_engine_fields verdict');
    assert.ok(/profHost\._syncDrift/.test(SRC),
        'the picker drift dot re-derives on every tab-strip render');
});
