/* QA-1 regression gate (2026-10-02): every IIFE file in static/ is its own
   scope — a shared short name like `S` must be bound per file. 05314a3 moved
   S.trackWrite into uplift_mmchips.js without the `const S = window.Uplift.state`
   line its siblings carry, so both DELETE actions died at click time with
   'S is not defined' (found by the browser re-run, never by a node test).
   This test pins the class: for each shared identifier, any file that uses
   `ID.member` must define `const ID =` / `let ID =` itself. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

// Names that live per-IIFE, not in any shared scope. Add here when a new
// cross-file short name appears — the point is the binding, not the name.
const SHARED_NAMES = ['S', 'CH', 'C', 'D', 'API', 'prefs', '$'];

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('every shared identifier used as ID.member is bound in its own file', () => {
    const offenders = [];
    for (const f of staticFiles()) {
        if (f === 'core.js' || f === 'domkit.js') continue; // UMD roots define the names themselves
        const src = stripComments(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'));
        for (const id of SHARED_NAMES) {
            const use = new RegExp(`(?<![\\w$.])${id === '$' ? '\\$' : id}\\s*\\.`, 'g');
            if (!use.test(src)) continue;
            const def = new RegExp(`(?:const|let|var|function)\\s+${id === '$' ? '\\$' : id}\\b`);
            if (!def.test(src)) offenders.push(`${f}: uses ${id}. but never defines ${id}`);
        }
    }
    assert.deepStrictEqual(offenders, [], 'unbound shared identifiers:\n' + offenders.join('\n'));
});
