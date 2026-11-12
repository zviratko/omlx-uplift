/* SPLIT-3: Bench > Accuracy panel (REPL-2a, ACC-2a/2b): the classic task
   grid, the Additional suites fold (LM-Eval cards), saved picks, the
   queue, the live board and the stream stall guard.
   Part of the native bench: uplift_bench.js calls this factory once with
   a bridge (CORE) to its helpers and live state, and uses the returned
   panel. Code moved from uplift_bench.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftBenchParts = root.UpliftBenchParts || {}).acc = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Bench-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, C = CORE.C, dom = CORE.dom, errText = CORE.errText,
    api = CORE.api, t = CORE.t, el = CORE.el, busyLabel = CORE.busyLabel,
    labeled = CORE.labeled, check = CORE.check, gid = CORE.gid,
    taskCard = CORE.taskCard, loadingNote = CORE.loadingNote,
    streamInterrupted = CORE.streamInterrupted,
    statusLine = CORE.statusLine, setBar = CORE.setBar,
    boardSuiteMeta = CORE.boardSuiteMeta,
    boardQuestions = CORE.boardQuestions,
    boardCounters = CORE.boardCounters,
    advancedSection = CORE.advancedSection,
    buildAccuracyText = CORE.buildAccuracyText, dlFile = CORE.dlFile,
    accExportJson = CORE.accExportJson, accExportCsv = CORE.accExportCsv,
    accExportTxt = CORE.accExportTxt, dlMenu = CORE.dlMenu,
    resultsHead = CORE.resultsHead, stopStream = CORE.stopStream;

/* ==========================================================================
   ACC-2a/ACC-2b — 'ADDITIONAL SUITES' — the home of EVERY LM-Eval card.
   The user's hard constraint on this block: the classic grid (#bench-acc-tasks)
   shows oMLX Classic cards ONLY, and every harness card — both the twin of a
   classic suite (mmlu -> 'mmlu|h') and the expanded catalog's own suites —
   lives here instead. The section is a COLLAPSED-BY-DEFAULT <details> framed
   in the accent colour: the harness path is the expensive, per-subtask one,
   so it is revealed by a deliberate click, never by scrolling past it.
   Two sources feed one list (buildExtras, deterministic server order):
     - family 'core': the classic catalog crossed with 'harness_tasks' —
       rendered by the REAL taskRowEl(tk, true) card, so its size select,
       its '|h' key and its uploadable routing are exactly as before
     - the ACC-2a extra_suites payload (sibling of harness-sizes):
       {"extra_suites": [{"key": "ifeval", "label": "IFEval",
                          "family": "instruction", "rows": 541,
                          "upload_ok": false}, ...]}
   family is one of instruction|reasoning|locale (unknown families render
   under their own raw name). rows is a dataset fact or null — a null row
   count renders NO row part in the chip (U68: never a guessed number).
   Leaf counts come from the harness-sizes map the panel already owns; a
   suite the probe does not know yet omits the 'x' part the same way.
   The extra_suites are local-only by construction (the omlx.ai leaderboard
   knows just the classic 16), so this section carries NO upload affordance
   and their picks leave /add in their own queue entry with upload off.
   ========================================================================== */
