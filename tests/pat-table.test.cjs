/* PAT-TABLE frontend gate (user layout ask 2026-10-19): the merged patch
   table's behavior contract, proven in the fe1 vm harness (no browser):
   - rows paint VANILLA/DEV checkbox state from the SERVER's surfaces map
     (never a client scope guess);
   - a checkbox flip POSTs the PAIR to /patches/targets (so (0,0) can
     disable in one act); a 409 reverts the boxes from the server truth,
     opens the row's details and the approval buttons re-issue the SAME
     pair with approve once|always;
   - MANAGE: version selects POST /patches/pin {target, version|null},
     the AUTO UPDATE box POSTs /patches/auto; update_available gets one
     honest Apply (promote) button;
   - ORIGIN cell shows v + HEAD sha and the '→ vN' candidate arrow;
   - pins are NAMED in the status cell, a tracking row stays clean.

   Harness note: the module concatenates ONLY repository source (core.js,
   domkit.js, uplift_patches.js) through the vm — no external input — so
   this file needs no new-function justification. */
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
        className: '', title: '',
        hidden: false, checked: false, disabled: false,
        value: '', type: '',
        append(...kids) {
            for (const k of kids) {
                if (typeof k === 'string' || k == null) continue; // text nodes
                k.parentNode = this;
                this.children.push(k);
            }
        },
        appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        remove() {
            if (!this.parentNode) return;
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
        },
        focus() {}, blur() {}, setAttribute() {},
        getAttribute() { return null; },
        scrollIntoView() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        oninput: null, onchange: null, onclick: null,
    };
    // REAL clearing semantics: assigning textContent/innerHTML='' must
    // splice children out (a plain property made re-renders APPEND ghost
    // copies — see uplift-static-ui-gate skill)
    const clearKids = () => {
        for (const k of el.children) k.parentNode = null;
        el.children = [];
    };
    let _text = '', _html = '';
    Object.defineProperty(el, 'textContent', {
        get() { return _text; },
        set(v) { _text = String(v); clearKids(); },
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) { _html = String(v); if (v === '') clearKids(); },
    });
    return el;
}
function walk(el, fn) {
    fn(el);
    for (const k of el.children || []) walk(k, fn);
}
function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children) s += ' ' + allText(k);
    return s;
}
function find(el, pred, acc = []) {
    if (pred(el)) acc.push(el);
    for (const k of el.children || []) find(k, pred, acc);
    return acc;
}

