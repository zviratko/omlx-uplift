/* FE-2 grep gate: raw fetch() in shipped static JS is allowed ONLY inside
   domkit.js (the single kit implementation) or on lines explicitly marked
   `domkit-exempt: <reason>` (the binary diff preview). FE-1 promised the
   kit contract; without this gate new raw fetches creep back with their
   private, divergent error handling — the [object Object] toast class. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

// fetchJson(url, opts) etc. are kit members, not raw fetches; the regex
// below matches a call expression `fetch(` not preceded by an identifier
// char or dot (so fetchJson(, postJson(, window.fetch-assignment pass).
const RAW_FETCH = /(?<![\w$.])fetch\s*\(/g;
const EXEMPT = /domkit-exempt/;

test('raw fetch() lives only in domkit.js or domkit-exempt lines', () => {
    const offenders = [];
    for (const f of staticFiles()) {
        if (f === 'domkit.js') continue;
        const lines = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // strip string contents so comments inside literals don't exempt
            RAW_FETCH.lastIndex = 0;
            if (!RAW_FETCH.test(line)) continue;
            const markedHere = EXEMPT.test(line);
            const markedPrev = i > 0 && EXEMPT.test(lines[i - 1]);
            if (!markedHere && !markedPrev)
                offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'raw fetch() outside domkit — use D.fetchJson/postJson/putJson/deleteJson '
        + 'or mark the line `// domkit-exempt: <reason>`:\n' + offenders.join('\n'));
});
