/* Escape-closes-modals contract (2026-09-25).

   The app must carry EXACTLY ONE document-level Escape handler for modal
   dialogs — the one in uplift_state.js. Per-dialog listeners were the old
   pattern and silently did nothing once focus left the dialog (a backdrop
   click moves focus to the overlay/body). Dialogs with teardown state
   register their close function on the overlay as __upliftModalClose.

   Text-level drift test (same approach as uplift-exports.test.cjs): every
   .modal-overlay creation site must NOT add its own Escape keydown
   listener, and the global handler must exist exactly once. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { STATIC_DIR } = require('./static-src.cjs');

const files = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.js'));
const src = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');

test('global Escape handler exists in uplift_state.js (exactly once)', () => {
    const s = src('uplift_state.js');
    assert.match(s, /__upliftModalClose/,
        'global handler must honour the dialog close-function hook');
    assert.match(s, /querySelectorAll\('\.modal-overlay'\)/,
        'global handler must target .modal-overlay dialogs');
    assert.strictEqual(
        (s.match(/e\.key !== 'Escape'|e\.key === 'Escape'/g) || []).length, 1,
        'uplift_state.js must own exactly one Escape check');
});

test('no per-dialog Escape keydown listeners remain', () => {
    const offenders = [];
    for (const f of files) {
        if (f === 'uplift_state.js' || f.startsWith('vendor')) continue;
        const s = src(f);
        // document/window-level Escape listeners on OTHER layers (the chart
        // timespan popover) are allowed; listeners tied to a modal overlay
        // are the drift. Detect the old idiom: addEventListener with Escape
        // anywhere a modal-overlay is created in the same file.
        const escListeners =
            s.match(/(document|overlay|window)\.addEventListener\(\s*'keydown'[^)]*Escape/gs) || [];
        if (/modal-overlay/.test(s) && escListeners.length) {
            offenders.push(`${f}: ${escListeners.length} leftover Escape listener(s)`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'dialogs must rely on the global handler (register __upliftModalClose ' +
        'for teardown) — no per-dialog Escape listeners:\n' + offenders.join('\n'));
});

test('every modal-overlay creation site is covered', () => {
    // sites that create an overlay must not be orphaned by a rename of the
    // class the global handler looks for
    const sites = files.filter(f => /className = 'modal-overlay/.test(src(f)));
    assert.ok(sites.length >= 3,
        'expected the known modal sites (helper/modelmgr/modelsops) to exist');
    for (const f of sites) {
        assert.match(src(f), /modal-overlay/, f + ' still creates modal overlays');
    }
});
