/* U84 (user 2026-10-12): one SAVE press commits EVERY dirty tab — the base
   model AND the profiles edited in the same session. Behavioural proof on
   the real sliced functions (uplift_mmeditor.js is a browser IIFE; same
   nat6-mode-ladder slicing pattern — the new Function below runs ONLY the
   repository's own checked-in source, no untrusted input). Pinned contracts:
   - base commits FIRST, and only then the profile overrides re-diff
     against the advanced base (a profile value the base edit just made
     redundant must drop out as inheritance, not persist as an override);
   - per-tab honest partial failure: a failed tab keeps its dirty state and
     its reason in the summary; committed tabs do NOT roll back and no
     blanket 'saved ✓' covers the failure;
   - the button: 'SAVE ALL (n)' counts across tabs (expose/api flips and
     kwargs included — the old dead end where a flip alone could not be
     committed), busy during the run, reactivated exactly per leftover
     changes (BUG-6 doctrine);
   - a single dirty profile tab still routes through the BUG-6-pinned
     saveProfileTab wrapper. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
function region(start, end, label) {
    const a = src.indexOf(start), b = src.indexOf(end, a);
    assert.ok(a > 0 && b > a, 'U84 slice region must exist: ' + label);
    return src.slice(a, b);
}
const CODE = [
    region('function seDirtyKeys', '/* ---- EFF-1', 'dirty-key helpers'),
    region('function seUpdateSaveBtn', '/* CHANGES box', 'button refresh'),
    region('function seCaptureTab', '/* ---- item 4', 'tab capture'),
    region('function seInitSnap', 'function seBind', 'tab accessors'),
    region('function seRestoreTab', 'function seNextAutoName', 'tab restore'),
    region('function seCommitSaved', '/* Pending-restart surfacing', 'commit bookkeeping'),
    region('async function sePersistDeferred', 'function seDirtyKeys', 'deferred store'),
    region('function seTabChangeCount', 'window.Uplift.mmEditor', 'save orchestration'),
    // TTS-1: the slice needs the voice-defaults state trio — seTts is a
    // LET in this same combined body, so saveEditor's dirty-check and the
    // commit resolve without any global accessor
    region('let seTts = null;', 'function seTtsField', 'tts defaults trio'),
    // TTS-2: seActivateTab hides the CUSTOM VOICES box on profile tabs —
    // its state pair must ride the same combined body (same LET rule)
    region('let seVoicesGen = 0;', 'async function seVoicesAttach',
        'editor voices-block state pair'),
].join('\n');

function harness({ validations = {}, loaded = true,
                   seValues = {}, seOrig = {}, seBaseVals = {},
                   base = null, profiles = [] } = {}) {
    const log = { calls: [], toasts: [] };
    const msg = { textContent: '' };
    const btn = { disabled: true, textContent: 'SAVE',
        classList: { toggle() {}, add() {}, remove() {} } };
    const panel = { querySelector: s => (s === '#se-msg' ? msg : null) };
    const mkErr = k => (validations[k] || []).slice();
    const window = { UpliftModelSpec: {
        validate: (v, e) => mkErr(e === 'profile' ? 'profile' : 'base'),
        buildPayload: v => Object.assign({}, v),
        adaptToServerSettings: ov => ov,
        RUNTIME_SETTING_KEYS: new Set(['mtp_enabled']),
        mergeRawKwargs: () => [],
    } };
    const D = {
        putJson: async (p, b) => { log.calls.push([p, JSON.parse(JSON.stringify(b))]); if (D.fail === p) throw Object.assign(new Error('boom'), { status: 500 }); return {}; },
        postJson: async (p, b) => { log.calls.push([p, JSON.parse(JSON.stringify(b))]); return {}; },
        deleteJson: async () => ({}),
    };
    const MM_GLUE = {
        toast: t => log.toasts.push(t),
        putModelSettings: async (m, s) => { log.calls.push(['PUT/settings', JSON.parse(JSON.stringify(s))]); },
        postModelAction: async () => ({}),
        modelSettingsFields: async () => new Set(['mtp_adaptive_max_depth']),
        SECRET_KEYS: new Set(), gsDisplay: v => String(v),
    };
    const C = { t: (k, o) => k, tf: (k, d) => d };
    const st = {
        seValues, seOrig, seBaseVals, seBaseRaw: {},
        seDeferred: {}, seTabs: [base ? baseTab() : baseTab()].concat(profiles),
        seActiveTab: 'base',
    };
    // The sliced code declares NONE of the se* module globals — bare
    // identifiers in the built function body resolve to the GLOBAL scope at
    // CALL time, so we expose st's fields as live accessors: the code's
    // reads AND writes (seActiveTab = t.id) hit the test state object.
    // (new Function here runs only this repository's own checked-in source;
    // each test file is its own process, so this stays out of other suites.)
    for (const n of Object.keys(st)) {
        if (n in globalThis) delete globalThis[n];
        Object.defineProperty(globalThis, n, {
            configurable: true,
            get: () => st[n],
            set: v => { st[n] = v; },
        });
    }
    const api = new Function(
        'MM_GLUE', 'C', 'D', 'API', 'window', 'document', 'MM_DATA', 'CHIPS',
        'seModel', 'seModelEntry', 'seFormModel',
        'seNormalizeKwargs', 'seMarkPendingRows', 'seRenderTabs',
        'renderEditorFields', 'refreshDivergence', 'seUpdateRailBadges',
        'renderEdChanges', 'closeEditor',
        CODE + `
        return {
            saveEditor, saveProfileTab, seUpdateSaveBtn, seTabChangeCount,
        };`)(
        MM_GLUE, C, D, '', window,
        { getElementById: id => (id === 'se-save' ? btn : null),
          querySelector: s => (s === '.modal.editor' ? panel : null),
          querySelectorAll: () => [] },
        { profiles: [], divergence: [] }, { clearProfileCache() {} },
        'M1', () => ({ id: 'M1', loaded }), { id: 'M1', loaded },
        () => {}, () => {}, () => {}, () => {}, () => {},
        () => {}, () => {}, () => {});
    return { api, log, msg, btn, st, D, panel };
}
function baseTab(over) {
    return Object.assign({ id: 'base', dirty: new Set(), workVals: {},
        origVals: {} }, over || {});
}
function profTab(name, over) {
    return Object.assign({ id: 'p_' + name, name, display_name: name,
        profileId: name, expose_as_model: false, api_name: '', overrides: {},
        dirty: new Set(), workVals: {}, origVals: {}, _origExpose: false, _origApi: '' },
        over || {});
}

test('U84: SAVE with base + profile dirty commits the BASE FIRST, then the profile', async () => {
    const h = harness();
    Object.assign(h.st, {
        seValues: { temperature: 0.3, max_context_window: 8192 },
        seOrig: { temperature: 0.7, max_context_window: 8192 },
        seBaseVals: { temperature: 0.7, max_context_window: 8192 },
    });
    const b = baseTab({ dirty: new Set(['temperature']),
        workVals: { temperature: 0.3, max_context_window: 8192 },
        origVals: { temperature: 0.7, max_context_window: 8192 } });
    // profile tab edited to the SAME temperature (will equal the new base)
    // plus its own context override
    const p = profTab('fast', { dirty: new Set(['max_context_window']),
        workVals: { temperature: 0.3, max_context_window: 4096 },
        origVals: { temperature: 0.7, max_context_window: 8192 },
        overrides: {} });
    h.st.seTabs = [b, p];
    await h.api.saveEditor();
    const paths = h.log.calls.map(c => c[0]);
    assert.deepEqual(paths, ['PUT/settings',
        '/admin/api/models/M1/profiles/fast'],
        'base settings PUT must precede the profile PUT (sparse diff ordering)');
    assert.deepEqual(h.log.calls[0][1], { temperature: 0.3 },
        'base: only the dirty live key rides the sparse PUT');
    // THE ordering proof: after the base commit advances seBaseVals,
    // temperature(0.3) equals base -> only the context override persists
    assert.deepEqual(h.log.calls[1][1].settings, { max_context_window: 4096 },
        'temperature must NOT persist as a profile override — it equals the just-saved base value');
    assert.equal(b.dirty.size, 0); assert.equal(p.dirty.size, 0);
    assert.equal(h.btn.disabled, true, 'all clean -> button disabled');
});

test('U84: partial failure — committed tabs stay committed, the failed tab stays dirty with its reason', async () => {
    const h = harness();
    Object.assign(h.st, {
        seValues: { temperature: 0.3 }, seOrig: { temperature: 0.7 },
        seBaseVals: { temperature: 0.7 },
    });
    const b = baseTab({ dirty: new Set(['temperature']), workVals: { temperature: 0.3 },
        origVals: { temperature: 0.7 } });
    const p1 = profTab('ok', { dirty: new Set(['top_p']), workVals: { top_p: 0.5 },
        origVals: { top_p: 0.9 } });
    const p2 = profTab('bad', { dirty: new Set(['min_p']), workVals: { min_p: 0.1 },
        origVals: { min_p: 0.2 } });
    h.st.seTabs = [b, p1, p2];
    h.D.fail = '/admin/api/models/M1/profiles/bad';
    await h.api.saveEditor();
    assert.equal(b.dirty.size, 0, 'base committed — never rolled back');
    assert.equal(p1.dirty.size, 0, 'healthy profile committed');
    assert.equal(p2.dirty.size, 1, 'the FAILED profile keeps its dirty key');
    assert.match(h.msg.textContent, /^saved: BASE, ok — failed: bad \(boom\)$/,
        'honest per-tab summary; no blanket saved ✓ over a failure: ' + h.msg.textContent);
    assert.equal(h.btn.disabled, false, 'reactivated — one tab still carries changes');
});

test('U84: single dirty profile with a clean base still routes through saveProfileTab', async () => {
    const h = harness();
    Object.assign(h.st, { seValues: { top_p: 0.5 }, seOrig: { top_p: 0.9 },
        seBaseVals: { top_p: 0.9 } });
    const b = baseTab({ workVals: { top_p: 0.9 }, origVals: { top_p: 0.9 } });
    const p = profTab('solo', { dirty: new Set(['top_p']), workVals: { top_p: 0.5 },
        origVals: { top_p: 0.9 } });
    h.st.seTabs = [b, p]; h.st.seActiveTab = p.id;
    await h.api.saveEditor();
    assert.deepEqual(h.log.calls.map(c => c[0]),
        ['/admin/api/models/M1/profiles/solo'], 'only the profile PUT');
    assert.equal(h.msg.textContent, 'saved ✓', 'BUG-6 wrapper label shape unchanged');
});

test('U84: button label counts changes across ALL tabs (SAVE ALL n) and expose flips are not a dead end', () => {
    const h = harness({ seValues: { temperature: 0.3 }, seOrig: { temperature: 0.7 },
        seBaseVals: { temperature: 0.7 } });
    const b = baseTab({ dirty: new Set(['temperature']) });
    const p = profTab('fl', { _origExpose: false, expose_as_model: true });  // flip only
    h.st.seTabs = [b, p];
    h.api.seUpdateSaveBtn();
    assert.equal(h.btn.textContent, 'SAVE ALL (2)',
        'dirty key on base + expose flip on the profile = 2 saveable changes');
    assert.equal(h.btn.disabled, false, 'an expose flip alone ENABLES save (old dead end)');
});

test('U84: expose/api flip as the ONLY change enables save and routes the PUT with the flag', async () => {
    const h = harness({ seValues: { temperature: 0.7 }, seOrig: { temperature: 0.7 },
        seBaseVals: { temperature: 0.7 } });
    const b = baseTab({ workVals: { temperature: 0.7 }, origVals: { temperature: 0.7 } });
    const p = profTab('fl', { _origExpose: false, expose_as_model: true });
    h.st.seTabs = [b, p];
    await h.api.saveEditor();
    assert.deepEqual(h.log.calls.map(c => c[0]),
        ['/admin/api/models/M1/profiles/fl'], 'the flip commits through the profile PUT');
    assert.equal(h.log.calls[0][1].expose_as_model, true);
    assert.equal(p._origExpose, true, 'flip baseline advances after the save');
});

test('U84: nothing dirty -> no request at all', async () => {
    const h = harness();
    Object.assign(h.st, { seValues: {}, seOrig: {}, seBaseVals: {} });
    h.st.seTabs = [baseTab(), profTab('q')];
    await h.api.saveEditor();
    assert.deepEqual(h.log.calls, []);
});

test('U84 doctrine pin: the save paths keep zero intermediate "saving" labels', () => {
    const offenders = [...src.matchAll(/msg\.textContent\s*=\s*'saving(?! \+ reloading)[^']*'/g)]
        .map(m => m[0]);
    assert.deepEqual(offenders, [],
        'U84 moved the saveEditor label handling into the orchestrator — re-adding an intermediate state violates BUG-6 doctrine');
});
