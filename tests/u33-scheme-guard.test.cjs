/* UP-33 gate: chat scheme guard. No browser harness exists for the deep-chat
   shadow render path, so the SHIPPED schemeGuard function is brace-walked
   verbatim out of uplift_chat.js (checked-in source only, no external input —
   justification per repo rule for new Function tests) and run against a
   fixture DOM. Live XSS probe evidence (raw HTML escaped; javascript:/data:
   hrefs WERE passing pre-fix) is documented in the card and the source
   comment. Also pins that the guard actually runs in the attach sweep. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');

function extractFn(name) {
    const at = SRC.indexOf('function ' + name + '(');
    assert.ok(at >= 0, 'function ' + name + ' present');
    let depth = 0, i = SRC.indexOf('{', at), started = false, end = -1;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > 0, 'brace walk terminated for ' + name);
    return SRC.slice(at, end);
}

function el(attrs) {
    const a = Object.assign({}, attrs);
    return {
        attrs: a,
        getAttribute: k => (k in a ? a[k] : null),
        removeAttribute: k => { delete a[k]; },
        setAttribute: (k, v) => { a[k] = v; },
    };
}
function rootWith(links, imgs) {
    return {
        querySelectorAll: sel => (sel === 'a[href]' ? links : sel === 'img[src]' ? imgs : []),
    };
}

test('schemeGuard strips dangerous hrefs/srcs, keeps safe ones', () => {
    const body = extractFn('schemeGuard');
    // eslint-disable-next-line no-new-func
    const schemeGuard = new Function('return (' + body + ')')();
    const keep = [el({ href: 'https://example.com', target: '_blank' }),
                  el({ href: 'http://a.b' }),
                  el({ href: 'mailto:x@y.z' }),
                  el({ href: '#frag' }),
                  el({ href: ' HTTPS://HF.CO/a/b ' })];
    const kill = [el({ href: 'javascript:alert(1)', target: '_blank' }),
                  el({ href: 'JaVaScRiPt:alert(1)' }),
                  el({ href: 'data:text/html,<script>alert(1)<\/script>' }),
                  el({ href: 'vbscript:x' }),
                  el({ href: '\n javascript:alert(1)' }),   // leading newline bypass
                  el({ href: '' })];
    const imgKeep = [el({ src: 'https://x/y.png' }), el({ src: 'data:image/png;base64,AAA' })];
    const imgKill = [el({ src: 'data:text/html,hi' }), el({ src: 'javascript:x' })];
    schemeGuard(rootWith(keep.concat(kill), imgKeep.concat(imgKill)));
    for (const a of keep)
        assert.ok(a.getAttribute('href'), 'safe href kept: ' + a.getAttribute('href'));
    assert.strictEqual(keep[0].getAttribute('target'), '_blank', 'target kept on safe links');
    for (const a of kill) {
        assert.strictEqual(a.getAttribute('href'), null, 'dangerous href stripped');
        assert.strictEqual(a.getAttribute('target'), null, 'target dropped with href');
    }
    for (const im of imgKeep) assert.ok(im.getAttribute('src'), 'safe img kept');
    for (const im of imgKill) assert.strictEqual(im.getAttribute('src'), null, 'dangerous img stripped');
});

test('schemeGuard runs in the post-render attach sweep (wiring pin)', () => {
    const at = SRC.indexOf('function attachMessageActions(');
    assert.ok(at >= 0);
    const head = SRC.slice(at, at + 320);
    assert.ok(/schemeGuard\(root\);/.test(head),
        'attachMessageActions must sweep the guard before touching bubbles');
});
