/* P1A-7 parity drift test: classic GlobalSettingsRequest schema keys vs the
   Uplift dashboard's save payload (GS_MAP + integration keys).
   Fails when upstream adds/renames a settings key that Uplift does not carry.
   node --test tests/globalspec.test.cjs

   SYNC-1 (2026-10-06) gate repair. REPO-1 made this suite skip SILENTLY:
   HAS_CLASSIC demanded OMLX_SRC (never set) AND scripts/uplift-mock.py —
   the dev-gateway mock, never ported and dead since (the package owns the
   gateway now; only this test referenced GS_FLAT_MAP). Nightly reported a
   comfortable `skip:3` while real drift accumulated: integrations_dsh_model
   (#3950), gpu_keep_warm_interval, the 'decision' model type (#4315).
   Repointed: any classic checkout satisfies the gate — OMLX_SRC override,
   else the plain upstream mirror ~/git/omlx-upstream, else the old monorepo
   ../../.. — and the bare integration keys come from classic's own
   saveIntegrationSettings() body in dashboard.js, not the mock. The
   GS_FLAT_MAP shadow test died with the gateway mock it guarded. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { allStaticJs } = require('./static-src.cjs');
function classicRoot() {
    const cands = [process.env.OMLX_SRC,
        path.join(os.homedir(), 'git', 'omlx-upstream'),
        path.join(__dirname, '..', '..', '..')];
    for (const c of cands) {
        if (c && fs.existsSync(path.join(c, 'omlx', 'admin', 'routes.py'))
             && fs.existsSync(path.join(c, 'omlx', 'admin', 'static', 'js', 'dashboard.js')))
            return c;
    }
    return null;
}
const ROOT = classicRoot();
const HAS_CLASSIC = ROOT !== null;
const routes = HAS_CLASSIC ? fs.readFileSync(path.join(ROOT, 'omlx/admin/routes.py'), 'utf8') : '';
const dashJs = HAS_CLASSIC ? fs.readFileSync(path.join(ROOT, 'omlx/admin/static/js/dashboard.js'), 'utf8') : '';
// PH2-1 stage 0: read the whole static JS surface, not uplift.js by name —
// the split into per-section files must not blind this drift test.
const uplift = allStaticJs();
const modelspec = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'modelspec.js'), 'utf8');

/* ---- schema keys from a pydantic request class ---- */
function schemaKeys(cls) {
    const m = routes.match(new RegExp('^class ' + cls + '\\(BaseModel\\):([\\s\\S]*?)\\n(?=class |def |@)', 'm'));
    assert.ok(m, cls + ' class found in routes.py');
    const keys = [];
    for (const line of m[1].split('\n')) {
        const f = line.match(/^\s{4}([a-z_0-9]+)\s*:\s*\S/);
        if (f) keys.push(f[1]);
    }
    return keys;
}

/* ---- classic bare integration keys, from its own save payload ---- */
/* saveIntegrationSettings() posts integrations_* prefixed keys plus the
   markitdown and web_search families BARE (real oMLX drops unknown fields
   with a silent success:true). Derive BOTH lists from that own body so a
   new upstream integration row cannot hide: every 'integrations_X' arg is
   prefixed, every other flat key is bare. */
function classicIntegrationKeys() {
    const m = dashJs.match(/async saveIntegrationSettings\(\)[\s\S]*?body: JSON\.stringify\(\{([\s\S]*?)\}\)/);
    assert.ok(m, 'saveIntegrationSettings() body found in classic dashboard.js');
    const prefixed = [], bare = [];
    for (const k of [...m[1].matchAll(/([a-z_0-9]+)\s*:/g)].map(x => x[1])) {
        (k.startsWith('integrations_') ? prefixed : bare).push(k);
    }
    return { prefixed: prefixed.map(k => k.slice('integrations_'.length)), bare };
}

/* ---- uplift save payload keys ---- */
/* TST-1: GS_MAP / GS_PAYLOAD_SKIP / INTEG_PREFIXED ship in the UMD module
   uplift_gspec.js — require() the contract instead of brace-walking and
   eval()ing source text. */
