/* I18N-1 reverse lint: the forward gate (test_locale_sync) only checks keys
   that already USE the locale system. This lint walks the other direction —
   user-facing surface first — and fails on strings that bypass i18n, which
   is how ~60 English-only leaks accumulated across 10 locales.

   Rules:
   A) index.html: <option>/<label> text, placeholder=, title= must carry a
      data-i18n / data-i18n-title / data-i18n-ph hook on the element (or an
      inner span carrying one), unless whitelisted (brand/unit/technical).
   B) static/*.js: bare string literals as the first text argument of
      toast()/emptyMsg()/cell() must be C.t()/C.tf() calls (whitelist for
      brand/unit fragments). A line may opt out with an `i18n-exempt` marker.

   The lint functions take source text so the self-test can plant synthetic
   violations and prove the rules actually fire (protocol v2 RED evidence,
   kept permanent instead of a throwaway). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

// brand names, units, technical tokens — deliberately untranslated
const WHITELIST = /^(GiB|MiB|KiB|GB|MB|tok\/s|tps|HTTP|API|URL|JSON|HTML|oMLX|omlx|MLX|HF|PR|TRENDING|POPULAR|SEARCH|TRACE|DEBUG|INFO|WARNING|ERROR|GitHub PR|Hugging Face|huggingface\.co.*|oQ.*|—|…|\W+)$/;
function whitelisted(s) {
    s = s.trim();
    if (WHITELIST.test(s)) return true;
    if (/^[\d.,]+%?$/.test(s)) return true; // pure numbers are locale-neutral
    return ['GiB', 'tok/s', 'oMLX', 'HTTP'].includes(s);
}

function lintHtml(html) {
    const bad = { option: [], label: [], placeholder: [], title: [] };
    const enclosingTag = (start) => {
        const s = html.lastIndexOf('<', start);
        const end = html.indexOf('>', start);
        return html.slice(s, end < 0 ? start + 400 : end + 1);
    };
    for (const m of html.matchAll(/<option\b[^>]*>([^<]+)<\/option>/g)) {
        const text = m[1].trim();
        if (!text || whitelisted(text)) continue;
        if (!m[0].includes('data-i18n')) bad.option.push(text);
    }
    for (const m of html.matchAll(/<label\b[^>]*>(?:<input[^>]*>)?\s*([^<>]*[A-Za-z][^<>]*)<\/label>/g)) {
        const text = m[1].trim();
        if (!text || whitelisted(text)) continue;
        if (!m[0].includes('data-i18n')) bad.label.push(text);
    }
    for (const m of html.matchAll(/\bplaceholder="([^"]+)"/g)) {
        if (whitelisted(m[1])) continue;
        if (!enclosingTag(m.index).includes('data-i18n-ph')) bad.placeholder.push(m[1]);
    }
    for (const m of html.matchAll(/\btitle="([^"]+)"/g)) {
        if (whitelisted(m[1])) continue;
        if (!enclosingTag(m.index).includes('data-i18n-title')) bad.title.push(m[1]);
    }
    return bad;
}

// ---- JS rule -------------------------------------------------------------
const JS_SITES = /\b(?:[A-Za-z_$][\w$]*\.)?(toast|emptyMsg|cell)\s*\(/g;

function bareStringArg(src, idx) {
    const rest = src.slice(idx, idx + 200);
    const m = rest.match(/^\s*(["'`])([^"'`\n]{2,})\1/);
    return m ? m[2] : null;
}

function lintJs(src, name) {
    const bad = [];
    for (const m of src.matchAll(JS_SITES)) {
        // C.t(/C.tf( are the translation call sites themselves, not leaks
        if (/\.t(f?)\($/.test(m[0])) continue;
        const idx = m.index + m[0].length;
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const lineEnd = src.indexOf('\n', m.index);
        const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        if (/i18n-exempt/.test(line)) continue;
        const fn = m[1];
        let lit = null;
        if (fn === 'emptyMsg') {   // emptyMsg(host, msg): text is the SECOND arg
            const rest = src.slice(idx, idx + 400);
            const arg2 = rest.match(/^[^,]*,\s*(["'`])([^"'`\n]{2,})\1/);
            if (arg2) lit = arg2[2];
        } else {
            lit = bareStringArg(src, idx);
        }
        if (lit === null || whitelisted(lit)) continue;
        bad.push(`${name}:${src.slice(0, m.index).split('\n').length} ${fn}('${lit.slice(0, 50)}')`);
    }
    return bad;
}

const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');

test('index.html: option/label/placeholder/title are translated or whitelisted', () => {
    const bad = lintHtml(html);
    const flat = Object.entries(bad).flatMap(([k, v]) => v.map(x => `${k}: ${x}`));
    assert.deepEqual(flat, [], `i18n leaks in index.html:\n${flat.join('\n')}`);
});

test('static/*.js: toast/emptyMsg/cell text args are translated or exempt', () => {
    const bad = [];
    for (const f of fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.js')))
        bad.push(...lintJs(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'), f));
    assert.deepEqual(bad, [], `bare literals into toast/emptyMsg/cell:\n${bad.join('\n')}`);
});

// ---- self-test: planted violations must fire (protocol v2 RED evidence) --
test('lint catches planted violations', () => {
    const leakHtml = '<select><option value="x">plain english</option></select>' +
        '<input placeholder="type here">' +
        '<span title="some hint">t</span>' +
        '<label><input type="checkbox"> tick me</label>';
    const bad = lintHtml(leakHtml);
    assert.deepEqual(bad.option, ['plain english']);
    assert.deepEqual(bad.placeholder, ['type here']);
    assert.deepEqual(bad.title, ['some hint']);
    assert.deepEqual(bad.label, ['tick me']);
    // the fixed form passes
    const okHtml = '<select><option value="x" data-i18n="uplift.x">plain english</option></select>' +
        '<input placeholder="type here" data-i18n-ph="uplift.x">' +
        '<span title="some hint" data-i18n-title="uplift.x">t</span>' +
        '<label><input type="checkbox"> <span data-i18n="uplift.x">tick me</span></label>';
    assert.deepEqual(Object.values(lintHtml(okHtml)).flat(), []);

    const leakJs = `
        toast('boom: ' + e.message);
        DG.toast('plain words');
        D.emptyMsg(host, 'Nothing here');
        MM_GLUE.cell('Section divider');`;
    assert.equal(lintJs(leakJs, 'x.js').length, 4);
    const okJs = `
        toast(C.tf('uplift.a', 'boom: ') + e.message);
        DG.toast(C.t('uplift.b'));
        D.emptyMsg(host, C.t('uplift.c'));
        MM_GLUE.cell(C.t('uplift.d'));
        toast('raw ok'); // i18n-exempt`;
    assert.deepEqual(lintJs(okJs, 'x.js'), []);
});
