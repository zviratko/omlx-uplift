/* Server Settings layout gates (user report 2026-10-27).
   Three shapes this file owns:
   1. gsLayoutColumns is vm-mounted VERBATIM (sliced out of uplift_gsys.js)
      and driven with measured heights, because the file cannot be loaded
      whole headless (the load1 note in uplift.js says so). Justification for
      running the slice: the body concatenates ONLY the repository's own
      checked-in source, no external input. Two columns max and the balance
      rule are behaviour, not text — a constant grep would pass on a layout
      that still shoves a 1480px box into an already-taller column.
   2. The Advanced disclosure must MOVE the viewport when it opens (the rows
      appear at the bottom of the last column, off-screen). The wiring lives
      inside the render loop, so it is pinned by source shape (the settled
      rule for gsys DOM wiring, see u41-gsys-polish.test.cjs).
   3. The sub-key value chip CSS: the settings grid inherits
      'white-space:nowrap' from '.admin-table .urow span:not(:first-child)',
      and a nowrap chip that shrinks PAINTS its overflow across the eye
      button. The rule that cancels it is load-bearing -> pinned. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const gsys = fs.readFileSync(path.join(STATIC_DIR, 'uplift_gsys.js'), 'utf8');
const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

/* ---------------- 1. the column splitter, mounted for real -------------- */

function sliceFn(src, name) {
    const m = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
    assert.ok(m, name + ' present in uplift_gsys.js');
    return sliceBraces(src, m.index);
}
/* balanced block from the first '{' at/after `from` (the sliced bodies here
   contain only balanced braces inside strings — repo convention) */
function sliceBraces(src, from) {
    let i = src.indexOf('{', from), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (!depth) return src.slice(from, j + 1); }
    }
    assert.fail('block starting at ' + from + ' never closes (brace walker)');
}

function makeEl(tag, cls) {
    const el = {
        tagName: tag, _text: '', children: [], parentNode: null, hidden: false,
        style: {}, dataset: {}, offsetHeight: 0, clientWidth: 0,
        classList: {
            contains: c => String(el.className || '').split(/\s+/).includes(c),
            add: c => { el.className = (el.className + ' ' + c).trim(); },
            toggle: (c, on) => {
                const parts = String(el.className || '').split(/\s+/).filter(Boolean);
                const at = parts.indexOf(c);
                if (on && at < 0) parts.push(c);
                if (!on && at >= 0) parts.splice(at, 1);
                el.className = parts.join(' ');
            },
        },
        get className() { return el._cls || ''; },
        set className(v) { el._cls = v; },
        append(...ns) {
            for (const n of ns) {
                if (!n || typeof n !== 'object') continue;   // real DOM: strings become text nodes
                // REAL append MOVES a node that already has a parent — the
                // splitter relies on that (measure pass parks every box in
                // col 0, balance pass moves them out). A stub that only
                // pushes shows each box twice in column 1.
                const p = n.parentNode;
                if (p) { const k = p.children.indexOf(n); if (k >= 0) p.children.splice(k, 1); }
                const mine = el.children.indexOf(n);
                if (mine >= 0) el.children.splice(mine, 1);
                n.parentNode = el; el.children.push(n);
            }
        },
        remove() {
            const p = el.parentNode; if (!p) return;
            const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1);
            el.parentNode = null;
        },
        querySelectorAll(sel) { return walk(el, sel); },
        querySelector(sel) { return walk(el, sel)[0] || null; },
    };
    el.className = cls || '';
    return el;
}
/* descendant walk for the selector shapes this test uses: '.gs-box',
   '.gs-col' (plain class selectors only) */
function walk(root, sel) {
    const want = sel.trim().replace(/^\./, '');
    const out = [];
    (function rec(node) {
        for (const c of node.children || []) {
            if (c.classList && c.classList.contains(want)) out.push(c);
            rec(c);
        }
    })(root);
    return out;
}

