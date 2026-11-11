/* SPLIT-3: chat message actions (U45, UP-29, UP-39, UP-40): the per-bubble
   action row (copy, copy markdown, regenerate, branch, edit, delete), reply
   variants and the regenerate menu, the inline editor, the audio cache
   report and the keyboard-shortcut sheet.
   Part of the native chat: uplift_chat.js calls this factory once with a
   bridge (CORE) to its helpers and live state, and uses the returned
   functions. Code moved from uplift_chat.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftChatParts = root.UpliftChatParts || {}).actions = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Chat-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, D = CORE.D, errText = CORE.errText, api = CORE.api,
    t = CORE.t, el = CORE.el, gid = CORE.gid,
    switchChatModel = CORE.switchChatModel, newConv = CORE.newConv,
    saveConv = CORE.saveConv, lastAiVisible = CORE.lastAiVisible,
    renderHistory = CORE.renderHistory, stopAndSettle = CORE.stopAndSettle,
    openConv = CORE.openConv, refreshConvList = CORE.refreshConvList,
    isVisibleRow = CORE.isVisibleRow,
    sanitizeMsgForStore = CORE.sanitizeMsgForStore,
    attPreviewOf = CORE.attPreviewOf, attChipsRender = CORE.attChipsRender,
    thinkingBlockEl = CORE.thinkingBlockEl, tf2 = CORE.tf2,
    messageAt = CORE.messageAt;

// Other chat parts' functions, late-bound (looked up at call time).
function autoSpeakOn() { return CORE.autoSpeakOn.apply(null, arguments); }
function hasVoices() { return CORE.hasVoices.apply(null, arguments); }
function newMid() { return CORE.newMid.apply(null, arguments); }
function saySilence() { return CORE.saySilence.apply(null, arguments); }
function saySweepPlans() { return CORE.saySweepPlans.apply(null, arguments); }
function sayTrackEl() { return CORE.sayTrackEl.apply(null, arguments); }
function sayGrid() { return CORE.sayGrid.apply(null, arguments); }
function sayAttach() { return CORE.sayAttach.apply(null, arguments); }
var _plans = CORE._plans;

// ---------------------------------------------------------------------------
// U45: per-message action overlay (classic parity: copy / copy markdown /
// regenerate / delete). deep-chat 2.5.1 exposes NO per-message hooks
// (NAT-1 finding) — the seam is the open shadowRoot: bubbles live at
// .outer-message-container > .inner-message-container > .message-bubble,
// and the shadow #messages list order equals _conv.messages EXCEPT rows
// with empty content, which renderHistory filters out. Bubbles the
// filter drops never enter the store (the save path skips empty rows,
// handler never emits empty ai turns), so the visible==stored
// correspondence holds; the action map records WHICH message each
// bubble got so actions read the store by the right index.
// ---------------------------------------------------------------------------
var _msgActions = new WeakMap();   // bubble element -> {idx, role}
var _overlayTimer = null;

function cacheReport(rep, sizeOf, say) {
    // one honest line: what is stored, and what nothing refers to any more
    var o = { n: rep.orphan_files || 0, bytes: rep.orphan_bytes || 0 };
    var files = rep.files != null ? rep.files : (rep.totals || {}).files || 0;
    var bytes = rep.bytes != null ? rep.bytes : (rep.totals || {}).bytes || 0;
    if (!o.n) {
        say(t('uplift.chat.cache_none',
            'Audio cache: {files} files, {size}. Nothing to clean up.')
            .replace('{files}', String(files)).replace('{size}', sizeOf(bytes)),
            'ok');
        return o;
    }
    say(t('uplift.chat.cache_found',
        'Audio cache: {orphan} orphaned files, {osize} of {size}.')
        .replace('{orphan}', String(o.n)).replace('{osize}', sizeOf(o.bytes))
        .replace('{size}', sizeOf(bytes)), 'info');
    return o;
}
function checkAudioCache(say, sizeOf, orphansOf) {
    var d = D();
    if (!d) return;
    d.fetchJson(api() + '/voices/speech-cache')
        .then(function (rep) { cacheReport(rep, sizeOf, say); },
              function (e) { say(errText(e), 'error'); });
}
function cleanupAudioCache(say, sizeOf, orphansOf) {
    var d = D();
    if (!d) return;
    d.fetchJson(api() + '/voices/speech-cache').then(function (rep) {
        var o = cacheReport(rep, sizeOf, say);
        if (!o.n) return;
        if (!window.confirm(t('uplift.chat.cache_confirm',
            'Delete {orphan} orphaned audio files ({osize})? Replies that '
            + 'still have their message keep their audio.').replace('{orphan}',
            String(o.n)).replace('{osize}', sizeOf(o.bytes)))) return;
        d.postJson(api() + '/voices/speech-cache/cleanup', {}).then(function (res) {
            say(t('uplift.chat.cache_cleaned', 'Removed {orphan} audio files ({osize}).')
                .replace('{orphan}', String(res.removed || 0))
                .replace('{osize}', sizeOf(res.freed || 0)), 'ok');
        }, function (e) { say(errText(e), 'error'); });
    }, function (e) { say(errText(e), 'error'); });
}

function msgActionsEl(idx, role, editedLabel, editedKey, paramsText) {
    // declared below; the pair is appended once the buttons exist
    var box = el('div', 'chat-native-msg-actions' +
                         (role === 'user' ? ' user' : ''));
    box.setAttribute('data-idx', String(idx));
    if (paramsText) {
        // U78: sampling provenance chip — always visible (state, not an
        // action; hover-gating it would hide the very thing it records)
        var chip = el('span', 'chat-native-params', paramsText);
        var ttl = tf2('uplift.chat.params_used',
                      'Sampling used for this reply');
        chip.title = ttl;
        box.appendChild(chip);
    }
    if (editedLabel) {
        // U74: 'Edited' / 'Edited — used on next reply' badge — first in
        // the track so it reads as the row's state, not a button
        var sp = el('span', 'chat-native-edited', editedLabel);
        // the KEY rides in, never a substring probe of the translated text
        sp.dataset.i18n = editedKey || 'uplift.chat.edited';
        sp.dataset.en = editedLabel;            // U59 repair marker
        box.appendChild(sp);
    }
    function act(cls, label, title, fn) {
        var b = el('button', 'chat-native-msg-action ' + cls, label);
        b.type = 'button'; b.title = title;
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            fn(idx, b);   // UP-29: the regenerate hub needs its own anchor
                          // button; every older handler takes (idx) only
        });
        box.appendChild(b);
        return b;
    }
    if (role === 'assistant') {
        // UP-29: the variant tab strip reads FIRST in the track (classic
        // renders its response-tab group above the reply; this row's state
        // comes before this row's actions). null unless this is the last
        // row of an active multi-variant chain.
        var vstrip = variantStripEl(idx);
        if (vstrip) box.appendChild(vstrip);
    }
    act('copy', t('chat.copy_tooltip', 'Copy'),
        t('chat.copy_tooltip', 'Copy'), msgCopy);
    act('copymd', t('chat.copy_markdown', 'Copy markdown'),
        t('chat.copy_markdown', 'Copy markdown'), msgCopyMarkdown);
    if (role === 'assistant') {
        // VOICE-1b: read-aloud rides the same per-message track — no new
        // overlay machinery. Text is stripped like 'Copy' does (the model
        // answer IS markdown; TTS would read the syntax out loud). The
        // button exists only while a voice is selected; voices are an
        // opt-in uplift feature, so no voices = no affordance (not a
        // dead button that errors on click).
        // UP-29: the button is now the regenerate OPTIONS hub (classic's
        // plain/creative/with-model menu) — the plain regenerate is the
        // hub's first entry and every entry writes a new variant chain.
        act('regen', t('chat.regenerate_tooltip', 'Regenerate'),
            t('chat.regenerate_tooltip', 'Regenerate'), openRegenMenu);
    }
    if (role === 'user' && !(CORE._conv && CORE._conv.temporary)) {
        // UP-65: classic hides Branch in a temporary chat (a branch is saved).
        // UP-29 (classic context menu :1435/:1710 'Branch here'): user-row
        // action; uplift has no context menu — the action bar IS its menu.
        act('branch', t('chat.branch_here', 'Branch from here'),
            t('chat.branch_here', 'Branch from here'), msgBranch);
    }
    // U75 (user: 'can we have just one Edit button for both the reply and
    // thinking?'): one affordance per row; assistant rows open the
    // UNIFIED editor (reasoning + reply together), user rows replay.
    act('edit', t('chat.edit_tooltip', 'Edit message'),
        t('chat.edit_tooltip', 'Edit message'), function (i) {
            openEditor(i, role);
        });
    act('del', t('chat.delete_message', 'Delete'),
        t('chat.delete_message', 'Delete'), msgDelete);
    if (role === 'assistant' && hasVoices()) {
        // VOICE-16j (user: 'not on the line with the other controls and aligned
        // to the right like I asked'): the whole-reply pair is the LAST control
        // on the action line, pushed right, and it appears and disappears with
        // that line — one hover rule for all message controls, not two.
        var track = sayTrackEl(idx);
        box.appendChild(track);
        // plans are keyed by mid: an index goes stale the moment a row above is
        // deleted, and the pair would then drive another bubble's audio
        var owner = messageAt(idx);
        if (owner && owner.mid && _plans[owner.mid]) _plans[owner.mid].box = track;
    }
    return box;
}

function msgCopy(idx) {
    var m = messageAt(idx);
    if (!m) return;
    copyText(stripMarkdown(m.content)).then(function () {
        D().toast(t('chat.copy_tooltip', 'Copy'), 'ok');
    }, function (e) {
        D().toast(errText(e), 'error');
    });
}

// classic keeps the RAW markdown in the store and renders it at display
// time (renderMessageContent -> marked). "Copy markdown" therefore gets
// the stored content verbatim; "Copy" strips the markup for a plain-text
// paste — both mirror classic's split between copyMessage and
// copyMarkdown.
function msgCopyMarkdown(idx) {
    var m = messageAt(idx);
    if (!m) return;
    copyText(String(m.content || '')).then(function () {
        D().toast(t('chat.copy_markdown', 'Copy markdown'), 'ok');
    }, function (e) {
        D().toast(errText(e), 'error');
    });
}

function copyText(text) {
    // classic parity (chat.html _copyText/_copyFallback): the Clipboard API
    // needs a secure context; the board is served over plain http, so the
    // offscreen-textarea execCommand path is the real transport here —
    // without it every copy rejects with 'no clipboard' on the LAN URL.
    var s = String(text || '');
    var nav = W() && W().navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) {
        return nav.clipboard.writeText(s).catch(function () {
            legacyCopy(s);
        });
    }
    legacyCopy(s);
    return Promise.resolve();
}

function legacyCopy(s) {
    var doc = W() && W().document;
    if (!doc || !doc.createElement || !doc.body) return;
    var ta = doc.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); } catch (e) {}
    doc.body.removeChild(ta);
}

function stripMarkdown(src) {
    // Minimal, deliberately conservative plain-text projection (U47 will
    // need the same for bench copy): fences/inline code kept as text,
    // links -> label, emphasis + heading markers dropped. Raw HTML tags
    // stripped; no innerHTML anywhere.
    var s = String(src || '');
    s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    s = s.replace(/^#{1,6}\s+/gm, '');
    s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
    s = s.replace(/(\*|_)(.*?)\1/g, '$2');
    s = s.replace(/^\s*[-*+]\s+/gm, '');
    return s.trim();
}

// ---- UP-29: regenerate variants + options + branch ------------------------
// Classic parity map (chat.html): branchChat :7365-7410, regenerateMessage
// :7199 with the creative / 'Regenerate with…' options :7218-7233, and the
// variant tab strip machinery :3440-3510 (switch, per-variant labels,
// delete-one). Uplift keeps its IN-PLACE assistant EDIT (commitEditedInPlace
// — a superset classic lacks) and lands the rest as ONE regenerate rework
// on _conv storage.
//
// Storage model (the ticket's "minimal honest" pick, refined): a variant
// chain is an ordinary CONSECUTIVE RUN of assistant rows; every row of a
// grouped turn carries vg (group id) + vid (chain id) + vsel (1 shown /
// 0 hidden). Because the markers are self-describing per row, the ONE
// shared visibility predicate (isVisibleRow, UP-43) does the hiding and
// all five ordinal call sites keep working untouched; deletes and
// truncations splice whole rows, so meta can never orphan. vg/vid/vsel/
// rmodel ARE in the server message whitelist (chat.py _clean_message, capped;
// pinned by test_u29_variant_markers_roundtrip), so a chain survives a reload.
// The pre-whitelist degradation this note used to describe — markers lost,
// siblings rendering as plain consecutive bubbles with no tab strip — no
// longer happens; kept here so the history of the shape stays readable.

function creativeTemp() {
    // classic :7218-7223 math, mirrored: base + 0.4 capped at 2 when a
    // positive finite base exists, 1.2 when nothing sane is set. The base
    // walks the same defensive chain classic does: the conversation's
    // sampling snapshot first, then the model row's own default if the
    // serving DTO carries one.
    var base = NaN;
    var g = CORE._conv && CORE._conv.generation;
    if (g && g.temperature != null) base = Number(g.temperature);
    if (!Number.isFinite(base)) {
        var minfo = null, mid = (CORE._conv && CORE._conv.model) || '';
        for (var i = 0; i < (CORE._models || []).length; i++) {
            if ((CORE._models[i].id || CORE._models[i].name) === mid) {
                minfo = CORE._models[i]; break;
            }
        }
        base = Number(minfo && minfo.settings && minfo.settings.temperature);
    }
    return (Number.isFinite(base) && base > 0) ? Math.min(2, base + 0.4) : 1.2;
}

function variantGroup(ms, gid0) {
    // {gid, vids in first-appearance order, activeVid, labels{vid:rmodel}}
    // — null when there is no group (plain turn, or markers dropped by a
    // reload before the server whitelist lands).
    if (!gid0) return null;
    var vids = [], active = null, labels = {};
    for (var i = 0; i < ms.length; i++) {
        var r = ms[i];
        if (!r || r.vg !== gid0) continue;
        if (vids.indexOf(r.vid) < 0) vids.push(r.vid);
        if (r.vsel === 1) active = r.vid;
        if (r.rmodel && !labels[r.vid]) labels[r.vid] = r.rmodel;
    }
    if (!vids.length) return null;
    return { gid: gid0, vids: vids,
             activeVid: active || vids[vids.length - 1], labels: labels };
}

function mergeVariantChain() {
    // UP-29: return the parked chains around the regenerate's result.
    // Three callers, first wins (the stash clears itself): onMessage's
    // final assistant row (normal close), the close() fallback drain
    // (stop / error / text-less last round — same one-shot discipline as
    // the UP-35 round drain beside it), and msgRegenerate itself as
    // watchdog-unwedge recovery. Post-merge order: user, [older chains
    // hidden], [new chain shown]. When the stream produced NOTHING the
    // parked chains return exactly as they were parked — the abort cost
    // the user nothing.
    var s = CORE._variantStash;
    if (!s) return false;
    CORE._variantStash = null;
    if (!CORE._conv || CORE._conv.id !== s.cid) return false;   // abandoned view
    var ms = CORE._conv.messages;
    var produced = 0;
    while (ms[s.cut + 1 + produced] && ms[s.cut + 1 + produced].role === 'assistant')
        produced++;
    var newVid = null;
    if (produced) {
        newVid = newMid();
        for (var k = s.cut + 1; k < s.cut + 1 + produced; k++) {
            ms[k].vg = s.gid; ms[k].vid = newVid; ms[k].vsel = 1;
        }
    }
    for (var p = 0; p < s.rows.length; p++) {
        var r = s.rows[p];
        // hidden only while a newer chain exists; a failed regen restores
        // the previous selection (never silently flips the shown reply)
        r.vsel = newVid ? 0 : (r.vsel === 0 ? 0 : 1);
    }
    Array.prototype.splice.apply(ms, [s.cut + 1, 0].concat(s.rows));
    renderHistory();
    saveConv();
    return true;
}

function msgRegenerate(idx, opts) {
    // UP-29: the regenerate OPTIONS hub (classic regenerateMessage :7199
    // + options :7218-7233). The plain action stays the primitive — the
    // U45 seam and the u29 gate drive it directly, opts {creative, model}
    // are the menu's choices. Every run writes a NEW VARIANT CHAIN; the
    // previous reply is parked, never destroyed.
    if (CORE._streaming || !CORE._conv) return;
    opts = opts || {};
    // dangling stash = the previous regen stream died without ANY settle
    // hook (watchdog un-wedge only): restore it before touching the store
    if (CORE._variantStash && !CORE._streaming) mergeVariantChain();
    var ms = CORE._conv.messages;
    var m = messageAt(idx);
    if (!m || m.role !== 'assistant') return;
    // UP-35: a tool turn is several assistant rows (the sealed rounds are
    // ordinary rows now) — regen rewinds over that run to the turn's USER
    // row, the same prompt the original turn started from. Pre-UP-35 the
    // last answer directly followed its user row and this walk stops
    // immediately: behavior for every alternating transcript is unchanged.
    var j = idx - 1;
    while (j > 0 && ms[j] && ms[j].role === 'assistant') j--;
    var prev = j >= 0 ? ms[j] : null;
    if (!prev || prev.role !== 'user') return;   // no prompt to replay
    // classic (chat.html:6656): transcription turns cannot be regenerated
    // — the audio file is not persisted; the label would go out as prose.
    if (/^\[audio\] /.test(String(prev.content))) return;
    // UP-29: park this turn's assistant run (sealed rounds + every chain
    // that already exists) before the truncate-and-resend. The send path
    // ALWAYS re-enters the user row (one prompt bubble, never a duplicate),
    // so the whole turn — hidden siblings included — lives in the stash
    // until mergeVariantChain puts it back.
    var gEnd = j + 1;
    while (gEnd < ms.length && ms[gEnd] && ms[gEnd].role === 'assistant') gEnd++;
    var gid0 = m.vg || newMid();
    var firstVid = newMid();
    var parked = [];
    for (var p = j + 1; p < gEnd; p++) {
        var r = ms[p];
        if (!r) continue;
        if (!r.vg) { r.vg = gid0; r.vid = firstVid; }
        parked.push(r);
    }
    CORE._variantStash = { cid: CORE._conv.id, cut: j, rows: parked, gid: gid0 };
    // slice BEFORE the prompt: the resend re-enters the user row through
    // onMessage (same as the old last-turn toolbar function did — slicing
    // at the assistant index would store the prompt twice)
    for (var k = j + 1; k < ms.length; k++)
        if (ms[k] && ms[k].role === 'assistant') saySilence(ms[k].mid);
    CORE._conv.messages = ms.slice(0, j);
    renderHistory();
    saySweepPlans();
    // UP-29: NO saveConv() at the provisional truncation — the onMessage
    // commits on both sides (replayed prompt row, final answer) persist the
    // merged pair; a reload before the merge still shows the OLD answer.
    // Regenerate OPTIONS (classic :7216-7233 mirrored, not invented):
    if (opts.model) {
        // 'Regenerate with…' SWITCHES the conversation's model — sticky,
        // exactly like classic's selectModel(opts.model) at :7226, and the
        // header picker follows so the UI never lies about the selection.
        // UP-37(3): the SAME path the picker uses, so the per-model knob map
        // is honoured here too (leave-and-return keeps each model's set).
        switchChatModel(String(opts.model));
        var sel = gid('chat-native-model');
        if (sel) sel.value = CORE._conv.model;
    }
    if (opts.creative) CORE._oneShotGen = { temperature: creativeTemp() };
    // UP-43: a LIVE prompt replays its own files (session previews hold the
    // File refs — classic re-sends content arrays from the session, so the
    // regenerated turn goes out with the same parts as the original). A
    // reloaded row has no bytes BY DESIGN, only meta: text-only replay, the
    // chips under the deleted turn's bubble were informational anyway.
    var replay = attPreviewOf(prev);
    var submit = { text: String(prev.content) };
    if (replay && replay.length) submit.files = replay;
    CORE._dc.submitUserMessage(submit);
}

function selectVariantAt(idx, vid) {
    // Variant tab switch (classic selectVariant :3581). Content, thinking
    // and usage already RIDE the rows, so flipping vsel + one renderHistory
    // moves the whole view — no per-widget bookkeeping.
    var ms = (CORE._conv && CORE._conv.messages) || [];
    var m = ms[idx];
    if (!m || !m.vg || CORE._streaming) return false;
    var g = variantGroup(ms, m.vg);
    if (!g || g.vids.indexOf(vid) < 0) return false;
    for (var i = 0; i < ms.length; i++)
        if (ms[i] && ms[i].vg === m.vg)
            ms[i].vsel = ms[i].vid === vid ? 1 : 0;
    renderHistory();
    saveConv();
    return true;
}

function deleteVariantAt(idx, vid) {
    // Delete ONE variant (classic's per-tab trash, :1550). The two-step
    // ARM lives in the strip UI; this is the guarded primitive: the last
    // remaining chain can never be deleted, and deleting down to one
    // leaves a PLAIN assistant turn (markers cleared — no vestigial tab
    // machinery).
    if (CORE._streaming || !CORE._conv || CORE._variantStash) return false;
    var ms = CORE._conv.messages;
    var m = ms[idx];
    if (!m || !m.vg) return false;
    var g = variantGroup(ms, m.vg);
    if (!g || g.vids.length < 2 || g.vids.indexOf(vid) < 0) return false;
    var wasActive = vid === g.activeVid;
    var kept = [], gone = [];
    for (var i = 0; i < ms.length; i++)
        (ms[i] && ms[i].vg === m.vg && ms[i].vid === vid ? gone : kept).push(ms[i]);
    for (var gi = 0; gi < gone.length; gi++) saySilence(gone[gi].mid);
    CORE._conv.messages = kept;
    var left = variantGroup(kept, m.vg);
    if (!left || left.vids.length < 2) {
        // down to ONE survivor: it is a plain assistant turn again —
        // strip the markers so no vestigial tab machinery can fire
        for (var k = 0; k < kept.length; k++)
            if (kept[k] && kept[k].vg === m.vg) {
                delete kept[k].vg; delete kept[k].vid; delete kept[k].vsel;
            }
    } else if (wasActive) {
        var lastVid = left.vids[left.vids.length - 1];
        for (var q = 0; q < kept.length; q++)
            if (kept[q] && kept[q].vg === m.vg)
                kept[q].vsel = kept[q].vid === lastVid ? 1 : 0;
    }
    saySweepPlans();                   // nothing left behind that can speak
    renderHistory();
    saveConv();
    return true;
}

function variantStripEl(idx) {
    // The compact tab strip on the LAST row of the active chain (classic's
    // response-tab group :1534-1551 — uplift's action bar is its own track,
    // no new overlay machinery). Renders only when the group exists (2+
    // chains, markers alive): no markers after a pre-whitelist reload means
    // no strip, exactly as documented.
    var ms = (CORE._conv && CORE._conv.messages) || [];
    var m = ms[idx];
    if (!m || m.role !== 'assistant' || !m.vg || m.vsel === 0) return null;
    var next = ms[idx + 1];
    if (next && next.vg === m.vg && next.vid === m.vid) return null; // mid-chain
    var g = variantGroup(ms, m.vg);
    if (!g || g.vids.length < 2) return null;
    var wrap = el('span', 'chat-native-variants');
    g.vids.forEach(function (vid, vi) {
        var tab = el('button', 'chat-native-vartab' +
                   (vid === g.activeVid ? ' active' : ''), String(vi + 1));
        tab.type = 'button';
        tab.dataset.vid = String(vid);
        tab.title = t('uplift.chat.variant_show', 'Show reply {n}')
            .replace('{n}', String(vi + 1)) +
            (g.labels[vid] ? ' \u00b7 ' + g.labels[vid] : '');
        tab.addEventListener('click', function (ev) {
            ev.stopPropagation();
            selectVariantAt(idx, vid);
        });
        wrap.appendChild(tab);
        var x = el('button', 'chat-native-vardel', '\u00d7');
        x.type = 'button';
        x.title = t('uplift.chat.variant_delete', 'Delete reply {n}')
            .replace('{n}', String(vi + 1));
        var armed = false;
        x.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (!armed) {
                // two-step, in place — the file's own doctrine (msgDelete
                // guards, cache cleanup confirms inline); a hover bar that
                // vanishes on mouseout must never lean on window.confirm
                armed = true;
                x.textContent = '?';
                x.title = t('uplift.chat.variant_delete_confirm',
                            'Click again to delete this reply');
                setTimeout(function () {
                    if (!armed) return;
                    armed = false; x.textContent = '\u00d7';
                }, 3000);
                return;
            }
            deleteVariantAt(idx, vid);
        });
        wrap.appendChild(x);
    });
    return wrap;
}

var _regenMenu = null;
function closeRegenMenu() {
    if (!_regenMenu) return;
    var menu = _regenMenu;
    _regenMenu = null;
    var doc = W() && W().document;
    if (menu.__away && doc && doc.removeEventListener) {
        try { doc.removeEventListener('click', menu.__away, true); } catch (e) {}
    }
    try { menu.remove(); } catch (e) { /* box already re-rendered away */ }
}
function openRegenMenu(idx, btn) {
    // The regenerate options hub (classic :7218-7233: plain / creative /
    // 'Regenerate with…'). Built like this file's other inline overlays
    // (openEditor): createElement + textContent, mounted ON the owning
    // action bar so any re-render retires it with the bar itself.
    if (CORE._streaming || !CORE._conv) return;
    var anchor = btn && btn.parentElement;
    if (!anchor) return;
    if (_regenMenu && _regenMenu.__idx === idx) { closeRegenMenu(); return; }
    closeRegenMenu();
    var menu = el('div', 'chat-native-regen-menu');
    menu.__idx = idx;
    function item(key, fb, fn) {
        var b = mkBtn('chat-native-regen-item', t(key, fb));
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            closeRegenMenu();
            fn();
        });
        menu.appendChild(b);
        return b;
    }
    item('chat.regenerate_tooltip', 'Regenerate',
         function () { msgRegenerate(idx); });
    item('uplift.chat.regen_creative', 'Creative (+0.4 temp)',
         function () { msgRegenerate(idx, { creative: true }); });
    // 'Regenerate with…' — a chat-capable model picker. Parity by SOURCE,
    // not by re-filtering: _models IS the header picker's list (CHAT-FILTER
    // at boot), so the menu and the select can never disagree — the u29
    // gate pins both against the picker DOM.
    var sel = el('select');
    sel.className = 'chat-native-regen-model';
    var ph = el('option', null,
                t('uplift.chat.regen_with', 'Regenerate with\u2026'));
    ph.value = '';
    sel.appendChild(ph);
    (CORE._models || []).forEach(function (mo) {
        var o = el('option', null, mo.id); o.value = mo.id;
        sel.appendChild(o);
    });
    menu.appendChild(sel);
    var go = mkBtn('chat-native-regen-go', '\u21bb');
    go.title = t('uplift.chat.regen_go',
                 'Regenerate with the selected model');
    go.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var v = sel.value;
        closeRegenMenu();
        if (v) msgRegenerate(idx, { model: v });
    });
    menu.appendChild(go);
    anchor.appendChild(menu);
    _regenMenu = menu;
    var doc = W() && W().document;
    menu.__away = function (ev) {
        if (_regenMenu !== menu) return;
        var tgt = ev && (ev.composedPath && ev.composedPath().length
            ? ev.composedPath()[0] : ev && ev.target);
        if (menu.contains && tgt && (menu.contains(tgt) || tgt === btn)) return;
        closeRegenMenu();
    };
    if (doc && doc.addEventListener) {
        try { doc.addEventListener('click', menu.__away, true); } catch (e) {}
    }
}

