/* VOICE-10 speech-io unit proofs: the streaming text chunker
   (splitSpeechChunks / createSpeechSplitter: modes, min-floor merge, hard
   cap at [,;:], incremental feed === whole-text split, flush tail) and the
   strictly-ordered gapless SpeechQueue (out-of-order promise resolution,
   prefetch ahead of playback, token-stop discarding late work, error-skip
   policy with one retry). Pure logic — the module is `require`d directly
   (UMD tail) and every environment seam (AudioContext, transport, WAV
   decode) is a hand-rolled fake, so no Web Audio and no server. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

const IO = require(path.join(STATIC_DIR, 'uplift_speechio.js'));
const { splitSpeechChunks, createSpeechSplitter, createSpeechSanitizer,
        sanitizeSpeechText, SpeechQueue } = IO;

// flush the microtask chains (load -> ready -> schedule -> end) between steps
const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};
function deferred() {
    const d = {};
    d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
    return d;
}
// a never-resolving queue must FAIL the suite, not hang it
function orTimeout(p, ms = 2000, label = 'promise') {
    let t;
    return Promise.race([
        p.then(v => { clearTimeout(t); return v; }),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(
            'TIMEOUT waiting for ' + label)), ms); }),
    ]);
}

/* ---- fake Web Audio ----------------------------------------------------
   Sources do NOT end on their own (unless the ctx is built with autoEnd):
   playback timing is asserted, never raced, and `drain(q)` ends what is
   live so a full playthrough can be driven deterministically. */
function fakeCtx(o) {
    o = o || {};
    const ctx = {
        currentTime: o.at || 0,
        autoEnd: !!o.autoEnd,
        destination: { __dest: true },
        sources: [],
        decoded: 0,
        createBufferSource() {
            const src = {
                buffer: null, connectAt: null, started: null, stopCalls: 0,
                disconnects: 0, onended: null, ended: false,
                connect(node) { src.connectAt = node; },
                disconnect() { src.disconnects++; },
                start(t) {
                    src.started = t;
                    if (ctx.autoEnd) setImmediate(() => src.__end());
                },
                stop() { src.stopCalls++; src.__end(); },
                __end() {
                    if (src.ended) return;
                    src.ended = true;
                    if (src.onended) src.onended();
                },
            };
            ctx.sources.push(src);
            return src;
        },
        decodeAudioData(bytes, ok) {
            ctx.decoded++;
            const b = { duration: bytes && bytes.__dur || 1, buffer: bytes };
            if (ok) ok(b);
            return Promise.resolve(b);
        },
        live() { return ctx.sources.filter(s => !s.ended); },
        scheduled() { return ctx.sources.filter(s => s.started !== null); },
    };
    if (o.noDecode) delete ctx.decodeAudioData;   // the "cannot decode" path
    return ctx;
}
const buf = (dur) => ({ duration: dur, kind: 'AudioBuffer' });

// end everything that is live, repeatedly, until the queue reports drained
async function drain(q, ctx, opts) {
    opts = opts || {};
    const p = opts.token === 'stop' ? Promise.resolve({ stopped: true }) : q.drain();
    for (let i = 0; i < 64; i++) {
        ctx.live().forEach(s => s.__end());
        await settle(3);
        if (!q.pending() && !ctx.live().length) break;
    }
    return orTimeout(p, 2000, 'drain (pending=' + q.pending()
        + ', live=' + ctx.live().length + ')');
}
// queue that hands back one fake AudioBuffer of the given duration per chunk
function durQueue(durations, extra) {
    const o = extra || {};
    const ctx = o.ctx || fakeCtx(o.ctxOpts);
    const calls = [];
    const q = new SpeechQueue(Object.assign({
        ctx,
        source: (chunk, seq) => { calls.push(seq); return buf(durations[seq]); },
    }, o.opts));
    q.__ctx = ctx;
    q.__calls = calls;
    return q;
}

/* =============================== splitter ============================== */

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const S3 = 'First sentence here. Second one follows. And a third that is '
         + 'quite long indeed, so the floor lets it stand on its own.';

