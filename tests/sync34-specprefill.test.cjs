// SYNC-1 run 34 (upstream 69abd86f #5562): the native per-alias SpecPrefill
// split replaces the specprefill-profile patch (PR jundot/omlx#4928, closed
// by the user as superseded). Contract of the uplift editor mirror: the
// activation row and the profile locks are gone, the master+drafter pair is
// a CONDITIONAL reload key (modelspec specprefillQueuedRebuild) measured on
// the base tab only, and the RELOAD badge renders whenever it can apply.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname,
    '../omlx_uplift/static/uplift_mmeditor.js'), 'utf8');
const SPEC = fs.readFileSync(path.join(__dirname,
    '../omlx_uplift/static/modelspec.js'), 'utf8');

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

test('run34: the activation row and the profile locks are gone', () => {
    assert.ok(!/specprefill_auto_enabled/.test(SRC),
        'the retired patch field must not survive in the editor');
    assert.ok(!/specprefill_auto_enabled/.test(SPEC),
        'the retired patch field must not survive in modelspec');
    assert.ok(!/seLockOnProfile\(/.test(SRC), 'no profile locks remain');
    assert.ok(!/load_locked/.test(SRC), 'the dead lock reason must be gone');
});
test('run34: seIsRuntimeKey measures the conditional SpecPrefill rebuild', () => {
    assert.match(body('seIsRuntimeKey'), /seSpQueuedRebuild\(k\)/);
    const fn = body('seSpQueuedRebuild');
    // base tab only — an alias never owns an engine rebuild (#5562 shares it)
    assert.match(fn, /seIsBaseTab\(\)/);
    assert.match(fn, /specprefillQueuedRebuild/);
    assert.match(fn, /specprefill_enabled.*specprefill_draft_model/s);
});
test('run34: the RELOAD badge renders conditionally on the base tab', () => {
    const i = SRC.indexOf('specprefillReloadPossible');
    assert.ok(i > 0, 'badge branch missing');
    const win = SRC.slice(i - 260, i + 320);
    assert.match(win, /seIsBaseTab\(\)/, 'badge must be base-tab only');
    assert.match(win, /uplift\.se\.specprefill\.reload_title/);
});
test('run34: the family renders without the activation child', () => {
    assert.match(SRC,
        /seFam\(g, 'specprefill_enabled', spBool, \[spDraft, spKeep, spThr\]\)/);
});
test('run34: family gating still reads the master state, not its DOM input', () => {
    // carried over from spec1-load-lock: seFam must not stamp data-gate on
    // the master row (the master row carries no gate attribute itself)
    const fam = body('seFam');
    assert.ok(!/masterRow[^;]*dataset\.gate/.test(fam),
        'seFam must not stamp data-gate on the master row');
});
test('run34: the reload title is localised in every uplift catalog', () => {
    const dir = path.join(__dirname, '../omlx_uplift/locales');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.ok(d['uplift.se.specprefill.reload_title'],
            f + ' catalog lacks the reload title');
        assert.ok(!('uplift.se.specprefill.load_locked' in d),
            f + ' catalog still carries the dead lock reason');
    }
});
