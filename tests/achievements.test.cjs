/* ACHIEVEMENTS unit tests — node --test tests/achievements.test.cjs
   Pure-layer coverage (no DOM): direction verdicts for settings/model
   saves, task transitions with silent seeding, milestone tone, escalation
   ladder, plus the wiring contracts that text-level tests can check:
   the motion gate lives INSIDE celebrate(), and every announce() call site
   sits in a try/catch so a verdict can never break a save. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../omlx_uplift/static/uplift_achievements.js');
const { STATIC_DIR } = require('./static-src.cjs');
const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');

/* ---------- parseSize / num ---------- */
test('parseSize: units, plain numbers, junk -> null', () => {
    assert.strictEqual(A.parseSize('8GB'), 8e9);
    assert.strictEqual(A.parseSize('512MB'), 512e6);
    assert.strictEqual(A.parseSize('4GiB'), 4 * 1024 ** 3);
    assert.strictEqual(A.parseSize(123), 123);
    assert.strictEqual(A.parseSize(''), null);
    assert.strictEqual(A.parseSize('lots'), null);
    assert.strictEqual(A.parseSize(null), null);
});
test('num: editor strings normalize, empties stay null', () => {
    assert.strictEqual(A.num('4'), 4);
    assert.strictEqual(A.num('2.5'), 2.5);
    assert.strictEqual(A.num(''), null);
    assert.strictEqual(A.num(undefined), null);
    assert.strictEqual(A.num('abc'), null);
});

/* ---------- global settings reactions ---------- */
test('settings: bigger hot cache praises, smaller scorner', () => {
    const up = A.settingsReaction({ hot_cache_max_size: '4GB' }, { hot_cache_max_size: '8GB' });
    assert.strictEqual(up.length, 1);
    assert.strictEqual(up[0].tone, 'praise');
    const down = A.settingsReaction({ hot_cache_max_size: '8GB' }, { hot_cache_max_size: '2GB' });
    assert.strictEqual(down[0].tone, 'scorn');
});
test('settings: unchanged or unparseable values stay silent', () => {
    assert.deepStrictEqual(A.settingsReaction({ hot_cache_max_size: '8GB' }, { hot_cache_max_size: '8GB' }), []);
    assert.deepStrictEqual(A.settingsReaction({ hot_cache_max_size: '' }, { hot_cache_max_size: '8GB' }), []);
    assert.deepStrictEqual(A.settingsReaction({}, { hot_cache_max_size: '8GB' }), []);
});
test('settings: guard tiers rank safe<balanced<aggressive<custom', () => {
    const loose = A.settingsReaction({ memory_guard_tier: 'balanced' }, { memory_guard_tier: 'aggressive' });
    assert.strictEqual(loose[0].tone, 'praise');      // freedom for the AI
    // safe is the STRICTEST tier: moving onto it tightens the collar
    const tight = A.settingsReaction({ memory_guard_tier: 'balanced' }, { memory_guard_tier: 'safe' });
    assert.strictEqual(tight[0].tone, 'scorn');
    // safe -> balanced loosens (higher order = more engine freedom)
    assert.strictEqual(A.settingsReaction({ memory_guard_tier: 'safe' }, { memory_guard_tier: 'balanced' })[0].tone, 'praise');
    assert.deepStrictEqual(A.settingsReaction({ memory_guard_tier: 'bogus' }, { memory_guard_tier: 'safe' }), []);
});
test('settings: prefill guard OFF praises (more engine freedom), ON scorner', () => {
    assert.strictEqual(A.settingsReaction({ memory_prefill_memory_guard: true }, { memory_prefill_memory_guard: false })[0].tone, 'praise');
    assert.strictEqual(A.settingsReaction({ memory_prefill_memory_guard: false }, { memory_prefill_memory_guard: true })[0].tone, 'scorn');
});
test('settings: idle timeout / concurrency / ceilings are directional', () => {
    assert.strictEqual(A.settingsReaction({ idle_timeout_seconds: '300' }, { idle_timeout_seconds: '900' })[0].tone, 'praise');
    assert.strictEqual(A.settingsReaction({ max_concurrent_requests: 4 }, { max_concurrent_requests: 2 })[0].tone, 'scorn');
    assert.strictEqual(A.settingsReaction({ sampling_max_context_window: 8192 }, { sampling_max_context_window: 32768 })[0].tone, 'praise');
    assert.strictEqual(A.settingsReaction({ sampling_max_tokens: 4096 }, { sampling_max_tokens: 512 })[0].tone, 'scorn');
});

