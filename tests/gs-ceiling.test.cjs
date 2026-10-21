/* MGC-1 (user 2026-10-21): "it is not possible to set a custom memory
   guard ceiling for the first time" — the ceiling row was gated on the
   SAVED tier (gsGet), so picking Custom queued the edit without ever
   materialising the row, and SAVE 400'd (vanilla: the ceiling must be > 0
   for tier=custom). Chicken-and-egg, first-time setting impossible.
   Pinned here (functions sliced VERBATIM from the repository's own
   uplift_gsys.js; the vm body concatenates ONLY checked-in source plus
   inert fixtures — new Function carries no external input):
   - the gate context follows the QUEUED tier, not the server baseline
     (same for claude_code mode / gdn storage / precision — one doctrine:
     'queued-but-unsaved edits win over the server baseline');
   - the unset ceiling seeds at 80% of physical RAM (the server's own auto
     policy; system.total_memory_bytes rides the same payload), rounded
     DOWN to whole GiB, floor 1;
   - a stored/typed value is never overwritten; no RAM number -> no seed;
   - the seed lands as an ordinary staged edit (gsQueueSave), so SAVE
     sends it and the CHANGES list shows it;
   - the spec row wires the seed via attach (source-shape pin). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');
const { GS_MAP } = require(path.join(STATIC_DIR, 'uplift_gspec.js'));

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_gsys.js'), 'utf8');

function sliceFn(name) {
    // brace-walk the VERBATIM function text (no unbalanced braces in the
    // bodies sliced here — every string brace is balanced)
    const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
    assert.ok(m, 'slice anchor ' + name);
    const i = m.index;
    let depth = 0, j = src.indexOf('{', i);
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(depth === 0, 'balanced slice ' + name);
    return src.slice(i, j + 1);
}

function load(gs) {
    const st = { queued: [] };
    const ctx = vm.createContext({
        console, JSON, Math, Number, Object, Array, String, Boolean, RegExp, Set,
        GS: gs, gsDirty: {}, GS_MAP,
        gsQueueSave: (f, v) => { ctx.gsDirty[f] = v; st.queued.push([f, v]); },
    });
    vm.runInContext([
        sliceFn('gsGet'),
        sliceFn('gsEffFlat'),
        sliceFn('gsGdnEff'),
        sliceFn('gsCtxNow'),
        sliceFn('gsCeilingDefault'),
        sliceFn('gsCeilingSeed'),
        'var API = { ctx: () => gsCtxNow(), seed: (ctl) => gsCeilingSeed(ctl), '
        + 'def: () => gsCeilingDefault(), dirty: () => gsDirty, '
        + 'eff: (f) => gsEffFlat(f) };',
    ].join('\n\n'), ctx, { filename: 'gs-ceiling.slice.js' });
    return { api: ctx.API, st, ctx };
}

const GiB = 1024 * 1024 * 1024;
const GS32 = { memory: { memory_guard_tier: 'balanced',
    memory_guard_custom_ceiling_gb: 0 },
    system: { total_memory_bytes: 32 * GiB } };

test('MGC-1: the gate context follows the QUEUED tier', () => {
    const { api, ctx } = load(GS32);
    assert.equal(api.ctx().tier, 'balanced', 'baseline reads through');
    ctx.gsDirty.memory_guard_tier = 'custom';        // select staged, NOT saved
    assert.equal(api.ctx().tier, 'custom',
        'the row gate follows the staged edit (this was the deadlock)');
    // same doctrine for the other gated contexts
    ctx.gsDirty.claude_code_mode = 'cloud';
    assert.equal(api.ctx().ccLocal, false, 'cc gate follows the queue too');
    ctx.gsDirty.gdn_snapshot_storage = 'ssd_sidecar';
    assert.equal(api.ctx().gdn, 'ssd_sidecar');
});

test('MGC-1: the unset ceiling seeds 80% of RAM, floor 1 GiB', () => {
    assert.equal(load(GS32).api.def(), 25, '32 GiB -> 25 (25.6 floored)');
    const small = JSON.parse(JSON.stringify(GS32));
    small.system.total_memory_bytes = Math.round(1.4 * GiB);
    assert.equal(load(small).api.def(), 1, 'a tiny box still gets a legal >= 1');
    const noRam = JSON.parse(JSON.stringify(GS32));
    delete noRam.system.total_memory_bytes;
    assert.equal(load(noRam).api.def(), null, 'unknown RAM: no guessing');
});

test('MGC-1: the seed queues a staged edit and never overwrites a value', () => {
    const { api, st, ctx } = load(GS32);
    const ctl = { value: '' };
    api.seed(ctl);
    assert.equal(ctl.value, '25', 'the input shows the default immediately');
    assert.deepEqual(st.queued, [['memory_guard_custom_ceiling_gb', 25]],
        'SAVE will carry it (staged like any edit, dirty chip included)');
    // a second materialisation (re-render) must not re-queue or retype
    const again = { value: '' };
    api.seed(again);
    assert.equal(again.value, '', 'already staged: hands off');
    assert.equal(st.queued.length, 1);
    // user-typed value wins over the seed
    const typed = JSON.parse(JSON.stringify(GS32));
    const h2 = load(typed);
    h2.ctx.gsDirty.memory_guard_tier = 'custom';
    h2.ctx.gsDirty.memory_guard_custom_ceiling_gb = 10;
    const c2 = { value: '10' };
    h2.api.seed(c2);
    assert.equal(c2.value, '10', 'never overwrites what the user staged');
    // a stored > 0 baseline also wins
    const saved = JSON.parse(JSON.stringify(GS32));
    saved.memory.memory_guard_custom_ceiling_gb = 12;
    const h3 = load(saved);
    const c3 = { value: '12' };
    h3.api.seed(c3);
    assert.equal(c3.value, '12');
    assert.deepEqual(h3.st.queued, [], 'no phantom edit on a saved value');
});

test('MGC-1: the row wires the seed and the gate (source-shape pin)', () => {
    const spec = src.slice(src.indexOf("{sec: 'res', lab: 'res.custom'"),
        src.indexOf("{env: ['scheduler', 'memory']}"));
    assert.match(spec, /show:\s*\(ctx\)\s*=>\s*ctx\.tier === 'custom'/,
        'the row still gates on the tier context');
    assert.match(spec, /attach:\s*gsCeilingSeed/,
        'materialising the row runs the seed hook');
    // the OLD stale-baseline gate must stay dead in BOTH paths
    assert.ok(!/tier:\s*gsGet\(/.test(src),
        'no ctx may read the tier from the server baseline again');
});
