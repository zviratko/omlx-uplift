/* ============================================================================
   PAT-TABLE: PATCHES — one row per patch (user ask 2026-10-19).
   Row anatomy: status lamp | ORIGIN (version + HEAD commit) | patch name
   (+details row: description, full origin, safeguards, per-version diffs) |
   status text | VANILLA checkbox (runs in the server at restart) | DEV
   checkbox (compiled into omlx-dev) | MANAGE dialog (version per surface:
   latest/auto-update or pinned; test; edit source; remove).
   The checkbox pair IS the scope+enable act (POST /patches/targets —
   (0,0) disables, keeping the last scope); the build-base picker rides the
   DEV column header (native select: compact closed, expands to the full
   line when opened); AUTO UPDATE is per patch, stored in the manifest so
   CLI, boot and every browser honour the same remembered choice.
   Every button hits a PAT-2 endpoint; nothing here writes the keg
   directly — changes land at the next restart (the .pth engine, PAT-3) or
   the next Build (the dev carrier). State chips reuse the cockpit-lamp
   vocabulary; the WARNING banner lights for needs_review/failed like an
   instrument flag. PT_DATA/PT_BUSY live in window.Uplift.state (declared
   before boot can reach pollPatches via applyTab — PAT-4 TDZ property
   preserved by load order). Plain script; loads AFTER uplift_state.js +
   domkit.js, BEFORE uplift.js; FE-1 takes toast/fetchJson from
   window.UpliftDom, currentTab/currentSub late-bind via
   window.Uplift._patchesGlue (live hash readers). Escape closes the
   dialog through the global frontmost-first handler (uplift_state.js) —
   this file never owns an Escape listener (modal-escape pin).
   Exports window.Uplift.patches {pollPatches, initPatchesPage, patchRow}.
   ========================================================================== */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const PG = {
    toast: D.toast,
    fetchJson: D.fetchJson,
    get currentTab() { return window.Uplift._patchesGlue.currentTab; },
    get currentSub() { return window.Uplift._patchesGlue.currentSub; },
};
const PT_STATE_CLASS = {
    applied: 'pt-st-applied', pending: 'pt-st-pending',
    update_available: 'pt-st-update', needs_review: 'pt-st-warn',
    failed: 'pt-st-warn', obsolete: 'pt-st-dim', disabled: 'pt-st-dim',
    // the omlx-dev branch was re-cut WITHOUT this enabled patch (the
    // build's own verdict — dev board only, see mark_dev_applied)
    not_in_build: 'pt-st-warn',
};

function ptMsg(key, fb) { return C.tf(key, fb); }

async function pollPatches() {
    try {
        S.PT_DATA = await PG.fetchJson(`${API}/uplift/api/patches`);
        renderPatches();
    } catch (e) {
        const list = $('pt-list');
        if (list) list.innerHTML = '';   // clear-only assignment — safe
        if (list) {
            const d = document.createElement('div');
            d.className = 'empty';
            // a 401 means the admin session cookie is missing/expired for
            // THIS origin — 'API unavailable' sent people hunting servers
            const denied = /-> 401/.test(String(e && e.message || e));
            d.textContent = (denied
                ? ptMsg('uplift.patches.load_auth', 'Sign in required — open /admin and log in, then reload')
                : ptMsg('uplift.patches.load_fail', 'Patches API unavailable'))
                + (denied ? '' : ' — ' + (e && e.message ? e.message : e));
            list.append(d);
        }
    }
    ptAutoSyncCurated();
    // KEGID-3: patch actions change tree AND expected set — keep the
    // drift banner in step with the manifest.
    pollDoctor();
}

/* ---- curated catalog: no separate section (user ask 2026-09-30). ----
   The catalog is reconciled into the store automatically — default tier
   enabled, optional tier disabled — and every catalog patch then shows up
   as an ordinary row in the table, BUNDLED chip included. There is no
   "install" step to press; the sync runs once per page load and again
   when the user presses Check for updates. A dead network or a catalog
   hiccup is silent: the store we already have is authoritative for
   rendering. */
let PT_CURATED_SYNCED = false;
let PT_CURATED_BUSY = false;
// one details row open at a time (id); renderPatches re-opens exactly it
// so the open state survives re-renders until the user folds it
let PT_OPEN_DETAILS = null;
// the surface selection a held safeguard is waiting on ({id, runtime, dev})
let PT_PENDING_TARGETS = null;

async function ptAutoSyncCurated(force) {
    if (PT_CURATED_BUSY) return;
    if (PT_CURATED_SYNCED && !force) return;
    PT_CURATED_SYNCED = true;
    PT_CURATED_BUSY = true;
    try {
        const r = await ptApi('curated/sync', {});
        const rep = r.report || {};
        const changed = Object.values(rep)
            .filter(x => String(x.sync).startsWith('added') || x.rescope_failed).length;
        const notesEl = $('pt-curated-notes');
        if (notesEl) {
            const notes = r.notes || [];
            notesEl.hidden = !notes.length;
            notesEl.textContent = notes.join(' · ');
        }
        if (changed) {
            await pollPatches();   // bring the new rows in
            await ptRefreshCarrier();   // a widened scope may need a build
        }
    } catch (e) {
        // sync failed: keep rendering from the local store (silent by design)
    } finally {
        PT_CURATED_BUSY = false;
    }
}

