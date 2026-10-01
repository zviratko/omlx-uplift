/* SPARK-3: skin hover preview must stay EPHEMERAL.

   The preview path may only change the live look. If it ever writes the
   pre-paint cache key ('omlx-uplift-skin-dir'), touches prefs/localStorage,
   or pushes into .embed-frame documents, a skin the user never commits
   survives a reload (or re-themes the bench/chat iframes on every pointer
   sweep) — the exact failure modes the ticket lists as pitfalls. Static
   invariants are cheap to pin, so they are pinned against the source region
   between the preview markers.  node --test tests/skin-hover-preview.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');
const MARK = src.indexOf('SPARK-3 — try-before-you-buy');
// start at the OPENING of the marker comment, not inside it: an unopened /*
// makes the comment stripper leave the rationale text in the "code" pool,
// and the rationale names the very calls this test forbids.
const START = MARK > 0 ? src.lastIndexOf('/*', MARK) : -1;
const END = src.indexOf('function applySkinCss');
assert.ok(START >= 0 && END > START,
    'preview region must sit between its marker and applySkinCss (moved — update test)');
const region = src.slice(START, END);
// strip comments: the marker text and rationale describe the very things we forbid
const code = region.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('preview path never writes localStorage', () => {
    const writes = [...code.matchAll(/localStorage\s*\.\s*(setItem|removeItem|clear)/g)]
        .map(m => m[0]);
    assert.deepEqual(writes, [],
        'the pre-paint skin-dir cache belongs to the COMMIT path only');
});

test('preview path never mutates prefs', () => {
    const writes = [...code.matchAll(/\bprefs\s*\.\s*\w+\s*=[^=]/g)].map(m => m[0]);
    assert.deepEqual(writes, [], 'prefs.theme is the single source of truth for committed');
    assert.ok(!/savePrefs\s*\(/.test(code), 'preview must not save prefs');
});

test('preview does not re-theme iframes', () => {
    assert.ok(!/syncEmbedTheme\s*\(/.test(code),
        'iframe theme push stays commit-only (jarring + heavy on hover)');
    assert.ok(!/embed-frame/.test(code), 'preview must not touch .embed-frame');
});

test('preview reuses the existing apply path, adds no second theme listener', () => {
    assert.match(code, /applySkinCss\(dir\)/, 'preview must drive the ONE skin link');
    assert.match(code, /CH\.rerenderChartsTheme\(\)/,
        'charts re-tint through the single existing path');
    assert.ok(!/addEventListener\(\s*['"](change|prefers-color-scheme)['"]/.test(code));
    assert.ok(!/new uPlot\(/.test(code), 'preview must not build its own plots');
});

test('hover is debounced and re-tints only on a real dir change', () => {
    assert.match(src, /const PREVIEW_DEBOUNCE_MS\s*=\s*150\b/,
        'a sweep down the list must not rebuild every uPlot per row');
    assert.match(code, /dir === previewDir\)[\s\S]{0,80}return/,
        'same dir twice must be a no-op');
});

test('touch is excluded from preview (tap still commits, unchanged)', () => {
    assert.match(code, /pointerType[\s\S]{0,80}mouse/,
        'pointerover must gate on pointerType so a tap does not preview-flash');
});

test('restore fires when the menu closes without a commit', () => {
    assert.match(code, /attributeFilter:\s*\[\s*'hidden'\s*\]/,
        'menu hidden by ANY caller (commit, leave timer, click-outside) must restore');
    assert.match(code, /function previewEnd[\s\S]*?applyPrefs\(\)/,
        'restore goes through applyPrefs() so classic-iframe state re-resolves');
});

test('keyboard focus previews too (a11y parity with hover)', () => {
    assert.match(code, /addEventListener\(\s*'focusin'/);
});

/* ---------------- behaviour: drive the REAL preview functions ----------
   The static guards above say what the code must not do; this says what it
   must do. The region between the marker and applySkinCss is self-contained
   apart from named seams (skinLookup, applySkinCss, applyPrefs, CH, $,
   prefs, API, document), all stubbed here — so the logic under test is the
   shipped logic, not a re-implementation. */
