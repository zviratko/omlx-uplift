/* GS_LABELS drift guard (user bug 2026-10-22: a labelless row under
   "Skip API key verification").

The server-settings spec rows reference label data by dotted path
(lab/hint/confirm/ph: 'auth.keyless'...). gsRef resolves them against
GS_LABELS and returns '' on a miss — the row renders WITHOUT a label,
and a missing `confirm` additionally silences the enable-confirmation of
a security switch (gsToggle skips an empty confirmMsg). The keyless row
shipped in a SYNC-1 fire with exactly this broken reference.

This test extracts the GS_LABELS literal (object of literals + C.tf
calls — evaluated with a tf stub) and asserts every dotted path the
spec rows reference actually resolves. No skip-if-missing: a broken
guard is what let the bug through. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_gsys.js'),
    'utf8');

// brace-walk the object literal — the file's only `const GS_LABELS = {`.
// Justification for the eval below: the function body concatenates ONLY
// this repository's own checked-in source slice (no external input), the
// settled pattern of the vm harnesses in this tests/ dir.
function extractLabels() {
    const start = src.indexOf('const GS_LABELS = {');
    assert.ok(start >= 0, 'GS_LABELS literal not found');
    let i = src.indexOf('{', start), depth = 0, end = -1;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
        const ch = src[j];
        if (inStr) {
            if (ch === '\\') j++;
            else if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        else if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
            if (depth === 0) { end = j; break; }
        }
    }
    assert.ok(end > 0, 'unbalanced GS_LABELS literal');
    const lit = src.slice(i, end + 1);
    // eslint-disable-next-line no-new-func
    return new Function('C', 'return ' + lit)(
        { tf: (k, d) => d });
}

test('every spec-row label path resolves in GS_LABELS', () => {
    const L = extractLabels();
    const used = new Map();
    const re = /\b(?:lab|hint|confirm|ph|title|desc):\s*'([a-z][a-z_0-9]*\.[A-Za-z_0-9]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) used.set(m[1], m.index);
    assert.ok(used.size >= 30,
        `extraction too small (${used.size}) — the regex stopped matching, ` +
        'a vacuous pass is worse than the bug this guards');
    const missing = [...used.keys()].filter(k => {
        let v = L;
        for (const part of k.split('.')) {
            if (v == null || !(part in v)) return true;
            v = v[part];
        }
        return v === '' || v == null;
    });
    assert.deepEqual(missing, [],
        'spec rows reference GS_LABELS paths that do not exist — these ' +
        'render as labelless rows / silent confirms: ' + missing.join(', '));
});

test('keyless-inference row is fully labeled and confirms', () => {
    const L = extractLabels();
    assert.equal(L.auth.keyless, 'Allow inference without API key');
    assert.match(L.auth.keyless_hint, /Admin still requires authentication/);
    assert.match(L.auth.keyless_confirm, /Select OK only if you understand/);
});