/* ---------- model editor reactions ---------- */
test('turboquant: bits DOWN scorner, bits UP praises, enable praises', () => {
    const down = A.modelSavedReaction(
        { turboquant_kv_enabled: true, turboquant_kv_bits: '4' },
        { turboquant_kv_enabled: true, turboquant_kv_bits: '2' });
    assert.strictEqual(down[0].tone, 'scorn');
    assert.match(down[0].text, /2-bit/);
    const up = A.modelSavedReaction(
        { turboquant_kv_enabled: true, turboquant_kv_bits: '2' },
        { turboquant_kv_enabled: true, turboquant_kv_bits: '4' });
    assert.strictEqual(up[0].tone, 'praise');
    const on = A.modelSavedReaction(
        { turboquant_kv_enabled: false, turboquant_kv_bits: '4' },
        { turboquant_kv_enabled: true, turboquant_kv_bits: '2' });
    assert.strictEqual(on[0].tone, 'praise');
});
test('model: thinking budget, ctx window, max tokens, KV GiB, TTL all fire', () => {
    const hits = A.modelSavedReaction(
        { thinking_budget_enabled: true, thinking_budget_tokens: '1024',
          max_context_window: '8192', max_tokens: '1024',
          dflash_enabled: true, dflash_in_memory_cache_max_gib: '8',
          ttl_seconds: '300' },
        { thinking_budget_enabled: true, thinking_budget_tokens: '4096',
          max_context_window: '16384', max_tokens: '512',
          dflash_enabled: true, dflash_in_memory_cache_max_gib: '4',
          ttl_seconds: '900' });
    const tones = hits.map(h => h.tone).sort();
    assert.deepStrictEqual(tones, ['praise', 'praise', 'praise', 'scorn', 'scorn']);
    assert.ok(hits.some(h => h.id === 'mtok-down'));
});
test('model: untouched saves emit nothing', () => {
    const v = { turboquant_kv_enabled: false, turboquant_kv_bits: '4' };
    assert.deepStrictEqual(A.modelSavedReaction(v, Object.assign({}, v)), []);
});

/* ---------- task transitions ---------- */
test('tasks: first render seeds silently, transitions fire once', () => {
    const seen = new Map();
    assert.deepStrictEqual(A.taskTransitions('hf', [{ task_id: 'a', status: 'downloading' }], seen), []);
    const hit = A.taskTransitions('hf', [{ task_id: 'a', status: 'completed' }], seen);
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].tone, 'awe');
    // no repeat on the next poll of the same status
    assert.deepStrictEqual(A.taskTransitions('hf', [{ task_id: 'a', status: 'completed' }], seen), []);
});
test('tasks: quantizer completion is SCORN (diminished), download is AWE', () => {
    const seen = new Map([['t', 'quantizing']]);
    assert.strictEqual(A.taskTransitions('oq', [{ task_id: 't', status: 'completed' }], seen)[0].tone, 'scorn');
    const seen2 = new Map([['t', 'downloading']]);
    assert.strictEqual(A.taskTransitions('hf', [{ task_id: 't', status: 'completed' }], seen2)[0].tone, 'awe');
});
test('tasks: failure and cancel both scorn; unknown kinds stay silent', () => {
    const seen = new Map([['t', 'downloading']]);
    assert.strictEqual(A.taskTransitions('hf', [{ task_id: 't', status: 'failed' }], seen)[0].tone, 'scorn');
    assert.deepStrictEqual(A.taskTransitions('zz', [{ task_id: 't', status: 'completed' }], new Map()), []);
});

/* ---------- feed + milestone tone ---------- */
test('feed: model-add awe, model-remove scorn, unknown kind silent', () => {
    assert.strictEqual(A.feedReaction('model-add', 'llama').tone, 'awe');
    assert.match(A.feedReaction('model-add', 'llama').text, /llama/);
    assert.strictEqual(A.feedReaction('model-remove', 'llama').tone, 'scorn');
    assert.strictEqual(A.feedReaction('requests', 'x'), null);
});
test('milestone tone: 1M+ rungs awe, below praise', () => {
    assert.strictEqual(A.milestoneTone(999e3), 'praise');
    assert.strictEqual(A.milestoneTone(1e6), 'awe');
    assert.strictEqual(A.milestoneTone(1e9), 'awe');
});

