/* ============================================================================
   PAT-4: PATCHES — declarative patch carrier UI (settings/patches).
   PH2-1 stage 8: extracted from uplift.js. Every button hits a PAT-2
   endpoint; nothing here writes the keg directly — enable/disable/promote/
   rollback/reconcile land at the NEXT omlx restart (the .pth engine, PAT-3).
   State chips reuse the cockpit-lamp vocabulary; the WARNING banner lights
   for needs_review/failed like an instrument flag. PT_DATA/PT_BUSY live in
   window.Uplift.state (declared before boot can reach pollPatches via
   applyTab — PAT-4 TDZ property preserved by load order). Plain script;
   loads AFTER uplift_state.js, BEFORE uplift.js, which late-binds
   toast/fetchJson/currentTab/currentSub via window.Uplift._patchesGlue.
   Exports window.Uplift.patches {pollPatches, initPatchesPage}.
   ========================================================================== */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const PG = {
    get toast() { return window.Uplift._patchesGlue.toast; },
    get fetchJson() { return window.Uplift._patchesGlue.fetchJson; },
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

// One diff line per problem + the autodetected root note (the paths stored
// in the manifest are the REWRITTEN ones — say so, or the diff view looks
// like it disagrees with the source URL).
function ptSafeguardLines(p) {
    const out = [];
    const ver = (p.versions || []).find(v => v.v === (p.desired_version ||
        Math.max(...(p.versions || []).map(x => x.v)))) || {};
    for (const pr of ((ver.safeguards || {}).problems || [])) {
        out.push({ text: pr.path + ' — ' + pr.message, code: pr.code });
    }
    if (ver.root_note) out.push({ text: ptMsg('uplift.patches.safeguard_note',
        'Root autodetected: {n}').replace('{n}', ver.root_note), code: null });
    return out;
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
    renderDev();
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

    // safeguards: flagged problems, autodetected root, rebuild command,
    // per-code approvals (the note names the EXCEPTIONS, not a blanket off)
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
            await pollDev();
        }
        adv.hidden = !(r.advisories && r.advisories.length);
        adv.innerHTML = '';
        for (const a of (r.advisories || [])) {
            const w = document.createElement('div');
            w.textContent = '⚠ ' + a;
            adv.append(w);
        }
        box.hidden = false;
        box.innerHTML = '';
        if (r.requires_approval && r.requires_approval.length) {
            const sgt = document.createElement('div');
            sgt.className = 'pt-sg-title';
            sgt.textContent = ptMsg('uplift.patches.safeguard_problems',
                'Safeguards flagged this patch:');
            box.append(sgt);
            for (const pr of ((r.safeguards || {}).problems || [])) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + pr.path + ' — ' + pr.message;
                box.append(w);
            }
            if (r.note) {
                const w = document.createElement('div');
                w.className = 'pt-advisories';
                w.textContent = '⚠ ' + ptMsg('uplift.patches.safeguard_note',
                    'Root autodetected: {n}').replace('{n}', r.note);
                box.append(w);
            }
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
            const en = document.createElement('button');
            en.type = 'button';
            en.className = 'btn primary';
            const held = r.requires_approval || [];
            en.textContent = held.length
                ? ptMsg('uplift.patches.approve_once', 'Apply once anyway')
                : ptMsg('uplift.patches.enable_now', 'Enable patch');
            en.onclick = async () => {
                await ptEnableWithApproval({ id }, held.length ? 'once' : null);
                box.hidden = true;
                $('pt-new-id').value = '';
            };
            box.append(en);
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
                box.append(al);
            }
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

/* ============================================================================
   DEV-5: "Build patches (omlx-dev)" section. Every state claim comes from
   /dev/status (never client guesses): staleness = built_sha vs expected_tip,
   drift = branch content vs enabled set, sharing = realized vs configured.
   Build-scope patch cards REUSE the runtime card anatomy; enable/disable
   ride the existing /patches/* endpoints (DEV-1 made them scope-aware).
   ========================================================================== */

