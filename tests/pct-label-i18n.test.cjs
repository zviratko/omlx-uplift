/* PCT-LABEL: the two percentile stat labels (p95 prompt / completion tok) carry
   catalog keys that all eleven locales translate, but renderRequestStats
   overwrote them with an English template literal on every stats tick - so a
   non-English board showed English there while the rest of the card read
   localized. Found while proving the Italian catalog paints (2026-11-21);
   Czech showed the same two labels, so the leak predates Italian.
   These labels are JS-built, so the pytest catalog gate cannot see them:
   this file is their owner (uplift-static-ui-gate doctrine). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const LOCALES = path.join(STATIC_DIR, '..', 'locales');
const upSrc = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');

// the shipped helper, evaluated out of the real source so the test cannot
// drift from what the board runs. new Function is safe HERE and only here:
// FN_SRC is read from this repo's own uplift.js (never from user input, the
// network or a request), and the test supplies its own stub C/layout objects.
const a = upSrc.indexOf('const pctLabel =');
const b = upSrc.indexOf('function renderRequestStats');
assert.ok(a > 0 && b > a, 'pctLabel must sit directly above renderRequestStats');
const FN_SRC = upSrc.slice(a, b);
const FB = { 'uplift.label.p95_prompt': (p) => `${p} prompt tok`,
             'uplift.label.p95_completion': (p) => `${p} completion tok` };
const mkLabel = (catalog, percentile, key) => {
    const pctLabel = new Function('C', 'layout', `${FN_SRC}\nreturn pctLabel;`)(
        { t: (k) => (k in catalog ? catalog[k] : k) }, { percentile });
    return pctLabel(key, (FB[key] || (() => ''))(percentile));
};

const KEYS = ['uplift.label.p95_prompt', 'uplift.label.p95_completion'];
const localeFiles = fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'));

test('PCT-LABEL: both render paths build the label through the catalog', () => {
    // 2 assignments per label (server-stats path + session-samples path, F-021)
    assert.equal((upSrc.match(/\$\('lbl-prompt-pct'\)\.textContent = pctLabel\(/g) || []).length, 2,
        'the prompt label must ride pctLabel in BOTH render paths');
    assert.equal((upSrc.match(/\$\('lbl-compl-pct'\)\.textContent = pctLabel\(/g) || []).length, 2,
        'the completion label must ride pctLabel in BOTH render paths');
    assert.ok(!/\$\('lbl-(prompt|compl)-pct'\)\.textContent = `\$\{layout\.percentile\}/.test(upSrc),
        'no label may go back to a bare English template literal');
});

test('PCT-LABEL: every locale keeps its own wording and follows the selector', () => {
    assert.equal(localeFiles.length, 11, 'all eleven catalogs are on disk');
    for (const f of localeFiles) {
        const cat = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
        const lang = f.replace(/\.json$/, '');
        for (const k of KEYS) {
            assert.ok(cat[k] && cat[k].length > 3, `${lang} lost ${k}`);
            for (const pct of ['p50', 'p90', 'p95', 'p99']) {
                const got = mkLabel(cat, pct, k);
                assert.ok(!/95/.test(got) || pct === 'p95',
                    `${lang}:${k} still shows a stale p95 under ${pct}: ${got}`);
                assert.ok(got.toLowerCase().includes(pct),
                    `${lang}:${k} must name the selected ${pct}: ${got}`);
            }
            if (lang === 'en') continue;
            const en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en.json'), 'utf8'));
            assert.notEqual(mkLabel(cat, 'p95', k), mkLabel(en, 'p95', k),
                `${lang}:${k} paints English, not its own catalog string`);
        }
    }
});

test('PCT-LABEL: zh keeps its upper-case prefix instead of being forced lower', () => {
    for (const lang of ['zh', 'zh-TW']) {
        const cat = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
        assert.ok(/P95/.test(cat['uplift.label.p95_prompt']),
            `${lang} catalog writes the prefix upper-case (the premise of the case rule)`);
        const got = mkLabel(cat, 'p99', 'uplift.label.p95_prompt');
        assert.ok(got.startsWith('P99'), `${lang} must read P99, not p99: ${got}`);
    }
});

test('PCT-LABEL: an unresolved key still yields the English label, never the key', () => {
    const withFb = new Function('C', 'layout', `${FN_SRC}
        return pctLabel('uplift.label.nope', \`\${layout.percentile} prompt tok\`);`)(
        { t: (k) => k }, { percentile: 'p90' });
    assert.equal(withFb, 'p90 prompt tok',
        'viewer mode (no catalog) must not print a raw key');
    const emptyCat = new Function('C', 'layout', `${FN_SRC}
        return pctLabel('uplift.label.p95_prompt', \`\${layout.percentile} prompt tok\`);`)(
        { t: (k) => k }, { percentile: 'p99' });
    assert.equal(emptyCat, 'p99 prompt tok',
        'a catalog that lost the key falls back to English instead of showing the key');
});
