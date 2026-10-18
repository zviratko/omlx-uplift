/* VOICE-15: audio-engine activity on the dashboard (client half).

   Server half (audio_activity.py + stats merge) attaches per-row `audio`
   lists; the client must map them through normalize() and paint the
   IN-FLIGHT sub-row. Contracts here:
   - core.js normalize maps m.audio -> [{kind,count,elapsed}] and drops
     junk (non-arrays, missing kind);
   - ifAudio paints labels, ×N and elapsed, hides when empty, and marks
     realtime with the .live class;
   - wiring: renderLive calls ifAudio, the Idle line yields to a live
     audio row, ifGroup creates the element;
   - CSS + all ten locales carry the new keys. */
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

/* ---- normalize passthrough --------------------------------------------- */

test('V15c: normalize maps the audio field and guards junk', () => {
    const raw = { active_models: { models: [
        { id: 'whisper-x', audio: [
            { kind: 'stt', count: 2, elapsed: 3.7 },
            { kind: 'nope-missing-count' },
        ] },
        { id: 'qwen', audio: 'not-an-array' },
        { id: 'kokoro', audio: [{ kind: '', count: 1 }] },
    ] } };
    const s = core.normalize(raw);
    assert.deepStrictEqual(s.models[0].audio, [
        { kind: 'stt', count: 2, elapsed: 3.7 },
        { kind: 'nope', count: 1, elapsed: null },
    ].map((x, i) => (i === 1 ? { kind: 'nope-missing-count', count: 1, elapsed: null } : x)));
    assert.deepStrictEqual(s.models[1].audio, []);   // junk -> empty, never crash
    assert.deepStrictEqual(s.models[2].audio, []);   // kindless entry dropped
    // absent field (every text model) -> []
    assert.deepStrictEqual(core.normalize({ active_models: { models: [{ id: 'a' }] } })
        .models[0].audio, []);
});

/* ---- ifAudio behavior (extracted, like the FE-1 door for IIFE pieces) --- */

function loadIfAudio() {
    const map = /const IF_AUDIO_LABELS = \{[\s\S]*?\};/.exec(uplift);
    const fn = /function ifAudio\(g, m\) \{[\s\S]*?\n\}/.exec(uplift);
    assert.ok(map && fn, 'IF_AUDIO_LABELS + ifAudio exist in uplift.js');
    const C = {
        tf: (key, fb) => (key === 'uplift.audio.realtime' ? 'Realtime transcription'
            : key === 'uplift.audio.transcribing' ? 'Transcribing'
            : key === 'uplift.audio.synthesizing' ? 'Synthesizing' : fb),
        fmtDuration: (n) => (n >= 60 ? Math.floor(n / 60) + 'm' : n + 's'),
    };
    const ctx = vm.createContext({ C, IF_AUDIO_LABELS: undefined });
    vm.runInContext(map[0].replace('const ', 'var ') + '\n' + fn[0] +
        '\nvar out = { ifAudio };', ctx);
    return { ifAudio: ctx.out.ifAudio };
}
function el() { return { className: '', textContent: '', style: { display: 'none' } }; }

test('V15c: audio rows paint label, ×N and elapsed', () => {
    const { ifAudio } = loadIfAudio();
    const g = { au: el() };
    ifAudio(g, { audio: [{ kind: 'stt', count: 3, elapsed: 12.4 }] });
    assert.strictEqual(g.au.style.display, '');
    assert.ok(g.au.textContent.includes('Transcribing'));
    assert.ok(g.au.textContent.includes('\u00d73'));
    assert.ok(g.au.textContent.includes('12s'));
    assert.ok(!/\blive\b/.test(g.au.className), 'file work is not .live');
});

test('V15c: realtime marks the row .live and skips elapsed', () => {
    const { ifAudio } = loadIfAudio();
    const g = { au: el() };
    ifAudio(g, { audio: [{ kind: 'realtime', count: 1, elapsed: null }] });
    assert.strictEqual(g.au.textContent, 'Realtime transcription');
    assert.ok(g.au.className.split(/\s+/).includes('live'));
});

test('V15c: empty and vanished audio hide the row', () => {
    const { ifAudio } = loadIfAudio();
    const g = { au: el() };
    ifAudio(g, { audio: [{ kind: 'tts', count: 1, elapsed: 2 }] });
    assert.strictEqual(g.au.style.display, '');
    ifAudio(g, { audio: [] });
    assert.strictEqual(g.au.style.display, 'none');
    assert.strictEqual(g.au.textContent, '');
    ifAudio(g, {});                                  // no field at all
    assert.strictEqual(g.au.style.display, 'none');
});

/* ---- wiring ------------------------------------------------------------ */

test('V15c: renderLive drives ifAudio and the Idle line yields to it', () => {
    assert.ok(/ifDflash\(g, m\);\s*\n\s*ifAudio\(g, m\);/.test(uplift),
        'renderLive calls ifAudio right after ifDflash');
    assert.ok(/g\.au && g\.au\.style\.display !== 'none'/.test(uplift),
        'the idle line hides while an audio row shows');
    assert.ok(/el\.append\(h, wrap, idle, df, au\)/.test(uplift),
        'ifGroup mounts the audio sub-row');
});

test('V15c: CSS carries the audio row', () => {
    const m = /\.if-audio \{[^}]*\}/.exec(css);
    assert.ok(m, '.if-audio rule exists');
    assert.ok(/--amber-text/.test(m[0]), 'busy label reads amber (work signal)');
    assert.ok(/animation: pulse/.test(m[0]), 'audio rows pulse while live');
    assert.ok(/padding: 2px 2px 0 20px/.test(m[0]),
        'same indent column as the dflash sub-row');
    assert.ok(/\.if-audio\.live \{[^}]*--accent/.test(css),
        'realtime sessions get the steady accent');
});

test('V15c: all ten locales carry the five audio labels', () => {
    const locs = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
    assert.strictEqual(locs.length, 10);
    const keys = ['transcribing', 'realtime', 'synthesizing', 'processing', 'busy']
        .map(k => 'uplift.audio.' + k);
    for (const f of locs) {
        const d = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'));
        for (const k of keys)
            assert.ok(typeof d[k] === 'string' && d[k].length, `${f}: ${k}`);
    }
});
