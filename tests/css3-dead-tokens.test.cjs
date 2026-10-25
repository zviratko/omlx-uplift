/* CSS-3 (dead-token ratchet): a var(--x) with NO fallback resolves to nothing
 * if nothing declares --x, and the damage is not limited to that one property —
 * an invalid value inside a shorthand drops the WHOLE declaration. Measured on
 * the live board on 2026-10-25: a table frame collapsed to border-width: 0 and
 * meta text rendered at 14px instead of 11px, both from one undefined token.
 *
 * This gate is a RATCHET, not a clean bill of health. Six tokens are used
 * without a fallback and are not declared anywhere in uplift's own surface;
 * some of them resolve at runtime because the classic dashboard CSS or an
 * installed skin declares them, which a repo-only test cannot see. So the set
 * is frozen: adding a new one fails, fixing one fails until it is removed from
 * the baseline below, and resolving the runtime question for each is separate
 * work (tracker D8) that needs the user's call because it changes how pages
 * look.
 *
 * --ok was in this list and is now declared in :root: 10 of its uses carried an
 * inline var(--ok, #2e8b57) fallback and looked correct by accident, while
 * .envcat-chip.ok and .se-tab-api.api-ok had none and silently inherited ink.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

// frozen 2026-10-25, see the header: may only SHRINK
const BASELINE = [
    '--border-normal',
    '--fs-meta',
    '--line',
    '--rule',
    '--text-danger',
    '--timeline-accent',
];

function scan() {
    const declared = new Set();
    const unbacked = new Map();          // token -> Set(files)
    for (const f of fs.readdirSync(STATIC_DIR)) {
        if (!/\.(css|html|js)$/.test(f)) continue;
        let s = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
        s = s.replace(/\/\*[\s\S]*?\*\//g, '');
        if (f.endsWith('.js')) s = s.replace(/\/\/[^\n]*/g, '');
        for (const m of s.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
        // var(--x) ONLY — var(--x, fallback) can never break, by definition
        for (const m of s.matchAll(/var\((--[\w-]+)\)/g)) {
            if (!unbacked.has(m[1])) unbacked.set(m[1], new Set());
            unbacked.get(m[1]).add(f);
        }
    }
    const dead = [...unbacked.keys()]
        .filter((t) => !declared.has(t))
        .sort();
    return { dead, unbacked };
}

test('CSS-3: no new token is used without a fallback and without a declaration', () => {
    const { dead, unbacked } = scan();
    const added = dead.filter((t) => !BASELINE.includes(t));
    assert.deepEqual(added, [], 'undeclared var() uses without fallback: '
        + added.map((t) => `${t} (${[...unbacked.get(t)].join(',')})`).join('; ')
        + ' — declare it in :root or write var(--x, #literal)');
});

test('CSS-3: the baseline shrinks when a dead token is fixed (no stale ratchet)', () => {
    const { dead } = scan();
    const stale = BASELINE.filter((t) => !dead.includes(t));
    assert.deepEqual(stale, [], 'these tokens are now declared — remove them from '
        + `BASELINE so the ratchet keeps its teeth: ${stale.join(', ')}`);
});

test('CSS-3: --ok is declared (it was borrowed by 13 rules and defined by none)', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.ok(/--ok\s*:/.test(css),
        '--ok must be a real token: without it .envcat-chip.ok and '
        + '.se-tab-api.api-ok paint plain ink instead of green');
    assert.ok(!/--ok\s*:\s*var\(/.test(css),
        '--ok must not be defined in terms of another token that may itself be missing');
});
