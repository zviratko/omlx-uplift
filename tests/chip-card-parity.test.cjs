/* Chip-parity fix (user 2026-10-08): the header temperature/watts chips
   must show the SAME number as the graph card header — the last non-null
   sample of the card's primary key — not a 60 s mean/max aggregate.
   chipReadout is sliced out of uplift_charts.js and executed (same
   pattern as the U42 ifPaint test; the statics are browser IIFEs).
   Points arrive newest-LAST (store series() ORDER BY ts contract). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
const start = src.indexOf('function chipReadout(');
const end = src.indexOf('async function refreshPowerChips(', start);
assert.ok(start > 0 && end > start, 'chipReadout slice found');
const chipReadout = new Function(src.slice(start, end) + '\nreturn chipReadout;')();

const pts = (...vs) => vs.map((v, i) => ({ ts: 100 + i, v }));

test('chip value = last non-null of the PRIMARY key (card header rule)', () => {
    const maps = { 'pwr.total_w': pts(40, 42, 44) };
    assert.equal(chipReadout(maps, 'pwr.total_w', null).primary, 44);
});

test('chip is NOT an average of the window (the old U20 behaviour)', () => {
    const maps = { 'therm.cpu_temp_c': pts(50, 60, 70) };
    const r = chipReadout(maps, 'therm.cpu_temp_c', ['therm.cpu_temp_c']);
    assert.equal(r.primary, 70, 'displayed = newest sample');
    assert.equal(r.mean60, 60, 'the old 60 s mean still exists for the tooltip');
    assert.equal(r.max60, 70);
});

test('trailing nulls fall back to the last REAL value (legend lastNonNull parity)', () => {
    const maps = { 'pwr.total_w': pts(11, 12, null, null) };
    assert.equal(chipReadout(maps, 'pwr.total_w', null).primary, 12);
});

test('temperature: display follows the card primary (CPU) even when GPU runs hotter', () => {
    // honest split: the chip copies the card header; the 60 s MAX over
    // both sensors — the U20 safety statistic — lives in the tooltip.
    const maps = {
        'therm.cpu_temp_c': pts(55, 56),
        'therm.gpu_temp_c': pts(80, 84),
    };
    const r = chipReadout(maps, 'therm.cpu_temp_c',
        ['therm.cpu_temp_c', 'therm.gpu_temp_c']);
    assert.equal(r.primary, 56, 'chip = CPU newest, like the card header');
    assert.equal(r.max60, 84, 'tooltip max spans both sensors');
});

test('no fresh primary sample -> null (chip hides; U24 silent absence)', () => {
    assert.equal(chipReadout({}, 'pwr.total_w', null), null);
    assert.equal(chipReadout({ 'pwr.total_w': [] }, 'pwr.total_w', null), null);
    assert.equal(chipReadout({ 'pwr.total_w': pts(null) }, 'pwr.total_w', null), null);
    // a hot sibling must NOT keep the chip alive on its own — the value
    // would not match the card header anyway
    assert.equal(chipReadout({ 'therm.gpu_temp_c': pts(70) },
        'therm.cpu_temp_c', ['therm.cpu_temp_c', 'therm.gpu_temp_c']), null);
});

test('refresh cadence: chip fetch window >= card window it mirrors', () => {
    // The card header reads its primary column over the CARD window; the
    // chip's freshness bound must at least cover the stored 5 m fetch it
    // makes, or it would hide while the card still shows the value.
    assert.ok(/refreshPowerChips[\s\S]*?window=5m/.test(src),
        'chip fetches the 5 m stored window');
    assert.ok(/now - p\.ts \* 1000 < 5 \* 60_000 \+ 15_000/.test(src),
        'freshness bound = the 5 m fetch window + tick slack');
});
