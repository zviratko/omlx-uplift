/* REPL-1 mount proof (fe1-patches-render harness pattern): the native
   Bench bootstrap really paints into #bench-native — the exact thing the
   first browser probe could not confirm (stale server, not the module).
   vm sandbox + DOM stub, no browser:
   - mount() renders the 4-subtab strip and the throughput panel once
   - labels come through UpliftCore.t (i18n doctrine: no raw key, no
     hardcoded English when a translation exists)
   - showSub('accuracy') swaps in the stub card
   - double mount is a no-op (host keeps its children)

   The stub registers ids on assignment so getElementById('bench-subpanel')
   inside the module returns the very object mount() appended — that
   id-identity is exactly what showSub relies on in a real browser. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function makeHarness() {
    const byId = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            innerHTML: '', checked: false, disabled: false, value: '', type: '',
            _id: '',
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            addEventListener() {}, removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {}, setAttribute() {},
            getAttribute() { return null; },
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            oninput: null, onchange: null, onclick: null,
        };
        return el;
    }
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    return { byId, document, makeEl };
}

function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children) s += ' ' + allText(k);
    return s;
}

const CAT = {   // fake merged catalog: classic + uplift keys, one marker lang
    'bench.heading': 'BENCHHEADING',
    'navbar.dropdown.performance': 'SUBTP',
    'navbar.dropdown.accuracy': 'SUBACC',
    'navbar.dropdown.context': 'SUBCTX',
    'uplift.bench.ane_tune': 'SUBANE',
    'uplift.bench.native_stub': 'STUBNOTE',
    'bench.config.model': 'LBLMODEL',
    'bench.config.run_button': 'BTNRUN',
};

function load() {
    const { byId, document } = makeHarness();
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: { fetchJson: async () => { throw new Error('no net in tests'); },
                     postJson: async () => { throw new Error('no net in tests'); },
                     toast: () => {} },
        Uplift: { state: { API: '' } },
        document,
        requestAnimationFrame: () => {},
        EventSource: undefined,
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8');
    new vm.Script(src).runInContext(ctx);
    return { win, byId };
}

test('mount paints subtabs + throughput form through the catalog', () => {
    const { win, byId } = load();
    assert.ok(win.UpliftNativeBench, 'module global exported on window');
    win.UpliftNativeBench.mount();
    const host = byId['bench-native'];
    assert.ok(host.children.length >= 2, 'strip + panel mounted');
    const text = allText(host);
    for (const marker of ['SUBTP', 'SUBACC', 'SUBCTX', 'SUBANE'])
        assert.ok(text.includes(marker), `subtab label ${marker} rendered`);
    assert.ok(text.includes('BENCHHEADING'), 'heading via C.t, not raw key');
    assert.ok(text.includes('LBLMODEL'), 'model label translated');
    assert.ok(text.includes('BTNRUN'), 'run button translated');
    assert.ok(!text.includes('bench.heading'), 'no raw i18n key leaks to UI');
    assert.ok(win.UpliftNativeBench.isMounted(), 'isMounted flips after mount');
});

test('showSub(accuracy) swaps in the stub card', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('accuracy');
    const text = allText(byId['bench-subpanel']);
    assert.ok(text.includes('SUBACC'), 'stub card title translated');
    assert.ok(text.includes('STUBNOTE'), 'stub note translated');
});

test('second mount is a no-op (no double paint)', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    const first = byId['bench-native'].children.length;
    win.UpliftNativeBench.mount();
    assert.equal(byId['bench-native'].children.length, first);
});
