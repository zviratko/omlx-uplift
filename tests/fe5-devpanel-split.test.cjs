/* FE-5 seam pins: the omlx-dev panel lives in uplift_devpanel.js and the
   patches page must (a) work when the panel is ABSENT (graceful lazy call)
   and (b) reach it only through window.Uplift.devpanel at call time — no
   top-of-IIFE capture, no leftover dv* internals in uplift_patches.js. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const patches = read('uplift_patches.js');
const devpanel = read('uplift_devpanel.js');

test('dev panel internals no longer live in uplift_patches.js', () => {
    for (const sym of ['DV_DATA', 'DV_POLL', 'DV_CLICK_BUSY', 'DV_BOOT_POLL',
                       'dvApi', 'dvSha', 'dvRenderBase', 'dvStartBuild', 'dvStartBootstrap'])
        assert.ok(!new RegExp('\\b' + sym + '\\b').test(patches),
            `uplift_patches.js still references ${sym}`);
});

test('devpanel owns its state, timers and API helper', () => {
    for (const sym of ['DV_DATA', 'DV_POLL', 'DV_CLICK_BUSY', 'dvApi', 'dvStartBuild', 'renderDev', 'pollDev'])
        assert.ok(new RegExp('\\b' + sym + '\\b').test(devpanel), `devpanel missing ${sym}`);
    assert.match(devpanel, /window\.Uplift\.devpanel\s*=/, 'export seam missing');
});

test('patches page calls the panel lazily through window.Uplift.devpanel', () => {
    // every devpanel touch must be a call-time lookup (const DP = ... or inline),
    // never a top-level const DP = window.Uplift.devpanel capture
    assert.ok(!/^(const|let|var)\s+\w+\s*=\s*window\.Uplift\.devpanel/m.test(patches),
        'uplift_patches.js captures devpanel at IIFE top — load-order roulette');
    assert.match(patches, /window\.Uplift\.devpanel/, 'no late-bound devpanel call found');
});

test('panel absent => patches page still boots (graceful seam, vm)', () => {
    const vm = require('node:vm');
    const mkEl = () => {
        const e = { children: [], classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            style: {}, dataset: {}, hidden: true, textContent: '', innerHTML: '', checked: false,
            append(...c) { this.children.push(...c); }, querySelector: () => mkEl(),
            querySelectorAll: () => [], onclick: null, onchange: null, disabled: false, title: '' };
        return e;
    };
    const sb = {
        document: { getElementById: () => mkEl(), createElement: () => mkEl(),
            addEventListener() {}, body: mkEl(), documentElement: { dataset: {} } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        setTimeout, setInterval: () => 0, clearInterval() {}, console,
    };
    sb.window = { Uplift: { state: { API: '', PT_DATA: null, prefs: {}, PT_BUSY: false } } };
    sb.window.UpliftCore = { tf: (k, fb) => fb, t: k => k };
    sb.window.UpliftDom = { $: () => mkEl(), toast() {}, fetchJson: async () => ({}),
        cell: t => ({ textContent: t }), emptyMsg() {} };
    vm.createContext(sb);
    vm.runInContext(patches, sb);   // loads with NO devpanel in the sandbox
    // initPatchesPage guards the seam: must not throw when devpanel is absent
    vm.runInContext('window.Uplift.patches.initPatchesPage()', sb);
    // and the old accessor resolves to undefined, not a crash
    assert.equal(vm.runInContext('typeof window.Uplift.patches.pollDev', sb), 'undefined');
});
