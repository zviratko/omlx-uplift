/* SPLIT-3: chat attachments (UP-32, UP-43): the document lane caps, the
   kind and meta of each attached file, what of a message the store keeps,
   attachment previews, chips and lightbox, and the composer wiring for
   paste, drop and the file picker.
   Part of the native chat: uplift_chat.js calls this factory once with a
   bridge (CORE) to its helpers and live state, and uses the returned
   functions. Code moved from uplift_chat.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftChatParts = root.UpliftChatParts || {}).attach = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Chat-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, t = CORE.t, el = CORE.el;

function isDocumentFile(f) {
    var name = String((f && f.name) || '').toLowerCase();
    var type = String((f && f.type) || '').toLowerCase();
    return /\.(pdf|docx|pptx|txt|md)$/.test(name)
        || type === 'application/pdf'
        || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        || type === 'text/plain' || type === 'text/markdown' || type === 'text/x-markdown';
}

/* ---- UP-43: attachment persistence (phase 2) -----------------------------
   Classic keeps FULL content arrays (bytes) in the session and strips the
   bytes only at save time (chat.html messageForStorage ~:5906: image_url.url
   -> '', file data -> '', the SHAPE survives so a reloaded chat still knows
   an image was there). Uplift's server store is text-only BY DESIGN
   (routers/chat.py _clean_message collapses list content to joined text), so
   the sibling meta is the row-local mirror of that idea: row.att =
   [{n: name, k: kind}] — names and kinds, NEVER bytes. The backend
   whitelist currently drops 'att' on reload; the owner lands the one-line
   server addition with this change (see u43 test header for the exact line).
   ------------------------------------------------------------------------- */
