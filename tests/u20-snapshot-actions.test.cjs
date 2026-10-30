/* UP-20 (1,2,3) — snapshot actions (reset / benchmark-optimal choose / recipe
   paste) + Load Generation Defaults in the model editor.
   uplift_mmeditor.js is a browser IIFE; this harness vm-loads the WHOLE file
   (the sanctioned dl1-fileselect pattern — the body concatenates ONLY the
   repository's own checked-in source, no external input) and drives the
   exported _u20 seam: the pure SETTINGS_APPLY phase machine (classic
   dashboard.js:3416-3547), the classic loadGenerationDefaults clear-list
   (dashboard.js:3571-3646) verified key-for-key against the fixture below,
   and the real modal DOM shell through the rich stub. Fixtures use the REAL
   server row shapes verified in omlx/admin/routes.py (_candidate_summary
   :4109, reset/recipe/optimal responses of _apply_settings_snapshot :3999). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_mmeditor.js'), 'utf8');

/* ---- rich DOM stub (skill: real _lis registries, textContent that splices
   children, .value visible to the serializer, classList two-arg toggle) ---- */
function makeDom() {
    const byId = {
        'se-save': el('button', { id: 'se-save' }),
        'se-restart': el('button', { id: 'se-restart' }),
    };
    function el(tag, attrs) {
        const node = {
            tagName: String(tag).toUpperCase(), children: [], _text: '',
            dataset: {}, style: {}, hidden: false, disabled: false,
            value: '', title: '', href: '', _classes: new Set(),
            parentNode: null, _lis: {},
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
            set(v) { node._text = String(v); _clear(node); },  // real DOM: text wipes children
        });
        node.append = (...cs) => {
            for (const c of cs) {
                if (c == null) continue;
                if (typeof c === 'string' || typeof c === 'number') continue; // text nodes skipped
                c.parentNode = node; node.children.push(c);
            }
        };
        node.remove = () => {
            if (!node.parentNode) return;
            const p = node.parentNode.children;
            const i = p.indexOf(node); if (i >= 0) p.splice(i, 1);
            node.parentNode = null;
        };
        node.addEventListener = (t, fn) => { (node._lis[t] = node._lis[t] || []).push(fn); };
        node.removeEventListener = () => {};
        node.setAttribute = () => {}; node.focus = () => {};
        node.querySelector = sel => node.querySelectorAll(sel)[0] || null;
        node.querySelectorAll = sel => {
            const out = [];
            const want = sel.trim();
            const walk = n => {
                for (const c of n.children) {
                    if (want.startsWith('.') && c._classes.has(want.slice(1))) out.push(c);
                    else if (want.startsWith('#') && c.id === want.slice(1)) out.push(c);
                    else if (want === sel && c.tagName === want.toUpperCase()) out.push(c);
                    walk(c);
                }
            };
            walk(node);
            return out;
        };
        Object.assign(node, attrs || {});
        if (attrs && attrs.className) node.className = attrs.className;
        return node;
    }
    function _clear(n) {
        for (const c of n.children) c.parentNode = null;
        n.children.length = 0;
    }
    const document = {
        body: el('body'),
        createElement: tag => el(tag),
        createTextNode: t => ({ _text: String(t), children: [], tagName: '#text',
            parentNode: null }),
        getElementById: id => byId[id] || null,
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
function allText(node) {   // serializer MUST include input values (skill rule)
    let s = (node._text || '') + (node.value ? ' ' + node.value : '');
    for (const c of node.children || []) s += ' ' + allText(c);
    return s;
}

/* classic en.json fallbacks pass through tf(k, en) => en, so text assertions
   read the English copy exactly as classic ships it. */
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
    const err = (url, status, msg) => Object.assign(
        new Error(`${url} -> ${status}: ${msg}`), { status });
    const win = { Uplift: { state: { API: '/adm' } } };
    win.UpliftCore = {
        t: k => k, tf: (k, en) => en, errorText: x => String(x),
        normalize: v => v,
    };
    win.UpliftDom = {
        $: id => dom.document.getElementById(id),
        fetchJson: async (url, o) => { calls.fetch.push([url, o]); return route(url, o); },
        postJson: async (url, b) => { calls.post.push([url, b]); return route(url, { method: 'POST' }); },
        putJson: async (url, b) => { calls.put.push([url, b]); return route(url, { method: 'PUT' }); },
        deleteJson: async (url) => { calls.del.push([url]); return route(url, { method: 'DELETE' }); },
        toast: (m, kind) => calls.toasts.push([m, kind]),
        cell: () => dom.el('span'), emptyMsg: () => {},
        errText: (e) => { if (e == null) return ''; if (typeof e === 'string') return e.includes(' -> ') ? e.split(' -> ')[1] : e; if (e.userMessage) return e.userMessage; const m = e.message || String(e); return m.includes(' -> ') ? m.split(' -> ')[1] : m; },
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
    const sandbox = {
        window: win, document: dom.document, console,
        localStorage: { _m: {}, getItem(k) { return this._m[k] || null; },
            setItem(k, v) { this._m[k] = String(v); } },
        setTimeout: (f) => setTimeout(f, 0), clearTimeout,
        URL, URLSearchParams,
    };
    vm.runInNewContext(SRC, sandbox);
    return { seam: win.Uplift.mmEditor._u20, dom, calls, win, err };
}

/* ---- MM_GLUE kit wiring (the landed-but-throwing postJson bug) --------- */
test('MM_GLUE exposes postJson/putJson/deleteJson — the MTPLX/preset-refresh call sites no longer throw', () => {
    const { seam } = load();
    for (const k of ['postJson', 'putJson', 'deleteJson'])
        assert.strictEqual(typeof seam.MM_GLUE_kit[k], 'function', k + ' must be wired');
});

/* ---- the pure phase machine (classic dashboard.js:3416-3547) ----------- */
const SA = () => load().seam.SETTINGS_APPLY;
test('open: recipe→input, reset→confirm, optimal→loading (classic openSettingsApply)', () => {
    const M = SA();
    assert.strictEqual(M.open('recipe').phase, 'input');
    assert.strictEqual(M.open('reset').phase, 'confirm');
    assert.strictEqual(M.open('optimal').phase, 'loading');
});
test('close is forbidden ONLY while loading (classic closeSettingsApply guard)', () => {
    const M = SA();
    for (const ph of ['confirm', 'input', 'choose', 'done', 'none', 'error']) {
        assert.strictEqual(M.canClose({ phase: ph }), true, ph);
    }
    assert.strictEqual(M.canClose({ phase: 'loading' }), false);
});
test('candidates: found→choose with rows, not-found→none with the answer kept', () => {
    const M = SA();
    const found = { found: true, by_pp: [{ benchmark_id: 'abc123', benchmark_url: 'https://omlx.ai/benchmarks/performance/abc123', pp_tps: 100 }], by_tg: [] };
    const st1 = M.onCandidates(M.open('optimal'), found);
    assert.strictEqual(st1.phase, 'choose');
    assert.strictEqual(st1.candidates, found);
    const st2 = M.onCandidates(M.open('optimal'), { found: false, by_pp: [], by_tg: [], search_url: 'https://omlx.ai/x' });
    assert.strictEqual(st2.phase, 'none');
    assert.strictEqual(st2.result.search_url, 'https://omlx.ai/x');
});
test('recipeBody trims the paste (classic POSTs recipeText.trim())', () => {
    const M = SA();
    const st = M.open('recipe');
    st.recipeText = '  omlx-recipe:1:zz9  \n';
    assert.strictEqual(JSON.stringify(M.recipeBody(st)),
        JSON.stringify({ recipe: 'omlx-recipe:1:zz9' }));
});
test('applied → done; error → error; Back reachable only for recipe / optimal-with-candidates', () => {
    const M = SA();
    const st = M.onApplied(M.open('recipe'), { changed: true });
    assert.strictEqual(st.phase, 'done');
    M.onError(st, 'boom');
    assert.strictEqual(st.phase, 'error');
    assert.strictEqual(st.error, 'boom');
    assert.strictEqual(M.canBack(st), true);
    M.back(st); assert.strictEqual(st.phase, 'input');
    const noCand = M.onError(M.open('optimal'), 'boom');
    assert.strictEqual(M.canBack(noCand), false);
    noCand.candidates = { by_pp: [1] };
    assert.strictEqual(M.canBack(noCand), true);
    M.back(noCand); assert.strictEqual(noCand.phase, 'choose');
    const reset = M.onError(M.open('reset'), 'boom');
    assert.strictEqual(M.canBack(reset), false);
    // no detail from the server → classic's generic settings_apply_failed fallback
    assert.strictEqual(M.onError(M.open('recipe'), '').error,
        'Failed to apply settings');
});
test('titles/loading/done texts mirror classic (incl. the changed:false no_change line)', () => {
    const M = SA();
    assert.strictEqual(M.title(M.open('reset')), 'Reset defaults');
    assert.strictEqual(M.title(M.open('recipe')), 'Apply custom recipe');
    assert.strictEqual(M.title(M.open('optimal')), 'Optimal settings from omlx.ai');
    assert.strictEqual(M.loadingText(M.open('reset')), 'Resetting settings...');
    assert.strictEqual(M.loadingText(M.open('recipe')), 'Applying the recipe...');
    const optFetching = M.open('optimal');
    assert.strictEqual(M.loadingText(optFetching),
        'Fetching the best benchmark results from omlx.ai...');
    optFetching.candidates = { by_pp: [1] };
    assert.strictEqual(M.loadingText(optFetching), 'Applying the benchmark settings...');
    assert.strictEqual(M.doneText({ mode: 'reset' }),
        'All settings were reset to their defaults.');
    assert.strictEqual(M.doneText({ mode: 'recipe', result: { changed: false } }),
        'Settings already matched; nothing changed.');
    assert.strictEqual(M.doneText({ mode: 'recipe', result: { changed: true } }),
        'The settings below were applied from the recipe!');
    assert.strictEqual(M.doneText({ mode: 'optimal', result: {} }),
        'The settings below were applied from the selected benchmark!');
});
/* REAL _candidate_summary rows (omlx/admin/routes.py:4109-4120) */
const CAND = {
    benchmark_id: 'ab12cd34', benchmark_url: 'https://omlx.ai/benchmarks/performance/ab12cd34',
    pp_tps: 1234.5678, tg_tps: 45.67, quantization: '4-bit', omlx_version: '0.3.9',
    created_at: '2026-10-01T12:00:00Z', context_profile: '4k', memory_gb: 64,
};
test('stats format is the classic line: PP/TG tok/s · GB · quant · oMLX ver · date', () => {
    const M = SA();
    assert.strictEqual(M.stats(CAND),
        'PP 1234.6 tok/s · TG 45.7 tok/s · 64 GB · 4-bit · oMLX 0.3.9 · 2026-10-01');
    assert.strictEqual(M.stats({ pp_tps: null }), '');
    assert.strictEqual(M.stats({}), '');
    assert.strictEqual(M.stats({ pp_tps: 10 }), 'PP 10.0 tok/s');
});
test('groups render PP then TG and drop an empty rank', () => {
    const M = SA();
    const st = { candidates: { by_pp: [CAND], by_tg: [] } };
    const gs = M.groups(st);
    assert.strictEqual(gs.length, 1);
    assert.strictEqual(gs[0].label, 'Best prompt processing (PP)');
    const st2 = { candidates: { by_pp: [CAND], by_tg: [CAND] } };
    assert.strictEqual(JSON.stringify(M.groups(st2).map(g => g.key)),
        JSON.stringify(['pp', 'tg']));
    assert.strictEqual(JSON.stringify(M.groups({ candidates: null })), '[]');
});
test('appliedJson pretty-prints result.applied and is empty without one', () => {
    const M = SA();
    assert.strictEqual(M.appliedJson({ result: { applied: { temperature: 0.7 } } }),
        JSON.stringify({ temperature: 0.7 }, null, 2));
    assert.strictEqual(M.appliedJson({ result: {} }), '');
    assert.strictEqual(M.appliedJson({}), '');
});

/* ---- Load Generation Defaults: classic's EXACT clear list --------------
   Fixture = dashboard.js:3580-3615 (tip of the reference clone) copied
   key-for-key; the shipped SE_GEN_CLEAR must match it pair-for-pair in
   order, and the 5 fetched keys must never appear in the clear list. */
const CLASSIC_SET_KEYS = ['max_context_window', 'temperature', 'top_p',
    'top_k', 'repetition_penalty'];
const CLASSIC_CLEAR = [
    ['max_tokens', null], ['min_p', null], ['presence_penalty', null],
    ['force_sampling', false], ['reasoning_parser', null],
    ['guided_grammar_enabled', false], ['guided_grammar', ''],
    ['ttl_seconds', null], ['enableIndexCache', false], ['index_cache_freq', 0],
    ['enable_thinking', false], ['enableThinkingBudget', false],
    ['thinking_budget_tokens', 0],
    // SYNC-1 (upstream d59d797 #4855): classic dashboard.js:3674-3675 added
    // the power-cap pair between the thinking and tool-result pairs
    ['enableGpuPowerLimit', false], ['gpu_power_limit_w', null],
    ['enableToolResultLimit', false],
    ['max_tool_result_tokens', 0], ['ctKwargEntries', []],
    ['turboquant_kv_enabled', false], ['turboquant_kv_scheme', 'turboquant'],
    ['turboquant_kv_bits', 4],
    ['qwen35_ane_prefill_enabled', false],
    ['qwen35_ane_prefill_sequence_length', 2048],
    ['qwen35_ane_prefill_tail_padding_min_tokens', 0],
    ['qwen35_ane_prefill_fraction', 0.53],
    ['qwen35_ane_prefill_max_layers', 64],
    ['qwen35_ane_prefill_dual_ane', true],
    ['qwen35_ane_prefill_gdn', true],
    ['qwen35_ane_prefill_gdn_fraction', 0.5],
    ['qwen35_ane_prefill_gdn_max_layers', 48],
    ['qwen35_ane_prefill_cpu_enabled', false],
    ['qwen35_ane_prefill_cpu_fraction', 0.135],
    ['qwen35_ane_prefill_cpu_down_fraction', 0],
    ['qwen35_ane_prefill_cpu_gdn_fraction', 0],
    ['qwen35_ane_prefill_cpu_threads', 8],
    ['qwen35_ane_prefill_cpu_shared_resource', true],
    ['specprefill_enabled', false], ['specprefill_draft_model', null],
    ['specprefill_keep_pct', 0.2], ['specprefill_threshold', null],
    ['specprefill_auto_enabled', true],
    ['dflash_enabled', false], ['dflash_draft_model', null],
    ['dflash_draft_quant_enabled', false],
    ['dflash_draft_quant_weight_bits', null],
    ['dflash_draft_quant_group_size', null],
    ['dflash_draft_window_size', null], ['dflash_block_size', null],
    ['dflash_verify_mode', 'adaptive'],
    ['mtp_enabled', false], ['mtp_adaptive_max_depth', '3'],
    ['trust_remote_code', false],
];
test('SE_GEN_CLEAR mirrors the classic hard-clear list key-for-key', () => {
    const { seam } = load();
    // cross-realm objects: compare JSON shapes, never deepStrictEqual (skill)
    assert.strictEqual(JSON.stringify(seam.SE_GEN_CLEAR),
        JSON.stringify(CLASSIC_CLEAR));
    assert.strictEqual(JSON.stringify(seam.SE_GEN_SET_KEYS),
        JSON.stringify(CLASSIC_SET_KEYS));
});
test('genDefaultsPatch: 5 keys from config (missing→null), the rest cleared; foreign keys never injected', () => {
    const { seam } = load();
    const state = {};
    for (const k of CLASSIC_SET_KEYS) state[k] = 1;
    for (const [k] of CLASSIC_CLEAR) state[k] = 1;
    state.foreign_key = 1; state.model_alias = 'x';
    const data = { max_context_window: 131072, temperature: 1.0 };
    const p = seam.genDefaultsPatch(data, {}, state);
    assert.strictEqual(p.max_context_window, 131072);
    assert.strictEqual(p.temperature, 1.0);
    assert.strictEqual(p.top_p, null, 'a key config does not report falls to null, classic ??');
    assert.strictEqual(p.top_k, null);
    assert.strictEqual(p.repetition_penalty, null);
    for (const [k, v] of CLASSIC_CLEAR)
        assert.strictEqual(JSON.stringify(p[k]), JSON.stringify(v), 'cleared ' + k);
    assert.ok(!('foreign_key' in p), 'never write keys the editor state does not carry');
    assert.ok(!('model_alias' in p), 'classic does not clear the alias — neither do we');
    for (const k of CLASSIC_SET_KEYS)
        assert.ok(!CLASSIC_CLEAR.some(([ck]) => ck === k),
            k + ' is fetched, never hard-cleared');
});
test('genDefaultsPatch: ANE fraction follows the model row; the array default is never shared', () => {
    const { seam } = load();
    const state = { qwen35_ane_prefill_fraction: 0.9, ctKwargEntries: [{ a: 1 }] };
    assert.strictEqual(seam.genDefaultsPatch({}, { ane_prefill_default_fraction: 0.61 }, state)
        .qwen35_ane_prefill_fraction, 0.61);
    assert.strictEqual(seam.genDefaultsPatch({}, {}, state)
        .qwen35_ane_prefill_fraction, 0.53, 'classic ?? 0.53 fallback');
    const p1 = seam.genDefaultsPatch({}, {}, state);
    p1.ctKwargEntries.push('poison');
    const p2 = seam.genDefaultsPatch({}, {}, state);
    assert.strictEqual(JSON.stringify(p2.ctKwargEntries), '[]', 'each call owns a fresh list');
});
test('seApplyGenDefaults lands the patch on the BASE tab as queued edits (classic drops the profile link)', () => {
    const { seam } = load();
    const t0 = { id: 'base', dirty: new Set(), origVals: { temperature: 0.9, max_tokens: 4096 } };
    seam.inject({
        seModel: 'M1', seFormModel: { id: 'M1' },
        seValues: { temperature: 0.9, max_tokens: 4096 },
        seOrig: { temperature: 0.9, max_tokens: 4096 },
        seBaseVals: { temperature: 0.9, max_tokens: 4096 },
        seTabs: [t0], seActiveTab: 'base',
    });
    seam.seApplyGenDefaults({ temperature: 0.7 });
    const live = seam.live;
    assert.strictEqual(live.seValues.temperature, 0.7);
    assert.strictEqual(live.seValues.max_tokens, null, 'hard-cleared');
    assert.deepStrictEqual([...t0.dirty].sort(), ['max_tokens', 'temperature']);
    // re-applying the same config must UNMARK keys that returned to orig
    seam.seApplyGenDefaults({ temperature: 0.7 });
    assert.ok(t0.dirty.has('max_tokens'));
    seam.seApplyGenDefaults({ temperature: 0.9 });   // back to the stored value
    assert.ok(!t0.dirty.has('temperature'), 'value equals original → not dirty');
});
test('seApplyGenDefaults switches a profile tab back to BASE first', () => {
    const { seam } = load();
    const t0 = { id: 'base', dirty: new Set(), origVals: {}, workVals: { temperature: 1 } };
    const tp = { id: 'p1', profileId: 'p1', dirty: new Set(), origVals: {}, overrides: {}, workVals: { temperature: 2 } };
    seam.inject({
        seModel: 'M1', seFormModel: { id: 'M1' },
        seValues: { temperature: 2 }, seOrig: {}, seBaseVals: { temperature: 1 },
        seTabs: [t0, tp], seActiveTab: 'p1',
    });
    seam.seApplyGenDefaults({ temperature: 0.7 });
    assert.strictEqual(seam.live.seActiveTab, 'base');
    assert.strictEqual(seam.live.seValues.temperature, 0.7);
    assert.ok(!tp.dirty.has('temperature'), 'the profile tab holds no gen-defaults writes');
});

/* ---- the real modal shell (drives the machine through the stub DOM) ---- */
const RESET_ANSWER = {
    success: true, changed: true, skipped: [],
    requires_reload: true, auto_unloaded: true, auto_reloaded: false,
    reload_deferred: false, settings: { temperature: 0.7 },
    applied: { temperature: 0.7 },
};
test('reset: confirm → Yes → POST settings/reset (bodyless) → done + editor reload + classic unload notice', async () => {
    const { seam, dom, calls } = load({
        '/admin/api/models/M1/settings/reset': RESET_ANSWER,
    });
    const reloads = [];
    seam.reloadHook = m => { reloads.push(m); };
    seam.inject({ seModel: 'M1' });
    seam.openSettingsApply('reset');
    const overlay = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    assert.ok(overlay, 'modal overlay mounted on document.body');
    const yes = findAll(overlay, n => n.tagName === 'BUTTON' && n.textContent === 'Yes')[0];
    const no = findAll(overlay, n => n.tagName === 'BUTTON' && n.textContent === 'No')[0];
    assert.ok(yes && no, 'classic Yes/No confirmation pair');
    assert.ok(allText(overlay).includes('Reset every setting of this model?'),
        'classic reset_confirm copy');
    no.onclick();                                    // No cancels outright
    assert.strictEqual(dom.document.body.children.includes(overlay), false, 'No closes');
    seam.openSettingsApply('reset');
    const ov2 = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    const yes2 = findAll(ov2, n => n.tagName === 'BUTTON' && n.textContent === 'Yes')[0];
    await yes2.onclick();
    assert.strictEqual(calls.post.length, 1);
    assert.ok(calls.post[0][0].endsWith('/admin/api/models/M1/settings/reset'),
        calls.post[0][0]);
    assert.strictEqual(seam.state.phase, 'done');
    assert.deepStrictEqual(reloads, ['M1'], 'the editor reloads behind the done phase');
    assert.ok(calls.toasts.some(t => String(t[0]).startsWith('Settings saved. The model was unloaded')),
        'classic auto_unloaded notice surfaces');
    // classic shows NO applied-JSON preview for a reset
    assert.strictEqual(findAll(ov2, n => n._classes.has('sa-applied')).length, 0);
});
test('reset: closing mid-flight is refused (classic phase===loading guard)', async () => {
    const { seam, dom } = load({});
    seam.inject({ seModel: 'M1' });
    seam.openSettingsApply('reset');
    const overlay = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    seam.state.phase = 'loading';
    seam.closeSettingsApply();
    assert.ok(dom.document.body.children.includes(overlay), 'X while loading must not close');
});
test('optimal: fetch → choose lists PP/TG rows with stats → Apply POSTs benchmark_id → done with applied JSON + skipped box', async () => {
    const OPT = {
        found: true, model_name: 'M1', search_url: 'https://omlx.ai/search',
        by_pp: [{ benchmark_id: 'ab12cd34', benchmark_url: 'https://omlx.ai/benchmarks/performance/ab12cd34',
            pp_tps: 1234.5678, tg_tps: 45.67, memory_gb: 64, quantization: '4-bit',
            omlx_version: '0.3.9', created_at: '2026-10-01T00:00:00Z' }],
        by_tg: [],
    };
    const APPLY = Object.assign({}, OPT.by_pp[0], RESET_ANSWER,
        { skipped: [{ feature: 'dflash', reason: 'draft model not installed' }] });
    const { seam, dom, calls } = load({
        '/admin/api/models/M1/settings/optimal': (url, o) =>
            (o && o.method === 'POST') ? APPLY : OPT,
    });
    seam.reloadHook = () => {};
    seam.inject({ seModel: 'M1' });
    seam.openSettingsApply('optimal');
    await new Promise(r => setImmediate(r));
    const overlay = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    assert.strictEqual(seam.state.phase, 'choose');
    const txt = allText(overlay);
    assert.ok(txt.includes('Best prompt processing (PP)'), 'group header');
    assert.ok(txt.includes('PP 1234.6 tok/s'), 'candidate stats rendered');
    assert.ok(findAll(overlay, n => n._classes.has('sa-cand')).length === 1);
    const apply = findAll(overlay, n => n.tagName === 'BUTTON' && n.textContent === 'Apply')[0];
    await apply.onclick();
    assert.strictEqual(JSON.stringify(calls.post[calls.post.length - 1][1]),
        JSON.stringify({ benchmark_id: 'ab12cd34' }));
    assert.strictEqual(seam.state.phase, 'done');
    const done = allText(overlay);
    assert.ok(done.includes('The settings below were applied from the selected benchmark!'));
    assert.ok(done.includes('Skipped on this machine'), 'amber skipped box');
    assert.ok(done.includes('dflash: draft model not installed'));
    const preview = findAll(overlay, n => n._classes.has('sa-applied'))[0];
    assert.ok(preview && preview.readOnly === true, 'readonly applied-JSON preview');
    assert.ok(JSON.parse(preview.value).temperature === 0.7, 'preview carries result.applied');
});
test('optimal: no candidates → none phase with the search link', async () => {
    const { seam, dom } = load({
        '/admin/api/models/M1/settings/optimal': { found: false, by_pp: [], by_tg: [],
            search_url: 'https://omlx.ai/search42' },
    });
    seam.inject({ seModel: 'M1' });
    seam.openSettingsApply('optimal');
    await new Promise(r => setImmediate(r));
    assert.strictEqual(seam.state.phase, 'none');
    const overlay = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    const link = findAll(overlay, n => n.tagName === 'A')[0];
    assert.strictEqual(link.href, 'https://omlx.ai/search42');
    assert.ok(allText(overlay).includes('No benchmark result matches this device and model.'));
});
test('recipe: paste enables Apply, POSTs the trimmed recipe; server detail lands in the error phase with Back', async () => {
    const { seam, dom, calls } = load({
        '/admin/api/models/M1/settings/recipe': new Error('url -> 400: Recipe contains no applicable settings'),
    });
    seam.reloadHook = () => {};
    seam.inject({ seModel: 'M1' });
    seam.openSettingsApply('recipe');
    const overlay = dom.document.body.children.find(n => n._classes.has('sa-overlay'));
    const ta = findAll(overlay, n => n._classes.has('sa-recipe'))[0];
    const apply = findAll(overlay, n => n._classes.has('sa-apply'))[0];
    assert.strictEqual(apply.disabled, true, 'Apply starts disabled (classic)');
    ta.value = '  omlx-recipe:1:abc  ';
    ta.oninput();
    assert.strictEqual(apply.disabled, false);
    await apply.onclick();
    assert.strictEqual(calls.post[0][1].recipe, 'omlx-recipe:1:abc', 'trimmed on the wire');
    assert.strictEqual(seam.state.phase, 'error');
    assert.ok(allText(overlay).includes('Recipe contains no applicable settings'));
    const back = findAll(overlay, n => n.tagName === 'BUTTON' && n.textContent === 'Back')[0];
    back.onclick();
    assert.strictEqual(seam.state.phase, 'input');
    assert.ok(findAll(overlay, n => n._classes.has('sa-recipe')).length === 1, 'paste box rebuilt');
});
test('head buttons: three classic actions, greyed while a phase loads', () => {
    const { seam, dom } = load({});
    seam.inject({ seModel: 'M1' });
    const wrap = seam.seSnapshotActions();
    const labels = wrap.children.map(b => b.textContent);
    assert.deepStrictEqual(labels, ['Reset defaults', 'Apply optimal settings', 'Apply custom recipe']);
    seam.openSettingsApply('optimal');       // phase 'loading' immediately
    assert.ok(wrap.children.every(b => b.disabled === true), 'buttons disabled mid-fetch');
    seam.closeSettingsApply();               // loading → refused…
    assert.ok(seam.state, 'still open');
    seam.state.phase = 'choose';
    seam.renderSettingsApply();              // the loading guard lifts…
    assert.ok(wrap.children.every(b => b.disabled === false), 're-enabled off the loading phase');
    seam.closeSettingsApply();               // …and only then the modal closes
    assert.strictEqual(seam.state, null);
});

/* ---- source-shape pins: the parts no stub can prove -------------------- */
test('wire contract: exact classic endpoints, no raw fetch, no window.confirm/alert', () => {
    assert.ok(/\/admin\/api\/models\/\$\{encodeURIComponent\(model\)\}\/settings\/\$\{path\}/.test(SRC),
        'single _saUrl builder for reset|recipe|optimal');
    assert.ok(/\/generation_config`/.test(SRC), 'generation_config endpoint used');
    assert.ok(!/[^.\w]fetch\(/.test(SRC), 'no raw fetch anywhere in the file');
    // CALLS to native dialogs are forbidden (comments naming the rule are not)
    assert.ok(!/window\.confirm\s*\(|(^|[^.\w])alert\s*\(/m.test(SRC),
        'no native dialogs (house rule)');
});
test('mount points: head buttons ride .editor-head; Load Defaults rides the generation section header', () => {
    assert.ok(/panel\.querySelector\('\.editor-head'\)\.append\(seSnapshotActions\(\)\);/.test(SRC));
    assert.ok(/if \(seModel && !m\._template\) seGenDefaultsBtn\(sect\);/.test(SRC));
    assert.ok(/box.__head = h;/.test(SRC), 'seSection exposes its header for the button');
    assert.ok(/title\.querySelector\('\.se-section-t'\)/.test(SRC),
        'rail label reads the label span, never the whole header');
});
