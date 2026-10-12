/* U85 (user 2026-10-12): the divergence sync split. Profiles are MEANT to
   diverge — that is their point — so the one-click SYNC that deleted the
   ENTIRE divergence diff from every listed profile is demoted, and the new
   primary verb applies ONLY the keys just edited on the base. Behavioural
   proof on the real sliced engine functions (uplift_mmeditor.js is a
   browser IIFE; slicing pattern as in nat6-mode-ladder. The new Function
   below runs only the repository's own checked-in source — no untrusted
   input — and each test file is its own process). Pinned contracts:
   - seBaseEditKeys: KEY_MAP-expanded payload keys of the dirty base tab
     (+ kwargs drift), null when nothing is queued;
   - seApplyBaseEditsToProfiles: writes ONLY the edited keys as explicit
     overrides into the TICKED profiles; every other stored override stays
     byte-identical; a null base value drops the key (back to inherit)
     together with its legacy twin;
   - the demoted full-reset seSyncBaseToProfiles still removes the whole
     divergence diff (unchanged semantics, reachable but secondary);
   - both verbs share seWriteProfileSettings -> open tabs re-base to the
     written record and lose their dirty state (no stale re-save). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
function region(a, b, label) {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, 'U85 slice region must exist: ' + label);
    return src.slice(i, j);
}
const CODE = [
    region('// dirty state keys -> the payload keys they own', 'function seModelIsLoaded', 'key maps + seBaseEditKeys'),
    region('function seInitSnap', 'function seBind', 'tab accessors'),
    region('function seRestoreTab', 'function seNextAutoName', 'tab restore'),
    region('async function seSyncBaseToProfiles', '/* The primary U85 verb', 'both sync verbs + shared write'),
].join('\n');

function harness({ profiles, tabs = [], baseTab = null, seBaseVals = {},
                   payloadVals = {}, putFail = null, seValues = {},
                   seFormModel = { id: 'M1' } } = {}) {
    const log = { put: [], post: [], cleared: [] };
    const MM_DATA = { profiles: JSON.parse(JSON.stringify(profiles)),
        divergence: [], reqDivergence: [] };
    const D = {
        putJson: async (p, b) => { log.put.push([p, JSON.parse(JSON.stringify(b))]);
            if (putFail) throw Object.assign(new Error('server ' + putFail), { status: putFail });
            return {}; },
        postJson: async (p, b) => { log.post.push([p, JSON.parse(JSON.stringify(b))]); return {}; },
    };
    const window = { UpliftModelSpec: {
        adaptToServerSettings: ov => ov,
        buildPayload: () => JSON.parse(JSON.stringify(payloadVals)),
    } };
    const st = { seTabs: tabs, seActiveTab: 'base', seBaseVals, seValues,
                 seModel: 'M1', seFormModel };
    for (const n of Object.keys(st)) {
        if (n in globalThis) delete globalThis[n];
        Object.defineProperty(globalThis, n, { configurable: true,
            get: () => st[n], set: v => { st[n] = v; } });
    }
    const api = new Function('D', 'API', 'window', 'MM_DATA', 'CHIPS', 'MM_GLUE',
        'document', 'seNormalizeKwargs', 'renderEditorFields', 'seModelEntry',
        CODE + '\nreturn { seBaseEditKeys, seApplyBaseEditsToProfiles, seSyncBaseToProfiles };')(
        D, '', window, MM_DATA,
        { clearProfileCache: m => log.cleared.push(m) },
        { toast: () => {}, modelSettingsFields: async () => null },
        { getElementById: () => null, querySelector: () => null },
        () => {}, () => {}, () => ({}));
    return { api, log, MM_DATA, st };
}

test('seBaseEditKeys: KEY_MAP expansion + kwargs drift; null when clean', () => {
    const clean = harness({ profiles: [], tabs: [{ id: 'base', dirty: new Set() , origVals: {}}] , baseTab: 1 });
    assert.equal(clean.api.seBaseEditKeys(), null, 'no dirty, no kwargs drift -> nothing to apply');
    const h = harness({ profiles: [], tabs: [{ id: 'base', dirty: new Set(['temperature', 'enableThinkingBudget']), origVals: { ctKwargEntries: [] } }],
        seValues: { temperature: 1, ctKwargEntries: [{ k: 1 }] } });
    const keys = [...h.api.seBaseEditKeys()];
    assert.deepEqual(keys.sort(), ['chat_template_kwargs', 'forced_ct_kwargs', 'temperature',
        'thinking_budget_enabled', 'thinking_budget_tokens'],
        'derived keys expand via SE_KEY_MAP; kwargs ride their entry diff');
});

test('apply-edits writes ONLY the edited keys as overrides; other divergence survives', async () => {
    const profiles = [
        { name: 'fast', display_name: 'fast', api_name: 'fast',
          settings: { temperature: 0.3, top_p: 0.9, max_context_window: 4096 } },
        { name: 'slow', display_name: 'slow', api_name: 'slow',
          settings: { temperature: 0.9, top_p: 0.5 } },
    ];
    const h = harness({ profiles, payloadVals: { temperature: 0.3 } });
    const targets = h.MM_DATA.profiles.filter(p => p.name === 'fast');  // ticked set only
    const n = await h.api.seApplyBaseEditsToProfiles(new Set(['temperature']), {}, targets);
    assert.equal(n, 1, 'only the ticked profile is written');
    assert.equal(h.log.put.length, 1);
    const [p, body] = h.log.put[0];
    assert.equal(p, '/admin/api/models/M1/profiles/fast');
    assert.deepEqual(body.settings, { temperature: 0.3, top_p: 0.9, max_context_window: 4096 },
        'temperature overwritten; top_p/max_context divergence byte-identical (their point)');
    assert.deepEqual(h.log.cleared, ['M1'], 'alias chips cache invalidated');
});

test('apply-edits: a null base value drops the key (back to inherit) incl. legacy twin', async () => {
    const profiles = [{ name: 'p', display_name: 'p', settings: {
        mtp_adaptive_max_depth: '4', temperature: 0.5 } }];
    const h = harness({ profiles, payloadVals: { mtp_adaptive_max_depth: null } });
    await h.api.seApplyBaseEditsToProfiles(new Set(['mtp_adaptive_max_depth']), {},
        h.MM_DATA.profiles);
    assert.deepEqual(h.log.put[0][1].settings, { temperature: 0.5 },
        'the edited-to-null key leaves the overrides; everything else stays');
});

test('apply-edits kwargs: replaced wholesale, cleared on null', async () => {
    const profiles = [{ name: 'p', display_name: 'p', settings: {
        chat_template_kwargs: '{"a":1}', temperature: 0.5 } }];
    const h = harness({ profiles,
        payloadVals: { chat_template_kwargs: '{"b":2}', forced_ct_kwargs: null } });
    await h.api.seApplyBaseEditsToProfiles(
        new Set(['chat_template_kwargs', 'forced_ct_kwargs']), {}, h.MM_DATA.profiles);
    assert.deepEqual(h.log.put[0][1].settings,
        { temperature: 0.5, chat_template_kwargs: '{"b":2}' },
        'base kwargs replace the stored ones; null forced clears');
});

test('demoted full-reset keeps its semantics: removes the WHOLE diff set', async () => {
    const profiles = [{ name: 'p', display_name: 'p', settings: {
        temperature: 0.5, top_p: 0.9, max_context_window: 4096 } }];
    const h = harness({ profiles });
    const diverging = [{ name: 'p', display_name: 'p',
        diff: [{ key: 'temperature' }, { key: 'top_p' }] }];
    const n = await h.api.seSyncBaseToProfiles(diverging, false);
    assert.equal(n, 1);
    assert.deepEqual(h.log.put[0][1].settings, { max_context_window: 4096 },
        'both diverging keys dropped -> inherit again (the heavy verb, still reachable)');
});

test('shared write seam: an open profile tab re-bases and loses dirty (no stale re-save)', async () => {
    const profiles = [{ name: 'fast', display_name: 'fast', settings: { temperature: 0.9 } }];
    const tab = { id: 'p1', profileId: 'fast', overrides: { temperature: 0.9 },
        _ovSnap: { temperature: 0.9 }, workVals: { temperature: 0.9 },
        origVals: { temperature: 0.9 }, dirty: new Set(['top_k']) };
    const h = harness({ profiles, tabs: [{ id: 'base', dirty: new Set(), origVals: {} }, tab],
        payloadVals: { temperature: 0.3 } });
    await h.api.seApplyBaseEditsToProfiles(new Set(['temperature']), {}, h.MM_DATA.profiles);
    assert.equal(tab.dirty.size, 0, 'tab re-based onto the written record');
    assert.deepEqual(tab.overrides, { temperature: 0.3 });
    assert.deepEqual(JSON.parse(JSON.stringify(h.MM_DATA.profiles[0].settings)), { temperature: 0.3 },
        'the stored mirror updates for the next diff computation');
});

test('missing base model: the classic PUT 404 falls back to the uplift upsert (saveProfileTab parity)', async () => {
    const profiles = [{ name: 'p', display_name: 'p', settings: { temperature: 0.9 } }];
    const h = harness({ profiles, payloadVals: { temperature: 0.3 }, putFail: 404 });
    const n = await h.api.seApplyBaseEditsToProfiles(new Set(['temperature']), {}, h.MM_DATA.profiles);
    assert.equal(n, 1);
    assert.equal(h.log.put.length, 1, 'classic PUT attempted');
    assert.equal(h.log.post.length, 1, '404 fell back to the uplift upsert');
    assert.equal(h.log.post[0][0], '/uplift/api/models/M1/profiles');
    assert.equal(h.log.post[0][1].name, 'p');
    assert.deepEqual(h.log.post[0][1].settings, { temperature: 0.3 });
});

test('a NON-404 PUT failure propagates — no silent success', async () => {
    const profiles = [{ name: 'p', display_name: 'p', settings: { temperature: 0.9 } }];
    const h = harness({ profiles, payloadVals: { temperature: 0.3 }, putFail: 500 });
    await assert.rejects(() => h.api.seApplyBaseEditsToProfiles(
        new Set(['temperature']), {}, h.MM_DATA.profiles));
});