async function msgBranch(idx) {
    // UP-29 (classic branchChat :7365-7410): duplicate the transcript up to
    // and INCLUDING the user message at idx into a NEW conversation that
    // inherits model / systemPrompt / activeProfile / customPrompt /
    // thinking / generation — then switch to it. The branch is just a new
    // server-stored conversation (POST /chat/history — no route needed),
    // and the rows are DEEP copies: shared row objects would make an edit
    // in one chat silently rewrite the other. Session-only file previews
    // stay with the original rows, exactly like classic's storage clones.
    if (!CORE._conv) return;
    var m = messageAt(idx);
    if (!m || m.role !== 'user') return;
    if (CORE._variantStash) return;                 // mid-regenerate: nothing settled
    if (CORE._streaming) await stopAndSettle();     // UP-34 doctrine: settle first
    if (CORE._streaming) return;                    // classic's refuse-while-streaming
    if (CORE._conv.messages[idx] !== m) return;     // the settle commit moved the store
    var src = CORE._conv;
    var b = newConv();
    b.title = (t('uplift.chat.branch_prefix', 'Branch of ') +
               (src.title || t('chat.untitled_title', 'Untitled'))).slice(0, 48);
    b.model = src.model;
    b.systemPrompt = src.systemPrompt;
    b.activeProfile = src.activeProfile;
    b.customPrompt = src.customPrompt;
    b.customState = src.customState
        ? JSON.parse(JSON.stringify(src.customState)) : null;
    b.variants = src.variants
        ? JSON.parse(JSON.stringify(src.variants)) : {};
    b.thinking = src.thinking;
    b.thinkingBudget = src.thinkingBudget;
    // UP-37(3): classic branchChat :7406 carries the per-model knob map into
    // the branch (deep copy — a shared object would tie the two chats).
    b.modelSettingsByModel = src.modelSettingsByModel
        ? JSON.parse(JSON.stringify(src.modelSettingsByModel)) : {};
    b.generation = src.generation
        ? JSON.parse(JSON.stringify(src.generation)) : null;
    b.pinned = false;
    b.messages = src.messages.slice(0, idx + 1).map(function (r) {
        return JSON.parse(JSON.stringify(sanitizeMsgForStore(r)));
    });
    if (!b.messages.length) return;
    var d = D();
    try {
        await d.postJson(api() + '/chat/history', b);
    } catch (e) {
        d.toast(errText(e), 'error');
        return;
    }
    CORE._convs.push({ id: b.id, title: b.title, model: b.model,
                  message_count: b.messages.length, updated: Date.now() });
    try {
        await openConv(b.id);   // full switch: fetch + render + model select +
                                // hydrate + VOICE-11/13 teardown rules
    } catch (e) {
        d.toast(errText(e), 'error');
    }
}

