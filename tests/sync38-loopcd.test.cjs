/* SYNC-1 run 38 pins: LoopCD contrastive decoding (upstream 6ff0b269 #5640).
   Two new ModelSettingsRequest fields, rendered by classic for ONE config
   type only. These pin the four places the mirror has to land: the editor
   state, the always-sent payload, the engine_pool signature replica and the
   type-flip strip - plus the row itself, which no vm harness mounts (the
   editor DOM is hand-built), so it is pinned by source shape. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const S = require('../omlx_uplift/static/modelspec.js');
const { allStaticJs } = require('./static-src.cjs');

const LOOP = (over = {}) => Object.assign({
    id: 'l1', model_type: 'llm', config_model_type: 'inkling2_loop',
}, over);
const OTHER = (over = {}) => Object.assign({
    id: 'm1', model_type: 'llm', config_model_type: 'qwen3_5',
}, over);
const EMB = (over = {}) => Object.assign({
    id: 'e1', model_type: 'embedding', config_model_type: 'inkling2_loop',
}, over);

/* ---- buildState: unset means OFF (classic dashboard.js:2363-2364) ---- */
test('run 38: buildState reads the LoopCD pair as plain OFF-by-default bools', () => {
    const st = S.buildState(LOOP(), {});
    assert.strictEqual(st.loopcd_enabled, false);
    assert.strictEqual(st.loopcd_skip_thinking, false);
    // a stored non-bool must not read as on (classic uses === true)
    const s2 = S.buildState(LOOP(), { loopcd_enabled: 'yes' });
    assert.strictEqual(s2.loopcd_enabled, false);
    const s3 = S.buildState(LOOP(), { loopcd_enabled: true, loopcd_skip_thinking: true });
    assert.strictEqual(s3.loopcd_enabled, true);
    assert.strictEqual(s3.loopcd_skip_thinking, true);
});

/* ---- buildPayload: always-sent base, both directions ---- */
test('run 38: buildPayload sends the pair on every generation model', () => {
    const on = S.buildPayload(S.buildState(LOOP(),
        { loopcd_enabled: true, loopcd_skip_thinking: true }), LOOP());
    assert.strictEqual(on.loopcd_enabled, true);
    assert.strictEqual(on.loopcd_skip_thinking, true);
    // an off save must WRITE false, not omit the key: a stored true has to
    // be clearable (PUT merges, an omitted key would keep it)
    const off = S.buildPayload(S.buildState(LOOP(), {}), LOOP());
    assert.strictEqual(off.loopcd_enabled, false);
    assert.strictEqual(off.loopcd_skip_thinking, false);
    // classic sends it for a non-loop family too - the server does the gate
    const other = S.buildPayload(S.buildState(OTHER(),
        { loopcd_enabled: true }), OTHER());
    assert.strictEqual(other.loopcd_enabled, true);
});

/* ---- type flip: the pair is type-only material ---- */
test('run 38: a non-LLM type flip strips the pair from the PUT', () => {
    const p = S.buildPayload(S.buildState(EMB(),
        { loopcd_enabled: true, loopcd_skip_thinking: true }), EMB());
    assert.ok(!('loopcd_enabled' in p), 'loopcd_enabled leaked on an embedding type');
    assert.ok(!('loopcd_skip_thinking' in p), 'loopcd_skip_thinking leaked on an embedding type');
    assert.ok(S.TYPE_ONLY_KEYS.has('loopcd_enabled'));
    assert.ok(S.TYPE_ONLY_KEYS.has('loopcd_skip_thinking'));
});

test('run 38: an ON LoopCD is named as sticky settings after a type flip', () => {
    // the server gate reads config_model_type, not the override, so a stored
    // true keeps its effect on a flipped checkpoint - the warning must say so
    assert.deepStrictEqual(S.stickyForType({ loopcd_enabled: true }),
        ['loopcd_enabled']);
    assert.deepStrictEqual(S.stickyForType({ loopcd_enabled: false,
                                             loopcd_skip_thinking: true }), []);
});

/* ---- runtime signature: engine_pool.py:1512-1515 shape ---- */
test('run 38: runtimeSignature mirrors the engine_pool LoopCD gating', () => {
    const rt = (over = {}) => S.buildPayload(S.buildState(LOOP(), over), LOOP());
    const on = rt({ loopcd_enabled: true, loopcd_skip_thinking: true });
    const off = rt({ loopcd_enabled: false, loopcd_skip_thinking: false });
    // the knob is signature material ONLY while the master is on: a flip of
    // it under an off master must not claim a reload
    assert.deepStrictEqual(S.runtimeDiff(off, rt({ loopcd_enabled: false,
        loopcd_skip_thinking: true })), []);
    // master on + knob on together: both rows (the knob's raw value moved too,
    // so DIV-2's display-equal suppression does not apply)
    assert.deepStrictEqual(S.runtimeDiff(off, on).map(r => r.key).sort(),
        ['loopcd_enabled', 'loopcd_skip_thinking']);
    // master-only change still reloads
    const d2 = S.runtimeDiff(rt({ loopcd_enabled: false }), rt({ loopcd_enabled: true }));
    assert.deepStrictEqual(d2.map(r => r.key), ['loopcd_enabled']);
    // knob change under an ON master is its own row
    assert.deepStrictEqual(S.runtimeDiff(on, rt({ loopcd_enabled: true,
        loopcd_skip_thinking: false })).map(r => r.key), ['loopcd_skip_thinking']);
    // and both keys are declared runtime material (drives the RELOAD badge)
    assert.ok(S.RUNTIME_SETTING_KEYS.has('loopcd_enabled'));
    assert.ok(S.RUNTIME_SETTING_KEYS.has('loopcd_skip_thinking'));
    assert.strictEqual(S.sigMasterKey('loopcd_skip_thinking'), 'loopcd_enabled');
});

/* ---- the editor row: no vm harness mounts the hand-built DOM ---- */
test('run 38: the editor renders the LoopCD family for inkling2_loop only', () => {
    const all = allStaticJs();
    // gated on classic's exact config type, and diffusion-excluded like the
    // rest of the ms-experimental section
    assert.match(all, /S\.normType\(m && m\.config_model_type\) === 'inkling2_loop'/,
        'the LoopCD block must carry classic\'s inkling2_loop gate');
    assert.match(all, /seFam\(g, 'loopcd_enabled',/,
        'the knob must be a gated family member, not a loose row');
    // labels + hints ride classic's own i18n keys (translated in all 12
    // classic locales through the mounted catalog, zero uplift locale edits)
    for (const k of ['modal.model_settings.loopcd', 'modal.model_settings.loopcd_hint',
                     'modal.model_settings.loopcd_skip_thinking',
                     'modal.model_settings.loopcd_skip_thinking_hint'])
        assert.ok(all.includes(`'${k}'`), `row must resolve classic's ${k}`);
});

test('run 38: no uplift locale copy of the classic LoopCD text exists', () => {
    // doctrine: a row on classic's keys must NOT also grow an uplift.se.*
    // copy - seBind looks up 'uplift.se.' + key FIRST, so a copy would
    // silently mask the classic value and go stale on the next reword.
    const fs = require('fs');
    const dir = path.join(__dirname, '..', 'omlx_uplift', 'locales');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of Object.keys(cat))
            assert.ok(!/^uplift\.(se|ui)\.loopcd/.test(k),
                `${f}: LoopCD text must live on classic's key, not ${k}`);
    }
});
