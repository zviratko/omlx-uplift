/* Four user-reported bugs, 2026-11-02. Each block pins the USER-VISIBLE
   symptom, not the internals:

   1. RETIRED catalog patch (audio-deps-in-base): a curated entry we deleted
      kept its card green and the upgrade log said "source re-gate failed -
      HTTP 404". The dashboard now shows a RETIRED chip, so the chip label,
      its wording keys (ptMsg keys are invisible to test_locale_sync - pinned
      here) and the check-toast verdict are pinned below.
   2. Enable Thinking row: uplift hid it whenever the server reported no
      default, so a Llama/Qwen2/SmolLM model had no thinking knob at all
      while classic always shows one. Negative pin on the old gate +
      positive pin on the row the user needs.
   3. kwargs never light SAVE: a reasoning-effort edit counted in the tab
      total but in nothing that armed the button. Driven behaviourally
      through the real seUpdateSaveBtn (u84 slicing pattern).
   4. SAVE that reloaded the model: max_context_window (past the native
      window on a YaRN family) and activation_fp16_enabled are engine
      signature material server-side and were not classified here. Pinned
      against modelspec's signature replica, which mirrors
      engine_pool._engine_runtime_signature.

   uplift_mmeditor.js is a browser IIFE: the regions are sliced from the
   checked-in source and run against a fake DOM (each test file is its own
   process, so the globalThis accessors stay out of other suites).
   new Function below receives ONLY this repository's own checked-in text -
   no external input reaches the function body (house slicing pattern). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');
const S = require('../omlx_uplift/static/modelspec.js');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
const psrc = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
function region(a, b, label) {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, 'slice region must exist: ' + label);
    return src.slice(i, j);
}

/* ================= (4) engine-signature classification ================== */

const YARN = { config_model_type: 'qwen3_5', model_context_length: 262144 };
const PLAIN = { config_model_type: 'llama', model_context_length: 131072 };

test('BUG4: activation_fp16_enabled is reload material on every model', () => {
    assert.ok(S.RUNTIME_SETTING_KEYS.has('activation_fp16_enabled'),
        'engine_pool adds it to the signature unconditionally');
    const off = S.runtimeSignature({ activation_fp16_enabled: false });
    const on = S.runtimeSignature({ activation_fp16_enabled: true });
    assert.notDeepEqual(off, on, 'the signature must move with it');
    assert.deepEqual(S.runtimeDiff({ activation_fp16_enabled: false },
                                   { activation_fp16_enabled: true })
        .map(d => d.key), ['activation_fp16_enabled']);
});

test('BUG4: a context window past the native one is reload material', () => {
    const lo = { max_context_window: 262144 };
    const hi = { max_context_window: 524288 };
    assert.ok(S.ctxRebuilds(YARN, 262144, 524288),
        'YaRN family crossing its native window rebuilds the engine');
    assert.ok(!S.ctxRebuilds(YARN, 65536, 131072),
        'both under the native window: no scaling, no reload');
    assert.ok(!S.ctxRebuilds(YARN, 524288, 524288), 'unchanged is unchanged');
    assert.ok(!S.ctxRebuilds(PLAIN, 131072, 524288),
        'not a YaRN family: the window is a request-time limit');
    // and the signature replica says the same thing, keyed by the SETTING so
    // the CHANGES line and the divergence banner name what the user moved
    const d = S.runtimeDiff(lo, hi, YARN);
    assert.deepEqual(d.map(x => x.key), ['max_context_window']);
    assert.deepEqual(S.runtimeDiff(lo, hi, PLAIN), []);
    assert.deepEqual(S.runtimeDiff(lo, hi), [],
        'no model entry -> no claim (other signature entries are payload-only)');
});