function mount(width, heights, slugs) {
    const wrap = makeEl('div', 'gs-wrap');
    wrap.clientWidth = width;
    const byId = { 'gs-body': wrap };
    const boxes = heights.map((h, i) => {
        const b = makeEl('div', 'gs-box');
        b.offsetHeight = h; b.dataset.ord = String(i); b.dataset.slug = slugs[i];
        wrap.append(b);
        return b;
    });
    const win = { addEventListener() {}, removeEventListener() {} };
    const ctx = {
        document: { getElementById: id => byId[id] || null, createElement: tag => makeEl(tag) },
        window: win, Math, console,
    };
    vm.createContext(ctx);
    // a top-level function DECLARATION in a vm Script lands as a context
    // property — parenthesising it would make an expression that never binds
    new vm.Script(sliceFn(gsys, 'gsLayoutColumns')).runInContext(ctx);
    ctx.gsLayoutColumns();
    const cols = walk(wrap, 'gs-col');
    return {
        nCols: cols.length,
        widths: cols.map(c => c.style.width),
        slugs: cols.map(c => c.children.map(b => b.dataset.slug)),
        heights: cols.map(c => c.children.reduce((a, b) => a + b.offsetHeight, 0)),
        boxes,
    };
}

test('two columns on a wide board, ONE below the two-column budget', () => {
    const h = [450, 400, 1200, 1480, 590, 1020];
    const slugs = ['server', 'auth', 'models', 'resource_management', 'integrations', 'advanced'];
    for (const [w, want] of [[1342, 2], [1182, 2], [1040, 1], [812, 1], [500, 1]]) {
        const r = mount(w, h, slugs);
        assert.strictEqual(r.nCols, want, 'columns at avail ' + w + ': ' + JSON.stringify(r.widths));
    }
});

test('column widths share the wrap exactly (no dead band, no overflow)', () => {
    const r = mount(1342, [450, 400, 1200, 1480, 590, 1020], ['a', 'b', 'c', 'd', 'e', 'f']);
    const ws = r.widths.map(w => parseInt(w, 10));
    assert.strictEqual(ws.length, 2);
    assert.ok(Math.abs(ws[0] - ws[1]) <= 1, 'equal columns: ' + ws);
    // 2 columns + one 14px gap must not exceed the wrap
    assert.ok(ws[0] * 2 + 14 <= 1342 + 1, 'fits the wrap: ' + ws);
    assert.ok(ws[0] >= 500, 'a settings row needs its value cell: ' + ws[0]);
});

test('a box taller than the slack starts the next column instead of unbalancing it', () => {
    // measured on the live board: server 438, auth 400, models 1219,
    // resource_management 1480, integrations 592, advanced 1022
    const r = mount(1342, [438, 400, 1219, 1480, 592, 1022],
        ['server', 'auth', 'models', 'resource_management', 'integrations', 'advanced']);
    assert.deepStrictEqual(r.slugs, [
        ['server', 'auth', 'models'],
        ['resource_management', 'integrations', 'advanced'],
    ], JSON.stringify(r.slugs));
    const spread = Math.max(...r.heights) - Math.min(...r.heights);
    // append-then-check (the old order) gave 3593 vs 1642 = 1951 spread
    assert.ok(spread < 1200, 'columns stay within ' + spread + 'px of each other');
});

test('a tab with one visible section takes the whole width (no empty column)', () => {
    const box = makeEl('div', 'gs-box'); box.offsetHeight = 400; box.dataset.slug = 'auth';
    const hidden1 = makeEl('div', 'gs-box'); hidden1.offsetHeight = 900; hidden1.hidden = true;
    const wrap = makeEl('div', 'gs-wrap'); wrap.clientWidth = 1342;
    wrap.append(hidden1, box);
    const byId = { 'gs-body': wrap };
    const ctx = { document: { getElementById: id => byId[id] || null, createElement: tag => makeEl(tag) }, window: { addEventListener() {} }, Math, console };
    vm.createContext(ctx);
    new vm.Script(sliceFn(gsys, 'gsLayoutColumns')).runInContext(ctx);
    ctx.gsLayoutColumns();
    const cols = walk(wrap, 'gs-col');
    assert.strictEqual(cols.length, 1, 'one visible box -> one column');
    assert.deepStrictEqual(cols[0].children.map(b => b.dataset.slug), ['auth']);
    // the filtered-out box must stay parked on the wrap, never in a column
    assert.ok(hidden1.parentNode === wrap, 'hidden box parked on the wrap');
});