const SKINS = {
    nerv: { dir: 'nerv-1700000001', name: 'nerv' },
    lain: { dir: 'lain-1700000002', name: 'lain' },
    shodan: { dir: 'shodan-1700000003', name: 'shodan' },
};
function makeEl(id) {
    const listeners = {};
    return {
        id, hidden: true, dataset: {}, _l: listeners,
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener() {},
        closest() { return null; },
        querySelectorAll() { return []; },
        getAttribute() { return null; },
        setAttribute() {},
        fire(t, ev) { (listeners[t] || []).forEach(fn => fn(ev)); },
    };
}
function harness(committed) {
    const menu = makeEl('dd-theme-menu');
    const link = makeEl('uplift-skin-css');
    const storage = { writes: 0, get item() { return this._v || null; },
        setItem() { this.writes++; }, removeItem() { this.writes++; } };
    const calls = { skinCss: [], rerender: 0, applyPrefs: 0, embed: 0 };
    const htmlEl = { dataset: {} };
    const doc = {
        documentElement: htmlEl,
        getElementById: id => (id === 'dd-theme-menu' ? menu : id === 'uplift-skin-css' ? link : null),
        addEventListener() {},
        querySelectorAll() { return []; },
    };
    const ctx = {
        setTimeout, clearTimeout, console,
        MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} },
        document: doc,
        API: '',
        prefs: { theme: committed },
        CH: { rerenderChartsTheme() { calls.rerender++; } },
        skinLookup(sel) { return SKINS[sel] || null; },
        applySkinCss(dir) { calls.skinCss.push(dir || null);
            link.getAttribute = () => `/uplift/api/skins/${dir}/theme.css`;
            link.sheet = dir ? {} : null; },
        applyPrefs() { calls.applyPrefs++;
            const s = SKINS[ctx.prefs.theme];
            htmlEl.dataset.theme = s ? s.dir : ctx.prefs.theme; },
        syncEmbedTheme() { calls.embed++; },
        localStorage: storage,
        $: id => doc.getElementById(id),
    };
    const script = region + `
this.previewHover = previewHover; this.previewShow = previewShow;
this.previewEnd = previewEnd; this.previewCommit = previewCommit;
this.previewPeek = () => previewDir;`;
    // comments would trip the vm only as text; keep them, they are valid JS
    vm.runInNewContext(script, vm.createContext(ctx));
    return { ctx, menu, link, storage, calls, htmlEl };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('hover previews a skin; leave restores the committed one', async () => {
    const h = harness('nerv');
    h.htmlEl.dataset.theme = 'nerv-1700000001';
    h.ctx.previewHover('lain');
    assert.equal(h.ctx.previewPeek(), null, 'nothing may change before the debounce');
    assert.equal(h.calls.rerender, 0, 'debounce: no rebuild yet');
    await sleep(220);
    assert.equal(h.htmlEl.dataset.theme, 'lain-1700000002', 'board took the hovered skin');
    assert.deepEqual(h.calls.skinCss, ['lain-1700000002']);
    assert.ok(h.calls.rerender >= 1, 'charts re-tinted for the preview');
    assert.equal(h.storage.writes, 0, 'PREVIEW WROTE STORAGE');
    assert.equal(h.ctx.prefs.theme, 'nerv', 'prefs.theme must stay committed');
    assert.equal(h.calls.embed, 0, 'iframes must not follow a hover');
    h.ctx.previewEnd();
    assert.equal(h.calls.applyPrefs, 1, 'restore goes through applyPrefs()');
    assert.equal(h.htmlEl.dataset.theme, 'nerv-1700000001', 'committed look returned');
    assert.equal(h.storage.writes, 0, 'RESTORE WROTE STORAGE');
});

test('sweeping the pointer down the list rebuilds once, not per row', async () => {
    const h = harness('nerv');
    h.ctx.previewHover('lain');
    h.ctx.previewHover('shodan');
    h.ctx.previewHover('lain');
    await sleep(220);
    assert.equal(h.calls.skinCss.length, 1,
        `one rebuild expected, got ${JSON.stringify(h.calls.skinCss)}`);
    assert.equal(h.htmlEl.dataset.theme, 'lain-1700000002', 'last hovered row wins');
});

test('hovering the committed entry ends an active preview', async () => {
    const h = harness('nerv');
    h.htmlEl.dataset.theme = 'nerv-1700000001';
    h.ctx.previewShow('lain');
    assert.equal(h.htmlEl.dataset.theme, 'lain-1700000002');
    h.ctx.previewShow('nerv');            // pointed back at the committed one
    assert.equal(h.htmlEl.dataset.theme, 'nerv-1700000001', 'restored');
});

test('built-in theme names are never previewed', async () => {
    const h = harness('nerv');
    h.ctx.previewShow('light');           // skinLookup returns null for these
    await sleep(220);
    assert.equal(h.calls.skinCss.length, 0, 'a built-in must not drive the skin link');
    assert.equal(h.storage.writes, 0);
});

test('a commit suppresses the restore (no double rebuild)', async () => {
    const h = harness('nerv');
    h.htmlEl.dataset.theme = 'nerv-1700000001';
    h.ctx.previewShow('lain');
    h.ctx.previewCommit();
    h.ctx.prefs.theme = 'lain';           // what the click handler does
    h.ctx.applyPrefs();
    const before = h.calls.applyPrefs;
    h.ctx.previewEnd();
    assert.equal(h.calls.applyPrefs, before,
        'committed already equals the preview: restore must be a no-op');
    assert.equal(h.storage.writes, 0);
});