let DV_DATA = null;
let DV_POLL = null;
// Set the instant a build click lands, cleared once the server reports
// build.running (or the POST fails). Bridges the poll-race window where
// DV_DATA still says "not running" and buttons would flicker back live.
let DV_CLICK_BUSY = false;
let DV_BOOT_POLL = null;
let DV_COMMITS = null;   // DEV-7(c): /dev/commits cache, loaded on demand
let DV_PIN_OPEN = false; // build-base pin row: collapsed until opened/pinned

async function pollDev() {
    const sec = $('dv-section');
    if (!sec) return;
    try {
        DV_DATA = await PG.fetchJson(`${API}/uplift/api/dev/status`);
        renderDev();
    } catch (e) {
        // a vanilla-only install has the endpoint too (installed:false) —
        // a failure here is an auth/API problem, hide rather than half-render
        sec.hidden = true;
    }
}

function dvApi(path, body) {
    return PG.fetchJson(`${API}/uplift/api/dev/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
}

function dvSha(sha) { return sha ? String(sha).slice(0, 12) : '—'; }

function renderDev() {
    const d = DV_DATA;
    const sec = $('dv-section');
    if (!d) { sec.hidden = true; return; }
    sec.hidden = false;
    const state = $('dv-state');
    state.innerHTML = '';
    const intro = $('dv-intro'), statusEl = $('dv-status');
    const patchesBox = $('dv-patches'), actions = $('dv-actions');
    const shareBox = $('dv-share'), warn = $('dv-warn');

    if (!d.installed) {
        statusEl.hidden = true; patchesBox.hidden = true;
        actions.hidden = true; shareBox.hidden = true; warn.hidden = true;
        const baseBox = $('dv-base');
        if (baseBox) baseBox.hidden = true;
        intro.hidden = false;
        intro.textContent = ptMsg('uplift.patches.dev_not_installed',
            'omlx-dev is not set up on this machine. To build patches here, run: '
            + 'omlx-uplift dev bootstrap (clones the dev-src repo), add patches with '
            + 'scope "build", then omlx-uplift dev install. Details: '
            + (d.reason || ''));
        // DEV-7(d): same bootstrap, one click — progress rides /dev/status
        const bootBox = $('dv-bootstrap');
        if (bootBox) {
            bootBox.hidden = false;
            const boot = d.bootstrap || {};
            const btn = $('dv-boot-btn');
            if (btn) {
                btn.disabled = !!boot.running;
                btn.textContent = boot.running
                    ? ptMsg('uplift.patches.dev_booting', 'Bootstrapping…')
                    : ptMsg('uplift.patches.dev_boot_btn', 'Bootstrap omlx-dev');
            }
            const log = $('dv-boot-log');
            if (log) {
                log.hidden = !(boot.log && boot.log.length);
                log.textContent = (boot.log || []).join('\n');
            }
        }
        return;
    }
    intro.hidden = true;
    const bootBox0 = $('dv-bootstrap');
    if (bootBox0) bootBox0.hidden = true;

    // status line: branch @ tip, N commits over base, behind sync ref
    const bits = [];
    bits.push(ptMsg('uplift.patches.dev_branch', 'branch {b} @ {t}')
        .replace('{b}', d.branch || '—').replace('{t}', dvSha(d.tip)));
    if (typeof d.ahead === 'number')
        bits.push(ptMsg('uplift.patches.dev_ahead', '{n} commits over base')
            .replace('{n}', d.ahead));
    if (typeof d.behind === 'number' && d.behind > 0)
        bits.push(ptMsg('uplift.patches.dev_behind', 'behind {ref} by {n}')
            .replace('{ref}', d.sync_ref || '').replace('{n}', d.behind));
    bits.push(ptMsg('uplift.patches.dev_built', 'built keg {s}')
        .replace('{s}', dvSha(d.built_sha)));
    statusEl.hidden = false;
    statusEl.textContent = bits.join(' · ');

    if (d.stale)
        state.append(ptChip(ptMsg('uplift.patches.dev_needs_rebuild',
            'NEEDS REBUILD'), 'pt-st-warn',
            ptMsg('uplift.patches.dev_stale_hint',
                'the enabled build patch set no longer matches the built keg')));
    if (d.restart_needed)
        state.append(ptChip(ptMsg('uplift.patches.dev_restart_needed',
            'RESTART NEEDED'), 'pt-st-warn',
            ptMsg('uplift.patches.dev_restart_hint',
                'the running omlx-dev service started before the last build — restart to load it')));
    if (d.drift && d.drift.drift)
        state.append(ptChip(ptMsg('uplift.patches.dev_drift', 'DRIFT'),
            'pt-st-warn', d.drift.detail || ''));
    if (d.build && d.build.running)
        state.append(ptChip(ptMsg('uplift.patches.dev_building', 'BUILDING'),
            'pt-st-update', (d.build.log || []).slice(-1)[0] || ''));
    // DEV-10: a finished-but-failed build keeps its warning on the page —
    // the materialize/brew abort reason lives in the log tail (tooltip).
    // The server guarantees the previous keg + branch stayed intact.
    if (d.build && !d.build.running && d.build.result)
        state.append(ptChip(ptMsg('uplift.patches.dev_build_failed', 'BUILD FAILED'),
            'pt-st-warn', (d.build.log || []).slice(-8).join('\n')));

    warn.hidden = !(d.drift && d.drift.drift);
    if (warn.hidden === false)
        warn.textContent = ptMsg('uplift.patches.dev_drift_banner',
            'WARNING — the uplift-dev branch does not match the enabled patch '
            + 'set (manual commits?). A rebuild re-cuts the branch and drops '
            + 'the foreign commits.');

    dvRenderBase(d);

    // build patch cards: same anatomy as runtime, fed by the /patches view.
    // Grouped by scope under headings so dev-only and both-scope patches —
    // which behave differently (one only lands on the rebuild, the other
    // also overlays the keg) — never blur into one undifferentiated stack.
    const buildOnDv = (S.PT_DATA && S.PT_DATA.patches || [])
        .filter(p => p.scope === 'dev' || p.scope === 'both');
    patchesBox.hidden = false;
    patchesBox.innerHTML = '';
    if (!buildOnDv.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = ptMsg('uplift.patches.dev_none',
            'No build patches yet. Add one below and pick scope "dev" or "both".');
        patchesBox.append(empty);
    }
    const groups = [
        ['both', ptMsg('uplift.patches.dev_group_both',
            'KEG + BUILD — overlays the running keg and lands in the omlx-dev build')],
        ['dev', ptMsg('uplift.patches.dev_group_dev',
            'BUILD ONLY — lands in the omlx-dev build')],
    ];
    const multi = new Set(buildOnDv.map(p => p.scope)).size > 1;
    for (const [scope, label] of groups) {
        const inGroup = buildOnDv.filter(p => p.scope === scope);
        if (!inGroup.length) continue;
        if (multi) {
            const h = document.createElement('div');
            h.className = 'dv-group-title';
            h.textContent = label;
            patchesBox.append(h);
        }
        for (const p of inGroup) {
            const card = patchCard(p, S.PT_DATA);
            if (d.stale && p.enabled)
                card.querySelector('.pt-card-head')
                    .append(ptChip(ptMsg('uplift.patches.dev_needs_rebuild',
                        'NEEDS REBUILD'), 'pt-st-warn'));
            patchesBox.append(card);
        }
    }

    actions.hidden = false;
    const btn = $('dv-build-btn');
    const busy = !!(d.build && d.build.running) || DV_CLICK_BUSY;
    btn.disabled = busy || !d.stale;
    btn.title = d.stale ? '' : ptMsg('uplift.patches.dev_build_ok',
        'built keg already matches the enabled patch set');
    const brBtn = $('dv-build-restart-btn');
    if (brBtn) {
        brBtn.disabled = btn.disabled;
        brBtn.title = btn.title;
    }
    // One caption owner: renderDev. The pristine labels are snapshotted
    // once into data-base; a running build swaps all action buttons to
    // "Building…" so the click visibly did something (and the swap
    // survives every 5s poll re-render instead of flickering back).
    [btn, brBtn, $('dv-restart-btn'), $('dv-boot-btn')].forEach(b => {
        if (!b) return;
        if (!b.dataset.base) b.dataset.base = b.textContent;
        b.textContent = busy && b !== $('dv-restart-btn')
            ? ptMsg('uplift.patches.dev_building_btn', 'Building…')
            : b.dataset.base;
        if (busy) { b.dataset.busy = '1'; } else { delete b.dataset.busy; }
    });
    if (busy) { btn.disabled = true; if (brBtn) brBtn.disabled = true; }
    const rsBtn = $('dv-restart-btn');
    if (rsBtn) {
        // Restart makes sense whenever the dev service EXISTS: fresh
        // build needs loading, restart_needed flag, or the service is
        // simply down and should come up. Only meaningless while a build
        // is mid-flight. (Previous gate (restart_needed || !stale) left
        // it dead-lit-but-dead when the service was down with stale=true.)
        rsBtn.disabled = busy;
        rsBtn.title = ptMsg('uplift.patches.dev_restart_title',
            'brew services restart omlx-dev');
    }

    // Isolation block: port, base path, per-file isolation toggles (server
    // truth). 2026-09-26 rename (user): "Coexistence" → "Isolation" with the
    // checkbox polarity flipped — checked now means omlx-dev keeps a PRIVATE
    // copy under its own base path; unchecked means it shares (symlinks) the
    // vanilla ~/.omlx/ files. Config truth stays share_map (shared=want).
    shareBox.hidden = false;
    shareBox.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pt-gate-row pt-gate-head';
    const hs = document.createElement('span');
    hs.textContent = ptMsg('uplift.patches.dev_isolation', 'Isolation');
    head.append(hs);
    shareBox.append(head);
    const isoIntro = document.createElement('div');
    isoIntro.className = 'pt-gate-row';
    const isoIntroEl = document.createElement('span');
    isoIntroEl.className = 'pt-detail';
    isoIntroEl.textContent = ptMsg('uplift.patches.dev_isolation_hint',
        'checked = omlx-dev keeps its own file · unchecked = omlx-dev uses '
        + 'the vanilla {v}/ file').replace('{v}', d.vanilla_base_path || '~/.omlx');
    isoIntro.append(isoIntroEl);
    shareBox.append(isoIntro);
    const meta = document.createElement('div');
    meta.className = 'pt-gate-row';
    const m = document.createElement('span');
    m.className = 'pt-detail';
    const clash = d.port === d.vanilla_port;
    m.textContent = ptMsg('uplift.patches.dev_runtime',
        'port {p} · base {b} · vanilla port {v}{c}{r}')
        .replace('{p}', d.port).replace('{b}', d.base_path)
        .replace('{v}', d.vanilla_port)
        .replace('{c}', clash ? ptMsg('uplift.patches.dev_port_clash',
            ' — SAME PORT AS VANILLA') : '')
        .replace('{r}', d.service_running
            ? ptMsg('uplift.patches.dev_service_on', ' · service running') : '');
    meta.append(m);
    shareBox.append(meta);
    for (const [name, info] of Object.entries(d.share_realized || {})) {
        const row = document.createElement('div');
        row.className = 'pt-gate-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        // ISOLATION polarity: checked = private copy under the dev base.
        cb.checked = !info.shared_wanted;
        cb.onchange = async () => {
            const share = [], no_share = [];
            for (const [k, v] of Object.entries(d.share_configured || {}))
                (k === name ? !cb.checked : v) ? share.push(k) : no_share.push(k);
            try {
                const r = await dvApi('reconfigure',
                    { share, no_share });
                DV_DATA = r.status || DV_DATA;
                renderDev();
            } catch (e) {
                PG.toast(ptMsg('uplift.patches.dev_reconfig_fail',
                    'Reconfigure failed') + ': ' + e, 5000);
                cb.checked = !cb.checked;
            }
        };
        const lbl = document.createElement('span');
        // Spell out what the box means for THIS file with the real paths
        // (user 2026-09-26: "make it clear the checkboxes mean omlx-dev
        // will use ~/.omlx/... files").
        const fname = d.share_filenames?.[name] || name;
        const iso = d.base_path + '/' + fname;
        const shr = (d.vanilla_base_path || '~/.omlx') + '/' + fname;
        lbl.textContent = ptMsg('uplift.patches.dev_isolation_file',
            'isolated {f} (own copy at {i}; unchecked: shared {s})')
            .replace('{f}', name).replace('{i}', iso).replace('{s}', shr);
        lbl.title = iso + '  ⇄  ' + shr;
        row.append(cb, lbl);
        if (!info.ok)
            row.append(ptChip(ptMsg('uplift.patches.dev_share_mismatch',
                'OUT OF SYNC'), 'pt-st-warn',
                ptMsg('uplift.patches.dev_share_mismatch_hint',
                    'the file on disk does not match the setting — run '
                    + 'omlx-uplift dev reconfigure')));
        shareBox.append(row);
    }
}

/* --- DEV-7(c): base-root chooser -----------------------------------------
   What uplift-dev re-cuts from: default = follow the vanilla omlx keg pin
   (today's behaviour); a commit from the sync-ref log pins the base. A pin
   changes nothing until the next rebuild (materialize re-cuts the branch). */

async function dvLoadCommits() {
    if (DV_COMMITS) return DV_COMMITS;
    try {
        const r = await PG.fetchJson(`${API}/uplift/api/dev/commits?limit=50`);
        DV_COMMITS = r.commits || [];
    } catch (e) {
        DV_COMMITS = null;   // retry on next open
    }
    return DV_COMMITS;
}

function dvRenderBase(d) {
    const box = $('dv-base');
    if (!box) return;
    box.hidden = false;
    const sel = $('dv-base-select'), note = $('dv-base-note');
    // build patches rebuild every poll — never stomp a selection in flight
    if (document.activeElement === sel) return;
    const pinned = d.base_pin || '';
    const following = ptMsg('uplift.patches.dev_base_follow',
        'follow vanilla omlx keg');
    // the pin row is expert-only: collapsed unless something is pinned (a
    // hidden pin would be an invisible override silently beating AUTO UPDATE)
    const pinRow = $('dv-pin-row'), toggle = $('dv-pin-toggle');
    if (pinRow && !pinned && document.activeElement !== sel)
        pinRow.hidden = !DV_PIN_OPEN;
    if (toggle) {
        // hidden once opened (the row itself is visible) or pinned (the row
        // is mandatory then) or while a build runs (no re-pin mid-flight)
        toggle.hidden = !!pinned || DV_PIN_OPEN || !!(d.build && d.build.running);
        toggle.onclick = () => {
            DV_PIN_OPEN = true;
            pinRow.hidden = false;
            toggle.hidden = true;
        };
    }
    if (pinned && pinRow) pinRow.hidden = false;
    if (toggle && pinned) toggle.hidden = true;
    // rebuild options fresh each render — commit list is fetch-once, cache
    sel.innerHTML = '';   // plain clear, no markup — safe
    const def = document.createElement('option');
    def.value = '';
    def.textContent = following + (pinned ? '' : ` (${dvSha(d.base)})`);
    sel.append(def);
    const commits = DV_COMMITS || [];
    if (!commits.length && !DV_COMMITS) dvLoadCommits().then(c => {
        if (c && DV_DATA === d) dvRenderBase(DV_DATA);
    });
    // pin may point outside the visible window — keep it selectable
    if (pinned && !commits.some(c => c.sha === pinned)) {
        const orp = document.createElement('option');
        orp.value = pinned;
        orp.textContent = `${dvSha(pinned)} — ${ptMsg('uplift.patches.dev_base_pinned', 'pinned commit')}`;
        sel.append(orp);
    }
    for (const c of commits) {
        const opt = document.createElement('option');
        opt.value = c.sha;
        opt.textContent = `${c.short} ${c.subject}`.slice(0, 90);
        sel.append(opt);
    }
    sel.value = pinned || '';
    const btn = $('dv-base-btn');
    btn.disabled = sel.value === (pinned || '') ||
        !!(d.build && d.build.running);
    note.textContent = pinned
        ? ptMsg('uplift.patches.dev_base_pinned_note',
            'pinned — the next rebuild re-cuts uplift-dev from this commit')
        : '';
    dvRenderAuto(d, pinned);
    btn.onclick = async () => {
        const pin = sel.value;
        btn.disabled = true;
        try {
            const r = await dvApi('base', { pin: pin || null });
            DV_DATA = r.status || DV_DATA;
            if (!pin) DV_PIN_OPEN = false;   // back to follow: collapse again
            PG.toast(pin
                ? ptMsg('uplift.patches.dev_base_set', 'Base pinned — rebuild to apply')
                : ptMsg('uplift.patches.dev_base_cleared', 'Back to following the sync ref'), 5000);
            renderDev();
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.dev_base_fail', 'Base change failed') + ': ' + e, 5000);
            btn.disabled = false;
        }
    };
}

function dvRenderAuto(d, pinned) {
    /* DEV-11: AUTO UPDATE — TRACK HEAD. The boot hook rebuilds omlx-dev on
       service start when the tracked sync tip moved since this keg was cut.
       Only meaningful while following HEAD — pinned disables it (and the
       server clears the flag as part of the pin). */
    const row = $('dv-auto-row'), cb = $('dv-auto'), note = $('dv-auto-note');
    if (!row || !cb) return;
    row.hidden = false;
    cb.checked = !!d.auto_update;
    cb.disabled = !!pinned || !!(d.build && d.build.running);
    if (pinned) {
        note.textContent = ptMsg('uplift.patches.dev_auto_pinned',
            'unavailable while the base is pinned');
    } else if (d.update_available) {
        note.textContent = ptMsg('uplift.patches.dev_auto_pending',
            'HEAD moved — omlx-dev will rebuild on the next restart');
    } else if (d.auto_update) {
        note.textContent = ptMsg('uplift.patches.dev_auto_on',
            'auto-rebuild on restart when HEAD moves');
    } else {
        note.textContent = '';
    }
    cb.onchange = async () => {
        cb.disabled = true;
        try {
            const r = await dvApi('auto-update', { enabled: cb.checked });
            DV_DATA = r.status || DV_DATA;
            renderDev();
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.dev_auto_fail',
                'Auto-update change failed') + ': ' + e, 5000);
            cb.disabled = false;
            dvRenderAuto(DV_DATA, (DV_DATA && DV_DATA.base_pin) || '');
        }
    };
}

function dvStartBootstrap() {
    const btn = $('dv-boot-btn');
    if (btn) btn.disabled = true;
    dvApi('bootstrap', {}).then(() => {
        PG.toast(ptMsg('uplift.patches.dev_boot_started',
            'omlx-dev bootstrap started'), 4000);
        clearInterval(DV_BOOT_POLL);
        DV_BOOT_POLL = setInterval(async () => {
            await pollDev();
            if (!(DV_DATA && DV_DATA.bootstrap && DV_DATA.bootstrap.running)) {
                clearInterval(DV_BOOT_POLL);
                if (DV_DATA && DV_DATA.installed)
                    PG.toast(ptMsg('uplift.patches.dev_boot_done',
                        'omlx-dev bootstrapped — add build patches and rebuild'), 6000);
            }
        }, 4000);
    }).catch(e => {
        PG.toast(ptMsg('uplift.patches.dev_boot_fail',
            'Bootstrap failed to start') + ': ' + e, 5000);
        if (btn) btn.disabled = false;
    });
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

function initPatchesPage() {
    ptSyncKindUI();
    $('pt-src-kind').onchange = ptSyncKindUI;
    $('pt-preview-btn').onclick = ptPreview;
    $('pt-check-btn').onclick = () => { ptCheckNow(false); ptAutoSyncCurated(true); };
    $('pt-diff-close').onclick = () => { $('pt-diff').hidden = true; };
    const dvBtn = $('dv-build-btn');
    if (dvBtn) dvBtn.onclick = () => dvStartBuild(false);
    const dvBootBtn = $('dv-boot-btn');
    if (dvBootBtn) dvBootBtn.onclick = () => dvStartBootstrap();
    const dvBrBtn = $('dv-build-restart-btn');
    if (dvBrBtn) dvBrBtn.onclick = () => dvStartBuild(true);
    const dvRsBtn = $('dv-restart-btn');
    if (dvRsBtn) dvRsBtn.onclick = async () => {
        // THIS dashboard may BE the dev server — the page dies with it.
        // The endpoint restarts detached after answering; reload shortly.
        try {
            await dvApi('restart', {});
            PG.toast(ptMsg('uplift.patches.dev_restarting',
                'omlx-dev restarting…'), 8000);
            setTimeout(() => location.reload(), 6000);
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.dev_restart_fail',
                'Restart failed') + ': ' + e, 5000);
        }
    };
    ptScheduleAutoCheck();
}

async function dvStartBuild(restartAfter) {
    // Immediate feedback: labels swap to a busy caption the moment the
    // click lands. renderDev() runs against stale DV_DATA for a few
    // seconds (build.running only flips on the next poll), which used to
    // leave the buttons looking stuck-lit with nothing happening.
    const busyBtns = [$('dv-build-btn'), $('dv-build-restart-btn'),
                      $('dv-restart-btn')].filter(Boolean);
    const prev = busyBtns.map(b => [b.textContent, b.disabled]);
    DV_CLICK_BUSY = true;
    renderDev();               // instant: captions swap before the POST lands
    try {
        await dvApi('build', { restart_after: !!restartAfter });
        PG.toast(ptMsg(restartAfter ? 'uplift.patches.dev_build_restart_started'
                                    : 'uplift.patches.dev_build_started',
                       restartAfter ? 'omlx-dev rebuild started (restart follows)'
                                    : 'omlx-dev rebuild started'), 4000);
        await pollDev();               // authoritative state, not stale DV_DATA
        const running0 = DV_DATA && DV_DATA.build && DV_DATA.build.running;
        if (running0) DV_CLICK_BUSY = false;   // server truth takes over
        renderDev();
        clearInterval(DV_POLL);
        let sawRunning = !!running0;
        let idlePolls = 0;
        DV_POLL = setInterval(async () => {
            await pollDev();
            const running = DV_DATA && DV_DATA.build && DV_DATA.build.running;
            if (running) { DV_CLICK_BUSY = false; sawRunning = true; renderDev(); return; }
            // Not running: finish only if we saw it run, or the server has
            // said "idle" repeatedly (fast/failed build never showed running).
            if (!sawRunning && ++idlePolls < 3) { renderDev(); return; }
            DV_CLICK_BUSY = false;
            clearInterval(DV_POLL);
            renderDev();
            PG.toast(DV_DATA && DV_DATA.build && DV_DATA.build.result &&
                     DV_DATA.build.result.ok === false
                ? ptMsg('uplift.patches.dev_build_failed_btn',
                        'omlx-dev build FAILED — see build log')
                : ptMsg('uplift.patches.dev_build_done_btn',
                        'omlx-dev build finished'), 6000);
        }, 5000);
    } catch (e) {
        PG.toast(ptMsg('uplift.patches.dev_build_fail',
            'Build failed to start') + ': ' + e, 5000);
        DV_CLICK_BUSY = false;
        busyBtns.forEach((b, i) => { b.textContent = prev[i][0];
                                     b.disabled = prev[i][1]; });
        busyBtns.forEach(b => delete b.dataset.busy);
    }
}

window.Uplift = window.Uplift || {};
window.Uplift.patches = { pollPatches, pollDev, initPatchesPage };
})();