function ptApi(path, body) {
    return PG.fetchJson(`${API}/uplift/api/patches/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
}

async function ptRefreshCarrier() {
    // Build-strip truth (DRIFT / NEEDS REBUILD chips) rides /dev/status,
    // NOT the patches view. Every store mutation that can move the enabled
    // build set (targets, remove, sync, check→obsolete/promote) must
    // re-read the carrier the moment it lands — a Remove that emptied the
    // drift set otherwise kept its stale DRIFT chip until a full page
    // refresh (user report 2026-10-19). pollDev repaints the strip AND
    // refills the rows (no cycle: the refill renders cached data, it
    // never re-fetches through here). Guard pollDev itself, not just
    // devpanel: an older panel bundle can load without it, and a missing
    // carrier read must never fail the action it follows (FE-5
    // graceful-no-op contract).
    const DP = window.Uplift.devpanel;
    if (DP && DP.pollDev) await DP.pollDev();
}

async function ptAction(path, body, okMsg) {
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    try {
        const r = await ptApi(path, body);
        if (okMsg) PG.toast(okMsg, 4000);
        if (r && r.reason) PG.toast(r.reason, 5000);
        await pollPatches();
        await ptRefreshCarrier();   // DRIFT/NEEDS REBUILD must not outlive
    } catch (e) {                  // the action that resolved them
        PG.toast(ptMsg('uplift.patches.action_fail', 'Patch action failed') +
              ': ' + (e && e.message ? e.message : e), 6000);
    } finally {
        S.PT_BUSY = false;
    }
}

// Enable/promote with safeguard support: on HTTP 409 the backend lists the
// codes that need an explicit approval — we do NOT silently retry.
async function ptEnableWithApproval(p, approve) {
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    try {
        const body = { id: p.id };
        if (approve) body.approve = approve;
        const r = await ptApi('enable', body);
        PG.toast(approve
            ? ptMsg('uplift.patches.approved_codes', 'approved: {codes}')
                  .replace('{codes}', (r.approved || []).join(', ') || approve)
            : enabledToast(p), 4000);
        await pollPatches();
        await ptRefreshCarrier();   // an enabled build patch changes what the
    } catch (e) {                  // branch must carry — re-judge drift now
        PG.toast(ptMsg('uplift.patches.approve_fail', 'Approval failed') +
              ': ' + (e && e.message ? e.message : e), 6000);
    } finally {
        S.PT_BUSY = false;
    }
}

/* ---- the checkbox pair: scope AND enable in one act (PAT-TABLE). ----
   (0,0) disables keeping the last scope; a widening re-gates the newly
   used tree server-side; a held safeguard comes back 409 (err.status from
   the fetchJson kit) — the checkbox visibly reverts (re-render from the
   server truth) and the row's details OPEN with the approval buttons:
   the operator never hunts for where to approve. */
async function ptSetTargets(p, runtime, dev, approve) {
    if (S.PT_BUSY) { renderPatches(); return; }
    S.PT_BUSY = true;
    try {
        const body = { id: p.id, runtime: !!runtime, dev: !!dev };
        if (approve) body.approve = approve;
        const r = await ptApi('targets', body);
        PT_PENDING_TARGETS = null;
        if (r && r.ok && !(r.unchanged && !r.scope)) {
            PG.toast(r.note ? r.note : targetsToast(r.scope, runtime, dev), 4500);
        }
        await pollPatches();
        await ptRefreshCarrier();
    } catch (e) {
        const held = (e && e.status === 409)
            || /needs approval/i.test(String(e && e.message || e));
        if (held) {
            PT_PENDING_TARGETS = { id: p.id, runtime: !!runtime,
                                   dev: !!dev };
            PT_OPEN_DETAILS = p.id;   // approvals must land in front of the eyes
            PG.toast(ptMsg('uplift.patches.targets_hold',
                'Safeguards flagged this change — approve it in the opened '
                + 'details row'), 6000);
        } else {
            PG.toast(ptMsg('uplift.patches.targets_fail',
                'Surface change failed') + ': '
                + (e && e.message ? e.message : e), 6000);
        }
        renderPatches();   // checkboxes revert to the server's truth
    } finally {
        S.PT_BUSY = false;
    }
}

function targetsToast(scope, runtime, dev) {
    if (!runtime && !dev) {
        return ptMsg('uplift.patches.targets_off',
            'Cleared — files return to vanilla on the next restart');
    }
    if (runtime && dev) {
        return ptMsg('uplift.patches.targets_both',
            'Selected for both: the server mounts it at the next restart, '
            + 'omlx-dev compiles it at the next Build');
    }
    if (runtime) {
        return ptMsg('uplift.patches.targets_runtime',
            'Selected for the server — takes effect after the next restart');
    }
    return ptMsg('uplift.patches.targets_build',
        'Selected for omlx-dev — lands at the next Build');
}

// One display line per safeguard GROUP (mirrors the backend grouping):
// one line per code, then the advisory lines. One line per problem used to
// mean eight copies of the same 500-char rebuild hint.
// SIMPLIFY (user 2026-10-10): the line says WHAT the patch targets (kernels,
// files off the keg) — it must NOT list the affected paths. The per-file
// detail already lives in the diff view the row links to, and repeating it
// here buried the actual warning. Group size stays as a bare count prefix
// ('7 files: ...') so a big patch still reads bigger than a one-path flag.
function ptSafeguardLines(p) {
    const out = [];
    const ver = (p.versions || []).find(v => v.v === (p.desired_version ||
        Math.max(...(p.versions || []).map(x => x.v)))) || {};
    const sg = ver.safeguards || {};
    for (const grp of (sg.problems || []).concat(sg.advisories || [])) {
        out.push({ text: ptGroupLine(grp), code: grp.code });
    }
    if (ver.root_note) out.push({ text: ptMsg('uplift.patches.safeguard_note',
        'Root autodetected: {n}').replace('{n}', ver.root_note), code: null });
    return out;
}

// '<msg>' for one path, '<n> files: <msg>' for a group. No path list.
function ptGroupLine(grp) {
    const msg = grp.message || '';
    const paths = grp.paths || (grp.path ? [grp.path] : []);
    if (paths.length > 1) return paths.length + ' files: ' + msg;
    return msg;
}

// PAT-TABLE (user 2026-10-20): the ORIGIN cell names WHERE the patch
// comes from, condensed; the version line stays underneath.
function ptOriginText(src, p) {
    if (src.kind === 'github_pr' && src.repo) {
        return src.repo + (src.pr ? ' PR#' + src.pr : '');
    }
    const url = src.url || '';
    let m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/);
    if (m) return m[1] + ' · ' + m[2].split('/').pop();
    m = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) return m[1] + ' PR#' + m[2];
    if (url) {
        const host = url.replace(/^https?:\/\//, '').split('/')[0];
        const tail = url.split('/').filter(Boolean).pop() || '';
        return host + (tail ? ' · ' + tail : '');
    }
    if (src.kind === 'upload' || (!url && p && p.versions)) {
        return ptMsg('uplift.patches.origin_upload', 'uploaded diff');
    }
    return src.kind || '—';
}
function ptCondensedOrigin(src, p) {
    if (src.kind === 'github_pr' && src.repo && src.pr) {
        return 'https://github.com/' + src.repo + '/pull/' + src.pr;
    }
    return src.url || null;
}

// the caret is the expand affordance — flip it with the details block
function ptPaintCarets() {
    const list = $('pt-list');
    if (!list) return;
    for (const e of list.querySelectorAll('.pt-entry'))
        if (e._ptCaret)
            e._ptCaret.textContent =
                (PT_OPEN_DETAILS === e.dataset.pid) ? '▴' : '▾';
}

function ptChip(text, cls, title) {
    const s = document.createElement('span');
    s.className = 'pt-chip ' + (cls || '');
    s.textContent = text;
    if (title) s.title = title;
    return s;
}

// PATCH-ZONE wording pass (user 2026-10-18): say WHAT LANDS WHERE, in
// plain effect words — no branch/commit/keg nouns. The effect differs by
// scope: a build-only patch lands when omlx-dev is next compiled; a
// runtime patch lands at the next server restart.
function enabledToast(p) {
    return (p && p.scope === 'dev')
        ? ptMsg('uplift.patches.enabled_toast_build',
                'Enabled — takes effect on the next omlx-dev build')
        : ptMsg('uplift.patches.enabled_toast',
                'Enabled — takes effect after the next server restart');
}

function renderPatches() {
    const d = S.PT_DATA;
    if (!d) return;
    const list = $('pt-list');
    list.innerHTML = '';   // clear-only assignment — safe

    // WARNING banner: any needs_review/failed patch (PAT-0 badge rule)
    const warn = $('pt-warn');
    warn.hidden = !d.warning;
    if (d.warning) {
        warn.textContent = ptMsg('uplift.patches.warn_banner',
            'WARNING — some patches no longer fit the installed files or failed to apply. The server runs without them until they are fixed or removed.');
    }
    const ks = $('pt-killswitch');
    ks.hidden = !d.kill_switch_active;
    if (d.kill_switch_active) {
        ks.textContent = ptMsg('uplift.patches.killswitch_on',
            'Patch engine is OFF — the server starts from unpatched files. Nothing was deleted; re-enable with: omlx-uplift patch enable-all.');
    }

    // plain status line: patches loaded vs active (enabled) — the table
    // shows every patch once (PAT-TABLE; the two-zone split is retired).
    $('pt-sub').textContent = ptMsg('uplift.patches.counts',
        '{loaded} loaded · {active} active')
        .replace('{loaded}', d.patches.length)
        .replace('{active}', d.patches.filter(p => p.enabled).length);

    // SUB-ACTIONS (user 2026-10-27, second round): the standalone
    // auto-update checkbox is gone; the AUTO-UPDATE column's "(all)" link
    // (painted here, wired in initPatchesPage) toggles every patch's
    // per-row AUTO flag in one click. 'lit' = every patch auto-updates.
    const allB = $('pt-auto-all');
    if (allB) {
        const on = d.patches.length > 0 && d.patches.every(p => p.auto_update);
        allB.classList.toggle('lit', on);
        allB.disabled = d.patches.length === 0;
    }

    if (!d.patches.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = ptMsg('uplift.patches.none',
            'No patches yet. Add a GitHub PR, URL, or upload a .diff below.');
        list.append(empty);
    }
    for (const p of d.patches) list.append(patchRow(p, d));
    ptPaintCarets();
    // FE-5 seam: dev panel lives in uplift_devpanel.js; lazy lookup so this
    // file works with the panel absent (graceful) and load order is free.
    const DP = window.Uplift.devpanel;
    if (DP) DP.renderDev();
}

/* ---- PAT-TABLE row: lamp | origin | name(+details) | status |           */
/*             VANILLA | DEV | MANAGE                                        */
function patchRow(p, view) {
    const entry = document.createElement('div');
    const bad = p.state === 'needs_review' || p.state === 'failed'
        || p.state === 'not_in_build';
    entry.className = 'pt-entry' + (bad ? ' pt-entry-warn' : '');
    entry.dataset.pid = p.id;

    const row = document.createElement('div');
    row.className = 'pt-row';

    // 1) status lamp — lit per the ONE state this board must show
    const lamp = document.createElement('span');
    lamp.className = 'pt-c-lamp pt-lamp '
        + (PT_STATE_CLASS[p.state] || 'pt-st-dim');
    lamp.title = (p.state || '').replace(/_/g, ' ').toUpperCase()
        + (p.state_detail ? ' — ' + p.state_detail : '');
    row.append(lamp);

    // 2) ORIGIN: WHO the patch came from, condensed (repo PR# / host · file
    //    / upload) with the tracked version + HEAD sha underneath — user
    //    2026-10-20: a column titled ORIGIN that only shows 'v1' is not
    //    telling where anything came from
    const ocell = document.createElement('span');
    ocell.className = 'pt-c-origin';
    const pSrc = p.source || {};
    const oline = document.createElement('span');
    oline.className = 'pt-origin-src';
    if (p.curated && !p.curated_adopted) {
        // BUNDLED names the ORIGIN (the curated catalog ships it), not the
        // state — it reads wrong among the status chips (user 2026-10-20)
        const tag = document.createElement('span');
        tag.className = 'pt-origin-tag pt-st-bundled';
        tag.textContent = ptMsg('uplift.patches.bundled_chip', 'BUNDLED');
        tag.title = ptMsg('uplift.patches.bundled_hint',
                          'part of the curated catalog — kept current by '
                          + 'curated sync');
        oline.append(tag);
    }
    const srcHref = ptCondensedOrigin(pSrc, p);
    if (srcHref) {
        const a = document.createElement('a');
        a.href = srcHref; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = ptOriginText(pSrc, p);
        a.title = pSrc.url || srcHref;
        oline.append(a);
    } else {
        oline.textContent = ptOriginText(pSrc, p);
        oline.title = pSrc.url || '';
    }
    ocell.append(oline);
    // 3) PATCH then 2) ORIGIN on screen: the user asked for the two columns
    //    exchanged (2026-10-25) — the patch name is what he scans for, the
    //    origin is supporting detail. Track widths travelled with the columns
    //    (see .pt-row), so ORIGIN keeps the wide track and PATCH the capped one.
    // version lives with the state now ('v1 APPLIED', user 2026-10-20)
    const effV = p.desired_version || p.latest_v || 0;
    const ent = (p.versions || []).find(v => v.v === effV)
        || (p.versions || []).slice(-1)[0] || {};

    // 3) PATCH: name; the details block (one open at a time) carries the
    //    description, full origin, per-version diffs, safeguards + approvals
    const pcell = document.createElement('span');
    pcell.className = 'pt-c-patch pt-name-cell';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'pt-name';
    const nmTxt = document.createElement('span');
    nmTxt.textContent = p.id;
    const caret = document.createElement('span');
    caret.className = 'pt-caret';
    caret.textContent = '▾';
    name.append(nmTxt, caret);
    name.title = ptMsg('uplift.patches.expand_hint', 'show details');
    pcell.append(name);
    entry._ptCaret = caret;   // the details toggle flips this (bigger, clear)
    row.append(pcell);
    row.append(ocell);        // ORIGIN follows PATCH here (see note above)

    // 4) STATUS: state chip + honest extras; stays CLEAN while the patch
    //    simply tracks the latest (user: pins are named, not implied)
    const scell = document.createElement('span');
    scell.className = 'pt-c-status';
    const origin = document.createElement('button');
    origin.type = 'button';
    origin.className = 'pt-origin';
    origin.textContent = 'v' + (ent.v || effV || '—');
    if ((p.latest_v || 0) > (ent.v || effV)) {
        const nx = document.createElement('span');
        nx.className = 'pt-origin-next';
        nx.textContent = ' → v' + p.latest_v;
        origin.append(nx);
    }
    origin.title = (ent.source_head_sha
        ? String(ent.source_head_sha).slice(0, 12) + ' — ' : '')
        + ptMsg('uplift.patches.show_diff', 'show stored diff');
    origin.onclick = () => ptShowDiff(p.id, ent.v || effV);
    scell.append(origin);
    scell.append(ptChip((p.state || '').replace(/_/g, ' ').toUpperCase(),
        PT_STATE_CLASS[p.state] || 'pt-st-dim', p.state_detail || ''));
    if (p.reversal) {
        scell.append(ptChip(ptMsg('uplift.patches.reversal_chip', 'REVERSAL'),
            'pt-st-reversal',
            ptMsg('uplift.patches.reversal_hint',
                  'reverts an already merged change — applied in the un-apply direction')));
    }
    if (p.source && p.source.insecure_tls) {   // UX-1 (SWEEP183 K): sticky
        scell.append(ptChip(ptMsg('uplift.patches.insecure_chip', 'INSECURE'),
            'pt-st-insecure',
            ptMsg('uplift.patches.insecure_hint',
                  'TLS verification is disabled when fetching this patch — ' +
                  'set at add time, it also applies to every later re-check')));
    }
    if (p.keg_changed && p.enabled) {
        // RUNTIME-MOUNT: with two boards on one store, "not live here" has
        // two very different fixes — a restart re-mounts a pending patch,
        // but a per-keg apply FAILURE (this board's build moved away from
        // the patched context) needs a rebased patch version. Never tell
        // the operator to restart when restart is proven not to help.
        const failed = p.this_keg === 'error';
        scell.append(ptChip(ptMsg(failed ? 'uplift.patches.keg_failed'
                                        : 'uplift.patches.keg_changed',
                               failed ? 'REVIEW' : 'NEEDS RE-APPLY'), 'pt-st-warn',
            failed ? (p.this_keg_detail ||
                      ptMsg('uplift.patches.keg_failed_hint',
                            'the patch does not fit the files this server runs — ' +
                            'restarting will not help; the patch must be updated ' +
                            'to match them first'))
                   : ptMsg('uplift.patches.keg_changed_hint',
                           'the installed files changed (an update or reinstall?) — ' +
                           'this patch is enabled but NOT in the running code. ' +
                           'Restart the server and it will be applied again.')));
    }
    const sf = p.surfaces || {};
    if (sf.runtime && sf.runtime.pinned) {
        scell.append(ptChip(ptMsg('uplift.patches.pin_vanilla',
            'VANILLA v{v} pinned').replace('{v}', sf.runtime.version),
            'pt-st-dim',
            ptMsg('uplift.patches.pin_hint',
                'this surface is frozen at this version — an update will '
                + 'not move it until you release the pin')));
    }
    if (sf.build && sf.build.pinned) {
        scell.append(ptChip(ptMsg('uplift.patches.pin_dev',
            'DEV v{v} pinned').replace('{v}', sf.build.version),
            'pt-st-dim',
            ptMsg('uplift.patches.pin_hint',
                'this surface is frozen at this version — an update will '
                + 'not move it until you release the pin')));
    }
    row.append(scell);

    // 5+6+7) DEV / VANILLA / AUTO — the first pair is scope AND enable in
    // one act; AUTO is the per-patch tracking choice, remembered in the
    // manifest (was dialog-only; the user asked for it as a column)
    const vcb = document.createElement('input');
    vcb.type = 'checkbox';
    vcb.checked = !!(sf.runtime && sf.runtime.checked);
    vcb.title = ptMsg('uplift.patches.box_vanilla_title',
        'runs in the server (vanilla + omlx-dev) — mounts at the next '
        + 'restart; unchecking restores the vanilla bytes there');
    const dcb = document.createElement('input');
    dcb.type = 'checkbox';
    dcb.checked = !!(sf.build && sf.build.checked);
    dcb.title = ptMsg('uplift.patches.box_dev_title',
        'compiled into omlx-dev — lands at the next Build');
    vcb.onchange = () => {
        // the pair posts together so (0,0) can disable in ONE act
        ptSetTargets(p, vcb.checked, dcb.checked);
    };
    dcb.onchange = () => {
        ptSetTargets(p, vcb.checked, dcb.checked);
    };
    const acb = document.createElement('input');
    acb.type = 'checkbox';
    acb.checked = !!p.auto_update;
    acb.title = ptMsg('uplift.patches.box_auto_title',
        'auto update: new validated versions apply without a click — '
        + 'remembered on the server, pinned surfaces keep their pin');
    acb.onchange = async () => {
        if (S.PT_BUSY) { acb.checked = !acb.checked; return; }
        S.PT_BUSY = true;
        try {
            const r = await ptApi('auto', { id: p.id, enabled: acb.checked });
            if (r && r.promoted) {
                PG.toast(ptMsg('uplift.patches.auto_promoted',
                    'Auto update ON — the waiting v{v} is now queued')
                    .replace('{v}', r.desired_version || ''), 5000);
            } else if (acb.checked) {
                PG.toast(ptMsg('uplift.patches.auto_on',
                    'Auto update ON — future versions apply without a click'),
                    4500);
            } else {
                PG.toast(ptMsg('uplift.patches.auto_off',
                    'Auto update OFF — updates wait for you'), 4500);
            }
            await pollPatches();
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.auto_fail',
                'Auto-update change failed') + ': '
                + (e && e.message ? e.message : e), 5000);
            acb.checked = !acb.checked;
        } finally {
            S.PT_BUSY = false;
        }
    };
    const fill = document.createElement('span');   // rides the 1fr track:
    fill.className = 'pt-c-fill';                  // grid items shift one
    const dcell = document.createElement('label');
    dcell.className = 'pt-c-dev';
    dcell.append(dcb);
    const vcell = document.createElement('label');
    vcell.className = 'pt-c-vanilla';
    vcell.append(vcb);
    const acell = document.createElement('label');
    acell.className = 'pt-c-auto';
    acell.append(acb);
    row.append(fill, dcell, vcell, acell);

    // 7) MANAGE dialog
    const mg = document.createElement('button');
    mg.type = 'button';
    mg.className = 'btn pt-manage-btn';
    mg.textContent = ptMsg('uplift.patches.manage', 'MANAGE');
    mg.onclick = () => ptManage(p);
    row.append(mg);

    entry.append(row);

    // ---- details block (hidden unless this id is the open one) ----
    const det = document.createElement('div');
    det.className = 'pt-det';
    det.hidden = PT_OPEN_DETAILS !== p.id;
    if (p.description) {
        const dsc = document.createElement('div');
        dsc.className = 'pt-det-desc';
        dsc.textContent = p.description;
        det.append(dsc);
    }
    // full origin: source line + per-version chips (click = diff)
    const src = document.createElement('div');
    src.className = 'pt-src';
    const s = p.source || {};
    let srcTxt;
    if (s.kind === 'github_pr') srcTxt = `github PR ${s.repo || ''}#${s.pr || ''}`;
    else if (s.kind === 'url') srcTxt = s.url || 'url';
    else srcTxt = ptMsg('uplift.patches.source_upload', 'uploaded file');
    src.textContent = srcTxt;
    if (s.url) {
        const a = document.createElement('a');
        a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = ' ↗';
        src.append(a);
    }
    det.append(src);
    const vers = document.createElement('div');
    vers.className = 'pt-vers';
    for (const v of (p.versions || []).slice().sort((a, b) => a.v - b.v)) {
        const isApplied = p.applied_v === v.v;
        const isDevApplied = p.dev_applied_v === v.v;
        const isDesired = p.desired_version === v.v;
        const isCandidate = !isDesired && v.v === (p.latest_v || 0);
        const chip = ptChip('v' + v.v + (isApplied ? ' ●'
            : isDevApplied ? ' ▲' : isDesired ? ' ◐' : ''),
            isApplied ? 'pt-st-applied'
                : (isCandidate && p.state === 'update_available')
                    ? 'pt-st-update' : 'pt-st-dim',
            (v.fetched_at || '') + (v.source_head_sha
                ? ' · ' + v.source_head_sha.slice(0, 12) : ''));
        chip.style.cursor = 'pointer';
        chip.title = ptMsg('uplift.patches.show_diff', 'show stored diff')
            + ' — ' + chip.title;
        chip.onclick = () => ptShowDiff(p.id, v.v);
        vers.append(chip);
    }
    det.append(vers);
    if (p.inactive_reason) {
        const ir = document.createElement('div');
        ir.className = 'pt-detail';
        ir.textContent = p.inactive_reason;
        det.append(ir);
    }
    // safeguards: grouped problem lines, advisory lines, autodetected
    // root, rebuild command, per-code approvals (the note names the
    // EXCEPTIONS, not a blanket off). The approval box renders whenever
    // codes are HELD too — hiding the means while demanding it is not an
    // option (fixture-tested: requires_approval without stored lines).
    const sgLines = ptSafeguardLines(p);
    const approved = p.safeguard_always || [];
    const heldCodes = p.requires_approval || [];
    if (sgLines.length || approved.length || heldCodes.length) {
        const box = document.createElement('div');
        box.className = 'pt-safeguards';
        if (sgLines.length) {
            const t = document.createElement('div');
            t.className = 'pt-sg-title';
            t.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(t);
            for (const l of sgLines) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + l.text;
                box.append(w);
            }
        }
        if (p.kernel_rebuild_hint) {
            const rr = document.createElement('div');
            rr.className = 'pt-sg-rebuild';
            const lbl = document.createElement('span');
            lbl.textContent = ptMsg('uplift.patches.safeguard_rebuild',
                'Native kernel rebuild (required for real effect):');
            const cmd = document.createElement('code');
            cmd.textContent = p.kernel_rebuild_hint;
            cmd.title = 'click to copy';
            cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); };
            rr.append(lbl, document.createTextNode(' '), cmd);
            box.append(rr);
        }
        if (approved.length) {
            const a = document.createElement('div');
            a.className = 'pt-detail';
            a.textContent = '✓ ' + ptMsg('uplift.patches.approved_codes',
                'approved: {codes}').replace('{codes}', approved.join(', '));
            box.append(a);
        }
        const acts = document.createElement('div');
        if (heldCodes.length) {
            acts.className = 'pt-acts pt-sg-acts';   // flex gap — two adjacent
            const once = document.createElement('button');
            once.type = 'button';
            once.className = 'btn primary';
            once.textContent = ptMsg('uplift.patches.approve_once',
                'Apply once anyway');
            once.onclick = () => {
                const pend = PT_PENDING_TARGETS
                    && PT_PENDING_TARGETS.id === p.id
                    ? PT_PENDING_TARGETS : null;
                if (pend) ptSetTargets(p, pend.runtime, pend.dev, 'once');
                else ptEnableWithApproval(p, 'once');
            };
            const al = document.createElement('button');
            al.type = 'button';
            al.className = 'btn primary';
            al.textContent = ptMsg('uplift.patches.approve_always',
                'Always allow ({codes})')
                .replace('{codes}', heldCodes.join(', '));
            al.onclick = () => {
                const pend = PT_PENDING_TARGETS
                    && PT_PENDING_TARGETS.id === p.id
                    ? PT_PENDING_TARGETS : null;
                if (pend) ptSetTargets(p, pend.runtime, pend.dev, 'always');
                else ptEnableWithApproval(p, 'always');
            };
            acts.append(once, al);
            box.append(acts);
        }
        det.append(box);
    }
    // name toggle: fold the others, open THIS one (direct DOM, no flood)
    name.onclick = () => {
        if (det.hidden) {
            for (const el of $('pt-list').querySelectorAll('.pt-det'))
                el.hidden = true;
            det.hidden = false;
            PT_OPEN_DETAILS = p.id;
            det.scrollIntoView({ block: 'nearest' });
        } else {
            det.hidden = true;
            PT_OPEN_DETAILS = null;
        }
        ptPaintCarets();
    };
    entry.append(det);
    return entry;
}