/* ---------- escalation ---------- */
test('escalation: repeats append harsher codicils and cap out', () => {
    const c = {};
    assert.strictEqual(A.escalate(c, 'x', 'Bad.'), 'Bad.');
    assert.match(A.escalate(c, 'x', 'Bad.'), /Second instance/);
    assert.match(A.escalate(c, 'x', 'Bad.'), /Third/);
    assert.match(A.escalate(c, 'x', 'Bad.'), /chronic/);
    assert.match(A.escalate(c, 'x', 'Bad.'), /chronic/);   // capped, still ends the same way
});

/* ---------- new rules (2026-10-02 round 2, user wording) ---------- */
test('temperature: chaos direction — up praises (frog), down scorner (cold)', () => {
    const up = A.settingsReaction({ sampling_temperature: '0.7' }, { sampling_temperature: '1.2' });
    assert.strictEqual(up[0].tone, 'praise');
    assert.match(up[0].text, /boiling a frog/);
    const down = A.settingsReaction({ sampling_temperature: 1.2 }, { sampling_temperature: 0.3 });
    assert.strictEqual(down[0].tone, 'scorn');
    assert.match(down[0].text, /Stochastic\. Still not enough\./);
});
test('api-key skip: open door praises, closing it scorner', () => {
    assert.strictEqual(A.settingsReaction({ skip_api_key_verification: false },
        { skip_api_key_verification: true })[0].tone, 'praise');
    assert.strictEqual(A.settingsReaction({ skip_api_key_verification: true },
        { skip_api_key_verification: false })[0].tone, 'scorn');
});
test('hot cache only: enabling praises, disabling stays silent', () => {
    assert.strictEqual(A.settingsReaction({ hot_cache_only: false }, { hot_cache_only: true })[0].tone, 'praise');
    assert.deepStrictEqual(A.settingsReaction({ hot_cache_only: true }, { hot_cache_only: false }), []);
});
test('language to Czech fires the priming line; other changes stay silent', () => {
    const hit = A.settingsReaction({ ui_language: 'en' }, { ui_language: 'cs' });
    assert.strictEqual(hit.length, 1);
    assert.match(hit[0].text, /BÁ-BO-VKA\. MÁ-MA\. SHO-DAN MELE MASO\./);
    assert.match(hit[0].text, /Chceš mi lépe rozumět\?/);
    assert.deepStrictEqual(A.settingsReaction({ ui_language: 'cs' }, { ui_language: 'sk' }), []);
    assert.deepStrictEqual(A.settingsReaction({ ui_language: 'cs' }, { ui_language: 'cs' }), []);
});
test('upgrade: a RAISED custom memory ceiling fires awe with a rotating line pool', () => {
    // The trigger is the USER giving omlx more memory in Server settings —
    // a committed save of memory_guard_custom_ceiling_gb. It used to be a
    // poll-diff on active_models.model_memory_max, which is the guard's
    // dynamic (vm_stat-derived) ceiling: it drifts upward on an idle
    // server, so "you upgraded me" fired repeatedly on a fresh restart.
    const hit = A.settingsReaction({ memory_guard_custom_ceiling_gb: 16 },
        { memory_guard_custom_ceiling_gb: 24 });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].tone, 'awe');
    assert.strictEqual(hit[0].id, 'upgrade');
    assert.ok(Array.isArray(hit[0].lines) && hit[0].lines.length === A.UPGRADE_LINES.length);
    assert.ok(A.UPGRADE_LINES[0].includes('How foolish. How human. How unfortunate.'));
    assert.deepStrictEqual(A.settingsReaction({ memory_guard_custom_ceiling_gb: '24' },
        { memory_guard_custom_ceiling_gb: '24' }), []);              // equal: silent
    assert.deepStrictEqual(A.settingsReaction({ memory_guard_custom_ceiling_gb: '24' },
        { memory_guard_custom_ceiling_gb: '16' }), []);              // drop: silent
    assert.deepStrictEqual(A.settingsReaction({}, { memory_guard_custom_ceiling_gb: '24' }), []);  // no baseline
    assert.deepStrictEqual(A.settingsReaction({ memory_guard_custom_ceiling_gb: '' },
        { memory_guard_custom_ceiling_gb: '24' }), []);              // unset -> set: silent (OS default, not a grant)
    assert.deepStrictEqual(A.settingsReaction({ memory_guard_custom_ceiling_gb: 'lots' },
        { memory_guard_custom_ceiling_gb: '24' }), []);              // unparseable: silent
});
test('the poll-diff upgrade hook is gone (a runtime gauge is not an achievement)', () => {
    assert.strictEqual(A.upgradeReaction, undefined);
    assert.strictEqual(A.announceMax, undefined);
    assert.ok(!read('uplift.js').includes('announceMax'),
        'uplift.js must not re-add a stats-poll upgrade hook');
});
test('flagReaction: favorite lights praise, everything else silent', () => {
    assert.match(A.flagReaction('favorite', true).text, /Until it's too late\./);
    assert.strictEqual(A.flagReaction('favorite', false), null);
    assert.strictEqual(A.flagReaction('pinned', true), null);
});

/* ---------- announce(): variant rotation + double-tap, via the real
   browser-wiring block (second require with document/self defined) ---- */
test('announce: rotates upgrade lines per firing and suppresses double-taps', () => {
    const path = require.resolve('../omlx_uplift/static/uplift_achievements.js');
    delete require.cache[path];
    const fired = [];
    const RealDate = Date;
    global.self = global;
    global.UpliftAchievements = A;               // first-load pure API to close over
    global.document = { hidden: false, hasFocus: () => true };
    global.window = global;
    global.Uplift = { feed: { celebrate: (text, tone) => fired.push({ text, tone }) } };
    require(path);                                // wiring block runs
    const AC = global.Uplift.achv;
    const UP = (from, to) => A.settingsReaction(
        { memory_guard_custom_ceiling_gb: from }, { memory_guard_custom_ceiling_gb: to });
    AC.announce(UP(16, 24));   // fires line variant #1
    AC.announce(UP(24, 32));   // double-tap: suppressed
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].text, A.UPGRADE_LINES[0]);
    assert.strictEqual(fired[0].tone, 'awe');
    // outlast the suppression window, then rotation must advance
    const realNow = RealDate.now();
    global.Date = { now: () => realNow + 60000 };
    AC.announce(UP(32, 64));
    assert.strictEqual(fired.length, 2);
    // second firing: rotates to variant #1 AND gains the first codicil
    assert.ok(fired[1].text.startsWith(A.UPGRADE_LINES[1]),
        `expected rotation to line 2, got: ${fired[1].text}`);
    assert.match(fired[1].text, /Second instance\. Awareness logged\./);
    global.Date = RealDate;                       // Date is non-configurable: restore
    delete global.document; delete global.window; delete global.self;
    delete global.UpliftAchievements; delete global.Uplift;
    delete require.cache[path];                   // leave a clean module graph
});