function commitEditedInPlace(idx, contentVal, reasoningVal) {
    // U74 + U75: assistant edits save ONTO the row (no truncation, no
    // send) — the point is conditioning the NEXT generation's context.
    // Diff-aware: only fields that actually CHANGED are written, the
    // edited stamp lands only when something changed (opening the editor
    // and pressing Save unchanged must NOT mark the message), and the
    // view persists with a single render. reasoning may be emptied
    // (deliberate: drop it from the card); content keeps non-empty.
    if (CORE._streaming || !CORE._conv) return false;
    var m = messageAt(idx);
    if (!m || m.role !== 'assistant') return false;
    var touched = false;
    if (contentVal != null && contentVal !== String(m.content || '')) {
        if (!contentVal.trim()) return false;   // empty reply = refuse save
        m.content = contentVal; touched = true;
    }
    if (reasoningVal != null &&
        reasoningVal !== String(m.reasoning_content || '')) {
        if (reasoningVal.trim()) m.reasoning_content = reasoningVal;
        else delete m.reasoning_content;
        touched = true;
    }
    if (!touched) return false;
    m.edited = new Date().toISOString();
    renderHistory();
    saveConv();
    return true;
}

function commitEdit(idx, text) {
    // U45 semantics unchanged (pinned by its test): truncate the store at
    // the edited user row, persist, replay the edited text as a new turn
    if (CORE._streaming || !CORE._conv) return;
    // UP-43: the edited row's live files ride the replay (see msgRegenerate)
    var replay = attPreviewOf(CORE._conv.messages[idx]);
    CORE._conv.messages = CORE._conv.messages.slice(0, idx);
    renderHistory();
    saveConv();
    var submit = { text: text };
    if (replay && replay.length) submit.files = replay;
    CORE._dc.submitUserMessage(submit);
}

