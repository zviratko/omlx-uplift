/* UP-41 (FEAT-1 parity): global-settings UX polish — pure logic + source
   pins. The extractable halves (host preset mapping, cache %<->size
   strings, memory-guard readouts, deep-link parsing) live in
   uplift_gspec.js (UMD, required directly); the DOM wiring in
   uplift_gsys.js is pinned by source shape (settled rule for this repo's
   harness-less hand-built forms). Classic refs cite
   apps/omlx-web/omlx_web/static/js/dashboard.js and
   templates/dashboard/_settings.html at the SYNC-1 tracked tip. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const G = require(path.join(STATIC_DIR, 'uplift_gspec.js'));
const gsys = fs.readFileSync(path.join(STATIC_DIR, 'uplift_gsys.js'), 'utf8');
const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
const GB = 1024 ** 3;

/* ---- item 8: host preset (classic _settings.html:311-321) ------------- */
test('hostPresetOf maps binds to classic presets, everything else custom', () => {
    assert.strictEqual(G.hostPresetOf('127.0.0.1'), 'localhost');
    assert.strictEqual(G.hostPresetOf(' 127.0.0.1 '), 'localhost');
    assert.strictEqual(G.hostPresetOf('0.0.0.0'), 'public');
    // custom covers blank, real addresses and comma lists (UP-19 multi-host)
    assert.strictEqual(G.hostPresetOf(''), 'custom');
    assert.strictEqual(G.hostPresetOf(null), 'custom');
    assert.strictEqual(G.hostPresetOf('192.168.1.5'), 'custom');
    assert.strictEqual(G.hostPresetOf('127.0.0.1,::1'), 'custom');
    assert.strictEqual(G.hostPresetOf('localhost'), 'custom');
});
test('hostPresetValue writes classic\'s exact preset values', () => {
    assert.strictEqual(G.hostPresetValue('localhost'), '127.0.0.1');
    assert.strictEqual(G.hostPresetValue('public'), '0.0.0.0');
    assert.strictEqual(G.hostPresetValue('custom'), '');   // blank: user types
});

/* ---- item 10: cache % <-> size strings (classic 6500-6772) ------------ */
test('size parse: units, junk, classic GB rounding', () => {
    assert.strictEqual(G.sizeToBytes('64GB'), 64 * GB);
    assert.strictEqual(G.sizeToBytes('512MB'), 512 * 1024 * 1024);
    assert.strictEqual(G.sizeToBytes('2TB'), 2 * 1024 * GB);
    assert.strictEqual(G.sizeToBytes('8'), 8 * GB);          // unitless = GB
    assert.strictEqual(G.sizeToBytes('auto'), null);
    assert.strictEqual(G.sizeToBytes(''), null);
    assert.strictEqual(G.parseSettingsGB('68GB'), 68);
    assert.strictEqual(G.parseSettingsGB('1TB'), 1024);
    assert.strictEqual(G.parseSettingsGB('512MB'), 1);
    // classic _parseSettingsGB quirk: sub-half-GB MB values round to 0
    assert.strictEqual(G.parseSettingsGB('100MB'), 0);
    assert.strictEqual(G.parseSettingsGB(null), null);
});
test('cold cache percent: 10 default, auto/blank fallback, 100 clamp', () => {
    assert.strictEqual(G.cachePercentOf('64GB', 640 * GB), 10);
    assert.strictEqual(G.cachePercentOf('auto', 640 * GB), 10);   // classic default
    assert.strictEqual(G.cachePercentOf('', 640 * GB), 10);
    assert.strictEqual(G.cachePercentOf('64GB', 0), 10);          // unknown disk
    assert.strictEqual(G.cachePercentOf('999GB', 640 * GB), 100); // clamped
});
test('cold cache percent -> string: floor GB, auto when disk unknown', () => {
    assert.strictEqual(G.percentToCacheString(10, 1024 * GB), '102GB');
    assert.strictEqual(G.percentToCacheString(50, 100 * GB), '50GB');
    assert.strictEqual(G.percentToCacheString(10, 0), 'auto');
});
test('hot cache percent: 0 default, 50 clamp (classic 6736)', () => {
    assert.strictEqual(G.hotCachePercentOf('0', 64 * GB), 0);
    assert.strictEqual(G.hotCachePercentOf('', 64 * GB), 0);
    assert.strictEqual(G.hotCachePercentOf('8GB', 64 * GB), 13);
    assert.strictEqual(G.hotCachePercentOf('40GB', 64 * GB), 50); // clamped
    assert.strictEqual(G.hotCachePercentOf('8GB', 0), 0);
});
test('hot cache 0 = disabled; sub-GB truncates to 0 (classic 6754)', () => {
    assert.strictEqual(G.hotCacheStringFromPercent(0, 64 * GB), '0');
    assert.strictEqual(G.hotCacheStringFromPercent(13, 64 * GB), '8GB');
    // 1% of 64GB = 0.64GB -> classic floors to 0 -> '0' (DISABLED edge).
    // Pinned because the same floor runs in both dashboards.
    assert.strictEqual(G.hotCacheStringFromPercent(1, 64 * GB), '0');
    assert.strictEqual(G.hotCacheStringFromPercent(10, 0), '0');
});
test('hot cache GB input -> slider percent (classic 6679)', () => {
    assert.strictEqual(G.hotCachePercentFromGB('0', 64 * GB), 0);
    assert.strictEqual(G.hotCachePercentFromGB(8, 64 * GB), 13);
    assert.strictEqual(G.hotCachePercentFromGB(40, 64 * GB), 50);
    assert.strictEqual(G.hotCachePercentFromGB(8, 0), null);  // no denominator
});