test('splitter: sentence mode cuts at [.!?…] (and newlines)', () => {
    const out = splitSpeechChunks(S3, 'sentence', 1, { sanitize: false });
    assert.deepEqual(out, [
        'First sentence here.',
        'Second one follows.',
        'And a third that is quite long indeed, so the floor lets it stand on its own.',
    ]);
    const cn = splitSpeechChunks('第一句。第二句！第三句？第四句', 'sentence', 1,
                                 { sanitize: false });
    assert.equal(cn.length, 4, JSON.stringify(cn));
});

test('splitter: min floor merges short neighbours instead of emitting them', () => {
    const text = 'Yes. No. Maybe so. Ten chars. ' + 'x'.repeat(40) + '. tail.';
    const tight = splitSpeechChunks(text, 'sentence', 1, { sanitize: false });
    assert.ok(tight.length >= 5, 'floor 1 emits ~one chunk per sentence');
    const loose = splitSpeechChunks(text, 'sentence', 60, { sanitize: false });
    assert.ok(loose.length < tight.length, 'floor 60 merges the stubs');
    loose.slice(0, -1).forEach(c => assert.ok(c.length >= 60, 'under floor: ' + c));
});

test('splitter: floor ladder 40/60/120 all hold, bigger floor -> fewer chunks', () => {
    const counts = [40, 60, 120].map(f => {
        const out = splitSpeechChunks(S3.repeat(3), 'sentence', f,
                                      { sanitize: false });
        out.slice(0, -1).forEach(c => assert.ok(c.length >= f, f + ': ' + c));
        return out.length;
    });
    assert.ok(counts[0] >= counts[1] && counts[1] >= counts[2],
        'monotone: ' + counts.join('/'));
});

test('splitter: line mode ignores sentence ends, cuts at newlines only', () => {
    const text = 'one line, still the same. and more of it\nsecond line.\nthird.';
    const line = splitSpeechChunks(text, 'line', 1, { sanitize: false });
    assert.deepEqual(line, ['one line, still the same. and more of it',
                            'second line.', 'third.']);
    const sent = splitSpeechChunks(text, 'sentence', 1, { sanitize: false });
    assert.deepEqual(sent, ['one line, still the same.', 'and more of it',
                            'second line.', 'third.'],
                     'sentence mode also cuts the "." mid-line');
});

test('splitter: paragraph mode keeps a wrapped paragraph together', () => {
    const text = 'alpha line one\nalpha line two\n\nbeta paragraph body.\n';
    const p = splitSpeechChunks(text, 'paragraph', 5, { sanitize: false });
    assert.deepEqual(p, ['alpha line one alpha line two', 'beta paragraph body.']);
    const l = splitSpeechChunks(text, 'line', 5, { sanitize: false });
    assert.deepEqual(l, ['alpha line one', 'alpha line two', 'beta paragraph body.'],
                     'line mode cuts the wrap where paragraph mode does not');
});

test('splitter: whole mode yields a single chunk until the cap fires', () => {
    const w = splitSpeechChunks(S3, 'whole', 60, { sanitize: false });
    assert.equal(w.length, 1);
    assert.equal(w[0], norm(S3));
});

test('splitter: hard cap breaks at [,;:] and never exceeds cap+slack', () => {
    const clause = 'this clause carries some useful spoken words, ';
    const text = clause.repeat(40);                       // ~1800 chars, no '.'
    const out = splitSpeechChunks(text, 'whole', 60, { sanitize: false, cap: 200 });
    assert.ok(out.length > 1, 'cap split happened');
    for (const c of out.slice(0, -1)) {
        assert.ok(c.length <= 200 + 16, 'over cap: ' + c.length);
        assert.ok(/[,;:]$/.test(c), 'cut at a soft break: ' + c.slice(-12));
    }
    assert.equal(norm(out.join(' ')), norm(text), 'nothing lost or duplicated');
});

test('splitter: cap with no soft break anywhere cuts dead at the cap', () => {
    const out = splitSpeechChunks('a'.repeat(500), 'whole', 60,
                                  { sanitize: false, cap: 100 });
    assert.deepEqual(out.map(s => s.length), [100, 100, 100, 100, 100]);
});