var ATT_MAX = 8;           // per-row cap for the meta list (classic: 5 docs + a few images)
var ATT_NAME_MAX = 120;    // persisted name cap (a filename is not a payload)
var ATT_KINDS = ['image', 'file', 'audio'];
function attKindOf(f) {
    var name = String((f && f.name) || '').toLowerCase();
    var type = String((f && f.type) || '').toLowerCase();
    if (type.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name))
        return 'image';
    if (type.indexOf('audio/') === 0 || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(name))
        return 'audio';
    return 'file';
}
// File-like[] -> capped [{n,k}] meta, or null when nothing to carry.
function attMeta(files) {
    var out = [];
    (files || []).forEach(function (f) {
        if (!f || out.length >= ATT_MAX) return;
        out.push({ n: String(f.name || 'file').slice(0, ATT_NAME_MAX),
                   k: attKindOf(f) });
    });
    return out.length ? out : null;
}
function attIsClean(att) {
    // already exactly the persisted shape? (skip churn on every saveConv)
    if (!Array.isArray(att) || !att.length || att.length > ATT_MAX) return false;
    for (var i = 0; i < att.length; i++) {
        var a = att[i];
        if (!a || typeof a !== 'object' || typeof a.n !== 'string' || !a.n
            || a.n.length > ATT_NAME_MAX
            || ATT_KINDS.indexOf(a.k) < 0
            || Object.keys(a).length !== 2) return false;
    }
    return true;
}
// The store-visible bubble predicate: content OR attachment meta. EVERY
// view<->store ordinal mapping (renderHistory, lastAiVisible, visibleOrdinal,
// editedClaim, attachMessageActions) MUST agree on this or action indices
// shift — one rule, five call sites.
function isVisibleRow(m) {
    // UP-29: rows of a NOT-active regenerate variant (vg marker + vsel 0)
    // are parking, not transcript-view: hidden exactly like a content-empty
    // row was, so ALL five ordinal call sites keep working off this ONE
    // predicate (self-describing per-row markers — the predicate stays
    // (m)-ary, no signature churn). The chat.py whitelist does not persist
    // vg/vid/vsel yet: a reload drops the markers and every sibling
    // renders as an ordinary consecutive assistant bubble (newest last) —
    // graceful degradation, never a silent loss (u29 gate header carries
    // the exact server-side addition).
    return !!(m && (m.content || (m.att && m.att.length)) &&
              !(m.vg && m.vsel === 0));
}
// Classic messageForStorage parity for ONE content part: shape survives,
// bytes NEVER do. Unknown part types pass through minus any data/base64.
function partShapeForStore(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.type === 'image_url')
        return { type: 'image_url', image_url: { url: '' } };
    if (p.type === 'file') {
        var f = p.file || {};
        return { type: 'file',
                 file: { filename: String(f.filename || '').slice(0, ATT_NAME_MAX),
                         data: '' } };
    }
    if (p.type === 'text') return { type: 'text', text: String(p.text || '') };
    var copy = Object.assign({}, p);
    if ('data' in copy) copy.data = '';
    if ('base64' in copy) copy.base64 = '';
    return copy;
}
// saveConv/import sanitizer: bytes out, shapes and text in. Rows that
// already hold only strings + clean meta are returned UNCHANGED (identity)
// so the frequent save path allocates nothing.
function sanitizeMsgForStore(m) {
    if (!m || typeof m !== 'object') return m;
    var out = m;
    if (Array.isArray(m.content)) {
        var parts = [];
        m.content.forEach(function (p) {
            var q = partShapeForStore(p);
            if (q) parts.push(q);
        });
        out = Object.assign({}, out,
            { content: parts.length ? parts : '' });
    }
    if (m.att !== undefined && !attIsClean(m.att)) {
        var clean = [];
        (Array.isArray(m.att) ? m.att : []).forEach(function (a) {
            if (!a || typeof a !== 'object' || clean.length >= ATT_MAX) return;
            var n = String(a.n == null ? '' : a.n).slice(0, ATT_NAME_MAX);
            if (!n) return;
            clean.push({ n: n,
                         k: ATT_KINDS.indexOf(a.k) >= 0 ? a.k : 'file' });
        });
        if (clean.length) out = Object.assign({}, out, { att: clean });
        else { out = Object.assign({}, out); delete out.att; }
    }
    return out;
}
// Session-side previews: the ROW is the key, the raw File objects the key's
// only reference. A live turn's chips can open a real preview; after reload
// the rows are fresh objects with no preview and the chips are informational
// (ticket rule: click-to-preview only for what still exists live). Nothing
// here ever reaches saveConv — the WeakMap holds no serializable bytes.
var _attPreviews = (typeof WeakMap === 'function') ? new WeakMap() : null;
function attKeepPreview(row, files) {
    if (_attPreviews && row && files && files.length) {
        try { _attPreviews.set(row, Array.prototype.slice.call(files)); }
        catch (e) { /* non-extensible row (never today) */ }
    }
}
function attPreviewOf(row) {
    return (_attPreviews && row && _attPreviews.get(row)) || null;
}
function attPreviewFile(row, name) {
    var files = attPreviewOf(row);
    if (!files) return null;
    for (var i = 0; i < files.length; i++)
        if (files[i] && files[i].name === name) return files[i];
    return null;
}
// Bubble text for an attachment-only turn (content '' but meta exists): the
// view must show SOMETHING or the row vanishes and every ordinal shifts.
function attViewText(m) {
    var names = (m && m.att || []).map(function (a) { return a.n; });
    return t('uplift.chat.attachments_sent', '\uD83D\uDCCE {files}')
        .replace('{files}', names.join(', '));
}
// one-turn lightbox for chip previews (image kinds only; documents stay
// text-meta). Own tiny overlay on purpose: lightboxWire (UP-32) pins its
// internals in the u32 gate and is not refactored here.
function attLightbox(uri) {
    var w = W();
    if (!w || !w.document || !uri) return;
    var ov = w.document.createElement('div');
    ov.className = 'chat-lightbox';
    var big = w.document.createElement('img');
    big.src = uri;
    ov.append(big);
    var bye = function () { ov.remove(); w.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') bye(); };
    ov.onclick = bye;
    w.addEventListener('keydown', esc);
    w.document.body.append(ov);
}
function attChipEl(a, row) {
    var chip = el('span', 'chat-native-att');
    chip.dataset.k = a.k;
    chip.title = a.n;
    chip.appendChild(el('span', 'chat-native-att-n', a.n));
    var live = a.k === 'image' && attPreviewFile(row, a.n);
    if (live) {
        // click-to-preview ONLY while the File still exists (live turn)
        chip.classList.add('live');
        chip.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var URLC = W() && W().URL;
            if (!URLC || !URLC.createObjectURL) return;
            try {
                var uri = URLC.createObjectURL(live);
                attLightbox(uri);
                setTimeout(function () {
                    try { URLC.revokeObjectURL(uri); } catch (e) {}
                }, 60000);
            } catch (e) { /* preview is progressive enhancement */ }
        });
    }
    return chip;
}
function attChipsRender(holder, m) {
    // idempotent per signature — the sweep runs after EVERY render pass
    if (!holder || typeof holder.querySelector !== 'function') return;
    var existing = holder.querySelector(':scope > .chat-native-atts');
    var att = (m && m.att) || [];
    var sig = att.map(function (a) { return a.k + ':' + a.n; }).join('|');
    if (!att.length) { if (existing) existing.remove(); return; }
    if (existing && existing.getAttribute('data-sig') === sig) return;
    if (existing) existing.remove();
    var row = el('div', 'chat-native-atts');
    row.setAttribute('data-sig', sig);
    att.forEach(function (a) { row.appendChild(attChipEl(a, m)); });
    if (typeof holder.appendChild === 'function') holder.appendChild(row);
}
// Composer mirror (pre-send chips): deep-chat's OWN #file-attachment-
// container is the source of truth — documents already render name+remove
// there (classic uploadDocuments parity); this adds what deep-chat cannot
// know from DOM alone: a FILE NAME TOOLTIP on queued image chips (they
// render as thumbnails). Files are tracked per add path (paperclip input
// change, drop, paste — all captured on the shadow root BEFORE the
// bundle's own handlers run) and kept honest by a count-resync against the
// chip row, so a rejected format, a FIFO eviction or the post-send clear
// can never desync a name onto the wrong thumbnail. References only — no
// copy, no bytes leave the component.
function attComposerWire(dc) {
    var root = dc && dc.shadowRoot;
    if (!root || typeof root.addEventListener !== 'function'
        || typeof root.querySelector !== 'function') return false;
    var imgs = [];
    var lastChips = 0;   // chip count at the previous sync (shrink detector)
    function kindOfChipImg(chip) { return chip && chip.querySelector
        ? chip.querySelector('img.image-attachment') : null; }
    function container() { return root.querySelector('#file-attachment-container'); }
    function note(filesLike) {
        Array.prototype.forEach.call(filesLike || [], function (f) {
            if (f && attKindOf(f) === 'image') imgs.push(f);
        });
        sync();
    }
    function sync() {
        var c = container();
        if (!c) return;
        var chips = c.querySelectorAll('.file-attachment');
        var imgChips = [];
        Array.prototype.forEach.call(chips, function (ch) {
            if (kindOfChipImg(ch)) imgChips.push(ch);
        });
        // A count SHRINK is a real removal (x-click, FIFO eviction, the
        // post-send clear) — the mirror follows it. A mirror still AHEAD
        // of the DOM is a pending add (the bundle renders the chip after
        // its FileReader resolves): never trim then, or the name lands
        // before the chip exists and the trim would eat it.
        if (imgChips.length < lastChips && imgs.length > imgChips.length)
            imgs.length = imgChips.length;
        lastChips = imgChips.length;
        imgChips.forEach(function (ch, i) {
            var f = imgs[i];
            // assign AND re-assign: after a removal the surviving chips
            // shift toward the front of the mirror, and a stale name is
            // worse than no name
            if (f && ch.title !== String(f.name || '')) {
                ch.title = String(f.name || '');
                var im = kindOfChipImg(ch);
                if (im) { im.alt = String(f.name || ''); im.title = ch.title; }
            }
        });
    }
    root.addEventListener('change', function (ev) {
        var tg = ev.target;
        if (tg && tg.tagName === 'INPUT' && tg.type === 'file' && tg.files)
            note(tg.files);
    }, true);
    root.addEventListener('drop', function (ev) {
        if (ev.dataTransfer && ev.dataTransfer.files) note(ev.dataTransfer.files);
    }, true);
    root.addEventListener('paste', function (ev) {
        if (ev.clipboardData && ev.clipboardData.files) note(ev.clipboardData.files);
    }, true);
    root.addEventListener('click', function (ev) {
        // × removal (also fires for the bundle's programmatic .click() on
        // FIFO overflow and the post-send hideFiles clear): splice the
        // mirror at the chip's position among the image chips
        var tg = ev.target;
        var btn = tg && tg.closest
            ? tg.closest('.remove-file-attachment-button') : null;
        if (!btn) return;
        var chip = btn.closest('.file-attachment');
        if (!chip || !kindOfChipImg(chip)) return;
        var c = container();
        if (!c) return;
        // the chip's position = how many IMAGE chips sit BEFORE it (the
        // mirror is append-order == image chip DOM order). The capture
        // listener runs BEFORE the bundle's own handler removes the chip;
        // if it is somehow already gone, let the next sync's shrink-trim
        // handle it rather than guessing a wrong position.
        var i = 0, seen = false;
        Array.prototype.forEach.call(c.querySelectorAll('.file-attachment'),
            function (ch) {
                if (!kindOfChipImg(ch)) return;
                if (ch === chip) { seen = true; return; }
                if (!seen) i++;
            });
        if (seen) imgs.splice(i, 1);
        setTimeout(sync, 0);
    }, true);
    if (typeof MutationObserver === 'function') {
        var pending = 0;
        var obs = new MutationObserver(function () {
            if (pending) return;
            pending = setTimeout(function () { pending = 0; sync(); }, 0);
        });
        // observe the WHOLE shadow root: config re-assignment re-renders
        // the component and the container node is recreated (a per-node
        // observer would silently die on the next syncAudioMode flip)
        try { obs.observe(root, { childList: true, subtree: true }); }
        catch (e) { /* annotations stay best-effort */ }
    }
    return true;
}

return {
    isDocumentFile: isDocumentFile,
    attKindOf: attKindOf,
    attMeta: attMeta,
    isVisibleRow: isVisibleRow,
    sanitizeMsgForStore: sanitizeMsgForStore,
    attKeepPreview: attKeepPreview,
    attPreviewOf: attPreviewOf,
    attViewText: attViewText,
    attChipsRender: attChipsRender,
    attComposerWire: attComposerWire
};
});
