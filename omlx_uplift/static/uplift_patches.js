/* ============================================================================
   PAT-4: PATCHES — declarative patch carrier UI (settings/patches).
   PH2-1 stage 8: extracted from uplift.js. Every button hits a PAT-2
   endpoint; nothing here writes the keg directly — enable/disable/promote/
   rollback/reconcile land at the NEXT omlx restart (the .pth engine, PAT-3).
   State chips reuse the cockpit-lamp vocabulary; the WARNING banner lights
   for needs_review/failed like an instrument flag. PT_DATA/PT_BUSY live in
   window.Uplift.state (declared before boot can reach pollPatches via
   applyTab — PAT-4 TDZ property preserved by load order). Plain script;
   loads AFTER uplift_state.js + domkit.js, BEFORE uplift.js; FE-1 takes
   toast/fetchJson from window.UpliftDom, currentTab/currentSub late-bind
   via window.Uplift._patchesGlue (live hash readers).
   Exports window.Uplift.patches {pollPatches, initPatchesPage}.
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
};
/* ============================================================================
   PAT-4: PATCHES — declarative patch carrier UI (settings/patches).
   Every button hits a PAT-2 endpoint; nothing here writes the keg directly —
   enable/disable/promote/rollback/reconcile land at the NEXT omlx restart
   (the .pth engine, PAT-3). State chips reuse the cockpit-lamp vocabulary;
   the WARNING banner lights for needs_review/failed like an instrument flag.
   ========================================================================== */

function ptMsg(key, fb) { return C.tf(key, fb); }

