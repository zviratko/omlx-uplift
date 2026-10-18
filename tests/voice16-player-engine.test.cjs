/* VOICE-16 player engine proofs (the SpeechQueue playhead): per-chunk item
   states for the row UI, position() arithmetic off the AudioContext clock,
   true pause/resume mid-buffer, replay from cached bytes without a new
   synthesis request, solo (one-chunk) play, and ⟳ reload of a single chunk.
   Pure logic — the module is `require`d directly (UMD tail) against a
   hand-rolled fake AudioContext that records (start, lead) per source, so no
   Web Audio and no server. The gapless/order/fuzz invariants of this same
   engine stay pinned by voice10-speechio.test.cjs (untouched, still green). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const IO = require(path.join(STATIC_DIR, 'uplift_speechio.js'));
const { SpeechQueue } = IO;

const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};
function deferred() {
    const d = {};
    d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
    return d;
}
function orTimeout(p, ms = 2000, label = 'promise') {
    let t;
    return Promise.race([
        p.then(v => { clearTimeout(t); return v; }),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(
            'TIMEOUT waiting for ' + label)), ms); }),
    ]);
}

/* fake Web Audio: sources never end on their own (the test ends them), and
   every start records BOTH the clock time and the in-buffer lead the engine
   asked for — that lead is what makes a resume land at the same millisecond. */