test('BUG4: the editor classifies the window from the queued value', () => {
    // the row badge is static (dirty state must not move the form) and is
    // rendered for a family it can be true for, with the bound in the title
    assert.match(src,
        /else if \(key === 'max_context_window' && window\.UpliftModelSpec\.yarnFamily\(seFormModel\)\)/,
        'context row carries a conditional RELOAD badge');
    assert.match(src, /function seCtxQueuedRebuild\(k\) \{[\s\S]{0,400}ctxRebuilds\(seFormModel, orig, seValues\[k\]\)/,
        'seIsRuntimeKey must consult the queued window, not a static set');
    assert.match(src, /RUNTIME_SETTING_KEYS\.has\(k\) \|\|\s*\n\s*seCtxQueuedRebuild\(k\)/,
        'the conditional key rides the same predicate the badges use');
});

/* ===================== (3) kwargs arm the SAVE button =================== */

const CODE = [
    region('function seDirtyKeys', '/* ---- EFF-1', 'dirty-key helpers'),
    region('function seUpdateSaveBtn', '/* CHANGES box', 'button refresh'),
    region('function seTabChangeCount', 'function seActivateTab', 'tab totals'),
    region('function seTab()', 'function seBind', 'tab accessors'),
    region('function seKwargMap', '/* ---- spec-driven settings form', 'kwarg lines'),
].join('\n');

function btnHarness({ entries = [], origEntries = [], dirty = [], values = {} } = {}) {
    const cls = new Set();
    const btn = { disabled: true, textContent: 'SAVE', title: '',
        classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
                     add: c => cls.add(c), remove: c => cls.delete(c),
                     contains: c => cls.has(c) } };
    const st = {
        seValues: Object.assign({ ctKwargEntries: entries }, values),
        seOrig: { ctKwargEntries: origEntries },
        seBaseVals: {}, seBaseRaw: {}, seDeferred: {},
        seTabs: [{ id: 'base', dirty: new Set(dirty), workVals: {},
                   origVals: { ctKwargEntries: origEntries } }],
        seActiveTab: 'base',
    };
    for (const n of Object.keys(st)) {
        if (n in globalThis) delete globalThis[n];
        Object.defineProperty(globalThis, n, {
            configurable: true, get: () => st[n], set: v => { st[n] = v; },
        });
    }
    const rail = { badges: [], changes: [], div: 0 };
    const api = new Function('document', 'C', 'window', 'seFormModel', 'MM_GLUE',
        'seTtsIsDirty', 'seUpdateRailBadges', 'renderEdChanges',
        'refreshDivergence',
        CODE + '\nreturn { seUpdateSaveBtn, seKwargChanges, seTabChangeCount };')(
        { getElementById: id => (id === 'se-save' ? btn : null) },
        { tf: (k, d) => d },
        { UpliftModelSpec: S },
        { id: 'M1', loaded: true },
        { SECRET_KEYS: new Set(), gsDisplay: v => String(v), toast() {} },
        () => false,
        () => { rail.badges.push(1); },
        () => { rail.changes.push(1); },
        () => { rail.div++; });
    const refresh = () => { api.seUpdateSaveBtn(); return btn; };
    return { btn, refresh, rail, api, st };
}

test('BUG3: a reasoning-effort kwarg alone arms SAVE', () => {
    const h = btnHarness({
        origEntries: [{ type: 'reasoning_effort', value: 'low', force: false }],
        entries: [{ type: 'reasoning_effort', value: 'high', force: false }],
    });
    assert.equal(h.btn.disabled, true, 'fixture: armed only by the edit below');
    h.refresh();
    assert.equal(h.btn.disabled, false,
        'the queued kwarg must light SAVE - it used to stay dead');
    assert.equal(h.btn.textContent, 'SAVE (1)');
    assert.equal(h.btn.classList.contains('queued'), true);
});

test('BUG3: adding a kwarg entry arms SAVE; removing it again clears it', () => {
    const h = btnHarness({ entries: [], origEntries: [] });
    h.refresh();
    assert.equal(h.btn.disabled, true, 'nothing queued -> SAVE stays dead');
    h.st.seValues.ctKwargEntries = [{ type: 'enable_thinking', value: 'true', force: false }];
    h.refresh();
    assert.equal(h.btn.disabled, false, 'a new entry is a queued change');
    assert.equal(h.btn.textContent, 'SAVE (1)');
    h.st.seValues.ctKwargEntries = [];
    h.refresh();
    assert.equal(h.btn.disabled, true, 'edited back = nothing queued');
});

