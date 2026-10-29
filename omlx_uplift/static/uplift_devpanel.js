/* FE-5: the omlx-dev control panel, lifted out of uplift_patches.js
   ("two products in one IIFE"). Owns its state (DV_*), timers, API helper
   and render path; the patches page reaches it through
   window.Uplift.devpanel at CALL time (load-order rule: uplift.js may
   load this file before or after uplift_patches.js — never capture at
   IIFE top). PAT-TABLE (user 2026-10-19): the patch rows all live in the
   single table (uplift_patches.js); this panel keeps the build-level
   strip AND the build-base picker, whose element now sits in the table's
   DEV column header (ids unchanged). ptMsg/ptChip are three-line pure
   helpers, duplicated here on purpose so the panel stays self-contained. */
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
/* LANE P (runtime line): one segment builder for the isolation meta row.
   Every value it prints comes from /dev/status, so it goes in through
   textContent — the row is never assembled as an HTML string. `—` keeps an
   absent number from reading as a blank hole in the middle of a sentence. */
function dvMeta(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = (text === null || text === undefined || text === '')
        ? '—' : String(text);
    return e;
}
/* HOME is a directory: exactly one trailing slash whatever the server sent
   ('~/.omlx-dev' and '~/.omlx-dev/' both land as '~/.omlx-dev/'). */
function dvHomePath(p) {
    return String(p || '').replace(/\/+$/, '') + '/';
}

/* ============================================================================
   DEV-5 strip: omlx-dev build controls under the patch table. Every state
   claim comes from /dev/status (never client guesses): staleness =
   built_sha vs expected_tip, drift = branch content vs enabled set,
   sharing = realized vs configured. The DEV checkbox on each row decides
   what the build set contains (PAT-TABLE /patches/targets); this strip
   only acts on the branch/build itself.
   ========================================================================== */