var EXTRAS = {
    KEY: 'uplift.bench.extras.v1',   // fold + show-all persistence (browser pref)
    CAP: 6,                          // visible cards per family before 'show all'
    LIMIT: 100,                      // per-subtask sample limit of an extras pick
    FAMILIES: ['core', 'instruction', 'reasoning', 'locale'],
    // 'other' is the honest bucket: the ACC-2b seam emits family straight
    // off the spec ('spec.get("family")'), so a suite added without one
    // must still land somewhere NAMED, not under a raw null
    FAM_FALLBACK: { core: 'Core benchmarks', instruction: 'Instruction following',
                    reasoning: 'Reasoning', locale: 'Language & locale',
                    other: 'Other' },
    FAM_KEYS: ['core', 'instruction', 'reasoning', 'locale', 'other'],

    norm: function (list) {
        // Server order is kept (same doctrine as the classic grid: the
        // order of the catalog is a server-side decision, not a UI one)
        var out = [];
        (list || []).forEach(function (s) {
            if (!s || !s.key) return;
            out.push({ key: String(s.key), label: s.label || String(s.key),
                       family: s.family ? String(s.family) : 'other',
                       rows: (typeof s.rows === 'number' && s.rows > 0)
                             ? s.rows : null,
                       upload_ok: s.upload_ok === true });
        });
        return out;
    },

    buildExtras: function (st) {
        // ONE list, two sources, both in server order (the deterministic-
        // order doctrine: the catalog's order is a server-side decision).
        // 'core' first: the LM-Eval TWINS of the classic suites left the
        // classic grid (user directive: the grid is classic-only) and live
        // here, so the section exists as soon as a harness twin exists —
        // a pre-ACC-2b server (empty harness_tasks AND no extra_suites)
        // still gets zero DOM delta.
        var out = [];
        var twins = (st && st.harnessTasks) || [];
        ((st && st.groups) || []).forEach(function (grp) {
            (grp.tasks || []).forEach(function (tk) {
                if (!tk || !tk.key) return;
                if (twins.indexOf(tk.key) < 0) return;
                out.push({ key: String(tk.key), label: tk.label || String(tk.key),
                           family: 'core',
                           rows: (typeof tk.full_size === 'number'
                                  && tk.full_size > 0) ? tk.full_size : null,
                           upload_ok: true,      // a classic twin uploads
                           task: tk });          // painted by taskRowEl
            });
        });
        return out.concat(EXTRAS.norm((st && st.extraSuites) || []));
    },

    isExtra: function (st, bareKey) {
        var list = (st && st.extraSuites) || [];
        for (var i = 0; i < list.length; i++)
            if (list[i] && list[i].key === bareKey) return true;
        return false;
    },

    uploadOk: function (st, bareKey) {
        // ACC-2a: the server owns the leaderboard truth per suite. The
        // omlx.ai site knows only the classic 16, so it advertises
        // upload_ok:false for every extra — the UI must then never let an
        // extras pick travel in a request that carries the upload flag.
        var list = (st && st.extraSuites) || [];
        for (var i = 0; i < list.length; i++)
            if (list[i] && list[i].key === bareKey)
                return list[i].upload_ok === true;
        return true;   // not an extra: the classic/harness rule stands
    },

    groups: function (list) {
        var byF = {}, order = [];
        (list || []).forEach(function (s) {
            var f = s.family || 'other';    // norm() mapped a null family here
            if (!byF[f]) { byF[f] = []; order.push(f); }
            byF[f].push(s);
        });
        var known = EXTRAS.FAMILIES.filter(function (f) { return byF[f]; });
        var rest = order.filter(function (f) {
            return known.indexOf(f) < 0; });
        return known.concat(rest).map(function (f) {
            return { family: f, items: byF[f] };
        });
    },

    famLabel: function (f) {
        var fb = EXTRAS.FAM_FALLBACK[f] || f;
        return t('uplift.bench.extras_family_' + f, fb);
    },

    match: function (s, family, q) {
        if (!q) return true;
        return (String(s.label) + ' ' + String(s.key) + ' ' + family + ' '
                + EXTRAS.famLabel(family)).toLowerCase().indexOf(q) >= 0;
    },

    chip: function (rows, leaves) {
        // 'N rows · x<leaves> · LM-Eval' with the honest omissions: rows
        // unknown -> no row part, leaves unknown -> no 'x' part. Never a
        // guessed number (U68 doctrine).
        var parts = [];
        if (typeof rows === 'number' && rows > 0)
            parts.push(t('uplift.bench.extras_rows', '{n} rows')
                .replace('{n}', rows.toLocaleString()));
        // x1 is not information — the size-option labels apply the same
        // rule (applyEngineLabels multiplies only when the count is > 1)
        if (typeof leaves === 'number' && leaves > 1)
            parts.push('\u00d7' + leaves);
        parts.push(t('uplift.bench.engine_harness', 'LM-Eval'));
        return parts.join(' \u00b7 ');
    },

    ui: function () { return { fold: {}, all: {}, open: false, q: '' }; },

    load: function () {
        var out = EXTRAS.ui();
        try {
            var raw = localStorage.getItem(EXTRAS.KEY);
            var d = raw ? JSON.parse(raw) : null;
            if (d && d.fold && typeof d.fold === 'object') out.fold = d.fold;
            if (d && d.all && typeof d.all === 'object') out.all = d.all;
            // the SECTION's own fold: collapsed until the user opens it,
            // and that choice is remembered like every other pref here
            if (d && typeof d.open === 'boolean') out.open = d.open;
        } catch (_) { /* a broken pref is no pref: defaults, never a throw */ }
        return out;
    },

    save: function (ui) {
        try {
            localStorage.setItem(EXTRAS.KEY, JSON.stringify(
                { fold: ui.fold, all: ui.all, open: ui.open === true }));
        } catch (_) {}
    },

    render: function (acc) {
        var st = acc && acc.state;
        if (!st) return;
        if (!st.extrasUI) st.extrasUI = EXTRAS.load();
        var ui = st.extrasUI;
        st.extrasItems = EXTRAS.buildExtras(st);
        if (!st.extrasItems.length) {
            // nothing to show (no twin, no extra suite): no node at all, so
            // the panel is the one that shipped before this section existed
            if (st.extrasSec && st.extrasSec.remove) st.extrasSec.remove();
            st.extrasSec = null; st.extrasBox = null; st.extrasCount = null;
            return;
        }
        // The section belongs to ONE form() build: state is rebuilt on
        // every panel mount, so 'no st.extrasSec' means 'this form has no
        // section yet'. (Never look the node up by id — a remount detaches
        // the old one and an id lookup can still find a stale node.)
        if (!st.extrasSec) {
            // A <details> that stays COLLAPSED until the user clicks it:
            // the harness path is the expensive one (N requests PER
            // subtask), so reaching it must be a deliberate act, never a
            // scroll past it.
            var sec = el('details', 'acc-extras'); sec.id = 'bench-acc-extras';
            var head = el('summary', 'acc-extras-head');
            var cap = el('span', 'bench-label acc-extras-cap',
                t('uplift.bench.extras_title', 'Additional suites'));
            cap.dataset.i18n = 'uplift.bench.extras_title';
            cap.dataset.en = cap.textContent;                 // U59 repair
            var fbCount = t('uplift.bench.extras_count', '{n} suites')
                .replace('{n}', String(st.extrasItems.length));
            var count = el('span', 'acc-extras-count', fbCount);
            count.dataset.i18n = 'uplift.bench.extras_count';
            count.dataset.en = count.textContent;             // U59 repair
            // exactly like the cap: data-en holds the RENDERED text, so an
            // applyI18n pass with no catalog answer restores '13 suites'
            // rather than a raw '{n}' template. paint() is the authority
            // for the number (the {n} key is re-substituted on every
            // repaint, the same contract as the chip / show-all labels).
            head.append(cap, count, el('span', 'bench-adv-chev', '▾'));
            var body = el('div', 'acc-extras-body');
            var note = el('p', 'native-stub-note',
                t('uplift.bench.extras_note',
                  'Local only \u2014 the community leaderboard knows just the classic suites.'));
            note.dataset.i18n = 'uplift.bench.extras_note';
            note.dataset.en = note.textContent;               // U59 repair
            var search = el('input');
            search.type = 'search'; search.id = 'bench-acc-extras-search';
            search.className = 'acc-extras-search';
            var ph = t('uplift.bench.extras_search',
                'Search additional suites\u2026');
            search.placeholder = ph;
            // U51: a placeholder is not an accessible name; the box lives
            // beside its own caption, so label it with the section title
            search.setAttribute('aria-label',
                t('uplift.bench.extras_title', 'Additional suites'));
            search.dataset.i18nPh = 'uplift.bench.extras_search';
            search.dataset.enPh = ph;
            var box = el('div', 'acc-extras-fams'); box.id = 'bench-acc-extras-fams';
            // Everything that belongs to the fold lives INSIDE the details;
            // the body wrapper keeps a CLOSED section at zero stray padding
            // (nothing but the header strip is laid out at all).
            body.append(note, search, box);
            sec.append(head, body);
            sec.open = ui.open === true;      // collapsed by default
            head.setAttribute('aria-expanded', sec.open ? 'true' : 'false');
            sec.addEventListener('toggle', function () {
                var on = sec.open === true;
                head.setAttribute('aria-expanded', on ? 'true' : 'false');
                if (ui.open === on) return;
                ui.open = on;
                EXTRAS.save(ui);
            });
            // Below the classic grid, ABOVE the LM-Eval request total: the
            // suite choice may never sit after the run buttons (U79
            // grouping by concern) and the total stays readable outside the
            // fold. insertBefore keeps the classic children untouched.
            var host = st.extrasHost, anchor = st.extrasAnchor;
            if (!host) return;        // form() not built yet: stay unbuilt,
                                      // a later render() retries (never
                                      // adopt a detached node — painting
                                      // into one would show nothing)
            if (anchor && host.insertBefore) host.insertBefore(sec, anchor);
            else host.appendChild(sec);
            st.extrasSec = sec; st.extrasBox = box; st.extrasCount = count;
            search.addEventListener('input', function () {
                st.extrasUI.q = String(search.value || '');
                EXTRAS.paint(acc);
            });
        }
        EXTRAS.paint(acc);
    },

    paint: function (acc) {
        var st = acc.state, box = st.extrasBox, sec = st.extrasSec;
        if (!box || !sec) return;
        var ui = st.extrasUI || (st.extrasUI = EXTRAS.load());
        var q = String(ui.q || '').trim().toLowerCase();
        // The header answers 'how much is behind this fold' — a count of
        // the SUITES in the section, not of the picks (the request math
        // stays in #bench-acc-engine-total, outside the fold). A search
        // filters the list; it does not change what the section holds.
        if (st.extrasCount) {
            st.extrasCount.textContent = t('uplift.bench.extras_count',
                '{n} suites').replace('{n}', String(st.extrasItems.length));
        }
        box.replaceChildren();
        EXTRAS.groups(st.extrasItems).forEach(function (g) {
            var hits = q ? g.items.filter(function (s) {
                return EXTRAS.match(s, g.family, q); }) : g.items;
            if (q && !hits.length) return;      // a filtered-out family is gone
            // Families default open. A LIVE SEARCH always reveals them:
            // a folded <details> would keep the very match the user typed
            // for invisible (the pref itself is untouched — clearing the
            // box restores the folded state)
            var open = q ? true : ui.fold[g.family] !== false;
            var full = !!ui.all[g.family];
            // a search shows every hit — capping the matches would hide
            // the very suite the user typed for
            var vis = (full || q) ? hits : hits.slice(0, EXTRAS.CAP);
            var det = el('details', 'acc-extras-fam');
            det.open = open;
            det.dataset.family = g.family;
            var sum = el('summary', 'acc-extras-fam-cap',
                EXTRAS.famLabel(g.family) + ' (' + hits.length + ')');
            sum.setAttribute('aria-expanded', open ? 'true' : 'false');
            det.appendChild(sum);
            var row = el('div', 'acc-group-tasks acc-extras-tasks');
            vis.forEach(function (s) {
                // 'core' is the twin of a classic suite: it is painted by
                // the SAME taskRowEl(tk, true) that used to sit in the
                // classic grid, so its size select, its '|h' key and its
                // uploadable routing are untouched by the move. The extra
                // suites keep their own local-only card.
                row.appendChild((g.family === 'core' && s.task)
                    ? acc.taskRowEl(s.task, true)
                    : EXTRAS.card(acc, s, g.family, det));
            });
            det.appendChild(row);
            if (!q && hits.length > vis.length) {
                var more = el('button', 'btn acc-extras-more',
                    t('uplift.bench.extras_show_all', 'show all ({n})')
                        .replace('{n}', String(hits.length)));
                more.type = 'button';
                more.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    ui.all[g.family] = true; EXTRAS.save(ui); EXTRAS.paint(acc);
                });
                det.appendChild(more);
            } else if (!q && full && hits.length > EXTRAS.CAP) {
                var less = el('button', 'btn acc-extras-more',
                    t('uplift.bench.extras_hide', 'hide'));
                less.type = 'button';
                less.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    delete ui.all[g.family]; EXTRAS.save(ui); EXTRAS.paint(acc);
                });
                det.appendChild(less);
            }
            det.addEventListener('toggle', function () {
                var on = det.open !== false;
                sum.setAttribute('aria-expanded', on ? 'true' : 'false');
                if (ui.fold[g.family] === on) return;
                ui.fold[g.family] = on;
                if (!on) delete ui.all[g.family];   // refold re-caps the list
                EXTRAS.save(ui);
            });
            box.appendChild(det);
        });
        if (!box.children.length) {
            box.appendChild(el('p', 'native-stub-note',
                t('uplift.bench.extras_none',
                  'No additional suite matches that search.')));
        }
    },

    card: function (acc, s, family, det) {
        var st = acc.state, ui = st.extrasUI;
        var key = s.key + '|h';   // the harness engine carries these picks
        var card = taskCard(s.label, '', null, function (on) {
            if (on) {
                st.selected[key] = true;
                st.sizes[key] = EXTRAS.LIMIT;
                // a pick must never stay invisible: reveal the folded
                // family (and a capped list) it lives in
                if (det && det.open === false) {
                    det.open = true; ui.fold[family] = true; EXTRAS.save(ui);
                }
                if (!ui.all[family] && !ui.q) {
                    var g = EXTRAS.groups(st.extrasItems).filter(function (x) {
                        return x.family === family; })[0];
                    var idx = g ? g.items.indexOf(s) : -1;
                    if (idx >= EXTRAS.CAP) {
                        ui.all[family] = true; EXTRAS.save(ui); EXTRAS.paint(acc);
                    }
                }
            } else {
                delete st.selected[key]; delete st.sizes[key];
            }
            accSavePicks(st);              // REMEMBER (user 2026-11-01)
            acc.applyEngineLabels();   // U68: totals hint counts the pick
        });
        card.dataset.key = key;
        card.dataset.localOnly = '1';
        card.classList.add('acc-task-harness');
        var leaves = (st.harnessSizes && st.harnessSizes[s.key]) || null;
        var chip = el('div', 'acc-task-chip',
            EXTRAS.chip(s.rows, leaves));
        chip.title = t('uplift.bench.extras_limit',
            'Sample limit {n} per subtask (harness default)').replace(
                '{n}', String(EXTRAS.LIMIT));
        card.appendChild(chip);
        if (st.selected[key]) {
            card.classList.add('on');
            card.setAttribute('aria-pressed', 'true');
        }
        return card;
    },
};