function loadModule() {
    const byId = {};
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(t) {
            return { textContent: String(t), children: [], className: '' };
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}, hidden: false,
        documentElement: makeEl('html'),
        body: makeEl('body'),
        activeElement: null,
    };
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
        Error, Number, String, Object, Array, RegExp, Set, Map,
        encodeURIComponent, confirm: () => true,
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
        window.Uplift.state = { API: '', PT_DATA: null, PT_DOCTOR: null, PT_BUSY: false };
        window.Uplift._patchesGlue = { currentTab: () => 'settings',
                                       currentSub: () => 'patches' };`, sandbox);
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8'),
                    sandbox, { filename: 'uplift_patches.js' });
    return sandbox;
}

const basePatch = (over = {}) => Object.assign({
    id: 'demo', state: 'applied', enabled: true, scope: 'omlx',
    source: { kind: 'github_pr', repo: 'a/b', pr: 1 },
    versions: [{ v: 1, source_head_sha: '0123456789abcdef0123456789abcdef' }],
    desired_version: 1, latest_v: 1, applied_v: 1,
    pins: { runtime: null, build: null },
    surfaces: {
        runtime: { checked: true, version: 1, pinned: false },
        build: { checked: false, version: 1, pinned: false },
    },
}, over);
const payload = (patches, extra = {}) => Object.assign(
    { patches, warning: false, kill_switch_active: false,
      config: { auto_update_check: false } }, extra);

/* route: url suffix -> handler(body) -> {status, json}. Records every POST. */
function router(sb, routes) {
    const posts = [];
    sb.fetch = async (url, opts) => {
        const u = String(url);
        const key = Object.keys(routes).find(k => u.endsWith(k));
        if (!key) {
            return { ok: false, status: 404, statusText: 'nf',
                     json: async () => ({}), text: async () => 'nf',
                     clone() { return this; } };
        }
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        posts.push({ url: u, body });
        const out = routes[key](body, posts.length);
        const status = out.status || 200;
        const json = out.json || {};
        return { ok: status < 400, status, statusText: String(status),
                 json: async () => JSON.parse(JSON.stringify(json)),
                 text: async () => JSON.stringify(json),
                 clone() { return this; } };
    };
    return posts;
}

async function boot(sb, patchesPayload) {
    router(sb, {
        '/uplift/api/patches': () => ({ json: patchesPayload }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, skipped_reason: null, n_checked: 1, unexpected: [] } }),
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
}

const list = (sb) => sb.document.getElementById('pt-list');
const entry = (sb, id) => list(sb).children
    .find(c => c.dataset && c.dataset.pid === id);
const boxes = (el) => find(el, e => e.type === 'checkbox');

test('rows paint checkbox state from the server surfaces map', async () => {
    const sb = loadModule();
    await boot(sb, payload([
        basePatch(),
        basePatch({ id: 'baked', scope: 'both', auto_update: true,
            surfaces: { runtime: { checked: true, version: 1, pinned: false },
                        build: { checked: true, version: 1, pinned: false } } }),
    ]));
    const [rt, both] = [entry(sb, 'demo'), entry(sb, 'baked')];
    assert.ok(rt && both, 'one row per patch, both scopes included');
    const [d1, v1, a1] = boxes(rt);   // DEV | VANILLA | AUTO (user 2026-10-20)
    assert.equal(d1.checked, false, 'DEV from surfaces.build.checked');
    assert.equal(v1.checked, true, 'VANILLA from surfaces.runtime.checked');
    assert.equal(a1.checked, false, 'AUTO column from p.auto_update');
    const [d2, , a2] = boxes(both);
    assert.equal(d2.checked, true, 'both-scope row shows DEV checked');
    assert.equal(a2.checked, true, 'AUTO rides the manifest per patch');
});

test('checkbox flip POSTs the pair; success re-polls (instant repaint)', async () => {
    const sb = loadModule();
    let views = 0;
    const p1 = basePatch();
    router(sb, {
        '/uplift/api/patches': () => {
            views++;
            return { json: payload([views > 1
                ? basePatch({ surfaces: {
                    runtime: p1.surfaces.runtime,
                    build: { checked: true, version: 1, pinned: false } },
                    scope: 'both' })
                : p1]) };
        },
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/targets': () => ({ json: { ok: true, scope: 'both' } }),
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const [dev] = boxes(entry(sb, 'demo'));
    dev.checked = true;
    await dev.onchange();
    await new Promise(r => setImmediate(r));
    assert.ok(views >= 2, 'the view was re-read so chips repaint without reload');
    const [dev2] = boxes(entry(sb, 'demo'));
    assert.equal(dev2.checked, true, 'the repaint shows the new server state');
});

test('held 409 reverts boxes, opens details, approvals re-issue the pair', async () => {
    const sb = loadModule();
    const held = basePatch({ requires_approval: ['kernel_source'] });
    const posts = router(sb, {
        '/uplift/api/patches': () => ({ json: payload([held]) }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/targets': (body) => {
            if (!body.approve) {
                return { status: 409,
                         json: { detail: 'safeguards need approval: kernel_source',
                                 requires_approval: ['kernel_source'] } };
            }
            return { json: { ok: true, scope: 'both', approved: ['kernel_source'] } };
        },
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const [dev] = boxes(entry(sb, 'demo'));
    dev.checked = true;
    await dev.onchange();
    await new Promise(r => setImmediate(r));
    // reverted from server truth + details OPEN with the approval buttons
    const e2 = entry(sb, 'demo');
    const [dev2] = boxes(e2);
    assert.equal(dev2.checked, false, 'the box reverted — nothing was written');
    const det = find(e2, el => el.className === 'pt-det')[0];
    assert.equal(det.hidden, false, 'details opened onto the hold');
    const approve = find(det, el => String(el.textContent).includes('Always allow'))[0];
    assert.ok(approve, 'an approval button is in front of the eyes');
    await approve.onclick();
    await new Promise(r => setImmediate(r));
    const t = posts.filter(x => x.url.endsWith('/patches/targets'));
    const last = t[t.length - 1].body;
    assert.equal(last.approve, 'always', 'the SAME pair re-issues with approval');
    assert.equal(last.runtime, true, 'runtime kept checked in the retry');
    assert.equal(last.dev, true, 'dev kept checked in the retry');
});

test('MANAGE: pin select posts {target, version}; latest posts null', async () => {
    const sb = loadModule();
    const p = basePatch({
        versions: [{ v: 1, source_head_sha: 'aa' }, { v: 2, source_head_sha: 'bb' }],
        desired_version: 2, latest_v: 2,
        surfaces: { runtime: { checked: true, version: 2, pinned: false },
                    build: { checked: false, version: 2, pinned: false } },
    });
    const posts = router(sb, {
        '/uplift/api/patches': () => ({ json: payload([p]) }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/pin': (body) => {
            // stateful fake: the reopen must see the saved pin
            p.pins = p.pins || {};
            if (body.version === null) delete p.pins[body.target];
            else p.pins[body.target] = body.version;
            return { json: { ok: true, pins: p.pins } };
        },
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const manage = find(entry(sb, 'demo'),
        el => String(el.textContent).includes('MANAGE'))[0];
    await manage.onclick();
    const overlay = sb.document.body.children
        .filter(c => String(c.className).includes('modal-overlay')).slice(-1)[0];
    assert.ok(overlay, 'MANAGE opens a dialog');
    const sels = find(overlay, el => el.tagName === 'select');
    assert.ok(sels.length >= 2, 'a version select per surface');
    const save = find(overlay,
        el => String(el.textContent).trim() === 'Save')[0];
    assert.ok(save, 'the dialog STAGES — a Save button owns the write');
    assert.equal(save.disabled, true, 'Save starts disabled');
    const before = posts.filter(x => x.url.endsWith('/patches/pin')).length;
    sels[0].value = '1';
    await sels[0].onchange();
    assert.equal(posts.filter(x => x.url.endsWith('/patches/pin')).length,
                 before, 'choosing a version writes NOTHING yet');
    assert.equal(save.disabled, false, 'a draft enables Save');
    await save.onclick();
    const pinPost = posts.filter(x => x.url.endsWith('/patches/pin')).pop().body;
    assert.equal(pinPost.target, 'runtime');
    assert.equal(pinPost.version, 1, 'SAVE writes the drafted pin');
    // reopen FRESH (the save re-rendered the table; the old button is a
    // detached node holding the pre-pin snapshot)
    const manage2 = find(entry(sb, 'demo'),
        el => String(el.textContent).includes('MANAGE'))[0];
    await manage2.onclick();
    const ov2 = sb.document.body.children
        .filter(c => String(c.className).includes('modal-overlay')).slice(-1)[0];
    const s2 = find(ov2, el => el.tagName === 'select')[0];
    assert.equal(s2.value, '1', 'reopen shows the SAVED pin');
    const sv2 = find(ov2, el => String(el.textContent).trim() === 'Save')[0];
    s2.value = '';
    await s2.onchange();
    await sv2.onclick();
    const rel = posts.filter(x => x.url.endsWith('/patches/pin')).pop().body;
    assert.equal(rel.version, null, 'latest releases the pin (null)');
    // escape contract: this file builds the overlay but owns NO keydown
    // listener (the global frontmost-first handler closes it)
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    assert.ok(!/addEventListener\('keydown'/.test(js),
              'no per-dialog Escape listener (modal-escape pin)');
});

test('MANAGE: AUTO UPDATE posts /patches/auto; candidate shows Apply', async () => {
    const sb = loadModule();
    const p = basePatch({ state: 'update_available', latest_v: 3,
        versions: [{ v: 1 }, { v: 2 }, { v: 3 }], desired_version: 2 });
    const posts = router(sb, {
        '/uplift/api/patches': () => ({ json: payload([p]) }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/auto': () => ({ json: { ok: true, auto_update: true } }),
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    // AUTO UPDATE is a ROW column now (the dialog does not own it)
    const autoBox = boxes(entry(sb, 'demo'))[2];
    assert.ok(autoBox, 'the row carries the AUTO checkbox');
    autoBox.checked = true;
    await autoBox.onchange();
    const a = posts.filter(x => x.url.endsWith('/patches/auto')).pop().body;
    assert.equal(a.enabled, true);
    const manage = find(entry(sb, 'demo'),
        el => String(el.textContent).includes('MANAGE'))[0];
    await manage.onclick();
    const overlay = sb.document.body.children
        .filter(c => String(c.className).includes('modal-overlay')).slice(-1)[0];
    assert.ok(!allText(overlay).includes('Auto update'),
              'AUTO left the dialog — no duplicate control');
    assert.match(allText(overlay), /Apply v3 now/,
                 'a waiting candidate keeps one honest Apply button');
});

test('ORIGIN names the source; the version rides the STATUS cell', async () => {
    const sb = loadModule();
    await boot(sb, payload([basePatch({
        source: { kind: 'github_pr', repo: 'jundot/omlx', pr: 1234 },
        versions: [{ v: 1, source_head_sha: '0123456789abcdef0123456789abcdef' }],
        latest_v: 4, desired_version: 1,
    })]));
    const e = entry(sb, 'demo');
    const ocell = find(e, el => el.className === 'pt-c-origin')[0];
    assert.match(allText(ocell), /jundot\/omlx PR#1234/,
                 'ORIGIN cell names WHERE the patch comes from');
    assert.ok(!/v1/.test(allText(ocell)),
              'no version line left in ORIGIN');
    const scell = find(e, el => el.className === 'pt-c-status')[0];
    const ver = find(scell, el => el.className === 'pt-origin')[0];
    assert.ok(ver, 'the version button leads the STATUS cell');
    assert.match(allText(ver), /v1.*→ v4/,
                 'tracked version + waiting candidate in one place');
    assert.match(ver.title, /0123456789ab/, 'HEAD sha readable in the tip');
});

test('Edit source opens a dialog that posts the add endpoint for the id', async () => {
    const sb = loadModule();
    const p = basePatch({
        source: { kind: 'github_pr', repo: 'jundot/omlx', pr: 3764 },
    });
    const posts = router(sb, {
        '/uplift/api/patches': () => ({ json: payload([p]) }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/add': () => ({ json: { ok: true, v: 2 } }),
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const manage = find(entry(sb, 'demo'),
        el => String(el.textContent).includes('MANAGE'))[0];
    await manage.onclick();
    const overlay = sb.document.body.children
        .filter(c => String(c.className).includes('modal-overlay')).slice(-1)[0];
    const edit = find(overlay, el => /Edit source/.test(String(el.textContent)))[0];
    await edit.onclick();
    const ov2 = sb.document.body.children
        .filter(c => String(c.className).includes('modal-overlay')).slice(-1)[0];
    assert.ok(ov2 && ov2 !== overlay, 'EDIT SOURCE opens a real dialog');
    const inputs = find(ov2, el => el.tagName === 'input');
    assert.ok(inputs.some(i => String(i.value) === 'jundot/omlx')
              && inputs.some(i => String(i.value) === '3764'),
              'prefilled with the CURRENT source — visible, not below the fold');
    const go = find(ov2, el => /Fetch & store/.test(String(el.textContent)))[0];
    assert.ok(go, 'one clear action');
    await go.onclick();
    await new Promise(r => setImmediate(r));
    const add = posts.filter(x => x.url.endsWith('/patches/add')).pop();
    assert.ok(add, 'Fetch & store posts the SAME add endpoint the gate lives on');
    assert.equal(add.body.id, 'demo');
    assert.equal(add.body.kind, 'github_pr');
    assert.equal(add.body.pr, 3764);
    assert.equal(add.body.scope, undefined,
                 'scope is fixed per patch — the update never resends it');
    assert.ok(!sb.document.body.children.some(
        c => String(c.className).includes('modal-overlay')),
        'dialog closes after the store');
});

test('status stays clean while tracking latest; pins are NAMED', async () => {
    const sb = loadModule();
    const pin = basePatch({
        id: 'held',
        pins: { runtime: null, build: 1 },
        surfaces: { runtime: { checked: true, version: 2, pinned: false },
                    build: { checked: true, version: 1, pinned: true } },
    });
    await boot(sb, payload([basePatch(), pin]));
    const clean = allText(entry(sb, 'demo'));
    assert.ok(!/pinned/i.test(clean), 'a latest-tracking row carries no pin note');
    assert.match(clean, /APPLIED/);
    const t = allText(entry(sb, 'held'));
    assert.match(t, /DEV v1 pinned/, 'the pinned surface is named, version and all');
    assert.ok(!/VANILLA v\d pinned/.test(t),
              'only the pinned surface is annotated');
});

test('unchecking both boxes posts the disabling (false,false) pair', async () => {
    const sb = loadModule();
    const posts = router(sb, {
        '/uplift/api/patches': () => ({ json: payload([basePatch()]) }),
        '/uplift/api/patches/curated/sync': () => ({ json: { report: {}, notes: [] } }),
        '/uplift/api/doctor': () => ({ json: { ok: true, unexpected: [] } }),
        '/uplift/api/patches/targets': () => ({ json: { ok: true, scope: 'omlx' } }),
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const [, van] = boxes(entry(sb, 'demo'));   // DEV | VANILLA | AUTO
    van.checked = false;
    await van.onchange();
    const t = posts.filter(x => x.url.endsWith('/patches/targets')).pop().body;
    assert.deepEqual({ runtime: t.runtime, dev: t.dev },
                     { runtime: false, dev: false },
                     '(0,0) disables in ONE act');
});

/* PAT-TABLE round 4 (user, 2026-10-25): PATCH and ORIGIN exchanged places —
 * the patch name is what he scans the table for, origin is supporting detail.
 * Three files had to move together (header markup, cell append order, grid
 * tracks) or the columns misalign against their headers, so the ORDER is
 * pinned, not just presence. Plus the renamed opt-in: the label said 'Check for
 * updates automatically' while the hourly check also promotes new versions
 * ('auto-applied vN — takes effect at the next restart/build'), so it now says
 * what it does; the English literal must equal the catalog value or a late
 * catalog load repaints a different sentence.
 */
test('column order: PATCH precedes ORIGIN in header, cells and tracks', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

    const head = /<div class="pt-row pt-thead">([\s\S]*?)<\/div>\s*<!--|<div class="pt-row pt-thead">([\s\S]*?)pt-c-status/.exec(html);
    const headTxt = head ? head[0] : html;
    assert.ok(headTxt.indexOf('pt-c-patch') > -1 && headTxt.indexOf('pt-c-origin') > -1,
        'the thead lost one of the two column labels');
    assert.ok(headTxt.indexOf('pt-c-patch') < headTxt.indexOf('pt-c-origin'),
        'header must read PATCH then ORIGIN');

    const aP = js.indexOf('row.append(pcell)'), aO = js.indexOf('row.append(ocell)');
    assert.ok(aP > 0 && aO > 0, 'a cell append disappeared — rows would drop a column');
    assert.ok(aP < aO, 'row cells must be appended PATCH then ORIGIN to match the header');

    const t = /\.pt-row\s*\{[\s\S]*?grid-template-columns:([^;]*);/.exec(css);
    assert.ok(t, 'no .pt-row grid template found');
    // a track is `minmax(a, b)` (which contains a comma+space!) or a bare
    // length/fraction — a naive whitespace split tears minmax() in half
    const tracks = t[1].replace(/\s+/g, ' ').match(/minmax\([^)]*\)|[^\s]+/g) || [];
    assert.ok(tracks.length >= 9, `expected 9 tracks, parsed ${tracks.length}: ${tracks}`);
    assert.ok(tracks[1].startsWith('minmax(170px'),
        `track 2 should be PATCH's capped column, got ${tracks[1]}`);
    assert.ok(tracks[2].startsWith('minmax(240px') && tracks[2].includes('2.4fr'),
        `track 3 should be ORIGIN's wide column, got ${tracks[2]}`);
});

test('patch auto-update label: says what it does, catalog agrees', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const m = /data-i18n="uplift\.patches\.auto_check">([^<]*)</.exec(html);
    assert.ok(m, 'the auto_check label lost its data-i18n registration');
    const en = JSON.parse(fs.readFileSync(
        path.join(STATIC_DIR, '..', 'locales', 'en.json'), 'utf8'));
    assert.equal(m[1].trim(), en['uplift.patches.auto_check'],
        'index.html literal and en.json drifted — applyI18n repaints this node');
    assert.ok(!/check for updates/i.test(m[1]),
        'this box also promotes updates, not only checks: say so');
    for (const loc of ['cs', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW']) {
        const d = JSON.parse(fs.readFileSync(
            path.join(STATIC_DIR, '..', 'locales', `${loc}.json`), 'utf8'));
        assert.ok(d['uplift.patches.auto_check'], `${loc} lost the label`);
        assert.notEqual(d['uplift.patches.auto_check'], m[1],
            `${loc} still carries the English label`);
    }
});
