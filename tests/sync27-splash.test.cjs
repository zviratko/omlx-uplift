/* SYNC-1 run 27: classic's External engines / Splash card, ported into the
uplift integrations panel (uplift_helper.js). The panel builds DOM
imperatively inside one async render function and no vm harness mounts it,
so a source-shape pin is the only proof available: the DTO read, the
path-editor machine, the silent-save contract, the select orders and the
classic EN label texts must all be asserted as shipped text.
Classic reference: _settings.html integrations tab (External engines card),
dashboard.js splashPath/saveSplashSize/editSplashPath/applySplashPath. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_helper.js'),
    'utf8');

test('the splash DTO rides the same GS GET as the integrations', () => {
    assert.match(src,
        /eng = \(gs\.external_engines \|\| \{\}\)\.splash \|\| \{\};/,
        'availability must come from the server _splash_status payload, never guessed');
});

test('saveIntegration keeps its toasts by delegating to the err-returning core', () => {
    // the splash rows need the error STRING (classic returns it from
    // saveIntegrationSettings); the existing rows keep the toast contract
    assert.match(src,
        /async function saveIntegrationErr\(overrides\) \{[\s\S]*?return '';\s*\} catch \(err\) \{ return D\.errText\(err\); \}/);
    const wrap = src.slice(src.indexOf('async function saveIntegration(overrides)'),
        src.indexOf('function integField'));
    assert.match(wrap, /const err = await saveIntegrationErr\(overrides\);/);
    assert.match(wrap, /uplift\.toast\.save_failed/);
    assert.match(wrap, /uplift\.toast\.integration_saved/);
});

test('the path editor machine survives re-renders and mirrors classic', () => {
    assert.match(src,
        /let _splashUI = \{ editing: false, draft: '', error: '', saving: false \};/);
    // apply: trim, empty -> null (classic: (path || '').trim() || null),
    // rollback + inline error on reject, close the editor + re-fetch on success
    const ap = src.slice(src.indexOf('async function applySplashPath(path)'),
        src.indexOf('const exCard'));
    assert.match(ap, /\{ splash_path: \(path \|\| ''\)\.trim\(\) \|\| null \}/);
    assert.match(ap, /integ\.splash_path = previous;\s*_splashUI\.error = err;/);
    assert.match(ap, /_splashUI\.editing = false;/);
    assert.ok(ap.includes('renderHelperModels();'),
        'apply must re-paint from a fresh GET (classic loadGlobalSettings)');
});

test('detected state shows path, hint, version badge and Change', () => {
    assert.match(src, /if \(eng\.available && !_splashUI\.editing\) \{/);
    assert.match(src, /'Found automatically.' : 'Set by path.'/,
        'classic detected_hint/configured_hint pair');
    assert.match(src, /badge\.textContent = \(\(eng\.label \|\| 'Splash'\) \+ ' ' \+ \(eng\.version \|\| ''\)\)\.trim\(\);/);
    assert.match(src, /_splashUI\.draft = integ\.splash_path \|\| eng\.path \|\| '';/,
        'Change prefills saved path first, detected path second (classic editSplashPath)');
});

test('editor state: hint, reason, error line, Apply gate, Use-auto, Cancel', () => {
    assert.match(src, /inp\.placeholder = '\/opt\/homebrew\/bin\/splash';/);
    assert.match(src, /apply\.disabled = _splashUI\.saving \|\| !_splashUI\.draft\.trim\(\);/,
        'classic :disabled="splashPath.saving || !splashPath.draft.trim()"');
    assert.match(src, /if \(integ\.splash_path\) \{[\s\S]*?'Detect automatically'[\s\S]*?applySplashPath\(''\)/,
        'use-auto only when a path is stored (classic x-show)');
    assert.match(src, /if \(_splashUI\.editing\) \{[\s\S]*?_splashUI\.editing = false; _splashUI\.error = '';/,
        'Cancel only while editing (classic x-show)');
});

test('the two selects carry classic option order and defaults', () => {
    assert.match(src,
        /integSelect\(\[\['int8', 'int8'\], \['bf16', 'bf16'\]\],\s*integ\.splash_kv_format \|\| 'int8',/,
        'classic kv_format: int8 first, default int8');
    assert.match(src,
        /integSelect\(\[\['bf16', 'bf16'\], \['auto', 'auto'\]\],\s*integ\.splash_activations \|\| 'bf16',/,
        'classic activations (upstream c8213a1 #5337): bf16 first, default bf16');
    // splash saves are SILENT (classic shows no toast; errors go to the line)
    assert.match(src, /optErr\.textContent =\s*await saveIntegrationErr\(\{ splash_activations: v \}\);/);
});

test('GB numbers: empty=Auto, min rule, rollback, shared error line', () => {
    const sn = src.slice(src.indexOf('function splashNumber(key, minimum)'),
        src.indexOf("exGrid.append(integField('Memory limit'"));
    assert.match(sn, /inp\.value = integ\[key\] \?\? '';/);
    assert.match(sn, /inp\.placeholder = 'Auto';/);
    assert.match(sn, /const value = raw === '' \? null : Number\(raw\);/);
    assert.match(sn, /if \(value !== null && !\(value >= minimum\)\)/);
    assert.match(sn, /integ\[key\] = previous; inp\.value = previous \?\? '';/);
    assert.ok(src.includes("splashNumber('splash_max_memory_gb', 1)"),
        'classic min=1 for the memory limit');
    assert.ok(src.includes("splashNumber('splash_ssd_cache_gb', 0)"),
        'classic min=0 for the SSD cache (0 turns it off)');
});

test('classic EN texts are copied verbatim (fragments of the concatenations)', () => {
    for (const frag of [
        'Serve a model with another inference engine running in ',
        'int8 holds about twice the context of bf16 in the same memory.',
        'bf16 keeps attention in bf16 on M5 and later; auto lets Splash use ',
        'int8 where it is faster. Applies to Splash 1.6.1 and later.',
        'Enter a size in GB, or leave the field empty for automatic.',
        'stays after it unloads, so the total can grow to this size times the ',
        'Let Splash run part of long prompts on the Neural Engine when that ',
    ]) assert.ok(src.includes(frag), `missing classic EN fragment: ${frag}`);
    // the new field's label pair exists (settings.integrations.splash.activations)
    assert.ok(src.includes("'Activation precision'"));
});

test('ANE prefill checkbox mirrors the classic toggle semantics', () => {
    assert.match(src, /aneInp\.checked = !!integ\.splash_ane_prefill;/);
    assert.match(src,
        /await saveIntegrationErr\(\{ splash_ane_prefill: aneInp\.checked \}\);/);
});
