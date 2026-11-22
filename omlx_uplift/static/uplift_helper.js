/* Uplift HELPER MODELS page + stored-settings prune dialog (PH2-1 stage
   9c extraction from uplift.js): helper/markitdown listing with the
   integration editors (CLI assistants, web search + test), device info,
   and the orphan/profile prune flow merged into Models. Plain script;
   loads AFTER uplift_state.js + uplift_modelmgr.js, BEFORE uplift.js,
   which late-binds shared helpers via window.Uplift._helperGlue (GW_LIVE
   mutable -> getter). MM (modelmgr export) is a stable module object —
   openInspector/adminModels resolve directly. Exports
   window.Uplift.helper {renderHelperModels}; applyTab consumes it. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
/* TST-1: the integration payload contract ships in uplift_gspec.js
   (UMD); the export below keeps it visible for tests. */
const INTEG_PREFIXED = window.UpliftGSpec.INTEG_PREFIXED;
const MM = window.Uplift.modelmgr;
/* Classic's splashPath machine (dashboard.js:236) must survive the panel's
   re-renders: the path editor is open/closed/draft state, not server state.
   A successful apply or a Cancel clears it. */
let _splashUI = { editing: false, draft: '', error: '', saving: false };
const HG = {
    fetchJson: D.fetchJson,
    postJson: D.postJson,
    toast: D.toast,
    cell: D.cell,
    emptyMsg: D.emptyMsg,
    get GW_LIVE() { return window.Uplift._helperGlue.GW_LIVE; },
};
/* ------- stored settings: prune dialog (the list merged into Models) ---- */