/* ---------------- 2. Advanced disclosure moves the viewport ------------- */
test('expanding Advanced scrolls the box into view; collapsing does not', () => {
    const i = gsys.indexOf("if (slug === 'advanced') {");
    assert.ok(i > 0, 'the advanced disclosure block exists');
    // balanced slice: the else-branch next to it (every OTHER header) still
    // aims at the savebar, and that is correct — so the pin must not read it
    const block = sliceBraces(gsys, i);
    assert.match(block, /const opening = !gsAdvOpen\(\);/);
    assert.match(block, /gsAdvSetOpen\(opening\);\s*paintAdv\(\);/);
    assert.match(block, /if \(opening\) \{[\s\S]*?gsScrollBoxIntoView\(box\);/);
    // DEAD SHAPE: scrolling to the savebar left the header + first rows above
    // the fold (user: 'clicking expand should send the viewport to the bottom')
    assert.ok(!/bar\.scrollIntoView/.test(block), 'the expand no longer aims at the savebar');
    assert.ok(!/scrollIntoView/.test(block), 'no raw scrollIntoView in the disclosure');
    // the helper itself must clear the STICKY header, or block:'start' parks
    // the section title underneath it
    const helper = sliceFn(gsys, 'gsScrollBoxIntoView');
    assert.match(helper, /document\.querySelector\('header\.top'\)/);
    assert.match(helper, /getBoundingClientRect\(\)\.height/);
    assert.match(helper, /window\.scrollTo\(\{[\s\S]*?behavior: 'smooth'/);
    assert.match(helper, /window\.scrollY \+ box\.getBoundingClientRect\(\)\.top - off/);
    assert.match(helper, /Math\.max\(0,/);   // never scroll above the document
});

/* ---- the disclosure STATE is a per-browser choice (user 2026-10-27:
   'advanced session should remember the state'). Storage area is the whole
   point, so it is pinned on the two accessor bodies; sessionStorage here
   would silently re-collapse on every reload. restartPending elsewhere in
   this file STAYS session-scoped on purpose — that flag is about a pending
   server restart, not a display choice. ------------------------------- */
test('Advanced remembers open/closed across reloads (localStorage)', () => {
    const acc = sliceFn(gsys, 'gsAdvOpen');
    const mut = sliceFn(gsys, 'gsAdvSetOpen');
    assert.ok(gsys.includes("const GS_ADV_LS = 'uplift.gs.advOpen'"), 'one stable key');
    assert.match(acc, /localStorage\.getItem\(GS_ADV_LS\) === '1'/);
    assert.match(mut, /localStorage\.setItem\(GS_ADV_LS, v \? '1' : ''\)/);
    assert.ok(!/sessionStorage/.test(acc + mut),
        'the fold state must not go back to session scope');
    for (const body of [acc, mut])
        assert.ok(/try \{[\s\S]*\} catch \(_\) \{/.test(body), 'private-mode safe both ways');
    // default with nothing stored stays collapsed (first visit = short page)
    assert.match(acc, /catch \(_\) \{ return false; \}/);
});

/* ---------------- 3. the sub-key value chip ---------------------------- */
/* standalone rule body by literal selector (the indexOf form is deliberate:
   a regex 'first match' can land inside a bigger selector list) */
function cssRule(sel) {
    const at = css.indexOf('\n' + sel + ' {');
    assert.ok(at >= 0, 'rule ' + sel + ' exists as a standalone block');
    return css.slice(at, css.indexOf('}', at));
}
test('the masked-key chip can shrink AND wrap (nowrap paints over the buttons)', () => {
    const body = cssRule('.gs-subkeys .gctl code');
    for (const need of ['min-width: 0', 'white-space: normal', 'overflow-wrap: anywhere', 'flex: 1 1 auto'])
        assert.ok(body.includes(need), 'rule carries ' + need + ' -> ' + body);
    assert.ok(cssRule('.gs-subkeys .gctl').includes('align-items: center'),
        'chip and its buttons share one centred row');
});
test('hint text and read-only values stay inside their own column', () => {
    // env-var hints carry unbreakable tokens ([OMLX_MTP_PRIME_WINDOW]) and the
    // label cell is a flex row: the hint ran 13-16px past its own cell and
    // touched the value box (measured live)
    const hint = cssRule('.urow.settings .uname small');
    for (const need of ['min-width: 0', 'max-width: calc(100% - 16px)', 'overflow-wrap: anywhere'])
        assert.ok(hint.includes(need), 'hint rule carries ' + need);
    // the HF cache path is a read-only control-column value: right-justified +
    // clipped cut its FRONT off
    const ro = cssRule('.urow.settings .gctl .gs-roval');
    for (const need of ['min-width: 0', 'white-space: normal', 'overflow-wrap: anywhere', 'text-align: right'])
        assert.ok(ro.includes(need), 'read-only value rule carries ' + need);
    assert.ok(gsys.includes("hfp.className = 'dim gs-roval'"),
        'the HF path readout carries the class the rule styles');
});