/* ---- MANAGE dialog: per-surface version (latest/auto or pinned),       */
/* test, edit source, remove. Native selects; compact closed controls.     */
/* Escape rides the global handler (modal-escape pin: no listener here).   */
function ptManage(p) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = p.id;
    h.append(ptChip((p.state || '').replace(/_/g, ' ').toUpperCase(),
        PT_STATE_CLASS[p.state] || 'pt-st-dim', p.state_detail || ''));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.onclick = () => overlay.remove();
    h.append(close);
    box.append(h);


    // PAT-TABLE (user 2026-10-20): the dialog STAGES choices — pins write
    // nothing until SAVE; × / Esc / backdrop discard the draft. (AUTO
    // update left for its own table column.)
    const edits = {};        // target -> draft value ('' = latest)
    const acts = document.createElement('div');
    acts.className = 'pt-acts';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = ptMsg('uplift.patches.manage_save', 'Save');
    saveBtn.disabled = true;
    saveBtn.onclick = async () => {
        if (S.PT_BUSY) return;
        S.PT_BUSY = true; saveBtn.disabled = true;
        try {
            for (const [t2, val] of Object.entries(edits)) {
                await ptApi('pin', { id: p.id, target: t2,
                    version: val ? parseInt(val, 10) : null });
            }
            PG.toast(ptMsg('uplift.patches.saved',
                'Saved — lands on the next restart/build'), 4000);
            overlay.remove();
            await pollPatches();
            await ptRefreshCarrier();
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.pin_fail', 'Version pin failed')
                + ': ' + (e && e.message ? e.message : e), 5000);
            saveBtn.disabled = false;
        } finally { S.PT_BUSY = false; }
    };

    // per-surface version target: latest (auto) or pinned vN
    const SURFACES = [
        ['runtime', 'VANILLA',
         ptMsg('uplift.patches.surf_vanilla', 'VANILLA — the running server'),
         ptMsg('uplift.patches.surf_vanilla_hint',
             'pruned overlay; mounts at the next restart')],
        ['build', 'DEV',
         ptMsg('uplift.patches.surf_dev', 'DEV — the omlx-dev build'),
         ptMsg('uplift.patches.surf_dev_hint',
             'materialized on the uplift-dev branch at the next Build')],
    ];
    for (const [target, short, title, hint] of SURFACES) {
        const sec = document.createElement('div');
        sec.className = 'pt-mgr-surf';
        const lbl = document.createElement('div');
        lbl.className = 'pt-mgr-surf-head';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!(p.surfaces && p.surfaces[target]
            && p.surfaces[target].checked);
        check.disabled = true;   // the table columns are the checkbox home
        const t = document.createElement('span');
        t.textContent = title;
        t.title = hint;
        lbl.append(check, document.createTextNode(' '), t);
        sec.append(lbl);
        const row2 = document.createElement('label');
        row2.className = 'pt-field';
        const nm = document.createElement('span');
        nm.textContent = ptMsg('uplift.patches.manage_version', 'version');
        const sel = document.createElement('select');
        const optLat = document.createElement('option');
        optLat.value = '';
        optLat.textContent = ptMsg('uplift.patches.pin_latest',
            'latest (auto update)');
        sel.append(optLat);
        for (const v of (p.versions || []).slice().sort((a, b) => b.v - a.v)) {
            const o = document.createElement('option');
            o.value = String(v.v);
            o.textContent = 'v' + v.v + ' — '
                + String(v.fetched_at || '').slice(0, 10)
                + (v.v === p.applied_v ? ' ●' : v.v === p.dev_applied_v ? ' ▲' : '');
            sel.append(o);
        }
        const pin = p.pins ? p.pins[target] : null;
        const initial = pin ? String(pin) : '';
        sel.value = initial;
        const note = document.createElement('span');
        note.className = 'pt-detail';
        const paintNote = () => {
            const eff = sel.value ? parseInt(sel.value, 10)
                                  : (p.desired_version || 0);
            const dirty = sel.value !== initial;
            if (dirty) edits[target] = sel.value;
            else delete edits[target];
            row2.classList.toggle('pt-dirty', dirty);
            saveBtn.disabled = !Object.keys(edits).length || S.PT_BUSY;
            if (!check.checked) {
                note.textContent = ptMsg('uplift.patches.surf_off',
                    'not selected');
            } else if (target === 'runtime') {
                note.textContent = (p.applied_v === eff && p.enabled)
                    ? ptMsg('uplift.patches.surf_runtime_live',
                        'v{v} is in the running files').replace('{v}', eff)
                    : ptMsg('uplift.patches.surf_runtime_pending',
                        'v{v} lands at the next server restart')
                        .replace('{v}', eff);
            } else {
                note.textContent = (p.dev_applied_v === eff && p.enabled)
                    ? ptMsg('uplift.patches.surf_build_live',
                        'v{v} is on the branch').replace('{v}', eff)
                    : ptMsg('uplift.patches.surf_build_pending',
                        'v{v} lands at the next Build').replace('{v}', eff);
            }
            if (dirty) {
                note.append(document.createTextNode(' · '),
                    (() => { const d = document.createElement('b');
                        d.textContent = ptMsg('uplift.patches.unsaved',
                            'unsaved'); return d; })());
            }
        };
        paintNote();
        sel.onchange = paintNote;      // stage only — SAVE writes
        row2.append(nm, sel, note);
        sec.append(row2);
        box.append(sec);
    }

    // candidate waiting -> one honest Apply button (auto does it for you)
    if (p.state === 'update_available') {
        const c = document.createElement('div');
        c.className = 'pt-mgr-cand';
        const cs = document.createElement('span');
        cs.textContent = ptMsg('uplift.patches.cand_note',
            'v{v} fetched and validated from the source')
            .replace('{v}', p.latest_v);
        const ap = document.createElement('button');
        ap.type = 'button';
        ap.className = 'btn primary';
        ap.textContent = ptMsg('uplift.patches.apply_now',
            'Apply v{v} now').replace('{v}', p.latest_v);
        ap.onclick = async () => {
            overlay.remove();
            await ptAction('promote', { id: p.id },
                ptMsg('uplift.patches.promoted',
                    'Promoted — applies on next omlx restart'));
        };
        c.append(cs, ap);
        box.append(c);
    }

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn';
    testBtn.textContent = ptMsg('uplift.patches.test', 'Test dry-run');
    testBtn.onclick = async () => {
        if (S.PT_BUSY) return;
        S.PT_BUSY = true;
        testBtn.disabled = true;
        const old = testBtn.textContent;
        testBtn.textContent = ptMsg('uplift.patches.testing', 'Testing…');
        try {
            const sms = p.surfaces || {};
            const t = sms.runtime && sms.runtime.checked ? 'runtime' : 'build';
            const r = await ptApi('test', { id: p.id,
                v: (sms[t] && sms[t].version) || undefined });
            const bad = (r.files || []).filter(f => f.status === 'fail')
                .map(f => f.path + ': ' + (f.reason || 'fail'));
            PG.toast(bad.length
                ? ptMsg('uplift.patches.test_fail', 'Dry-run FAILED')
                    + ': ' + bad.join('; ')
                : ptMsg('uplift.patches.test_ok',
                    'Dry-run OK — patch applies cleanly now'),
                bad.length ? 7000 : 4000);
            await pollPatches();
        } catch (e) { PG.toast(String(e), 5000); }
        finally { testBtn.textContent = old; testBtn.disabled = false; S.PT_BUSY = false; }
    };
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn';
    editBtn.textContent = ptMsg('uplift.patches.edit', 'Edit source');
    editBtn.onclick = () => {
        overlay.remove();
        ptEditSource(p);
    };
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn danger';
    rmBtn.textContent = ptMsg('uplift.patches.remove', 'Remove');
    rmBtn.onclick = async () => {
        if (p.curated && !p.curated_adopted) {
            // catalog patch: removing it restores vanilla bytes AND drops
            // it from the local store. The graceful path is adoption —
            // keep the patch, cut the catalog tie (user decision 2026-09-27)
            const adopt = confirm(ptMsg('uplift.patches.remove_curated_choice',
                'This patch comes from the curated catalog. OK = adopt the '
                + 'patch as local: it stays installed and becomes yours, '
                + 'the catalog never touches it again. Cancel = remove it '
                + 'completely (applied files are restored to vanilla bytes).'));
            if (adopt) {
                await ptApi('curated/adopt', { id: p.id }).then(async () => {
                    PG.toast(ptMsg('uplift.patches.adopted',
                        'Patch adopted as local'), 4000);
                    await pollPatches();
                }).catch(e => PG.toast(String(e), 5000));
                overlay.remove();
                return;
            }
        }
        if (!confirm(ptMsg('uplift.patches.remove_confirm',
            'Remove this patch? Applied files are restored to vanilla bytes now.'))) return;
        await ptAction('remove', { id: p.id },
            ptMsg('uplift.patches.removed', 'Patch removed'));
        overlay.remove();
    };
    acts.append(saveBtn, testBtn, editBtn, rmBtn);
    box.append(acts);
    overlay.append(box);
    // backdrop click closes (same contract as every other dialog here)
    overlay.addEventListener('click', ev => {
        if (ev.target === overlay) overlay.remove();
    });
    document.body.append(overlay);
}

