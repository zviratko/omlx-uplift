/* UP-19 gate: global-settings save safety (gspec pure core) + gsys source
   pins. node --test tests/u19-gsys-save-safety.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../omlx_uplift/static/uplift_gspec.js');

/* ---- isLoopbackBindHost: verbatim classic semantics (dashboard.js) ---- */
test('UP-19: loopback verdict mirrors classic exactly', () => {
    const lb = G.isLoopbackBindHost;
    assert.ok(lb('127.0.0.1'));
    assert.ok(lb('localhost'));
    assert.ok(lb('Localhost.'), 'case + trailing dot tolerated');
    assert.ok(lb('127.1.2.3'), 'whole 127/8');
    assert.ok(lb('::1'));
    assert.ok(lb('127.0.0.1,localhost'), 'multi-host all-loopback');
    assert.ok(!lb('127.0.0.1,0.0.0.0'), 'one public host taints the list');
    assert.ok(!lb('0.0.0.0'));
    assert.ok(!lb('10.20.31.250'));
    assert.ok(!lb(''), 'empty is NOT loopback (classic refuses)');
    assert.ok(!lb('[::1]'), 'bracketed form rejected exactly like classic');
});

test('UP-19: required-fields block matches the classic list', () => {
    const vals = { host: '127.0.0.1', port: 8080, max_audio_upload_size: 50,
        model_dirs: ['/models'], max_concurrent_requests: 4,
        embedding_batch_size: 8, ssd_cache_max_size: '64GB',
        sampling_max_context_window: 4096, sampling_max_tokens: 512,
        gdn_snapshot_storage: 'embedded', hot_cache_only: false };
    const get = f => vals[f];
    const label = f => f;
    assert.strictEqual(G.requiredFieldsError(get, label), null);
    const v2 = Object.assign({}, vals, { port: null, host: '' });
    const r = G.requiredFieldsError(f => v2[f], label);
    assert.ok(r && /host/.test(r.joined) && /port/.test(r.joined));
    const v3 = Object.assign({}, vals, { model_dirs: ['  '] });
    assert.ok(/model_dirs/.test(G.requiredFieldsError(f => v3[f], label).joined));
    const v4 = Object.assign({}, vals,
        { gdn_snapshot_storage: 'ssd_sidecar', hot_cache_only: true });
    assert.ok(/gdn_hot_conflict/.test(G.requiredFieldsError(f => v4[f], label).joined));
});

/* ---- gsys wiring pins ---- */
const gsys = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_gsys.js'), 'utf8');

test('UP-19(5): single-flight save + button disable', () => {
    assert.match(gsys, /let gsSaving = false;/);
    assert.match(gsys, /async function gsCommit\(\) \{\n    if \(gsSaving\) return;/);
    assert.match(gsys, /gsSaving = true;\n    const sb = gsSaveBtn\(\); if \(sb\) sb\.disabled = true;/);
});

test('UP-19(2): validation runs BEFORE any POST and can veto', () => {
    const i = gsys.indexOf('async function gsCommit');
    const body = gsys.slice(i, gsys.indexOf('gsSaving = true', i));
    assert.ok(body.includes('requiredFieldsError'));
    assert.ok(body.includes('isLoopbackBindHost'));
    assert.ok(body.includes('api_key_min_length'));
    assert.ok(body.includes('skip_api_key_verification = false'));
    const veto = body.indexOf('if (errs.length)');
    assert.ok(veto > body.indexOf('requiredFieldsError'), 'veto after checks');
});

test('UP-19(1): HTTP-failure toast surfaces the server detail', () => {
    const i = gsys.indexOf('async function gsSaveNow');
    const seg = gsys.slice(i, i + 1400);
    assert.match(seg, /GLUE\.toast\(D\.errText\(e\)\n?\s*\|\| C\.t\('uplift\.toast\.save_failed_http'/);
});

test('UP-19(4): restart confirms, watches health down-then-up, persists pending', () => {
    const i = gsys.indexOf('async function gsRestartServer');
    const seg = gsys.slice(i, gsys.indexOf('function gsSaveOrRestart'));
    assert.match(seg, /window\.confirm\(C\.tf\('settings\.server\.restart_confirm'/);
    assert.match(seg, /gsRestartWatch\(\);/);
    const w = gsys.slice(gsys.indexOf('function gsRestartWatch'));
    assert.match(w, /\/health/);
    assert.match(w, /sawDownAt/);
    assert.match(w, /60000/);
    assert.match(gsys, /sessionStorage\.setItem\('uplift\.gs\.restartPending'/);
    assert.match(gsys, /sessionStorage\.getItem\('uplift\.gs\.restartPending'\)/);
});

test('UP-19(3): k:num rows build real number inputs', () => {
    assert.match(gsys, /extra\.bool \? 'bool' : extra\.number \? 'number' : 'text'/);
});

test('UP-19(7): skip-auth row locks off-loopback; (9) dirs queue; (9) live selects', () => {
    assert.match(gsys, /\|\| flat === 'host'\)/);           // dirty trigger re-syncs
    assert.match(gsys, /const loop = window\.UpliftGSpec\.isLoopbackBindHost/);
    assert.ok(!gsys.includes('gsSaveNow({ model_dirs'), 'model dirs no longer POST on blur');
    assert.match(gsys, /gsQueueSave\('model_dirs', nd\);/);
    assert.match(gsys, /flat === 'ui_language' \|\| flat === 'idle_timeout_seconds'\) gsCommit\(\);/);
    assert.match(gsys, /input\[type=password\]/);           // UP-19(6) eye toggle
});