/* ---- item 10: memory-guard readouts (classic 6553-6663) --------------- */
test('wired-limit warning + copyable sysctl fix', () => {
    const capped = { iogpu_wired_limit_bytes: 30 * GB,
                     omlx_wired_limit_request_bytes: 36 * GB };
    assert.strictEqual(G.wiredLimitWarned(capped), true);
    assert.strictEqual(G.wiredLimitCommand(capped),
        'sudo sysctl iogpu.wired_limit_mb=' + Math.ceil(36 * GB / (1024 ** 2)));
    // no kernel value / no request / kernel >= request: silent
    assert.strictEqual(G.wiredLimitWarned({}), false);
    assert.strictEqual(G.wiredLimitWarned({ iogpu_wired_limit_bytes: 0,
        omlx_wired_limit_request_bytes: 36 * GB }), false);
    assert.strictEqual(G.wiredLimitWarned({ iogpu_wired_limit_bytes: 36 * GB,
        omlx_wired_limit_request_bytes: 36 * GB }), false);
    assert.strictEqual(G.wiredLimitCommand({}), '');
});
test('guard tier description fills reserve / custom ceiling', () => {
    assert.strictEqual(
        G.guardTierText('Balanced keeps {reserve} free.', 'balanced',
            { reserve_bytes: 12 * GB }, 0), 'Balanced keeps 12.0 GB free.');
    assert.strictEqual(
        G.guardTierText('Custom: ceiling of {custom_gb} GB.', 'custom',
            null, 48), 'Custom: ceiling of 48.0 GB.');
    // missing preview -> 0.0 GB (classic Number(undefined||0) behavior)
    assert.strictEqual(
        G.guardTierText('{reserve}', 'safe', undefined, 0), '0.0 GB');
});
test('templateSegments splits placeholders into bold-able DOM segments', () => {
    const s = G.templateSegments('Free {free} + {reserve} -> {ceiling}',
        { free: '1.0 GB', ceiling: '9.0 GB' });
    assert.deepStrictEqual(s, [
        { t: 'Free ' }, { t: '1.0 GB', bold: true }, { t: ' + ' },
        { t: '{reserve}', bold: true },   // unmapped token stays literal
        { t: ' -> ' }, { t: '9.0 GB', bold: true }]);
    assert.deepStrictEqual(G.templateSegments('no tokens', {}),
        [{ t: 'no tokens' }]);
});
test('custom ceiling clamps by static/metal limits (classic 6637)', () => {
    assert.strictEqual(G.customGuardCeilingGB(64,
        { static_bytes: 48 * GB, metal_cap_bytes: 50 * GB }), 48);
    assert.strictEqual(G.customGuardCeilingGB(40,
        { static_bytes: 48 * GB, metal_cap_bytes: 50 * GB }), 40);
    assert.strictEqual(G.customGuardCeilingGB(40, {}), null);  // no clamp data
});