async function openPruneDialog() {
    let orphans = [], profs = [];
    try {
        const idx = await HG.fetchJson(`${API}/admin/api/model-settings-index`);
        S.settingsIdx = idx;
        orphans = idx.orphans || [];
        // round 4: profiles of orphaned bases AND of models that stay on
        // disk but whose profiles were left behind are all prune candidates
        const known = new Set(MM.adminModels.map(m => m.id));
        profs = (idx.profiles || []).filter(p => !known.has(p.base)
            || orphans.includes(p.base));
    } catch (err) { HG.toast(C.tf('uplift.helper.prune_check_fail', 'prune check failed: ') + D.errText(err)); return; }
    if (!orphans.length && !profs.length) { HG.toast(C.t('uplift.toast.nothing_to_prune')); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = `Prune model settings (${orphans.length + profs.length})`;
    const sub = document.createElement('div');
    sub.className = 'se-hint';
    sub.textContent = C.tf('uplift.ui.stored_configuration_for_models_that_no_longer_e', 'Stored settings for models that no longer exist on disk.') + ' '
        + C.tf('uplift.ui.profiles_shown_as_base_name', 'Profiles appear as "model:profile". ')
        + (HG.GW_LIVE
            ? 'Removed entries are deleted from this server\'s model_settings.json.'
            : 'Removed entries are deleted from the sandbox model_settings.json.');
    const list = document.createElement('div');
    list.className = 'prune-list';
    const checks = [];
    for (const id of orphans) {
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = id; cb.dataset.kind = 'model';
        lbl.append(cb, HG.cell(id));
        list.append(lbl);
        checks.push(cb);
    }
    for (const p of profs) {
        // profile of an orphaned base is covered by deleting the base record;
        // show it anyway (user must see what goes), uncheckable individually
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = p.name;
        cb.dataset.base = p.base; cb.dataset.kind = 'profile';
        lbl.append(cb, HG.cell(p.base + ':' + (p.display_name || p.name)));
        list.append(lbl);
        checks.push(cb);
    }
    const bar = document.createElement('div');
    bar.className = 'row buttons';
    const all = document.createElement('button');
    all.textContent = C.tf('uplift.ui.select_all', 'Select all');
    all.onclick = () => checks.forEach(c => c.checked = true);
    const none = document.createElement('button');
    none.textContent = C.tf('uplift.ui.select_none', 'Select none');
    none.onclick = () => checks.forEach(c => c.checked = false);
    const cancel = document.createElement('button');
    cancel.textContent = C.tf('uplift.layout.cancel', 'Cancel');
    cancel.onclick = () => overlay.remove();
    const doIt = document.createElement('button');
    doIt.className = 'danger';
    doIt.textContent = C.tf('uplift.ui.prune_selected', 'Prune selected');
    doIt.onclick = async () => {
        const sel = checks.filter(c => c.checked);
        const ids = sel.filter(c => c.dataset.kind === 'model').map(c => c.value);
        // profiles whose base record is also selected die with it (the
        // server's delete_settings drops both); a second delete_profile for
        // them is a harmless no-op, so send every checked profile anyway
        const idSet = new Set(ids);
        const profSel = sel.filter(c => c.dataset.kind === 'profile'
            && !idSet.has(c.dataset.base))
            .map(c => ({ base: c.dataset.base, name: c.value }));
        if (!ids.length && !profSel.length) { HG.toast(C.t('uplift.toast.nothing_selected')); return; }
        try {
            const r = await HG.postJson(`${API}/admin/api/prune-model-settings`,
                { ids, profiles: profSel });
            HG.toast(C.tf('uplift.helper.pruned', 'Pruned {n} setting record(s)', { n: r.removed.length })
                + (r.removed_profiles && r.removed_profiles.length
                    ? ', ' + C.tf('uplift.helper.pruned_profiles', '{n} profile(s)', { n: r.removed_profiles.length }) : ''));
            overlay.remove();
            MM.render(true);
        } catch (err) { HG.toast(C.tf('uplift.helper.prune_fail', 'prune failed: ') + D.errText(err)); }
    };
    bar.append(all, none, document.createElement('span'), cancel, doIt);
    box.append(h, sub, list, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    // Escape is handled by the global modal handler (uplift_state.js)
    document.body.append(overlay);
}
$('btn-prune').onclick = openPruneDialog;




/* ---------------- models sub-page: helper models -------- */
/* used_by resolver: overlay route provides row.used_by; vanilla rows lack
   it but carry their full settings dict — derive the reverse map here so
   the page works identically against a vanilla upstream. */
function usedBy(m) {
    if (Array.isArray(m.used_by)) return m.used_by;
    const users = new Set();
    for (const x of MM.adminModels || []) {
        if (x.id === m.id) continue;
        const s = x.settings || {};
        for (const k of ['specprefill_draft_model', 'dflash_draft_model',
                         'vlm_mtp_draft_model'])
            if (s[k] === m.id) users.add(x.id);
    }
    return [...users].sort();
}

async function renderHelperModels() {
    let models;
    // DEAD-1: prefer the uplift overlay — its used_by is derived
    // SERVER-side from stored settings and resolves model_path /
    // source_repo_id aliases the client fallback below misses. Full
    // /uplift/api/ path on purpose: /admin/api/models collides with
    // vanilla (registration order — vanilla wins, no used_by). If the
    // overlay is unreachable (older server), fall back to the vanilla
    // list; usedBy() then derives client-side as before.
    try { models = (await HG.fetchJson(`${API}/uplift/api/models`)).models; }
    catch (_) {
        try { models = (await HG.fetchJson(`${API}/admin/api/models`)).models; }
        catch (e) { HG.emptyMsg($('hm-list'), D.errText(e)); return; }
    }
    const mk = models.filter(m => m.engine_type === 'markitdown' || m.model_type === 'markitdown');
    const helpers = models.filter(m => !mk.includes(m) && (m.is_helper ||
        /dflash|assistant/i.test(m.id)));
    $('hm-sub').textContent = `${helpers.length} helpers · ${mk.length} markitdown`;
    $('hm-sub').dataset.count = helpers.length;

    // Integrations, same fields / labels / conditionals as the classic
    // Settings -> Integrations tab. MarkItDown gets the special box at the
    // top (separate role gets separate space), then Web Search, then the
    // helper model list.
    const box = $('hm-markitdown');
    box.textContent = '';
    let integ = {}, ccSec = {}, stats = {}, eng = {};
    let modelList = [];
    try {
        const gs = await HG.fetchJson(`${API}/admin/api/global-settings`);
        integ = gs.integrations || {};
        // the Splash launcher state rides the same GET (routes.py
        // _splash_status): available/path/auto_detected/reason/label/version
        eng = (gs.external_engines || {}).splash || {};
        ccSec = gs.claude_code || {};     // UP-26(2): the env-command half
    } catch (_) {}
    // UP-26(2): classic renders launch commands from stats (cli_prefix,
    // host, port, api_key — dashboard.js:4231/3832/3838, /admin/api/stats
    // carries all four); one extra GET, honest degradation on a miss.
    try { stats = await HG.fetchJson(`${API}/admin/api/stats`) || {}; } catch (_) {}
    modelList = models;

    // save exactly like classic saveIntegrationSettings(): flat body where
    // ONLY the CLI-assistant keys carry the integrations_ prefix; markitdown_*
    // and web_search_* are sent bare (real oMLX drops unknown fields with a
    // silent success:true, so a blanket prefix looked saved but did nothing).
    async function saveIntegrationErr(overrides) {
        Object.assign(integ, overrides || {});
        const body = {};
        for (const [k, v] of Object.entries(integ))
            body[INTEG_PREFIXED.has(k) ? 'integrations_' + k : k] = v;
        try {
            const res = await HG.postJson(`${API}/admin/api/global-settings`, body);
            if (res.success === false) throw new Error(res.message || 'rejected');
            return '';
        } catch (err) { return D.errText(err); }
    }
    async function saveIntegration(overrides) {
        const err = await saveIntegrationErr(overrides);
        if (err) { HG.toast(C.t('uplift.toast.save_failed', {msg: err})); return false; }
        HG.toast(C.t('uplift.toast.integration_saved'));
        return true;
    }
    function integField(label, hint, control) {
        const f = document.createElement('label');
        f.className = 'field';
        const lab = document.createElement('span');
        lab.textContent = label;
        f.append(lab, control);
        if (hint) {
            const h = document.createElement('small');
            h.className = 'fhint dim'; h.textContent = hint;
            f.append(h);
        }
        return f;
    }
    function integSelect(opts, val, onchange) {
        const sel = document.createElement('select');
        for (const [v, t] of opts) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            sel.append(o);
        }
        sel.value = val;
        sel.onchange = () => onchange(sel.value);
        return sel;
    }
    function integNumber(key, min, max) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = min; inp.max = max;
        inp.value = integ[key] ?? '';
        inp.onchange = async () => {
            const v = Number(inp.value);
            if (await saveIntegration({ [key]: v })) renderHelperModels();
        };
        return inp;
    }

    /* ---- MarkItDown box ---- */
    const mkCard = document.createElement('div');
    mkCard.className = 'mk-box';
    const head = document.createElement('div');
    head.className = 'mk-head';
    const title = document.createElement('div');
    title.className = 'mk-title';
    title.textContent = 'MarkItDown';
    head.append(title);
    for (const m of mk) {
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : 'off');
        state.textContent = m.loaded ? 'LOADED' : 'IDLE';
        head.append(state);
    }
    mkCard.append(head);
    const mkGrid = document.createElement('div');
    mkGrid.className = 'mk-fields';

    const enabledInp = document.createElement('input');
    enabledInp.type = 'checkbox';
    enabledInp.checked = !!integ.markitdown_enabled;
    enabledInp.onchange = async () => {
        if (await saveIntegration({ markitdown_enabled: enabledInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Enable MarkItDown',
        'Preprocess supported file attachments before LLM requests.', enabledInp));

    const exposeInp = document.createElement('input');
    exposeInp.type = 'checkbox';
    exposeInp.checked = !!integ.markitdown_expose_model;
    exposeInp.disabled = !integ.markitdown_enabled;
    exposeInp.onchange = async () => {
        if (await saveIntegration({ markitdown_expose_model: exposeInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Show as model',
        'Expose MarkItDown in model lists for direct Markdown conversion requests.', exposeInp));

    mkGrid.append(integField('Max file size (MB)',
        'Reject larger document attachments before conversion.',
        integNumber('markitdown_max_file_size_mb', 1, 1024)));
    mkGrid.append(integField('Max files per request',
        'Limit document attachments converted in one request.',
        integNumber('markitdown_max_files_per_request', 1, 50)));

    // pdf engine: MarkItDown + OCR-capable models (classic: config_model_type contains 'ocr')
    const pdfOpts = [['markitdown', 'MarkItDown']];
    for (const m of modelList)
        if (String(m.config_model_type || '').toLowerCase().includes('ocr'))
            pdfOpts.push([m.id, m.id]);
    const pdfSel = integSelect(pdfOpts, integ.markitdown_pdf_processing_engine || 'markitdown',
        async v => { if (await saveIntegration({ markitdown_pdf_processing_engine: v })) renderHelperModels(); });
    const pdfField = integField('PDF processing engine',
        'Process PDF requests by MarkItDown itself or by an OCR engine.', pdfSel);
    if (integ.markitdown_pdf_processing_engine === 'markitdown') {
        const warn = document.createElement('small');
        warn.className = 'fhint warn';
        // classic ships this as ONE catalog sentence; do not split it into
        // an uplift copy + hardcoded tail (a later classic extension then
        // truncates our mirror).
        warn.textContent = C.tf('settings.integrations.markitdown.pdf_processing_markitdown_warning',
            'Scanned or image-only PDFs will fail when MarkItDown is selected, and PDFs with tables may not be processed correctly.');
        pdfField.append(warn);
    }
    mkGrid.append(pdfField);
    mkCard.append(mkGrid);
    box.append(mkCard);

    /* ---- CLI assistants (classic binds these on the Status launcher;
       Uplift edits them where integrations live). Keys save with the
       integrations_ prefix exactly like saveIntegrationSettings(). ---- */
    const cliCard = document.createElement('div');
    cliCard.className = 'mk-box';
    const cliHead = document.createElement('div');
    cliHead.className = 'mk-head';
    const cliTitle = document.createElement('div');
    cliTitle.className = 'mk-title';
    cliTitle.textContent = C.tf('uplift.ui.cli_assistants', 'CLI Assistants');
    const cliHint = document.createElement('small');
    cliHint.className = 'dim';
    cliHint.textContent = 'Model each launched CLI assistant defaults to (blank = ask every launch).';
    cliHead.append(cliTitle, cliHint);
    /* UP-26(2) ROUND 2, grouped (user 2026-11-01: "coding assistants should
       be grouped with their settings and the copy button; current layout
       makes no sense"): ONE row per assistant - name | its model default
       (+ OpenClaw's tools profile) | its ready-to-paste command(s), each
       with its own copy button. The old split (a picker grid here, an
       'Applications' command list below) made the reader correlate two
       lists by hand. Pure templating stays in uplift_gspec.js
       (launchCommand / claudeCodeCommand). */
    const GSPEC = window.UpliftGSpec;
    const cliPick = (key) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.spellcheck = false;
        inp.setAttribute('list', 'cli-models');
        inp.value = integ[key] || '';
        inp.placeholder = 'Ask every launch';
        inp.onchange = async () => { await saveIntegration({ [key]: inp.value || null }); };
        return inp;
    };
    // SYNC-1 fire 18 (upstream 579db64 #5055): a command may carry a masked
    // DISPLAY variant (the Claude Code auth token). The <code> text AND its
    // title show `display`; the copy button still copies the real `cmd`.
    const cmdLine = (cmd, display) => {
        const shown = display === undefined ? cmd : display;
        const line = document.createElement('div'); line.className = 'up-appcmd';
        const code = document.createElement('code'); code.textContent = shown;
        code.title = shown;
        const cp = document.createElement('button');
        cp.type = 'button'; cp.className = 'se-btn act';
        cp.textContent = '\u29C9';   // ⧉, same idiom as the API-endpoints card
        cp.title = C.tf('status.integrations.copy_command_tooltip', 'Copy command');
        cp.onclick = () => {
            const flash = () => { cp.textContent = '\u2713';
                setTimeout(() => { cp.textContent = '\u29C9'; }, 2000); };
            if (navigator.clipboard && navigator.clipboard.writeText)
                navigator.clipboard.writeText(cmd).then(flash).catch(flash);
            else flash();
        };
        line.append(code, cp);
        return line;
    };
    const cliRows = document.createElement('div');
    cliRows.className = 'cli-rows';
    const cliRow = (name, ctls, cmds) => {
        const row = document.createElement('div'); row.className = 'cli-row';
        const nm = document.createElement('div'); nm.className = 'cli-name';
        nm.textContent = name;
        const ctl = document.createElement('div'); ctl.className = 'cli-ctl';
        if (ctls && ctls.length) ctl.append(...ctls);
        else {   // an assistant with nothing to configure: an honest dash
            const d = document.createElement('div'); d.className = 'cli-dash';
            d.textContent = '\u2014'; ctl.append(d);
        }
        const cb = document.createElement('div'); cb.className = 'cli-cmds';
        for (const c of cmds)
            cb.append(typeof c === 'string' ? cmdLine(c) : cmdLine(c.cmd, c.display));
        row.append(nm, ctl, cb);
        cliRows.append(row);
    };
    // model datalist for the assistant pickers
    const cliDl = document.createElement('datalist'); cliDl.id = 'cli-models';
    for (const m of modelList) {
        const o2 = document.createElement('option'); o2.value = m.id || m.name || ''; cliDl.append(o2);
    }
    const ccConn = { host: stats.host, port: stats.port, apiKey: stats.api_key };
    cliRow(C.tf('status.integrations.claude_code', 'Claude Code'), null,
        [{ cmd: GSPEC.claudeCodeCommand(ccSec, ccConn),
           display: GSPEC.claudeCodeCommand(ccSec, ccConn, { mask: true }) },
         GSPEC.launchCommand('claude', { cliPrefix: stats.cli_prefix })]);
    cliRow('GitHub Copilot', [cliPick('copilot_model')],
        [GSPEC.launchCommand('copilot', { cliPrefix: stats.cli_prefix })]);
    cliRow('Codex', [cliPick('codex_model')],
        [GSPEC.launchCommand('codex', { cliPrefix: stats.cli_prefix }),
         GSPEC.launchCommand('codex_app', { cliPrefix: stats.cli_prefix })]);
    cliRow(C.tf('status.integrations.opencode', 'OpenCode'), [cliPick('opencode_model')],
        [GSPEC.launchCommand('opencode', { cliPrefix: stats.cli_prefix })]);
    cliRow(C.tf('status.integrations.openclaw', 'OpenClaw'),
        [cliPick('openclaw_model'),
         integField('Tools profile', 'Tool set the launcher passes to openclaw.',
             integSelect([['minimal','Minimal'],['coding','Coding'],['messaging','Messaging'],['full','Full']],
                         integ.openclaw_tools_profile || 'coding',
                         v => saveIntegration({ openclaw_tools_profile: v })))],
        [GSPEC.launchCommand('openclaw', { cliPrefix: stats.cli_prefix,
            toolsProfile: integ.openclaw_tools_profile })]);
    cliRow(C.tf('status.integrations.hermes_agent', 'Hermes Agent'), [cliPick('hermes_model')],
        [GSPEC.launchCommand('hermes', { cliPrefix: stats.cli_prefix })]);
    cliRow(C.tf('status.integrations.pi', 'Pi'), [cliPick('pi_model')],
        [GSPEC.launchCommand('pi', { cliPrefix: stats.cli_prefix })]);
    cliRow(C.tf('status.integrations.vibe', 'Mistral Vibe'), [cliPick('vibe_model')],
        [GSPEC.launchCommand('vibe', { cliPrefix: stats.cli_prefix,
            model: integ.vibe_model })]);
    cliRow(C.tf('status.integrations.dsh', 'DeepSeek Harness'), [cliPick('dsh_model')],
        [GSPEC.launchCommand('dsh', { cliPrefix: stats.cli_prefix })]);
    const cliNote = document.createElement('p');
    cliNote.className = 'native-stub-note';
    cliNote.textContent = C.tf('uplift.helper.launch_hint',
        'Ready-to-paste commands (classic parity): env-prefix form points Claude Code at this server; the launch form loads the assistant with its assigned model.');
    cliNote.dataset.i18n = 'uplift.helper.launch_hint';
    cliNote.dataset.en = cliNote.textContent;             // U59 repair
    cliCard.append(cliHead, cliDl, cliNote, cliRows);
    box.append(cliCard);

    /* ---- Web Search ---- */
    const wsCard = document.createElement('div');
    wsCard.className = 'mk-box';
    const wsHead = document.createElement('div');
    wsHead.className = 'mk-head';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'mk-title';
    wsTitle.textContent = C.tf('uplift.ui.web_search', 'Web Search');
    wsHead.append(wsTitle);
    const wsGrid = document.createElement('div');
    wsGrid.className = 'mk-fields';

    const provSel = integSelect([
        ['ddgs', 'DDGS Total'], ['ddgs_custom', 'DDGS Custom'],
        ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'],
        ['searxng', 'SearXNG'],
    ], integ.web_search_provider || 'ddgs', async v => {
        if (await saveIntegration({ web_search_provider: v })) renderHelperModels();
    });
    wsGrid.append(integField('Search provider',
        'Backend used by the chat web search tool. DDGS Total queries every available engine and needs no key.',
        provSel));

    if (integ.web_search_provider === 'ddgs_custom') {
        const be = document.createElement('input');
        be.type = 'text';
        be.placeholder = 'e.g. duckduckgo,brave,mojeek';
        be.value = integ.web_search_ddgs_backends || '';
        be.onchange = async () => {
            if (await saveIntegration({ web_search_ddgs_backends: be.value })) renderHelperModels();
        };
        wsGrid.append(integField('Search engines',
            'Comma-separated engines to query. All of these work without an API key.', be));
    }
    if (integ.web_search_provider === 'brave') {
        const key = document.createElement('input');
        key.type = 'password';
        key.placeholder = 'BSA…';
        key.value = integ.web_search_brave_api_key || '';
        key.onchange = async () => {
            if (await saveIntegration({ web_search_brave_api_key: key.value })) renderHelperModels();
        };
        wsGrid.append(integField('Brave API key',
            'Subscription token from the Brave Search API dashboard. Stored locally, never echoed.', key));
    }
    if (integ.web_search_provider === 'searxng') {
        const url = document.createElement('input');
        url.type = 'text';
        url.placeholder = 'http://127.0.0.1:8080';
        url.value = integ.web_search_searxng_url || '';
        url.onchange = async () => {
            if (await saveIntegration({ web_search_searxng_url: url.value })) renderHelperModels();
        };
        wsGrid.append(integField('SearXNG instance URL',
            'Base URL of a SearXNG instance with the JSON output format enabled.', url));
    }

    wsGrid.append(integField('Results per search',
        'How many sources one web_search call returns (1-10).',
        integNumber('web_search_max_results', 1, 10)));

    const modeSel = integSelect([
        ['snippet', 'Snippets only'], ['full', 'Full page content'],
    ], integ.web_search_content_mode || 'snippet', async v => {
        if (await saveIntegration({ web_search_content_mode: v })) renderHelperModels();
    });
    wsGrid.append(integField('Result content',
        'Snippets keep the prompt small. Full page content fetches and inlines each result page.',
        modeSel));

    if (integ.web_search_content_mode === 'full') {
        const tr = document.createElement('input');
        tr.type = 'checkbox';
        tr.checked = !!integ.web_search_content_truncate;
        tr.onchange = async () => {
            if (await saveIntegration({ web_search_content_truncate: tr.checked })) renderHelperModels();
        };
        wsGrid.append(integField('Truncate page content',
            'Cut each fetched page at the limit below. Turning this off can flood the model context.', tr));
        if (integ.web_search_content_truncate) {
            wsGrid.append(integField('Content limit (chars)',
                'Maximum characters kept per fetched page.',
                integNumber('web_search_content_max_chars', 500, 200000)));
        }
    }

    // Test search: classic uses the real API; through the gateway it hits the real backend read-only.
    const testRow = document.createElement('div');
    testRow.className = 'row buttons';
    const testBtn = document.createElement('button');
    testBtn.className = 'se-btn';
    testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    const testOut = HG.cell('');
    testOut.className = 'dim';
    testBtn.onclick = async () => {
        testBtn.disabled = true; testBtn.textContent = C.tf('uplift.patches.testing', 'Testing…');
        try {
            // Classic contract (dashboard.js testWebSearch): the endpoint tests
            // the PENDING form values and 422s without a JSON body. This page
            // autosaves every change, so last-loaded `integ` + live controls
            // ARE the pending state.
            const pickVal = ph => { const el = [...wsGrid.querySelectorAll('input')]
                    .find(i => i.placeholder === ph); return el ? el.value : ''; };
            const body = {
                provider: provSel.value || integ.web_search_provider || 'ddgs',
                brave_api_key: pickVal('BSA…') || integ.web_search_brave_api_key || '',
                searxng_url: pickVal('http://127.0.0.1:8080') || integ.web_search_searxng_url || '',
                ddgs_backends: pickVal('e.g. duckduckgo,brave,mojeek') || integ.web_search_ddgs_backends || '',
                max_results: Number(integ.web_search_max_results) || 5,
            };
            const r = await HG.fetchJson(`${API}/admin/api/web-search/test`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body) });
            const errBody = r.error || {};
            testOut.textContent = r.ok
                ? `Search OK: ${(r.results || []).length} results`
                : ('Search test failed: ' + (D.errText(errBody.message || '') || 'unknown'));
        } catch (err) {
            testOut.textContent = C.tf('uplift.ui.search_test_failed', 'Search test failed: ') + D.errText(err);
        }
        testBtn.disabled = false; testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    };
    testRow.append(testBtn, testOut);
    testRow.className = 'mk-row';
    wsGrid.append(testRow);
    wsCard.append(wsHead, wsGrid);
    box.append(wsCard);

    /* ---- External engines: classic's Splash card (SYNC-1 run 27 parity).
       Availability rides the GS GET (external_engines.splash); saves are
       SILENT like classic's saveIntegrationSettings (inline error line, no
       toast), and a path apply re-fetches so the detected state repaints
       from the server truth (classic: loadGlobalSettings + loadModels).
       Labels copy classic's EN verbatim - this panel's call-site style. ---- */
    async function applySplashPath(path) {
        _splashUI.saving = true; _splashUI.error = '';
        const previous = integ.splash_path;
        const err = await saveIntegrationErr(
            { splash_path: (path || '').trim() || null });
        if (err) {
            integ.splash_path = previous;
            _splashUI.error = err;
        } else {
            _splashUI.editing = false;
        }
        _splashUI.saving = false;
        renderHelperModels();
    }
    const exCard = document.createElement('div');
    exCard.className = 'mk-box';
    const exHead = document.createElement('div'); exHead.className = 'mk-head';
    const exTitle = document.createElement('div'); exTitle.className = 'mk-title';
    exTitle.textContent = 'External engines';
    const exChip = document.createElement('span');
    exChip.className = 'spill ' + (eng.available ? 'on' : 'off');
    exChip.textContent = 'Splash';
    exHead.append(exTitle, exChip);
    const exDesc = document.createElement('small'); exDesc.className = 'fhint dim';
    exDesc.textContent = 'Serve a model with another inference engine running in ' +
        'its own process. Choose the engine per model in Model Settings \u2192 Advanced.';
    const exGrid = document.createElement('div'); exGrid.className = 'mk-fields';
    const optErr = document.createElement('small');
    optErr.className = 'fhint warn';

    // binary row: detected state, or the path editor (classic splashPath)
    const binField = document.createElement('div');
    binField.className = 'field';
    const binLab = document.createElement('span');
    binLab.textContent = 'Splash';
    binField.append(binLab);
    if (eng.available && !_splashUI.editing) {
        const p = document.createElement('small'); p.className = 'fhint dim';
        p.textContent = eng.path || '';
        const h = document.createElement('small'); h.className = 'fhint dim';
        h.textContent = eng.auto_detected ? 'Found automatically.' : 'Set by path.';
        const ctl = document.createElement('div'); ctl.className = 'row buttons';
        const badge = document.createElement('span'); badge.className = 'spill on';
        badge.textContent = ((eng.label || 'Splash') + ' ' + (eng.version || '')).trim();
        const change = document.createElement('button');
        change.type = 'button'; change.className = 'se-btn';
        change.textContent = 'Change';
        change.onclick = () => {
            _splashUI.draft = integ.splash_path || eng.path || '';
            _splashUI.error = ''; _splashUI.editing = true;
            renderHelperModels();
        };
        ctl.append(badge, change);
        binField.append(ctl, p, h);
    } else {
        const h = document.createElement('small'); h.className = 'fhint dim';
        h.textContent = 'Path to the splash or splash-m1 launcher. Install it ' +
            'with brew install incoai/tap/splash (M3 or later), or splash-m1 ' +
            'on M1/M2 Macs.';
        binField.append(h);
        if (!eng.available && eng.reason) {
            const rs = document.createElement('small'); rs.className = 'fhint warn';
            rs.textContent = eng.reason;
            binField.append(rs);
        }
        if (_splashUI.error) {
            const er = document.createElement('small'); er.className = 'fhint warn';
            er.textContent = _splashUI.error;
            binField.append(er);
        }
        const ctl = document.createElement('div'); ctl.className = 'row buttons';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = '/opt/homebrew/bin/splash';
        inp.value = _splashUI.draft;
        inp.oninput = () => { _splashUI.draft = inp.value; };
        const apply = document.createElement('button');
        apply.type = 'button'; apply.className = 'se-btn';
        apply.textContent = 'Apply';
        apply.disabled = _splashUI.saving || !_splashUI.draft.trim();
        apply.onclick = () => applySplashPath(inp.value);
        ctl.append(inp, apply);
        if (integ.splash_path) {
            const auto = document.createElement('button');
            auto.type = 'button'; auto.className = 'se-btn';
            auto.textContent = 'Detect automatically';
            auto.disabled = _splashUI.saving;
            auto.onclick = () => applySplashPath('');
            ctl.append(auto);
        }
        if (_splashUI.editing) {
            const cancel = document.createElement('button');
            cancel.type = 'button'; cancel.className = 'se-btn';
            cancel.textContent = 'Cancel';
            cancel.onclick = () => {
                _splashUI.editing = false; _splashUI.error = '';
                renderHelperModels();
            };
            ctl.append(cancel);
        }
        binField.append(ctl);
    }
    exGrid.append(binField);

    exGrid.append(integField('KV cache precision',
        'int8 holds about twice the context of bf16 in the same memory.',
        integSelect([['int8', 'int8'], ['bf16', 'bf16']],
            integ.splash_kv_format || 'int8',
            async v => { optErr.textContent =
                await saveIntegrationErr({ splash_kv_format: v }); })));
    exGrid.append(integField('Activation precision',
        'bf16 keeps attention in bf16 on M5 and later; auto lets Splash use ' +
        'int8 where it is faster. Applies to Splash 1.6.1 and later.',
        integSelect([['bf16', 'bf16'], ['auto', 'auto']],
            integ.splash_activations || 'bf16',
            async v => { optErr.textContent =
                await saveIntegrationErr({ splash_activations: v }); })));

    // GB size rows: empty means automatic; a rejected value rolls the field
    // back so later saves keep working (classic saveSplashSize)
    function splashNumber(key, minimum) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = minimum;
        inp.value = integ[key] ?? '';
        inp.placeholder = 'Auto';
        inp.onchange = async () => {
            const previous = integ[key];
            const raw = String(inp.value).trim();
            const value = raw === '' ? null : Number(raw);
            let error = '';
            if (value !== null && !(value >= minimum))
                error = 'Enter a size in GB, or leave the field empty for automatic.';
            else error = await saveIntegrationErr({ [key]: value });
            if (error) { integ[key] = previous; inp.value = previous ?? ''; }
            optErr.textContent = error;
        };
        const wrap = document.createElement('div'); wrap.className = 'row buttons';
        const unit = document.createElement('small'); unit.className = 'fhint dim';
        unit.textContent = 'GB';
        wrap.append(inp, unit);
        return wrap;
    }
    exGrid.append(integField('Memory limit',
        'Empty gives Splash enough for the model\'s full context window. A ' +
        'larger limit gives its prefix cache more room; on a smaller Mac ' +
        'Splash fits a shorter context to the memory left. oMLX counts the ' +
        'memory Splash plans against its own limit.',
        splashNumber('splash_max_memory_gb', 1)));
    const ssdField = integField('SSD cache',
        'Splash\'s own prefix cache in the oMLX SSD cache folder, kept across ' +
        'restarts. Empty uses the oMLX SSD cache size and 0 turns it off. ' +
        'Needs the oMLX SSD cache.',
        splashNumber('splash_ssd_cache_gb', 0));
    const ssdWarn = document.createElement('small'); ssdWarn.className = 'fhint warn';
    ssdWarn.textContent = 'Applies to each Splash model, and a model\'s cache ' +
        'stays after it unloads, so the total can grow to this size times the ' +
        'number of Splash models you use. Set a size when you use more than one.';
    ssdField.append(ssdWarn);
    exGrid.append(ssdField);

    const aneInp = document.createElement('input'); aneInp.type = 'checkbox';
    aneInp.checked = !!integ.splash_ane_prefill;
    aneInp.onchange = async () => {
        optErr.textContent =
            await saveIntegrationErr({ splash_ane_prefill: aneInp.checked });
    };
    exGrid.append(integField('Neural Engine prefill',
        'Let Splash run part of long prompts on the Neural Engine when that ' +
        'is faster.', aneInp));
    exGrid.append(optErr);
    exCard.append(exHead, exDesc, exGrid);
    box.append(exCard);

    $('hm-sub').textContent = `${helpers.length} helpers · integrations editable${HG.GW_LIVE ? ' (live)' : ' (shadow)'}`;
    $('hm-sub').dataset.count = helpers.length;

    const host = $('hm-list');
    host.textContent = '';
    if (!helpers.length) { D.emptyMsg(host, C.t('uplift.helper.none')); return; }
    for (const m of helpers) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = HG.cell(m.id); name.className = 'uname';
        name.title = m.model_path || m.id;
        const kind = /dflash/i.test(m.id) ? 'DFLASH DRAFTER'
            : /assistant/i.test(m.id) ? 'ASSISTANT (MTP)' : 'HELPER';
        // U10 (user round): a drafter rides its consumers' engine — its own
        // loaded flag does not mean anything useful and the load button was
        // wrong. Show WHO uses it and light the lamp from the consumers.
        // used_by comes from our overlay route; on vanilla installs (viewer
        // mode) it is absent and derived here from each model's embedded
        // settings blob instead.
        const users = usedBy(m).map(uid => {
            const u = (MM.adminModels || []).find(x => x.id === uid);
            return { id: uid, loaded: !!(u && (u.loaded || u.is_loading)),
                     name: (u && (u.display_name || u.id)) || uid };
        });
        const active = users.filter(u => u.loaded);
        const state = document.createElement('span');
        state.className = 'spill ' + (active.length ? 'on' : 'off');
        state.textContent = users.length
            ? (active.length ? `IN USE ×${active.length}` : `SET FOR ×${users.length}`)
            : 'UNUSED';
        state.title = users.length
            ? 'Used by: ' + users.map(u => u.name + (u.loaded ? ' (loaded)' : '')).join(', ')
            : 'No model config references this drafter';
        row.append(name, HG.cell(m.model_type || ''), HG.cell(kind),
                   HG.cell(m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size || 0)), state);
        const act = document.createElement('span'); act.className = 'rowacts';
        for (const u of users.slice(0, 3)) {
            const chip = document.createElement('button');
            chip.className = 'se-btn act' + (u.loaded ? ' on' : '');
            chip.textContent = u.name.split('/').pop().slice(0, 22);
            chip.title = (u.loaded ? 'loaded — ' : 'not loaded — ') + u.id;
            chip.onclick = () => { location.hash = '#models/manager'; MM.render(true); };
            act.append(chip);
        }
        if (users.length > 3) act.append(HG.cell('+' + (users.length - 3)));
        if (!users.length) {
            const hint = document.createElement('span');
            hint.className = 'dim'; hint.style.fontSize = '10px';
            hint.textContent = 'assign it in a model\'s settings (DFlash / MTP / SpecPrefill)';
            act.append(hint);
        }
        row.append(act);
        host.append(row);
    }
}