/* ==========================================================================
   ACCURACY (REPL-2a) — classic 16-task engine over /uplift/api/
   bench/accuracy/*. Queue chaining + per-suite upload events belong to the
   classic runner; uplift flips upload to explicit OPT-IN (engine window
   patch, documented in accuracy_engine.py). Task grid comes from the
   server (/tasks) so dataset facts ship in one place; labels are classic
   acc_bench.* keys. The grid holds oMLX Classic cards ONLY — every
   LM-Eval card (a classic suite's twin as well as the expanded catalog)
   renders in the 'Additional suites' fold above, and never mixes in here.
   ========================================================================== */

/* ACC-STALL (user item 4): a half-open SSE socket (proxy blip) keeps the
   EventSource technically OPEN while the server stops talking — the board
   froze on the last painted event (the user saw 1/164 for minutes). Two
   defences, both driven from the 4s queue poll:
     1. restart the stream when the server has events we never consumed
        (needsStreamRestart hysteresis below);
     2. forward-seed the board from the poll's own last_progress, so the
        boxes move even against a server that does not report event_count.
   Both are FORWARD-ONLY by construction: harness leaf-restart events (cur
   lower than the live bar) are never seeded — a real leaf boundary only
   arrives through the stream or a full replay. */
var ACC_POLL_MS = 4000;
var ACC_STALL_MS = 90000;
/* REMEMBER (user 2026-11-01): the Intelligence panel keeps the last suite
   picks (and their sample sizes) per browser - the same localStorage
   pattern as the extras fold (EXTRAS.KEY). Server state is untouched; a
   pick whose suite left the catalog is dropped when the catalog lands. */
var ACC_PICKS_KEY = 'uplift.bench.acc.picks.v1';
function accLoadPicks() {
    var out = { selected: {}, sizes: {} };
    try {
        var raw = localStorage.getItem(ACC_PICKS_KEY);
        var d = raw ? JSON.parse(raw) : null;
        if (!d || typeof d !== 'object') return out;
        (d.selected || []).forEach(function (k) {
            if (typeof k === 'string' && k) out.selected[k] = true;
        });
        Object.keys(d.sizes || {}).forEach(function (k) {
            var n = d.sizes[k];
            if (typeof k === 'string' && k && typeof n === 'number' && isFinite(n) && n >= 0)
                out.sizes[k] = n;
        });
    } catch (_) { /* a broken pref is no pref (EXTRAS doctrine) */ }
    return out;
}
function accSavePicks(st) {
    try {
        if (!st) return;
        var sel = [], sizes = {};
        Object.keys(st.selected || {}).forEach(function (k) {
            if (!st.selected[k]) return;
            sel.push(k);
            if (st.sizes && st.sizes[k] != null) sizes[k] = st.sizes[k];
        });
        localStorage.setItem(ACC_PICKS_KEY,
            JSON.stringify({ selected: sel, sizes: sizes }));
    } catch (_) { /* private mode / quota: picks simply do not persist */ }
}
function accValidatePicks(acc) {
    // Runs on the STATE sources (groups / harness tasks / extra suites),
    // never on painted DOM, so it can prune BEFORE the grid renders - a
    // stale pick must neither paint 'on' nor reach collect().
    var st = acc && acc.state;
    if (!st || !st.groups) return;
    var known = {};
    st.groups.forEach(function (g) {
        (g.tasks || []).forEach(function (tk) {
            if (!tk || !tk.key) return;
            known[tk.key] = true;
            if ((st.harnessTasks || []).indexOf(tk.key) >= 0)
                known[tk.key + '|h'] = true;
        });
    });
    (st.extraSuites || []).forEach(function (s) {
        if (s && s.key) known[s.key + '|h'] = true;
    });
    var dirty = false;
    Object.keys(st.selected).forEach(function (k) {
        if (known[k]) return;
        delete st.selected[k]; delete st.sizes[k]; dirty = true;
    });
    if (dirty) accSavePicks(st);
}
// A restart RESETS the accumulators and REPLAYS the whole log. While that
// replay lands, the consumed counter is legitimately behind the server's
// event_count — a second restart racing in here would interleave TWO
// replays and double-bank the leaf totals (proven live in QA). Restart
// decisions only run outside this quiet window after an attach.
var ACC_RESTART_COOLDOWN_MS = 12000;
function needsStreamRestart(eventCount, seen, prevEventCount) {
    // The fetch and the stream race each other, so ONE poll that shows a
    // backlog proves nothing: restart only when the miss REPEATS, i.e. the
    // previous poll already reported more events than we have consumed NOW
    // (seen has not caught up to what the last poll saw). A stream that is
    // merely a moment behind has consumed the previous count by now, so this
    // also survives a backlog that keeps climbing while the socket is dead.
    if (typeof eventCount !== 'number') return false;
    if (eventCount <= (seen | 0)) return false;         // stream is current
    return typeof prevEventCount === 'number' && prevEventCount > (seen | 0);
}
function resetBoardEntry(entry, harnessSizes, groups) {
    // A reconnect REPLAYS the whole log from index 0. The harness leaf bank
    // lives in entry.bar (a bar that restarts below its previous cur banks
    // the old total) — replaying into a non-empty bar would bank twice, so
    // the accumulator is cleared first and the rebuild is exact.
    if (!entry) return entry;
    entry.bar = {};
    entry.suiteDone = {};
    entry.suiteQuiet = {};
    entry.qper = boardQuestions(entry.sizes || {}, entry.engine || 'classic',
                                harnessSizes, groups).per;
    var first = true;
    entry.suiteState = {};
    Object.keys(entry.sizes || {}).forEach(function (k) {
        entry.suiteState[k] = (entry.running && first) ? 'running' : 'queued';
        first = false;
    });
    return entry;
}

