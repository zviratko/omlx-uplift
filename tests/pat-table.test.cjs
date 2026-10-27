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

test('auto-update checkbox and check-for-updates button are GONE from chrome', () => {
    // ROUND 2 (user 2026-10-27): both controls left the card chrome — the
    // checkbox set the server-wide background check (config.auto_update_check
    // stays a server/CLI setting) and the check action moved into the table
    // header. Negative pins keep the dead shapes dead.
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    assert.ok(!html.includes('pt-auto-check'),
        'the auto-update checkbox must not come back');
    assert.ok(!html.includes('pt-head-auto'),
        'the header auto-label CSS hook must not come back');
    assert.ok(!/<button[^>]*class="btn"[^>]*id="pt-check-btn"/.test(html),
        'Check-for-updates lives under the ORIGIN column, not as a toolbar btn');
    for (const loc of ['en', 'cs', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW']) {
        const d = JSON.parse(fs.readFileSync(
            path.join(STATIC_DIR, '..', 'locales', `${loc}.json`), 'utf8'));
        assert.ok(!('uplift.patches.auto_check' in d),
            `${loc} still carries the deleted auto_check key`);
        assert.ok(!('uplift.patches.col_manage' in d),
            `${loc} still carries the deleted col_manage key`);
    }
});

/* PAT-TABLE round 4 (user 2026-10-25): the ADD PATCH card moved OUT of the
 * stack below the table and INTO the toolbar, so the way a patch arrives
 * (pull from origin / add one) sits above the list. Pinned by document
 * order — the ids are wired by getElementById, so nothing else would notice
 * if it slid back down.
 *
 * ROUND 2 (user 2026-10-27): the toolbar lost the check-for-updates button
 * too (it lives under the ORIGIN column now) — the ADD PATCH card is the
 * toolbar's only occupant.
 */
test('ADD PATCH card sits in the toolbar, above the patch list', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const tb = /<div class="pt-toolbar">([\s\S]*?)<\/div>\s*<!--/
        .exec(html) || /<div class="pt-toolbar">([\s\S]*?)(<div class="pt-table")/.exec(html);
    assert.ok(tb, 'no .pt-toolbar block found');
    const tbHtml = tb[1].replace(/<!--[\s\S]*?-->/g, '');   // prose may name ids
    assert.ok(!tbHtml.includes('pt-check-btn'),
        'check-for-updates belongs under the ORIGIN header, not the toolbar');
    assert.ok(!tbHtml.includes('pt-auto-check'),
        'the removed auto-update checkbox must not return to the toolbar');
    assert.ok(tbHtml.includes('class="pt-addform"'),
        'the ADD PATCH card is not inside the toolbar (it belongs above the list)');
    assert.ok(html.indexOf('class="pt-addform"') < html.indexOf('<div class="pt-table">'),
        'the card must sit before the table in the document');
});

