/* EXTPERSIST (owner 2026-11-22): the External API bench trio (Base URL,
   API key, Model) must survive reloads. Persistence lives in localStorage,
   which the node mount stubs carry only as a no-op - the panel renders the
   same with or without the feature - so a source-shape pin is the only
   proof available (house pattern, see uplift-static-ui-gate). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tp = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static',
    'uplift_bench_tp.js'), 'utf8');

test('external API fields persist to the browser pref and refill', () => {
    assert.match(tp, /var EXT_LS = 'uplift\.bench\.extapi\.v1';/);
    assert.match(tp, /JSON\.parse\(localStorage\.getItem\(EXT_LS\)\)/);
    for (const [f, id] of [['url', 'eurl'], ['key', 'ekey'], ['model', 'emod']])
        assert.match(tp, new RegExp(
            "if \\(typeof ep\\." + f + " === 'string'\\) " + id +
            "\\.value = ep\\." + f + ";"));
    assert.match(tp, /localStorage\.setItem\(EXT_LS, JSON\.stringify\(\s*\{ url: eurl\.value, key: ekey\.value, model: emod\.value \}\)\)/);
    assert.match(tp, /\[eurl, ekey, emod\]\.forEach\(function \(i\) \{\s*i\.addEventListener\('change', extPrefSave\);/);
    // storage failures stay 'no pref', never a throw out of the panel build
    assert.ok((tp.match(/catch \(_\) \{ \/\* (blocked or absent storage|a denied storage)/g) || []).length === 2,
        'load and save each guarded');
    // the key field rests masked
    assert.match(tp, /ekey\.type = 'password'/);
});