test('BUG3: the CHANGES rail names the kwarg that moved', () => {
    const h = btnHarness({
        origEntries: [{ type: 'reasoning_effort', value: 'low', force: false },
                      { type: 'custom', key: 'keep', value: '1', force: false }],
        entries: [{ type: 'reasoning_effort', value: 'high', force: true },
                  { type: 'custom', key: 'keep', value: '1', force: false }],
    });
    const lines = h.api.seKwargChanges(h.st.seTabs[0]);
    assert.deepEqual(lines.map(l => l.key), ['chat_template_kwargs.reasoning_effort (forced)'],
        'only the parameter that actually moved gets a line, marked as it will be saved');
    assert.equal(lines[0].orig, 'low', 'the stored value, before the force tick');
    assert.equal(lines[0].cur, 'high');
    assert.equal(lines[0].key.indexOf('keep'), -1,
        'an untouched entry never appears');
});

test('BUG3: every kwargs widget re-derives the button on edit', () => {
    // the typed/custom widgets mutate the entry in place; without a refresh
    // the button keeps its pre-edit answer (the same dead end, widget side)
    const kw = region('function renderCtKwargs', 'function editorNode', 'kwargs section');
    for (const handler of [/e\.key = key\.value; seUpdateSaveBtn\(\)/,
                           /e\.value = val\.value; seUpdateSaveBtn\(\)/,
                           /e\.customValue = cv\.value; seUpdateSaveBtn\(\)/,
                           /if \(val\.value === '__custom__'\)[\s\S]{0,120}\n\s*seSyncKwEntries\(\);/])
        assert.match(kw, handler, 'kwargs handler must refresh the save state: ' + handler);
});

/* ================== (2) Enable Thinking is always rendered ============== */

