/* Uplift About view (STATUS-SPLIT 2026-10-25): the #status/about page.
   Owns the two sections whose answers must come from the SERVING process
   (#about-software, #about-host) plus the credits list (#about-credits).
   The API Endpoints and Engine Versions sections keep their original element
   ids (#api-openai, #api-claude, #api-alias, #api-engines) and stay filled by
   uplift.js's existing renderer — the markup moved into this card, the code
   that paints it did not.
   Loads BEFORE uplift.js and talks to nothing but domkit/core, so there is no
   cross-module glue object that a later script can reassign away.
   Exports window.Uplift.about (render). */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;

/* Projects this dashboard stands on. Names are proper nouns, so the list
   needs no locale keys; the section header does. URLs are the upstreams, not
   the user's fork, and the engine rows above already link each installed
   commit — this block is the credit, not the version table. */
const CREDITS = [
    ['oMLX', 'https://github.com/jundot/omlx'],
    ['MLX', 'https://github.com/ml-explore/mlx'],
    ['MLX LM', 'https://github.com/ml-explore/mlx-lm'],
    ['MLX VLM', 'https://github.com/Blaizzy/mlx-vlm'],
    ['MLX Embeddings', 'https://github.com/Blaizzy/mlx-embeddings'],
    ['MLX Audio', 'https://github.com/Blaizzy/mlx-audio'],
    ['MarkItDown', 'https://github.com/microsoft/markitdown'],
    ['lm-evaluation-harness', 'https://github.com/EleutherAI/lm-evaluation-harness'],
    ['uPlot', 'https://github.com/leeoniya/uPlot'],
    ['GridStack', 'https://github.com/gridstack/gridstack.js'],
];

let loaded = false, inflight = false;

/* ---- row anatomy (same as the classic settings rows) ------------------- */
function urow(labelKey, labelEn, valueEl) {
    const row = document.createElement('div'); row.className = 'urow settings';
    const nm = document.createElement('span'); nm.className = 'uname';
    const sp = document.createElement('span');
    sp.dataset.i18n = labelKey; sp.textContent = C.tf(labelKey, labelEn);
    nm.append(sp);
    const diff = document.createElement('span'); diff.className = 'diffslot';
    const ctl = document.createElement('span'); ctl.className = 'gctl';
    ctl.append(valueEl);
    row.append(nm, diff, ctl);
    return row;
}
/* Every value goes through textContent — a server string is never parsed as
   HTML (shared rule with the rest of the dashboard). */
function code(txt) {
    const c = document.createElement('code');
    c.textContent = (txt === null || txt === undefined || txt === '') ? '—' : String(txt);
    return c;
}
function link(txt, url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = txt;
    return a;
}
function chip(txt) {
    const s = document.createElement('span');
    s.className = 'chip'; s.textContent = txt;
    return s;
}
function fill(id, rows) {
    const host = $(id);
    if (!host) return;
    host.replaceChildren();
    for (const r of rows) host.append(r);
}

/* ---- the three sections ------------------------------------------------- */
function renderSoftware(a) {
    const rows = [];
    const omlx = link(a.omlx_version || '—', 'https://github.com/jundot/omlx');
    rows.push(urow('uplift.about.omlx', 'oMLX engine', omlx));
    const up = link(a.uplift_version || '—', 'https://github.com/zviratko/omlx-uplift');
    rows.push(urow('uplift.about.uplift', 'Uplift', up));
    // The keg path carries the username, so this line only ever arrives on an
    // admin session (the route is gated) and it is the honest answer to
    // "which build is answering me" — dev and stable look identical here.
    const keg = document.createElement('span');
    keg.append(code(a.keg));
    if (a.dev) keg.append(' ', chip(C.tf('uplift.about.dev_build', 'dev build')));
    rows.push(urow('uplift.about.keg', 'Serving keg', keg));
    fill('about-software', rows);
}

function renderHost(a, stats) {
    const rows = [];
    if (a.chip) rows.push(urow('uplift.about.chip', 'Chip', code(a.chip)));
    if (a.ram_bytes) rows.push(urow('uplift.about.ram', 'Memory', code(C.fmtBytes(a.ram_bytes))));
    const os = [a.macos_version, a.arch].filter(Boolean).join(' · ');
    rows.push(urow('uplift.about.macos', 'macOS', code(os)));
    rows.push(urow('uplift.about.python', 'Python', code(a.python_version)));
    if (a.model_dir) rows.push(urow('uplift.about.model_dir', 'Model folder', code(a.model_dir)));
    if (stats && stats.host) {
        const port = stats.port ? ':' + stats.port : '';
        rows.push(urow('uplift.about.address', 'Server address', code(stats.host + port)));
    }
    if (stats && stats.uptime_seconds)
        rows.push(urow('uplift.about.uptime', 'Uptime', code(C.fmtDuration(stats.uptime_seconds))));
    fill('about-host', rows);
}

function renderCredits() {
    const host = $('about-credits');
    if (!host) return;
    host.replaceChildren();
    for (const [name, url] of CREDITS) {
        const row = document.createElement('div'); row.className = 'urow settings';
        const nm = document.createElement('span'); nm.className = 'uname';
        nm.append(link(name, url));
        row.append(nm, document.createElement('span'), document.createElement('span'));
        host.append(row);
    }
    const note = document.createElement('p');
    note.className = 'hint';
    note.dataset.i18n = 'uplift.about.credits_hint';
    note.textContent = C.tf('uplift.about.credits_hint',
        'Uplift is an add-on: the inference engine, its models and the charts above all come from these projects.');
    host.append(note);
}

/* ---- load --------------------------------------------------------------- */
async function load() {
    // Both answers come from the serving process; vanilla's stats route owns
    // host/port/uptime, ours owns versions and hardware. Either failing must
    // not blank the other half, so they are settled independently.
    const [about, stats] = await Promise.all([
        D.fetchJson(`${API}/uplift/api/about`).catch(() => null),
        D.fetchJson(`${API}/admin/api/stats`).catch(() => null),
    ]);
    if (about) renderSoftware(about);
    renderHost(about || {}, stats || {});
    renderCredits();
    loaded = true;
}

function render() {
    if (!document.getElementById('about-software')) return;
    renderCredits();                      // static, always correct on entry
    if (loaded || inflight) return;       // one fetch per page load (UPLIFT-1)
    inflight = true;
    load().catch(() => {}).then(() => { inflight = false; });
}

window.Uplift = window.Uplift || {};
window.Uplift.about = { render: render, CREDITS: CREDITS };
})();