test('splitter: cap 0 disables the guard entirely', () => {
    const out = splitSpeechChunks('a'.repeat(500), 'whole', 60,
                                  { sanitize: false, cap: 0 });
    assert.deepEqual(out.map(s => s.length), [500]);
});

test('splitter: a boundary is honoured only once the text past it arrived', () => {
    const z = createSpeechSplitter({ mode: 'sentence', minFloor: 5, cap: 0 });
    assert.deepEqual(z.push('Hello there.'), [], 'boundary at end of buffer: hold');
    assert.deepEqual(z.push(' O'), ['Hello there.'], 'next token confirms it -> emit');
    assert.deepEqual(z.push('k.'), [], 'the new chunk is still under the floor');
    assert.deepEqual(z.flush(), ['Ok.'], 'flush emits the short tail anyway');
    assert.deepEqual(z.flush(), [], 'second flush is empty');
});

/* ---- incremental feeding (the live LLM stream) ------------------------- */

function feedBySizes(text, sizes) {
    const z = createSpeechSplitter({ mode: 'sentence', minFloor: 60, cap: 200 });
    const out = [];
    let i = 0, k = 0;
    while (i < text.length) {
        const n = Math.max(1, sizes[k++ % sizes.length]);
        out.push(...z.push(text.slice(i, i + n)));
        i += n;
    }
    out.push(...z.flush());
    return out;
}

test('splitter: incremental feed === whole-text split (1/3/7/64-char deltas)', () => {
    const text = S3.repeat(4);
    const whole = splitSpeechChunks(text, 'sentence', 60, { sanitize: false, cap: 200 });
    assert.ok(whole.length > 3, 'the reference itself chunks');
    for (const n of [1, 3, 7, 64]) {
        assert.deepEqual(feedBySizes(text, [n]), whole, 'delta size ' + n);
    }
    // word-at-a-time is the realistic token shape
    const z = createSpeechSplitter({ mode: 'sentence', minFloor: 60, cap: 200 });
    const words = [];
    text.split(/(?=\s)/).forEach(w => words.push(...z.push(w)));
    words.push(...z.flush());
    assert.deepEqual(words, whole, 'word deltas');
});

test('splitter: incremental === whole for line / paragraph / whole modes too', () => {
    const text = 'l1.\nl2 more text here\n\npara two body.\ntrailing tail.';
    for (const mode of ['line', 'paragraph', 'whole', 'sentence']) {
        for (const opt of [{ minFloor: 1, cap: 0 }, { minFloor: 20, cap: 120 }]) {
            const whole = splitSpeechChunks(text, mode, opt.minFloor,
                                            { sanitize: false, cap: opt.cap });
            const z = createSpeechSplitter(Object.assign({ mode }, opt));
            const got = [];
            for (let i = 0; i < text.length; i++) got.push(...z.push(text[i]));
            got.push(...z.flush());
            assert.deepEqual(got, whole, mode + ' ' + JSON.stringify(opt));
        }
    }
});

test('splitter: empty / whitespace text emits nothing, all chunks non-empty', () => {
    assert.deepEqual(splitSpeechChunks('', 'sentence', 60), []);
    assert.deepEqual(splitSpeechChunks('   \n\n  \t ', 'sentence', 60), []);
    assert.deepEqual(splitSpeechChunks(null, 'sentence', 60), []);
    splitSpeechChunks('a.\n\n\n\n   b.', 'sentence', 1, { sanitize: false })
        .forEach(c => assert.ok(c.length, 'no empty chunk'));
});

test('splitter: unknown mode falls back to sentence', () => {
    assert.deepEqual(splitSpeechChunks('x.', 'banana', 1, { sanitize: false }), ['x.']);
});

/* ---- sanitize ---------------------------------------------------------- */

