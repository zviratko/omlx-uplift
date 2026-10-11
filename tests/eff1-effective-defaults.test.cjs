/* EFF-1: modelspec.effDefault re-exports ONLY what the server reports.
   Contract pinned here:
   - global sampling values surface as fallbacks for the keys the server's
     /admin/api/global-settings sampling section carries (temperature,
     top_p, top_k, repetition_penalty, max_tokens, max_context_window);
   - max_context_window prefers the model-native context (with the policy
     clamp), then the global fallback default;
   - keys the server does NOT report (min_p, presence_penalty) return null
     — the UI must keep its honest bare '(default)' placeholder;
   - TTL mirrors classic: pinned > global idle_timeout > no-TTL;
   - OCR models keep the honest blank for max_tokens (the engine applies a
     hidden per-family default the API cannot show);
   - templates (no server context) never claim a fallback. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../omlx_uplift/static/modelspec.js');

const GS = {
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 0, min_p: 0.1,
                repetition_penalty: 1.0, max_tokens: 32768,
                max_context_window: 65536, max_context_window_policy: null },
    idle_timeout: { idle_timeout_seconds: 600 },
};

test('sampling keys fall back to the global section verbatim', () => {
    const m = { model_context_length: 131072 };
    assert.deepEqual(S.effDefault('temperature', m, GS),
        { kind: 'global_default', value: 1.0 });
    assert.deepEqual(S.effDefault('top_p', m, GS),
        { kind: 'global_default', value: 0.95 });
    assert.deepEqual(S.effDefault('top_k', m, GS),
        { kind: 'global_default', value: 0 }, '0 is a real value, kept');
    assert.deepEqual(S.effDefault('repetition_penalty', m, GS),
        { kind: 'global_default', value: 1.0 });
});

test('min_p / presence_penalty: NOT reported by the server -> no claim', () => {
    const m = {};
    assert.equal(S.effDefault('min_p', m, GS), null);
    assert.equal(S.effDefault('presence_penalty', m, GS), null);
});

test('context window: native wins, policy clamps, global is the last tier', () => {
    assert.deepEqual(S.effDefault('max_context_window', { model_context_length: 131072 }, GS),
        { kind: 'model_config', value: 131072 });
    const pol = JSON.parse(JSON.stringify(GS));
    pol.sampling.max_context_window_policy = 32768;
    assert.deepEqual(S.effDefault('max_context_window', { model_context_length: 131072 }, pol),
        { kind: 'model_config', value: 32768 }, 'min(native, policy) per get_max_context_window');
    assert.deepEqual(S.effDefault('max_context_window', {}, GS),
        { kind: 'global_default', value: 65536 });
    assert.equal(S.effDefault('max_context_window', {},
        { sampling: { max_context_window: null } }), null);
});

test('TTL: pinned > global idle_timeout > no-TTL (classic ttlPlaceholder)', () => {
    assert.deepEqual(S.effDefault('ttl_seconds', { pinned: true }, GS), { kind: 'pinned' });
    assert.deepEqual(S.effDefault('ttl_seconds', {}, GS),
        { kind: 'global_ttl', seconds: 600 });
    assert.deepEqual(S.effDefault('ttl_seconds', {},
        { sampling: {}, idle_timeout: { idle_timeout_seconds: null } }), { kind: 'no_ttl' });
});

test('OCR model: max_tokens hidden (hidden engine tier, not reported)', () => {
    const ocr = { config_model_type: 'deepseek-ocr' };
    assert.equal(S.effDefault('max_tokens', ocr, GS), null);
    assert.deepEqual(S.effDefault('max_tokens', {}, GS),
        { kind: 'global_default', value: 32768 });
});

test('no payload -> null (fetch failed; UI keeps bare (default))', () => {
    assert.equal(S.effDefault('temperature', {}, null), null);
    assert.equal(S.effDefault('temperature', {}, {}), null);
});
