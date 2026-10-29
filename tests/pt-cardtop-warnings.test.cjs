'use strict';
/* CARD-TOP WARNINGS (mruu ask 2026-10-29).
   Two warnings used to render where nobody looks:
     * the omlx-dev build drift line sat at the BOTTOM of the DEV zone,
     * a failed bundled-patch update check printed in the muted note line
       under the table (.pt-detail), next to informational chatter.
   Both now sit above the ADD PATCH form, in the same alarm frame as the
   runtime drift banner, and the dev line carries the concrete evidence
   (which files, which version) instead of asking whether the user edited
   by hand. No vm harness expresses the card layout, so the placement and
   the wiring are pinned as source shape on the checked-in files, and the
   locale contract is pinned for all ten catalogs. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'omlx_uplift');
const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const patchesJs = fs.readFileSync(path.join(ROOT, 'static', 'uplift_patches.js'), 'utf8');
const devJs = fs.readFileSync(path.join(ROOT, 'static', 'uplift_devpanel.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'uplift.css'), 'utf8');
const LOCALES = fs.readdirSync(path.join(ROOT, 'locales'))
    .filter((f) => f.endsWith('.json')).sort();

const at = (s, needle, what) => {
    const i = s.indexOf(needle);
    assert.notEqual(i, -1, 'missing ' + what + ': ' + needle);
    return i;
};

test('both warnings sit above the ADD PATCH form', () => {
    const dev = at(html, 'id="dv-warn"', 'dev drift banner');
    const cat = at(html, 'id="pt-catalog-warn"', 'catalog check banner');
    const add = at(html, 'class="pt-addform"', 'ADD PATCH form');
    assert.ok(dev < add, 'dev build warning must be above ADD PATCH');
    assert.ok(cat < add, 'catalog check warning must be above ADD PATCH');
    // and both share the alarm frame the runtime drift banner uses
    for (const id of ['dv-warn', 'pt-catalog-warn']) {
        const tag = html.slice(at(html, 'id="' + id + '"', id) - 40,
                               at(html, 'id="' + id + '"', id) + 90);
        assert.match(tag, /pt-banner/, id + ' keeps the banner box');
        assert.match(tag, /pt-drift/, id + ' uses the alarm frame');
        assert.match(tag, /pt-alert/, id + ' is sized up');
    }
});

test('the DEV zone no longer carries its own copy of the warning', () => {
    // a duplicate id would leave the old (invisible) element in charge
    assert.equal(html.split('id="dv-warn"').length - 1, 1,
        'dv-warn must appear exactly once');
});

test('the visible line says what changed, not who is to blame', () => {
    // detail (files + versions from drift_check) rides the banner text
    assert.match(devJs, /warn\.textContent = \[_lead, _dr\.detail\]\.filter\(Boolean\)\.join\(' '\);/,
        'banner composes the lead with the concrete drift detail');
    // a version fallback uses the server sentence, because Build repeats
    // the same fallback and must not promise otherwise
    assert.match(devJs, /d\.build_state === 'version-fallback'/,
        'fallback state switches the lead');
    // the old copy accused the operator and promised a fix
    assert.ok(!devJs.includes('edited by hand?'), 'accusation is gone');
    assert.ok(!devJs.includes('re-applies'), 'false promise is gone');
    // the banner left the section it used to be inside, so hiding that
    // section cannot hide the warning — it is folded explicitly
    assert.match(devJs, /const w0 = \$\('dv-warn'\);\s*if \(w0\) w0\.hidden = true;/,
        'dev panel folds the relocated banner when there is no data');
});

test('a failed update check is a warning, not a note', () => {
    assert.match(patchesJs, /const cw = \$\('pt-catalog-warn'\);/,
        'the patches page paints the catalog warning');
    assert.match(patchesJs, /r\.tier_error_text/,
        'driven by the structured failure field');
    assert.match(patchesJs, /ptMsg\('uplift\.patches\.catalog_check_failed',/,
        'translated lead with an English fallback');
});

test('the alarm strip is sized up in the stylesheet', () => {
    const rule = at(css, '.pt-banner.pt-alert {', 'the alert rule') ;
    const body = css.slice(rule, css.indexOf('}', rule));
    assert.match(body, /font-size: 13px;/, 'one step above the meta line');
    assert.match(body, /font-weight: 600;/, 'reads as a warning');
    assert.ok(!/border-radius/.test(body),
        'no invented radius: the frame comes from .pt-banner.pt-drift');
});

test('locale contract: both keys exist in all ten catalogs', () => {
    assert.equal(LOCALES.length, 10, 'unexpected locale set: ' + LOCALES);
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
    for (const f of LOCALES) {
        const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8'));
        const lead = d['uplift.patches.dev_drift_banner'];
        const cat = d['uplift.patches.catalog_check_failed'];
        assert.ok(lead && lead.length > 8, f + ': dev_drift_banner missing');
        assert.ok(cat && cat.length > 8, f + ': catalog_check_failed missing');
        // the rewritten sentence keeps the fact and drops the accusation
        assert.ok(!/hand|ručně|手動|직접|a mano|mão|вручную/.test(lead),
            f + ': drift lead still blames the operator: ' + lead);
        assert.ok(!/next Build|Příští Build|次の Build|다음 Build|siguiente Build|prochain Build|próximo Build|Следующая сборка|下次/.test(lead),
            f + ': drift lead still promises a fix: ' + lead);
        if (f !== 'en.json') {
            assert.notEqual(cat, en['uplift.patches.catalog_check_failed'],
                f + ': catalog warning left untranslated');
            assert.notEqual(lead, en['uplift.patches.dev_drift_banner'],
                f + ': drift lead left untranslated');
        }
    }
    // the English fallback literal in the JS must match en.json
    const i = patchesJs.indexOf("ptMsg('uplift.patches.catalog_check_failed'");
    assert.notEqual(i, -1, 'ptMsg call present');
    const seg = patchesJs.slice(i, patchesJs.indexOf('+ \' \' + te', i));
    const lits = (seg.match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1));
    assert.ok(lits.length > 1, 'fallback string literals parsed: ' + lits.length);
    assert.equal(lits.slice(1).join(''), en['uplift.patches.catalog_check_failed'],
        'JS fallback text must equal en.json (the catalog repaints over it)');
});