test('sanitize: drops fenced code, tables, rules; strips blockquote/list markers', () => {
    const md = ['# Heading', '> quoted words here', '', '```python',
                'print("code")', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |',
                '', '- - -', '1. first item', '* second *item*', 'tail.'].join('\n');
    const s = sanitizeSpeechText(md);
    assert.ok(!/print\(/.test(s), 'code fence body dropped: ' + s);
    assert.ok(!/```/.test(s));
    assert.ok(!/\|/.test(s), 'table rows dropped: ' + s);
    assert.ok(!s.includes('> '), 'blockquote marker gone: ' + s);
    assert.ok(s.includes('quoted words here'), 'quoted TEXT survives');
    assert.ok(s.includes('first item') && s.includes('second item'), s);
    assert.ok(!/\*/.test(s) && !/\b1\./.test(s) && !/Heading/.test(s.slice(0, 1)), s);
});

test('sanitize: drops reasoning spills (thinking tags) and their content', () => {
    const md = 'Visible answer begins. <thinking>\nhidden chain of thought\n'
             + '</thinking> visible tail continues here.';
    const s = sanitizeSpeechText(md);
    assert.ok(!/chain of thought/.test(s), s);
    assert.ok(!/thinking/.test(s), s);
    assert.match(s, /^Visible answer begins\./);
    assert.match(s, /visible tail continues here\.$/);
    // an unclosed spill is never spoken
    assert.ok(!/secret/.test(sanitizeSpeechText('ok. <thinking>secret')), 'open tag');
});

test('sanitize: incremental feed === whole-text sanitising', () => {
    const md = '```js\nvar x = 1;\n```\n> quote\n| t | able |\nplain <b>text</b>.';
    const whole = sanitizeSpeechText(md);
    const z = createSpeechSanitizer();
    let acc = [];
    for (const ch of md) { const s = z.push(ch); if (s) acc.push(s); }
    const f = z.flush();
    if (f) acc.push(f);
    assert.equal(norm(acc.join(' ')), whole);
});

test('splitter: sanitize is on by default (code fences never reach the TTS)', () => {
    const md = 'Spoken part one.\n\n```\nnot spoken at all\n```\n\nSpoken part two.';
    assert.deepEqual(splitSpeechChunks(md, 'sentence', 1),
                     ['Spoken part one.', 'Spoken part two.']);
});

/* ================================ queue ================================ */

test('queue: strictly ordered when promises resolve out of order', async () => {
    const ctx = fakeCtx();
    const d = [deferred(), deferred(), deferred()];
    const q = new SpeechQueue({ ctx, source: (chunk, seq) => d[seq].promise });
    ['one', 'two', 'three'].forEach(t => q.push(t));
    assert.equal(q.pending(), 3);
    d[2].resolve(buf(3));                       // the SLOW chunk 1 finishes first
    d[1].resolve(buf(2));
    await settle();
    assert.deepEqual(ctx.scheduled(), [], 'nothing may start before chunk 0');
    d[0].resolve(buf(1));
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.buffer.duration), [1, 2, 3],
        'scheduling order follows the sequence, not the resolution order');
    assert.deepEqual(ctx.scheduled().map(s => s.started), [0, 1, 3], 'gapless clock');
    assert.equal(q.played(), 0, 'nothing has ended yet');
});

test('queue: prefetch loads later chunks while the head plays (no stall)', async () => {
    const ctx = fakeCtx();
    const q = durQueue([1, 1, 1, 1, 1], { ctx, opts: { prefetch: 3 } });
    ['a', 'b', 'c', 'd', 'e'].forEach(t => q.push(t));
    assert.deepEqual(q.__calls, [0, 1, 2], 'prefetch window respected (sync)');
    await settle();
    ctx.sources[0].__end();                     // chunk 0 audible -> ends
    await settle();
    assert.deepEqual(q.__calls.slice(0, 4), [0, 1, 2, 3], 'window slid forward');
});

test('queue: start = max(ctx.currentTime, prevEnd) — never in the past', async () => {
    const ctx = fakeCtx();
    const q = durQueue([1, 1, 1], { ctx });
    q.push('a'); q.push('b');
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.started), [0, 1]);
    ctx.currentTime = 42;                       // playback fell behind the clock
    q.push('c');
    await settle();
    assert.equal(ctx.scheduled()[2].started, 42, 'clamped to the live clock');
    assert.equal(q.clock(), 43);
});

test('queue: progressive PCM source (a clip LIST) is appended back-to-back', async () => {
    const ctx = fakeCtx();
    const q = new SpeechQueue({ ctx, source: () => [buf(0.5), buf(0.5)] });
    q.push('a'); q.push('b');
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.started), [0, 0.5, 1, 1.5]);
    assert.equal(q.clock(), 2);
});

test('queue: WAV bytes go through the decode seam; a Response body via arrayBuffer', async () => {
    const ctx = fakeCtx();
    const q = new SpeechQueue({ ctx, decode: (bytes) => buf(bytes.__dur),
                                source: () => ({ __dur: 2 }) });
    q.push('a');
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.buffer.duration), [2]);
    // fetch-Response-shaped, decoded by the ctx itself (the browser default)
    const ctx2 = fakeCtx();
    const q2 = new SpeechQueue({ ctx: ctx2,
        fetchLike: async () => ({ arrayBuffer: async () => ({ __dur: 4 }) }),
        request: (chunk, seq) => ({ url: '/voices/speech', body: { input: chunk, seq } }) });
    q2.push('b');
    await settle();
    assert.deepEqual(ctx2.scheduled().map(s => s.buffer.duration), [4]);
    assert.equal(ctx2.decoded, 1, 'decodeAudioData is the WAV decode seam');
});

test('queue: per-chunk source override wins over the global one', async () => {
    const ctx = fakeCtx();
    const q = new SpeechQueue({ ctx, source: () => buf(1) });
    q.push({ text: 'cached', source: () => buf(9) });
    q.push('normal');
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.buffer.duration), [9, 1]);
});

test('queue: token stop discards late resolutions AND late pushes', async () => {
    const ctx = fakeCtx();
    const d = [deferred(), deferred(), deferred()];
    const asked = [];
    const q = new SpeechQueue({ ctx, source: (c, seq) => {
        asked.push(seq); return d[seq].promise;
    } });
    ['one', 'two', 'three'].forEach(t => q.push(t));
    await settle();
    assert.deepEqual(asked, [0, 1, 2], 'all three are in flight when stop() lands');
    const tokBefore = q.token();
    assert.ok(q.stop() > tokBefore, 'stop bumps the session token');
    assert.equal(q.pending(), 0, 'the killed session is fully settled');
    assert.equal(q.liveSources().length, 0);
    // the three requests that were already in flight now land, one by one
    d[0].resolve(buf(1)); d[1].resolve(buf(2)); d[2].resolve(buf(3));
    await settle();
    assert.deepEqual(ctx.scheduled(), [], 'a stale .then schedules nothing');
    const drained = await orTimeout(q.drain(), 2000, 'post-stop drain');
    assert.equal(drained.stopped, true);
    assert.equal(drained.played, 0);
    // a NEW push after stop belongs to the new token and does play
    q.push({ text: 'fourth', source: () => buf(7) });
    await settle();
    assert.deepEqual(ctx.scheduled().map(s => s.buffer.duration), [7],
        'post-stop push starts from a fresh clock');
    assert.deepEqual(ctx.scheduled().map(s => s.started), [0]);
});

test('queue: stop tears down live sources mid-playback', async () => {
    const q = durQueue([2, 2]);
    const ctx = q.__ctx;
    ['a', 'b'].forEach(t => q.push(t));
    await settle();
    assert.equal(ctx.live().length, 2, 'both clips scheduled on one clock');
    q.stop();
    assert.equal(ctx.live().length, 0);
    assert.ok(ctx.sources.every(s => s.stopCalls === 1 && s.disconnects >= 1),
        'stop() + disconnect() on every live source');
});

test('queue: reset() clears the stopped flag for the next spoken answer', async () => {
    const ctx = fakeCtx({ autoEnd: true });
    const q = durQueue([1, 1], { ctx });
    q.push('a');
    q.stop();
    assert.equal((await orTimeout(q.drain(), 2000, 'stopped drain')).stopped, true);
    q.reset();
    q.push('b');
    const r = await orTimeout(q.drain(), 2000, 'post-reset drain');
    assert.equal(r.stopped, false, 'a fresh session is not flagged stopped');
    assert.equal(r.played, 1);
});

test('queue: a failed chunk is SKIPPED (one retry) and the queue continues', async () => {
    const ctx = fakeCtx({ autoEnd: true });
    const drops = [];
    let tries = 0;
    const q = new SpeechQueue({
        ctx, onDrop: (info) => drops.push(info),
        source: (chunk, seq) => {
            if (seq !== 1) return buf(1);
            tries++;
            return Promise.reject(new Error('synth exploded'));
        },
    });
    ['alpha', 'bravo', 'charlie'].forEach(t => q.push(t));
    const drained = await orTimeout(q.drain(), 2000, 'error-skip drain');
    assert.equal(tries, 2, 'max one retry per chunk');
    assert.equal(drops.length, 1, 'exactly one dropped chunk reported');
    assert.equal(drops[0].seq, 1);
    assert.equal(drops[0].chunk, 'bravo');
    assert.match(String(drops[0].error), /synth exploded/);
    assert.deepEqual(drained.dropped.map(x => x.seq), [1],
        'drain() carries the toast accounting');
    assert.equal(drained.played, 2);
    assert.deepEqual(ctx.scheduled().map(s => s.started), [0, 1],
        'charlie butts against alpha — no silent stall, no gap');
});

test('queue: a chunk that succeeds after one failure is not dropped', async () => {
    const ctx = fakeCtx({ autoEnd: true });
    let n = 0;
    const q = new SpeechQueue({ ctx, source: () => (++n < 2
        ? Promise.reject(new Error('503')) : buf(1)) });
    q.push('flaky');
    const drained = await orTimeout(q.drain(), 2000, 'retry drain');
    assert.equal(n, 2);
    assert.deepEqual(drained.dropped, []);
    assert.equal(drained.played, 1);
});

test('queue: retries: 0 skips on the first failure', async () => {
    let n = 0;
    const q = new SpeechQueue({ ctx: fakeCtx(), retries: 0,
                                source: () => { n++; return Promise.reject(new Error('x')); } });
    q.push('a');
    const drained = await orTimeout(q.drain(), 2000, 'no-retry drain');
    assert.equal(n, 1, 'no retry attempted');
    assert.equal(drained.dropped.length, 1);
    assert.equal(drained.played, 0);
});

test('queue: empty-after-strip chunks are never requested', async () => {
    const q = durQueue([1, 1]);
    assert.equal(q.push('   '), -1);
    assert.equal(q.push(''), -1);
    assert.equal(q.push('\n\t '), -1);
    assert.equal(q.push({ text: '  ' }), -1);
    assert.equal(q.push('real'), 0, 'seq numbering ignores the rejects');
    await settle();
    assert.deepEqual(q.__calls, [0]);
    assert.equal(q.__ctx.sources.length, 1);
});

test('queue: drain resolves at once when idle, waits when something plays', async () => {
    const ctx = fakeCtx();
    const q = durQueue([1], { ctx });
    const empty = await orTimeout(q.drain(), 2000, 'idle drain');
    assert.deepEqual({ played: empty.played, dropped: empty.dropped.length },
                     { played: 0, dropped: 0 });
    q.push('a');
    let done = false;
    const p = q.drain().then(r => { done = true; return r; });
    await settle(2);
    assert.equal(done, false, 'still playing');
    assert.equal(q.played(), 0);
    ctx.live().forEach(s => s.__end());
    const r = await orTimeout(p, 2000, 'playback drain');
    assert.equal(done, true);
    assert.equal(r.played, 1);
});

test('queue: drain covers chunks appended while it is pending', async () => {
    const ctx = fakeCtx();
    const q = durQueue([1, 1, 1], { ctx });
    q.push('a');
    const p = q.drain();
    q.push('b'); q.push('c');
    const r = await drain(q, ctx, { token: null });
    await orTimeout(p, 2000, 'append-during-drain');
    assert.equal(r.played + (r.stopped ? 0 : 0) >= 1, true);
    assert.equal(q.played(), 3, 'background appends are played: ' + q.played());
});

test('queue: onSource fires with the item + node (the VOICE-11 visualiser seam)', async () => {
    const seen = [];
    const ctx = fakeCtx();
    const q = new SpeechQueue({ ctx,
        onSource: (item, src) => seen.push([item.seq, !!src.buffer, item.chunk]),
        source: (c, seq) => buf(1) });
    q.push('a'); q.push('b');
    await settle();
    assert.deepEqual(seen, [[0, true, 'a'], [1, true, 'b']]);
    assert.deepEqual(ctx.sources.map(s => s.connectAt),
                     [ctx.destination, ctx.destination], 'routed to the ctx output');
    // an explicit destination (VOICE-11 volume ducking) takes precedence
    const gain = { __gain: true };
    const ctx2 = fakeCtx();
    const q2 = new SpeechQueue({ ctx: ctx2, destination: gain, source: () => buf(1) });
    q2.push('a');
    await settle();
    assert.deepEqual(ctx2.sources.map(s => s.connectAt), [gain],
        'opts.destination wins over ctx.destination');
});

test('queue: no decode seam at all -> the chunk drops with a clear error', async () => {
    // a ctx WITHOUT decodeAudioData: the payload is neither an AudioBuffer
    // nor decodable, so the queue must drop it (after one retry) and drain
    const ctx = fakeCtx({ noDecode: true });
    const q = new SpeechQueue({ ctx, source: () => ({ not: 'audio' }) });
    q.push('a');
    const r = await orTimeout(q.drain(), 2000, 'bad-payload drain');
    assert.equal(r.played, 0);
    assert.match(String(r.dropped[0].error), /decode seam|empty audio/);
    assert.equal(ctx.sources.length, 0, 'nothing is scheduled for a bad payload');
});

/* ---- the module in a browser-shaped sandbox ---------------------------- */

test('index.html loads uplift_speechio.js before its consumers', () => {
    const files = staticFiles();
    const i = files.indexOf('uplift_speechio.js');
    assert.ok(i >= 0, 'registered in index.html');
    assert.ok(i < files.indexOf('uplift.js'), 'before the app monolith');
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    assert.match(html, /<script src="\.\/uplift_speechio\.js"><\/script>/);
});

test('browser shape: window.Uplift.speechio is the same surface node sees', () => {
    const win = {};
    win.window = win; win.self = win;
    const vmCtx = vm.createContext(win);
    new vm.Script(fs.readFileSync(path.join(STATIC_DIR, 'uplift_speechio.js'), 'utf8'))
        .runInContext(vmCtx);
    assert.ok(win.Uplift && win.Uplift.speechio, 'window.Uplift.speechio set');
    for (const k of ['sanitizeSpeechText', 'createSpeechSanitizer',
                     'createSpeechSplitter', 'splitSpeechChunks', 'SpeechQueue',
                     'MODES', 'DEFAULT_FLOOR', 'DEFAULT_CAP'])
        assert.ok(k in win.Uplift.speechio, 'export ' + k);
    assert.equal(typeof win.UpliftSpeechIo, 'object', 'UMD root fallback');
    // with no voices module loaded, the default transport fails LOUDLY
    const q = new win.Uplift.speechio.SpeechQueue({ ctx: fakeCtx() });
    q.push('needs the voices module');
    return orTimeout(q.drain(), 2000, 'no-voices drain').then(r => {
        assert.match(String(r.dropped[0].error), /transport seam/);
    });
});

test('browser shape: the voices transport is used when the module is present', async () => {
    const win = { Uplift: { voices: { speechJson: async (url, body) => {
        win.__req = [url, body];
        return { arrayBuffer: async () => ({ __dur: 3 }) };
    } } } };
    win.window = win; win.self = win;
    const vmCtx = vm.createContext(win);
    new vm.Script(fs.readFileSync(path.join(STATIC_DIR, 'uplift_speechio.js'), 'utf8'))
        .runInContext(vmCtx);
    const ctx = fakeCtx();
    const q = new win.Uplift.speechio.SpeechQueue({ ctx });
    q.push('hello world');
    await settle();
    assert.deepEqual(win.__req, ['/voices/speech', { input: 'hello world' }]);
    assert.deepEqual(ctx.scheduled().map(s => s.buffer.duration), [3]);
});

test('no i18n / user-visible strings in this card', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_speechio.js'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bt\(\s*'/.test(code), 'no t() calls');
    assert.ok(!/data-i18n/.test(code), 'no i18n attributes');
    assert.ok(!/toast\(/.test(code), "the single toast is VOICE-11's");
    assert.ok(!/document\.|\bwindow\.(?!Uplift)/.test(code), 'pure logic: no DOM access');
});
