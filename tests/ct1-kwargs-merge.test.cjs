/* CT-1: chat-template kwargs rows must merge BY IDENTITY.

   Reported symptom (user screenshot 2026-10-03): the Chat Template Kwargs
   section showed two identical 'reasoning_effort' rows. Root cause lived
   in the editor's seNormalizeKwargs keep-filter (`!(e.key in raw)`):
   typed entries carry no e.key, so the base row always survived the
   merge on top of its rebuilt twin. Trigger path: a profile tab whose
   overrides still hold raw chat_template_kwargs merged over base entries
   (first render after seRestoreTab / apply), before seSyncKwEntries
   drops the raw twins.

   The fix moved the merge into modelspec.mergeRawKwargs (pure,
   require()-able — TST-1 pattern) so this file pins it directly. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../omlx_uplift/static/modelspec.js');

test('kwargIdentity: typed kinds map to fixed keys, custom trims, blank is none', () => {
    assert.equal(S.kwargIdentity({ type: 'reasoning_effort' }), 'reasoning_effort');
    assert.equal(S.kwargIdentity({ type: 'enable_thinking' }), 'enable_thinking');
    assert.equal(S.kwargIdentity({ type: 'custom', key: ' my_key ' }), 'my_key');
    assert.equal(S.kwargIdentity({ type: 'custom', key: '  ' }), null);
    assert.equal(S.kwargIdentity({ type: 'custom' }), null);
    assert.equal(S.kwargIdentity(null), null);
});

test('CT-1 regression: base typed entry + raw payload merge to ONE row', () => {
    const raw = { reasoning_effort: 'medium' };
    const baseEntries = S.buildCtKwargEntries(raw, [], false);
    assert.equal(baseEntries.length, 1);
    // OLD code: keep = baseEntries.filter(e => !(e.key in raw)) -> typed row
    // has no e.key, `undefined in raw` is false, filter keeps it, merge
    // produced 2 rows. New merge drops it as an identity collision:
    const merged = S.mergeRawKwargs(raw, [], baseEntries, false);
    assert.equal(merged.length, 1, 'reasoning_effort must not double');
    assert.equal(merged[0].value, 'medium');
    assert.equal(merged.filter(e => e.type === 'reasoning_effort').length, 1);
});

test('same for enable_thinking', () => {
    const raw = { enable_thinking: true };
    const merged = S.mergeRawKwargs(raw, [], S.buildCtKwargEntries(raw, [], false), false);
    assert.equal(merged.filter(e => e.type === 'enable_thinking').length, 1);
});

test('custom rows merge by their own key; raw wins on collision', () => {
    const raw = { my_key: 'new' };
    const existing = [
        { type: 'custom', key: 'my_key', value: 'old', force: false },
        { type: 'custom', key: 'other', value: 'keep', force: false },
    ];
    const merged = S.mergeRawKwargs(raw, [], existing, false);
    const mine = merged.filter(e => e.key === 'my_key');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].value, 'new', 'raw payload wins');
    assert.ok(merged.some(e => e.key === 'other'), 'unrelated rows kept');
});

test('untitled custom rows (mid-typing) are kept, never collide', () => {
    const raw = { reasoning_effort: 'low' };
    const existing = [{ type: 'custom', key: '', value: '', force: false }];
    const merged = S.mergeRawKwargs(raw, [], existing, false);
    assert.equal(merged.length, 2);
    assert.ok(merged.some(e => e.type === 'custom' && e.key === ''));
});

test('payload round-trip after merge writes a single value', () => {
    const raw = { reasoning_effort: 'medium' };
    const merged = S.mergeRawKwargs(raw, [], S.buildCtKwargEntries(raw, [], false), false);
    const p = S.buildPayload({ ctKwargEntries: merged, is_diffusion_model: false }, {});
    assert.deepEqual(p.chat_template_kwargs, { reasoning_effort: 'medium' });
});
