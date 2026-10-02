/* P1A-7 parity drift test: classic GlobalSettingsRequest schema keys vs the
   Uplift dashboard's save payload (GS_MAP + helper-page integration keys).
   Fails when upstream adds/renames a settings key that Uplift does not carry.
   node --test tests/globalspec.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { allStaticJs } = require('./static-src.cjs');
// REPO-1: standalone repo has no classic checkout next door. OMLX_SRC points
// at one (monorepo: default ../../.. still works); without it the drift
// checks skip so a bare clone stays green.
const ROOT = process.env.OMLX_SRC || path.join(__dirname, '..', '..', '..');
const ROUTES_FILE = path.join(ROOT, 'omlx/admin/routes.py');
const HAS_CLASSIC = fs.existsSync(ROUTES_FILE) && fs.existsSync(path.join(ROOT, 'scripts', 'uplift-mock.py'));
const routes = HAS_CLASSIC ? fs.readFileSync(ROUTES_FILE, 'utf8') : '';
// PH2-1 stage 0: read the whole static JS surface, not uplift.js by name —
// the split into per-section files must not blind this drift test.
const uplift = allStaticJs();
const mock = HAS_CLASSIC ? fs.readFileSync(path.join(ROOT, 'scripts', 'uplift-mock.py'), 'utf8') : '';
const modelspec = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'modelspec.js'), 'utf8');

/* ---- schema keys from GlobalSettingsRequest ---- */
function schemaKeys() {
    const m = routes.match(/class GlobalSettingsRequest\(BaseModel\):([\s\S]*?)\n\nclass /);
    assert.ok(m, 'GlobalSettingsRequest class found in routes.py');
    const body = m[1];
    const keys = [];
    for (const line of body.split('\n')) {
        const f = line.match(/^\s{4}([a-z_0-9]+)\s*:\s*\S/);
        if (f) keys.push(f[1]);
    }
    return keys;
}

/* ---- uplift save payload keys ---- */
/* TST-1: GS_MAP / GS_PAYLOAD_SKIP / INTEG_PREFIXED ship in the UMD module
   uplift_gspec.js — require() the contract instead of brace-walking and
   eval()ing source text. mock's GS_FLAT_MAP stays regex-parsed (python). */
const GSPEC = require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_gspec.js'));

test('GS_MAP + integration keys cover the full GlobalSettingsRequest schema', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC)' }, () => {
    const gsMap = GSPEC.GS_MAP;
    const skip = GSPEC.GS_PAYLOAD_SKIP;
    const prefixed = [...GSPEC.INTEG_PREFIXED].map(k => 'integrations_' + k);
    // markitdown_* / web_search_* are saved bare and are schema keys verbatim
    const bareKeys = [...mock.matchAll(/INTEGRATION_BARE_KEYS = \{([\s\S]*?)\}/g)][0];
    const carried = new Set([...Object.keys(gsMap), ...prefixed,
        ...[...bareKeys[1].matchAll(/"([a-z_0-9]+)"/g)].map(x => x[1])]);
    const missing = schemaKeys().filter(k => !carried.has(k) && !skip.has(k));
    // Deliberate exclusions, mirroring classic saveGlobalSettings():
    // model_dir is deprecated (model_dirs supersedes it) and
    // gdn_ssd_split_enabled is legacy — upstream 400s when it arrives
    // together with gdn_snapshot_storage, which is always sent.
    const LEGACY = new Set(['model_dir', 'gdn_ssd_split_enabled']);
    assert.deepStrictEqual(missing.filter(k => !LEGACY.has(k)), [],
        `schema keys missing from Uplift save payload: ${missing.join(', ')}`);
});

test('gateway GS_FLAT_MAP keeps every GS_MAP key it must overlay in shadow mode', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC)' }, () => {
    const gsMap = GSPEC.GS_MAP;
    const m = mock.match(/GS_FLAT_MAP = \{([\s\S]*?)\n\}/);
    assert.ok(m, 'GS_FLAT_MAP found in uplift-mock.py');
    const flatKeys = [...m[1].matchAll(/"([a-z_0-9]+)":/g)].map(x => x[1]);
    const apiKeys = ['api_key', 'ui_language', 'idle_timeout_seconds']; // handled elsewhere in the mock
    const missing = Object.keys(gsMap).filter(k => !flatKeys.includes(k) && !apiKeys.includes(k));
    assert.deepStrictEqual(missing, [], `GS_FLAT_MAP missing overlay keys: ${missing.join(', ')}`);
});

test('payload skip list stays minimal', () => {
    const skip = GSPEC.GS_PAYLOAD_SKIP;
    // ui_dashboard_layout: classic's saved block layout — Uplift must not
    // round-trip it (omitting = "keep" server-side). Everything else in
    // the GlobalSettingsRequest schema must stay MAPPED and reachable.
    assert.deepStrictEqual([...skip].sort(),
        ['api_key', 'base_path', 'ui_dashboard_layout']);
});

// P1A-8: model-settings editor parity. Every ModelSettingsRequest field must
// be reachable in the Uplift editor (modelspec.js / uplift.js) unless it is a
// deliberate exclusion with its classic counterpart recorded here.
test('ModelSettingsRequest fields stay reachable in the Uplift editor', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC)' }, () => {
    const m = routes.match(/class ModelSettingsRequest\(BaseModel\):([\s\S]*?)\n\n(?:@|class )/);
    assert.ok(m, 'ModelSettingsRequest class found in routes.py');
    const fields = [...m[1].matchAll(/^ {4}([a-z_0-9]+)\s*:/gm)].map(x => x[1]);
    const ms = uplift + modelspec;
    // is_pinned is toggled from the model row (is_pinned via PUT settings,
    // classic parity), not the editor modal. Upstream split the legacy
    // mtp_num_draft_tokens into mtp_adaptive_max_depth + mtp_fixed_depth
    // (jundot merge 2026-09); both carry editor widgets now.
    const allow = new Set(['is_pinned']);
    const missing = fields.filter(f => !allow.has(f) && !ms.includes(f));
    assert.deepStrictEqual(missing, [],
        `model-settings fields missing from Uplift editor: ${missing.join(', ')}`);
});

// P1A-7 interop: Uplift-style global-settings round-trip against the REAL
// oMLX must leave settings.json untouched. Skips (exit 2) when no local
// oMLX answers, so CI without a running server stays green.
test('global-settings round-trip is a no-op on the real server', { timeout: 30000 }, () => {
    const { spawnSync } = require('child_process');
    const script = [require('path').join(ROOT, 'tests', 'ui', 'p1a7_interop.py'), require('path').join(__dirname, '..', '..', '..', 'tests', 'ui', 'p1a7_interop.py')].find(fs.existsSync);
    if (!script) { console.log('interop SKIP: p1a7_interop.py not found (standalone repo)'); return; }
    const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 25000 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 2) { console.log('interop SKIP:', out.trim()); return; }
    assert.strictEqual(r.status, 0, 'interop round-trip failed:\n' + out);
});
