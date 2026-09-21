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
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const MM = window.Uplift.modelmgr;
const HG = {
    get fetchJson() { return window.Uplift._helperGlue.fetchJson; },
    get postJson() { return window.Uplift._helperGlue.postJson; },
    get toast() { return window.Uplift._helperGlue.toast; },
    get cell() { return window.Uplift._helperGlue.cell; },
    get emptyMsg() { return window.Uplift._helperGlue.emptyMsg; },
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
    } catch (err) { HG.toast('prune check failed: ' + err.message); return; }
    if (!orphans.length && !profs.length) { HG.toast(C.t('uplift.toast.nothing_to_prune')); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = `Prune model settings (${orphans.length + profs.length})`;
    const sub = document.createElement('div');
    sub.className = 'se-hint';
    sub.textContent = C.tf('uplift.ui.stored_configuration_for_models_that_no_longer_e', 'Stored configuration for models that no longer exist on disk. ')
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
    cancel.textContent = 'Cancel';
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
            HG.toast(`Pruned ${r.removed.length} setting record(s)`
                + (r.removed_profiles && r.removed_profiles.length
                    ? `, ${r.removed_profiles.length} profile(s)` : ''));
            overlay.remove();
            MM.render(true);
        } catch (err) { HG.toast('prune failed: ' + err.message); }
    };
    bar.append(all, none, document.createElement('span'), cancel, doIt);
    box.append(h, sub, list, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
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
    try { models = (await HG.fetchJson(`${API}/admin/api/models`)).models; }
    catch (e) { HG.emptyMsg($('hm-list'), e.message); return; }
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
    let integ = {};
    let modelList = [];
    try {
        integ = (await HG.fetchJson(`${API}/admin/api/global-settings`)).integrations || {};
    } catch (_) {}
    modelList = models;

    // save exactly like classic saveIntegrationSettings(): flat body where
    // ONLY the CLI-assistant keys carry the integrations_ prefix; markitdown_*
    // and web_search_* are sent bare (real oMLX drops unknown fields with a
    // silent success:true, so a blanket prefix looked saved but did nothing).
    const INTEG_PREFIXED = new Set(['copilot_model', 'codex_model', 'opencode_model',
        'openclaw_model', 'hermes_model', 'pi_model', 'openclaw_tools_profile']);
    async function saveIntegration(overrides) {
        Object.assign(integ, overrides || {});
        const body = {};
        for (const [k, v] of Object.entries(integ))
            body[INTEG_PREFIXED.has(k) ? 'integrations_' + k : k] = v;
        try {
            const r = await fetch(`${API}/admin/api/global-settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const res = await r.json().catch(() => ({}));
            if (res.success === false) throw new Error(res.message || 'rejected');
            HG.toast(C.t('uplift.toast.integration_saved'));
            return true;
        } catch (err) { HG.toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
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
        warn.textContent = C.tf('uplift.ui.scanned_or_image_only_pdfs_will_fail_when_markit', 'Scanned or image-only PDFs will fail when MarkItDown is selected, ')
            + 'and PDFs with tables may not be processed correctly.';
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
    const cliGrid = document.createElement('div');
    cliGrid.className = 'mk-grid';
    const cliModel = (key, label) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.spellcheck = false;
        inp.setAttribute('list', 'cli-models');
        inp.value = integ[key] || '';
        inp.placeholder = 'Ask every launch';
        inp.onchange = async () => { await saveIntegration({ [key]: inp.value || null }); };
        return integField(label, '', inp);
    };
    cliGrid.append(
        cliModel('copilot_model', 'GitHub Copilot'),
        cliModel('codex_model', 'Codex'),
        cliModel('opencode_model', 'OpenCode'),
        cliModel('openclaw_model', 'OpenClaw'),
        integField('OpenClaw tools profile', 'Tool set the launcher passes to openclaw.',
            integSelect([['minimal','Minimal'],['coding','Coding'],['messaging','Messaging'],['full','Full']],
                        integ.openclaw_tools_profile || 'coding',
                        v => saveIntegration({ openclaw_tools_profile: v }))),
        cliModel('hermes_model', 'Hermes Agent'),
        cliModel('pi_model', 'Pi'));
    // model datalist for the assistant pickers
    const cliDl = document.createElement('datalist'); cliDl.id = 'cli-models';
    for (const m of modelList) {
        const o2 = document.createElement('option'); o2.value = m.id || m.name || ''; cliDl.append(o2);
    }
    cliCard.append(cliHead, cliDl, cliGrid);
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
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
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
            testOut.textContent = r.ok
                ? `Search OK: ${(r.results || []).length} results`
                : ('Search test failed: ' + ((r.error && r.error.message) || 'unknown'));
        } catch (err) {
            testOut.textContent = C.tf('uplift.ui.search_test_failed', 'Search test failed: ') + err.message;
        }
        testBtn.disabled = false; testBtn.textContent = C.tf('uplift.ui.test_search', 'Test search');
    };
    testRow.append(testBtn, testOut);
    testRow.className = 'mk-row';
    wsGrid.append(testRow);
    wsCard.append(wsHead, wsGrid);
    box.append(wsCard);

    $('hm-sub').textContent = `${helpers.length} helpers · integrations editable${HG.GW_LIVE ? ' (live)' : ' (shadow)'}`;
    $('hm-sub').dataset.count = helpers.length;

    const host = $('hm-list');
    host.textContent = '';
    if (!helpers.length) { host.innerHTML = '<div class="empty">No helper models</div>'; return; }
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


window.Uplift = window.Uplift || {};
window.Uplift.helper = { renderHelperModels };
})();