function visibleOrdinal(msgs, idx) {
    // store idx -> bubble ordinal under renderHistory's content filter
    var ord = -1;
    for (var i = 0; i < msgs.length; i++) {
        if (!isVisibleRow(msgs[i])) continue;  // UP-43: shared predicate
        ord++;
        if (i === idx) return ord;
    }
    return -1;
}

function openEditor(idx) {
    // U73 + U75: ONE inline editor per message. Assistant rows get the
    // UNIFIED form (user: 'just one Edit button for both the reply and
    // thinking'): thinking textarea (when the row has reasoning) above
    // the reply textarea, ONE Save/Cancel bar hugging the right edge of
    // the input on the row's own side. User rows keep the single replay
    // editor. Textareas REPLACE what they edit (display:none), Enter=
    // Save, Shift+Enter=break, Escape=Cancel.
    if (CORE._streaming || !CORE._conv) return;
    var m = messageAt(idx);
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
    var root = CORE._dc && CORE._dc.shadowRoot;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var bubbles = root.querySelectorAll('.message-bubble');
    var ord = visibleOrdinal(CORE._conv.messages, idx);
    var bub = bubbles[ord];
    var holder = bub && bub.parentElement;
    if (!holder) return;
    var liveTa = holder.querySelector('.chat-native-edit');
    if (liveTa) { liveTa.focus(); return; }   // one editor per message
    var ai = m.role === 'assistant';
    var card = ai ? holder.querySelector(':scope > .chat-native-thinking') : null;
    var nodes = [];                            // created, for teardown

    function mkTa(cls, value, rows, labelKey) {
        var ta = document.createElement('textarea');
        ta.className = 'chat-native-edit' + (cls ? ' ' + cls : '');
        ta.value = value;
        ta.rows = rows;
        if (labelKey) {
            var lab = tf2(labelKey[0], labelKey[1]);
            ta.setAttribute('aria-label', lab);
            ta.placeholder = lab;
        }
        nodes.push(ta);
        return ta;
    }

    var taR = null;
    var haveReasoning = ai && !!(m.reasoning_content ||
        (card && String(card.querySelector('.chat-native-think-body')
              ? card.querySelector('.chat-native-think-body').textContent : '').trim()));
    if (haveReasoning) {
        var bodyEl = card && card.querySelector('.chat-native-think-body');
        var rv = String(m.reasoning_content || (bodyEl ? bodyEl.textContent : ''));
        taR = mkTa('reasoning', rv, Math.min(12, Math.max(3, rv.split('\n').length)),
            ['chat.thinking_label', 'Thinking']);
    }
    var taC = mkTa(ai ? 'ai' : '', String(m.content),
        Math.min(10, Math.max(2, String(m.content).split('\n').length)));
    var bar = document.createElement('div');
    bar.className = 'chat-native-edit-actions' + (ai ? ' left' : '');
    var saveB = mkBtn('save', t('chat.system_prompt.save', 'Save'));
    var cancelB = mkBtn('', t('chat.edit_cancel', 'Cancel'));
    bar.append(saveB, cancelB);
    nodes.push(bar);

    function done() {
        nodes.forEach(function (n) { n.remove(); });
        bub.style.display = '';
        if (card) card.style.display = '';
    }
    saveB.addEventListener('click', function () {
        if (!taC.value.trim()) return;        // empty reply = refuse (editor stays)
        // Both save paths refuse to act while a reply is in flight. Say so and
        // KEEP the editor with its typed text — silently returning here was
        // half of 'editing a bubble does nothing'.
        if (CORE._streaming) { editWaitToast(); return; }
        if (ai) {
            // in-place; a fully-unchanged save commits nothing and marks
            // nothing — close quietly
            commitEditedInPlace(idx, taC.value, taR ? taR.value : null);
            done();
        } else {
            done();
            commitEdit(idx, taC.value);       // U45 truncate-and-replay
        }
    });
    cancelB.addEventListener('click', done);
    nodes.forEach(function (n) {
        if (n.tagName === 'TEXTAREA') wireKeys(n, saveB, done);
    });
    if (card) card.style.display = 'none';
    bub.style.display = 'none';               // editor replaces the message
    var anchor = holder.querySelector('.chat-native-msg-actions') || null;
    if (ai && card) holder.insertBefore(bar, card);
    else holder.insertBefore(bar, anchor);
    if (taR) holder.insertBefore(taR, bar);
    holder.insertBefore(taC, bar);
    focusEnd(taR || taC);
    // BUG (user: 'editing a bubble does nothing'): on the bottom-most message
    // the Save/Cancel row fell outside the message scroller, under the composer
    // — a real click hit the composer and the save never ran. Bring the editor's
    // own controls into view, and again next frame (hiding the bubble moves the
    // scroll height after this pass has laid out).
    scrollIntoChatView(bar);
    var raf = W() && W().requestAnimationFrame;
    if (raf) { try { raf(function () { scrollIntoChatView(bar); }); } catch (e) {} }
}

