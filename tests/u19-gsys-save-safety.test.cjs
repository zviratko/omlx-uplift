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
    assert.ok(!lb('192.0.2.10'));
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
    // 2026-11-22: the silent disable became a visible SAVING state; the
    // UP-19(5) contract is unchanged - guard flag + button disabled while
    // the POST is in flight.
    assert.match(gsys, /gsSaving = true;\s*const sb = gsSaveBtn\(\);\s*if \(sb\) \{[\s\S]{0,300}?sb\.disabled = true;/);
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

test('SSD Write Buffer: a plain number saves as MB, never raw bytes', () => {
    const S = G.sizeInputWithUnit;
    assert.equal(S('512', 'MB'), '512MB');
    assert.equal(S(' 1.5 ', 'MB'), '1.5MB');
    assert.equal(S('512MB', 'MB'), '512MB', 'explicit unit passes through');
    assert.equal(S('2GB', 'MB'), '2GB', 'other units pass through');
    assert.equal(S('', 'MB'), '', 'empty passes through (pre-existing behavior)');
    assert.equal(S(null, 'MB'), '');
    assert.equal(S('abc', 'MB'), 'abc', 'junk passes to server validation');
    // wiring: the row declares the unit, gsText applies it before queueing
    assert.match(gsys, /flat: 'gdn_ssd_pending_max_size', ph: '512MB', sizeUnit: 'MB'/);
    assert.match(gsys, /sizeUnit: c\.sizeUnit,/);
    assert.match(gsys, /if \(extra\.sizeUnit\) \{\s*val = window\.UpliftGSpec\.sizeInputWithUnit\(val, extra\.sizeUnit\);/);
});

test('save feedback: SAVING state on the button while the POST runs', () => {
    assert.match(gsys, /sb\.classList\.add\('saving'\);/);
    assert.match(gsys, /sb\.textContent = 'SAVING…';/);
    assert.match(gsys, /sb\.disabled = false; sb\.classList\.remove\('saving'\);/);
    const css = fs.readFileSync(
        path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift.css'), 'utf8');
    assert.match(css, /\.savebtn\.saving \{ opacity: 0\.65; cursor: progress; \}/);
});

test('cache saves say they unload models (mirror of the engine trigger)', () => {
    const S = G.GS_MODEL_UNLOAD_FLATS;
    assert.ok(S.has('gdn_ssd_pending_max_size'), 'SSD Write Buffer warns');
    for (const f of ['cache_enabled', 'ssd_cache_dir', 'ssd_cache_max_size',
        'hot_cache_only', 'hot_cache_max_size', 'hot_cache_write_through',
        'gdn_snapshot_storage', 'gdn_ssd_split_enabled', 'gdn_sidecar_precision',
        'initial_cache_blocks'])
        assert.ok(S.has(f), f);
    assert.ok(!S.has('log_level'), 'non-cache fields stay quiet');
    // the note renders in the CHANGES box and the button tooltip reads it
    assert.match(gsys, /k => window\.UpliftGSpec\.GS_MODEL_UNLOAD_FLATS\.has\(k\)/);
    assert.match(gsys, /note\.className = 'gs-unload-note';/);
    assert.match(gsys, /note\.dataset\.i18n = 'uplift\.gs\.unloads_notice';/);
    const css = fs.readFileSync(
        path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift.css'), 'utf8');
    assert.match(css, /\.changelist \.gs-unload-note \{/);
    // key present in every locale, non-empty, translated (not the EN copy)
    const en = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'omlx_uplift', 'locales', 'en.json'), 'utf8'));
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'omlx_uplift', 'locales'))) {
        if (!f.endsWith('.json')) continue;
        const d = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'omlx_uplift', 'locales', f), 'utf8'));
        const v = d['uplift.gs.unloads_notice'];
        assert.ok(typeof v === 'string' && v.length > 10, f + ': missing key');
        if (f !== 'en.json') assert.notEqual(v, en['uplift.gs.unloads_notice'], f + ': untranslated');
    }
});
