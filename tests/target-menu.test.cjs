/* TARGET menu (Patches / DEV, uplift_devpanel.js) — regression 2026-10-21
   (user: "selecting dev(target) produces a garbled dropdown list — make it
   clear and visible, limit the lines or something"). Root cause proven from
   live CDP: every .pt-target-item carries overflow:hidden, which collapses
   the flexbox automatic-minimum-size to 0 — the 51-row roster SHRANK to
   fit the menu's 60vh box (rows landed at ~10px, text piled over text)
   instead of the menu scrolling.
   Pinned here (vm slice of the module's own functions — ONLY checked-in
   repository source is concatenated, nothing external):
   - the commit list is capped (CAP rows); the rest rides behind ONE
     'show all {n} commits' expander that appends the remaining rows in
     place (no nested dialogs, no second fetch)
   - the roster fetch stays limit=50 (the cap is a RENDER cap)
   - pinned row leads with the check; the pinned commit is not duplicated
     in the log below it
   - close wiring survives the cap (outside click + Escape)
   - CSS: items keep their natural line (flex: 0 0 auto); the menu owns
     the scrolling (max-height + overflow-y) */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = path.join(STATIC_DIR, 'uplift_devpanel.js');
const CAP = 15; // must match dvTargetMenu's CAP

function makeEl(tag) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
        parentNode: null, hidden: false, textContent: '', title: '',
        disabled: false, onclick: null, _classes: new Set(),
        set className(v) {
            this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
        },
        get className() { return [...this._classes].join(' '); },
        append(...kids) {
            kids.forEach(c => {
                if (typeof c !== 'string') { c.parentNode = this; this.children.push(c); }
            });
        },
        remove() {
            if (this.parentNode) {
                const i = this.parentNode.children.indexOf(this);
                if (i >= 0) this.parentNode.children.splice(i, 1);
                this.parentNode = null;
            }
        },
        addEventListener() {}, removeEventListener() {},
        contains(n) {
            let found = false;
            (function w(el) {
                if (el === n) found = true;
                (el.children || []).forEach(w);
            })(this);
            return found;
        },
        getBoundingClientRect() {
            return { x: 10, y: 20, width: 100, height: 24,
                     left: 10, top: 20, right: 110, bottom: 44 };
        },
    };
    el.classList = {
        add(...c) { c.forEach(x => el._classes.add(x)); },
        remove(...c) { c.forEach(x => el._classes.delete(x)); },
        contains(c) { return el._classes.has(c); },
        toggle(c, on) {
            if (on === undefined) on = !el._classes.has(c);
            if (on) el._classes.add(c); else el._classes.delete(c);
            return on;
        },
    };
    return el;
}

function sliceFn(src, name) {
    // brace-walk the VERBATIM function text (the (?:async\s+)? anchor
    // matters: dvLoadCommits is async — cutting the keyword off the
    // slice would leave an await in a sync function and die at compile)
    const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(')
        .exec(src);
    assert.ok(m, 'slice anchor ' + name);
    const i = m.index;
    let depth = 0;
    let j = src.indexOf('{', i);
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(depth === 0, 'balanced slice ' + name);
    return src.slice(i, j + 1);
}

function loadMenu(commits) {
    const src = fs.readFileSync(SRC, 'utf8');
    const doc = {
        body: makeEl('body'),
        createElement: makeEl,
        createTextNode: t => ({ textContent: String(t), children: [],
                                 _classes: new Set(), append() {} }),
        _l: { click: [], keydown: [] },
        addEventListener(type, fn) { if (this._l[type]) this._l[type].push(fn); },
        removeEventListener(type, fn) {
            const a = this._l[type];
            if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
        },
    };
    const st = { toasts: [], posts: [], fetches: [] };
    const body = [
        'const S = { API: "" }; const API = S.API;',
        'const PG = { toast: (...a) => st.toasts.push(a),',
        '  fetchJson: (u) => { st.fetches.push(String(u));',
        '    return Promise.resolve({ commits: COMMITS }); } };',
        'function ptMsg(k, fb) { return fb; }',
        'function dvApi(p, b) { st.posts.push({ p: p, b: b });',
        '  return Promise.resolve({}); }',
        sliceFn(src, 'dvSha'),
        'let DV_MENU = null; let DV_COMMITS = null;',
        sliceFn(src, 'dvCloseMenu'),
        sliceFn(src, 'dvLoadCommits'),
        sliceFn(src, 'dvTargetMenu'),
        'var OPEN = (btn, d) => dvTargetMenu(btn, d);',
    ].join('\n\n');
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise,
        JSON, Math, String, Number, Object, Array, Error, RegExp, Map, Set,
        Boolean, encodeURIComponent, document: doc, innerWidth: 1440,
        innerHeight: 900, st, COMMITS: commits });
    vm.runInContext(body, ctx, { filename: 'target-menu.slice.js' });
    // the slice's top-level `var OPEN` lands on the global object; the
    // host side must reach it THROUGH the context, not by name
    assert.ok(typeof ctx.OPEN === 'function', 'OPEN exported by the slice');
    return { ctx, doc, st, OPEN: (btn, d) => ctx.OPEN(btn, d) };
}

