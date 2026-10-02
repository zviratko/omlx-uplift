/* FE-3: the late-bind glue objects in uplift.js (window.Uplift._xGlue) and
   the consumer shims that mirror them are a contract by COMMENT — a
   renamed/added member on one side only fails at click time in the browser.
   This test extracts both sides by regex and asserts every getter name a
   consumer shim reads from window.Uplift._xGlue exists on the definition,
   and (except for documented pass-through members) that defined getters are
   actually consumed — drift in either direction fails. Planted-mismatch
   proof lives in the ticket (RED -> GREEN, protocol v2). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const files = staticFiles();

// --- definitions: window.Uplift._xGlue = { get name() {...}, name2(...) {...} }
// Brace-walk the object literal (nested braces inside getter bodies).
function extractGlueDefs(src) {
    const defs = {};
    const re = /window\.Uplift\.(_\w+Glue)\s*=\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        const name = m[1];
        let i = re.lastIndex, depth = 1;
        while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
        }
        const body = src.slice(re.lastIndex, i - 1)
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Member scan (comments stripped): members of these literals sit at
        // exactly 4-space indent (getters AND the two methods). Deeper lines
        // are getter bodies. Formatting is stable; test 1 sanity-pins the
        // extraction against reality.
        const members = new Set();
        for (const mm of body.matchAll(/^ {4}(?:get\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm))
            members.add(mm[1]);
        // shorthand properties: a 4-indent line that is nothing but
        // `name, name, name` (the _bootGlue style) declares shorthands
        for (const line of body.split('\n')) {
            if (!/^ {4}[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*,?\s*$/.test(line)) continue;
            line.trim().replace(/,$/, '').split(/\s*,\s*/).forEach(n => members.add(n));
        }
        defs[name] = members;
    }
    return defs;
}

// --- consumers: every `return window.Uplift._xGlue.member` read inside any file
function extractGlueUses(src) {
    const uses = {};   // glueName -> Map(member -> count)
    const re = /window\.Uplift\.(_\w+Glue)\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) {
        if (!uses[m[1]]) uses[m[1]] = new Set();
        uses[m[1]].add(m[2]);
    }
    return uses;
}

const upSrc = read('uplift.js');
const defs = extractGlueDefs(upSrc);
const uses = {};
for (const f of files) {
    if (f === 'uplift.js') continue;
    const u = extractGlueUses(read(f));
    for (const [g, set] of Object.entries(u)) {
        if (!uses[g]) uses[g] = new Set();
        for (const k of set) uses[g].add(k);
    }
}
// destructure form: const { a, b } = window.Uplift._bootGlue
const bootSrc = read('uplift_boot.js');
const destr = new Set();
for (const m of bootSrc.matchAll(/const\s*\{([^}]*)\}\s*=\s*window\.Uplift\.(_\w+Glue)/g)) {
    const g = m[2];
    if (!uses[g]) uses[g] = new Set();
    m[1].split(',').forEach(s => { s = s.trim(); if (s) uses[g].add(s); destr.add(s); });
}

test('glue definitions were found (sanity: the regex still matches reality)', () => {
    assert.ok(Object.keys(defs).length >= 9,
        `expected >=9 glue objects, found ${Object.keys(defs).length}: ${Object.keys(defs)}`);
});

test('every glue member a consumer reads is defined by uplift.js', () => {
    const missing = [];
    for (const [g, set] of Object.entries(uses)) {
        assert.ok(defs[g], `consumer reads ${g} but uplift.js defines no such glue`);
        for (const member of set)
            if (!defs[g].has(member)) missing.push(`${g}.${member}`);
    }
    assert.deepStrictEqual(missing, [], 'undefined glue members read by consumers: ' + missing.join(', '));
});

// Some defined getters are consumed from uplift.js itself (boot helpers) or
// by index.html-era code; whitelist documents them so the reverse direction
// stays strict for everything else.
const DEFINED_NOT_CONSUMED_OK = new Set([
    '_chartGlue.revealGatedCard',   // called from uplift_charts via CH_GLUE getter above
    '_bootGlue.renderTasks',        // consumed via destructure in uplift_boot.js (const {..} = _bootGlue)
]);

test('every defined glue getter is consumed somewhere (no dead contract members)', () => {
    const dead = [];
    for (const [g, set] of Object.entries(defs)) {
        const consumed = uses[g] || new Set();
        for (const member of set) {
            if (consumed.has(member)) continue;
            if (DEFINED_NOT_CONSUMED_OK.has(`${g}.${member}`)) continue;
            dead.push(`${g}.${member}`);
        }
    }
    assert.deepStrictEqual(dead, [], 'glue members nobody reads (drift or leftover): ' + dead.join(', '));
});
