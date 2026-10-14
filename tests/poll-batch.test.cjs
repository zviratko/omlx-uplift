/* POLL-BATCH (user 2026-10-14: "several requests/s while sitting in stats,
   and polling models/profiles/model-index in the Model Manager").

   Pinned contracts:
   - the metric grid fetches ONE /metrics/series per WINDOW (union of the
     visible cards' keys), not one per card — lease key 'W|<w>', shared
     response redraws the whole window (drawWindow)
   - the GATED-EMPTY rules survive inside metricFetch verbatim (the pin in
     tests/uplift.test.cjs guards them; re-asserted here because the union
     widened the key set they apply to)
   - parked gated cards contribute NO keys to a window union
   - the Manager 8 s tick stays soft: model-settings-index refetches only
     force-or-older-than-TTL; profile-templates paints from cache the same
     way; tab entry (applyTab) forces a full side-load; every template
     WRITE path invalidates (box delete, editor save = render(true),
     snapshot-create = mmTemplates.invalidate())
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');

test('POLL-BATCH: metric window fetch is one request per window', () => {
    const s = src('uplift_charts.js');
    assert.match(s, /function windowKeys\(w\) \{/, 'union helper exists');
    assert.match(s, /const keys = windowKeys\(w\);/,
        'metricFetch requests the WINDOW union');
    assert.match(s, /const sk = 'W\|' \+ w;/,
        'one in-flight lease per window');
    assert.match(s, /if \(_seq\[sk\] === seq\) drawWindow\(w\);/,
        'the shared response redraws every card of the window');
    // parked gated cards contribute no keys and start no fetches
    assert.match(s, /function windowKeys\(w\) \{[\s\S]*?_gateHidden\(ce\.def\)\) continue;/,
        'hidden gated cards stay out of the union');
    // the per-card fresh path still draws its own card
    assert.match(s, /if \(!force && !stale && !missing\) \{ drawMetricChart\(id\); return; \}/,
        'fast path keeps the per-card draw');
});

test('POLL-BATCH: Manager side-loads are TTL-cached, entry and writes force', () => {
    const t = src('uplift_mmtable.js');
    assert.match(t, /const IDX_TTL_MS = 60000;/, 'index TTL declared');
    assert.match(t, /if \(onManager && \(force \|\| Date\.now\(\) - _idxAt > IDX_TTL_MS\)\)/,
        'settings-index refetches only force-or-stale');
    assert.match(t, /MM_TPL\.render\(force\)/,
        'the templates box inherits the force flag');
    const m = src('uplift_mmtemplates.js');
    assert.match(m, /const TPL_TTL_MS = 60000;/, 'template TTL declared');
    assert.match(m, /if \(_tpl && !force && Date\.now\(\) - _tplAt <= TPL_TTL_MS\) \{ paint\(_tpl\); return; \}/,
        'soft render paints from cache');
    assert.match(m, /_tpl = null;   \/\/ POLL-BATCH: a delete IS a write — invalidate/,
        'the box delete invalidates the cache');
    assert.match(m, /invalidate: \(\) => \{ _tpl = null; \}/,
        'invalidate is exported for other write paths');
    const ed = src('uplift_mmeditor.js');
    assert.match(ed, /MM_TPL\.render\(true\);/,
        'template save forces a refetch');
    assert.match(ed, /if \(_tp && _tp\.invalidate\) _tp\.invalidate\(\);   \/\/ POLL-BATCH/,
        'snapshot-to-template creation invalidates');
    const u = src('uplift.js');
    assert.match(u, /MM\.render\(true\);   \/\/ POLL-BATCH: entry = full fresh side-loads/,
        'tab entry forces; the interval stays soft');
    const b = src('uplift_boot.js');
    assert.match(b, /currentTab\(\) === 'models' && !MM\.seModel\) MM\.render\(\); \}, 8000\)/,
        'the 8 s tick passes NO force (models list only)');
});
