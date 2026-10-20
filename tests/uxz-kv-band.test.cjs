/* UX-Z (user 2026-10-20): the KV-compression band fold. An Affine4/Affine8
   format IS its bit depth — the Bits row must DISAPPEAR under affine (classic
   x-show parity: 'Affine8 turns into two settings' was the defect). The band
   builder lives inside the giant browser form renderer, so it is sliced
   VERBATIM and run against a fake DOM (the new Function below concatenates
   ONLY the repository's own checked-in source — no untrusted input; each
   test file is its own process, u85/nat6 pattern).
   Pinned contracts:
   - affine scheme -> bits ROW .hidden = true, bits value pinned 4/8 through
     the normal change path, control disabled while hidden by the pin;
   - switching back to turboquant unfolds the ladder;
   - an already-affine stored state renders folded (initial sync);
   - uplift.css carries the .se-row[hidden] display:none guard — .se-row
     sets display:grid, which would otherwise BEAT the UA [hidden] rule and
     render the folded row anyway;
   - the editor pair alternates a background shade PER TILE (skin-safe
     color-mix), declared exactly once (css2 selector-duplication rule). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

function region(a, b, label) {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, 'UX-Z slice region must exist: ' + label);
    return src.slice(i, j);
}
const BLOCK = region(
    'if (seValues.turboquant_kv_enabled !== undefined) {',
    '/* ---- advanced (classic ms-advanced)', 'KV compression band');

/* ---- fake DOM ---------------------------------------------------------- */
function fakeEl(tag) {
    const el = {
        tag, children: [], _lis: {}, hidden: false, disabled: false, value: '',
        classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
        append(...kids) { kids.forEach(k => el.children.push(k)); },
        addEventListener(t, fn) { (el._lis[t] = el._lis[t] || []).push(fn); },
        querySelector() { return el._ctl; },
        dispatchEvent(ev) { el._fire(ev); },
        _fire(ev) {
            // change bubbles: control handlers, then the band's handlers
            (el._lis[ev.type] || []).forEach(fn => fn(ev));
            if (el._band) el._band._fire(ev);
        },
    };
    return el;
}
const Ev = function (type) { return { type }; };

function run(seValues) {
    const fields = {};                 // key -> { row, ctl }
    const fam = fakeEl('div');
    const seBind = (kind, key, opts) => {
        const row = fakeEl('label');
        const ctl = fakeEl(kind === 'bool' ? 'input' : 'select');
        row._ctl = ctl;
        ctl.value = String(seValues[key] ?? '');
        // mimic the REAL seBind change handler: numeric strings -> numbers
        ctl.addEventListener('change', () => {
            const nv = Number(ctl.value);
            seValues[key] = ctl.value !== '' && Number.isFinite(nv) ? nv : ctl.value;
        });
        fields[key] = { row, ctl };
        return row;
    };
    const seFam = (g, master, mrow, kids) => {
        kids.forEach(k => { if (k._ctl) k._ctl._band = fam; });
        return fam;
    };
    const body = new Function('seValues', 'seBind', 'seFam', 'C', 'g', 'document',
        'seRefreshGates', 'Event', BLOCK + '\nreturn;');
    body(seValues, seBind, seFam, { tf: (k, f) => f }, fakeEl('div'),
        { getElementById: () => null }, () => {}, Ev);
    return fields;
}
const setScheme = (f, v) => {
    f.turboquant_kv_scheme.ctl.value = v;
    f.turboquant_kv_scheme.ctl.dispatchEvent({ type: 'change' });
};

test('UX-Z: affine8 folds the bits row and pins bits through the change path', () => {
    const f = run({ turboquant_kv_enabled: true, turboquant_kv_scheme: 'affine8',
        turboquant_kv_bits: 2 });
    assert.equal(f.turboquant_kv_bits.row.hidden, true, 'bits row folded under affine8');
    assert.equal(f.turboquant_kv_bits.ctl.value, '8', 'select repainted to 8');
    assert.equal(f.turboquant_kv_scheme.ctl.value, 'affine8', 'scheme write path intact');
    assert.equal(f.turboquant_kv_bits.ctl.disabled, true, 'folded control stays disabled');
});

test('UX-Z: affine4 pins 4; switching back to turboquant unfolds', () => {
    const vals = { turboquant_kv_enabled: true, turboquant_kv_scheme: 'turboquant',
        turboquant_kv_bits: 3.5 };
    const f = run(vals);
    assert.equal(f.turboquant_kv_bits.row.hidden, false, 'turboquant shows the ladder');
    assert.equal(f.turboquant_kv_bits.ctl.disabled, false);
    setScheme(f, 'affine4');
    assert.equal(f.turboquant_kv_scheme.ctl.value, 'affine4', 'scheme persisted');
    assert.equal(f.turboquant_kv_bits.row.hidden, true, 'affine4 folds the ladder');
    assert.equal(f.turboquant_kv_bits.ctl.value, '4');
    setScheme(f, 'turboquant');
    assert.equal(f.turboquant_kv_bits.row.hidden, false, 'turboquant re-renders the ladder');
    assert.equal(f.turboquant_kv_bits.ctl.disabled, false);
});

test('UX-Z: master off greys (not folds) a turboquant state; stored affine renders folded', () => {
    const f1 = run({ turboquant_kv_enabled: false, turboquant_kv_scheme: 'turboquant',
        turboquant_kv_bits: 4 });
    assert.equal(f1.turboquant_kv_bits.row.hidden, false, 'ladder visible under the greyed gate');
    assert.equal(f1.turboquant_kv_bits.ctl.disabled, true, 'but disabled with the master off');
    const f2 = run({ turboquant_kv_enabled: false, turboquant_kv_scheme: 'affine4',
        turboquant_kv_bits: 4 });
    assert.equal(f2.turboquant_kv_bits.row.hidden, true, 'already-affine renders folded');
});

test('UX-Z: the [hidden] guard beats .se-row display:grid (CSS pin)', () => {
    const m = css.match(/^\.se-row\[hidden\]\s*\{[^}]*\}/m);
    assert.ok(m, 'uplift.css must carry a standalone .se-row[hidden] rule');
    assert.match(m[0], /display:\s*none/, 'the guard must be display:none');
});

test('UX-Z: per-tile alternating shade exists exactly once in the editor pair', () => {
    const hits = css.match(/\.modal\.editor \.pair > \.se-row:nth-of-type\(odd\)/g) || [];
    assert.equal(hits.length, 1, 'the stripe rule must not be duplicated');
    assert.match(css, /\.modal\.editor \.pair > \.se-row:nth-of-type\(odd\)[^}]*color-mix\(in srgb, var\(--ink\)/s,
        'tiles alternate via a skin-safe ink mix');
});