/* ---- edit source: a dialog over the SAME add endpoint — prefill the
   current source, Fetch & store gates it and records a candidate.
   (The old flow silently prefilled the far add form below the table;
   the user read it as 'nothing happened' — 2026-10-20.)             */
function ptEditSource(p) {
    const s0 = p.source || {};
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';        // same chrome as the MANAGE dialog
    const h = document.createElement('h3');
    h.textContent = ptMsg('uplift.patches.edit', 'Edit source')
        + ' — ' + p.id;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.onclick = () => overlay.remove();
    h.append(close);
    box.append(h);
    const hint = document.createElement('div');
    hint.className = 'pt-detail';
    hint.textContent = ptMsg('uplift.patches.edit_hint',
        'fetches this source and validates it against the running files — '
        + 'a new candidate version is stored; nothing changes on disk '
        + 'until you apply it');
    box.append(hint);

    const row1 = document.createElement('div');
    row1.className = 'pt-field';
    const kindLbl = document.createElement('span');
    kindLbl.textContent = ptMsg('uplift.patches.lbl_source', 'source');
    const kind = document.createElement('select');
    for (const [val, key, fb] of [['github_pr', 'src_pr', 'GitHub PR'],
                                  ['url', 'src_url', 'URL'],
                                  ['upload', 'src_upload', 'Upload']]) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = ptMsg('uplift.patches.' + key, fb);
        kind.append(o);
    }
    kind.value = s0.kind || 'github_pr';
    const repo = document.createElement('input');
    repo.type = 'text'; repo.size = 18;
    repo.placeholder = ptMsg('uplift.patches.ph_repo', 'owner/repo');
    repo.value = s0.repo || '';
    const pr = document.createElement('input');
    pr.type = 'text'; pr.size = 7;
    pr.placeholder = ptMsg('uplift.patches.ph_pr', '1234');
    pr.value = s0.pr ? String(s0.pr) : '';
    const url = document.createElement('input');
    url.type = 'text';
    url.placeholder = 'https://…/patch.diff';
    url.value = s0.url || '';
    url.className = 'grow';
    const diffTa = document.createElement('textarea');
    diffTa.rows = 6;
    diffTa.placeholder = ptMsg('uplift.patches.source_upload',
        'paste the .diff text');
    diffTa.className = 'pt-edit-diff grow';
    row1.append(kindLbl, kind, repo, pr, url);
    box.append(row1, diffTa);
    const sync = () => {
        repo.hidden = kind.value !== 'github_pr';
        pr.hidden = kind.value !== 'github_pr';
        url.hidden = kind.value !== 'url';
        diffTa.hidden = kind.value !== 'upload';
    };
    kind.onchange = sync;
    sync();

    const acts = document.createElement('div');
    acts.className = 'pt-acts';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn primary';
    go.textContent = ptMsg('uplift.patches.edit_fetch', 'Fetch & store');
    go.onclick = async () => {
        if (S.PT_BUSY) return;
        const body = { id: p.id, kind: kind.value,
                       reversal: !!p.reversal, insecure_tls: !!s0.insecure_tls };
        if (kind.value === 'github_pr') {
            body.repo = repo.value.trim();
            body.pr = parseInt(pr.value, 10) || null;
            if (!body.repo || !body.pr) return;
        } else if (kind.value === 'url') {
            body.url = url.value.trim();
            if (!body.url) return;
        } else {
            body.data = diffTa.value;
            if (!body.data.trim()) return;
        }
        S.PT_BUSY = true; go.disabled = true;
        try {
            const r = await ptApi('add', body);
            overlay.remove();
            PG.toast(ptMsg('uplift.patches.edit_stored',
                'v{v} fetched and validated — open MANAGE to apply it')
                .replace('{v}', r.v || ''), 6000);
            await pollPatches();
            await ptRefreshCarrier();
        } catch (e) {
            PG.toast(String(e && e.message ? e.message : e), 7000);
        } finally {
            S.PT_BUSY = false; go.disabled = false;
        }
    };
    acts.append(go);
    box.append(acts);
    overlay.append(box);
    overlay.addEventListener('click', ev => {
        if (ev.target === overlay) overlay.remove();
    });
    document.body.append(overlay);
}