/* ---- items 11/12: deep-links (classic #settings-x anchors) ------------ */
test('parseGsDeepLink understands classic anchors and uplift routes', () => {
    assert.strictEqual(G.parseGsDeepLink('#settings-advanced'), 'advanced');
    assert.strictEqual(G.parseGsDeepLink('#settings-auth'), 'auth');
    // classic-only ids map onto uplift box slugs
    assert.strictEqual(G.parseGsDeepLink('#settings-resource'), 'resource_management');
    assert.strictEqual(G.parseGsDeepLink('#settings-cache'), 'resource_management');
    assert.strictEqual(G.parseGsDeepLink('#settings-network'), 'integrations');
    assert.strictEqual(G.parseGsDeepLink('#settings-appearance'), 'server');
    // uplift-native slugs round-trip; two-segment uplift route parses
    assert.strictEqual(G.parseGsDeepLink('#settings-resource_management'), 'resource_management');
    assert.strictEqual(G.parseGsDeepLink('#settings/advanced'), 'advanced');
    // plain routes are NOT deep links
    assert.strictEqual(G.parseGsDeepLink('#settings'), null);
    assert.strictEqual(G.parseGsDeepLink('#status'), null);
    assert.strictEqual(G.parseGsDeepLink(''), null);
    assert.strictEqual(G.parseGsDeepLink(undefined), null);
});
test('every classic settings anchor maps to an uplift slug; copy-link writes #settings-x', () => {
    for (const id of G.CLASSIC_SECTION_IDS) {
        const slug = G.parseGsDeepLink('#' + id);
        assert.ok(slug, id + ' resolves');
        assert.strictEqual(G.CLASSIC_TO_UPLIFT[id], slug, id + ' via map');
    }
    assert.strictEqual(G.gsSectionAnchor('advanced'), '#settings-advanced');
});

/* ---- source pins: gsys DOM wiring ------------------------------------- */
test('GS_SPEC carries the new builders (host preset, sliders, guard, scale)', () => {
    for (const anchor of ['{x: gsHostRow}', '{x: gsNumberScaleRow}',
                          '{x: gsColdCacheRow}', '{x: gsHotCacheRow}',
                          '{x: gsGuardBlock}'])
        assert.ok(gsys.includes(anchor), 'spec entry ' + anchor);
    // the old plain-text cache rows are GONE (sliders own those flats)
    assert.ok(!gsys.includes("k: 'text', field: 'ssd_cache_max_size'"));
    assert.ok(!gsys.includes("k: 'text', field: 'hot_cache_max_size'"));
});
test('composite rows hook the dirty plumbing (gsSetControlValue + re-apply)', () => {
    assert.match(gsys, /if \(row && row\.__gsApply\) \{ row\.__gsApply\(val\); return true; \}/);
    assert.match(gsys, /if \(row && row\.__gsApply\) \{ row\.__gsApply\(wasDirty\[flat\]\); continue; \}/);
});

/* ---- UP-41(10) follow-up (user report 2026-10-27): the wired-limit
   warning used to be ONE flex row holding the sentence, the command chip
   and the copy button. Flex makes every text run AND every <strong> an
   ITEM, so the sentence shattered over three lines with hard gaps and a
   line that began with ';'. Classic keeps the sentence a block line and
   flexes only command + button. Node gates cannot measure geometry, so the
   chain (with order) plus the two containers' CSS display are pinned here,
   and the dead shape gets a negative pin. ------------------------------ */
