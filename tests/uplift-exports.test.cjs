/* PH2-1 stage 0 export-contract test — the safety net for the uplift.js split.

   Contract (per ticket PH2-1, amended 2026-09-21): every extracted section
   file exposes its surface via `window.Uplift.<name> = ...` and consumers
   reach it as `window.Uplift.<name>`. Node text tests cannot catch browser
   ReferenceErrors from a missed export; this test catches that class at the
   text level: every first-level name referenced as window.Uplift.<name>
   anywhere in static/*.js must be DEFINED (window.Uplift.<name> = ...) by
   EXACTLY ONE file. Duplicate exports are a load-order roulette, so they are
   refused too. Today nothing uses window.Uplift.* yet (uplift.js is one
   IIFE), so the assertions hold vacuously — they start biting at stage 1. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

const DEF_RE = /window\.Uplift\.([A-Za-z_$][\w$]*)\s*=(?!=|>)/g;
const ANY_RE = /window\.Uplift\.([A-Za-z_$][\w$]*)/g;

const files = staticFiles();

test('static file surface is present (helper sanity)', () => {
    assert.ok(files.includes('uplift.js'), 'uplift.js still in the static set');
    assert.ok(files.length >= 1, 'at least one static JS file');
});

test('every window.Uplift.* reference is exported by exactly one file', () => {
    const defs = new Map();  // name -> [files that define it]
    const refs = new Map();  // name -> [files that reference it]
    for (const f of files) {
        const src = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
        // Strip definition assignments first so `window.Uplift.x = ...` is
        // counted as a definition, not also as a reference.
        const stripped = src.replace(DEF_RE, '/*__def_$1__*/');
        for (const m of src.matchAll(DEF_RE)) {
            if (!defs.has(m[1])) defs.set(m[1], []);
            defs.get(m[1]).push(f);
        }
        for (const m of stripped.matchAll(ANY_RE)) {
            if (!refs.has(m[1])) refs.set(m[1], []);
            refs.get(m[1]).push(f);
        }
    }
    const undef = [...refs.keys()].filter(n => !defs.has(n));
    assert.deepStrictEqual(undef, [],
        'window.Uplift.* referenced but never defined: ' + undef.join(', '));
    const dup = [...defs.entries()].filter(([, f]) => f.length > 1);
    assert.deepStrictEqual(dup.map(([n]) => n), [],
        'window.Uplift.* defined by more than one file: ' +
        dup.map(([n, f]) => n + ' (' + f.join(', ') + ')').join('; '));
});

test('no file both consumes window.Uplift.* before it loads (load-order guard)', () => {
    // index.html order IS the load order. A file may reference names defined
    // by files that come BEFORE it in the list, or later ones only inside
    // functions (deferred execution). The text-level rule we can enforce
    // cheaply: a name may not be used at the TOP level (column 0, outside
    // any function body) of a file that precedes its definition file.
    const defFile = new Map();
    for (const f of files) {
        const src = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
        for (const m of src.matchAll(DEF_RE)) if (!defFile.has(m[1])) defFile.set(m[1], f);
    }
    for (const [name, file] of defFile) {
        const idx = files.indexOf(file);
        for (const earlier of files.slice(0, idx)) {
            const src = fs.readFileSync(path.join(STATIC_DIR, earlier), 'utf8');
            // top-level statements start at column 0 in this codebase;
            // anything inside a function is indented.
            const toplevel = src.match(new RegExp('^window\\.Uplift\\.' + name + '\\b', 'gm'));
            assert.ok(!toplevel,
                name + ' used at top level of ' + earlier + ' before it is defined in ' + file);
        }
    }
});