/* ---- add flow: kind-aware inputs -> preview (per-file gate table) -> enable */

function ptReadSource() {
    const kind = $('pt-src-kind').value;
    const insecure_tls = $('pt-insecure-tls').checked;
    if (kind === 'github_pr') {
        return { kind, repo: $('pt-src-repo').value.trim(),
                 pr: parseInt($('pt-src-pr').value, 10) || null, insecure_tls };
    }
    if (kind === 'url') return { kind, url: $('pt-src-url').value.trim(), insecure_tls };
    return { kind: 'upload' };   // data filled from file input below
}

function ptSyncKindUI() {
    const kind = $('pt-src-kind').value;
    $('pt-src-repo').hidden = kind !== 'github_pr';
    $('pt-src-pr').hidden = kind !== 'github_pr';
    $('pt-src-url').hidden = kind !== 'url';
    $('pt-src-file').hidden = kind !== 'upload';
}

async function ptPreview() {
    const id = $('pt-new-id').value.trim();
    if (!id) {
        PG.toast(ptMsg('uplift.patches.need_name', 'Give the patch a name first'), 4000);
        return;
    }
    const src = ptReadSource();
    const scope = $('pt-new-scope') ? $('pt-new-scope').value : '';
    const wasStored = (S.PT_DATA && S.PT_DATA.patches || [])
        .some(x => x.id === id);
    const body = { id, reversal: $('pt-reversal').checked, ...src };
    if (scope) body.scope = scope;
    if (src.kind === 'upload') {
        const f = $('pt-src-file').files[0];
        if (!f) { PG.toast(ptMsg('uplift.patches.need_file', 'Pick a .diff file'), 4000); return; }
        body.data = await f.text();
    }
    const box = $('pt-preview');
    const adv = $('pt-advisories');
    try {
        const r = await ptApi('add', body);
        if (r.ok && !wasStored) {
            // DEV-6: a NEW stored patch must appear immediately — same page
            // state a refresh would produce (checkboxes/dialog usable)
            await pollPatches();
            await ptRefreshCarrier();
        }
        adv.hidden = !(r.advisories && r.advisories.length);
        adv.innerHTML = '';   // clear-only — safe
        for (const a of (r.advisories || [])) {
            const w = document.createElement('div');
            w.textContent = '⚠ ' + a;
            adv.append(w);
        }
        box.hidden = false;
        box.innerHTML = '';   // clear-only — safe; content goes DOM-builders
        // PAT-TABLE: the row renders safeguards for a NEW stored/adopted
        // patch (pollPatches above redraws it). The old flow rendered the
        // stored verdict here TOO — the double flood. Keep the box lines
        // for every verdict with no fresh row behind it: a REJECTED add
        // (no row at all), 'obsolete-held' (ok=true, nothing stored) and
        // an UPDATE re-add of an existing patch (pollPatches is skipped
        // there, so the row still shows the OLD version's flags).
        const rowShowsIt = r.ok && !r.obsolete && !wasStored;
        if (!rowShowsIt && r.safeguards && (r.safeguards.problems || []).length) {
            const sgt = document.createElement('div');
            sgt.className = 'pt-sg-title';
            sgt.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(sgt);
            let hint = '';
            for (const grp of (r.safeguards.problems || [])) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + ptGroupLine(grp);
                box.append(w);
                if (grp.hint) hint = grp.hint;   // row absent -> hint lives here
            }
            if (hint) {
                const rr = document.createElement('div');
                rr.className = 'pt-sg-rebuild';
                const lbl = document.createElement('span');
                lbl.textContent = ptMsg('uplift.patches.safeguard_rebuild',
                    'Native kernel rebuild (required for real effect):');
                const cmd = document.createElement('code');
                cmd.textContent = hint;
                cmd.title = 'click to copy';
                cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); };
                rr.append(lbl, document.createTextNode(' '), cmd);
                box.append(rr);
            }
        }
        if (!rowShowsIt && r.note) {
            const w = document.createElement('div');
            w.className = 'pt-advisories';
            w.textContent = '⚠ ' + ptMsg('uplift.patches.safeguard_note',
                'Root autodetected: {n}').replace('{n}', r.note);
            box.append(w);
        }
        const tbl = document.createElement('div');
        tbl.className = 'pt-gate';
        const head = document.createElement('div');
        head.className = 'pt-gate-row pt-gate-head';
        const ht = document.createElement('span');
        // r.ok is the verdict — never claim "gate passed" for a rejected
        // patch (a GNU `diff -ruN` upload once showed green on a parse fail)
        const rev = body.reversal;
        ht.textContent = !r.ok
            ? ptMsg('uplift.patches.preview_fail', 'REJECTED — gate failed')
            : r.adopted
            ? (rev
                ? ptMsg('uplift.patches.reversal_adopted',
                    'ALREADY REVERTED — stored as APPLIED reversal; disable restores the merged bytes')
                : ptMsg('uplift.patches.adopted',
                    'ALREADY APPLIED — stored as APPLIED, will re-apply after an omlx update'))
            : r.obsolete
            ? (rev
                ? ptMsg('uplift.patches.reversal_nothing',
                    'NOTHING TO UNDO — the merged change is not in the live tree')
                : ptMsg('uplift.patches.obsolete', 'ALREADY PRESENT upstream — patch looks obsolete'))
            : (r.unchanged
                ? ptMsg('uplift.patches.unchanged', 'stored version already matches the source')
                : (rev
                    ? ptMsg('uplift.patches.preview_ok_rev',
                        'VALIDATED REVERSAL — the merged change reverts cleanly')
                    : ptMsg('uplift.patches.preview_ok', 'VALIDATED — gate passed')));
        ht.className = (!r.ok || (r.obsolete && !r.adopted) || r.unchanged)
            ? 'pt-fail' : 'pt-ok';
        head.append(ht);
        tbl.append(head);
        if (!r.ok && r.reason) {
            const why = document.createElement('div');
            why.className = 'pt-gate-row';
            const w = document.createElement('span');
            w.className = 'pt-detail';
            w.textContent = r.reason;
            why.append(w);
            tbl.append(why);
        }
        for (const f of (r.files || [])) {
            const row = document.createElement('div');
            row.className = 'pt-gate-row';
            const st = document.createElement('span');
            st.className = 'pt-chip ' + (f.status === 'ok' ? 'pt-st-applied'
                : f.status === 'already' ? 'pt-st-update'
                : f.status === 'skipped' ? 'pt-st-applied pt-st-dim' : 'pt-st-warn');
            st.textContent = f.status.toUpperCase();
            const pth = document.createElement('span');
            pth.textContent = f.path;
            row.append(st, pth);
            if (f.reason) {
                const why = document.createElement('span');
                why.className = 'pt-detail';
                why.textContent = f.reason;
                row.append(why);
            }
            tbl.append(row);
        }
        box.append(tbl);
        if (r.ok && !r.unchanged && !r.adopted) {
            const act = document.createElement('div');
            act.className = 'pt-acts pt-sg-acts';   // flex gap — two adjacent
            const held = r.requires_approval || [];  // filled .btn.primary
            const en = document.createElement('button');
            en.type = 'button';
            en.className = 'btn primary';
            // wasStored = an update of an existing row: the act is
            // 'apply this version' (promote), not 'enable' (already is)
            en.textContent = held.length
                ? ptMsg('uplift.patches.approve_once', 'Apply once anyway')
                : (wasStored
                    ? ptMsg('uplift.patches.apply_now', 'Apply v{v} now')
                          .replace('{v}', r.v)
                    : ptMsg('uplift.patches.enable_now', 'Enable patch'));
            en.onclick = async () => {
                if (wasStored && !held.length) {
                    await ptAction('promote', { id },
                        ptMsg('uplift.patches.promoted',
                            'Promoted — applies on next omlx restart'));
                } else {
                    await ptEnableWithApproval({ id }, held.length ? 'once' : null);
                }
                box.hidden = true;
                $('pt-new-id').value = '';
            };
            act.append(en);
            if (held.length) {
                const al = document.createElement('button');
                al.type = 'button';
                al.className = 'btn primary';
                al.textContent = ptMsg('uplift.patches.approve_always',
                    'Always allow ({codes})').replace('{codes}', held.join(', '));
                al.onclick = async () => {
                    await ptEnableWithApproval({ id }, 'always');
                    box.hidden = true;
                    $('pt-new-id').value = '';
                };
                act.append(al);
            }
            box.append(act);
        }
    } catch (e) {
        adv.hidden = false;
        adv.innerHTML = '';   // clear-only — safe
        const w = document.createElement('div');
        w.textContent = '✕ ' + (e && e.message ? e.message : e);
        adv.append(w);
        box.hidden = true;
    }
}


