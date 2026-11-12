/* SYNC-1 run 23 mirrors.
   (1) upstream b85f8db (#5085) + 75e5f58: server.gpu_keep_warm_idle_window,
       a live-applied select on classic's Advanced settings (presets Off,
       5 min default, 15/30 min, 1/2 h, plus a 'Custom (N s)' option for a
       settings.json value outside them).
   (2) upstream fa7b454 (#5189): local accuracy runs send a top-level
       max_tokens_override floor; the result card, TXT export and JSON export
       carry the limit the run used.
   Both surfaces are hand-built DOM no vm harness mounts (same class as the
   run-22 cprio pins), so row shape, payload lines and the locale batch are
   pinned from the source here. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const STATIC = p => fs.readFileSync(path.join(ROOT, 'omlx_uplift', 'static', p), 'utf8');
const LOCS = ['cs', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-TW', 'zh'];
const GSPEC = require(path.join(ROOT, 'omlx_uplift', 'static', 'uplift_gspec.js'));

test('s23: GS_MAP carries gpu_keep_warm_idle_window on the server section', () => {
    assert.deepStrictEqual(GSPEC.GS_MAP.gpu_keep_warm_idle_window,
        ['server', 'gpu_keep_warm_idle_window']);
});

test('s23 shape: idle-window row is a select, hidden when the GET lacks the field', () => {
    const src = STATIC('uplift_gsys.js');
    assert.match(src,
        /lab: 'adv\.keep_warm_window', hint: 'adv\.keep_warm_window_hint', ctl: \{\s*\n\s*k: 'sel', sec: 'server', field: 'gpu_keep_warm_idle_window',\s*\n\s*flat: 'gpu_keep_warm_idle_window', opts: gsKeepWarmWindowOpts\},\s*\n\s*show: \(\) => gsGet\('server', 'gpu_keep_warm_idle_window'\) != null\}/);
    // classic preset order and values (seconds)
    assert.match(src, /keep_warm_window_opts: \[\['0','Off'\],\['300','5 minutes \(default\)'\],\['900','15 minutes'\],\s*\n\s*\['1800','30 minutes'\],\['3600','1 hour'\],\['7200','2 hours'\]\]/);
    // a stored value outside the presets gets its own option (classic x-if)
    assert.match(src, /function gsKeepWarmWindowOpts\(L\) \{[\s\S]*?opts\.push\(\[String\(cur\), String\(L\.adv\.keep_warm_window_custom\)\.replace\('\{seconds\}', cur\)\]\)/);
    // row sits after the keep-warm interval row (both after mid-system cache)
    const iMid = src.indexOf("field: 'preserve_mid_system_cache', flat:");
    const iInt = src.indexOf("flat: 'gpu_keep_warm_interval', min: 0");
    const iWin = src.indexOf("lab: 'adv.keep_warm_window'");
    assert.ok(iMid >= 0 && iMid < iInt && iInt < iWin, 'row order');
});

test('s23 labels: EN literals match classic verbatim, old 5-minute claim gone', () => {
    const src = STATIC('uplift_gsys.js');
    assert.match(src, /keep_warm_window: 'Keep GPU Awake After Requests'/);
    assert.match(src, /keep_warm_window_custom: 'Custom \(\{seconds\} s\)'/);
    assert.ok(!/Ticks stop after 5 minutes without requests/.test(src),
        'the interval hint must not promise a fixed 5 minutes any more');
});

test('s23 locales: idle-window keys x10, interval hint updated x10', () => {
    const KEYS = ['uplift.gs.adv.keep_warm_window', 'uplift.gs.adv.keep_warm_window_hint',
        'uplift.gs.adv.keep_warm_window_custom',
        ...['0', '300', '900', '1800', '3600', '7200'].map(v => 'uplift.gs.adv.keep_warm_window_opts.' + v)];
    for (const loc of LOCS) {
        const d = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'omlx_uplift', 'locales', `${loc}.json`), 'utf8'));
        for (const k of KEYS) {
            assert.ok(typeof d[k] === 'string' && d[k].length > 0, `${loc}: ${k} missing`);
        }
        assert.ok(d['uplift.gs.adv.keep_warm_window_custom'].includes('{seconds}'),
            `${loc}: custom label keeps its placeholder`);
        assert.ok(d['uplift.gs.adv.keep_warm_hint'].includes(d['uplift.gs.adv.keep_warm_window']),
            `${loc}: interval hint names the idle-window row`);
    }
});

test('s23 bench: local max-tokens row, top-level payload, classic validation', () => {
    const src = STATIC('uplift_bench.js');
    assert.match(src, /lmax\.id = 'bench-acc-max'; lmax\.type = 'number';/);
    assert.match(src, /lmaxRow\.hidden = accExtLb\.input\.checked;/,
        'the local floor hides while the external endpoint is on (classic x-show)');
    assert.match(src, /lmaxRow,\s*\n\s*accExtLb,\s*\n\s*extRow,/, 'classic order: before external');
    assert.match(src, /\} else \{[\s\S]{0,600}?Number\.isInteger\(lv\) \|\| lv < 1 \|\| lv > 1000000[\s\S]{0,300}?body\.max_tokens_override = lv;/);
    // the LM-Eval twin bodies are cloned BEFORE the local floor is set
    assert.ok(src.indexOf('body._extras = Object.keys(xBody)') < src.indexOf('body.max_tokens_override = lv'));
});

test('s23 bench: result badge + JSON export carry the saved limit', () => {
    const src = STATIC('uplift_bench.js');
    assert.match(src, /if \(!r\.external && r\.max_tokens\) badges \+= ' \[' \+ t\('acc_bench\.results\.token_limit', 'Token limit'\)/);
    assert.match(src, /thinking_used: r\.thinking_used \|\| false,\s*\n\s*max_tokens: r\.max_tokens,/);
});
