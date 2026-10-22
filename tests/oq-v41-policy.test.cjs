/* SYNC-1 follow-up 2026-10-22: DeepSeek V4.1 oQ policy parity.

The SERVER hard-rejects non-calibrated levels for V4.1
(_validate_v41_oq_settings: only oQ2/2.5/2.7/3/4, dtype must be
bfloat16/group_size 64) and classic mirrors that in the form
(oqAvailableLevels/oqApplyModelPolicy). The uplift port must show the
same truth — a selectable level the engine cannot run reads as a bug.
Source-shape pins: the panel's payload/DOM code has no vm harness. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_modelsops.js'),
    'utf8');

test('V4.1 level list matches the server policy', () => {
    assert.match(src, /const V41_LEVELS = \[2, 2\.5, 2\.7, 3, 4\];/);
    assert.match(src,
        /const oqLevelsFor = t => \(t === 'deepseek_v41' \? V41_LEVELS : OQ_LEVELS\);/);
});

test('level options are rebuilt per model type', () => {
    assert.match(src, /const levels = oqLevelsFor\(m && m\.model_type\);/,
        'updateConditional must derive the list from the selected model');
    assert.match(src, /for \(const o of \[\.\.\.selLevel\.options\]\) o\.remove\(\);/,
        'the select must actually drop the unsupported options');
});

test('a dropped selection snaps to oQ4 without blanking the select', () => {
    // assigning a value matching no option blanks a real browser select
    assert.match(src,
        /selLevel\.value = levels\.map\(String\)\.includes\(keep\) \? keep : '4';/,
        'unsupported keep must snap to 4 via an includes-check, never raw');
});

test('V4.1 forces bfloat16 output', () => {
    assert.match(src,
        /dtype\.v = 'bfloat16';\s*for \(const x of dtypes\.children\)/,
        'policy must pin the dtype like classic oqApplyModelPolicy');
});

test('V4.1 clears text-only and the oQ4 sensitivity pick', () => {
    assert.match(src,
        /cbText\.checked = false;\s*if \(selLevel\.value === '4'\) selSens\.value = '';/);
});

test('level change re-applies the oQ4 sensitivity rule', () => {
    assert.match(src,
        /if \(m && m\.model_type === 'deepseek_v41' && selLevel\.value === '4'\)\s*selSens\.value = '';/);
});

/* Live-browser catch 2026-10-22: the fold rows set el.hidden but
   .qz-form .field { display:flex } and .qz-enh-only { display:grid }
   override the UA [hidden] rule, so sensitivity/combine/Engram/oQe
   blocks rendered even when folded (the same trap the CSS already
   documents for .se-row and .dd-menu). Guards must stay. */
const css = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift.css'),
    'utf8');

test('quantizer fold rows have [hidden] guards', () => {
    assert.match(css, /\.qz-form \.field\[hidden\]\s*\{\s*display:\s*none;/);
    assert.match(css, /\.qz-enh-only\[hidden\]\s*\{\s*display:\s*none;/);
});