let PT_CHECK_TIMER = null;

function ptScheduleAutoCheck() {
    // hourly drift check while the page is open AND the user opted in (PAT-2
    // config flag drives the same endpoint the collector would use)
    clearInterval(PT_CHECK_TIMER);
    PT_CHECK_TIMER = setInterval(() => {
        if (!document.hidden && PG.currentTab() === 'settings' && PG.currentSub('settings') === 'patches'
                && S.PT_DATA && S.PT_DATA.config && S.PT_DATA.config.auto_update_check) {
            ptCheckNow(true);
        }
    }, 3600e3);
}

async function ptCheckNow(quiet) {
    const b = $('pt-check-btn');
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    const old = b.textContent;
    b.textContent = ptMsg('uplift.patches.checking', 'Checking…');
    b.disabled = true;
    try {
        const r = await ptApi('check', {});
        const reports = r.reports || {};
        const notes = Object.entries(reports).map(([id, rep]) => {
            if (rep.check === 'update_available')
                return id + ': ' + (rep.promoted
                    ? ptMsg('uplift.patches.auto_applied',
                        'auto-applied v{v} — takes effect at the next restart/build')
                          .replace('{v}', rep.v)
                    : ptMsg('uplift.patches.update_avail_toast',
                        'update available (v{v})').replace('{v}', rep.v));
            if (rep.check === 'obsolete') return id + ': ' + ptMsg('uplift.patches.obsolete', 'obsolete');
            if (rep.check === 'error') return id + ': ' + ptMsg('uplift.patches.check_error', 'check failed') + ' — ' + rep.reason;
            return null;
        }).filter(Boolean);
        if (!quiet || notes.length)
            PG.toast(notes.length ? notes.join(' · ')
                : ptMsg('uplift.patches.all_current', 'All patch sources current'), 6000);
        await pollPatches();
        await ptRefreshCarrier();   // a promoted/obsolete verdict can
    } catch (e) {                  // empty or grow the build set right now
        PG.toast(ptMsg('uplift.patches.check_fail', 'Check failed') + ': ' + e, 5000);
    } finally {
        b.textContent = old;
        b.disabled = false;
        S.PT_BUSY = false;
    }
}