function fakeCtx(o) {
    o = o || {};
    const ctx = {
        currentTime: o.at || 0,
        sources: [],
        createBufferSource() {
            const src = {
                buffer: null, started: null, lead: null, stopCalls: 0,
                disconnects: 0, onended: null, ended: false,
                connect() {}, disconnect() { src.disconnects++; },
                start(t, lead) { src.started = t; src.lead = lead || 0; },
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
        live() { return ctx.sources.filter(s => !s.ended); },
        heard() { return ctx.sources.filter(s => s.started !== null); },
    };
    return ctx;
}
const b = (dur, tag) => ({ duration: dur, tag: tag || 'x', kind: 'AudioBuffer' });

/* queue with a per-chunk byte source that COUNTS its own calls (the
   no-re-synthesis pin) and names each buffer after its chunk */
function rig(durations, extra) {
    extra = extra || {};
    const ctx = extra.ctx || fakeCtx(extra.ctxOpts);
    const calls = [];
    const events = [];
    const src = extra.source || ((chunk, seq) => {
        calls.push(seq);
        const s = extra.defer && extra.defer[seq];
        // (durations past the script default to 2s so a late push stays valid)
        if (s) return s.promise.then((v) => { calls[calls.length - 1] = [seq, v]; return v; });
        return b(durations[seq] == null ? 2 : durations[seq], 'C' + seq);
    });
    const q = new SpeechQueue(Object.assign({
        ctx, source: src,
        onItem: extra.noEvents ? null : ((item, state) =>
            events.push([item.seq, state, item.duration || 0])),
    }, extra.opts));
    return { q, ctx, calls, events };
}
const endAll = async (ctx, q, rounds = 40) => {
    for (let i = 0; i < rounds; i++) {
        ctx.live().forEach(s => s.__end());
        await settle(3);
        if (!q.pending() && !ctx.live().length) break;
    }
};

/* ---- 1. the row ladder: every state a player row paints from ---------- */

test('queue: onItem walks the row ladder and duration lands with playing', async () => {
    const { q, ctx, events } = rig([2]);
    q.push('alpha');
    await settle();
    const states = events.map(e => e[1]);
    assert.deepEqual(states, ['loading', 'ready', 'playing'], states.join('>'));
    const playing = events[events.length - 1];
    assert.equal(playing[0], 0, 'row 0');
    assert.equal(playing[2], 2, 'duration is known when the row starts moving');
    ctx.live().forEach(s => s.__end());
    await settle();
    assert.equal(events[events.length - 1][1], 'played');
    assert.equal(q.itemAt(0).clips, null, 'a settled chunk leaves the clock');
});

test('queue: position() is idle with nothing queued and loading before air', async () => {
    const d0 = deferred();
    const { q } = rig([2], { noEvents: true, defer: { 0: d0 } });
    assert.deepEqual(q.position(), { seq: -1, offset: 0, duration: 0, state: 'idle' });
    q.push('alpha');
    await settle();
    assert.deepEqual(q.position().state, 'loading',
                     'bytes on the way, nothing on air');
    d0.resolve(b(2, 'C0'));
    await settle(6);
    assert.equal(q.position().state, 'playing', 'it reached the clock');
});

/* ---- 2. progress across the gapless seam -------------------------------- */

test('queue: position() reads the live chunk and its offset off the clock', async () => {
    const { q, ctx } = rig([2, 2]);
    q.push('one'); q.push('two');
    await settle();
    assert.equal(ctx.heard().length, 2, 'chunk 2 schedules while chunk 1 plays');
    assert.equal(ctx.heard()[1].started, 2, 'the seam is back-to-back');
    ctx.currentTime = 1;
    let p = q.position();
    assert.deepEqual([p.seq, p.offset, p.duration, p.state], [0, 1, 2, 'playing']);
    ctx.currentTime = 3;
    p = q.position();
    assert.deepEqual([p.seq, p.offset, p.duration], [1, 1, 2], 'second chunk, 1s in');
});

/* ---- 3. pause/resume lands at the same millisecond --------------------- */

test('queue: pause freezes the playhead, resume restarts it mid-buffer', async () => {
    const { q, ctx, calls } = rig([2, 2]);
    q.push('one'); q.push('two');
    await settle();
    ctx.currentTime = 3;                      // 1s into chunk 2
    assert.equal(q.pause(), true, 'pause takes effect on a live chunk');
    assert.equal(q.paused(), true);
    assert.deepEqual([q.position().seq, q.position().offset, q.position().state],
                     [1, 1, 'paused'], 'the position is remembered');
    assert.ok(ctx.live().every(s => s.ended), 'nothing is on the clock');
    // a paused read is NOT a settled one: the turn must not fire its settle path
    let settled = null;
    q.drain().then(r => { settled = r; });
    await settle(6);
    assert.equal(settled, null, 'drain waits out a pause (the mic stays closed)');
    const before = ctx.heard().length;
    ctx.currentTime = 10;
    assert.equal(q.resume(), true);
    await settle();
    const fresh = ctx.heard().slice(before);
    assert.equal(fresh.length, 1, 'only the interrupted chunk is re-scheduled');
    assert.equal(fresh[0].buffer.tag, 'C1', 'resume replays chunk 2, not chunk 1');
    assert.equal(fresh[0].started, 10, 'it starts on the current clock');
    assert.ok(Math.abs(fresh[0].lead - 1) < 1e-9, 'lead = the second already heard');
    assert.equal(calls.length, 2, 'pause/resume never asks the server again');
    ctx.currentTime = 11;
    assert.deepEqual([q.position().seq, q.position().offset], [1, 2],
                     'progress continues from the resume point');
    const done = q.drain();
    await endAll(ctx, q);
    assert.equal((await orTimeout(done, 2000, 'drain after resume')).stopped, false);
});

test('queue: pause holds the in-flight loads for the resume', async () => {
    const d2 = deferred();
    const { q, ctx } = rig([2, 2, 2], { defer: { 2: d2 } });
    q.push('a'); q.push('b'); q.push('c');
    await settle();
    assert.equal(q.pause(), true);
    const before = ctx.heard().length;
    d2.resolve(b(2, 'C2'));                   // the late byte arrives while paused
    await settle(6);
    assert.equal(q.itemAt(2).state, 'ready',
                 'a paused session keeps its loads valid (no token bump)');
    assert.equal(ctx.heard().length, before, 'a paused queue schedules nothing');
    q.resume();
    await settle();
    assert.deepEqual(ctx.heard().slice(before).map(s => s.buffer.tag),
                     ['C0', 'C1', 'C2'],
                     'resume replays from the pause point, in order, once each');
});

/* ---- 4. replay is free -------------------------------------------------- */

test('queue: seek() replays a finished read from cached bytes, in order', async () => {
    const { q, ctx, calls } = rig([2, 2]);
    q.push('one'); q.push('two');
    await endAll(ctx, q);
    assert.equal(calls.length, 2, 'first pass synthesized both chunks');
    ctx.currentTime = 20;
    assert.equal(q.seek(0, 0), true);
    await settle();
    assert.equal(calls.length, 2, 'replay asks the server ZERO times');
    const tags = ctx.heard().map(s => s.buffer.tag);
    assert.deepEqual(tags, ['C0', 'C1', 'C0', 'C1'], 'the whole read replays in order');
    ctx.currentTime = 21;
    assert.deepEqual([q.position().seq, q.position().offset], [0, 1]);
});

test('queue: seek(seq) skips ahead without replaying what came before', async () => {
    const { q, ctx, calls } = rig([2, 2, 2]);
    q.push('a'); q.push('b'); q.push('c');
    await endAll(ctx, q);
    const before = ctx.heard().length;
    ctx.currentTime = 30;
    assert.equal(q.seek(2, 0), true);
    await settle(4);
    const tags = ctx.heard().slice(before).map(s => s.buffer.tag);
    assert.deepEqual(tags, ['C2'], 'only the tail of the read is on the clock');
    assert.equal(calls.length, 3, 'still no new synthesis');
});

/* ---- 5. solo: one row plays, the rest waits ----------------------------- */

test('queue: solo seek plays ONE chunk and settles without dragging the tail', async () => {
    const { q, ctx } = rig([2, 2, 2]);
    q.push('a'); q.push('b'); q.push('c');
    await endAll(ctx, q);
    const before = ctx.heard().length;
    ctx.currentTime = 40;
    assert.equal(q.seek(1, 0, { solo: true }), true);
    const done = q.drain();
    await settle();
    assert.equal(ctx.heard().length - before, 1, 'exactly one chunk on the clock');
    ctx.live().forEach(s => s.__end());
    const res = await orTimeout(done, 2000, 'solo drain');
    assert.equal(res.stopped, false, 'a solo play resolves its own drain');
    assert.equal(q.itemAt(2).state, 'played', 'the tail was not replayed');
    // the solo cap must not outlive the solo play
    q.push('d');
    await settle(3);
    assert.ok(ctx.heard().some(s => s.buffer.tag === 'C3'), 'later chunks still play');
});

/* ---- 6. ⟳ reload one chunk --------------------------------------------- */

test('queue: reload() re-synthesizes ONE chunk in the background', async () => {
    const { q, ctx, calls } = rig([2, 2]);
    q.push('one'); q.push('two');
    await endAll(ctx, q);
    const sources = ctx.heard().length;
    let reloadCalls = 0;
    assert.equal(q.reload(1, () => { reloadCalls++; return b(3, 'NEW1'); }), true);
    await settle(6);
    assert.equal(reloadCalls, 1, 'the forced source ran once');
    assert.equal(q.itemAt(1).state, 'ready', 'fresh bytes land, nothing auto-plays');
    assert.equal(q.itemAt(1).duration, 3, 'the row re-measures its bar');
    assert.equal(ctx.heard().length, sources, 'the playhead was not hijacked');
    assert.equal(calls.length, 2, 'the untouched chunk was not re-requested');
});

test('queue: reload() of the chunk on air restarts it when the audio lands', async () => {
    const d = deferred();
    const { q, ctx } = rig([2]);
    q.push('one');
    await settle();
    assert.equal(q.itemAt(0).state, 'playing', 'it is on the clock');
    const before = ctx.heard().length;
    // ⟳ while it plays: the row goes back to synthesizing, then resumes itself
    assert.equal(q.reload(0, () => d.promise.then(() => b(2, 'NEW'))), true);
    await settle(4);
    assert.equal(q.itemAt(0).state, 'loading', 'air cut, bytes on the way');
    assert.ok(ctx.live().every(s => s.ended), 'the old audio stopped at once');
    d.resolve(b(2, 'x'));
    await settle(8);
    assert.equal(q.itemAt(0).state, 'playing', 'it came back on air by itself');
    const fresh = ctx.heard().slice(before);
    assert.deepEqual(fresh.map(s => s.buffer.tag), ['NEW']);
    assert.equal(fresh[0].lead, 0, 'a re-recorded chunk starts from its top');
});

/* ---- 7. stop() still wins over the playhead ---------------------------- */

test('queue: stop() clears a pause and settles the turn', async () => {
    const { q, ctx } = rig([2, 2]);
    q.push('one'); q.push('two');
    await settle();
    q.pause();
    assert.equal(q.paused(), true);
    const done = q.drain();
    q.stop();
    assert.equal(q.paused(), false, 'stop is not a pause');
    const res = await orTimeout(done, 2000, 'drain after stop');
    assert.equal(res.stopped, true);
    assert.equal(q.resume(), false, 'a dead session cannot resume');
});
