// ALIAS-DIRTY (user-reported 2026-10-28): clicking through model aliases
// inflated SAVE ALL (n) with no edit, and letting SAVE ALL run renamed the
// committed profiles' labels to their internal names until refresh.
// Root 1: seAddProfileTab seeded workVals/origVals with RAW profile
// settings; the first render normalizes chat_template_kwargs -> entries
// into workVals only, so the ctKwargEntries compare in seTabChangeCount
// counted a phantom change per visited tab. Root 2: post-save bookkeeping
// overwrote t.display_name with the internal name.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname,
    '../omlx_uplift/static/uplift_mmeditor.js'), 'utf8');
function grab(start, end) {
    const a = SRC.indexOf(start);
    assert.ok(a >= 0, 'missing ' + start);
    const b = SRC.indexOf(end, a);
    assert.ok(b > a, 'missing end ' + end);
    return SRC.slice(a, b);
}

const CODE = [
    grab('function seNormalizeKwargs', 'function seRestoreTab'),
    'function seInitSnap(t){t._ovSnap=JSON.parse(JSON.stringify(t.overrides||{}));return t;}',
    grab('function seAddProfileTab', 'function seOpenProfileTab'),
    grab('function seTabChangeCount', 'function seTabHasChanges'),
    'let seTabs=[]; let seActiveTab="base"; let seBaseVals={};',
    'function seTab(){return seTabs.find(t=>t.id===seActiveTab)||seTabs[0];}',
].join('\n');

const sandbox = {
    JSON, Math, Date, String, Object, Array,
    window: { UpliftModelSpec: {
        // deterministic stand-in: raw keys become type/value entries
        mergeRawKwargs: (raw, forced, entries) =>
            Object.entries(raw || {}).map(([k, v]) => ({ type: k, value: String(v) }))
            .concat((entries || []).filter(e => !(e.type in (raw || {})))),
    } },
    exports: {},
};
vm.createContext(sandbox);
vm.runInContext(CODE + '\nexports.fns = { seAddProfileTab, seTabChangeCount, seNormalizeKwargs }'
    + ' + 0 ? undefined : undefined; exports.api = () => ({ seAddProfileTab, seTabChangeCount, seNormalizeKwargs });',
    sandbox);
const api = vm.runInContext('exports.api()', sandbox);

function setBaseVals(v) { vm.runInContext('seBaseVals = ' + JSON.stringify(v), sandbox); }
function tabsLen() { return vm.runInContext('seTabs.length', sandbox); }
function reset() { vm.runInContext('seTabs=[]; seActiveTab="base";', sandbox); }

test('ALIAS-DIRTY: tab seeded from a profile with raw kwargs starts clean', () => {
    reset();
    setBaseVals({ enable_thinking: undefined,
        ctKwargEntries: [{ type: 'enable_thinking', value: 'false' }] });
    const t = api.seAddProfileTab({ name: 'p1', display_name: 'P ONE',
        settings: { chat_template_kwargs: { enable_thinking: true },
                    forced_ct_kwargs: [] } });
    assert.strictEqual(api.seTabChangeCount(t), 0, 'fresh tab must count 0');
    assert.ok(!('chat_template_kwargs' in t.workVals), 'seed must normalize workVals');
    assert.ok(!('chat_template_kwargs' in t.origVals), 'seed must normalize origVals');
    assert.ok(Array.isArray(t.origVals.ctKwargEntries), 'origVals carry entries shape');
});
test('ALIAS-DIRTY: visiting the tab (capture after normalize) counts NO change', () => {
    // the old bug: first render re-derived workVals entries while origVals
    // stayed raw-shaped -> +1 per visited profile -> SAVE ALL (n) grew on
    // clicks and committed unedited profiles.
    reset();
    setBaseVals({ ctKwargEntries: [{ type: 'enable_thinking', value: 'false' }] });
    const t = api.seAddProfileTab({ name: 'p2', display_name: 'P TWO',
        settings: { chat_template_kwargs: { enable_thinking: true } } });
    const seValues = Object.assign({}, t.workVals);
    api.seNormalizeKwargs(seValues);                  // render step
    t.workVals = seValues;                            // capture step
    assert.strictEqual(api.seTabChangeCount(t), 0, 'visited tab must stay clean');
});
test('ALIAS-DIRTY: a real kwargs edit on the tab still counts', () => {
    reset();
    setBaseVals({ ctKwargEntries: [] });
    const t = api.seAddProfileTab({ name: 'p3', display_name: 'P THREE',
        settings: { chat_template_kwargs: { enable_thinking: true } } });
    const seValues = Object.assign({}, t.workVals);
    seValues.ctKwargEntries = [{ type: 'enable_thinking', value: 'false' }];
    t.workVals = seValues;
    assert.strictEqual(api.seTabChangeCount(t), 1, 'genuine kwargs edit must count 1');
});
test('ALIAS-DIRTY: save never overwrites the display label with the name', () => {
    const post = grab('MM_GLUE.toast(C.t(\'uplift.toast.saved_profile\'',
                      'const mirror = (MM_DATA.profiles');
    assert.match(post, /if \(!t\.display_name\) t\.display_name = name;/);
    assert.ok(!/t\.name = name; t\.display_name = name;/.test(post),
        'label clobber must stay gone');
});
