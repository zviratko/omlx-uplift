/* FE-6 step 1: uplift_widgets.js — the shared widget registry.

   Golden tests pin the DOM each builder produces (tag/type/attrs/order/
   placeholder wording) — the v1 seBind/gsText rules transferred verbatim.
   Host behavior (value extraction, dirty state, payloads) stays under
   the hosts' own tests (modelspec.test.cjs etc.); this file owns the
   PIXELS. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

function makeEl(tag) {
    const el = {
        tagName: tag, children: [], dataset: {}, style: {},
        className: '', textContent: '', title: '', hidden: false,
        checked: false, disabled: false, value: '', placeholder: '',
        options: [],                       // mirror for select
        append(...kids) { this.children.push(...kids);
            if (tag === 'select') this.options.push(...kids); },
        prepend(k) { this.children.unshift(k);
            if (tag === 'select') this.options.unshift(k); },
        addEventListener() {},
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k] ?? null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    return el;
}
global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
};

const W = require(path.join(STATIC_DIR, 'uplift_widgets.js'));

test('text: value, type override, placeholder', () => {
    const { el, evt } = W.build('text', { value: 'abc' });
    assert.equal(el.tagName, 'input');
    assert.equal(el.type, 'text');
    assert.equal(el.value, 'abc');
    assert.equal(evt, 'input');
    const p = W.build('text', { value: null, type: 'password', placeholder: '•' });
    assert.equal(p.el.value, '');
    assert.equal(p.el.type, 'password');
    assert.equal(p.el.placeholder, '•');
});

test('textarea: rows=3, evt input', () => {
    const { el, evt } = W.build('textarea', { value: 'k v' });
    assert.equal(el.tagName, 'textarea');
    assert.equal(el.rows, 3);
    assert.equal(el.value, 'k v');
    assert.equal(evt, 'input');
});

test('bool: checkbox mirrors checked, evt change', () => {
    const { el, evt } = W.build('bool', { checked: true });
    assert.equal(el.type, 'checkbox');
    assert.equal(el.checked, true);
    assert.equal(evt, 'change');
});

test('number: attrs + empty->effHint placeholder (v1 U3 rule)', () => {
    const { el, evt } = W.build('number', { value: '', min: 0, max: 5, step: 1, effHint: '(from config)' });
    assert.equal(el.type, 'number');
    assert.equal(el.min, 0); assert.equal(el.max, 5); assert.equal(el.step, 1);
    assert.equal(el.placeholder, '(from config)');
    assert.equal(evt, 'input');
    const zero = W.build('number', { value: 0 });
    assert.equal(zero.el.value, 0);
    assert.equal(zero.el.placeholder, '', 'a real 0 is NOT the empty case');
});

test('select: string-compared selection + picker prepend', () => {
    const { el } = W.build('select', {
        selected: 3,
        options: [{ value: 1, text: 'one' }, { value: 3, text: 'three' }],
    });
    assert.equal(el.children.length, 2);
    assert.ok(el.children[1].selected, 'numeric 3 selects value 3 (String compare)');
    assert.equal(el.children[0].textContent, 'one');
    const pick = W.build('select', {
        selected: 'zzz', picker: 'zzz',
        options: [{ value: 'a', text: 'A' }],
    });
    assert.equal(pick.el.children.length, 2);
    assert.equal(pick.el.children[0].value, 'zzz');
    assert.equal(pick.el.children[0].textContent, 'zzz (current)');
    assert.ok(pick.el.children[0].selected);
});

test('inheritable-number: empty value + base placeholder', () => {
    const { el, kind } = W.build('inheritable-number', { value: '', baseVal: 7, min: 1 });
    assert.equal(kind, 'number');           // normalized like v1 seBind
    assert.equal(el.type, 'number');
    assert.equal(el.min, 1);
    assert.equal(el.placeholder, '7 (inherited)');
    const noBase = W.build('inheritable-number', { value: null });
    assert.equal(noBase.el.placeholder, '(default)');
});

test('inheritable-text: empty vs base value', () => {
    const { el, kind } = W.build('inheritable-text', { value: 'x', baseVal: 'base' });
    assert.equal(kind, 'text');
    assert.equal(el.value, 'x');
    assert.equal(el.placeholder, 'base (inherited)');
    const noBase = W.build('inheritable-text', { value: '' });
    assert.equal(noBase.el.placeholder, '(default)');
});

test('inheritable-bool: tri-state select, order inh/on/off', () => {
    const { el } = W.build('inheritable-bool', { value: undefined, baseVal: true });
    assert.equal(el.tagName, 'select');
    assert.deepEqual(el.children.map(c => c.value), ['', 'true', 'false']);
    assert.equal(el.children[0].textContent, 'Inherited: Yes');
    assert.equal(el.children[1].textContent, 'Yes (override)');
    assert.equal(el.children[2].textContent, 'No (override)');
    assert.equal(el.value, '');
    const on = W.build('inheritable-bool', { value: true, baseVal: false });
    assert.equal(on.el.value, 'true');
    assert.equal(on.el.children[0].textContent, 'Inherited: No');
    const off = W.build('inheritable-bool', { value: 'false', baseVal: null });
    assert.equal(off.el.value, 'false');
    assert.equal(off.el.children[0].textContent, 'Inherited: —');
});

test('unknown kind -> null (host keeps bespoke control)', () => {
    assert.equal(W.build('json-editor', {}), null);
    assert.equal(W.build(undefined, {}), null);
});