function msgEdit(idx) { openEditor(idx); }

function usageLabel(u) {
    // UP-38: compact token strip — ' 128→64 tok'; '' when absent.
    if (!u || !u.completion_tokens) return '';
    return ' \u00b7 ' + (u.prompt_tokens || 0) + '\u2192' + u.completion_tokens + ' tok'
        + (u.tps ? ' \u00b7 ' + u.tps + ' t/s' : '');
}

function paramsLabel(pp) {
    // U78: compact provenance chip text — 'temp 0.6 · top_p 0.9 · think 64';
    // enable_thinking true alone -> 'think on'; budget implies enable.
    if (!pp) return '';
    var short = { temperature: 'temp', max_tokens: 'max', top_p: 'top_p',
                  top_k: 'top_k', min_p: 'min_p',
                  repetition_penalty: 'rep', presence_penalty: 'pres' };
    var bits = [];
    Object.keys(short).forEach(function (k) {
        if (pp[k] != null) bits.push(short[k] + ' ' + pp[k]);
    });
    var et = pp.chat_template_kwargs && typeof pp.chat_template_kwargs.enable_thinking === 'boolean'
        ? pp.chat_template_kwargs.enable_thinking : pp.enable_thinking;
    if (pp.thinking_budget != null) bits.push('think ' + pp.thinking_budget);
    else if (et === true) bits.push('think on');
    else if (et === false) bits.push('think off');
    // UP-37(1): classic's provenance summary carries the effort level too
    // (chat.html:7144 `effort=${gen.reasoning_effort}`) — the stop is real
    // sampling state, not junk, so it earns its slot in the chip.
    if (typeof pp.reasoning_effort === 'string' && pp.reasoning_effort)
        bits.push('effort ' + pp.reasoning_effort);
    return bits.join(' \u00b7 ');
}

