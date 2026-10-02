/* CSS-2 invariant: uplift.css must not re-open the same selector in the
   same @media context. Same-selector blocks scattered across the file are
   how the stylesheet drifted (23 pairs measured 2026-10-02); every later
   'tweak' lands wherever the editor happened to be, and the cascade makes
   the result unreadable. Merge instead of re-opening.

   (ctx, selector) keying: the SAME selector under DIFFERENT media queries
   is legitimate and common; only same-context re-opens are drift. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

function tokenize(css) {
    const stack = [];
    let i = 0;
    const n = css.length;
    const rules = [];
    while (i < n) {
        if (css.startsWith('/*', i)) { const j = css.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
        const ch = css[i];
        if (ch === '@') {
            let j = i;
            while (j < n && css[j] !== '{' && css[j] !== ';') j++;
            if (j < n && css[j] === '{') { stack.push(css.slice(i, j).replace(/\s+/g, ' ').trim()); i = j + 1; continue; }
            i = j + 1; continue;
        }
        if (ch === '}') { stack.pop(); i++; continue; }
        if (ch === '{') {
            let s = i - 1;
            while (s >= 0 && '{};'.indexOf(css[s]) < 0) s--;
            const sel = css.slice(s + 1, i).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
            let j = i + 1;
            while (j < n) {
                if (css.startsWith('/*', j)) { const k = css.indexOf('*/', j + 2); j = k < 0 ? n : k + 2; continue; }
                if (css[j] === '}') break;
                j++;
            }
            if (sel && !sel.startsWith('@')) rules.push([stack.join(' | '), sel]);
            i = j + 1; continue;
        }
        i++;
    }
    return rules;
}

test('uplift.css has no same-context duplicate selectors', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    // key = the FULL rule selector string (a comma group is one selector).
    // A member appearing in a group AND standalone is a different rule
    // contract (e.g. the .badge group min-width vs .badge.done colors) —
    // what drift means is the IDENTICAL selector string re-opened.
    const seen = new Map();
    const dups = [];
    for (const [ctx, sel] of tokenize(css)) {
        const key = ctx + '\u0000' + sel;
        if (seen.has(key)) dups.push(`${sel}${ctx ? ` (in ${ctx})` : ''}`);
        seen.set(key, true);
    }
    assert.deepEqual(dups, [], `duplicate selectors (merge them):\n${dups.join('\n')}`);
});