test('table header carries the sub-actions, help marks, and no MANAGE title', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const head = /<div class="pt-row pt-thead">([\s\S]*?)<\/div>\s*<div id="pt-list"/.exec(html);
    assert.ok(head, 'the table header row shape changed (pt-thead -> pt-list)');
    const th = head[1];
    // the two actions live in their own column, on a second line
    assert.ok(th.includes('id="pt-check-btn"') && th.includes('pt-c-origin'),
        'check-for-updates must sit under ORIGIN');
    assert.ok(th.indexOf('pt-c-origin') < th.indexOf('id="pt-check-btn"')
        && th.indexOf('id="pt-check-btn"') < th.indexOf('pt-c-status'),
        'the check link lives INSIDE the ORIGIN cell');
    assert.ok(th.includes('id="pt-auto-all"') && th.includes('pt-c-auto'),
        'the (all) toggle must sit under AUTO-UPDATE');
    // help marks: real buttons wired by wirePtHeadHelp — hover opens the
    // pop, click pins it. The text is the catalog entry for data-help-key;
    // data-en-help carries the English literal as fallback and MUST equal
    // en.json (drift pin below). No native title attribute: with the pop
    // wired, a leftover title would double up as a slow browser tooltip.
    const enHelp = {
        'pt-help-dev': ['uplift.patches.col_dev_help',
            'Checked patches are compiled into the omlx-dev app — '
            + 'they take effect at the next Build.'],
        'pt-help-vanilla': ['uplift.patches.col_vanilla_help',
            'Checked patches are applied to the code the server runs — '
            + 'they take effect at the next server restart.'],
    };
    const enCat = JSON.parse(fs.readFileSync(
        path.join(STATIC_DIR, '..', 'locales', 'en.json'), 'utf8'));
    for (const [id, [key, enText]] of Object.entries(enHelp)) {
        const btn = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(th);
        assert.ok(btn, `${id} lost its help button`);
        assert.ok(btn[0].includes(`data-help-key="${key}"`),
            `${id} is not registered with the catalog key`);
        assert.ok(btn[0].includes(`data-en-help="${enText.replace(/"/g, '&quot;')}"`)
            || th.includes(`data-en-help="${enText}"`),
            `${id} English fallback drifted from the ask`);
        assert.ok(!btn[0].includes('title='),
            `${id} must not carry a native title next to the help pop`);
        assert.equal(enCat[key], enText, `en.json drifted from ${id} fallback`);
    }
    // the MANAGE heading is dropped; the grid track stays (buttons align)
    assert.match(th, /<span class="pt-c-manage"><\/span>/,
        'pt-c-manage must stay as an EMPTY track — the column is unlabeled');
    // the card header is plain again
    const h2 = /<h2><span data-i18n="uplift\.patches\.title">[\s\S]*?<\/h2>/.exec(html);
    assert.ok(h2 && !h2[0].includes('pt-auto-check') && !h2[0].includes('checkbox'),
        'the Patches header must carry only title + counts');
    // locale self-pin: the header keys are data-i18n literals (test_locale_sync
    // sees the first), but the toast strings are dynamic — cover all of them.
    // ROUND 4 (user 2026-10-27): the 'all' LABEL is gone — the AUTO-UPDATE
    // second line is a checkbox — so 'auto_all' dropped from the catalog;
    // negative-pinned below that it never comes back as a label.
    const keys = ['auto_all_title', 'auto_all_on', 'auto_all_off',
        'auto_all_failed', 'auto_all_all', 'check_now_title',
        'col_dev_help', 'col_vanilla_help'];
    const en = JSON.parse(fs.readFileSync(
        path.join(STATIC_DIR, '..', 'locales', 'en.json'), 'utf8'));
    for (const k of keys) assert.ok(en['uplift.patches.' + k], `en lost ${k}`);
    for (const loc of ['cs', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW']) {
        const d = JSON.parse(fs.readFileSync(
            path.join(STATIC_DIR, '..', 'locales', `${loc}.json`), 'utf8'));
        for (const k of keys) {
            const key = 'uplift.patches.' + k;
            assert.ok(d[key], `${loc} lost ${key}`);
            assert.notEqual(d[key], en[key], `${loc}:${key} still English`);
        }
    }
});

/* PAT-TABLE round 3 (user 2026-10-27): the header "?" must DO something —
   hover opens a small explanation pop under the column, click pins it,
   Escape / any other click closes. The old dotted <sup> with a native
   title was invisible as an action ("does nothing on neither hover or
   click"). And the ADD PATCH box spreads over the full line above the
   table instead of hiding in a 560px box that wrapped its own fields. */
