/* PH2-1 stage 0: shared reader for the static JS surface.
   Text-parsing drift tests must not pin a single filename — uplift.js is
   being split into per-section plain-script files (ticket PH2-1). This
   helper concatenates every static/*.js in the order index.html loads
   them (alphabetical for files index.html does not list), so drift regexes
   keep working unchanged across the split. Vendor files are excluded. */
'use strict';
const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, '..', 'omlx_uplift', 'static');

function staticFiles() {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const order = [...html.matchAll(/<script src="\.\/([\w.-]+)\.js(?:\?[^"]*)?"/g)].map(m => m[1] + '.js');
    const onDisk = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.js')).sort();
    for (const f of onDisk) if (!order.includes(f)) order.push(f);
    const missing = order.filter(f => !onDisk.includes(f));
    if (missing.length) throw new Error('index.html loads missing files: ' + missing.join(', '));
    return order;
}

function allStaticJs() {
    return staticFiles()
        .map(f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'))
        .join('\n');
}

/* SPLIT-3: the native chat is uplift_chat.js (core, loaded LAST) plus part
   files that register on UpliftChatParts before it. Tests that read or run
   "the chat" use these two helpers, so they keep working as code moves
   between the chat files. Order = browser load order (uplift.js). */
const CHAT_FILES = ['uplift_chat_attach.js', 'uplift_chat_voice.js', 'uplift_chat_actions.js',
                    'uplift_chat_stt.js', 'uplift_chat.js'];

function chatSource() {
    return CHAT_FILES
        .map(f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'))
        .join('\n');
}

function runChat(ctx) {
    const vm = require('vm');
    for (const f of CHAT_FILES) {
        new vm.Script(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'),
                      { filename: f }).runInContext(ctx);
    }
}

module.exports = { STATIC_DIR, staticFiles, allStaticJs, CHAT_FILES, chatSource, runChat };