async function pollPatches() {
    try {
        S.PT_DATA = await PG.fetchJson(`${API}/uplift/api/patches`);
        renderPatches();
    } catch (e) {
        const list = $('pt-list');
        if (list) list.innerHTML = '';   // plain clear, no markup — safe
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
   as an ordinary patch card in its scope zone, BUNDLED chip included.
   There is no "install" step to press; the sync runs once per page load
   and again when the user presses Check for updates. A dead network or a
   catalog hiccup is silent: the store we already have is authoritative
   for rendering. */
let PT_CURATED_SYNCED = false;
let PT_CURATED_BUSY = false;

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
        if (changed) await pollPatches();   // bring the new cards in
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

async function ptAction(path, body, okMsg) {
    if (S.PT_BUSY) return;
    S.PT_BUSY = true;
    try {
        const r = await ptApi(path, body);
        if (okMsg) PG.toast(okMsg, 4000);
        if (r && r.reason) PG.toast(r.reason, 5000);
        await pollPatches();
    } catch (e) {
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
            : ptMsg('uplift.patches.enabled_toast',
                    'Enabled — applies on next omlx restart'), 4000);
        await pollPatches();
    } catch (e) {
        PG.toast(ptMsg('uplift.patches.approve_fail', 'Approval failed') +
              ': ' + (e && e.message ? e.message : e), 6000);
    } finally {
        S.PT_BUSY = false;
    }
}

// One display line per safeguard GROUP (mirrors the backend grouping):
// one line per code with its path list, then the advisory lines. One
// line per problem used to mean eight copies of the same 500-char
// rebuild hint.
// (paths stored in the manifest are the REWRITTEN ones — say so, or the
// diff view looks like it disagrees with the source URL).
function ptSafeguardLines(p) {
    const out = [];
    const ver = (p.versions || []).find(v => v.v === (p.desired_version ||
        Math.max(...(p.versions || []).map(x => x.v)))) || {};
    const sg = ver.safeguards || {};
    for (const grp of (sg.problems || [])) {
        out.push({ text: ptGroupLine(grp), code: grp.code });
    }
    for (const grp of (sg.advisories || [])) {
        out.push({ text: ptGroupLine(grp), code: grp.code, advisory: true });
    }
    if (ver.root_note) out.push({ text: ptMsg('uplift.patches.safeguard_note',
        'Root autodetected: {n}').replace('{n}', ver.root_note), code: null });
    return out;
}

// 'path — msg' for one path, '<n> files (a, b, …) — msg' for a group
function ptGroupLine(grp) {
    const paths = grp.paths || (grp.path ? [grp.path] : []);
    if (paths.length === 1) return paths[0] + ' — ' + (grp.message || '');
    if (!paths.length) return grp.message || '';
    const shown = paths.slice(0, 6).join(', ');
    const more = paths.length > 6 ? ', … (+' + (paths.length - 6) + ')' : '';
    return paths.length + ' (' + shown + more + ') — ' + (grp.message || '');
}

function ptChip(text, cls, title) {
    const s = document.createElement('span');
    s.className = 'pt-chip ' + (cls || '');
    s.textContent = text;
    if (title) s.title = title;
    return s;
}

function renderPatches() {
    const d = S.PT_DATA;
    if (!d) return;
    const list = $('pt-list');
    list.innerHTML = '';

    // WARNING banner: any needs_review/failed patch (PAT-0 badge rule)
    const warn = $('pt-warn');
    warn.hidden = !d.warning;
    if (d.warning) {
        warn.textContent = ptMsg('uplift.patches.warn_banner',
            'WARNING — one or more patches need review after a vanilla update or failed to apply. oMLX runs without them until resolved.');
    }
    const ks = $('pt-killswitch');
    ks.hidden = !d.kill_switch_active;
    if (d.kill_switch_active) {
        ks.textContent = ptMsg('uplift.patches.killswitch_on',
            'Patch engine disabled (kill switch) — booting pristine vanilla, manifest untouched.');
    }

    // plain status line: patches loaded vs active (enabled). Patches can
    // touch any part of the package, not just /admin/ — no claims about
    // which files diverge from vanilla.
    $('pt-sub').textContent = ptMsg('uplift.patches.counts',
        '{loaded} loaded · {active} active')
        .replace('{loaded}', d.patches.filter(p => p.scope !== 'dev').length)
        .replace('{active}', d.patches.filter(p => p.enabled && p.scope !== 'dev').length);

    const auto = $('pt-auto-check');
    auto.checked = !!(d.config && d.config.auto_update_check);
    auto.onchange = async () => {
        try {
            await ptApi('config', { auto_update_check: auto.checked });
            await pollPatches();
        } catch (e) { PG.toast(String(e), 4000); }
    };

    // DEV-6: omlx section shows keg-targeted scopes (omlx+both); dev+both
    // live in the omlx-dev section below (same cards, /patches/* API)
    const runtimeOnly = d.patches.filter(p => p.scope !== 'dev');
    if (!runtimeOnly.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = ptMsg('uplift.patches.none',
            'No runtime patches yet. Add a GitHub PR, URL, or upload a .diff below.');
        list.append(empty);
    }
    for (const p of runtimeOnly) list.append(patchCard(p, d));
    // FE-5 seam: dev panel lives in uplift_devpanel.js; lazy lookup so this
    // file works with the panel absent (graceful) and load order is free.
    const DP = window.Uplift.devpanel;
    if (DP) DP.renderDev();
}

function patchCard(p, view) {
    const card = document.createElement('div');
    card.className = 'pt-card' + (p.state === 'needs_review' || p.state === 'failed'
        ? ' pt-card-warn' : '');

    const head = document.createElement('div');
    head.className = 'pt-card-head';
    const title = document.createElement('span');
    title.className = 'pt-id';
    title.textContent = p.id;
    head.append(title);
    const cls = PT_STATE_CLASS[p.state] || 'pt-st-dim';
    head.append(ptChip((p.state || '').toUpperCase(), cls, p.state_detail || ''));
    if (p.curated && !p.curated_adopted) {
        head.append(ptChip(ptMsg('uplift.patches.bundled_chip', 'BUNDLED'),
            'pt-st-bundled',
            ptMsg('uplift.patches.bundled_hint',
                  'part of the curated catalog — kept current by curated sync')));
    }
    if (p.reversal) {
        head.append(ptChip(ptMsg('uplift.patches.reversal_chip', 'REVERSAL'),
            'pt-st-reversal',
            ptMsg('uplift.patches.reversal_hint',
                  'reverts an already merged change — applied in the un-apply direction')));
    }
    if (p.source && p.source.insecure_tls) {   // UX-1 (SWEEP183 K): sticky
        head.append(ptChip(ptMsg('uplift.patches.insecure_chip', 'INSECURE'),
            'pt-st-insecure',
            ptMsg('uplift.patches.insecure_hint',
                  'TLS verification is disabled when fetching this patch — ' +
                  'set at add time, it also applies to every later re-check')));
    }
    const heldCodes = p.requires_approval || [];
    if (heldCodes.length) {
        head.append(ptChip(ptMsg('uplift.patches.safeguard_hold', 'AUTO-APPLY HELD'),
            'pt-st-warn', p.state_detail || ''));
    }
    if (p.keg_changed && p.enabled)
        head.append(ptChip(ptMsg('uplift.patches.keg_changed', 'KEG CHANGED'), 'pt-st-warn',
            ptMsg('uplift.patches.keg_changed_hint',
                  'vanilla omlx was upgraded — the patch re-validates on next start')));
    if (p.state_detail) {
        const det = document.createElement('span');
        det.className = 'pt-detail';
        det.textContent = p.state_detail;
        head.append(det);
    }
    card.append(head);

    // source line + advisory warnings (plaintext/credentials policy)
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
    card.append(src);
    // curated patches carry the manifest summary (why they exist)
    if (p.description) {
        const det = document.createElement('div');
        det.className = 'pt-detail';
        det.textContent = p.description;
        card.append(det);
    }
    for (const adv of (p.advisories || [])) {
        const w = document.createElement('div');
        w.className = 'pt-advisories';
        w.textContent = '⚠ ' + adv;
        card.append(w);
    }

    // versions row: v<n> chips, applied one marked
    const vers = document.createElement('div');
    vers.className = 'pt-vers';
    for (const v of (p.versions || []).slice().sort((a, b) => a.v - b.v)) {
        const isApplied = p.applied_v === v.v;
        const isDesired = p.desired_version === v.v;
        const isCandidate = !isDesired && v.v === Math.max(...(p.versions || []).map(x => x.v));
        const chip = ptChip('v' + v.v + (isApplied ? ' ●' : isDesired ? ' ◐' : ''),
            isApplied ? 'pt-st-applied' : (isCandidate && p.state === 'update_available') ? 'pt-st-update' : 'pt-st-dim',
            (v.fetched_at || '') + (v.source_head_sha ? ' · ' + v.source_head_sha.slice(0, 12) : ''));
        chip.style.cursor = 'pointer';
        chip.title = ptMsg('uplift.patches.show_diff', 'show stored diff') + ' — ' + chip.title;
        chip.onclick = () => ptShowDiff(p.id, v.v);
        vers.append(chip);
    }
    card.append(vers);

    // safeguards: grouped problem lines, advisory lines, autodetected
    // root, rebuild command, per-code approvals (the note names the
    // EXCEPTIONS, not a blanket off)
    const sgLines = ptSafeguardLines(p);
    const approved = p.safeguard_always || [];
    if (sgLines.length || approved.length) {
        const box = document.createElement('div');
        box.className = 'pt-safeguards';
        if (sgLines.length) {
            const t = document.createElement('div');
            t.className = 'pt-sg-title';
            t.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(t);
            for (const l of sgLines) {
                const row = document.createElement('div');
                row.className = 'pt-advisories';
                row.textContent = '⚠ ' + l.text;
                box.append(row);
            }
        }
        if (p.kernel_rebuild_hint) {
            const row = document.createElement('div');
            row.className = 'pt-sg-rebuild';
            const lbl = document.createElement('span');
            lbl.textContent = ptMsg('uplift.patches.safeguard_rebuild',
                'Native kernel rebuild (required for real effect):');
            const cmd = document.createElement('code');
            cmd.textContent = p.kernel_rebuild_hint;
            cmd.title = 'click to copy';
            cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); };
            row.append(lbl, document.createTextNode(' '), cmd);
            box.append(row);
        }
        if (approved.length) {
            const a = document.createElement('div');
            a.className = 'pt-detail';
            a.textContent = '✓ ' + ptMsg('uplift.patches.approved_codes',
                'approved: {codes}').replace('{codes}', approved.join(', '));
            box.append(a);
        }
        card.append(box);
    }

    // action row: buttons wired to PAT-2 endpoints
    const acts = document.createElement('div');
    acts.className = 'pt-acts';
    const btn = (label, cls, fn, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (cls ? ' ' + cls : '');
        b.textContent = label;
        if (title) b.title = title;
        b.onclick = fn;
        acts.append(b);
        return b;
    };
    if (!p.enabled) {
        if (heldCodes.length) {
            btn(ptMsg('uplift.patches.approve_once', 'Apply once anyway'), 'primary',
                () => ptEnableWithApproval(p, 'once'),
                ptMsg('uplift.patches.approve_once_title',
                      'Approve the flagged safeguards for this version only'));
            btn(ptMsg('uplift.patches.approve_always', 'Always allow ({codes})')
                    .replace('{codes}', heldCodes.join(', ')), 'primary',
                () => ptEnableWithApproval(p, 'always'),
                ptMsg('uplift.patches.approve_always_title',
                      'Remember these safeguard codes for future versions of this patch'));
        } else {
            btn(ptMsg('uplift.patches.enable', 'Enable'), 'primary',
                () => ptEnableWithApproval(p, null),
                ptMsg('uplift.patches.enabled_toast',
                      'Enabled — applies on next omlx restart'));
        }
    } else {
        btn(ptMsg('uplift.patches.disable', 'Disable'), '',
            () => ptAction('disable', { id: p.id },
                ptMsg('uplift.patches.disabled_toast', 'Disabled — files restored on next omlx restart')));
    }
    if (p.state === 'update_available') {
        const doPromote = (approve) => ptAction('promote',
            approve ? { id: p.id, approve } : { id: p.id },
            ptMsg('uplift.patches.promoted', 'Promoted — applies on next omlx restart'));
        if (heldCodes.length) {
            btn(ptMsg('uplift.patches.approve_once', 'Apply once anyway'), 'primary',
                () => doPromote('once'),
                ptMsg('uplift.patches.approve_once_title',
                      'Approve the flagged safeguards for this version only'));
            btn(ptMsg('uplift.patches.approve_always', 'Always allow ({codes})')
                    .replace('{codes}', heldCodes.join(', ')), 'primary',
                () => doPromote('always'),
                ptMsg('uplift.patches.approve_always_title',
                      'Remember these safeguard codes for future versions of this patch'));
        } else {
            btn(ptMsg('uplift.patches.promote', 'Promote update'), 'primary',
                () => doPromote(null));
        }
    }
    const vs = (p.versions || []).map(v => v.v).sort((a, b) => a - b);
    if (p.desired_version && vs.length > 1 && p.state !== 'disabled') {
        btn(ptMsg('uplift.patches.rollback', 'Rollback'), '',
            () => ptAction('rollback', { id: p.id },
                ptMsg('uplift.patches.rolledback', 'Rollback queued for next omlx restart')));
    }
    btn(ptMsg('uplift.patches.test', 'Test dry-run'), '', async () => {
        if (S.PT_BUSY) return;
        S.PT_BUSY = true;
        try {
            const r = await ptApi('test', { id: p.id });
            const bad = (r.files || []).filter(f => f.status === 'fail')
                .map(f => f.path + ': ' + (f.reason || 'fail'));
            PG.toast(bad.length
                ? ptMsg('uplift.patches.test_fail', 'Dry-run FAILED') + ': ' + bad.join('; ')
                : ptMsg('uplift.patches.test_ok', 'Dry-run OK — patch applies cleanly now'),
                bad.length ? 7000 : 4000);
            await pollPatches();
        } catch (e) { PG.toast(String(e), 5000); } finally { S.PT_BUSY = false; }
    });
    btn(ptMsg('uplift.patches.remove', 'Remove'), '', async () => {
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
                return;
            }
        }
        if (!confirm(ptMsg('uplift.patches.remove_confirm',
            'Remove this patch? Applied files are restored to vanilla bytes now.'))) return;
        await ptAction('remove', { id: p.id },
            ptMsg('uplift.patches.removed', 'Patch removed'));
    });
    card.append(acts);
    return card;
}

