/* PR-4206 safeguard-flood regression (card render): problems arrive
   GROUPED PER CODE with a paths list, so a 7-file kernel patch renders
   ONE problem line (count + paths + short message), NOT seven copies of
   the same 500-char rebuild hint. The long hint appears at most once per
   card (in its dedicated copy-clipboard row, from kernel_rebuild_hint).
   Dev-scope patches carry only advisories — shown, and with NO approval
   buttons and NO rebuild row. Harness is the fe1 vm sandbox pattern. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function makeEl(tag) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {},
        className: '', textContent: '', title: '', hidden: false,
        innerHTML: '', checked: false, disabled: false, value: '',
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
function texts(el, cls, acc = []) {
    if (el.className && String(el.className).split(' ').includes(cls))
        acc.push(allText(el));
    for (const k of el.children) if (k && k.children) texts(k, cls, acc);
    return acc;
}
function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children || []) s += ' ' + allText(k);
    return s.trim();
}


function loadPatchesModule() {
    const byId = {};
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(t) { return { textContent: String(t) }; },  // rebuild-hint row
        querySelector() { return makeEl('div'); },
        querySelectorAll() { return []; },
        addEventListener() {}, hidden: false,
        documentElement: makeEl('html'),
        body: makeEl('body'),
    };
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
        Error, Number, String, Object, Array, RegExp, Set, Map, encodeURIComponent,
        fetch: async () => { throw new Error('no fetch in test'); },
        document,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['core.js', 'domkit.js']) {
        vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'),
                        sandbox, { filename: f });
    }
    vm.runInContext(`window.Uplift = window.Uplift || {};
        window.Uplift.state = { API: '', PT_DATA: null, PT_BUSY: false };
        window.Uplift._patchesGlue = { currentTab: () => 'settings',
                                       currentSub: () => 'patches' };`, sandbox);
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8'),
                    sandbox, { filename: 'uplift_patches.js' });
    return sandbox;
}

const basePatch = (over = {}) => Object.assign({
    id: 'demo-patch', state: 'applied', enabled: true, scope: 'omlx',
    source: { kind: 'github_pr', repo: 'a/b', pr: 1 },
    versions: [], applied_v: 1,
}, over);

function payload(patches) {
    return { patches, warning: false, kill_switch_active: false,
             config: { auto_update_check: false } };
}

async function runPoll(sandbox, payloadObj) {
    const routes = {
        '/uplift/api/patches': payloadObj,
        '/uplift/api/patches/curated/sync': { report: {}, notes: [] },
        '/uplift/api/dev/status': { installed: false, reason: 'test' },
    };
    sandbox.fetch = async (url) => {
        const key = Object.keys(routes).find(k => String(url).endsWith(k));
        if (!key) return { ok: false, status: 404, statusText: 'nf',
                           json: async () => ({}), text: async () => 'nf',
                           clone() { return this; } };
        const body = routes[key];
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)),
                 clone() { return this; }, text: async () => '' };
    };
    await vm.runInContext('window.Uplift.patches.pollPatches()', sandbox);
    await new Promise(r => setImmediate(r));
}

const kernelPaths = ['a.metal', 'b.metal', 'c.cpp', 'd.h', 'e.h', 'f.h', 'g.txt']
    .map(n => 'omlx/custom_kernels/glm_moe_dsa/csrc/' + n);
const HINT = 'omlx-uplift kernel rebuild <name> --src /path (brew reinstall hint)';
const grouped = {
    problems: [{ code: 'kernel_source', paths: kernelPaths,
                 message: 'touches a bundled custom kernel; rebuild needed' }],
    codes: ['kernel_source'], advisories: [],
};

test('card renders ONE grouped problem line for 7 kernel paths', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch({
        id: 'tq', state: 'pending', enabled: false,
        versions: [{ v: 1, safeguards: grouped }],
        requires_approval: ['kernel_source'], kernel_rebuild_hint: HINT,
    })]));
    const list = sb.document.getElementById('pt-list');
    const cards = list.children.filter(c => (c.className || '').includes('pt-card'));
    assert.equal(cards.length, 1);
    const adv = texts(cards[0], 'pt-advisories');
    assert.equal(adv.length, 1, `one grouped line, got ${adv.length}: ${JSON.stringify(adv)}`);
    assert.match(adv[0], /^⚠ 7 \(/, 'count + path list prefix');
    const hintCount = adv.filter(t => t.includes('brew reinstall')).length
        + texts(cards[0], 'pt-sg-rebuild').filter(t => t.includes('brew reinstall')).length;
    assert.equal(hintCount, 1, 'the long hint appears EXACTLY once per card');
});

test('legacy single-path problem rows still render', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch({
        id: 'old', state: 'pending', enabled: false,
        versions: [{ v: 1, safeguards: {
            problems: [{ code: 'kernel_source', path: 'omlx/custom_kernels/x/fast.py',
                         message: 'legacy row' }],
            codes: ['kernel_source'] } }],   // no 'advisories' key at all
        requires_approval: ['kernel_source'], kernel_rebuild_hint: null,
    })]));
    const cards = sb.document.getElementById('pt-list').children
        .filter(c => (c.className || '').includes('pt-card'));
    const adv = texts(cards[0], 'pt-advisories');
    assert.equal(adv.length, 1);
    assert.match(adv[0], /omlx\/custom_kernels\/x\/fast\.py — legacy row/);
});

test('advisory-only dev card: one line, no approval buttons, no rebuild row', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([]));   // boot the module; dev cards render
    const p = basePatch({            // via patchCard directly (runtimeOnly
        id: 'dev', state: 'pending', enabled: false, scope: 'dev',  // filter hides them)
        versions: [{ v: 1, safeguards: { problems: [], codes: [],
            advisories: [{ code: 'kernel_source', paths: kernelPaths,
                          message: 'native kernel sources — built by the dev rebuild' }] } }],
        requires_approval: [], kernel_rebuild_hint: null,
    });
    const card = vm.runInContext('window.Uplift.patches.patchCard', sb)(
        JSON.parse(JSON.stringify(p)), payload([p]));
    const adv = texts(card, 'pt-advisories');
    assert.equal(adv.length, 1, 'the grouped advisory renders as one line');
    assert.match(adv[0], /dev rebuild/);
    const acts = texts(card, 'pt-acts').join(' ');
    assert.ok(!/Always allow/.test(acts), 'no approval buttons without held codes');
    assert.equal(texts(card, 'pt-sg-rebuild').length, 0,
                 'no keg rebuild-hint row on a dev-carrier card');
});

test('approval action row carries the pt-acts class (flex gap + border rule)', async () => {
    // the add-preview approve row must be a .pt-acts so the CSS gap and
    // the .btn.primary border ring apply — the two buttons used to sit
    // edge-to-edge and read as one button
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.match(css, /\.pt-acts \.btn\.primary \{[^}]*outline/);
    assert.match(css, /\.pt-sg-acts \{[^}]*margin-top/);
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    assert.match(js, /className = 'pt-acts pt-sg-acts'/);
});
