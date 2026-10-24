// UP-32 gate: chat document attachments (markitdown lane) + lightbox.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');

// extract a top-level function by brace-walking (u33 pattern)
function extract(name) {
    const i = SRC.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' present');
    let depth = 0, started = false;
    for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; started = true; }
        else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
    }
    throw new Error('unbalanced ' + name);
}
const mod = { exports: {} };
// safe by construction: the body is OUR first-party repo source (uplift_chat.js
// read off disk in this very test), never untrusted input — same pattern as
// the u33 gate's shipped-function extraction.
new Function('module', 'exports', extract('isDocumentFile') + '\nmodule.exports = isDocumentFile;')
    (mod, mod.exports);
const isDocumentFile = mod.exports;

test('UP-32: document classifier mirrors classic isSupportedDocumentFile', () => {
    const f = (name, type) => ({ name, type });
    assert.ok(isDocumentFile(f('report.PDF', '')));
    assert.ok(isDocumentFile(f('notes.md', '')));
    assert.ok(isDocumentFile(f('deck', 'application/pdf')));
    assert.ok(isDocumentFile(f('doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')));
    assert.ok(isDocumentFile(f('pres', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')));
    assert.ok(isDocumentFile(f('a.txt', 'text/plain')));
    assert.ok(isDocumentFile(f('a', 'text/markdown')));
    assert.ok(isDocumentFile(f('a', 'text/x-markdown')));
    assert.ok(!isDocumentFile(f('cat.png', 'image/png')), 'images stay on the image lane');
    assert.ok(!isDocumentFile(f('song.mp3', 'audio/mpeg')));
});

test('UP-32: shapeRequest routes docs to the file part, capped like classic', () => {
    const i = SRC.indexOf('} else if (files.length) {');
    assert.ok(i > 0);
    const seg = SRC.slice(i, SRC.indexOf('msgs.push(cur);', i));
    assert.match(seg, /isDocumentFile\(f\)/);
    assert.match(seg, /type: 'file',\n?\s*file: \{ filename: f\.name, file_data: await fileToDataURL\(f\) \}/);
    assert.match(seg, /_docCfg\.maxFiles/);
    assert.match(seg, /_docCfg\.maxMb \* 1048576/);
    assert.match(seg, /chat\.error\.document_too_large/);
    assert.match(seg, /chat\.error\.too_many_documents/);
    // the image lane stays intact for everything else
    assert.match(seg, /type: 'image_url'/);
});

test('UP-32: mixedFiles paperclip + boot caps fetch from integrations', () => {
    assert.match(SRC, /dc\.mixedFiles = \{ acceptedFormats: '\.pdf,\.docx,\.pptx,\.txt,\.md'/);
    assert.match(SRC, /maxNumberOfFiles: _docCfg\.maxFiles/);
    assert.match(SRC, /fetchJson\('\/admin\/api\/global-settings'\)/);
    assert.match(SRC, /markitdown_enabled !== false/);
    assert.match(SRC, /markitdown_max_file_size_mb \|\| 25/);
    assert.match(SRC, /markitdown_max_files_per_request \|\| 5/);
});

test('UP-32(4e): lightbox wired into the post-render sweep; scheme-safe src', () => {
    assert.match(SRC, /lightboxWire\(root\);/);
    const i = SRC.indexOf('function attachMessageActions');
    const call = SRC.indexOf('lightboxWire(root);', i);
    assert.ok(call > i && call < i + 400, 'called from attachMessageActions head');
    const lb = extract('lightboxWire');
    assert.match(lb, /\/\^\(javascript\|data:text\)\/i\.test\(uri\)/);
    assert.match(lb, /chat-lightbox/);
    assert.match(lb, /key === 'Escape'/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift.css'), 'utf8');
    assert.match(css, /\.chat-lightbox \{ position: fixed/);
});