function guardWarnBlock() {
    const start = gsys.indexOf('if (GSPEC.wiredLimitWarned(sys)) {');
    assert.ok(start > 0, 'the wired-limit builder exists');
    const end = gsys.indexOf('box.append(warn);', start);
    assert.ok(end > start, 'the warning rides the guard box');
    return gsys.slice(start, end);
}
test('memory-guard warning: sentence is a block line, command + button flex', () => {
    const b = guardWarnBlock();
    // warn > line (created and attached BEFORE any text is built) …
    assert.match(b, /warn\.className = 'gs-guard-wired';\s*const line = document\.createElement\('div'\);\s*line\.className = 'gs-guard-wired-line';\s*warn\.append\(line\);/);
    // … the sentence runs + bolds live IN the line …
    assert.match(b, /if \(piece\) line\.append\(document\.createTextNode\(piece\)\);/);
    assert.match(b, /if \(i < pieces\.length - 1\) line\.append\(\s*Object\.assign\(document\.createElement\('strong'\)/);
    // … and only the command row is a flex pair, appended after it
    assert.match(b, /fix\.className = 'gs-guard-fix';/);
    assert.match(b, /fix\.append\(code, cp\);\s*warn\.append\(fix\);/);
    // DEAD SHAPES (negative pins): text or boxes as direct flex children
    assert.ok(!/warn\.append\(document\.createTextNode/.test(b),
        'sentence text must not be a direct child of the flex-warning box');
    assert.ok(!/warn\.append\(code, cp\)/.test(b),
        'command + button belong to .gs-guard-fix, not the warning');
    // the copy control is an ICON button: '.act' is the admin-table action
    // column and carries a 74px min-width meant for words
    assert.match(b, /cp\.className = 'se-btn gs-guard-copy';/);
    assert.ok(!/cp\.className = 'se-btn act'/.test(b));
    assert.match(b, /cp\.setAttribute\('aria-label', cp\.title\);/);
});
test('uplift.css keeps .gs-guard-wired a block and .gs-guard-fix the flex row', () => {
    const rule = (sel) => {
        const i = css.indexOf('\n' + sel + ' {');
        assert.ok(i >= 0, 'rule ' + sel + ' exists as a standalone block');
        return css.slice(i, css.indexOf('}', i));
    };
    assert.ok(!/display:\s*flex/.test(rule('.gs-guard-wired')),
        '.gs-guard-wired must not be a flex container (it holds a sentence)');
    assert.match(rule('.gs-guard-fix'), /display:\s*flex/);
    assert.match(rule('.gs-guard-sysctl'), /flex:\s*1 1 auto/);
    assert.match(rule('.gs-guard-copy'), /flex:\s*0 0 auto/);
});
test('UP-19 pins survive: host loopback trigger + eye toggle + queue line', () => {
    assert.match(gsys, /\|\| flat === 'host'\)/);          // UP-19(7) re-sync
    assert.match(gsys, /gsGuardSync\(\);.*\n.*gsUpdateSaveBtn\(\);\n    gsMarkSections\(\);\n    renderDirtyList\(\);\n\}/);
    assert.match(gsys, /input\[type=password\]/);           // UP-19(6) eyes
    assert.match(gsys, /extra\.bool \? 'bool' : extra\.number \? 'number' : 'text'/);
});
test('blank-vs-0 cache semantics are aligned DELIBERATELY and documented', () => {
    // card CAUTION: uplift blank vs classic 0 — the builders normalize and
    // say so; pin the doctrine markers so a future edit must be intentional
    assert.ok(gsys.includes('ALIGNMENT: blank/\'auto\' normalize to \'0\''));
    assert.ok(gsys.includes('SEMANTICS (card CAUTION — aligned deliberately)'));
    assert.ok(gsys.includes("gsQueueSave('ssd_cache_max_size', 'auto')"));
    assert.ok(gsys.includes("g === 0 ? '0' : `${g}GB`"));
});
test('deep-link boot normalizes BEFORE uplift.js applyTab and follows later ones', () => {
    assert.match(gsys, /const gsDeepBoot = gsDeepNormalize\(\);/);
    assert.match(gsys, /addEventListener\('hashchange', \(\) => \{\n    try \{ gsDeepApply\(gsDeepNormalize\(\)\); \} catch \(_\) \{\}/);
    assert.match(gsys, /'#settings\/' \+ slug/);            // replaceState form
});
test('Advanced is collapsed by default in ALL view and opens on entry', () => {
    assert.match(gsys, /const collapsed = gsTab === 'all' && !gsAdvOpen\(\);/);
    assert.match(gsys, /if \(slug === 'advanced'\) gsAdvSetOpen\(true\);/);  // tab strip + deep link
});
test('copy-link buttons ride every section header with classic keys', () => {
    assert.ok(gsys.includes("C.tf('settings.sections.copy_link'"));
    assert.ok(gsys.includes("gsSectionAnchor(slug)"));
    assert.match(gsys, /cp\.onclick = \(e\) => \{ e\.stopPropagation\(\); gsCopySectionLink\(cp, slug\); \};/);
});
test('number scale persists to classic\'s own key and wires omlxCount', () => {
    assert.ok(gsys.includes("const GS_NUMSCALE_LS = 'omlx-number-scale'"));
    assert.match(gsys, /window\.omlxCount && window\.omlxCount\.setScale && window\.omlxCount\.setScale\(v\)/);
    assert.ok(gsys.includes("'uplift-number-scale'"));
});
