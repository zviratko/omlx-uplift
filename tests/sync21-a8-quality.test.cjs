/* SYNC-1 run 21 (upstream faafcf15 #5155 + 1ed39eb #5083): the A8 row
   mirror. The BEHAVIOUR half (unset reads OFF, MiniMax joins the family) is
   pinned in modelspec.test.cjs; this file pins the DOM half - classic paints
   an amber 'May reduce quality' chip next to the A8 label, and uplift's
   seBind badge option + call site + stylesheet entry are hand-built DOM no
   vm harness mounts (same class as the fire-9 source-shape pins). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const STATIC = p => fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', p), 'utf8');

test('f21 shape: seBind paints opts.badge as .se-qual-badge via textContent', () => {
    const src = STATIC('uplift_mmeditor.js');
    assert.match(src,
        /if \(opts && opts\.badge\) \{[\s\S]{0,220}?className = 'se-qual-badge';\s*\n\s*qb\.textContent = opts\.badge;/,
        'the badge option builds a span with textContent (never innerHTML)');
});
test('f21 shape: the A8 master row passes classic\'s quality chip key', () => {
    const src = STATIC('uplift_mmeditor.js');
    assert.match(src,
        /badge: C\.tf\('modal\.model_settings\.qwen_oq_a8_quality_badge',\s*\n\s*'May reduce quality'\)/,
        'the label resolves through the mounted classic catalog (all 10 locales, zero uplift locale edits)');
    // only the A8 row uses the option today - a second caller must be a
    // deliberate classic-parity move, not an accident
    assert.strictEqual(src.match(/badge: C\.tf\(/g).length, 1);
});
test('f21 shape: .se-qual-badge exists in uplift.css with the amber family', () => {
    const css = STATIC('uplift.css');
    const rule = css.match(/\.se-qual-badge \{[^}]*\}/);
    assert.ok(rule, 'the class the JS paints must have a rule');
    assert.match(rule[0], /var\(--amber-text\)/, 'house token, same palette as the reload badge');
    assert.match(rule[0], /white-space: nowrap/, 'badges never wrap their own text (UX-2)');
});
