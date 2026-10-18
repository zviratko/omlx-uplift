/* VOICE-15: engine activity visible on the dashboard (client half).

   Vanilla already reports non-scheduler work (transcribing, realtime
   sessions, synthesizing, audio processing, embedding, reranking,
   deciding) per model as `activities`; the server feed now refreshes it
   at 2 Hz. Contracts here:
   - core.js normalize maps m.activities -> [{kind,detail,elapsed}] and
     guards junk;
   - ifActivity paints i18n labels, ×N grouping, oldest elapsed, the
     .live accent for realtime, and hides when empty; unknown details
     print verbatim;
   - wiring: renderLive calls ifActivity; the Idle line yields to it;
   - CSS + all ten locales carry the labels. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const LOCALES_DIR = path.join(__dirname, '..', 'omlx_uplift', 'locales');
const core = require(path.join(STATIC_DIR, 'core.js'));
const uplift = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');
const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

/* ---- normalize ---------------------------------------------------------- */

test('V15: normalize maps activities and guards junk', () => {
    const raw = { active_models: { models: [
        { id: 'whisper', activities: [
            { request_id: 'a', kind: 'transcribing',
              detail: 'Transcribing', elapsed_seconds: 2.5 },
            { request_id: 'b', kind: 'embedding', detail: 'Embedding' },
        ] },
        { id: 'qwen', activities: 'not-an-array' },
        { id: 'kokoro', activities: [{ request_id: 'x' }] },
    ] } };
    const s = core.normalize(raw);
    assert.deepStrictEqual(s.models[0].activities, [
        { kind: 'transcribing', detail: 'Transcribing', elapsed: 2.5 },
        { kind: 'embedding', detail: 'Embedding', elapsed: null },
    ]);
    assert.deepStrictEqual(s.models[1].activities, []);
    assert.deepStrictEqual(s.models[2].activities, []);   // kind+detail both empty
    assert.deepStrictEqual(
        core.normalize({ active_models: { models: [{ id: 'a' }] } })
            .models[0].activities, []);
});

/* ---- ifActivity behavior ------------------------------------------------ */

function loadIfActivity() {
    const maps = /const IF_ACTIVITY_LABELS = \{[\s\S]*?\};/.exec(uplift);
    const fbs = /const IF_ACTIVITY_FALLBACK = \{[\s\S]*?\};/.exec(uplift);
    const fn = /function ifActivity\(g, m\) \{[\s\S]*?\n\}/.exec(uplift);
    assert.ok(maps && fbs && fn, 'IF_ACTIVITY_* + ifActivity exist in uplift.js');
    const C = {
        tf: (key) => ({ 'uplift.audio.transcribing': 'Přepis',
                        'uplift.audio.realtime': 'Přepis realtime',
                        'uplift.audio.synthesizing': 'Syntéza řeči' }[key]
                      || '??' + key),
        fmtDuration: (n) => (n >= 60 ? Math.floor(n / 60) + 'm' : n + 's'),
    };
    const ctx = vm.createContext({ C });
    vm.runInContext([maps[0], fbs[0], fn[0],
        'var out = { ifActivity };'].join('\n'), ctx);
    return { ifActivity: ctx.out.ifActivity };
}
function el() { return { className: '', textContent: '', style: { display: 'none' } }; }

test('V15: activity rows paint i18n labels and elapsed', () => {
    const { ifActivity } = loadIfActivity();
    const g = { act: el() };
    ifActivity(g, { activities: [
        { kind: 'transcribing', detail: 'Transcribing', elapsed: 12.4 },
    ] });
    assert.strictEqual(g.act.style.display, '');
    assert.strictEqual(g.act.textContent, 'Přepis · 12s');   // catalog wins
    assert.ok(!/\blive\b/.test(g.act.className));
});

test('V15: same detail groups ×N with the OLDEST elapsed', () => {
    const { ifActivity } = loadIfActivity();
    const g = { act: el() };
    ifActivity(g, { activities: [
        { kind: 'synthesizing speech', detail: 'Synthesizing speech', elapsed: 1 },
        { kind: 'synthesizing speech', detail: 'Synthesizing speech', elapsed: 4 },
    ] });
    assert.strictEqual(g.act.textContent, 'Syntéza řeči ×2 · 4s');
});

test('V15: realtime marks .live', () => {
    const { ifActivity } = loadIfActivity();
    const g = { act: el() };
    ifActivity(g, { activities: [
        { kind: 'transcribing', detail: 'Realtime transcription', elapsed: 30 },
    ] });
    assert.ok(g.act.className.split(/\s+/).includes('live'));
    assert.strictEqual(g.act.textContent, 'Přepis realtime · 30s');
});

test('V15: unknown details print the server string verbatim', () => {
    const { ifActivity } = loadIfActivity();
    const g = { act: el() };
    ifActivity(g, { activities: [
        { kind: 'teleporting', detail: 'Teleporting', elapsed: null },
    ] });
    assert.strictEqual(g.act.textContent, 'Teleporting');
});

test('V15: empty and vanished activities hide the row', () => {
    const { ifActivity } = loadIfActivity();
    const g = { act: el() };
    ifActivity(g, { activities: [{ kind: 'embedding', detail: 'Embedding', elapsed: 1 }] });
    assert.strictEqual(g.act.style.display, '');
    ifActivity(g, { activities: [] });
    assert.strictEqual(g.act.style.display, 'none');
    assert.strictEqual(g.act.textContent, '');
    ifActivity(g, {});
    assert.strictEqual(g.act.style.display, 'none');
});

/* ---- wiring / CSS / locales --------------------------------------------- */

test('V15: renderLive drives ifActivity and the Idle line yields', () => {
    assert.ok(/ifDflash\(g, m\);\s*\n\s*ifActivity\(g, m\);/.test(uplift));
    assert.ok(/g\.act && g\.act\.style\.display !== 'none'/.test(uplift));
    assert.ok(/el\.append\(h, wrap, idle, df, act\)/.test(uplift));
});

test('V15: CSS carries the activity row', () => {
    const m = /\.if-act \{[^}]*\}/.exec(css);
    assert.ok(m, '.if-act rule exists');
    assert.ok(/--amber-text/.test(m[0]), 'busy label reads amber');
    assert.ok(/animation: pulse/.test(m[0]), 'activity rows pulse while live');
    assert.ok(/padding: 2px 2px 0 20px/.test(m[0]),
        'same indent column as the dflash sub-row');
    assert.ok(/\.if-act\.live \{[^}]*--accent/.test(css));
});

test('V15: all ten locales carry every mapped label', () => {
    const locs = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
    assert.strictEqual(locs.length, 10);
    const keys = ['transcribing', 'realtime', 'synthesizing', 'processing',
                  'embedding', 'reranking', 'deciding']
        .map(k => 'uplift.audio.' + k);
    const mapped = [...uplift.matchAll(/'(uplift\.audio\.[a-z]+)'/g)]
        .map(m => m[1]);
    for (const k of new Set(mapped))
        assert.ok(keys.includes(k), `code references unknown key ${k}`);
    for (const f of locs) {
        const d = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'));
        for (const k of keys)
            assert.ok(typeof d[k] === 'string' && d[k].length, `${f}: ${k}`);
    }
});