const tick = () => new Promise(r => setTimeout(r, 5));
function findPop(doc) {
    return doc.body.children.find(c => c._classes.has('pt-target-menu'));
}
function items(pop, cls) {
    return pop.children.filter(c => c._classes && c._classes.has(cls));
}

test('target menu: capped list + one honest show-all expander', async () => {
    const commits = [];
    for (let i = 0; i < 40; i++)
        commits.push({ sha: 'c'.repeat(39) + i, short: 'ab' + i,
                       subject: 'commit number ' + i });
    const { OPEN, doc, st } = loadMenu(commits);
    const btn = makeEl('button');
    OPEN(btn, { base: 'f0e3f6a84bd1', base_pin: '' });
    const pop = findPop(doc);
    assert.ok(pop, 'menu appended to body');
    // before the fetch resolves: follow row + loading head, nothing else
    assert.equal(items(pop, 'pt-target-item').length, 1, 'follow row only');
    assert.ok(items(pop, 'pt-target-item')[0].textContent.startsWith('✓'),
              'follow is the active row (no pin)');
    assert.ok(st.fetches.some(u => u.includes('dev/commits?limit=50')),
              'roster fetch keeps limit=50 — the cap is a render cap');
    await tick();
    const listed = items(pop, 'pt-target-item');
    // 1 follow + 15 commit rows + 1 'show all' expander
    assert.equal(listed.length, 17, String(listed.length));
    const more = items(pop, 'pt-target-more');
    assert.equal(more.length, 1);
    assert.ok(more[0].textContent.includes('show all 40 commits'),
              more[0].textContent);
    more[0].onclick();
    assert.equal(items(pop, 'pt-target-item').length, 41,
                 'expander appends the remaining 25 rows in place');
    assert.equal(items(pop, 'pt-target-more').length, 0,
                 'the expander retires itself');
});

test('target menu: pinned row leads with the check, not duplicated below', async () => {
    const commits = [];
    for (let i = 0; i < 20; i++)
        commits.push({ sha: (i === 4 ? 'deadbeefcafe0000' : 'aa' + i),
                       short: 'ab' + i, subject: 'work ' + i });
    const { OPEN, doc } = loadMenu(commits);
    const btn = makeEl('button');
    OPEN(btn, { base: 'f0e3f6a84bd1', base_pin: 'deadbeefcafe0000' });
    await tick();
    const pop = findPop(doc);
    const listed = items(pop, 'pt-target-item');
    // follow + pinned + 15 log rows + expander (19 rest - 15 shown = 4)
    assert.equal(listed.length, 18, String(listed.length));
    assert.ok(listed[0].textContent.startsWith('follow upstream HEAD'),
              'pinned -> follow row is NOT checked');
    assert.ok(listed[1].textContent.includes('pinned commit') &&
              listed[1].textContent.startsWith('✓'), listed[1].textContent);
    const logTexts = listed.slice(2).map(n => n.textContent);
    assert.ok(!logTexts.some(t => t.includes('ab4 —')),
              'the pinned commit is not listed again in the log');
});

test('target menu: close wiring — outside click and Escape both dismiss', async () => {
    const { OPEN, doc } = loadMenu([{ sha: 'x1', short: 'x1', subject: 'one' }]);
    const btn = makeEl('button');
    OPEN(btn, { base: 'f0e3f6a84bd1', base_pin: '' });
    await tick();
    assert.ok(doc._l.click.length, 'dismiss listener armed after setTimeout(0)');
    assert.ok(doc._l.keydown.length, 'escape listener armed');
    const pop = findPop(doc);
    const out = doc._l.click[0];
    // click INSIDE the pop: stays open
    out({ target: pop.children[0] });
    assert.ok(findPop(doc), 'inside click does not close');
    // click outside: closes
    out({ target: doc.createElement('elsewhere') });
    assert.ok(!findPop(doc), 'outside click closes');
    // Escape closes too (re-open, then press Escape)
    OPEN(btn, { base: 'f0e3f6a84bd1', base_pin: '' });
    await tick();
    assert.ok(findPop(doc));
    const esc = doc._l.keydown[doc._l.keydown.length - 1];
    esc({ key: 'Escape' });
    assert.ok(!findPop(doc), 'Escape closes');
});

test('CSS gate: menu items keep their line; the menu owns the scroll', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const item = css.slice(css.indexOf('.pt-target-item {'),
                            css.indexOf('.pt-target-item:hover'));
    assert.ok(/flex:\s*0 0 auto/.test(item),
              'items must not shrink below their content (garbled wall fix)');
    assert.ok(/white-space:\s*nowrap/.test(item) &&
              /text-overflow:\s*ellipsis/.test(item),
              'long rows stay ONE ellipsized line');
    const menu = css.slice(css.indexOf('.pt-target-menu {'),
                           css.indexOf('.pt-target-item {'));
    assert.ok(/max-height:\s*60vh/.test(menu) &&
              /overflow-y:\s*auto/.test(menu),
              'the container clips and scrolls, never the rows');
    assert.ok(/\.pt-target-more\s*\{/.test(css), 'expander is styled');
});
