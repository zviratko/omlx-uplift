/* SYNC-1 run 27 (upstream a57ed31 #5317): oQh 'Rotated codes' parity in the
uplift quantizer form. The hand-built oQ form in uplift_modelsops.js has no
vm harness (the panel posts a literal body built from DOM controls), so a
source-shape pin is the only proof available: label text, the gating rule
from the model DTO, the fold/reset lines and the payload site must all be
asserted as shipped text. Classic reference: dashboard.js
oqSelectedModelSupportsOqh/oqHadamardActive + _models.html enhanced block. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_modelsops.js'),
    'utf8');

test('the DTO gate mirrors classic oqSelectedModelSupportsOqh', () => {
    assert.match(src,
        /function oqhSupported\(m, level\) \{\s*if \(!m \|\| !m\.oqh_supported\) return false;\s*return m\.oqh_max_level == null \|\| level < m\.oqh_max_level;/,
        'support = oqh_supported AND (no cap OR level < cap)');
});

test('the row carries classic EN label and help verbatim', () => {
    // classic en.json models.oq.hadamard_label / hadamard_help, copied in
    // the form's call-site style (this panel hardcodes English labels);
    // the help string is a multi-line concatenation, so pin the fragments
    assert.match(src, /qzCheck\(rowEnhOnly, 'Rotated codes \(oQh\)',/);
    for (const frag of ['Same size as oQe with lower error: weights are stored in a ',
        'Hadamard-rotated basis with one scale per row. Needs the oQh ',
        'kernels to run.'])
        assert.ok(src.includes(frag), `help fragment missing: ${frag}`);
    // the three fragments must be ONE concatenated literal, not loose prose
    assert.match(src,
        /'Same size as oQe with lower error: weights are stored in a ' \+\s*'Hadamard-rotated basis with one scale per row\. Needs the oQh ' \+\s*'kernels to run\.'/,
        'help text must equal classic EN verbatim');
});

test('the row sits FIRST in the enhanced block, above the imatrix rows', () => {
    const h = src.indexOf("qzCheck(rowEnhOnly, 'Rotated codes (oQh)'");
    const r = src.indexOf("'Reuse imatrix cache'");
    assert.ok(h > 0 && r > h, 'classic _models.html order: hadamard, then reuse');
});

test('gate runs on model change and on level change, after the level rebuild', () => {
    // updateConditional: gate AFTER the level list block (the pick may snap)
    const uc = src.slice(src.indexOf('function updateConditional() {'),
        src.indexOf('QG.fetchJson(`${API}/admin/api/oq/models`)'));
    const snap = uc.indexOf("selLevel.value = levels.map(String).includes(keep) ? keep : '4';");
    const gate = uc.indexOf('gateHadamard(m);');
    assert.ok(snap > 0 && gate > snap,
        'updateConditional must gate after the level list is rebuilt');
    // selLevel.onchange re-gates (oqh_max_level is level-dependent)
    assert.match(src,
        /if \(m && m\.model_type === 'deepseek_v41' && selLevel\.value === '4'\)\s*selSens\.value = '';\s*gateHadamard\(m\);/);
});

test('a closed gate un-checks the box (uplift reset idiom)', () => {
    assert.match(src,
        /if \(!ok\) cbHadamard\.checked = false;/);
});

test('hadamard rides the payload only in the enhanced branch, with the gate', () => {
    const pl = src.slice(src.indexOf('if (cbEnh.checked) {'),
        src.indexOf('QG.postJson(`${API}/admin/api/oq/start`'));
    assert.match(pl, /payload\.enhanced = true;/);
    assert.match(pl,
        /payload\.hadamard = cbHadamard\.checked &&\s*oqhSupported\(m, parseFloat\(selLevel\.value\)\);/,
        'the flag must be gated by the DTO rule, never sent naked');
    // exactly one hadamard payload site, inside the branch
    const sites = src.match(/payload\.hadamard/g) || [];
    assert.strictEqual(sites.length, 1);
});

test('estimate stays hadamard-free (classic oqRefreshEstimate sends no such param)', () => {
    assert.doesNotMatch(src, /estimate[^;]*hadamard/i);
});
