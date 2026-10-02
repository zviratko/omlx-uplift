/* FE-5: the omlx-dev control panel, lifted out of uplift_patches.js
   ("two products in one IIFE"). Owns its state (DV_*), timers, API helper
   and render path; the patches page reaches it through
   window.Uplift.devpanel at CALL time (load-order rule: uplift.js may
   load this file before or after uplift_patches.js — never capture at
   IIFE top). patchCard is the one shared anatomy piece: late-bound via
   window.Uplift.patches, which exports it. ptMsg/ptChip are three-line
   pure helpers, duplicated here on purpose so the panel stays
   self-contained. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const PG = { toast: D.toast, fetchJson: D.fetchJson };
function ptMsg(key, fb) { return C.tf(key, fb); }
function ptChip(text, cls, title) {
    const s = document.createElement('span');
    s.className = 'pt-chip ' + (cls || '');
    s.textContent = text;
    if (title) s.title = title;
    return s;
}
const patchCard = (p, view) => window.Uplift.patches.patchCard(p, view);

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

function initDevPanel() {
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
}


/* FE-5 seam: the patches page calls renderDev/pollDev through this export
   at click/poll time; graceful no-op when the panel file is absent. */
window.Uplift = window.Uplift || {};
window.Uplift.devpanel = { renderDev, pollDev, initDevPanel };
})();
