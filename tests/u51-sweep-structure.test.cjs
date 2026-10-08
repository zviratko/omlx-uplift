/* U51 (sweep) structural pins through the mount-test harness:
   - task/pack cards are keyboard-operable (role=button, tabindex=0,
     aria-pressed mirrors the .on class) at all three grids (ACC/MTEB/DEC)
   - the /tasks request paints an honest loading line first
   - [hidden] guard: no JS assertion possible (CSS), pinned live instead
   - classic {count} slot filled in the ACC Full option, plain 'Full'
     where no count exists (limit selects)
   The DOM stub has no KeyboardEvent — the keydown wiring is proven in
   the live drill; here we pin attributes + click semantics. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function harness() {
    const byId = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            className: '', textContent: '', title: '', hidden: false,
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '',
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
            removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {},
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            classList: {
                _s: new Set(),
                add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                toggle(c) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; },
                contains(c) { return this._s.has(c); },
            },
            oninput: null, onchange: null, onclick: null,
        };
        return el;
    }
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' }, attrs: {},
                           setAttribute() {}, getAttribute() { return null; } },
    };
    return { byId, document };
}

const TASKS = { tasks: [{ group: 'g', tasks: [{ key: 'mmlu', label: 'MMLU',
    desc: 'd', full_size: 14042, sizes: [30, 50, 100] }] }], valid: ['mmlu'] };

function load() {
    const { byId, document } = harness();
    const win = {
        UpliftCore: { t: (k, fb) => (k === 'acc_bench.config.full_option' ? 'Full ({count})' : (fb || k)) },
        UpliftDom: { fetchJson: async (u) => {
            if (String(u).endsWith('/models')) return { models: [{ id: 'M', engine_type: 'llm' }] };
            if (String(u).endsWith('/bench/accuracy/tasks')) return TASKS;
            if (String(u).endsWith('/bench/embed/tasks'))
                return { env: 'ready', tasks: { STS12: { kind: 'embed', group: 'sts', sizes: 3108, cs: false } } };
            if (String(u).endsWith('/bench/decision/tasks'))
                return { tasks: { 'arc-choice': { kind: 'decision', items: 294, license: 'CC', source: 's' } } };
            if (String(u).endsWith('/results') || String(u).endsWith('/active') || String(u).endsWith('/queue'))
                return { results: [], running: false, queue: [] };
            throw new Error('no net');
        }, postJson: async () => { throw new Error('no net'); }, toast: () => {} },
        Uplift: { state: { API: '' } },
        document, requestAnimationFrame: () => {}, EventSource: undefined,
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8')).runInContext(ctx);
    return { win, byId };
}

function cards(gridEl) {
    const out = [];
    (function walk(n) {
        if (n && n.className === 'acc-task') { out.push(n); return; }
        for (const k of (n && n.children) || []) walk(k);
    })(gridEl);
    return out;
}

test('U51: ACC task cards are keyboard buttons; size-pick selects the card', async () => {
    const { win, byId } = load();
    const ACC = win.UpliftNativeBench._panels.acc;
    ACC.state = { results: [], groups: null, selected: {}, sizes: {} };
    const grid = win.document.getElementById('bench-acc-tasks');
    ACC.loadTasks();                    // paints loading note first
    assert.equal(grid.children.length, 1);
    assert.equal(grid.children[0].textContent, 'Loading benchmarks…',
        'honest loading line while /tasks is in flight');
    await new Promise(r => setTimeout(r, 10));
    const card = cards(grid)[0];
    assert.equal(card.getAttribute('role'), 'button');
    assert.equal(card.getAttribute('tabindex'), '0');
    assert.equal(card.getAttribute('aria-pressed'), 'false');
    const sizeSel = card.children.find(c => c.tagName === 'select');
    // the classic key carries '{count}' INSIDE; the mirror must fill it
    const fullOpt = sizeSel.children.find(o => o.value === '0');
    assert.equal(fullOpt.textContent, 'Full (14,042)');
    sizeSel._ev.change();               // choosing a size picks the task
    assert.equal(card.getAttribute('aria-pressed'), 'true');
    assert.equal(ACC.state.selected.mmlu, true);
});

test('U51: MTEB + DEC pack cards carry the same button semantics', async () => {
    const { win, byId } = load();
    const M = win.UpliftNativeBench;
    M.mount();
    M.showSub('embed');
    await new Promise(r => setTimeout(r, 15));
    const egrid = byId['bench-embed-tasks'];
    const ecard = cards(egrid)[0];
    assert.equal(ecard.getAttribute('role'), 'button');
    ecard._ev.click();
    assert.equal(ecard.getAttribute('aria-pressed'), 'true');
    // global limit select: plain 'Full', no raw {count} leak
    const lim = byId['bench-embed-limit'];
    const full = lim.children.find(o => o.value === '0');
    assert.equal(full.textContent, 'Full');
    M.showSub('decision');
    await new Promise(r => setTimeout(r, 15));
    const dcard = cards(byId['bench-dec-tasks'])[0];
    assert.equal(dcard.getAttribute('role'), 'button');
    assert.equal(dcard.getAttribute('aria-pressed'), 'false');
});
