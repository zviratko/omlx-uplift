/* WIDE-QA round 2 (user 2026-11-01): every capped reading column is
   CENTERED, not pinned to the left edge of the page. The first capping
   pass (today, 652b52d/d279745) set max-widths but left the blocks flush
   left, which reads lopsided on wide monitors; and the About cap shipped
   DEAD (selector #about-page - the section carries data-id, no id), so
   About never narrowed at all. These pins keep both shapes honest. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');

/* a standalone rule whose body must carry margin-inline: auto */
function centered(selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, 'rule exists: ' + selector);
    assert.match(m[1], /margin(-inline)?:[^;}]*auto/, 'and centers: ' + selector);
}

test('today\'s capped columns all ride the centered reading line', () => {
    centered('.mk-box');                     // helper models + voices cards
    centered('.qz-form');                    // quantizer / uploader forms
    centered('#qz-tasks, #up-tasks, #dl-tasks, #hm-list');   // queue tables
    centered('#dl-results');                 // downloader results
});

test('About narrows via the markup that EXISTS (data-id, not a dead #id)', () => {
    // the page section carries data-id="about-page" and NO id attribute
    assert.match(html, /<section class="card wide page-card" data-id="about-page"/);
    assert.ok(!/\sid="about-page"/.test(html),
        'no element named about-page: the first cap selected nothing');
    centered('section[data-id="about-page"] .card-body');
    assert.match(css,
        /section\[data-id="about-page"\] \.card-body \{[^}]*max-width: 1180px/,
        'the cap matches the other pages\' reading column');
    assert.ok(!/\n#about-page /.test(css),
        'the dead #about-page selector must stay retired');
});

test('the native bench column narrows; the STATUS BOARD NEVER DOES', () => {
    /* User ruling 2026-11-01 (same day as the caps): "you shouldn't have
       resized the status dashboards - using the display estate there
       makes sense, there's lots of information. Only forms that needlessly
       stretch the information make sense to be narrowed." The board rides
       the .wrap column; capping it is RETIRED - negative pin. */
    assert.ok(!/main#grid[^{]*\{[^}]*max-width/.test(css),
        'the status board must not carry a max-width again');
    assert.ok(!/#grid\b[^{]*\{[^}]*margin-inline:[^}]*auto/.test(css),
        'and no centering rule for a cap that must not exist');
    // Bench: sub-tab strip AND panels ride the same capped column
    const m = css.match(/#bench-native \.native-subtabs,\s*\n#bench-native \.native-subpanel \{([^}]*)\}/);
    assert.ok(m, 'the bench column rule exists');
    assert.match(m[1], /max-width: 1180px/, 'capped');
    assert.match(m[1], /margin-inline: auto/, 'centered');
    // Chat's native host is NOT narrowed (it owns the composer width) -
    // the cap selectors above must stay bench/status-scoped
    assert.ok(!/\.native-host \{[^}]*max-width/.test(css),
        'no blanket native-host cap (chat keeps its width)');
});
