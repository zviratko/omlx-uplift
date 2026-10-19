/* RELAX-1 (behavioral): the celebration fire point of uplift_feed.js —
   global cooldown spacing, the small/fast confetti pop, and the x10
   milestone quip ladder — sliced VERBATIM from the shipped source and run
   in a vm sandbox (uplift_feed.js cannot boot headless whole: it pulls
   UpliftDom, modelmgr, confetti and the DOM; same slice harness style as
   act-sleep1-feed-watchdog.test.cjs). Justification for the dynamic wrap:
   the body concatenates ONLY the repository's own checked-in source, no
   external input. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');
const C = require('../omlx_uplift/static/core.js');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_feed.js'), 'utf8');

function between(from, to) {
    const a = src.indexOf(from), b = src.indexOf(to);
    assert.ok(a >= 0 && b > a, `slice markers (${JSON.stringify(from.slice(0, 30))}: ${a}, ${b})`);
    return src.slice(a, b);
}
assert.ok(/^const CELEB_COOLDOWN_MS = 30_000;$/m.test(src),
    'global celebration cooldown moved — update harness');

// the celebrate/queue/confetti region: celebrate() through the flush
// listener loop, stopping before reactTo (feed pushes, not celebrations)
const SLICE_CELEB = between('function celebrate(', 'function reactTo(');
assert.ok(SLICE_CELEB.includes('function _celebrateNow'), 'slice carries the fire point');
// the milestone quip table + generic rotation (ladder gate follows); the
// slice owns MILESTONE_QUIPS, MILESTONE_GENERIC and the `let _genericQuip`
// counter — the wrapper must NOT re-declare any of them.
const SLICE_QUIP = between('const MILESTONE_QUIPS', '/* Ladder gate');
assert.ok(SLICE_QUIP.includes('function milestoneQuip'), 'slice carries the quip picker');

function loadCeleb({ motionOff = false, audience = true } = {}) {
    const env = {
        t: 1_000_000, motionOff, audience, toasts: [], bursts: [], timers: [],
        cleared: [], listeners: [],
    };
    const code = `
        var confetti = (o) => { env.bursts.push(o); };
        var audienceHere = () => env.audience;
        var FEG = {
            motionOff: () => env.motionOff,
            toast: (text, ms, cls) => env.toasts.push({ text, ms, cls }),
        };
        (() => {
            ${SLICE_CELEB}
            return { celebrate, flushCelebrations, CELEB_COOLDOWN_MS,
                     get pending() { return _celebPending.length; } };
        })()`;
    const sandbox = {
        env,
        document: { hidden: false },
        Date: { now: () => env.t },
        Math,
        setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
        clearTimeout: () => { env.cleared.push('timeout'); },
        setInterval: (fn, ms) => { env.timers.push({ fn, ms, repeat: true }); return env.timers.length; },
        clearInterval: () => { env.cleared.push('interval'); },
        addEventListener: (ev) => { env.listeners.push(ev); },
    };
    const api = vm.runInNewContext(code, sandbox);
    return { api, env };
}

function loadQuip(fmtNumber) {
    const code = `(() => {
        ${SLICE_QUIP}
        return { MILESTONE_QUIPS, MILESTONE_GENERIC, milestoneQuip }; })()`;
    return vm.runInNewContext(code, { C: { fmtNumber } });
}

/* ---------- the small fast pop ---------- */
test('praise pops: few particles, short fuse, no explosion', () => {
    const { api, env } = loadCeleb();
    api.celebrate('Good servant.', 'praise');
    assert.strictEqual(env.toasts.length, 1);
    assert.strictEqual(env.bursts.length, 1);
    const b = env.bursts[0];
    assert.ok(b.particleCount <= 30, `pop stays small (got ${b.particleCount})`);
    assert.ok(b.ticks <= 120, `pop dies fast (ticks ${b.ticks})`);
    assert.ok(b.gravity >= 1.2 && b.scalar <= 1, 'chips fall heavy and stay tiny');
});
test('awe double pops: second volley lands via the 180 ms timer, one toast', () => {
    const { api, env } = loadCeleb();
    api.celebrate('Ten million.', 'awe');
    assert.strictEqual(env.bursts.length, 1);
    const volley = env.timers.find(t => !t.repeat);
    assert.ok(volley && volley.ms === 180, 'awe schedules the second pop at +180 ms');
    volley.fn();
    assert.strictEqual(env.bursts.length, 2);
    assert.strictEqual(env.toasts.length, 1, 'the volley adds confetti, not a second toast');
    assert.ok(env.bursts[1].particleCount <= 40, 'the volley pops too');
});
test('scorn keeps its ceiling rain (it is weather, not an explosion)', () => {
    const { api, env } = loadCeleb();
    api.celebrate('Collar time.', 'scorn');
    assert.strictEqual(env.toasts.length, 1);
    assert.strictEqual(env.toasts[0].cls, 'toast-scorn');
    assert.strictEqual(env.bursts[0].origin.y, 0);
    assert.ok(env.bursts[0].particleCount >= 100);
});