const GSPEC = require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_gspec.js'));

test('GS_MAP + integration keys cover the full GlobalSettingsRequest schema', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC or create ~/git/omlx-upstream)' }, () => {
    const gsMap = GSPEC.GS_MAP;
    const skip = GSPEC.GS_PAYLOAD_SKIP;
    const integ = classicIntegrationKeys();
    // cross-check: Uplift's prefixed set must match classic's exactly —
    // an upstream integration row added to the save body lands here too.
    assert.deepStrictEqual([...GSPEC.INTEG_PREFIXED].sort(), [...integ.prefixed].sort(),
        'INTEG_PREFIXED diverged from classic saveIntegrationSettings() prefixed keys');
    const carried = new Set([...Object.keys(gsMap),
        ...integ.prefixed.map(k => 'integrations_' + k), ...integ.bare]);
    const missing = schemaKeys('GlobalSettingsRequest').filter(k => !carried.has(k) && !skip.has(k));
    // Deliberate exclusions, mirroring classic saveGlobalSettings():
    // model_dir is deprecated (model_dirs supersedes it) and
    // gdn_ssd_split_enabled is legacy — upstream 400s when it arrives
    // together with gdn_snapshot_storage, which is always sent.
    const LEGACY = new Set(['model_dir', 'gdn_ssd_split_enabled']);
    assert.deepStrictEqual(missing.filter(k => !LEGACY.has(k)), [],
        `schema keys missing from Uplift save payload: ${missing.join(', ')}`);
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
test('ModelSettingsRequest fields stay reachable in the Uplift editor', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC or create ~/git/omlx-upstream)' }, () => {
    const fields = schemaKeys('ModelSettingsRequest');
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

// SYNC-1: the classic model_type_override enum must stay mirrored in
// modelspec MODEL_TYPE_OPTIONS (upstream adds a value per new model family;
// #4315 'decision' was the one that taught this test to exist).
test('MODEL_TYPE_OPTIONS mirrors the classic model-type <option> list', { skip: !HAS_CLASSIC && 'no classic checkout (set OMLX_SRC or create ~/git/omlx-upstream)' }, () => {
    const tpl = fs.readFileSync(path.join(ROOT, 'omlx/admin/templates/dashboard/_modal_model_settings.html'), 'utf8');
    const classic = [...tpl.matchAll(/<option value="([a-z_]+)">\{\{ t\('modal\.model_settings\.model_type/g)]
        .map(x => x[1]);
    assert.ok(classic.length >= 5, 'classic option list parsed');
    const S = require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'modelspec.js'));
    const missing = classic.filter(v => !S.MODEL_TYPE_OPTIONS.includes(v));
    assert.deepStrictEqual(missing, [],
        `classic model types missing from MODEL_TYPE_OPTIONS: ${missing.join(', ')}`);
});

// P1A-7 interop: Uplift-style global-settings round-trip against the REAL
// oMLX must leave settings.json untouched. Skips (exit 2) when no local
// oMLX answers, so CI without a running server stays green.
test('global-settings round-trip is a no-op on the real server', { timeout: 30000 }, () => {
    const { spawnSync } = require('child_process');
    // CI-4: ROOT is null without a classic checkout (GitHub runner) —
    // path.join(null, …) threw BEFORE the intended graceful skip. Candidate
    // #1 only exists when classic is there; the repo-local copy below is
    // what CI runs (it self-skips exit 2 when no oMLX answers).
    const script = [ROOT && require('path').join(ROOT, 'tests', 'ui', 'p1a7_interop.py'),
                    require('path').join(__dirname, '..', 'tests', 'ui', 'p1a7_interop.py'),
                    require('path').join(__dirname, '..', '..', '..', 'tests', 'ui', 'p1a7_interop.py')].find(fs.existsSync);
    if (!script) { console.log('interop SKIP: p1a7_interop.py not found'); return; }
    const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 25000 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 2) { console.log('interop SKIP:', out.trim()); return; }
    assert.strictEqual(r.status, 0, 'interop round-trip failed:\n' + out);
});
