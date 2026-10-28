// SPEC-1 (user 2026-10-28): the SpecPrefill activation split — contract of the
// uplift editor mirror. The four model-load knobs must be LOCKED on profile
// tabs (the server strips them from profile settings, so an alias edit saves
// nothing); the activation row is the only SpecPrefill field an alias may
// differ on, and must stay editable under a locked master.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname,
    '../omlx_uplift/static/uplift_mmeditor.js'), 'utf8');
const body = (fn) => {
    const i = SRC.indexOf('function ' + fn);
    assert.ok(i >= 0, 'missing function ' + fn);
    let depth = 0, j = SRC.indexOf('{', i);
    for (let k = j; k < SRC.length; k++) {
        if (SRC[k] === '{') depth++;
        else if (SRC[k] === '}' && --depth === 0) return SRC.slice(i, k + 1);
    }
    assert.fail('unbalanced ' + fn);
};

test('SPEC-1: master and drafter are locked on profile tabs; knobs are not', () => {
    for (const k of ['specprefill_enabled', 'specprefill_draft_model'])
        assert.match(SRC, new RegExp('seLockOnProfile\\([^)]*\\b' + k + '\\b'),
            k + ' must carry a profile-tab lock');
    for (const k of ['specprefill_keep_pct', 'specprefill_threshold'])
        assert.ok(!new RegExp('seLockOnProfile\\([^)]*\\b' + k + '\\b').test(SRC),
            k + ' is alias-tunable (v3) and must NOT be locked');
});
test('SPEC-1: the activation row is NOT locked (it is THE alias field)', () => {
    assert.ok(!/seLockOnProfile\([^)]*specprefill_auto_enabled/.test(SRC));
    // and it is a family child under the locked master
    assert.match(SRC, /seFam\(g, 'specprefill_enabled', spBool, \[spAuto/);
});
test('SPEC-1: locking a row never propagates via gate state', () => {
    const g = body('seGateEnabled');
    assert.match(g, /lockProf/, 'gate walk must honour [data-lock-prof]');
    // family gating reads seValues[masterKey], not the master's DOM input —
    // the locked master's own row carries no data-gate attribute
    const fam = body('seFam');
    assert.ok(!/masterRow[^;]*dataset\.gate/.test(fam),
        'seFam must not stamp data-gate on the master row');
});
test('SPEC-1: lock reason is localised in both uplift catalogs', () => {
    for (const loc of ['en', 'cs']) {
        const d = JSON.parse(fs.readFileSync(path.join(__dirname,
            '../omlx_uplift/locales/' + loc + '.json'), 'utf8'));
        assert.ok(d['uplift.se.specprefill.load_locked'],
            loc + ' catalog lacks the lock reason');
    }
});