/* ---------- global cooldown ---------- */
test('cooldown: one celebration per CELEB_COOLDOWN_MS, closer ones drop silently', () => {
    const { api, env } = loadCeleb();
    api.celebrate('First.', 'praise');
    env.t += 10_000;
    api.celebrate('Second too close.', 'awe');
    assert.strictEqual(env.toasts.length, 1, 'the 10 s follow-up is dropped');
    assert.strictEqual(env.bursts.length, 1);
    env.t += 20_001;                                // 30.001 s after the first
    api.celebrate('Third, spaced.', 'praise');
    assert.strictEqual(env.toasts.length, 2);
    assert.match(env.toasts[1].text, /Third/);
});
test('audience-queue drain is cooldown-spaced: a burst flush pops ONCE, not three', () => {
    const { api, env } = loadCeleb({ audience: false });
    api.celebrate('One.', 'praise');                // no audience: queued
    api.celebrate('Two.', 'awe');
    api.celebrate('Three.', 'scorn');
    assert.strictEqual(api.pending, 3);
    assert.strictEqual(env.toasts.length, 0);
    api.flushCelebrations();                        // 450 ms drain tick armed
    const tick = env.timers.find(t => t.repeat);
    assert.ok(tick, 'drain interval registered');
    tick.fn();                                      // 'One.' survives the gate
    assert.strictEqual(env.toasts.length, 1);
    env.t += 450; tick.fn();                        // 'Two.' inside cooldown: drops
    env.t += 450; tick.fn();                        // 'Three.' likewise drops
    assert.strictEqual(env.toasts.length, 1, 'no machine-gun flush at 450 ms spacing');
    assert.strictEqual(api.pending, 0, 'excess praise is consumed, not buffered forever');
});
test('motion off still kills everything BEFORE any cooldown/queue state moves', () => {
    const { api, env } = loadCeleb({ motionOff: true });
    api.celebrate('Silent.', 'awe');
    assert.strictEqual(env.toasts.length, 0);
    assert.strictEqual(api.pending, 0, 'no queueing when motion is off');
});

/* ---------- milestone quips on the x10 ladder ---------- */
test('every MILESTONE_QUIPS key is a real ladder rung (no more dead BILLION key)', () => {
    const q = loadQuip(v => String(v));
    for (const key of Object.keys(q.MILESTONE_QUIPS)) {
        assert.ok(C.MILESTONE_LADDER.includes(Number(key)),
            `quip key ${key} is not a ladder rung`);
    }
    assert.ok(Object.keys(q.MILESTONE_QUIPS).length >= 14);
    // the old dead key (2^30, never on the 2e6-doubling ladder) must be gone
    assert.strictEqual(q.MILESTONE_QUIPS[1073741824], undefined);
    assert.match(q.milestoneQuip({ label: 'tokens processed', value: 10240000000, rung: 10240000000 }),
        /TEN BILLION/);
});
test('milestone quips: x10 ladder lines + rotating generic fallback', () => {
    const q = loadQuip(v => String(v));
    const s10k = q.milestoneQuip({ label: 'requests processed', value: 10001, rung: 10000 });
    assert.match(s10k, /^10K requests processed\. A crumb/);
    assert.match(s10k, /\[10001\]$/, 'exact value rides in brackets');
    // off-ladder crossings lead with the formatted value and ROTATE the
    // generic line so even filler copy never repeats within a session
    const seen = [];
    for (let i = 0; i < 5; i++)
        seen.push(q.milestoneQuip({ label: 'tokens processed', value: 12345, rung: null }));
    assert.strictEqual(seen[0].startsWith('12.345K tokens processed.'), true);
    assert.notStrictEqual(seen[0], seen[1], 'generic line must rotate');
    assert.strictEqual(seen[0], seen[4], 'rotation cycles the pool');
    assert.strictEqual(new Set(seen.slice(0, 4)).size, 4, 'four distinct generic lines');
});