function renderDriftBanner(rep) {
    // KEGID-3: red banner on unexpected tree drift. Static element —
    // survives renderPatches() rebuilds; textContent only, no markup.
    const el = $('pt-drift');
    if (!el) return;
    const bad = rep && rep.ok === false && !rep.skipped_reason;
    el.hidden = !bad;
    if (!bad) return;
    const n = (rep.unexpected || []).length;
    const first = (rep.unexpected || []).slice(0, 3)
        .map(e => e.path).join(', ');
    const more = n > 3 ? ' …' : '';
    el.textContent = ptMsg('uplift.patches.drift_banner',
        'TREE DRIFT — {n} installed oMLX files no longer match the wheel'
        + ' they were built from ({files}). Model loads may fail.'
        + ' Repair: brew reinstall omlx — uplift never rewrites the tree.')
        .replace('{n}', n).replace('{files}', first + more);
    el.title = (rep.unexpected || []).map(e => e.kind + ' ' + e.path).join('\n');
}

async function pollDoctor() {
    // Fire-and-forget: the chip is advisory; a failure must never break
    // or blank the patches page (0.2 s census runs server-side off-loop).
    // A failed probe HIDES the banner: without a verdict there is no
    // honest alarm to show (next patch action re-probes).
    try {
        S.PT_DOCTOR = await PG.fetchJson(`${API}/uplift/api/doctor`);
        renderDriftBanner(S.PT_DOCTOR);
    } catch (e) { S.PT_DOCTOR = null; renderDriftBanner(null); }
}