test('BUG2: the thinking row no longer hides on an unknown model default', () => {
    const basic = region("section('Basic Settings')", "section('Generation Defaults')",
        'basic settings block');
    assert.ok(!/thinking_default !== undefined/.test(basic),
        'the old gate hid the knob for every model the server says nothing about');
    assert.ok(!/m\.thinking_default[^\n]*\|\|[^\n]*seValues\.enable_thinking/.test(basic),
        'no re-created gate may claim a thinking_default verdict the server never gave');
    assert.match(basic, /if \(!S\.isDiffusion\(m\)\) \{[\s\S]{0,900}seBind\('select', 'enable_thinking'/,
        'classic parity: every non-diffusion LLM/VLM gets the row');
    assert.match(basic, /disabled: !!m\.thinking_forced/,
        'a model that always thinks keeps the row, disabled (MTP-HEAD rule)');
    // the inherit option claims nothing the server did not report
    assert.match(basic, /modal\.model_settings\.enable_thinking_default/,
        'reuses classic key: no on/off claim when thinking_default is null');
    assert.ok(!/Using model default \(on\)/.test(basic)
              && !/Using model default \(off\)/.test(basic),
        'the invented (on)/(off) labels asserted a default for every model');
});

test('BUG2: an unset thinking value still round-trips as inherit', () => {
    const p = S.buildPayload({ enable_thinking: null, ctKwargEntries: [],
                               is_diffusion_model: false }, { thinking_forced: false });
    assert.equal(p.enable_thinking, null);
    const q = S.buildPayload({ enable_thinking: false, ctKwargEntries: [],
                               is_diffusion_model: false }, { thinking_forced: false });
    assert.equal(q.enable_thinking, false, 'explicit Off survives the payload');
});

/* ===================== (1) retired catalog patch card =================== */

test('BUG1: a retired catalog patch shows RETIRED, not a silent DISABLED', () => {
    assert.match(psrc, /if \(p\.delisted\) \{[\s\S]{0,600}uplift\.patches\.retired_chip/,
        'the card carries its own chip');
    assert.match(psrc, /if \(rep\.check === 'delisted'\)/,
        'the check verdict has honest wording of its own');
    assert.match(psrc, /x\.sync === 'delisted'/,
        'a sync that retired a patch repaints the table');
});

/* Run the card's delisted branch for real: slice the shipped block out of
   uplift_patches.js and execute it against a stub cell, with ptMsg reading
   the SHIPPED en.json (not the JS fallback) - so this pins what the operator
   actually reads on the card, not just that a string appears in the source. */
test('BUG1: the retired card renders the shipped chip text', () => {
    const en = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'omlx_uplift', 'locales', 'en.json'), 'utf8'));
    const start = psrc.indexOf('if (p.delisted) {');
    assert.ok(start > 0, 'the card has a delisted branch');
    let depth = 0, end = start;
    for (let i = psrc.indexOf('{', start); i < psrc.length; i++) {
        if (psrc[i] === '{') depth++;
        else if (psrc[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
    }
    const block = psrc.slice(start, end);
    const appended = [];
    const scell = { append: x => appended.push(x) };
    const ptChip = (label, cls, title) => ({ label, cls, title });
    const ptMsg = (key, fallback) => en[key] || fallback;
    const run = new Function('p', 'scell', 'ptChip', 'ptMsg', block);

    run({ delisted: '2026-11-02T20:00:00+00:00',
          delisted_reason: 'the catalog no longer serves this patch (HTTP 404)' },
        scell, ptChip, ptMsg);
    assert.equal(appended.length, 1, 'one chip');
    assert.equal(appended[0].label, 'RETIRED');
    assert.equal(appended[0].cls, 'pt-st-warn', 'a warning, not a fault red');
    assert.match(appended[0].title, /catalog no longer serves/, 'says why: ' + appended[0].title);
    assert.match(appended[0].title, /until you remove it/,
        'names the one action left, which stays the operator\'s: ' + appended[0].title);

    appended.length = 0;
    run({ delisted: true }, scell, ptChip, ptMsg);   // no reason stamped
    assert.match(appended[0].title, /removed from the curated catalog/,
        'falls back to the shipped default wording');
});

test('BUG1: the retirement strings exist in every locale', () => {
    const keys = ['uplift.patches.retired_chip', 'uplift.patches.retired_default',
                  'uplift.patches.retired_hint', 'uplift.patches.retired_toast',
                  'uplift.se.ctx.reload_title'];
    const dir = path.join(__dirname, '..', 'omlx_uplift', 'locales');
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
    for (const k of keys) assert.ok(en[k], 'en.json missing ' + k);
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f === 'en.json') continue;
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of keys)
            assert.ok(d[k] && d[k] !== en[k], f + ' needs a translation for ' + k);
    }
});

test('BUG1: the upgrade log says retired instead of re-gate failed', () => {
    // the line the user read came from the generic error branch; the drift
    // loop now has its own verdict for a retirement, and the error branch
    // keeps its wording for a source that really did fail
    const dev = fs.readFileSync(path.join(STATIC_DIR, '..', 'devsrc.py'), 'utf8');
    const a = dev.indexOf('def _refresh_patch_sources');
    const drift = dev.slice(a, dev.indexOf('def _run_dev_build_body', a));
    assert.ok(a > 0, 'drift pass region must exist (renamed — update test)');
    const delisted = drift.indexOf('"delisted"');
    const err = drift.indexOf('"error"');
    assert.ok(delisted > 0 && err > delisted,
        'the retirement branch sits BEFORE the error branch (order is the fix)');
    assert.match(drift, /retired from the patch catalog/,
        'the drift pass names the retirement in plain words');
    assert.match(drift, /source re-gate failed/,
        'a genuine gate failure keeps its line, still naming the patch');
});
