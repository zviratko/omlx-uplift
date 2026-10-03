/* FE-4: the dirty-state/CHANGES machine — ONE implementation for the two
   copies that drifted apart (uplift_gsys.js markFieldDirty/renderDirtyList
   vs uplift_mmeditor.js's lab2 block/renderEdChanges: the same JSON
   compare, .dirty/.restartq toggles, .diff-out reveal, bullet mask and
   'CHANGES (n)' box had been forked, and HAD drifted: gsys masked the
   old side '•••' + wrapped the new side in a .ch-new span, mmeditor
   printed plain text with '••• CHANGED' on BOTH sides).

   UMD (chartkit/gspec pattern): window.UpliftDirty in the page,
   require()-able in node — DOM is touched only inside functions, so unit
   tests run against a stub document.

   One canonical CHANGES-line rendering wins (gsys's richer form: old
   side '•••' when secret, new side '••• CHANGED' when secret, new side
   in a .ch-new span). Hosts keep their own dirty STATE container
   (gsys a flat map, mmeditor per-profile-tab Sets with inherit-snapshot
   orig resolution) and pass entries in — the pixels live here, the state
   lives there; section badges and inherit snapshots stay host callbacks,
   so neither host forks the module. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftDirty = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const SECRET_TEXT = '\u2022\u2022\u2022 CHANGED';   // masked field: say it changed, not what
const SECRET_OLD = '\u2022\u2022\u2022';
const ARROW = ' \u2192 ';

/* Toggle one row's dirty visuals + fill its |original| chip. Returns the
   changed flag so hosts can mirror it into their own state.
   {orig, cur, row|null, isSecret, isRestart, display(v)} */
function applyRowState(o) {
    const changed = JSON.stringify(o.orig) !== JSON.stringify(o.cur);
    const row = o.row;
    if (row) {
        row.classList.toggle('dirty', changed);
        row.classList.toggle('restartq', !!(changed && o.isRestart));
        const rd = row.querySelector('.diff-out');
        if (rd) {
            rd.hidden = !changed;
            if (changed && o.isSecret) {
                rd.classList.add('masked');
                rd.querySelector('.diff-o').textContent = SECRET_TEXT;
            } else if (changed) {
                rd.classList.remove('masked');
                rd.querySelector('.diff-o').textContent = o.display(o.orig);
            }
        }
    }
    return changed;
}

/* Append one CHANGES line to `host` (entry: {key, orig, cur, isSecret,
   display}). New side rides in .ch-new (the accent-colored half). */
function appendChangeLine(host, e) {
    const line = document.createElement('div');
    line.className = 'ch-line';
    const a = document.createElement('span');
    a.textContent = e.key + ': ' + (e.isSecret ? SECRET_OLD : e.display(e.orig));
    const arrow = document.createTextNode(ARROW);
    const b = document.createElement('span');
    b.className = 'ch-new';
    b.textContent = e.key + ': ' + (e.isSecret ? SECRET_TEXT : e.display(e.cur));
    line.append(a, arrow, b);
    host.append(line);
    return line;
}

/* CHANGES (n) box: head + entry lines. t(key, fallback) injected — the
   tracker stays i18n-agnostic. entries already resolved by the host
   (mmeditor prepends its expose_as_model/api_name flips there). */
function renderChangesBox(host, entries, t) {
    if (!host) return;
    host.hidden = !entries.length;
    host.textContent = '';
    if (!entries.length) return;
    const head = document.createElement('div');
    head.className = 'ch-head';
    head.textContent = (t ? t('uplift.ui.changes', 'CHANGES (') : 'CHANGES (')
        + entries.length + ')';
    host.append(head);
    for (const e of entries) appendChangeLine(host, e);
}

/* Stateful tracker for single-map hosts (gsys).
   opts: { orig(key), cur(key) [optional], isSecret(key) [opt],
           isRestart(key) [opt], rowOf(key) [opt -> element],
           display(v), t(key, fb), onChange() } */
function DirtyTracker(opts) {
    const dirty = new Map();
    const isSecret = opts.isSecret || (() => false);
    function entryFor(key) {
        return { key, orig: opts.orig(key), cur: dirty.get(key),
                 isSecret: isSecret(key), display: opts.display };
    }
    function mark(key, value) {
        const orig = opts.orig(key);
        const cur = value === undefined
            ? (opts.cur ? opts.cur(key) : undefined) : value;
        const changed = applyRowState({ orig, cur,
            row: opts.rowOf ? opts.rowOf(key) : null,
            isSecret: isSecret(key), isRestart: !!(opts.isRestart && opts.isRestart(key)),
            display: opts.display });
        if (changed) dirty.set(key, cur);
        else dirty.delete(key);                     // edited back = no longer queued
        if (opts.onChange) opts.onChange();
        return changed;
    }
    return {
        dirty,
        isDirty: key => dirty.has(key),
        keys: () => [...dirty.keys()],
        value: key => dirty.get(key),
        entryFor,
        clear() { dirty.clear(); if (opts.onChange) opts.onChange(); },
        mark,
        renderChangesBox(host, extras) {
            renderChangesBox(host, [...(extras || []),
                ...[...dirty.keys()].map(entryFor)], opts.t);
        },
    };
}

return { SECRET_TEXT, SECRET_OLD, ARROW, applyRowState, appendChangeLine,
         renderChangesBox, DirtyTracker };
});
