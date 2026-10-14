/* BUG-FORCE (user 2026-10-14): the model editor's Chat Template Kwargs
   section had NO force control — forced entries rendered as a dead
   read-only row ('key (forced)', no ×), and free entries could never be
   marked force. The data path was always there (entry.force ->
   buildPayload -> forced_ct_kwargs); only the editor UI was missing.

   Contract pinned here (u85 slicing pattern — uplift_mmeditor.js is a
   browser IIFE; the region is sliced from the checked-in source and run
   against a fake DOM; each test file is its own process):
   - EVERY entry renders an editable row + a checkbox carrying e.force;
     forced rows keep their editor widget (input/select) and their ×;
   - toggling the checkbox mutates the entry and seSyncKwEntries pushes
     the list back to the tab (raw kwargs twins deleted);
   - buildPayload splits a checked row into forced_ct_kwargs (server-
     side contract of the flag, pinned end-to-end). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');
const S = require('../omlx_uplift/static/modelspec.js');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
function region(a, b, label) {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    assert.ok(i > 0 && j > i, 'CT2 slice region must exist: ' + label);
    return src.slice(i, j);
}
const CODE = region('function seSyncKwEntries', 'function editorNode',
    'seSyncKwEntries + renderCtKwargs');

/* ---- fake DOM (u85 shape + listeners, closest, dataset) ------------- */
function el(tag) {
    const e = { tag, children: [], dataset: {}, style: {}, textContent: '',
        className: '', _lis: {} };
    e.append = (...c) => { e.children.push(...c.filter(Boolean)); return e; };
    e.closest = () => null;                    // no #se-fields ancestor
    e.addEventListener = (t, fn) => { (e._lis[t] = e._lis[t] || []).push(fn); };
    return e;
}
function fire(e, t) { (e._lis[t] || []).forEach(fn => fn({ stopPropagation() {} })); }
function walk(e, out = []) {
    for (const c of e.children || []) { out.push(c); walk(c, out); }
    return out;
}
const findAll = (root, pred) => walk(root).filter(pred);

function harness(entries, formModel) {
    const reRenders = { n: 0 };
    const tab = { id: 'base', workVals: {} };
    const seValues = { ctKwargEntries: entries };
    const document = { createElement: el };
    const C = { tf: (k, d) => d };
    const fn = new Function('document', 'C', 'window', 'seValues', 'seTab',
        'seFormModel', 'renderEditorFields',
        CODE + '\nreturn { renderCtKwargs, seSyncKwEntries };');
    const api = fn(document, C, { UpliftModelSpec: S }, seValues,
        () => tab, formModel || { id: 'M1' },
        () => { reRenders.n++; });
    const container = el('div');
    api.renderCtKwargs(container);
    return { container, tab, seValues, api, reRenders };
}

test('forced entry renders an EDITABLE row with a ticked checkbox and ×', () => {
    const entries = S.buildCtKwargEntries({ my_key: 'v1' }, ['my_key'], false);
    assert.equal(entries[0].force, true, 'fixture: entry is forced');
    const h = harness(entries);
    const rows = findAll(h.container, e => e.className === 'se-row se-kwarg');
    assert.equal(rows.length, 1, 'one editable row, not a read-only label');
    const boxes = findAll(h.container, e => e.tag === 'input' && e.type === 'checkbox');
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].checked, true, 'checkbox reflects entry.force');
    assert.equal(findAll(h.container, e => e.tag === 'input' && e.type === 'text'
        && e.value === 'v1').length, 1, 'value stays editable');
    assert.equal(findAll(h.container, e => e.tag === 'button'
        && e.textContent === '×').length, 1, 'forced rows are removable');
    assert.ok(!h.container.textContent.includes('(forced)'),
        'the old read-only label is gone');
});

test('checkbox change mutates e.force and syncs the tab (no raw twins)', () => {
    const entries = S.buildCtKwargEntries({ my_key: 'v1' }, [], false);
    const h = harness(entries);
    const box = findAll(h.container, e => e.tag === 'input' && e.type === 'checkbox')[0];
    assert.equal(box.checked, false, 'free entry starts unforced');
    // raw twins present (pre-sync shape): sync must delete them
    h.tab.workVals.chat_template_kwargs = { my_key: 'v1' };
    h.tab.workVals.forced_ct_kwargs = null;
    box.checked = true;
    fire(box, 'change');
    assert.equal(entries[0].force, true);
    assert.equal(h.tab.workVals.ctKwargEntries, entries, 'entries pushed back to tab');
    assert.ok(!('chat_template_kwargs' in h.tab.workVals)
        && !('forced_ct_kwargs' in h.tab.workVals), 'raw twins deleted by sync');
    // and the payload honors the tick (server contract end-to-end):
    const payload = S.buildPayload({ ctKwargEntries: entries, is_diffusion_model: false }, {});
    assert.deepEqual(payload.chat_template_kwargs, { my_key: 'v1' });
    assert.deepEqual(payload.forced_ct_kwargs, ['my_key']);
    // untick -> the key leaves forced_ct_kwargs
    box.checked = false;
    fire(box, 'change');
    const p2 = S.buildPayload({ ctKwargEntries: entries, is_diffusion_model: false }, {});
    assert.equal(p2.forced_ct_kwargs, null);
});

test('typed forced entry (enable_thinking) keeps its select and checkbox', () => {
    const entries = S.buildCtKwargEntries({ enable_thinking: true },
        ['enable_thinking'], false);
    const h = harness(entries);
    assert.equal(findAll(h.container, e => e.tag === 'select').length, 1,
        'true/false select, not static text');
    assert.equal(findAll(h.container, e => e.tag === 'input'
        && e.type === 'checkbox')[0].checked, true);
    assert.equal(findAll(h.container, e => e.tag === 'span'
        && e.className === 'se-kwarg-key').length, 1, 'typed key stays read-only');
});

test('the old read-only branch is gone from the shipped source', () => {
    assert.ok(!/\(forced\)/.test(src.slice(src.indexOf('function renderCtKwargs'),
        src.indexOf('function editorNode'))),
        'no forced-entry early return may sneak back');
});