/* HEADER HELP "?" (user 2026-10-27, third round): the marks on OMLX-DEV
   BUILD / RUNTIME PATCH were dotted sups with a native title — nothing
   happened on click and the hover tooltip was easy to miss entirely. They
   are real buttons now. The bubble itself lives in domkit (UpliftDom
   .helpPop — hover opens, click pins, Escape or a click anywhere else
   closes): this file builds .modal-overlay dialogs, and the modal-escape
   gate forbids it from owning keydown listeners, so a tooltip factory has
   to sit in the shared layer. All the wiring here adds is the anchor, the
   catalog text (data-help-key, English literal in data-en-help as the
   fallback — no title attribute remains, so the pop never doubles into a
   native tooltip) and the per-button aria-label. */
function wirePtHeadHelp() {
    if (!document.querySelectorAll) return;
    const HP = D.helpPop;
    if (!HP) return;                              // sandboxed render paths
    document.querySelectorAll('.pt-head-help').forEach(btn => {
        if (btn.__ptHelp) return;                 // initPatchesPage re-runs
        btn.__ptHelp = true;
        const opts = pin => ({ cellSel: '.pt-c-dev, .pt-c-vanilla',
            popClass: 'pt-help-pop', pin,
            text: ptMsg(btn.dataset.helpKey, btn.dataset.enHelp || '') });
        btn.setAttribute('aria-label', opts(false).text);
        btn.addEventListener('mouseenter', () => HP.open(btn, opts(false)));
        btn.addEventListener('mouseleave', () => HP.hoverOut(btn));
        btn.addEventListener('click', ev => {
            ev.stopPropagation();                 // the opening click must
                                                  // not reach doc listeners
            if (HP.isPinned(btn)) { HP.close(); return; }   // click again out
            HP.open(btn, opts(true));
        });
    });
}

function initPatchesPage() {
    ptSyncKindUI();
    wirePtHeadHelp();
    pollDoctor();
    $('pt-src-kind').onchange = ptSyncKindUI;
    $('pt-preview-btn').onclick = ptPreview;
    $('pt-check-btn').onclick = () => { ptCheckNow(false); ptAutoSyncCurated(true); };
    // "(all)" under the AUTO-UPDATE header (user 2026-10-27, second round):
    // one click drives every patch's per-row AUTO flag to the opposite of
    // "all on". Posts per patch (no bulk endpoint) and reports honestly:
    // all done = one short toast; a failure names the ids, never a blanket
    // success over a partial write.
    $('pt-auto-all').onclick = async () => {
        if (S.PT_BUSY || !S.PT_DATA) return;
        const list = S.PT_DATA.patches || [];
        if (!list.length) return;
        const target = !list.every(p => p.auto_update);
        S.PT_BUSY = true;
        const b = $('pt-auto-all');
        b.disabled = true;
        let done = 0;
        const failed = [];
        try {
            for (const p of list) {
                if (!!p.auto_update === target) { done++; continue; }
                try { await ptApi('auto', { id: p.id, enabled: target }); done++; }
                catch (e) { failed.push(p.id); }
            }
        } finally { S.PT_BUSY = false; b.disabled = false; }
        const word = target
            ? ptMsg('uplift.patches.auto_all_on', 'Auto-update ON')
            : ptMsg('uplift.patches.auto_all_off', 'Auto-update OFF');
        if (failed.length) {
            PG.toast(word + ' ' + done + '/' + list.length + ' — '
                + ptMsg('uplift.patches.auto_all_failed', 'failed')
                + ': ' + failed.join(', '), 6000);
        } else {
            PG.toast(word + ' — ' + ptMsg('uplift.patches.auto_all_all',
                'every patch'), 4000);
        }
        await pollPatches();
    };
    $('pt-diff-close').onclick = () => { $('pt-diff').hidden = true; };
    // FE-5: dev-panel button wiring lives with the panel (uplift_devpanel.js)
    if (window.Uplift.devpanel) window.Uplift.devpanel.initDevPanel();
    ptScheduleAutoCheck();
}


window.Uplift = window.Uplift || {};
window.Uplift.patches = {
    pollPatches, initPatchesPage, patchRow,
    // PATCH-ZONES: kept as an alias so an older devpanel bundle calling
    // refill() keeps working (it redraws from cached data, never fetches).
    refill() { if (S.PT_DATA) renderPatches(); },
    // FE-5: pollDev moved to uplift_devpanel.js; keep the old accessor alive
    // for uplift.js's tab dispatcher (lazy, order-free).
    get pollDev() { return window.Uplift.devpanel && window.Uplift.devpanel.pollDev; },
};
})();