function mkBtn(cls, label) {
    var b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.textContent = label;
    return b;
}

function wireKeys(ta, saveB, done) {
    ta.addEventListener('keydown', function (ev) {
        ev.stopPropagation();                 // component keys must not fire
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveB.click(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); done(); }
    });
}

function focusEnd(ta) {
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
}

function scrollIntoChatView(node) {
    // Why openEditor calls this: see the note at its call site. The BOTTOM of
    // the injected editor is the part the composer covers, so block:'end'.
    if (!node || !node.scrollIntoView) return;
    try { node.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (e) {}
}

function editWaitToast() {
    var d = D();
    if (d && d.toast) d.toast(t('uplift.chat.edit_wait_reply',
        'Wait for the reply to finish before saving this edit.'), 'error');
}

// ---- UP-40(4): the '?' keyboard-shortcut sheet ----------------------------
// classic shows a fixed modal (chat.html:2728-2757), opened by '?' in
// handleGlobalKeydown (:7906 — never while typing, :7884) or by the settings
// entry (:2514 'View shortcuts'). Same affordance here with UPLIFT's list:
// the composer keys, Esc-as-stop (UP-40 3), the dblclick rename (UP-39), the
// regenerate hub (UP-29) and the attachment paths (UP-43). Built with the
// house pattern (grammar-pop / helper prune): .modal-overlay + .modal.nasa,
// dismissed by the ONE global Escape handler (uplift_state.js), which calls
// the overlay's __upliftModalClose for teardown. Labels are classic's
// catalog keys where they exist (chat.shortcut_*), uplift.chat.* elsewhere.
var _helpOverlay = null;
// Propagation is the trap: the app-wide Escape handler lives on DOCUMENT,
// and in the bubble phase document is reached BEFORE window — so by the time
// chatGlobalKey sees the key, the sheet is already gone and a plain
// "was it open?" test would fall through to the stop rule and CUT A STREAM
// the user never meant to stop. The teardown therefore hands this Escape to
// the sheet exactly once (cleared on the next tick, so a later Escape stops
// normally again).
var _helpEscapeTaken = false;
// [what-key, what-fallback, key-key, key-fallback]
var HELP_ROWS = [
    ['chat.shortcut_send', 'Send message', 'chat.shortcut_key_enter', 'Enter'],
    ['chat.shortcut_newline', 'Newline in message', 'chat.shortcut_shift_enter', 'Shift + Enter'],
    ['chat.shortcut_stop', 'Stop generating', 'chat.shortcut_key_esc', 'Esc'],
    ['chat.rename_tooltip', 'Rename chat', 'uplift.chat.help_gesture_dblclick', 'Double-click'],
    ['uplift.chat.help_variants', 'Regenerate keeps every reply. Switch with the tabs.', 'chat.regenerate_tooltip', 'Regenerate'],
    ['chat.attachments', 'Attachments', 'uplift.chat.help_gesture_drop', 'Drop'],
    ['chat.attachments', 'Attachments', 'uplift.chat.help_gesture_paste', 'Paste image'],
    ['chat.shortcut_help', 'Show this help', null, '?'],
];
function _typingNode(n) {
    if (!n || !n.tagName) return false;
    var tag = String(n.tagName).toLowerCase();
    return tag === 'input' || tag === 'textarea' || n.isContentEditable === true;
}
function isTypingTarget(ev, throughShadow) {
    // classic _isTypingTarget (chat.html:7884): INPUT / TEXTAREA /
    // contentEditable.
    //
    // The `throughShadow` flag is the one place uplift MUST differ from
    // classic, and the difference is the KEY, not the taste: deep-chat's
    // composer lives in a SHADOW ROOT, so a window-level listener sees the
    // RETARGETED host (<deep-chat>) as ev.target and the textarea is
    // invisible. For a PRINTABLE key that matters — '?' is a character the
    // user is typing, so asking "am I typing?" without composedPath() pops
    // the sheet on every question mark. Escape is not a character: typing
    // cannot be interrupted by it, and the landed UP-40(3) rule (Esc stops
    // the stream, exactly where the operator is mid-message) is kept
    // byte-for-byte. So: '?' passes true, Escape passes false.
    if (_typingNode(ev && ev.target)) return true;
    if (!throughShadow) return false;
    var path = (ev && typeof ev.composedPath === 'function') ? ev.composedPath() : null;
    if (!path) return false;
    for (var i = 0; i < path.length; i++) if (_typingNode(path[i])) return true;
    return false;
}
function shortcutsHelpEl() { return _helpOverlay; }
function closeShortcutsHelp() {
    // true = a sheet was open (the caller swallows the key: classic's Escape
    // rule :2894 closes the sheet INSTEAD of stopping the stream).
    if (!_helpOverlay) return false;
    var ov = _helpOverlay;
    _helpOverlay = null;
    ov.__upliftModalClose = null;
    try { ov.remove(); } catch (e) { /* already gone */ }
    return true;
}
function openShortcutsHelp() {
    if (_helpOverlay) return _helpOverlay;        // '?' twice is not a stack
    var doc = W() && W().document;
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return null;
    var ov = el('div', 'modal-overlay chat-help-overlay');
    var box = el('div', 'modal nasa chat-help');
    var h = el('h3', null, t('chat.keyboard_shortcuts', 'Keyboard shortcuts'));
    var list = el('div', 'chat-help-list');
    HELP_ROWS.forEach(function (r) {
        var row = el('div', 'chat-help-row');
        row.appendChild(el('span', 'chat-help-what', t(r[0], r[1])));
        // classic translates the caps too (chat.shortcut_key_enter/…); the
        // gesture rows carry uplift keys with the literal as the fallback
        row.appendChild(el('kbd', 'chat-help-kbd',
                           r[2] ? t(r[2], r[3]) : r[3]));
        list.appendChild(row);
    });
    var closeB = mkBtn('btn', t('modal.model_settings.actions.close', 'Close'));
    closeB.addEventListener('click', function () { closeShortcutsHelp(); });
    box.append(h, list, closeB);
    ov.append(box);
    // backdrop click closes (classic :2730 @click on the backdrop, .stop on
    // the card); Escape belongs to the ONE global handler in uplift_state.js
    ov.addEventListener('click', function (ev) {
        if (ev.target === ov) closeShortcutsHelp();
    });
    ov.__upliftModalClose = function () {
        _helpEscapeTaken = true;     // the document handler got here first
        closeShortcutsHelp();
        var w = W();
        if (w && w.setTimeout) w.setTimeout(function () { _helpEscapeTaken = false; }, 0);
    };
    _helpOverlay = ov;
    doc.body.appendChild(ov);
    return ov;
}
function helpButtonEl() {
    // classic's settings entry (chat.html:2514) — the sheet must be findable
    // without knowing the key exists.
    var b = el('button', 'btn', '? ' + t('chat.shortcuts', 'Shortcuts'));
    b.type = 'button'; b.id = 'chat-native-help';
    b.title = t('chat.view_shortcuts', 'View keyboard shortcuts');
    b.addEventListener('click', function () { openShortcutsHelp(); });
    return b;
}
function chatGlobalKey(ev) {
    // ONE window listener, classic's handleGlobalKeydown shape (:2891-2910):
    // Escape closes the sheet first, stops the stream only when the user is
    // not typing; '?' opens the sheet, never while typing.
    if (!ev) return;
    if (ev.key === 'Escape') {
        if (_helpEscapeTaken) { _helpEscapeTaken = false; return; }
        if (closeShortcutsHelp()) return;
        if (!CORE._streaming || isTypingTarget(ev, false)) return;
        stopAndSettle();   // UP-34/40: settle through the component's stop
        return;
    }
    if (ev.key === '?' && !(ev.metaKey || ev.ctrlKey || ev.altKey)
        && !isTypingTarget(ev, true)) {
        ev.preventDefault();
        openShortcutsHelp();
    }
}

// U74: what does the Edited mark claim? 'next' = this row conditions the
// NEXT reply: it is the last message and an assistant row was edited.
function editedClaim() {
    var ms = (CORE._conv && CORE._conv.messages) || [];
    for (var i = ms.length - 1; i >= 0; i--) {
        if (!isVisibleRow(ms[i])) continue;   // UP-43: shared predicate
        return ms[i].role === 'assistant' && ms[i].edited ? 'next' : '';
    }
    return '';
}

function msgDelete(idx) {
    if (!CORE._conv) return;
    if (CORE._streaming) return;      // classic deleteMessage guard: never during a stream
    var m = messageAt(idx);
    if (!m) return;
    saySilence(m.mid);                 // (user) deleting a bubble silences it
    // UP-34 (1d): classic deleteMessage/sliceBeforeMessage TRUNCATES —
    // deleting a user row drops it and everything after; deleting an
    // assistant row drops back to just before its user row. The old
    // single-row splice orphaned pairs and shifted role alignment.
    var ms = CORE._conv.messages, from = idx;
    if (m.role !== 'user') {
        // classic sliceToUserTurn: keep through the question, cut the answer
        // and everything after it
        for (var i = Math.min(idx, ms.length) - 1; i >= 0; i--) {
            if (ms[i].role === 'user') { from = i + 1; break; }
        }
    }
    ms.splice(from);
    renderHistory();
    saySweepPlans();                   // nothing left behind that can speak
    if (!ms.length) {
        // classic: an emptied chat is auto-deleted (skipConfirm)
        var d = D();
        (CORE._conv.temporary ? Promise.resolve()   // UP-65: nothing stored
            : d.deleteJson(api() + '/chat/history/' + encodeURIComponent(CORE._conv.id)))
         .then(function () {
            CORE._convs = CORE._convs.filter(function (c) { return c.id !== CORE._conv.id; });
            CORE._conv = newConv();
            if (CORE._dc) CORE._dc.history = [];
            if (CORE._ctxRender) CORE._ctxRender();   // UP-16: deleted chat, zero gauge
            refreshConvList();
         }).catch(function (e) { d.toast(errText(e), 'error'); });
        return;
    }
    saveConv();
}

// UP-32 (4e): classic's click-to-zoom — one shared overlay, dismissed by a
// click anywhere or Escape. Runs inside the same post-render sweep that
// already rewrites link/image schemes, so it sees exactly the live bubbles.
function lightboxWire(root) {
    var imgs = root.querySelectorAll('.message-bubble img');
    for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        if (im.__lb) continue;
        im.__lb = true;
        im.style.cursor = 'zoom-in';
        im.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var uri = this.getAttribute('src');
            if (!uri || /^(javascript|data:text)/i.test(uri)) return;
            var doc = W().document;
            var ov = doc.createElement('div');
            ov.className = 'chat-lightbox';
            var big = doc.createElement('img');
            big.src = uri;
            ov.append(big);
            var bye = function () { ov.remove();
                W().removeEventListener('keydown', esc); };
            var esc = function (e) { if (e.key === 'Escape') bye(); };
            ov.onclick = bye;
            W().addEventListener('keydown', esc);
            doc.body.append(ov);
        });
    }
}

