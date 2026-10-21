/* MTP-HEAD (user 2026-10-21): "MTP can be enabled on models that have no
   MTP heads (the dashboard even says so)". The editor rendered an honest
   incompatibility HINT under a fully clickable toggle. Classic's modal
   disables it instead: :disabled = (!mtp_compatible && !mtp_enabled).
   Pinned here (the band is sliced VERBATIM from the checked-in editor
   source — new Function concatenates ONLY repository source, no external
   input; uxz-kv-band pattern):
   - no head + currently OFF -> toggle DISABLED, the server's reason rides
     the row title AND the input title (a disabled input swallows hovers);
   - head present -> enabled, the built-in-head hint shows;
   - no head but a STORED enable -> still togglable (the escape hatch to
     turn it OFF — classic parity, never a trap);
   - synthetic rows (_template / _missing carry no server verdict) ->
     control untouched;
   - modelspec.validate mirror: mtp_enabled PUT with an explicit
     mtp_compatible=false verdict errors; a compatible model or a
     verdict-less/template row never does. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const { STATIC_DIR } = require('./static-src.cjs');
const S = require(path.join(STATIC_DIR, 'modelspec.js'));

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');

function region(a, b, label) {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, 'slice region must exist: ' + label);
    return src.slice(i, j);
}
const BLOCK = region('if (seValues.mtp_enabled !== undefined) {',
    'const drafterType', 'MTP band');

function fakeEl(tag) {
    const el = {
        tag, children: [], dataset: {}, hidden: false, disabled: false,
        value: '', title: '', textContent: '',
        classList: { toggle() {}, add() {}, remove() {} },
        append(...kids) { kids.forEach(k => el.children.push(k)); },
        querySelector() { return el._ctl || null; },
        addEventListener() {},
    };
    return el;
}

function run(seValues, m) {
    const fields = {};
    const seBind = (kind, key, opts) => {
        const row = fakeEl('label');
        const ctl = fakeEl(kind === 'bool' ? 'input' : 'select');
        ctl.checked = seValues[key] === true;
        // mirror the REAL seBind: opts.disabled lands on the control
        if (opts && opts.disabled) ctl.disabled = true;
        row._ctl = ctl;
        row.hint = opts && opts.hint;
        row.label = opts && opts.label;
        fields[key] = { row, ctl };
        return row;
    };
    const fam = fakeEl('div');
    const seFam = () => fam;
    // SAFETY: BLOCK is a VERBATIM slice of this repository's own checked-in
    // uplift_mmeditor.js (no external input is concatenated into the body)
    // — same sanctioned pattern as uxz-kv-band.test.cjs.
    const body = new Function('seValues', 'seBind', 'seFam', 'C', 'g', 'm',
        'seRefreshGates', 'document', BLOCK + '\nreturn;');
    body(seValues, seBind, seFam, { tf: (k, f) => f }, fakeEl('div'), m,
        () => {}, { getElementById: () => null });
    return fields;
}

const REASON = 'model has no MTP heads in config';

test('MTP-HEAD: no head + OFF locks the toggle and titles the reason', () => {
    const f = run({ mtp_enabled: false, mtp_adaptive_max_depth: 3 },
        { id: 'x', mtp_compatible: false, mtp_compatibility_reason: REASON });
    assert.equal(f.mtp_enabled.ctl.disabled, true, 'toggle DISABLED');
    assert.equal(f.mtp_enabled.row.title, REASON, 'row carries the reason');
    assert.equal(f.mtp_enabled.ctl.title, REASON, 'input carries the reason');
    assert.equal(f.mtp_enabled.row.hint, REASON, 'hint states the verdict');
});

test('MTP-HEAD: a model WITH a head stays clickable with the head hint', () => {
    const f = run({ mtp_enabled: false, mtp_adaptive_max_depth: 3 },
        { id: 'x', mtp_compatible: true });
    assert.equal(f.mtp_enabled.ctl.disabled, false);
    assert.equal(f.mtp_enabled.row.title, '');
    assert.match(f.mtp_enabled.row.hint, /built-in MTP head/);
});

test('MTP-HEAD: a stored enable stays togglable TO OFF (classic parity)', () => {
    const f = run({ mtp_enabled: true, mtp_adaptive_max_depth: 3 },
        { id: 'x', mtp_compatible: false, mtp_compatibility_reason: REASON });
    assert.equal(f.mtp_enabled.ctl.disabled, false,
        'an already-on row is never trapped on');
});

test('MTP-HEAD: synthetic rows carry no verdict — control untouched', () => {
    for (const m of [{ id: 't', _template: true }, { id: '?', _missing: true }]) {
        const f = run({ mtp_enabled: false, mtp_adaptive_max_depth: 3 }, m);
        assert.equal(f.mtp_enabled.ctl.disabled, false, JSON.stringify(m));
    }
});

/* ---- modelspec.validate mirror (the payload-side net) ---- */
const base = () => ({ id: 'm', model_type: 'llm', config_model_type: 'llama' });

test('validate mirror: mtp on an explicitly-incompatible model errors', () => {
    const st = S.buildState(base(), { mtp_enabled: true });
    const m = Object.assign(base(), { mtp_compatible: false,
        mtp_compatibility_reason: REASON });
    const errs = S.validate(st, m);
    assert.equal(errs.length, 1, JSON.stringify(errs));
    assert.equal(errs[0], REASON, 'the server reason is shown verbatim');
});

test('validate mirror: compatible model and verdict-less rows never error', () => {
    const st = S.buildState(base(), { mtp_enabled: true });
    assert.deepStrictEqual(S.validate(st, Object.assign(base(),
        { mtp_compatible: true })), []);
    assert.deepStrictEqual(S.validate(st, base()), []);   // old DTO, no flag
    assert.deepStrictEqual(S.validate(st, { id: 't', _template: true }), []);
    assert.deepStrictEqual(S.validate(st), []);           // single-arg call
});