let DV_DATA = null;
let DV_POLL = null;
// Set the instant a build click lands, cleared once the server reports
// build.running (or the POST fails). Bridges the poll-race window where
// DV_DATA still says "not running" and buttons would flicker back live.
let DV_CLICK_BUSY = false;
let DV_BOOT_POLL = null;
let DV_COMMITS = null;   // DEV-7(c): /dev/commits cache, loaded on demand

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
    if (!d) {
        sec.hidden = true;
        // dv-warn now sits at the TOP of the card, outside this section, so
        // hiding the section no longer hides the warning. Fold it here or a
        // stale drift line outlives the DEV zone it belongs to.
        const w0 = $('dv-warn');
        if (w0) w0.hidden = true;
        return;
    }
    sec.hidden = false;
    const state = $('dv-state');
    state.innerHTML = '';
    const intro = $('dv-intro'), statusEl = $('dv-status');
    const actions = $('dv-actions');
    const shareBox = $('dv-share'), warn = $('dv-warn');

    if (!d.installed) {
        statusEl.hidden = true;
        actions.hidden = true; shareBox.hidden = true; warn.hidden = true;
        // no carrier -> the header's build-base picker stays hidden too
        const baseBox = $('dv-base');
        if (baseBox) baseBox.hidden = true;
        intro.hidden = false;
        intro.textContent = ptMsg('uplift.patches.dev_not_installed',
            'omlx-dev is not set up on this machine. To build patches here, run: '
            + 'omlx-uplift dev bootstrap (makes the source copy), add patches with '
            + 'scope "Build", then omlx-uplift dev install. Details: '
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
    bits.push(ptMsg('uplift.patches.dev_built', 'installed build: {s}')
        .replace('{s}', dvSha(d.built_sha)));
    if (d.base_stale)
        // base currency is an INFO line under the build status, not a
        // patch warning: the patches did not drift, omlx-dev just is not
        // built from the newest fetched sources yet (user 2026-10-18).
        bits.push(ptMsg('uplift.patches.dev_base_stale',
            'built from older sources — next Build/upgrade refreshes them'));
    // BUILD-ZONE honesty: the server says WHAT it measured and WHAT it
    // means (d.build_reason) — shown as its own line, not a hover-only
    // tooltip (user: "have explanation what it means"). Server-authored
    // English like the card's state detail, deliberately visible.
    const bstate = d.build_state;
    if (d.build_reason && bstate && bstate !== 'current')
        bits.push(d.build_reason);
    statusEl.hidden = false;
    statusEl.textContent = bits.join(' · ');

    if (d.stale) {
        // BUILD-ZONE honesty (mruu report, 2026-10-18): a sha gap is not a
        // verdict. The server classifies by CONTENT — warn only when the
        // enabled patches are genuinely NOT in the installed build; a
        // build that merely carries retired-patch residue gets a quiet
        // cleanup hint (nothing is missing, the next Build tidies up).
        const warn = d.needs_rebuild === undefined ? true : d.needs_rebuild;
        if (warn) {
            state.append(ptChip(ptMsg('uplift.patches.dev_needs_rebuild',
                'NEEDS REBUILD'), 'pt-st-warn',
                d.build_reason || ptMsg('uplift.patches.dev_stale_hint',
                    'the installed omlx-dev build no longer matches the enabled patches — press Build')));
        } else if (d.build_ahead) {
            state.append(ptChip(ptMsg('uplift.patches.dev_cleanup_build',
                'OLD CONTENT'), 'pt-st-dim',
                d.build_reason || ptMsg('uplift.patches.dev_cleanup_build_hint',
                    'the build still carries patch content that left the build set — press Build to drop it (nothing is missing)')));
        }
    }
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
    // BUILD-PROGRESS-1 (user 2026-10-10): the rebuild logs its progress —
    // brew's streamed lines land in d.build.log while the job runs (the
    // server appends per line). Shown while running or after a failure;
    // a success clears the log server-side (DEV-10 quiet-success), so the
    // box hides itself then. Same element style as the bootstrap log.
    const blog = $('dv-build-log');
    if (blog) {
        const bLog = (d.build && d.build.log) || [];
        blog.hidden = !(bLog.length && ((d.build && d.build.running)
                                        || d.build.result));
        blog.textContent = bLog.slice(-60).join('\n');
        if (!blog.hidden) blog.scrollTop = blog.scrollHeight;
    }

    // SAY WHAT CHANGED (mruu ask 2026-10-29): drift_check resolves the
    // evidence down to files and versions, and that sentence used to ride a
    // hover tooltip while this line made a generic accusation. A version
    // fallback takes the server's own reason instead of the canned lead:
    // pressing Build does NOT re-apply the wanted patch, it repeats the same
    // fallback, so the old promise was a lie.
    const _dr = d.drift || {};
    warn.hidden = !(_dr.drift || d.build_state === 'version-fallback');
    if (warn.hidden === false) {
        const _lead = d.build_state === 'version-fallback'
            ? (d.build_reason || '')
            : ptMsg('uplift.patches.dev_drift_banner',
                'WARNING - the omlx-dev build sources do not match the '
                + 'patches you enabled.');
        warn.textContent = [_lead, _dr.detail].filter(Boolean).join(' ');
    }

    // PAT-TABLE (user 2026-10-19): the build-zone patch cards are retired
    // — one row per patch lives in the single table above; this strip only
    // answers build-level truth (chips, status, logs) and owns the
    // build-base picker which sits in the table's DEV column header.
    dvRenderBase(d);

    actions.hidden = false;
    const btn = $('dv-build-btn');
    const busy = !!(d.build && d.build.running) || DV_CLICK_BUSY;
    btn.disabled = busy || !d.stale;
    btn.title = d.stale ? '' : ptMsg('uplift.patches.dev_build_ok',
        'the installed omlx-dev build already contains the enabled patches');
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
    head.className = 'pt-gate-row pt-gate-head dv-iso-head';
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
    // RUNTIME LINE (lane P, user 2026-10-27): the old single translated
    // sentence ('port {p} · base {b} · vanilla port {v}…') buried the two
    // facts an operator actually scans — WHICH service is up and ON WHICH
    // PORT — inside one grey string. Each fact is now its own element with
    // its own key, and the state words + port numbers carry .dv-meta-em so
    // CSS can embolden them. Built with createElement/textContent only:
    // every value here comes from /dev/status and must never be parsed as
    // markup.
    const meta = document.createElement('div');
    meta.className = 'pt-gate-row dv-runtime';
    const devUp = !!d.service_running;
    const vanillaUp = !!d.vanilla_service_running;
    const clash = d.port === d.vanilla_port;
    meta.append(
        dvMeta('b', 'dv-meta-em ' + (devUp ? 'dv-meta-on' : 'dv-meta-off'),
               devUp ? ptMsg('uplift.patches.dev_state_running', 'RUNNING')
                     : ptMsg('uplift.patches.dev_state_stopped', 'STOPPED')),
        dvMeta('span', '', ptMsg('uplift.patches.dev_runtime_on_port', 'on port')),
        dvMeta('b', 'dv-meta-em', d.port),
        dvMeta('span', 'dv-meta-sep', '·'),                      // i18n-exempt
        dvMeta('span', 'dv-meta-label',
               ptMsg('uplift.patches.dev_runtime_home', 'HOME:')),
        dvMeta('span', 'dv-meta-path', dvHomePath(d.base_path)),
        dvMeta('span', 'dv-meta-sep', '·'),                      // i18n-exempt
        dvMeta('span', 'dv-meta-label',
               ptMsg('uplift.patches.dev_vanilla_label', 'VANILLA OMLX:')),
        dvMeta('b', 'dv-meta-em ' + (vanillaUp ? 'dv-meta-on' : 'dv-meta-off'),
               vanillaUp ? ptMsg('uplift.patches.dev_vanilla_running', 'running')
                         : ptMsg('uplift.patches.dev_vanilla_stopped', 'not running')),
        dvMeta('span', '', ptMsg('uplift.patches.dev_runtime_on_port', 'on port')),
        dvMeta('b', 'dv-meta-em', d.vanilla_port));
    if (clash) {
        // the one case where sharing a port is a fault, kept as its own
        // loud segment (leading '—'/spaces come from the catalog: trim)
        meta.append(dvMeta('span', 'dv-meta-sep', '·'),           // i18n-exempt
                    dvMeta('b', 'dv-meta-clash',
                           ptMsg('uplift.patches.dev_port_clash',
                                 ' — POTENTIAL PORT CONFLICT')
                           .replace(/^[\s—–-]+/, '')));
    }
    shareBox.append(meta);
    // LANE P: the per-file toggles read as a list of settings, not as
    // gate rows; two columns so a machine with 6 isolated files stays
    // scannable instead of a 6-row ladder.
    const isoGrid = document.createElement('div');
    isoGrid.className = 'dv-iso-grid';
    for (const [name, info] of Object.entries(d.share_realized || {})) {
        const row = document.createElement('div');
        row.className = 'pt-gate-row dv-iso-item';
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
        isoGrid.append(row);
    }
    if (isoGrid.children.length) shareBox.append(isoGrid);
}

/* --- build-base picker (PAT-TABLE: it rides the table's DEV header) ----
   What uplift-dev re-cuts from: default = follow the vanilla omlx keg pin
   (today's behaviour); a commit from the sync-ref log pins the base. A pin
   changes nothing until the next rebuild (materialize re-cuts the branch).
   Native select: compact closed control, the open popup expands to the
   full option line on its own (user question answered: yes). */

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

/* TARGET (was the build-base select, user 2026-10-20): the DEV header shows
   the word as a hyperlink; clicking expands a full-line menu of the omlx-dev
   build sources. Nothing renders until the dev carrier exists. */
let DV_MENU = null;    // {pop, out, esc} while the menu is open

function dvCloseMenu() {
    if (!DV_MENU) return;
    DV_MENU.pop.remove();
    document.removeEventListener('click', DV_MENU.out, true);
    document.removeEventListener('keydown', DV_MENU.esc);
    DV_MENU = null;
}

function dvTargetMenu(btn, d) {
    const pinned = d.base_pin || '';
    const pop = document.createElement('div');
    pop.className = 'pt-target-menu';
    const mk = (text, active, pick, title) => {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'pt-target-item' + (active ? ' pt-target-sel' : '');
        it.textContent = (active ? '\u2713 ' : '') + text;
        if (title) it.title = title;
        it.onclick = async () => {
            dvCloseMenu();
            if (active) return;
            try {
                const r = await dvApi('base', { pin: pick || null });
                DV_DATA = r.status || DV_DATA;
                PG.toast(pick
                    ? ptMsg('uplift.patches.dev_base_set',
                        'Base pinned — rebuild to apply')
                    : ptMsg('uplift.patches.dev_base_cleared',
                        'Back to following the sync ref'), 5000);
                renderDev();
            } catch (e) {
                PG.toast(ptMsg('uplift.patches.dev_base_fail',
                    'Base change failed') + ': ' + e, 5000);
            }
        };
        return it;
    };
    pop.append(mk(ptMsg('uplift.patches.dev_base_follow',
        'follow upstream HEAD') + ' (' + dvSha(d.base) + ')',
        !pinned, ''));
    if (pinned) pop.append(mk(`${dvSha(pinned)} — `
        + ptMsg('uplift.patches.dev_base_pinned', 'pinned commit'),
        true, pinned));
    const head = document.createElement('div');
    head.className = 'pt-target-load pt-detail';
    head.textContent = '…';
    pop.append(head);
    // PAT-CAP (user 2026-10-21): the menu opens under a table header; the
    // whole 50-commit log read as a garbled wall — list the recent rows
    // and offer the rest behind one honest expander.
    const CAP = 15;
    const drawRow = (c) => pop.append(mk(`${c.short} — ${c.subject}`,
                                          false, c.sha, c.sha));
    const finish = (commits) => {
        if (!DV_MENU || DV_MENU.pop !== pop) return;   // closed meanwhile
        head.remove();
        if (!commits) {
            head.textContent = ptMsg('uplift.patches.dev_commits_fail',
                'commit list unavailable');
            pop.append(head);
            return;
        }
        const rest = commits.filter(c => !(pinned && c.sha === pinned));
        rest.slice(0, CAP).forEach(drawRow);
        const hidden = rest.slice(CAP);
        if (hidden.length) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'pt-target-item pt-target-more';
            more.textContent = ptMsg('uplift.patches.dev_base_show_all',
                'show all {n} commits').replace('{n}', rest.length);
            more.onclick = () => {
                more.remove();
                hidden.forEach(drawRow);
            };
            pop.append(more);
        }
    };
    document.body.append(pop);
    const br = btn.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    let left = Math.max(8, Math.min(br.left, innerWidth - r.width - 8));
    let top = br.bottom + 4;
    if (top + r.height > innerHeight - 8) {
        top = Math.max(8, br.top - r.height - 4);      // flip up
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    DV_MENU = {
        pop,
        out: ev => { if (!pop.contains(ev.target)) dvCloseMenu(); },
        esc: ev => { if (ev.key === 'Escape') dvCloseMenu(); },
    };
    setTimeout(() => {
        if (DV_MENU && DV_MENU.pop === pop) {
            document.addEventListener('click', DV_MENU.out, true);
            document.addEventListener('keydown', DV_MENU.esc);
        }
    }, 0);
    dvLoadCommits().then(finish);
}

function dvRenderBase(d) {
    const box = $('dv-base');
    if (!box) return;
    // the ( TARGET ) slot: only lit while the dev carrier exists
    box.hidden = !(d && d.installed);
    const btn = $('dv-target-btn');
    if (!btn || box.hidden) return;
    const pinned = d.base_pin || '';
    btn.title = pinned
        ? `${dvSha(pinned)} — ` + ptMsg('uplift.patches.dev_base_pinned_note',
            'pinned — the next Build uses exactly this source version')
        : ptMsg('uplift.patches.dev_base_follow',
            'follow upstream HEAD') + ' (' + dvSha(d.base) + ')';
    btn.disabled = !!(d.build && d.build.running);
    if (btn.dataset.wired !== '1') {
        btn.dataset.wired = '1';
        btn.onclick = ev => {
            ev.stopPropagation();
            if (DV_MENU) { dvCloseMenu(); return; }
            dvTargetMenu(btn, DV_DATA || d);
        };
    }
    dvRenderAuto(d, pinned);
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
            PG.toast(DV_DATA && DV_DATA.build && DV_DATA.build.result
                ? ptMsg('uplift.patches.dev_build_failed_btn',
                        'omlx-dev build FAILED — see build log')
                : ptMsg('uplift.patches.dev_build_done_btn',
                        'omlx-dev build finished'), 6000);
            // RESTART WATCH: 'Rebuild & restart' restarts the service the moment
            // the build lands, so the page is about to lose its backend. Take
            // over here instead of letting the operator discover it.
            if (restartAfter) dvWatchRestart();
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

/* RESTART WATCH (user, 2026-10-25): on this machine the dashboard IS the dev
   server, so pressing Restart — and the restart that follows a Rebuild &
   restart — tears the backend out from under the open page. Before this the
   whole plan was a toast plus a blind location.reload() after 6 s; when the
   service took longer the browser landed on a dead socket and the operator had
   to guess whether it was coming back. Now a dialog watches the round trip and
   reloads only once the board answers again.

   Probe: GET /uplift/api/dev/status through the kit (no raw fetch — the FE-2
   gate owns that). The kit stamps `.status` onto its error, which is what tells
   'the port answered' (any HTTP code, 401 included — a login page is a live
   server) apart from 'nothing is listening'. Two phases on purpose: a restart
   that has not begun yet answers perfectly normally, and reloading then would
   only drop the page mid-restart. So it waits for a DOWN edge first; if nothing
   ever drops it says so instead of pretending to have watched something.
   Dismissible (×, backdrop, or leaving it): the poll stops with the dialog. No
   Escape handler here — uplift_state.js closes the frontmost .modal-overlay
   globally and a second listener on the same key fires twice. */
let DV_RS = null;

function dvWatchRestart() {
    if (DV_RS) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';    // house dialog chrome (ptManage is the reference)
    const h = document.createElement('h3');
    h.textContent = ptMsg('uplift.patches.dev_restarting', 'omlx-dev restarting…');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    h.append(close);
    const line = document.createElement('p');
    line.className = 'pt-rs-line';
    const acts = document.createElement('div');
    acts.className = 'pt-acts';      // existing action-row styling
    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button'; reloadBtn.className = 'btn primary';
    reloadBtn.textContent = ptMsg('uplift.patches.dev_restart_reload', 'Reload now');
    acts.append(reloadBtn);
    box.append(h, line, acts);
    overlay.append(box);
    document.body.append(overlay);

    box.style.width = 'min(480px, 92vw)';
    const WAITING = ptMsg('uplift.ui.server_restarting_dashboard_reconnecting',
        'Server restarting — dashboard reconnecting…');
    line.textContent = WAITING;

    const t0 = Date.now();
    let sawDown = false, timer = null, done = false;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const shut = () => { stop(); done = true; DV_RS = null; overlay.remove(); };
    close.onclick = shut;
    overlay.onclick = (e) => { if (e.target === overlay) shut(); };
    reloadBtn.onclick = () => location.reload();

    const tick = async () => {
        if (done) return;
        const secs = Math.round((Date.now() - t0) / 1000);
        let answered = false;
        try {
            await PG.fetchJson(`${API}/uplift/api/dev/status?_=${Date.now()}`);
            answered = true;
        } catch (e) {
            answered = !!(e && e.status);      // any HTTP reply = it is alive
            if (!answered) sawDown = true;     // refused / no route = it is down
        }
        if (answered && sawDown) {
            stop(); done = true;
            line.textContent = ptMsg('uplift.patches.dev_restart_back',
                'Server is back — reloading…');
            setTimeout(() => location.reload(), 400);
            return;
        }
        if (secs > 300) {
            stop();
            line.textContent = ptMsg('uplift.patches.dev_restart_timeout',
                'The server has not answered again after {n}s. Check that '
                + 'omlx-dev is running, then reload this page.')
                .replace('{n}', String(secs));
            return;
        }
        line.textContent = (answered && !sawDown && secs > 25)
            ? ptMsg('uplift.patches.dev_restart_held',
                'Still answering — the restart has not started yet. This dialog '
                + 'stays open and reloads as soon as the service drops and '
                + 'comes back.')
            : WAITING + ' (' + secs + 's)';
    };
    timer = setInterval(tick, 1500);
    DV_RS = { overlay, shut };
    tick();
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
        // The endpoint restarts detached after answering, so hand over to the
        // watcher: it reloads when the port answers again, not on a timer.
        try {
            await dvApi('restart', {});
            dvWatchRestart();
        } catch (e) {
            PG.toast(ptMsg('uplift.patches.dev_restart_fail',
                'Restart failed') + ': ' + D.errText(e), 5000);
        }
    };
}


/* FE-5 seam: the patches page calls renderDev/pollDev through this export
   at click/poll time; graceful no-op when the panel file is absent.
   PATCH-ZONES: installed() answers whether the build zone carries the
   machine's build patches (both+dev cards live there when it does). */
window.Uplift = window.Uplift || {};
window.Uplift.devpanel = { renderDev, pollDev, initDevPanel, dvWatchRestart,
    installed: () => !!(DV_DATA && DV_DATA.installed) };
})();