var ACC = {
    state: null,

    render: function (panel) {
        var picks = accLoadPicks();       // REMEMBER (user 2026-11-01)
        this.state = { running: false, benchId: null, queue: [],
                       progress: null, groups: null,
                       selected: picks.selected, sizes: picks.sizes,
                       results: [],
                       // ACC-STALL: stream bookkeeping (consumed events, the
                       // previous poll's event_count, last visible activity)
                       seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                       // U68: {suite: leaf subtask count}; harness --limit
                       // applies PER subtask, the labels must say so
                       harnessSizes: ACC._sizesCache || null,
                       harnessTasks: ACC._tasksCache || [],
                       // ACC-2a: harness-only suites (the SEPARATE section
                       // under the classic grid). /tasks owns the list; an
                       // absent key is the pre-ACC-2b server, and the
                       // section then does not exist in the DOM at all
                       extraSuites: ACC._extrasCache || [],
                       engine: 'classic' };
        panel.appendChild(this.form());
        var queue = el('div', 'acc-queue'); queue.id = 'bench-acc-queue';
        // ACC-STALL: this is a FRESH wrap — the in-place repaint guard must
        // forget the previous mount's shape or the first poll would skip it
        this._qSig = null;
        var status = statusLine('bench-acc-status');
        var results = el('div', 'bench-results'); results.id = 'bench-acc-results';
        panel.append(queue, status, results);
        this.loadModels();
        this.loadTasks();
        // ACC-2a: paint the extras section from the module cache right
        // away (a panel reopen must not blank it while /tasks is in
        // flight); loadTasks repaints when the payload lands
        EXTRAS.render(this);
        this.refreshQueue();
        this.refreshResults();
    },

    form: function () {
        var self = this;
        var f = el('div', 'bench-form card');
        f.appendChild(el('h2', null, t('uplift.bench.accuracy_heading', 'Accuracy benchmark')));
        f.appendChild(el('p', 'native-stub-note', t('acc_bench.description',
            'Multiple-choice and generation accuracy across 16 community benchmarks.')));

        var row1 = el('div', 'bench-row');
        var modelSel = el('select'); modelSel.id = 'bench-acc-model';
        var ph = el('option', null, t('acc_bench.config.model_placeholder', 'Select a model...'));
        ph.value = ''; modelSel.appendChild(ph);
        row1.appendChild(labeled(t('acc_bench.config.model', 'Model'), modelSel));
        f.appendChild(row1);

// U49: task grid gets its classic section caption (it floated
        // unlabeled before) and the scoring-engine choice moves OUT of
        // Advanced — first-order per-run decision, classic shows it openly
        f.appendChild(el('div', 'bench-label acc-grid-label',
            t('acc_bench.config.benchmarks', 'Benchmarks')));
        var grid = el('div', 'acc-taskgrid'); grid.id = 'bench-acc-tasks';
        // U69 (user): the engine is a property of the benchmark, not a
        // global mode. One list; every card carries its engine caption
        // (oMLX Classic / LM-Eval); the lm-eval math shows on the harness
        // cards' own size options. The old radio row is gone.
        var engNote = el('p', 'native-stub-note', t('uplift.bench.engine_hint',
            'oMLX Classic samples N questions total. LM-Eval (the community '
            + 'harness lm-eval) runs N PER SUBTASK — MMLU has 57 subtasks, so '
            + '30 becomes 1710 requests. The LM-Eval suites live in the '
            + 'Additional suites section below; its request total is shown '
            + 'under it.'));
        engNote.id = 'bench-acc-engine-hint';
        var totNote = el('p', 'native-stub-note'); totNote.id = 'bench-acc-engine-total';
        f.append(grid, engNote, totNote);
        self.loadHarnessSizes();
        // ACC-2a/2b: the extras section is a SIBLING that lands under the
        // classic grid and ABOVE the LM-Eval request total (the suite
        // choice may never sit after the run buttons, U79; and the total
        // has to stay readable while the fold is closed). form() only
        // records where it goes — the node itself exists only once the
        // server offers a harness card, so a plain classic panel is
        // byte-identical to the one that shipped without this section.
        self.state.extrasHost = f;
        self.state.extrasAnchor = totNote;   // insertBefore(target) = the
                                             // section goes above the total

        var extRow = el('div', 'bench-row bench-external');
        extRow.id = 'bench-acc-ext-row'; extRow.hidden = true;
        var eurl = el('input'); eurl.id = 'bench-acc-ext-url'; eurl.placeholder = t('bench.config.external_base_url', 'Base URL');
        var ekey = el('input'); ekey.id = 'bench-acc-ext-key'; ekey.type = 'password'; ekey.placeholder = t('bench.config.external_api_key', 'API key');
        var emax = el('input'); emax.id = 'bench-acc-ext-max'; emax.type = 'number'; emax.placeholder = t('acc_bench.config.external_max_tokens', 'Max tokens');
        var ebody = el('input'); ebody.id = 'bench-acc-ext-body'; ebody.placeholder = t('acc_bench.config.external_extra_body', 'Extra body (JSON)');
        var emod = el('input'); emod.id = 'bench-acc-ext-model'; emod.placeholder = t('bench.config.external_model', 'Model');
        extRow.append(labeled(t('bench.config.external_base_url', 'Base URL'), eurl),
                      labeled(t('bench.config.external_api_key', 'API key'), ekey),
                      labeled(t('bench.config.external_model', 'Model'), emod),
                      labeled(t('acc_bench.config.external_max_tokens', 'Max tokens'), emax),
                      labeled(t('acc_bench.config.external_extra_body', 'Extra body (JSON)'), ebody));

        // U48/U49: prominent full-width Advanced section; the external
        // inputs live INSIDE with their toggle (form-level before)
        var bsSel = el('select'); bsSel.id = 'bench-acc-batch';
        [1, 2, 4, 8, 16, 32].forEach(function (n) {
            var o = el('option', null, String(n)); o.value = String(n); bsSel.appendChild(o);
        });
        var sampSel = el('select'); sampSel.id = 'bench-acc-sampling';
        var o1 = el('option', null, t('acc_bench.config.sampling_deterministic', 'Deterministic (greedy)'));
        o1.value = 'deterministic'; sampSel.appendChild(o1);
        var o2 = el('option', null, t('acc_bench.config.sampling_model', 'Model settings (temperature)'));
        o2.value = 'model_settings'; sampSel.appendChild(o2);
        var accExtLb = check('bench-acc-ext', t('bench.config.external', 'Use external OpenAI API endpoint'), false);
        // UP-57: reference-bound reveal (the old gid()+rAF block attached
        // nothing when the rAF beat the async view mount — external
        // accuracy-mode inputs could never appear)
        // SYNC-1 run 23 (upstream fa7b454 #5189): local runs get the
        // per-question max_tokens floor external runs already had. Classic
        // shows the input only while the external endpoint is off and keeps
        // the value for the session only (runs get much longer).
        var lmax = el('input'); lmax.id = 'bench-acc-max'; lmax.type = 'number';
        lmax.min = '1'; lmax.step = '1'; lmax.placeholder = '65536';
        var lmaxRow = el('div', 'bench-row');
        lmaxRow.id = 'bench-acc-max-row';
        lmaxRow.append(labeled(t('acc_bench.config.max_tokens', 'Max Tokens Override'), lmax),
            el('p', 'native-stub-note', t('acc_bench.config.max_tokens_hint',
                'Optional floor for each question\'s max_tokens; benchmark defaults are never lowered. '
                + 'Raise it when answers hit the token limit, for example with thinking on. A larger limit '
                + 'can make runs much longer. The limit used is saved with the result.')));
        accExtLb.input.addEventListener('change', function () {
            extRow.hidden = !accExtLb.input.checked;
            lmaxRow.hidden = accExtLb.input.checked;
        });
        var adv = advancedSection([
            labeled(t('acc_bench.config.batch_size', 'Batch size'), bsSel),
            labeled(t('acc_bench.config.sampling', 'Sampling'), sampSel),
            el('p', 'native-stub-note', t('acc_bench.config.batch_size_hint', 'Larger batches are faster but use more memory.')),
            check('bench-acc-think', t('acc_bench.config.thinking', 'Enable thinking mode'), false),
            el('p', 'native-stub-note', t('acc_bench.config.thinking_hint', 'Applies to models whose template supports thinking toggles.')),
            lmaxRow,
            accExtLb,
            extRow,
            check('bench-acc-upload', t('uplift.bench.upload_results', 'Upload results to community leaderboard'), false),
            el('p', 'native-stub-note', t('uplift.bench.upload_hint',
                'Off by default: a native run never posts to omlx.ai unless you check this.'))],
            'acc_bench.config.advanced_options', 'Advanced options');
        f.appendChild(adv);

        var actions = el('div', 'bench-actions');
        var addBtn = el('button', 'btn primary', t('acc_bench.config.add_run', 'Add to Queue'));
        addBtn.type = 'button'; addBtn.id = 'bench-acc-add';
        addBtn.addEventListener('click', function () { self.add(); });
        var cancelBtn = el('button', 'btn', t('acc_bench.config.cancel_button', 'Cancel All'));
        cancelBtn.type = 'button'; cancelBtn.id = 'bench-acc-cancel';
        cancelBtn.addEventListener('click', function () { self.cancelAll(); });
        var clearBtn = el('button', 'btn', t('acc_bench.results.clear', 'Clear'));
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', function () { self.clearResults(); });
        actions.append(addBtn, cancelBtn, clearBtn);
        f.appendChild(actions);

        return f;
    },

    loadModels: function () {
        var d = dom();
        return d.fetchJson(api() + '/models').then(function (data) {
            var sel = gid('bench-acc-model');
            if (!sel) return;
            var usable = ((data && data.models) || []).filter(function (m) {
                var ty = m.model_type || m.type;
                return !ty || ty === 'llm' || ty === 'vlm';
            });
            var ph2 = el('option', null, t('acc_bench.config.model_placeholder', 'Select a model...'));
            ph2.value = '';
            sel.replaceChildren(ph2);
            usable.forEach(function (m) { sel.appendChild(el('option', null, m.id || m.model_id)); });
        }).catch(function () {});
    },

    _sizesCache: null,
    _tasksCache: null,   // U69: harness-mapped suite keys (module cache)
    _extrasCache: null,  // ACC-2a: harness-only suites (module cache)

    loadHarnessSizes: function () {
        // U68: lazy, never blocks the grid; the first server probe can
        // expand groups through bench-env (~20s once, cached on disk)
        if (ACC._sizesCache) { this.state.harnessSizes = ACC._sizesCache; this.applyEngineLabels(); return; }
        var self = this;
        var d = dom();
        d.fetchJson(api() + '/bench/accuracy/harness-sizes').then(function (p) {
            if (!p || !p.sizes) return;              // bench-env not ready: plain sizes
            ACC._sizesCache = p.sizes;
            if (self.state) { self.state.harnessSizes = p.sizes; }
            self.applyEngineLabels();
            // ACC-2a: the chips multiply by the leaf count — repaint once
            // the probe lands (before that they honestly omit the 'x' part)
            if (self.state && self.state.extrasBox) EXTRAS.paint(self);
            // U83: harness question math needs the leaf counts
            if (self.state && (self.state.running || (self.state.queue || []).length))
                self.refreshQueue();
        }).catch(function () { /* honest plain sizes */ });
    },

    _fullSize: function (st, key) {
        var out = 0;
        (st.groups || []).forEach(function (g) {
            (g.tasks || []).forEach(function (tk) {
                if (tk.key === key) out = tk.full_size || 0;
            });
        });
        return out;
    },

    applyEngineLabels: function () {
        var self = this;   // U83-FIX: pre-existing since 38c1259 — the
                           // engine-total loop below calls this._fullSize
                           // from a forEach callback where `this` is lost
                           // (crash: "can't access property _fullSize,
                           // this is undefined"). Found by the U83 drill
                           // because the board re-syncs labels on catalog
                           // load; the old code path hit it too.
        // U68+U69: every LM-Eval card relabels its OWN size options with
        // the per-subtask truth ('30 \u00d757'); classic cards stay plain
        var st = this.state;
        if (!st) return;
        var gdoc = (typeof document.querySelectorAll === 'function')
            ? document : null;
        if (gdoc) gdoc.querySelectorAll(
            // ACC-2b: the harness twins moved into the extras fold — the
            // multiplier must follow them there or their size options
            // would silently stop showing '30 \u00d757'
            '#bench-acc-tasks .acc-task, #bench-acc-extras .acc-task'
        ).forEach(function (card) {
            var key = card.dataset.key || '';
            var bare = key.indexOf('|h') > 0 ? key.slice(0, key.indexOf('|h')) : key;
            var c = (st.harnessSizes && st.harnessSizes[bare]) || 1;
            var sel = card.querySelector('select');
            if (!sel) return;
            var mult = (key.indexOf('|h') > 0 && c > 1) ? c : 1;
            [].forEach.call(sel.children, function (o) {
                if (o.value === '0') { o.dataset.base = o.dataset.base || o.textContent; return; }
                o.dataset.base = o.dataset.base || o.textContent;
                o.textContent = mult > 1 ? o.dataset.base + ' \u00d7' + mult : o.dataset.base;
            });
        });
        // Honest request total for the LM-Eval picks (sizes 0 = full
        // dataset: counted as full_size per subtask only when known,
        // otherwise excluded with the total staying a lower bound — we
        // NEVER print a guessed number)
        var tot = gid('bench-acc-engine-total');
        if (tot) {
            var reqs = 0, counted = false;
            Object.keys(st.selected).forEach(function (k) {
                if (!st.selected[k] || k.indexOf('|h') < 0) return;
                var bare = k.slice(0, k.indexOf('|h'));
                var c = (st.harnessSizes && st.harnessSizes[bare]) || 1;
                var n = st.sizes[k] || 0;
                if (!n) {
                    var fs = self._fullSize(st, bare);
                    if (!fs) return;             // unknown: stay silent-ish
                    n = fs;
                }
                reqs += c * n; counted = true;
            });
            var shown = counted && reqs ? reqs.toLocaleString() : '\u2014';
            var c2 = C();
            var line = (c2 && c2.t) ? c2.t('uplift.bench.engine_total',
                                            { n: shown }) : null;
            if (typeof line !== 'string' || line === 'uplift.bench.engine_total'
                || line.indexOf('{n}') >= 0) {
                var fb = t('uplift.bench.engine_total',
                    'LM-Eval selection: about {n} requests.');
                line = (typeof fb === 'string' ? fb
                        : 'LM-Eval selection: about {n} requests.')
                        .replace('{n}', shown);
            }
            tot.textContent = line;
            tot.hidden = !(Object.keys(st.selected).some(function (k) {
                return st.selected[k] && k.indexOf('|h') > 0; }));
        }
    },

    loadTasks: function () {
        var d = dom();
        var self = this;
        var g0 = gid('bench-acc-tasks');
        if (g0) g0.replaceChildren(loadingNote());
        return d.fetchJson(api() + '/bench/accuracy/tasks').then(function (data) {
            self.state.groups = data.tasks || [];
            // U69: which suites have an lm-eval equivalent (module cache:
            // a panel reopen before this fetch resolves still renders the
            // full list)
            ACC._tasksCache = data.harness_tasks || [];
            self.state.harnessTasks = ACC._tasksCache;
            // ACC-2a: harness-only suites for the SEPARATE section (the
            // key is absent on a pre-ACC-2b server — an absent key and an
            // empty list both mean: render nothing, ever)
            ACC._extrasCache = data.extra_suites || [];
            self.state.extraSuites = ACC._extrasCache;
            // REMEMBER: prune saved picks the catalog no longer offers
            // BEFORE the grid and the extras fold paint from them
            accValidatePicks(self);
            self.renderGrid();
            EXTRAS.render(self);
            self.applyEngineLabels();   // ACC-2a: totals see the extras cache
            // U83: the board may have painted BEFORE the catalog landed
            // (queued suites render key-only, 'Full' sizes unknown). Labels
            // and full-dataset totals come from groups — resync in place.
            if (self.state.running || (self.state.queue || []).length)
                self.refreshQueue();
        }).catch(function () {});
    },

    renderGrid: function () {
        var grid = gid('bench-acc-tasks');
        if (!grid || !this.state.groups) return;
        var self = this;
        grid.replaceChildren();
        this.state.groups.forEach(function (grp) {
            var wrap = el('div', 'acc-group');
            var cap = el('div', 'bench-label', t(grp.group, grp.group.split('.').pop()));
            cap.dataset.i18n = grp.group; cap.dataset.en = cap.textContent;  // U59
            wrap.appendChild(cap);
            var row = el('div', 'acc-group-tasks');
            grp.tasks.forEach(function (tk) {
                row.appendChild(self.taskRowEl(tk, false));
                // ACC-2b (user directive): the LM-Eval twin of a classic
                // suite no longer renders beside its classic twin here.
                // The grid shows oMLX Classic cards ONLY; every harness
                // card lives in the 'Additional suites' fold, which paints
                // it as the very same variant card it always was.
            });
            wrap.appendChild(row);
            grid.appendChild(wrap);
        });
        this.applyEngineLabels();   // U68: labels are fresh DOM
    },

    taskRowEl: function (tk, variant) {
        var self = this;
        var key = variant ? tk.key + '|h' : tk.key;
        var sizeSel = el('select');
        sizeSel.dataset.key = key;
        tk.sizes.forEach(function (n) {
            var o = el('option', null, String(n)); o.value = String(n); sizeSel.appendChild(o);
        });
        // U51: {count} lives INSIDE the translated key
        // (classic fills it the same way); the old concat showed
        // the raw placeholder + a paren for non-en locales
        // U69: 'Full' (0 = entire dataset) stays on oMLX Classic cards
        // ONLY. On an LM-Eval twin, lm_eval semantics would make it the
        // FULL set PER SUBTASK (mmlu: 14,042 x 57 requests) — an hours-
        // long accident one mis-click away, and the classic twin already
        // runs the same questions in full. Harness cards are for
        // controlled sample counts; the total line shows their cost.
        if (!variant) {
            var fullOpt = el('option', null,
                t('acc_bench.config.full_option', 'Full ({count})')
                    .replace('{count}', tk.full_size.toLocaleString()));
            fullOpt.value = '0';
            sizeSel.appendChild(fullOpt);
        }
        sizeSel.value = String(tk.sizes[Math.min(2, tk.sizes.length - 1)]);
        // REMEMBER: a saved size re-arms the select when the catalog still
        // offers that exact option (classic 'Full' lives as value '0')
        var sz0 = self.state.sizes[key];
        if (sz0 != null && [].some.call(sizeSel.children, function (o) {
                return o.value === String(sz0); }))
            sizeSel.value = String(sz0);
        // U51: keyboard-operable card (was a click-only div). The
        // size select lives inside as its own focus target; a
        // click that lands on it must not double-toggle the card.
        var card = taskCard(tk.label,
            tk.desc ? t(tk.desc, tk.desc_literal || tk.key) : (tk.desc_literal || ''),
            null, function (on) {
                self.state.selected[key] = on;
                accSavePicks(self.state); // REMEMBER (user 2026-11-01)
                self.applyEngineLabels();   // U68: totals hint
            }, { d: tk.desc || null });
        card.dataset.key = key;
        // REMEMBER: a restored pick paints its card; its saved size rides
        // along only while the catalog still offers that option
        if (self.state.selected[key]) {
            card.classList.add('on');
            card.setAttribute('aria-pressed', 'true');
        }
        // U69: engine caption inside the card — the list must read the
        // engine per benchmark (classic doctrine: oMLX Classic vs the
        // community lm-eval harness)
        var cap = el('div', 'acc-task-engine',
            variant ? t('uplift.bench.engine_harness', 'LM-Eval')
                    : t('uplift.bench.engine_classic', 'oMLX Classic'));
        cap.dataset.i18n = variant ? 'uplift.bench.engine_harness'
                                   : 'uplift.bench.engine_classic';
        cap.dataset.en = cap.textContent;   // U59 repair marker
        card.appendChild(cap);
        if (variant) card.classList.add('acc-task-harness');
        card.appendChild(sizeSel);
        sizeSel.addEventListener('click', function (ev) { ev.stopPropagation(); });
        sizeSel.addEventListener('change', function () {
            // choosing a size implies picking the task (U53: the
            // select stays operable on unselected cards — classic
            // disabled it, which made the FIRST click dead)
            if (!card.classList.contains('on')) {
                card.classList.add('on');
                card.setAttribute('aria-pressed', 'true');
                self.state.selected[key] = true;
            }
            self.state.sizes[key] = Number(sizeSel.value);
            accSavePicks(self.state);     // REMEMBER (user 2026-11-01)
            self.applyEngineLabels();       // U68: totals hint
        });
        return card;
    },

    collect: function () {
        var g = this.state;
        var benchmarks = {};
        Object.keys(g.selected).forEach(function (k) {
            if (!g.selected[k]) return;
            benchmarks[k] = g.sizes[k] != null ? g.sizes[k]
                : (g.groups ? this.defaultSize(k) : 100);
        }, this);
        var body = {
            model_id: gid('bench-acc-model') ? gid('bench-acc-model').value : '',
            benchmarks: benchmarks,
            batch_size: Number((gid('bench-acc-batch') || {}).value || 1),
            sampling_profile: (gid('bench-acc-sampling') || {}).value || 'deterministic',
            enable_thinking: !!(gid('bench-acc-think') && gid('bench-acc-think').checked),
            upload: !!(gid('bench-acc-upload') && gid('bench-acc-upload').checked),
        };
        // U69: engine is per CARD now ('key' classic, 'key|h' harness).
        // This call carries the classic part; the harness part rides as a
        // second queue entry (add() posts both) so mixed picks work and a
        // harness rejection (external/thinking) can't eat the classic run.
        var hBody = {};
        // ACC-2a: an extras pick (server upload_ok:false — the omlx.ai
        // leaderboard only knows the classic 16) leaves in ITS OWN queue
        // entry with upload forced off. The U69 upload opt-in can never
        // reach a local-only suite, not even when both are picked at once.
        var xBody = {};
        Object.keys(body.benchmarks).forEach(function (k) {
            if (k.indexOf('|h') > 0) {
                var bare = k.slice(0, k.indexOf('|h'));
                if (EXTRAS.isExtra(g, bare) && !EXTRAS.uploadOk(g, bare))
                    xBody[bare] = body.benchmarks[k];
                else
                    hBody[bare] = body.benchmarks[k];
                delete body.benchmarks[k];
            }
        });
        body.engine = 'classic';
        body._harness = Object.keys(hBody).length
            ? JSON.parse(JSON.stringify(Object.assign({}, body,
                  { benchmarks: hBody, engine: 'harness' })))
            : null;
        body._extras = Object.keys(xBody).length
            ? JSON.parse(JSON.stringify(Object.assign({}, body,
                  { benchmarks: xBody, engine: 'harness', upload: false })))
            : null;
        var ext = gid('bench-acc-ext');
        if (ext && ext.checked) {
            // classic parity (accuracyExternalRequestBody): extra_body +
            // max_tokens_override live INSIDE the external object, and
            // model_id IS the remote model name (local catalog skipped)
            var external = {
                base_url: (gid('bench-acc-ext-url') || {}).value || '',
                api_key: (gid('bench-acc-ext-key') || {}).value || '',
                model: ((gid('bench-acc-ext-model') || {}).value || '').trim(),
            };
            var eb = (gid('bench-acc-ext-body') || {}).value;
            if (eb && eb.trim()) {
                try { external.extra_body = JSON.parse(eb); }
                catch (e) { throw new Error(t('acc_bench.config.external_extra_body', 'Extra body (JSON)') + ': JSON'); }
            }
            var mt = Number((gid('bench-acc-ext-max') || {}).value || 0);
            if (mt > 0) external.max_tokens_override = mt;
            body.model_id = external.model || body.model_id;
            body.external = external;
            body.enable_thinking = false;  // classic forces off for external
        } else {
            // fa7b454: local floor rides the TOP-LEVEL request field; classic
            // validates it the same way (integer 1..1,000,000, else refuse).
            // Built-in (classic engine) runs only: the LM-Eval twins above
            // were cloned before this line and never carry it.
            var lraw = String((gid('bench-acc-max') || {}).value || '').trim();
            if (lraw) {
                var lv = Number(lraw);
                if (!Number.isInteger(lv) || lv < 1 || lv > 1000000) {
                    throw new Error(t('js.error.external_max_tokens_invalid',
                        'Max Tokens Override must be a positive integer (max 1,000,000).'));
                }
                body.max_tokens_override = lv;
            }
        }
        return body;
    },

    defaultSize: function (key) {
        // U69: 'mmlu|h' variant cards resolve to the same task default
        var bare = key.indexOf('|h') > 0 ? key.slice(0, key.indexOf('|h')) : key;
        var out = 100;
        (this.state.groups || []).forEach(function (grp) {
            grp.tasks.forEach(function (tk) {
                if (tk.key === bare) out = tk.sizes[Math.min(2, tk.sizes.length - 1)];
            });
        });
        return out;
    },

    add: async function () {
        var d = dom();
        var body;
        try { body = this.collect(); }
        catch (e) { d.toast(errText(e), 'error'); return; }
        if (!body.external && !body.model_id) {
            d.toast(t('acc_bench.config.model_placeholder', 'Select a model...'), 'error');
            return;
        }
        if (!Object.keys(body.benchmarks).length && !body._harness
            && !body._extras) {
            d.toast(t('uplift.bench.pick_tasks', 'Pick at least one benchmark'), 'error');
            return;
        }
        var rel = busyLabel(gid('bench-acc-add'));
        var harness = body._harness;
        var extras = body._extras;   // ACC-2a: local-only, upload off
        delete body._harness;
        delete body._extras;
        var posted = 0, err = null;
        try {
            if (Object.keys(body.benchmarks).length) {
                await d.postJson(api() + '/bench/accuracy/add', body);
                posted++;
            }
            if (harness) {
                await d.postJson(api() + '/bench/accuracy/add', harness);
                posted++;
            }
            if (extras) {
                await d.postJson(api() + '/bench/accuracy/add', extras);
                posted++;
            }
        } catch (e) { err = errText(e); }
        rel();
        if (posted) d.toast(t('uplift.bench.queued', 'Added to queue'));
        if (err) d.toast(err, 'error');
        if (posted) this.refreshQueue();
        // BENCHQ: Intelligence already had its own queue toast — reuse it and
        // push the GLOBAL box to the new state without waiting for the poll
        if (posted) CORE.BENCHQ.refresh();
    },

    cancelAll: async function () {
        var d = dom();
        try { await d.postJson(api() + '/bench/accuracy/cancel', {}); this.refreshQueue(); }
        catch (e) { d.toast(errText(e), 'error'); }
    },

    clearResults: async function () {
        var d = dom();
        try { await d.postJson(api() + '/bench/accuracy/results/reset', {}); this.refreshResults(); }
        catch (e) { d.toast(errText(e), 'error'); }
    },

    refreshQueue: async function () {
        var d = dom();
        try {
            var st = await d.fetchJson(api() + '/bench/accuracy/queue');
            this.state.queue = st.queue || [];
            var wasRunning = this.state.running;
            this.state.running = !!st.running;
            this.state.benchId = st.current_bench_id || null;
            this.state.boardPhase = st.phase || null;
            this.syncBoard(st);
            if (st.running) this.pollCatchup(st);
            this.renderQueue(st);
            if (st.running && !wasRunning && st.current_bench_id) this.startStream(st.current_bench_id);
            if (!st.running && wasRunning) { stopStream(); this.refreshResults(); }
        } catch (e) { /* board offline */ }
    },

    /* ACC-STALL: everything the 4s poll does while a run is live. Called
       right after syncBoard (so the entries exist) and before renderQueue
       (so a seed is visible in the same frame). */
    pollCatchup: function (st) {
        this.seedFromPoll(st);
        this.pollStatus(st);
        if (typeof st.event_count !== 'number') return;
        if (Date.now() - (this.state.armedAt || 0) < ACC_RESTART_COOLDOWN_MS) {
            this.state.pollN = st.event_count;   // observe, do not decide
            return;                               // (replay may still land)
        }
        var restart = needsStreamRestart(st.event_count, this.state.seenN,
                                         this.state.pollN);
        this.state.pollN = st.event_count;
        if (restart) this.restartStream(st);
    },

    seedFromPoll: function (st) {
        // Forward-only seeding: a poll progress that is NEWER than the live
        // bar of that suite is fed through the normal event path. Harness
        // leaf restarts (cur below the live bar) are NOT seeded — banking a
        // leaf boundary belongs to the stream or to a full replay, never to
        // a single out-of-order snapshot.
        var lp = st && st.last_progress;
        if (!lp || lp.type !== 'progress' || lp.phase !== 'eval') return false;
        if (lp.bench_current == null) return false;
        var b = lp.benchmark || (lp.data && lp.data.benchmark) || '';
        if (!b) return false;
        var run = null;
        var entries = this.state.board || [];
        for (var i = 0; i < entries.length; i++)
            if (entries[i].running) run = entries[i];
        if (!run) return false;
        var bar = (run.bar || {})[b];
        if (bar && !(lp.bench_current > bar.cur)) return false;
        this.boardEvent(lp);
        return true;
    },

    restartStream: function (st) {
        var id = st.current_bench_id || this.state.benchId;
        if (!id) return;
        var entries = this.state.board || [];
        for (var i = 0; i < entries.length; i++)
            if (entries[i].running) resetBoardEntry(entries[i],
                this.state.harnessSizes, this.state.groups);
        this.startStream(id);
    },

    pollStatus: function (st) {
        // The stream paints message + counters off events; a silent stream
        // paints the very same shape off the poll (both read one event
        // source, so the line can only move forward).
        var lp = st && st.last_progress;
        if (!lp) return;
        var node = gid('bench-acc-status');
        if (!node || node.classList.contains('bench-status-error')) return;
        var msg = String(lp.message || lp.phase || '');
        if (msg !== this.state.lastMsg) {
            this.state.lastMsg = msg;
            this.state.lastAct = Date.now();      // the board IS moving
        }
        node.textContent = msg + this.statusCounterText(lp) + this.stallSuffix();
    },

    stallSuffix: function () {
        // Honesty, not decoration: polls keep answering but nothing has
        // changed for >90s, so the frozen line says so instead of lying.
        var s = this.state;
        if (!s.running || !s.lastAct) return '';
        var idle = Date.now() - s.lastAct;
        if (idle <= ACC_STALL_MS) return '';
        return ' — ' + t('uplift.bench.board_stalled',
                         'No progress events for {n}s')
            .replace('{n}', String(Math.round(idle / 1000)));
        // NO dataset.i18n here: a {placeholder} node would repaint raw (SAY-2c)
    },

    /* U83: board entries = the RUNNING entry (new queue_status field) +
       waiting entries. Progress state (suite fill, quiet notes) survives
       re-polls by merging on model|engine — the stream mutates between. */
    syncBoard: function (st) {
        var self = this;
        var prev = this.state.board || [];
        var groups = this.state.groups;
        var mk = function (q, running) {
            var key = q.model_id + '|' + (q.engine || 'classic') + '|' +
                      Object.keys(q.sizes || {}).sort().join(',');
            var old = null;
            for (var i = 0; i < prev.length; i++)
                if (prev[i].key === key) old = prev[i];
            var qs = boardQuestions(q.sizes || {}, q.engine || 'classic',
                                   self.state.harnessSizes, groups);
            var meta = {};
            Object.keys(q.sizes || {}).forEach(function (k) {
                meta[k] = boardSuiteMeta(groups, k, self.state.extraSuites);
            });
            var e = {
                key: key, model_id: q.model_id, engine: q.engine || 'classic',
                external: !!q.external, running: !!running, sizes: q.sizes || {},
                qper: qs.per, meta: meta,
                suiteState: (old && old.suiteState) || {},
                suiteDone: (old && old.suiteDone) || {},
                suiteQuiet: (old && old.suiteQuiet) || {},
            };
            // first paint: running entry's suites are 'running' (or the
            // first is — others queued), waiting entries all queued
            if (!Object.keys(e.suiteState).length) {
                var first = true;
                Object.keys(e.sizes).forEach(function (k) {
                    e.suiteState[k] = (running && first) ? 'running' : 'queued';
                    first = false;
                });
            } else if (running && !Object.keys(e.sizes).some(function (k) {
                    return e.suiteState[k] === 'running'
                        || e.suiteState[k] === 'preparing'; })) {
                // reload/refresh between suites: the moment no bar is
                // active, the first still-queued suite IS the live one
                var nxt = Object.keys(e.sizes).filter(function (k) {
                    return e.suiteState[k] === 'queued'; })[0];
                if (nxt) e.suiteState[nxt] = 'running';
            }
            return e;
        };
        var entries = [];
        if (st.running && st.running_entry) entries.push(mk(st.running_entry, true));
        else if (st.running && st.current_model)   // old server shape: honest fallback
            entries.push(mk({ model_id: st.current_model, sizes: {} }, true));
        (st.queue || []).forEach(function (q) { entries.push(mk(q, false)); });
        this.state.board = entries;
    },

    /* stream event -> board mutation (pure data, render is separate) */
    boardEvent: function (ev) {
        var entries = this.state.board || [];
        var run = null;
        for (var i = 0; i < entries.length; i++) if (entries[i].running) run = entries[i];
        if (!run) return;
        var b = ev.benchmark || (ev.data && ev.data.benchmark) || '';
        if (ev.type === 'progress') {
            if (b) {
                if (ev.bench_total && (run.qper[b] | 0) < ev.bench_total
                        && (ev.bench_total <= (run.qper[b] | 0) * 4 || !run.qper[b]))
                    run.qper[b] = ev.bench_total;      // classic's own total wins
                if (ev.phase === 'eval' && ev.bench_current != null) {
                    // Harness suites replay 'Requesting API' once PER LEAF
                    // subtask (mmlu: 57 bars of N). A bar that restarts
                    // (cur < last cur) closed the previous leaf — bank its
                    // total. CLASSIC suites have ONE bar per suite, and a
                    // drop there is a RE-RUN, not a boundary: the runner's
                    // thinking auto-switch clears partial results and
                    // re-answers from 1 (eval/base.py run loop), and a
                    // poll-seeded snapshot followed by a stream/replay
                    // restart is the same shape data-wise. Banking would
                    // double-count the fixed dataset total (32/30 seen
                    // live) — reset the accumulator instead. (Interleaved
                    // same-suite bars do not occur in either engine's
                    // eval phase.)
                    run.bar = run.bar || {};
                    var prev = run.bar[b];
                    var acc = prev ? prev.acc : 0;
                    if (prev && ev.bench_current < prev.cur)
                        acc = run.engine === 'harness' ? acc + prev.tot : 0;
                    run.bar[b] = { cur: ev.bench_current, tot: ev.bench_total || prev && prev.tot || 0, acc: acc };
                    run.suiteDone[b] = acc + ev.bench_current;
                    run.suiteState[b] = 'running';
                    delete run.suiteQuiet[b];
                }
                else if (ev.phase === 'prepare' || ev.phase === 'download') {
                    run.suiteState[b] = 'preparing';
                    run.suiteQuiet[b] = ev.quiet_s || null;
                }
            }
        } else if (ev.type === 'result') {
            if (b) {
                run.suiteState[b] = 'done';
                var banked = run.bar && run.bar[b]
                    ? run.bar[b].acc + (run.bar[b].tot || run.bar[b].cur) : 0;
                run.suiteDone[b] = (ev.data && ev.data.total) || banked
                    || run.suiteDone[b] || 0;
                if ((run.qper[b] | 0) < run.suiteDone[b]) run.qper[b] = run.suiteDone[b];
                // next suite of THIS entry starts when classic says so;
                // board pre-marks the first still-queued box as running
                var nxt = Object.keys(run.sizes).filter(function (k) {
                    return run.suiteState[k] === 'queued'; })[0];
                if (nxt) run.suiteState[nxt] = 'running';
            }
        } else if (ev.type === 'error') {
            Object.keys(run.sizes).forEach(function (k) {
                if (run.suiteState[k] === 'running' || run.suiteState[k] === 'preparing')
                    run.suiteState[k] = 'error';
            });
        }
    },

    renderQueue: function (st) {
        var wrap = gid('bench-acc-queue');
        if (!wrap) return;
        var self = this;
        var entries = this.state.board || [];
        var empty = !st.running && !(st.queue || []).length;
        /* ACC-STALL: the queue poll now runs every 4s while a run is live.
           The SHAPE (which entries, which suite boxes, the phase chip) only
           changes at transitions, so an unchanged shape repaints the numbers
           IN PLACE (boardPaint) instead of rebuilding — rebuilding under the
           pointer killed hover, and the board was built to survive 1 Hz
           events exactly for that reason. */
        var sig = (st.phase || '') + '|' + entries.map(function (e) {
            return (e.running ? '>' : '') + e.key + '[' +
                   Object.keys(e.sizes || {}).join(',') + ']';
        }).join(';');
        if (sig === this._qSig && !(empty && !wrap.hidden)) {
            if (!empty) this.boardPaint();
            return;
        }
        this._qSig = sig;
        wrap.replaceChildren();
        if (empty) { wrap.hidden = true; return; }
        wrap.hidden = false;
        wrap.appendChild(el('div', 'bench-label',
            t('acc_bench.config.queue_label', 'Queue')));
        var d = dom();
        var skip = entries.length && entries[0].running ? 1 : 0;
        entries.forEach(function (e, idx) {
            var row = el('div', 'acc-board-entry' + (e.running ? ' running' : ''));
            row.dataset.key = e.key;
            var head = el('div', 'acc-board-head');
            head.appendChild(el('span', 'acc-board-model',
                (e.running ? '▸ ' : (idx - skip + 1) + '. ') + e.model_id +
                (e.external ? ' [' + t('acc_bench.results.external_badge', 'external') + ']' : '')));
            var eng = el('span', 'acc-board-engine ' + (e.engine === 'harness' ? 'h' : 'c'),
                t(e.engine === 'harness' ? 'uplift.bench.engine_harness'
                                         : 'uplift.bench.engine_classic',
                  e.engine === 'harness' ? 'LM-Eval' : 'oMLX Classic'));
            head.appendChild(eng);
            if (e.running && st.phase)
                head.appendChild(el('span', 'acc-board-phase', st.phase));
            else if (!e.running) {
                var rm = el('button', 'acc-queue-remove', '×');
                rm.type = 'button';
                rm.title = t('models.queue.remove_tooltip', 'Remove');
                rm.addEventListener('click', async function () {
                    try { await d.deleteJson(api() + '/bench/accuracy/queue/' + (idx - skip)); self.refreshQueue(); }
                    catch (err) { d.toast(errText(err), 'error'); }
                });
                head.appendChild(rm);
            }
            row.appendChild(head);
            var boxes = el('div', 'acc-board-suites');
            Object.keys(e.sizes).forEach(function (k) {
                boxes.appendChild(self.suiteBoxEl(e, k));
            });
            row.appendChild(boxes);
            wrap.appendChild(row);
        });
    },

    /* suite box: '[ MMLU  28/300 ]' with a left-to-right fill underlay.
       Updated IN PLACE from the stream (widths/text only) so hovering and
       scroll survive 1 Hz events. */
    suiteBoxEl: function (e, k) {
        var box = el('div', 'acc-suite st-' + (e.suiteState[k] || 'queued'));
        box.dataset.k = k;
        var fill = el('div', 'acc-suite-fill');
        var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
        fill.style.width = (e.suiteState[k] === 'done' ? 100
            : (tot ? Math.min(100, Math.round(done / tot * 100)) : 0)) + '%';
        var lab = el('span', 'acc-suite-name', (e.meta[k] && e.meta[k].label) || k);
        var cnt = el('span', 'acc-suite-count', this.suiteCountText(e, k));
        box.append(fill, lab, cnt);
        box.title = this.suiteTitle(e, k);
        return box;
    },
    suiteCountText: function (e, k) {
        var stt = e.suiteState[k] || 'queued';
        var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
        if (stt === 'done') return tot ? tot + '/' + tot : '✓';
        if (stt === 'queued') return tot ? '0/' + tot : '—';
        return tot ? done + '/' + tot : (stt === 'preparing' ? '…' : '—');
    },
    suiteTitle: function (e, k) {
        var stt = e.suiteState[k] || 'queued';
        if (stt === 'preparing') {
            var q = e.suiteQuiet[k];
            return q ? t('uplift.bench.board_preparing_quiet',
                'Preparing dataset — lm-eval silent {n}s (download/build)')
                .replace('{n}', q)
                : t('uplift.bench.board_preparing', 'Preparing dataset…');
        }
        return ({ running: t('uplift.bench.board_running', 'Running'),
                  done: t('uplift.bench.board_done', 'Done'),
                  error: t('uplift.bench.board_error', 'Error'),
                  queued: t('uplift.bench.board_queued', 'Queued') })[stt] || stt;
    },
    /* in-place repaint from the board data (no rebuild) */
    boardPaint: function () {
        var wrap = gid('bench-acc-queue');
        if (!wrap || wrap.hidden) return;
        var entries = this.state.board || [];
        var rows = wrap.querySelectorAll('.acc-board-entry');
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var r = null;
            for (var j = 0; j < rows.length; j++)
                if (rows[j].dataset.key === e.key) r = rows[j];
            if (!r) continue;
            Object.keys(e.sizes).forEach(function (k) {
                var box = r.querySelector('.acc-suite[data-k="' + k + '"]');
                if (!box) return;
                var stt = e.suiteState[k] || 'queued';
                box.className = 'acc-suite st-' + stt;
                var done = e.suiteDone[k] | 0, tot = e.qper[k] | 0;
                var pct = tot ? Math.min(100, Math.round(done / tot * 100)) : 0;
                if (stt === 'done') pct = 100;
                var f = box.querySelector('.acc-suite-fill');
                if (f) f.style.width = pct + '%';
                var c = box.querySelector('.acc-suite-count');
                if (c) c.textContent = ACC.suiteCountText(e, k);
                box.title = ACC.suiteTitle(e, k);
            });
        }
    },

    statusCounterText: function (ev) {
        // user shape: [running-suite/total-suites · done-q/total-q] over
        // the WHOLE board (both engine entries); falls back to the entry
        // fields when no board data exists (classic-page runs)
        var c = boardCounters(this.state.board || []);
        if (!c.total && ev && ev.total) {
            return ' [' + ((ev.current | 0) + 1) + '/' + ev.total + ' suites]';
        }
        if (!c.total) return '';
        var qs = c.qTotal ? ' · ' + c.qDone.toLocaleString() + '/' +
                   c.qTotal.toLocaleString() + ' q' : '';
        return ' [' + c.cur + '/' + c.total + ' suites' + qs + ']';
    },

    startStream: function (benchId) {
        var self = this;
        stopStream();
        // ACC-STALL: a replay restarts the consumed counter — events are
        // counted from index 0 again, which is exactly what the server sends
        var arm = function () {
            if (CORE._poll) clearInterval(CORE._poll);
            CORE._poll = setInterval(function () { self.refreshQueue(); },
                                 ACC_POLL_MS);
        };
        this.state.seenN = 0;
        this.state.pollN = null;
        this.state.armedAt = Date.now();    // replay quiet window (pollCatchup)
        if (!W().EventSource) { arm(); return; }
        try {
            CORE._es = new EventSource(api() + '/bench/accuracy/' + encodeURIComponent(benchId) + '/stream');
            CORE._es.onmessage = function (ev) {
                var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
                self.onEvent(data);
            };
            // U83: onerror fires when the server dies AND when a proxy
            // half-closes the socket; EventSource then retries silently,
            // so the board froze on the last event with a live queue (the
            // 'stuck' half that was NOT the harness). Interrupt visibly and
            // poll for truth: refreshQueue restarts the stream once the run
            // reappears or marks the board done when it does not.
            CORE._es.onerror = function () {
                streamInterrupted('bench-acc-status');
                arm();
            };
            // ACC-STALL: the socket can also die SILENTLY (half-open after a
            // proxy blip: no error event, no data, EventSource thinks it is
            // connected). The stream is never the only source of truth — the
            // 4s queue poll runs alongside it whenever it is open, and
            // pollCatchup decides whether the stream has to be rebuilt.
            arm();
        } catch (e) { arm(); }
    },

    onEvent: function (ev) {
        var st = gid('bench-acc-status');
        // ACC-STALL: the poll compares this counter against the server's
        // event_count to spot a stream that stopped delivering
        this.state.seenN = (this.state.seenN | 0) + 1;
        this.state.lastAct = Date.now();
        // U83: every event first mutates the board data, then the widgets
        // paint from it — counters and boxes can never disagree with each
        // other because they read the same source
        this.boardEvent(ev);
        if (ev.type === 'progress') {
            if (st) st.textContent = (ev.message || ev.phase || '') +
                this.statusCounterText(ev);
            this.state.lastMsg = String(ev.message || ev.phase || '');
            // U-PROG: the queue box fills per suite; the top bar tracks the
            // whole board (same counters the text reads from)
            var c = boardCounters(this.state.board || []);
            var denom = c.qTotal || c.total;
            if (denom) setBar('bench-acc-status',
                (c.qTotal ? c.qDone / c.qTotal : c.cur / c.total) * 100);
            this.boardPaint();
        } else if (ev.type === 'result') {
            this.boardPaint();
            this.refreshResults();
        } else if (ev.type === 'error') {
            if (st) { st.textContent = String(ev.message || 'error');
                      st.classList.add('bench-status-error'); }
            this.state.running = false;
            stopStream();
            this.boardPaint();
        } else if (ev.type === 'done') {
            if (st) st.classList.remove('bench-status-error');
            this.state.running = false;
            stopStream();
            this.refreshQueue();
            this.refreshResults();
        }
    },

    refreshResults: async function () {
        var d = dom();
        try {
            var r = await d.fetchJson(api() + '/bench/accuracy/results');
            this.state.results = r.results || [];
            this.renderResults();
        } catch (e) { /* keep last table */ }
    },

    renderResults: function () {
        var self = this;
        var wrap = gid('bench-acc-results');
        if (!wrap) return;
        var rows = this.state.results;
        if (!rows.length) { wrap.replaceChildren(); return; }
        var tbl = el('table', 'bench-table');
        var head = el('tr');
        [t('bench.config.model', 'Model'), t('acc_bench.results.category', 'Benchmark'),
         t('acc_bench.results.correct_line', '{correct} of {total} in {time}s'),
         t('acc_bench.results.total_accuracy', 'Total accuracy'),
         t('acc_bench.results.download', 'Download')].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        tbl.appendChild(head);
        rows.forEach(function (r) {
            var tr = el('tr');
            var badges = '';
            // U68: the engine word told users nothing; badge the real names
            if (r.engine === 'harness') badges += ' [' + t('uplift.bench.badge_harness', 'LM-Eval') + ']';
            else if (r.engine === 'classic') badges += ' [' + t('uplift.bench.badge_classic', 'Built-in') + ']';
            if (r.external) badges += ' [' + t('acc_bench.results.external_badge', 'external') + ']';
            if (r.thinking_used) badges += ' [' + t('acc_bench.results.thinking_badge', 'thinking') + ']';
            // fa7b454: the limit a local run used is saved with the result
            if (!r.external && r.max_tokens) badges += ' [' + t('acc_bench.results.token_limit', 'Token limit')
                + ' ' + Number(r.max_tokens).toLocaleString() + ']';
            var up = r.upload ? (r.upload.status === 'skipped' ? '—' : '↑') : '';
            // classic renders count+time through its own template string
            var line = t('acc_bench.results.correct_line', '{correct} of {total} in {time}s')
                .replace('{correct}', String(r.correct || 0))
                .replace('{total}', String(r.total || 0))
                .replace('{time}', String(r.time_s || 0));
            // 'x of y' reads exactly like classic's leaderboard copy;
            // dataset_total is the raw number beside it (no invented key)
            if (r.dataset_total) line += ' · /' + r.dataset_total.toLocaleString();
            var dlCell = el('td');
            // U70: classic's per-row Download menu (JSON/CSV/TXT in
            // classic's exact formats and classic i18n labels)
            dlCell.appendChild(dlMenu(function () {
                return String(r.model_id || 'run') + '_' + String(r.benchmark || '');
            }, [
                [function (name) { dlFile(name + '.json', 'application/json', accExportJson(r)); },
                 'acc_bench.results.download_json', 'JSON'],
                [function (name) { dlFile(name + '.csv', 'text/csv', accExportCsv(r)); },
                 'acc_bench.results.download_csv', 'CSV'],
                [function (name) { dlFile(name + '.txt', 'text/plain', accExportTxt(r)); },
                 'acc_bench.results.download_txt', 'TXT'],
            ]));
            tr.append(
                el('td', null, String(r.model_id || '')),
                el('td', null, String(r.benchmark || '')),
                el('td', null, line + (up ? ' ' + up : '')),
                el('td', null, ((r.accuracy || 0) * 100).toFixed(1) + '% ' + badges),
                dlCell);
            tbl.appendChild(tr);
        });
        // U49: Copy of the whole matrix in classic's own export format
        wrap.replaceChildren(
            resultsHead(function () {
                return buildAccuracyText(rows, self.state.groups);
            }, 'acc_bench.results.text_export.section_label',
               'Benchmark Results (Text — Copy & Paste)'),
            tbl);
    },
};

return {
    EXTRAS: EXTRAS,
    ACC_PICKS_KEY: ACC_PICKS_KEY,
    accLoadPicks: accLoadPicks,
    accSavePicks: accSavePicks,
    accValidatePicks: accValidatePicks,
    needsStreamRestart: needsStreamRestart,
    resetBoardEntry: resetBoardEntry,
    ACC: ACC
};
});