async function ptShowDiff(id, v) {
    try {
        // domkit-exempt: binary — plain-text diff body, not a JSON envelope
        const res = await fetch(`${API}/uplift/api/patches/diff/${id}/${v}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        $('pt-diff-title').textContent = `${id} · v${v}`;
        const body = $('pt-diff-body');
        body.innerHTML = '';
        for (const line of txt.split('\n')) {
            const s = document.createElement('span');
            s.className = line.startsWith('+') && !line.startsWith('+++') ? 'pt-diff-add'
                : line.startsWith('-') && !line.startsWith('---') ? 'pt-diff-del'
                : line.startsWith('@@') ? 'pt-diff-hunk' : '';
            s.textContent = line + '\n';
            body.append(s);
        }
        $('pt-diff').hidden = false;
        $('pt-diff').scrollIntoView({ block: 'nearest' });
    } catch (e) {
        PG.toast(ptMsg('uplift.patches.diff_fail', 'Could not load diff') + ': ' + e, 5000);
    }
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
        .some(p => p.id === id);
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
            // state a refresh would produce (enable/disable/remove usable)
            await pollPatches();
            const DP = window.Uplift.devpanel;
            if (DP) await DP.pollDev();
        }
        adv.hidden = !(r.advisories && r.advisories.length);
        adv.innerHTML = '';
        for (const a of (r.advisories || [])) {
            const w = document.createElement('div');
            w.textContent = '⚠ ' + a;
            adv.append(w);
        }
        box.hidden = false;
        box.innerHTML = '';   // clear-only (existing pattern); all content below goes through DOM builders + textContent
        // The PATCH CARD renders grouped safeguards for a NEW stored/
        // adopted patch (pollPatches above redraws it, in both scope
        // zones). The old flow rendered the stored verdict here TOO —
        // the double flood. Keep the box lines for every verdict with no
        // fresh card behind it: a REJECTED add (no card at all),
        // 'obsolete-held' (ok=true, nothing stored) and an UPDATE re-add
        // of an existing patch (pollPatches is skipped there, so the
        // card still shows the OLD version's flags).
        const cardShowsIt = r.ok && !r.obsolete && !wasStored;
        if (!cardShowsIt && r.safeguards && (r.safeguards.problems || []).length) {
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
                if (grp.hint) hint = grp.hint;   // card absent -> hint lives here
            }
            if (hint) {
                const row = document.createElement('div');
                row.className = 'pt-sg-rebuild';
                const lbl = document.createElement('span');
                lbl.textContent = ptMsg('uplift.patches.safeguard_rebuild',
                    'Native kernel rebuild (required for real effect):');
                const cmd = document.createElement('code');
                cmd.textContent = hint;
                cmd.title = 'click to copy';
                cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); };
                row.append(lbl, document.createTextNode(' '), cmd);
                box.append(row);
            }
        }
        if (!cardShowsIt && r.note) {
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
            const row = document.createElement('div');
            row.className = 'pt-acts pt-sg-acts';   // flex gap — two adjacent
            const held = r.requires_approval || [];  // filled .btn.primary
            const en = document.createElement('button');
            en.type = 'button';
            en.className = 'btn primary';
            en.textContent = held.length
                ? ptMsg('uplift.patches.approve_once', 'Apply once anyway')
                : ptMsg('uplift.patches.enable_now', 'Enable patch');
            en.onclick = async () => {
                await ptEnableWithApproval({ id }, held.length ? 'once' : null);
                box.hidden = true;
                $('pt-new-id').value = '';
            };
            row.append(en);
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
                row.append(al);
            }
            box.append(row);
        }
    } catch (e) {
        adv.hidden = false;
        adv.innerHTML = '';
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
                return id + ': ' + ptMsg('uplift.patches.update_avail_toast', 'update available (v{v})').replace('{v}', rep.v);
            if (rep.check === 'obsolete') return id + ': ' + ptMsg('uplift.patches.obsolete', 'obsolete');
            if (rep.check === 'error') return id + ': ' + ptMsg('uplift.patches.check_error', 'check failed') + ' — ' + rep.reason;
            return null;
        }).filter(Boolean);
        if (!quiet || notes.length)
            PG.toast(notes.length ? notes.join(' · ')
                : ptMsg('uplift.patches.all_current', 'All patch sources current'), 6000);
        await pollPatches();
    } catch (e) {
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

function initPatchesPage() {
    ptSyncKindUI();
    pollDoctor();
    $('pt-src-kind').onchange = ptSyncKindUI;
    $('pt-preview-btn').onclick = ptPreview;
    $('pt-check-btn').onclick = () => { ptCheckNow(false); ptAutoSyncCurated(true); };
    $('pt-diff-close').onclick = () => { $('pt-diff').hidden = true; };
    // FE-5: dev-panel button wiring lives with the panel (uplift_devpanel.js)
    if (window.Uplift.devpanel) window.Uplift.devpanel.initDevPanel();
    ptScheduleAutoCheck();
}


window.Uplift = window.Uplift || {};
window.Uplift.patches = {
    pollPatches, initPatchesPage, patchCard,
    // FE-5: pollDev moved to uplift_devpanel.js; keep the old accessor alive
    // for uplift.js's tab dispatcher (lazy, order-free).
    get pollDev() { return window.Uplift.devpanel && window.Uplift.devpanel.pollDev; },
};
})();