/* UP-26(3): new-omlx-release nudge. Classic checks GET
   /admin/api/update-check at boot + hourly (dashboard.js:1163 checkForUpdate,
   1177 startUpdateCheckTimer) and badges the version link in _navbar.html
   (green dot + navbar.update_available tooltip + release_url href).
   Uplift's own build chip (#logo-build, uplift_boot.js) reports THIS
   deployment's build and stays untouched — the upstream release feed is a
   deliberately separate signal (card: do not conflate with the dev-keg
   auto-rebuild flag). Rendered next to the header status chips; hidden on
   any error (older server without the route, network, no update). */
function upUpdateCheck() {
    const anchor = document.getElementById('chip-uptime');
    const host = anchor && anchor.parentElement;
    if (!host) return;   // no header chips (frame/embed): nothing to badge
    let chip = document.getElementById('up-update-chip');
    if (!chip) {
        chip = document.createElement('a');
        chip.id = 'up-update-chip';
        chip.className = 'chip up-update-chip';
        chip.target = '_blank';
        chip.rel = 'noopener noreferrer';
        chip.hidden = true;
        anchor.insertAdjacentElement('afterend', chip);
    }
    HG.fetchJson(`${API}/admin/api/update-check`).then(d => {
        // classic fetches with no referrer and silently ignores failures
        // (dashboard.js:1172); updateNudge maps the payload honestly
        const n = window.UpliftGSpec.updateNudge(d);
        if (!n) { chip.hidden = true; return; }
        const txt = C.tf('navbar.update_available',
            'Update available: v{version}').replace('{version}', n.version);
        chip.textContent = txt;
        chip.title = txt + ' \u2014 ' + n.url;
        chip.href = n.url;
        chip.hidden = false;
    }).catch(() => { chip.hidden = true; });
}
/* Lane gate (owner 2026-11-22): a dev-lane board builds omlx from our
   uplift-dev branch - a vanilla release feed is not actionable there, and
   checking for one is noise. uplift_boot.js arms this ONLY after
   /admin/api/identity says the board is not DEV; uplift's own commits ride
   the nightly sync, not a header chip. */
let upArmed = false;
function upUpdateArm(devLane) {
    if (upArmed || devLane) return;
    upArmed = true;
    try {
        upUpdateCheck();
        setInterval(upUpdateCheck, 3600000);   // classic's hourly recheck
    } catch (_) { /* nudge is decoration; never break boot */ }
}


window.Uplift = window.Uplift || {};
window.Uplift.helper = { renderHelperModels, INTEG_PREFIXED, upUpdateArm };
})();
