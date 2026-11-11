/* SYNC-1 run 22 (upstream 09ad2e9 #5164): the concurrent_priority mirror.
   Classic replaced the decode_fairness on/off toggle with a 3-way select
   (Prefill First | Balanced | Decode First) and renamed the neighbouring
   prefill_priority row ('Long Prompt Handling', option 'Full Speed').
   The GS panel rows are hand-built spec-table DOM no vm harness mounts
   (same class as the fire-9/fire-21 source-shape pins), so the row shape,
   the option ORDER and the locale batch are pinned here. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const STATIC = p => fs.readFileSync(path.join(ROOT, 'omlx_uplift', 'static', p), 'utf8');
const LOCS = ['cs', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-TW', 'zh']
    .filter(l => l !== 'de'); // uplift ships 10 locales (German is a user call)

const GSPEC = require(path.join(ROOT, 'omlx_uplift', 'static', 'uplift_gspec.js'));

test('f22: GS_MAP carries concurrent_priority, decode_fairness is gone', () => {
    assert.deepStrictEqual(GSPEC.GS_MAP.concurrent_priority, ['scheduler', 'concurrent_priority']);
    assert.ok(!('decode_fairness' in GSPEC.GS_MAP),
        'classic dropped the old on/off form from its save payload; the server ' +
        'derives it from concurrent_priority (routes.py #5164 handler)');
});

test('f22 shape: the row is a sel on the scheduler section, classic option order', () => {
    const src = STATIC('uplift_gsys.js');
    assert.match(src,
        /lab: 'res\.cprio', hint: 'res\.cprio_desc', ctl: \{\s*\n\s*k: 'sel', sec: 'scheduler', field: 'concurrent_priority', flat: 'concurrent_priority',/,
        'the spec row binds the select to scheduler.concurrent_priority');
    // classic _settings.html order: prefill, balanced, decode
    assert.match(src,
        /opts: \(\) => \[\['prefill', GS_LABELS\.res\.cprio_prefill\],\s*\n\s*\['balanced', GS_LABELS\.res\.cprio_balanced\],\s*\n\s*\['decode', GS_LABELS\.res\.cprio_decode\]\]/,
        'option order mirrors classic <select> (prefill|balanced|decode)');
    // classic row order: chunked -> concurrent -> prefill_priority
    const iChunk = src.indexOf("flat: 'chunked_prefill'");
    const iCprio = src.indexOf("flat: 'concurrent_priority'");
    const iPrio = src.indexOf("field: 'prefill_priority'");
    assert.ok(iChunk >= 0 && iChunk < iCprio && iCprio < iPrio,
        'row order follows classic: chunked, concurrent, prefill priority');
    assert.ok(!/field: 'decode_fairness'/.test(src),
        'no live control may keep sending the retired key');
});

test('f22 shape: GS_LABELS literals match classic EN values verbatim', () => {
    const src = STATIC('uplift_gsys.js');
    assert.match(src, /cprio: 'Concurrent Request Priority'/);
    assert.match(src, /cprio_desc: 'What runs first when a new prompt arrives while other responses are generating\. Prefill First can pause them during a long prompt\.'/);
    assert.match(src, /cprio_prefill: 'Prefill First', cprio_balanced: 'Balanced', cprio_decode: 'Decode First'/);
    assert.match(src, /prio: 'Long Prompt Handling', prio_speed: 'Full Speed'/);
});

test('f22 locales: cprio keys x10, fairness keys retired, prio renamed', () => {
    const KEYS = ['uplift.gs.res.cprio', 'uplift.gs.res.cprio_desc',
                  'uplift.gs.res.cprio_prefill', 'uplift.gs.res.cprio_balanced',
                  'uplift.gs.res.cprio_decode'];
    for (const loc of LOCS) {
        const d = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'omlx_uplift', 'locales', `${loc}.json`), 'utf8'));
        for (const k of KEYS) {
            assert.ok(typeof d[k] === 'string' && d[k].length > 0, `${loc}: ${k} missing`);
        }
        assert.ok(!('uplift.gs.res.fairness' in d) && !('uplift.gs.res.fairness_desc' in d),
            `${loc}: retired fairness keys must not linger`);
        assert.notStrictEqual(d['uplift.gs.res.prio'], 'Prefill Priority',
            `${loc}: prio label must move off the retired classic wording`);
    }
    const en = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'omlx_uplift', 'locales', 'en.json'), 'utf8'));
    assert.strictEqual(en['uplift.gs.res.prio'], 'Long Prompt Handling');
    assert.strictEqual(en['uplift.gs.res.prio_speed'], 'Full Speed');
});