function attachMessageActions(dc) {
    var root = dc && dc.shadowRoot;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    schemeGuard(root);
    lightboxWire(root);   // UP-32 (4e): classic's click-to-zoom on chat images
    var bubbles = root.querySelectorAll('.message-bubble');
    if (!bubbles.length) { _msgActions = new WeakMap(); return; }
    // filtered view order == store order for NON-empty messages (see
    // header note); map bubble k -> the k-th stored non-empty message
    var ms = (CORE._conv && CORE._conv.messages) || [];
    var visible = [];
    for (var i = 0; i < ms.length; i++) {
        if (isVisibleRow(ms[i])) visible.push(i);   // UP-43: shared predicate
    }
    var liveOrd = lastAiVisible();   // bubble ordinal the live stream owns
    // U74: mark context — which row the 'used on next reply' claim belongs
    // to, and the claim for THIS conversation state
    var claim = editedClaim();
    var lastVisibleIdx = visible.length ? visible[visible.length - 1] : -1;
    if (!CORE._streaming && typeof root.querySelectorAll === 'function') {
        // finalize wipe: persisted text (if any) re-creates blocks below —
        // a live block that outlived its stream is stale by definition
        root.querySelectorAll('.chat-native-thinking[data-live="1"]')
            .forEach(function (e) { e.remove(); });
    }
    for (var k = 0; k < bubbles.length; k++) {
        var b = bubbles[k];
        var holder = b.parentElement;      // .inner-message-container
        if (!holder || !holder.querySelector) continue;
        var storeIdx = visible[k];
        // VOICE-16: the live stream has no store row yet — the last ai bubble
        // is where its chunk rows and numbers have to appear.
        if (storeIdx === undefined && CORE.CHAT_VOICE._livePlan && autoSpeakOn() && CORE._streaming
            && k === bubbles.length - 1 && b.classList
            && b.classList.contains('ai-message'))
            sayGrid(holder, CORE.CHAT_VOICE._livePlan, -1, b);
        // U71: this bubble's thinking block. Rule: the PERSISTED store
        // text is authoritative (classic's per-message block); while a
        // stream is still in flight, the last-ai bubble shows the live
        // text instead (deep-chat appends the assistant row only when
        // the stream closes — same 'current stream' anchor classic uses).
        var thinkEl = holder.querySelector(':scope > .chat-native-thinking');
        var txt = '', isLive = false;
        if (storeIdx !== undefined && (ms[storeIdx] || {}).role === 'assistant') {
            txt = String(ms[storeIdx].reasoning_content || '');
        }
        if (!txt && CORE._streaming && k === bubbles.length - 1
            && b.classList && b.classList.contains('ai-message')) {
            // UP-35: live paint is the CURRENT round's slice — the sealed
            // rounds' blocks travel inside their .chat-native-round segment
            txt = CORE._thinkLive.slice(CORE._thinkMark); isLive = !!txt;   // in-flight ai bubble ONLY
        }
        if (txt) {
            if (!thinkEl) {
                thinkEl = thinkingBlockEl(txt, isLive);
                if (thinkEl) holder.insertBefore(thinkEl, b);
            } else {
                var tb = thinkEl.querySelector('.chat-native-think-body');
                if (tb && tb.textContent !== txt) { tb.textContent = txt; }
                if (isLive) { thinkEl.dataset.live = '1'; if (!thinkEl.open) thinkEl.open = true; }
                else if (thinkEl.dataset.live === '1') {
                    // finalized from the store: live styling off, stays open
                    thinkEl.dataset.live = '';
                }
            }
        } else if (thinkEl && thinkEl.dataset.live !== '1') {
            thinkEl.remove();
        }
        var existing = holder.querySelector(':scope > .chat-native-msg-actions');
        if (storeIdx === undefined) {     // component-local row (no store twin)
            if (existing) existing.remove();
            continue;
        }
        var role = (ms[storeIdx] || {}).role;
        sayAttach(holder, storeIdx, role, b);
        // UP-43: attachment chips under the bubble (names+kind only — the
        // store row never carries bytes). Idempotent per content signature.
        attChipsRender(holder, ms[storeIdx]);
        // U74: Edited / 'Edited — used on next reply' mark. Claim rule:
        // the LAST visible row conditions the next reply, and the claim
        // holds only while that row is an edited ASSISTANT turn (the next
        // user message will read it as context). Everything older is just
        // 'Edited'. The badge lives inside the track (msgActionsEl), so a
        // changed mark rebuilds the row — no orphaned mutations.
        var want = '', wantKey = '';
        if (ms[storeIdx].edited) {
            if (claim === 'next' && storeIdx === lastVisibleIdx) {
                wantKey = 'uplift.chat.edited_next_reply';
                want = tf2(wantKey, 'Edited \u2014 used on next reply');
            } else {
                wantKey = 'uplift.chat.edited';
                want = tf2(wantKey, 'Edited');
            }
        }
        var ptxt = role === 'assistant'
            ? paramsLabel(ms[storeIdx].params) + usageLabel(ms[storeIdx].usage) : '';
        var prev = _msgActions.get(b);
        if (existing && prev && prev.idx === storeIdx && prev.role === role
            && prev.edited === want && prev.params === ptxt)
            continue;                      // identical — no DOM churn
        if (existing) existing.remove();
        holder.appendChild(msgActionsEl(storeIdx, role, want, wantKey, ptxt));
        _msgActions.set(b, { idx: storeIdx, role: role, edited: want,
                             params: ptxt });
    }
}