test('help marks are wired pop buttons, not dead tooltips', () => {
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    assert.match(js, /function wirePtHeadHelp/, 'pop wiring lost');
    assert.match(js, /initPatchesPage\(\)[\s\S]*wirePtHeadHelp\(\)/,
        'initPatchesPage must wire the help buttons');
    assert.match(js, /D\.helpPop/, 'wiring must use the shared domkit pop');
    assert.match(js, /'mouseenter'[\s\S]*HP\.open\(btn, opts\(false\)\)/,
        'hover-open lost');
    assert.match(js, /'click'[\s\S]*HP\.open\(btn, opts\(true\)\)/,
        'click-pin lost');
    assert.match(js, /HP\.isPinned\(btn\)[\s\S]*HP\.close\(\)/,
        'clicking the same mark again must close the pop');
    // the bubble factory itself lives in domkit: the modal-escape gate
    // forbids this page (it builds .modal-overlay dialogs) from owning any
    // keydown listener, and the kit is where a shared tooltip belongs
    assert.ok(!/addEventListener\('keydown'/.test(js),
        'uplift_patches.js must stay keydown-free (modal-escape pin)');
    const kit = fs.readFileSync(path.join(STATIC_DIR, 'domkit.js'), 'utf8');
    assert.match(kit, /function hpKey\(ev\) \{ if \(ev\.key === 'Escape'\)/,
        'Escape-close lost from the kit (named fn keeps it off the dialog gate)');
    assert.match(kit, /document\.addEventListener\('keydown', hpKey\)/,
        'kit must arm the Escape listener when a pop pins');
    assert.match(kit, /document\.addEventListener\('click', hpClose\)/,
        'click-anywhere close lost');
    assert.match(kit, /helpPop: \{ open: hpOpen, close: hpClose/,
        'the pop is not exported from domkit');
    // the pop text is catalog-first with the literal as fallback
    assert.match(js, /ptMsg\(btn\.dataset\.helpKey, btn\.dataset\.enHelp/,
        'pop must read data-help-key through ptMsg with data-en-help fallback');
    // the pop anchors to the header cell, and the cell is its positioning
    // parent — top:100% of the page would paint it over unrelated chrome
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.match(css, /\.pt-help-pop \{ position: absolute/, '.pt-help-pop lost');
    assert.match(css, /\.pt-thead \.pt-c-dev,[\s\S]*?position: relative/,
        'the dev/vanilla/auto header cells must anchor the pop');
    assert.match(css, /\.pt-thead button\.pt-head-help/,
        'the "?" must look like the button it is (round marker, cursor)');
    // a dead native tooltip beside a live pop is the double-paint we removed
    assert.ok(!/data-i18n-title="uplift\.patches\.col_(dev|vanilla)_help"/
        .test(fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8')),
        'the help buttons must not carry data-i18n-title tooltips again');
});

test('ADD PATCH spans one full line above the table (no small box)', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const m = /\.pt-toolbar div\.pt-addform \{([^}]*)\}/.exec(css);
    assert.ok(m, 'the add-form toolbar rule lost');
    assert.match(m[1], /flex: 1 1 100%/,
        'the card must take the full line (round 2 capped it at 460/560px '
        + 'and the fields wrapped into a small box)');
    assert.ok(!/max-width: 5\d\dpx/.test(m[1]), 'the 560px cap must not return');
    // the stretchy fields share the spare width so one row is enough
    assert.match(css, /\.pt-addform #pt-src-url \{ flex: 2\.5 1 160px/,
        'the url field is the main stretcher');
    assert.match(css, /\.pt-addform #pt-src-repo \{ flex: 1 1 110px/,
        'repo must grow too');
    assert.match(css, /\.pt-addform div\.pt-addform-row > \.pt-field:has\(#pt-new-id\)/,
        'the name field wrapper must grow (label+input column)');
});

/* ROUND 4 (user 2026-10-27): 'make the button on the second line consistent
   and larger (like TARGET). Rename TARGET to SELECT SOURCE. Change "all"
   under AUTO-UPDATE to a checkbox (same as the one in the columns)'. */
test('header second line: uniform TARGET-style actions, checkbox for auto-all', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    // the quieter .pt-head-sub muting is DEAD — every sub-action link is one
    // affordance at the header's own size (the .pt-target-link rule)
    assert.ok(!html.includes('pt-head-sub') && !css.includes('.pt-head-sub {'),
        'pt-head-sub muting must not come back — the second line is uniform now');
    assert.match(html, /id="pt-check-btn" class="pt-target-link"/,
        'CHECK FOR UPDATES shares the TARGET affordance');
    // TARGET is renamed SELECT SOURCE: fallback text + every catalog
    assert.match(html, /id="dv-target-btn"[\s\S]{0,300}>SELECT SOURCE<\/button>/,
        'the dev column reads SELECT SOURCE');
    const enCat = JSON.parse(fs.readFileSync(
        path.join(STATIC_DIR, '..', 'locales', 'en.json'), 'utf8'));
    assert.equal(enCat['uplift.patches.dev_target'], 'SELECT SOURCE');
    // 'all' as a LABEL is gone — and it must not return
    assert.ok(!('uplift.patches.auto_all' in enCat),
        'the auto_all label key was retired with the button');
    // AUTO-UPDATE's second line is a real checkbox, house-style like the rows
    assert.match(html, /<input type="checkbox" id="pt-auto-all"/,
        'pt-auto-all is a checkbox now (same control as the per-row AUTO ticks)');
    assert.ok(!/<button[^>]*id="pt-auto-all"/.test(html),
        'the old "all" button must not come back');
    // paint drives the three honest states; click reads the box, and the
    // post-loop re-poll re-lands the truth over any partial failure
    assert.match(js, /allB\.checked = n > 0 && on === n;/);
    assert.match(js, /allB\.indeterminate = on > 0 && on < n;/,
        'mixed auto-states must show as indeterminate, never as unchecked');
    assert.match(js, /\$\('pt-auto-all'\)\.onchange = async \(\) => \{/);
    assert.match(js, /const target = \$\('pt-auto-all'\)\.checked;/);
});

test('ADD PATCH strip: one control height, one caption size (user 2026-10-27)', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    // The global input floor (input:not(…):not(…)…) carries eight :not()
    // clauses; the strip override must MIRROR that weight or the text
    // inputs silently stay 32px tall beside 26px selects and buttons.
    assert.ok(/\.pt-addform div\.pt-addform-row input\[type="text"\](?::not\([^)]*\)){8}/
        .test(css), 'the add-row text-input override lost its :not() chain');
    assert.match(css, /\.pt-addform div\.pt-addform-row select \{ height: 26px/,
        'controls share ONE height (26px) across the strip');
    assert.ok(!/\.pt-addform div\.pt-addform-row input\[type="text"\](?!:not)[, ]/.test(css),
        'the weak selector that lost the cascade must not come back');
    assert.ok(!/label\.pt-auto input\[type="checkbox"\][^{]*\{[^}]*12px/.test(css),
        'strip checkboxes keep the house 18px touch target');
    const f = /\.pt-addform \.pt-field \{([^}]*)\}/.exec(css);
    assert.ok(f && /font-size: 10px/.test(f[1]),
        'field captions ride the strip 10px scale (title/hint/labels)');
});
