/* BUG-6 (user 2026-10-12): "SAVE PROFILE shows 'saving profile…' and
   nothing is saved." Root cause: saveProfileTab declared `const ov` and
   then reassigned it (adaptToServerSettings) — a runtime TypeError that
   killed EVERY profile save before a request was ever issued, and the
   uncaught rejection stranded the label on 'saving profile…'. node --check
   parses statics in SLOPPY mode (strict mode only downgrades this to a
   runtime error anyway — V8 has no parse-time check here), so the gate
   could not see it. This test RUNS the real sliced functions with fakes:
   it pins that a save issues the PUT, shows ONLY the final label (saved ✓
   or error — user doctrine: no intermediate 'saving…' status), and
   reactivates the button (disabled=dirty-cleared on success, enabled again
   after a failure). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');

// slice the two save functions out of the IIFE (they are neighbours; the
// export block marks the end) — same pattern as nat6-mode-ladder
const A = src.indexOf('async function saveProfileTab');
const B = src.indexOf('window.Uplift.mmEditor = {');
assert.ok(A > 0 && B > A, 'saveProfileTab..exports region must exist (moved — update test)');
const region = src.slice(A, B);
if (!region.includes('async function saveProfileCommit'))
    assert.fail('BUG-6 contract: saveProfileTab must delegate to saveProfileCommit');

function harness({ dirtyKeys = ['max_context_window'], putFails = null,
                  validationErrors = [] } = {}) {
    const log = { put: [], post: [], toasts: [], msgSets: [] };
    const tab = { id: 'p1', name: 'p1', profileId: 'p1', display_name: 'p1',
        expose_as_model: false, api_name: null, dirty: new Set(dirtyKeys),
        workVals: { max_context_window: 12000, temperature: 0.7 } };
    const msg = { textContent: '' };
    Object.defineProperty(msg, 'textContent', {
        get() { return this._v; },
        set(v) { this._v = v; log.msgSets.push(v); },
    });
    const btn = { disabled: false, textContent: 'SAVE PROFILE (1)' };
    const panel = { querySelector: sel => (sel === '#se-msg' ? msg : null) };
    const D = {
        putJson: async (p, b) => { if (putFails) throw putFails; log.put.push([p, b]); return {}; },
        postJson: async (p, b) => { if (putFails) throw putFails; log.post.push([p, b]); return {}; },
    };
    const MM_GLUE = {
        toast: t => log.toasts.push(t),
        modelSettingsFields: async () => new Set(['mtp_adaptive_max_depth']),
    };
    const C = { t: k => k };
    const window = { UpliftModelSpec: {
        validate: () => validationErrors,
        buildPayload: v => v,
        adaptToServerSettings: ov => ov,
    } };
    const st = { dirty: dirtyKeys.slice() };
    const f = new Function(
        'MM_GLUE', 'C', 'D', 'API', 'window', 'document',
        'seBaseVals', 'seModel', 'MM_DATA', 'seFormModel',
        'seTab', 'seDirtyKeys', 'seNormalizeKwargs', 'seModelEntry',
        'seRenderTabs', 'seUpdateSaveBtn',
        region + '\nreturn saveProfileTab;'
    )(
        MM_GLUE, C, D, '/admin', window,
        { getElementById: id => (id === 'se-save' ? btn : null) },
        { max_context_window: 8192, temperature: 0.7 }, 'M1',
        { profiles: [] }, {},
        () => tab, () => st.dirty, () => {}, () => ({}),
        () => {}, () => { st.dirty = []; btn.disabled = true; }   // success path re-derives from state
    );
    return { run: () => f(panel), log, msg, btn, tab, st };
}

test('BUG-6: profile save issues the PUT with only the keys that differ from base', async () => {
    const h = harness();
    await h.run();
    assert.equal(h.log.put.length, 1, 'classic profile PUT must fire (this is the call the const-reassign bug killed)');
    const [p, b] = h.log.put[0];
    assert.match(p, /\/admin\/api\/models\/M1\/profiles\/p1$/);
    assert.deepEqual(b.settings, { max_context_window: 12000 },
        'inheritance semantics: temperature equals base, only the changed key persists');
});

test('BUG-6 doctrine: no intermediate "saving…" label — only the final state', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.msg._v, 'saved ✓');
    for (const s of h.log.msgSets)
        assert.ok(!/^saving/i.test(s),
            `label must never pass through an intermediate '${s}' state (user doctrine)`);
});

test('BUG-6: button is busy during the request and reactivated by final state', async () => {
    const h = harness();
    const r = h.run();
    assert.equal(h.btn.disabled, true, 'disabled while the request is in flight');
    await r;
    assert.equal(h.btn.disabled, true, 'success: nothing dirty left -> stays disabled (seUpdateSaveBtn ran)');
});

test('BUG-6: a failed save shows the error and RE-ACTIVATES the button for a retry', async () => {
    const h = harness({ putFails: Object.assign(new Error('boom'), { status: 500 }) });
    await h.run();
    assert.match(h.msg._v, /^error: boom$/, 'final label carries the failure');
    assert.equal(h.btn.disabled, false, 'button reactivates — the stranded-button state was the user-visible bug');
    assert.equal(h.tab.dirty.size, 1, 'failed save keeps the tab dirty');
});

test('BUG-6: a rejected save NEVER shows saved ✓ (honesty over blanket status)', async () => {
    const h = harness({ putFails: Object.assign(new Error('nope'), { status: 500 }) });
    await h.run();
    assert.notEqual(h.msg._v, 'saved ✓');
    assert.equal(h.log.toasts.includes('uplift.toast.profile_save_failed'), true,
        'failure toast uses the existing locale key');
});

test('validation errors short-circuit before any request, with button re-enabled', async () => {
    const h = harness({ validationErrors: ['bad value'] });
    await h.run();
    assert.equal(h.log.put.length + h.log.post.length, 0, 'nothing sent when validation fails');
    assert.equal(h.msg._v, 'bad value');
    assert.equal(h.btn.disabled, false, 'reactivated so the user can fix and retry');
});

test('static pin: no SAVE path in the editor sets an intermediate "saving" label', () => {
    // The restart path ('saving + reloading…') is exempt on purpose: it is
    // a genuinely long multi-step op (PUT+unload+load) and always ends by
    // closing the editor or re-enabling its button — it cannot strand. The
    // save paths must show ONLY the final state (button carries busy).
    const offenders = [...src.matchAll(/msg\.textContent\s*=\s*'saving(?! \+ reloading)[^']*'/g)]
        .map(m => m[0]);
    assert.deepEqual(offenders, [],
        'BUG-6 doctrine: save labels show only the final state (button carries busy)');
});