// UP-33 (FEAT-1 sweep, live-verified 2026-10-24): the vendored markdown
// engine escapes RAW HTML — <img onerror>/<script> arrive as text — but it
// renders link and image URLs UNFILTERED: a poisoned model reply or a
// web-tool-fetched page can offer javascript: or data:text/html. Classic
// neutralizes this whole class with DOMPurify; at our seam the surgical
// filter is enough and cannot break KaTeX/mathml: allowed schemes keep,
// everything else loses the href/src — never the visible text. Runs in the
// same sweep the action overlay already performs after every render pass.
function schemeGuard(root) {
    var LINK_OK = /^(https?:|mailto:|#)/i, IMG_OK = /^(https?:|data:image\/)/i;
    root.querySelectorAll('a[href]').forEach(function (a) {
        var h = (a.getAttribute('href') || '').trim();
        if (!LINK_OK.test(h)) { a.removeAttribute('href'); a.removeAttribute('target'); }
    });
    root.querySelectorAll('img[src]').forEach(function (im) {
        var s = (im.getAttribute('src') || '').trim();
        if (!IMG_OK.test(s)) im.removeAttribute('src');
    });
}

function scheduleMessageActions(dc) {
    // deep-chat renders history asynchronously; one tick + a couple of
    // retries ride it out without an observer (re-render resets the
    // bubbles, so attach is idempotent by map+identity check)
    if (_overlayTimer) clearTimeout(_overlayTimer);
    var tries = 0;
    function go() {
        attachMessageActions(dc);
        if (++tries < 4) _overlayTimer = setTimeout(go, 120 * tries);
        else _overlayTimer = null;
    }
    _overlayTimer = setTimeout(go, 0);
}

return {
    checkAudioCache: checkAudioCache,
    cleanupAudioCache: cleanupAudioCache,
    msgCopy: msgCopy,
    msgCopyMarkdown: msgCopyMarkdown,
    stripMarkdown: stripMarkdown,
    creativeTemp: creativeTemp,
    variantGroup: variantGroup,
    mergeVariantChain: mergeVariantChain,
    msgRegenerate: msgRegenerate,
    selectVariantAt: selectVariantAt,
    deleteVariantAt: deleteVariantAt,
    variantStripEl: variantStripEl,
    closeRegenMenu: closeRegenMenu,
    openRegenMenu: openRegenMenu,
    msgBranch: msgBranch,
    commitEdit: commitEdit,
    msgEdit: msgEdit,
    HELP_ROWS: HELP_ROWS,
    isTypingTarget: isTypingTarget,
    shortcutsHelpEl: shortcutsHelpEl,
    closeShortcutsHelp: closeShortcutsHelp,
    openShortcutsHelp: openShortcutsHelp,
    helpButtonEl: helpButtonEl,
    chatGlobalKey: chatGlobalKey,
    msgDelete: msgDelete,
    attachMessageActions: attachMessageActions,
    scheduleMessageActions: scheduleMessageActions
};
});
