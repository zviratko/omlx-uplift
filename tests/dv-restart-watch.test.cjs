/* RESTART WATCH (user, 2026-10-25): after Restart / Rebuild-&-restart the board
 * must wait for the server to come back and only then reload — the old code
 * reloaded on a fixed 6 s timer and landed on a dead socket.
 *
 * Why a vm test and not a source grep: the whole feature is a two-phase state
 * machine (down edge -> answered -> reload) driven by a poll. Only driving it
 * shows whether it reloads too early, never, or after the wrong edge. The stub
 * keeps a REAL timer registry so 'the poll stopped when dismissed' is provable,
 * and textContent clears children like the DOM does, so a re-render cannot
 * append a second line.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function makeSandbox(fetchImpl) {
    const timers = { interval: new Map(), timeout: [], next: 1 };
    const mkEl = (tag) => {
        const el = {
            tagName: (tag || 'div').toUpperCase(), children: [], parentNode: null,
            style: {}, dataset: {}, attrs: {}, _text: '', className: '',
            classList: {
                add(c) { el.className = el.className.split(' ').filter(Boolean).concat(c).join(' '); },
                remove(c) { el.className = el.className.split(' ').filter(x => x && x !== c).join(' '); },
                contains: (c) => el.className.split(' ').includes(c),
                toggle() {},
            },
            setAttribute(k, v) { el.attrs[k] = v; },
            getAttribute(k) { return el.attrs[k]; },
            append(...xs) {
                for (const x of xs) {
                    if (typeof x === 'string') { el._text += x; continue; }  // real DOM: text node
                    x.parentNode = el; el.children.push(x);
                }
            },
            remove() {
                const p = el.parentNode; if (!p) return;
                p.children.splice(p.children.indexOf(el), 1); el.parentNode = null;
            },
            querySelector() { return null; }, querySelectorAll() { return []; },
        };
        Object.defineProperty(el, 'textContent', {
            get() { return el._text + el.children.map(c => c.textContent).join(''); },
            set(v) { el._text = String(v); el.children.forEach(c => c.parentNode = null); el.children = []; },
        });
        Object.defineProperty(el, 'hidden', { get() { return el._hidden; }, set(v) { el._hidden = !!v; } });
        return el;
    };
    const byId = {};
    const doc = {
        body: mkEl('body'),
        createElement: mkEl,
        getElementById(id) { return byId[id] || null; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        documentElement: mkEl('html'), hidden: false,
    };
    doc.byId = byId;
    const sb = {
        document: doc, console,
        setInterval(fn, ms) { const id = timers.next++; timers.interval.set(id, fn); return id; },
        clearInterval(id) { timers.interval.delete(id); },
        setTimeout(fn, ms) { timers.timeout.push(fn); return timers.timeout.length; },
        clearTimeout() {},
        Promise, JSON, Math, Date, String, Number, Object, Array, RegExp, Error, Boolean, parseInt, parseFloat, isNaN,
        encodeURIComponent, decodeURIComponent,
    };
    sb.window = sb;
    sb.globalThis = sb;
    sb.window.UpliftCore = {
        tf: (k, fb) => fb, t: (k) => k,
    };
    sb.window.UpliftDom = {
        $: (id) => byId[id] || mkEl('div'),
        toast() {}, emptyMsg() {}, cell: () => mkEl('span'),
        errText: (e) => (e && e.message) || String(e),
        fetchJson: (u) => fetchImpl(u, sb),
        loadScript: () => Promise.resolve(),
        setUnauthorizedHandler() {},
    };
    sb.window.Uplift = { state: { API: '' } };
    sb.__timers = timers;
    sb.location = { reload() { sb.__reloaded = (sb.__reloaded || 0) + 1; } };
    return sb;
}

function mount(sb) {
    const ctx = vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'uplift_devpanel.js'), 'utf8'),
        ctx, { filename: 'uplift_devpanel.js' });
    return sb.window.Uplift.devpanel;
}

const flat = (el, out = []) => { out.push(el); el.children.forEach(c => flat(c, out)); return out; };

test('watcher opens the house dialog with one status line', () => {
    const sb = makeSandbox(() => Promise.resolve({}));
    const DP = mount(sb);
    DP.dvWatchRestart();
    const overlays = sb.document.body.children.filter(e => e.className === 'modal-overlay');
    assert.equal(overlays.length, 1, 'exactly one overlay');
    const box = overlays[0].children[0];
    assert.equal(box.className, 'modal nasa', 'must use the house dialog chrome (ptManage pattern)');
    const all = flat(box);
    assert.ok(all.some(e => e.className === 'icon-btn' && e.textContent === '×'), 'needs the × close');
    const line = all.find(e => e.className === 'pt-rs-line');
    assert.ok(line && /reconnecting/i.test(line.textContent), 'status line missing: ' + line && line.textContent);
    assert.equal(all.filter(e => e.className === 'pt-rs-line').length, 1,
        'the line must be rewritten in place, never appended twice');
});

test('it reloads only after a down edge, never while the server still answers', async () => {
    let phase = 'up';
    const sb = makeSandbox((u) => (phase === 'up'
        ? Promise.resolve({ ok: true })
        : Promise.reject(new TypeError('Failed to fetch'))));
    const DP = mount(sb);
    DP.dvWatchRestart();
    const tick = [...sb.__timers.interval.values()][0];
    await tick();                                     // server still answering
    assert.equal(sb.__reloaded, undefined, 'reloaded while the restart had not even started');
    assert.ok(sb.document.body.children[0], 'dialog still open');

    phase = 'down'; await tick();                     // socket refused
    phase = 'up';   await tick();                     // answered again
    const line = flat(sb.document.body).find(e => e.className === 'pt-rs-line');
    assert.ok(/back/i.test(line.textContent), 'expected the back-online line, got: ' + line.textContent);
    assert.equal(sb.__timers.interval.size, 0, 'poll must stop once the answer is in');
    assert.equal(sb.__timers.timeout.length, 1, 'reload must be deferred by one timer');
    sb.__timers.timeout[0]();                          // fire it
    assert.equal(sb.__reloaded, 1, 'reload did not happen after the server came back');
});

test('an HTTP answer (even 401) counts as alive; dismissal stops the poll', async () => {
    let err = null;
    const sb = makeSandbox(() => {
        if (err) return Promise.reject(err);
        return Promise.resolve({ ok: true });
    });
    const DP = mount(sb);
    DP.dvWatchRestart();
    const tick = [...sb.__timers.interval.values()][0];
    err = Object.assign(new Error('/uplift/api/dev/status -> 401: auth'), { status: 401 });
    await tick();                                     // answered-with-401, no down edge yet
    assert.equal(sb.__reloaded, undefined, 'a 401 with no prior drop must not reload');
    const close = flat(sb.document.body).find(e => e.className === 'icon-btn');
    close.onclick();
    assert.equal(sb.__timers.interval.size, 0, 'dismissing must stop the poll');
    assert.equal(sb.document.body.children.length, 0, 'overlay must be gone after dismissal');
});

test('no blind timed reload survives anywhere in the panel', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_devpanel.js'), 'utf8');
    assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*location\.reload\(\),\s*6000\s*\)/.test(src),
        'the 6-second blind reload is back — the watcher must own this');
    for (const site of ["await dvApi('restart', {});", 'if (restartAfter) dvWatchRestart();'])
        assert.ok(src.includes(site), `lost a wiring site: ${site}`);
    assert.ok(!/(?<![.\w$])fetch\s*\(/.test(src), 'raw fetch in the panel — use the kit (FE-2)');
});
