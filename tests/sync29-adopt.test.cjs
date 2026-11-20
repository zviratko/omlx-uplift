/* SYNC-1 run 29 (upstream f50cd819 #5449 + d4f95b4b #5453): the adoption
   mirror. modelspec.test.cjs pins the SCHEMA half of the LoRA field (state,
   payload, conflicts, runtime signature). This file pins the DOM half: the
   editor row, the downloader's changed adapter rules, the bench skip reason
   and the settings copy-link key the cluster cleanup renamed. The editor row
   is hand-built DOM that no vm harness mounts (same class as the run-21 badge
   pins), so a source-shape regex is the only proof available - each test names
   the classic line it must stay adjacent to. The last test resolves every key
   this run touches against the mirror tip, because a renamed classic key fails
   LOUD: it silently falls back to English instead of erroring. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const STATIC = p => fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', p), 'utf8');

/* ---- the model-settings row ---- */
test('lora row: reads the adapter list from the new per-model endpoint', () => {
    const src = STATIC('uplift_mmeditor.js');
    assert.match(src,
        /async function loadLoraAdapters\(model\) \{[\s\S]{0,400}?\/admin\/api\/models\/\$\{encodeURIComponent\(model\)\}\/lora-adapters/,
        'classic fills its picker from GET /admin/api/models/{id}/lora-adapters (dashboard.js:1921)');
    // the list is per model: a cached payload for another id must never paint
    // this row (classic resets loraAdapters on every open)
    assert.match(src, /LORA_ADAPTERS = \{ model: model, adapters: \[\] \};/,
        'the cache is armed empty for the model being opened');
    assert.match(src, /LORA_ADAPTERS && LORA_ADAPTERS\.model === seModel/,
        'every read checks the cache belongs to the model in the editor');
    // classic awaits it inside the modal-open sequence (dashboard.js:3122)
    assert.match(src,
        /await loadGrammarParsers\(\)\.catch\(\(\) => \{\}\);[\s\S]{0,240}?await loadLoraAdapters\(model\)\.catch\(\(\) => \{\}\);/,
        'the list is loaded before the form renders, so the row paints complete');
});

test('lora row: sits after the kwargs block, diffusion-gated like classic', () => {
    const src = STATIC('uplift_mmeditor.js');
    // classic: the row is the last block of the kwargs container, x-show =
    // !modelSettings.is_diffusion_model (_modal_model_settings.html:1365)
    const kw = src.indexOf("kwh.className = 'se-subhead'");
    // the gate that opens the kwargs container is the nearest one above it
    const gate = src.lastIndexOf("if (!S.isDiffusion(m)) {", kw);
    const end = src.indexOf("section('Experimental Features')");
    assert.ok(gate > 0 && kw > gate && end > kw, 'kwargs gate, block and next section found');
    const after = src.slice(gate, end);
    assert.ok(after.indexOf('renderCtKwargs(sect.__body)') < after.indexOf("'lora_adapter'"),
        'the adapter row follows the chat-template kwargs block, as classic orders it');
    assert.match(after, /if \(!S\.isDiffusion\(m\)\) \{[\s\S]*?'lora_adapter'/,
        'the row lives inside the diffusion gate, never outside it');
});

test('lora row: labels come from the mounted classic catalog, zero new keys', () => {
    const src = STATIC('uplift_mmeditor.js');
    for (const key of ['lora_adapter', 'lora_adapter_hint', 'lora_adapter_none',
                       'lora_adapter_info', 'lora_adapter_empty'])
        assert.ok(src.includes("C.tf('modal.model_settings." + key + "'"),
            'missing classic label key: ' + key);
    // an uplift-invented key would need the same entry in all 10 locale files;
    // this mirror must not add one
    assert.ok(!src.includes("'uplift.se.lora_adapter'")
              && !src.includes("'uplift.ui.lora"),
        'no uplift-only locale key was minted');
});

test('lora row: an unusable adapter is disabled unless it is the saved pick', () => {
    const src = STATIC('uplift_mmeditor.js');
    // classic: :disabled="!!a.problem && a.path !== modelSettings.lora_adapter"
    assert.match(src, /if \(a && a\.problem && a\.path !== cur\) el\.disabled = true;/,
        'the option stays visible so the stored value never silently vanishes');
    // classic loraAdapterOptions: a saved path outside the folders still shows
    assert.match(src,
        /const listed = cur && !adapters\.some\(a => a\.path === cur\)[\s\S]{0,90}id: cur, path: cur, problem: null/,
        'an off-folder saved path is prepended as a selectable row');
    // classic loraAdapterLabel: id · r<rank> · <size>
    assert.match(src, /'r' \+ a\.rank/, 'the rank and size ride the option label');
    assert.match(src, /a\.size_formatted \? \[a\.size_formatted\]/, 'and the formatted size too');
    // the reason line reads the LOADED list only (classic selectedLoraAdapter)
    assert.match(src,
        /const chosen = cur \? \(adapters\.find\(a => a\.path === cur\) \|\| null\) : null;/,
        'a path that is not on disk shows no info line, like classic');
});

test('lora row: the amber reason line has its own CSS rule', () => {
    const css = STATIC('uplift.css');
    const rule = css.match(/\.row-editor \.se-hint\.se-hint-warn \{[^}]*\}/);
    assert.ok(rule, 'the class the JS paints must have a rule');
    assert.match(rule[0], /var\(--warn\)/, 'house token, same amber family as classic');
});

/* ---- the downloader: adapters became ordinary downloads ---- */
test('download: the dead lora_warning key is gone and lora_info replaces it', () => {
    const src = STATIC('uplift_downloader.js');
    // upstream f50cd819 RENAMED the catalog key; the old literal therefore
    // resolved to nothing and the stale English fallback told the user a
    // supported thing was 'not supported'. (The key may still appear in the
    // comment that explains the rename - what must never come back is a call.)
    assert.ok(!/C\.tf\(['"]models\.detail\.lora_warning/.test(src),
        'negative pin: no lookup of the deleted classic key');
    assert.match(src,
        /dlBadge\('info', C\.tf\("models\.detail\.lora_info",\s*\n\s*"LoRA adapter: choose it in a model's Advanced Settings"\)\)/,
        'neutral info badge, classic\'s exact wording through the mounted catalog');
});

test('download: an adapter keeps its download controls and the space check', () => {
    const src = STATIC('uplift_downloader.js');
    // classic dropped every is_adapter exclusion in the detail footer
    assert.ok(!/if \(!detail\.is_adapter && !HFS\.fits/.test(src),
        'negative pin: the free-space warning no longer skips adapters');
    assert.match(src, /if \(!HFS\.fits\(detail, spaceBytes\)\) \{/,
        'the space warning runs for every repo shape');
    // the info badge must NOT short-circuit the download chain: an
    // `else if` here would leave an adapter with no Download button
    assert.match(src,
        /if \(detail\.is_adapter\) \{[\s\S]{0,200}?\}\s*\n\s*if \(detail\.unsupported_reason\) \{/,
        'the adapter badge is its own statement, the chain starts fresh after it');
    // classic hfShowsUpdate lost the is_adapter term too
    assert.match(src,
        /showsUpdate\(detail, downloaded\) \{\s*\n\s*return !!\(detail && !detail\.unsupported_reason/,
        'a downloaded adapter with Hub changes offers Update like any checkpoint');
    assert.ok(!/showsUpdate\(detail, downloaded\) \{\s*\n\s*return !!\(detail && !detail\.is_adapter/.test(src),
        'negative pin: no adapter exclusion left in showsUpdate');
});

/* ---- the throughput bench: the fifth upload-skip reason ---- */
test('bench: a LoRA run names its upload skip instead of the generic line', () => {
    const src = STATIC('uplift_bench_tp.js');
    assert.match(src,
        /lora_adapter: \['bench\.upload_skipped\.reason_lora_adapter',/,
        'classic added the reason to benchUploadSkippedLabel (dashboard.js:6109)');
    const map = src.slice(src.indexOf('uploadSkippedLabel: function'),
        src.indexOf('renderStatus: function'));
    for (const r of ['external_endpoint', 'splash', 'ane_aligned_prompt',
                     'custom_generation_length', 'lora_adapter'])
        assert.ok(map.includes(r + ': ['), 'skip-reason map lost an entry: ' + r);
});

/* ---- the settings copy-link key the cluster cleanup renamed ---- */
test('gsys: the copy-link flash uses the surviving cluster key', () => {
    const src = STATIC('uplift_gsys.js');
    // upstream d4f95b4b deleted the v1 console and with it the v2 cluster i18n
    // tier; a lookup of a dead key returns the EN fallback, so a Czech board
    // kept reading the English 'Copied!' after the copy-link flash.
    assert.ok(!/cluster[.]v2[.]/.test(src),
        'negative pin: no reference to the deleted v2 cluster namespace');
    assert.match(src, /C\.tf\('cluster\.common\.copied', 'Copied!'\)/);
});

test('run 29: the mirror tip carries every classic key this run wired in', () => {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const mirror = process.env.OMLX_SRC || path.join(os.homedir(), 'git', 'omlx-upstream');
    if (!fs.existsSync(path.join(mirror, 'omlx', 'admin', 'routes.py'))) return; // no checkout
    const en = JSON.parse(execFileSync('git',
        ['-C', mirror, 'show', 'HEAD:apps/omlx-web/omlx_web/i18n/en.json']).toString());
    const keys = [
        'modal.model_settings.lora_adapter', 'modal.model_settings.lora_adapter_hint',
        'modal.model_settings.lora_adapter_none', 'modal.model_settings.lora_adapter_info',
        'modal.model_settings.lora_adapter_empty',
        'models.detail.lora_info', 'bench.upload_skipped.reason_lora_adapter',
        'cluster.common.copied',
    ];
    for (const k of keys)
        assert.ok(typeof en[k] === 'string' && en[k].length > 0,
            'classic catalog is missing the key uplift reads: ' + k);
    // the keys uplift STOPPED reading must really be gone, or the negative pins
    // above would pass against a catalog that still ships them
    for (const dead of ['models.detail.lora_warning', 'cluster.v2.common.copied'])
        assert.ok(!(dead in en), 'renamed-away key is still in the catalog: ' + dead);
});
