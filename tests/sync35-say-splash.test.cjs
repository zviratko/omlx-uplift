/* SYNC-1 run 35 source-shape pins.
   (1) The macOS Speech card is native since #5076 merged (2bb2332d): ONE
       toggle row, always visible - the PR draft's language rows and the
       read-only availability gate are gone from every surface, store map
       included.
   (2) The Splash card carries the #5582 (f062a272) concurrent-requests
       select: Auto (null) + 1..8, labels read from classic's i18n keys.
   Negative pins scan the WHOLE static surface (static-src.cjs), so a rename
   in one file cannot hide behind another file's copy. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { allStaticJs } = require('./static-src.cjs');
const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const GSPEC = require(path.join(STATIC, 'uplift_gspec.js'));

test('run 35: the say card is one ungated toggle row', () => {
    const gsys = fs.readFileSync(path.join(STATIC, 'uplift_gsys.js'), 'utf8');
    assert.strictEqual([...gsys.matchAll(/\{sec: 'say'/g)].length, 1,
        'exactly one say row in GS_SPEC');
    assert.match(gsys,
        /\{sec: 'say', lab: 'say\.enabled', hint: 'say\.enabled_hint', ctl: \{\s*\n\s*k: 'tog', sec: 'integrations', field: 'macos_say_enabled',\s*\n\s*flat: 'macos_say_enabled'\}\}/,
        'the say row is ungated (no show:)');
});

test('run 35: the PR-draft say surface is gone everywhere', () => {
    const all = allStaticJs();
    for (const dead of ['macos_say_autodetect', 'macos_say_language',
                        'macos_say_available', 'sayAvail'])
        assert.ok(!all.includes(dead), `${dead} still lives in the static surface`);
    assert.ok('macos_say_enabled' in GSPEC.GS_MAP, 'the native key stays mapped');
    assert.ok(!('macos_say_autodetect' in GSPEC.GS_MAP));
    assert.ok(!('macos_say_language' in GSPEC.GS_MAP));
    const dir = path.join(__dirname, '..', 'omlx_uplift', 'locales');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of Object.keys(cat))
            assert.ok(!/^uplift\.gs\.say\.(autodetect|language|ph)/.test(k),
                `${f}: dead locale key ${k}`);
    }
});

test('run 35: the splash card carries the concurrent-requests select', () => {
    const helper = fs.readFileSync(path.join(STATIC, 'uplift_helper.js'), 'utf8');
    // Labels ride classic's catalog keys - no uplift copies.
    assert.match(helper, /C\.tf\('settings\.integrations\.splash\.max_concurrent'/);
    assert.match(helper, /C\.tf\('settings\.integrations\.splash\.max_concurrent_hint'/);
    // Auto sends null (classic optionalNumber), a number sends 1..8.
    assert.match(helper, /String\(integ\.splash_max_concurrent_requests \?\? ''\)/);
    assert.match(helper,
        /splash_max_concurrent_requests:\s*\n?\s*v === '' \? null : Number\(v\)/);
    assert.match(helper, /\['', C\.tf\('settings\.integrations\.splash\.auto', 'Auto'\)\]/);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8])
        assert.ok(helper.includes(`['${n}', '${n}']`), `option ${n} missing`);
    assert.ok(!helper.includes("['9', '9']"), 'the server rejects 9 - no option for it');
});
