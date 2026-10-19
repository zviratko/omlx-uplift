/* ACT-SLEEP-1 (behavioral): the request-feed presence + watchdog region of
   uplift_feed.js, sliced VERBATIM from the shipped source and run in a vm
   sandbox (uplift_feed.js cannot boot headless whole: it pulls UpliftDom,
   modelmgr, confetti and the DOM). Sliced span: audienceHere() +
   connectEventStream(), then the focus/blur/sseOpen/feedWatchdog region up
   to pollRequests (the visibilitychange block between them is boot-owned
   and pinned structurally in hang1-focus-slots.test.cjs). Justification
   for the dynamic wrap: the body concatenates ONLY the repository's own
   checked-in source, no external input.
   Proven here: the audience gate incl. the iframe trap, iframe-focus blur
   keeping the slot, real-departure blur releasing it, focus reopen +
   catch-up poll, half-open (silent-OPEN) repair, permanently-CLOSED repair
   (connectEventStream refuses while any ref survives — the watchdog must
   detach first), the 10 s poll throttle (POLL-BATCH-2) inside a faster
   watchdog tick, a healthy stream causing ZERO extra polls, and tick
   frames stamping liveness through to pushServerEvent. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_feed.js'), 'utf8');

function between(from, to) {
    const a = src.indexOf(from), b = src.indexOf(to);
    assert.ok(a >= 0 && b > a, `slice markers (${JSON.stringify(from.slice(0, 30))}: ${a}, ${b})`);
    return src.slice(a, b);
}
// the exact shipped lines the preamble mirrors / the region owns — drift fails loudly
assert.ok(/^let sseSource = null;$/m.test(src), 'shipped `let sseSource` moved');
assert.ok(/^let lastFrameAt = 0;/m.test(src), 'shipped `let lastFrameAt` moved');
assert.ok(/^const SSE_SILENCE_MS = 60_000;$/m.test(src), 'silence budget changed — update harness');
assert.ok(/^let lastPollAt = 0;/m.test(src), 'shipped `let lastPollAt` moved');

const SLICE_A = between('function audienceHere()', '/* SSE-PAUSE-1');
const SLICE_B = between('/* HANG-1 (kept for the request stream)', 'async function pollRequests');
assert.ok(SLICE_A.trimEnd().endsWith('}'), 'slice A terminates at a function close');
assert.ok(SLICE_B.includes('function feedWatchdog'), 'slice B carries the watchdog');
assert.ok(SLICE_B.trimEnd().endsWith('}'), 'slice B terminates at a function close');

function loadFeed({ hidden = false, focused = true, active = 'BODY' } = {}) {
    const env = {
        hidden, focused, polls: [], events: [], created: [], timeouts: [],
        winLis: {}, clock: { t: 1_000_000 },
        doc: {
            get hidden() { return env.hidden; },
            hasFocus: () => env.focused,
            activeElement: { tagName: active },
        },
    };
    class FakeES {
        constructor(url) {
            this.url = url; this.readyState = FakeES.CONNECTING;
            this.closed = false; env.created.push(this);
        }
        close() { this.closed = true; this.readyState = FakeES.CLOSED; }
    }
    FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
    // pollRequests/pushServerEvent live OUTSIDE the sliced span in the real
    // module (poll fn + dispatcher); the harness injects spies by name.
    const code = `
        var pollRequests = () => envHooks.poll();
        var pushServerEvent = (ev) => envHooks.event(ev);
        (() => {
            const API = '';
            let sseSource = null;
            let lastFrameAt = 0;
            ${SLICE_A}
            ${SLICE_B}
            return {
                audienceHere, connectEventStream, feedWatchdog, sseOpen, SSE_SILENCE_MS,
                get sseSource() { return sseSource; },
                get lastFrameAt() { return lastFrameAt; },
            };
        })()`;
    const sandbox = {
        document: env.doc,
        EventSource: FakeES,
        window: { EventSource: FakeES },
        Date: { now: () => env.clock.t },
        JSON,
        envHooks: {
            poll: () => env.polls.push(env.clock.t),
            event: ev => env.events.push(ev),
        },
        addEventListener: (t, fn) => { (env.winLis[t] = env.winLis[t] || []).push(fn); },
        setTimeout: (fn) => { env.timeouts.push(fn); return env.timeouts.length; },
        console,
    };
    vm.createContext(sandbox);
    const api = vm.runInContext(code, sandbox, { filename: 'uplift_feed.slice.js' });
    return {
        api, env, FakeES,
        setHidden: v => { env.hidden = v; },
        setFocused: v => { env.focused = v; },
        setActive: v => { env.doc.activeElement = { tagName: v }; },
        tick: () => env.timeouts.splice(0).forEach(fn => fn()),   // drain deferred blur checks
        advance: ms => { env.clock.t += ms; },
        fire: t => (env.winLis[t] || []).forEach(fn => fn()),
        open: es => { es.readyState = FakeES.OPEN; if (es.onopen) es.onopen(); return es; },
        opened: () => { const es = env.created[env.created.length - 1]; return loadFeed.open(es); },
    };
}
// helper indirection so opened() can reuse open()
loadFeed.open = es => { es.readyState = 1; if (es.onopen) es.onopen(); return es; };

test('audience gate: hidden refused, focus accepted, iframe-focus accepted, bare-unfocused refused', () => {
    let h = loadFeed({ hidden: true });
    h.api.connectEventStream();
    assert.strictEqual(h.env.created.length, 0, 'hidden tab must not connect');

    h = loadFeed({ focused: true });
    h.api.connectEventStream();
    assert.strictEqual(h.env.created.length, 1, 'focused visible tab connects');

    h = loadFeed({ focused: false, active: 'IFRAME' });   // the ACT-SLEEP-1 case
    assert.strictEqual(h.api.audienceHere(), true, 'embed focus = audience');
    h.api.connectEventStream();
    assert.strictEqual(h.env.created.length, 1, 'iframe-focus tab keeps its stream');

    h = loadFeed({ focused: false, active: 'BODY' });     // another app/window owns focus
    assert.strictEqual(h.api.audienceHere(), false, 'visible-but-unattended = no audience');
    h.api.connectEventStream();
    assert.strictEqual(h.env.created.length, 0, 'unattended visible tab still refuses (HANG-1 budget)');
});

test('blur keeps the stream when focus moved into an embed, releases it when the audience left', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream();
    const es = h.open(h.env.created[0]);
    h.setFocused(false); h.setActive('IFRAME');           // exactly the measured Chrome event set
    h.fire('blur'); h.tick();
    assert.strictEqual(es.closed, false, 'iframe-focus blur is NOT a departure');
    assert.strictEqual(h.api.sseOpen(), true, 'stream survives embed focus');

    h.setActive('BODY');                                  // user actually switched away
    h.fire('blur'); h.tick();
    assert.strictEqual(es.closed, true, 'real departure releases the slot');
    assert.strictEqual(h.api.sseOpen(), false, 'source detached');
});

test('focus reopen: reconnects with an audience; unattended focus falls back to the poll', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream(); h.open(h.env.created[0]);   // catch-up poll #0
    h.setActive('BODY'); h.setFocused(false); h.fire('blur'); h.tick();
    assert.strictEqual(h.env.created.length, 1, 'released on departure');
    h.env.polls.length = 0;

    h.setFocused(true);
    h.fire('focus');                                        // user back in the tab
    assert.strictEqual(h.env.created.length, 2, 'focus reopens the stream');
    const es2 = h.env.created[1];
    assert.ok(es2.url.includes('/admin/api/requests/stream'), 'same route');
    assert.strictEqual(h.env.polls.length, 1, 'pre-open catch-up poll covers a slow handshake');
    h.open(es2);
    assert.strictEqual(h.env.polls.length, 2, 'onopen re-catches up (idempotent upserts)');

    h.setActive('BODY'); h.setFocused(false); h.fire('blur'); h.tick();
    h.env.polls.length = 0;
    h.fire('focus');                                        // audience-less focus (defensive)
    assert.ok(h.env.polls.length >= 1, 'unattended focus falls back to pollRequests');
});

test('watchdog repairs a half-open stream: OPEN but silent past the budget -> close, reopen', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream();
    const es = h.open(h.env.created[0]);
    h.advance(h.api.SSE_SILENCE_MS + 1000);      // silence past 3 tick budgets
    assert.strictEqual(h.api.sseOpen(), true, 'browser still believes the link');
    h.api.feedWatchdog();
    assert.strictEqual(es.closed, true, 'silent-OPEN link dropped');
    assert.strictEqual(h.env.created.length, 2, 'watchdog reconnected');
    assert.notStrictEqual(h.env.created[1], es);
    h.open(h.env.created[1]);
    assert.ok(h.api.sseOpen(), 'healthy again');
    assert.ok(h.api.lastFrameAt > 0, 'onopen re-stamped liveness');
});

test('watchdog repairs a permanently CLOSED stream (connect refuses while any ref survives)', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream();
    const es = h.env.created[0];
    es.readyState = 2;                            // EventSource.CLOSED (401/500 internal retry)
    h.api.feedWatchdog();
    assert.strictEqual(h.env.created.length, 2, 'closed source detached, fresh connect made');
    assert.notStrictEqual(h.api.sseSource, es, 'the dead reference is gone');
});

test('watchdog poll throttle: faster ticks do not raise the 10 s fallback cadence', () => {
    const h = loadFeed({ focused: false, active: 'BODY' });   // unattended: connect refused
    h.api.feedWatchdog();                          // poll #1
    h.advance(4000); h.api.feedWatchdog();         //  4 s: no
    h.advance(4000); h.api.feedWatchdog();         //  8 s: no
    assert.strictEqual(h.env.polls.length, 1, 'one poll per 10 s even at 5 s ticks');
    h.advance(3000); h.api.feedWatchdog();         // 11 s: yes
    assert.strictEqual(h.env.polls.length, 2);
});

test('healthy stream: watchdog costs ZERO extra polls and touches nothing', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream();
    const es = h.open(h.env.created[0]);          // 1 catch-up poll
    h.advance(9000); h.api.feedWatchdog();
    h.advance(9000); h.api.feedWatchdog();
    assert.strictEqual(h.env.polls.length, 1, 'the open stream IS the poll — watchdog adds none');
    assert.strictEqual(es.closed, false, 'fresh-within-budget stream survives');
    assert.strictEqual(h.env.created.length, 1, 'no needless reconnect');
});

test('tick frames stamp liveness and dispatch harmlessly through onmessage', () => {
    const h = loadFeed({ focused: true });
    h.api.connectEventStream();
    const es = h.env.created[0];
    es.readyState = 1;
    es.onmessage({ data: JSON.stringify({ type: 'tick' }) });
    assert.strictEqual(h.env.events.length, 1, 'frame reaches the dispatcher (it ignores unknown types)');
    assert.ok(h.api.lastFrameAt > 0, 'tick stamped liveness — the watchdog can tell idle from dead');
});
