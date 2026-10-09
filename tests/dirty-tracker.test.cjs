/* FE-4: uplift_dirty.js unit tests — the shared dirty/CHANGES machine.
   require() the UMD module directly (no vm, no source slicing); DOM is
   stubbed just enough for classList/querySelector/append. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const U = require(path.join(STATIC_DIR, 'uplift_dirty.js'));

function el(children = []) {
    const classes = new Set();
    const e = {
        children, classes, hidden: false, textContent: '', className: '',
        classList: {
            toggle(c, on) { on ? classes.add(c) : classes.delete(c); },
            add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
            contains: c => classes.has(c),
        },
        append(...cs) { this.children.push(...cs); },
        querySelector(sel) {
            // '.diff-out' / '.diff-o' lookup by className substring
            const want = sel.replace('.', '');
            const walk = n => {
                for (const c of n.children || []) {
                    if ((c.className || '').includes(want)) return c;
                    const r = walk(c); if (r) return r;
                }
                return null;
            };
            return walk(e);
        },
    };
    return e;
}
const disp = v => (v === undefined ? '—' : String(v));

// module builds real elements via document.createElement — node stub
global.document = {
    createElement: () => {
        const classes = new Set();
        return {
            children: [], classes, hidden: false, textContent: '', className: '',
            classList: {
                toggle(c, on) { on ? classes.add(c) : classes.delete(c); },
                add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
                contains: c => classes.has(c),
            },
            append(...cs) { this.children.push(...cs); },
        };
    },
    createTextNode: t => ({ textContent: t }),
};

test('applyRowState: unchanged value clears dirty classes and hides chip', () => {
    const row = el([el([el()])]);
    row.children[0].className = 'diff-out';
    row.children[0].children[0].className = 'diff-o';
    const changed = U.applyRowState({ orig: 'a', cur: 'a', row, isSecret: false, isRestart: false, display: disp });
    assert.equal(changed, false);
    assert.ok(!row.classList.contains('dirty'));
    assert.equal(row.querySelector('.diff-out').hidden, true);
});

test('applyRowState: change marks dirty + restartq + fills original chip', () => {
    const row = el([el([el()])]);
    row.children[0].className = 'diff-out';
    row.children[0].children[0].className = 'diff-o';
    const changed = U.applyRowState({ orig: 'a', cur: 'b', row, isSecret: false, isRestart: true, display: disp });
    assert.equal(changed, true);
    assert.ok(row.classList.contains('dirty'));
    assert.ok(row.classList.contains('restartq'));
    const rd = row.querySelector('.diff-out');
    assert.equal(rd.hidden, false);
    assert.equal(rd.querySelector('.diff-o').textContent, 'a');
});

test('applyRowState: secret change masks the original chip', () => {
    const row = el([el([el()])]);
    row.children[0].className = 'diff-out';
    row.children[0].children[0].className = 'diff-o';
    U.applyRowState({ orig: 'sk-live', cur: 'sk-new', row, isSecret: true, isRestart: false, display: disp });
    const rd = row.querySelector('.diff-out');
    assert.ok(rd.classList.contains('masked'));
    assert.equal(rd.querySelector('.diff-o').textContent, U.SECRET_TEXT);
});

/* Checkbox rows carry an explicit .diff-n new-value chip: an unchecked box
   reads as nothing, so 'true →' with no right side looked broken (user
   report: unticking hot cache showed 'true -> ' + nothing). */
function chipRow() {
    const row = el();
    const rd = el(); rd.className = 'diff-out';
    const o = el(); o.className = 'diff-o';
    const n = el(); n.className = 'diff-n';
    row.append(rd); rd.append(o, n);
    return row;
}

test('applyRowState: checkbox chip fills .diff-n with the new value', () => {
    const row = chipRow();
    U.applyRowState({ orig: true, cur: false, row, isSecret: false, isRestart: true, display: v => String(v) });
    const rd = row.querySelector('.diff-out');
    assert.equal(rd.querySelector('.diff-o').textContent, 'true');
    assert.equal(rd.querySelector('.diff-n').textContent, 'false');
});

test('applyRowState: edited back hides chip and clears .diff-n', () => {
    const row = chipRow();
    U.applyRowState({ orig: true, cur: false, row, isSecret: false, isRestart: false, display: v => String(v) });
    const changed = U.applyRowState({ orig: true, cur: true, row, isSecret: false, isRestart: false, display: v => String(v) });
    assert.equal(changed, false);
    assert.equal(row.querySelector('.diff-out').hidden, true);
    assert.equal(row.querySelector('.diff-n').textContent, '');
});

test('applyRowState: secret change masks .diff-n too', () => {
    const row = chipRow();
    U.applyRowState({ orig: 'sk-live', cur: 'sk-new', row, isSecret: true, isRestart: false, display: v => String(v) });
    assert.equal(row.querySelector('.diff-n').textContent, U.SECRET_TEXT);
});

test('DirtyTracker: mark/isDirty/edited-back + payload map', () => {
    const state = { host: 'x' };
    const tr = U.DirtyTracker({
        orig: k => state[k], cur: k => state[k],
        display: disp, isRestart: k => k === 'port',
    });
    tr.mark('host', 'x');                      // unchanged -> not dirty
    assert.equal(tr.isDirty('host'), false);
    tr.mark('host', 'y');
    assert.equal(tr.isDirty('host'), true);
    assert.equal(tr.value('host'), 'y');
    tr.mark('host', 'x');                      // edited back
    assert.equal(tr.isDirty('host'), false);
});

test('renderChangesBox: head + old/new halves + .ch-new span', () => {
    const box = el();
    U.renderChangesBox(box, [
        { key: 'port', orig: 8000, cur: 8011, isSecret: false, display: disp },
        { key: 'api_key', orig: 'sk-old', cur: 'sk-new', isSecret: true, display: disp },
    ], (k, fb) => fb);
    assert.equal(box.hidden, false);
    const head = box.children[0];
    assert.equal(head.className, 'ch-head');
    assert.ok(head.textContent.includes('CHANGES (2)'));
    const l1 = box.children[1];
    assert.equal(l1.children[0].textContent, 'port: 8000');
    assert.equal(l1.children[1].textContent, U.ARROW);
    assert.equal(l1.children[2].textContent, 'port: 8011');
    assert.equal(l1.children[2].className, 'ch-new');
    const l2 = box.children[2];
    assert.equal(l2.children[0].textContent, 'api_key: ' + U.SECRET_OLD);
    assert.equal(l2.children[2].textContent, 'api_key: ' + U.SECRET_TEXT);
});

test('renderChangesBox: empty list hides the box', () => {
    const box = el();
    box.hidden = false;
    U.renderChangesBox(box, [], null);
    assert.equal(box.hidden, true);
});

test('tracker renderChangesBox wires entries from its own state', () => {
    const state = { a: '1' };
    const box = el();
    const tr = U.DirtyTracker({ orig: k => state[k], display: disp, isSecret: k => k === 'a', t: (k, fb) => fb });
    tr.mark('a', '2');
    tr.renderChangesBox(box);
    assert.ok(box.children[1].children[0].textContent.includes(U.SECRET_OLD));
    assert.ok(box.children[1].children[2].textContent.includes(U.SECRET_TEXT));
});