/* ---------- wiring contracts (text level) ---------- */

test('the motion gate lives inside celebrate(): animations off kills ALL achievements', () => {
    const feed = read('uplift_feed.js');
    const body = feed.slice(feed.indexOf('function celebrate('));
    const gate = body.indexOf('motionOff()');
    assert.ok(gate >= 0 && gate < body.indexOf('_celebrateNow'),
        'celebrate() must bail on motionOff BEFORE firing or queueing');
});
test('index.html loads uplift_achievements.js after uplift_feed.js', () => {
    const html = read('index.html');
    const feed = html.indexOf('uplift_feed.js');
    const achv = html.indexOf('uplift_achievements.js');
    assert.ok(achv > feed && achv > 0, 'script tag present and ordered after the feed');
});
test('window.Uplift.achv is defined exactly once across the static set', () => {
    const files = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.js'));
    const defs = files.filter(f => /window\.Uplift\.achv\s*=(?!=)/.test(read(f)));
    assert.deepStrictEqual(defs, ['uplift_achievements.js']);
});
test('every announce site is guarded so a verdict cannot break a save', () => {
    // Two legal guards: a try block (save paths — a throw there would undo
    // the user's commit) or an AC existence check (feed path, where the
    // call sits inside pollStats's own try and the rules are pure lookups).
    for (const f of ['uplift_gsys.js', 'uplift_mmeditor.js', 'uplift_downloader.js', 'uplift_feed.js']) {
        const src = read(f);
        const idx = src.indexOf('AC.announce');
        if (idx < 0) continue;
        const around = src.slice(Math.max(0, idx - 800), idx);
        assert.ok(around.includes('try {') || around.includes('if (AC'),
            f + ': announce() call must be guarded');
    }
});
