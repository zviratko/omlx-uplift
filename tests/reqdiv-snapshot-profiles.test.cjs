/* REQ-DIV: modelspec.requestDiff / eqBase — the snapshot profile semantics.

   A profile is a SNAPSHOT of the base at save time. The server merges
   profile.settings over base.settings per request, so:
   - a key the profile does not store IS truly inherited -> never a row;
   - a key the profile stores diverges when it differs from the base's
     EFFECTIVE value (stored base value, else the server-reported fallback);
   - a stored value that EQUALS the base behaves like inheritance today —
     eqBase says so, and the editor tags the row (= base).
   This file pins the semantics against the real-world shape of a
   classic-created full-snapshot profile on the dev store. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../omlx_uplift/static/modelspec.js');

const GS = { sampling: { temperature: 1.0, top_p: 0.95, top_k: 0,
                         repetition_penalty: 1.0, max_tokens: 32768,
                         max_context_window: 65536 },
             idle_timeout: { idle_timeout_seconds: null } };
const MODEL = { model_context_length: 131072, thinking_default: true };

// base payload shape (buildPayload output): stored values, null = unset
function baseP(over) {
    return Object.assign({ max_context_window: 262145, max_tokens: 65536,
        temperature: null, top_p: 0.95, top_k: 20, min_p: null,
        presence_penalty: null, enable_thinking: true,
        thinking_budget_enabled: false, thinking_budget_tokens: 0,
        guided_grammar_enabled: false, guided_grammar: null,
        chat_template_kwargs: null, forced_ct_kwargs: null }, over || {});
}
const keys = d => d.map(r => r.key);

test('truly inherited keys (not stored by the profile) never produce rows', () => {
    const prof = { top_p: 0.95 };                  // temperature NOT stored
    const d = S.requestDiff(baseP({ temperature: 0.3 }), prof, MODEL, GS);
    assert.deepEqual(keys(d), [], 'base moved under an unsaved temperature edit: '
        + 'profile does not store temperature, so it inherits — no drift');
});

test('stored value equal to effective base -> no row; eqBase says inherited-like', () => {
    const prof = { temperature: 1, top_p: 0.95, top_k: 20, presence_penalty: 1.5,
                   max_context_window: 262145 };
    const d = S.requestDiff(baseP(), prof, MODEL, GS);
    assert.deepEqual(keys(d), [], 'snapshot matches base on every stored key');
    assert.ok(S.eqBase(1, 1, 'temperature', MODEL, GS), '1 stored vs 1');
    assert.ok(S.eqBase(1.0, null, 'top_k', MODEL,
        { sampling: Object.assign({}, GS.sampling, { top_k: 1 }) }), 'stored vs fallback');
    assert.ok(!S.eqBase(0.7, 1, 'temperature', MODEL, GS), '0.7 vs base 1');
});

test('the real general-thinking drift: base ctx moved to 262145, snapshot has 262144', () => {
    const prof = { max_context_window: 262144, temperature: 1, top_p: 0.95,
                   presence_penalty: 1.5 };
    const d = S.requestDiff(baseP(), prof, MODEL, GS);
    assert.deepEqual(keys(d), ['max_context_window'],
        'only ctx drifts; presence 1.5-vs-unset stays silent (no reported ' +
        'fallback to compare against — honesty rule)');
});

test('presence/min_p: base unset with NO reported fallback -> no claim', () => {
    const d = S.requestDiff(baseP({ presence_penalty: null, min_p: null }),
        { presence_penalty: 1.5, min_p: 0.1 }, MODEL, GS);
    assert.deepEqual(keys(d).filter(k => k === 'presence_penalty' || k === 'min_p'),
        [], 'engine-internal defaults are not server data — claim nothing');
});

test('base unset but fallback REPORTED: stale snapshot surfaces as drift', () => {
    // base stores no temperature (falls back to global 1.0); profile
    // snapshot froze 0.7 — requests under the profile serve 0.7
    const d = S.requestDiff(baseP({ temperature: null }),
        { temperature: 0.7 }, MODEL, GS);
    assert.deepEqual(keys(d), ['temperature']);
    assert.equal(d[0].base, 1.0, 'row shows the EFFECTIVE base value');
    assert.equal(d[0].other, 0.7);
});

test('gated knob with master off on BOTH sides is no row (DIV-1, request edition)', () => {
    const d = S.requestDiff(
        baseP({ thinking_budget_enabled: false, thinking_budget_tokens: 0 }),
        { thinking_budget_enabled: false, thinking_budget_tokens: 4096 }, MODEL, GS);
    assert.ok(!keys(d).includes('thinking_budget_tokens'));
    const d2 = S.requestDiff(
        baseP({ thinking_budget_enabled: true, thinking_budget_tokens: 2048 }),
        { thinking_budget_enabled: true, thinking_budget_tokens: 4096 }, MODEL, GS);
    assert.ok(keys(d2).includes('thinking_budget_tokens'), 'both masters on: real drift');
});

test('enable_thinking falls back to the model default the entry reports', () => {
    const d = S.requestDiff(baseP({ enable_thinking: null }),
        { enable_thinking: false }, MODEL, GS);
    assert.deepEqual(keys(d), ['enable_thinking'], 'thinking_default true vs snapshot false');
    const noDefault = S.requestDiff(baseP({ enable_thinking: null }),
        { enable_thinking: false }, { model_context_length: 8192 }, GS);
    assert.ok(!keys(noDefault).includes('enable_thinking'), 'no reported default: no claim');
});

test('kwargs compare as one honest lump row', () => {
    const d = S.requestDiff(baseP({ chat_template_kwargs: { reasoning_effort: 'low' } }),
        { chat_template_kwargs: { reasoning_effort: 'high' } }, MODEL, GS);
    assert.ok(keys(d).includes('chat_template_kwargs'));
    const same = S.requestDiff(baseP({ chat_template_kwargs: { a: 1, b: 2 } }),
        { chat_template_kwargs: { b: 2, a: 1 } }, MODEL, GS);
    assert.ok(!keys(same).includes('chat_template_kwargs'), 'key order is not drift');
});

test('0 vs 0.0 vs false-ish: display equality rules', () => {
    const d = S.requestDiff(baseP({ min_p: null }), { min_p: 0 }, MODEL, GS);
    // min_p base unset AND unreported -> no claim regardless of the 0
    assert.ok(!keys(d).includes('min_p'));
    const d2 = S.requestDiff(baseP({ temperature: 0 }), { temperature: 0.0 }, MODEL, GS);
    assert.deepEqual(keys(d2), [], '0 === 0.0 is not drift');
});
