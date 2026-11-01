/* Uplift MODEL OPS pages (PH2-1 stage 9b extraction from uplift.js):
   oQ quantizer form (faithful port of the classic page — candidate filters
   mirror oqSensitivityModelCandidates/oqMtpAssistantCandidates, estimate
   mirrors oqRefreshEstimate incl. the client-side sensitivity memory) and
   the uploader (token -> validate-token shadow flow). Plain script; loads
   AFTER uplift_state.js + uplift_downloader.js, BEFORE uplift.js, which
   late-binds shared helpers via window.Uplift._modelsopsGlue (GW_LIVE is
   a mutable let -> getter). Task lists reach uplift_downloader.js via its
   export, not through uplift.js. Exports window.Uplift.modelsops
   {renderQuantizer, renderUploader}; applyTab consumes them. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const MO = { get tasks() { return window.Uplift.downloader.renderTasks; } };
const QG = {
    fetchJson: D.fetchJson,
    postJson: D.postJson,
    toast: D.toast,
    cell: D.cell,
    emptyMsg: D.emptyMsg,
    get GW_LIVE() { return window.Uplift._modelsopsGlue.GW_LIVE; },
};
/* ---- oQ quantizer: faithful port of the classic page's form.
   All option lists come from the server (/oq/models); the candidate
   filters mirror oqSensitivityModelCandidates / oqMtpAssistantCandidates
   in dashboard.js; estimate mirrors oqRefreshEstimate (300 ms debounce,
   preserve_mtp param) including the client-side sensitivity-model memory
   approximation (size x 1.5 + 5 GB). Labels from models.oq.* in i18n. -- */
const OQ_LEVELS = [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8];
// DeepSeek V4.1 is a dedicated calibrated scheme: the SERVER rejects every
// other level (_validate_v41_oq_settings), plus non-bfloat16 dtype. The
// classic form mirrors that policy (oqAvailableLevels/oqApplyModelPolicy) —
// the uplift port must too, or users hit a server error that reads as a bug.
const V41_LEVELS = [2, 2.5, 2.7, 3, 4];
const oqLevelsFor = t => (t === 'deepseek_v41' ? V41_LEVELS : OQ_LEVELS);
function oqMtpFamily(t) {
    if (!t) return null;
    if (t.startsWith('qwen3_6')) return 'qwen3_6';
    if (t.startsWith('qwen3_5')) return 'qwen3_5';
    return null;
}
function qzField(host, label, ctl, hint, area) {
    const row = document.createElement('label');
    row.className = 'field';
    if (area) row.style.gridArea = area;
    const t = document.createElement('span'); t.textContent = label;
    row.append(t);
    if (ctl) row.append(ctl);
    if (hint) {
        const h = document.createElement('small'); h.textContent = hint;
        row.append(h);
        row._hint = h; row._hintEn = hint;    // gated rows swap this text
    }
    host.append(row);
    return row;
}
/* Checkboxes ride the same 32px control band as selects/inputs so the
   label line, the control line and the hint line of every column land on
   the same y (the naked 18px box under a label was the 'unaligned lines'). */
function qzCheck(host, label, hint, area) {
    const row = qzField(host, label, null, hint, area);
    const wrap = document.createElement('span');
    wrap.className = 'chk32';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    wrap.append(cb);
    row.insertBefore(wrap, row.querySelector('small'));
    row._cb = cb;
    return row;
}
/* Model selection must never reflow the form (user 2026-11-01):
   model-dependent rows keep their fixed grid slot and switch to a dimmed,
   disabled state with the REASON in the hint line — the seGate shape the
   model editor already established, not display:none. */
function qzGate(row, ok, reason) {
    row.classList.toggle('qz-off', !ok);
    for (const c of row.querySelectorAll('select,input,button')) c.disabled = !ok;
    const h = row._hint;
    if (h) {
        h.textContent = ok ? row._hintEn : reason;
        h.classList.toggle('warn-text', !ok);
    }
}
function qzSelect(placeholder) {
    const sel = document.createElement('select');
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.append(o);
    return sel;
}

function renderQuantizer() {
    const host = $('qz-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        host.append(g);

        const st = { all: [], models: [] };
        const selModel = qzSelect('Select a model...');
        qzField(g, 'Source Model', selModel, 'full precision only', 'src');
        const rowSens = qzField(g, 'Sensitivity Model', null,
            'Use a quantized version of the source model to analyze layer sensitivity with ~4x less memory.', 'sens');
        const selSens = qzSelect('None (use source model)');
        rowSens.insertBefore(selSens, rowSens.querySelector('small'));
        const selLevel = qzSelect(null);
        selLevel.remove(0);
        for (const l of OQ_LEVELS) {
            const o = document.createElement('option');
            o.value = l; selLevel.append(o);
        }
        selLevel.value = '4';
        qzField(g, 'oQ Level', selLevel, null, 'lvl');
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start';

        // enhanced (oQe) block — the only fold left on display:none: it is
        // driven by the user's own click, so growing the form there reads
        // as feedback, not as the panel rearranging itself.
        const rowEnh = qzCheck(g, 'Enhanced quantization (oQe)',
            'Use imatrix calibration to weight affine quantization by activation importance.', 'enh');
        const cbEnh = rowEnh._cb;
        const rowEnhOnly = document.createElement('div');
        rowEnhOnly.className = 'qz-enh-only'; rowEnhOnly.hidden = true;
        const cbReuse = document.createElement('input'); cbReuse.type = 'checkbox'; cbReuse.checked = true;
        qzField(rowEnhOnly, 'Reuse imatrix cache', cbReuse,
            'Use a compatible cached imatrix when available; otherwise collect a new one.');
        const inpCache = document.createElement('input');
        inpCache.type = 'text'; inpCache.placeholder = 'Automatic';
        qzField(rowEnhOnly, 'Imatrix cache path', inpCache);
        const cbStrict = document.createElement('input'); cbStrict.type = 'checkbox';
        qzField(rowEnhOnly, 'Strict imatrix coverage', cbStrict,
            'Fail when a quantized tensor has no matching imatrix entry instead of falling back.');
        g.append(rowEnhOnly);

        // advanced block: framed panel with an inset header strip (the old
        // bare 1px box read as flat); fixed two-row area grid, gated rows
        // always hold their slot
        const adv = document.createElement('div');
        adv.className = 'qz-adv';
        adv.style.gridArea = 'adv';
        const advT = document.createElement('div');
        advT.className = 'qz-adv-title'; advT.textContent = 'Advanced Settings';
        const advBody = document.createElement('div');
        advBody.className = 'qz-adv-body';
        adv.append(advT, advBody);
        const dtypes = document.createElement('div');
        dtypes.className = 'qz-toggle';
        const dtype = { v: 'bfloat16' };
        for (const d of ['bfloat16', 'float16']) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = d;
            b.className = d === dtype.v ? 'on' : '';
            b.onclick = () => {
                dtype.v = d;
                for (const x of dtypes.children) x.classList.toggle('on', x.textContent === d);
            };
            dtypes.append(b);
        }
        const rowDtype = qzField(advBody, 'Non-quant weight dtype', dtypes,
            'float16 gives ~20% faster prefill on M1/M2 Apple Silicon (native fp16). bfloat16 is safer for newer models.', 'dt');
        rowDtype.dataset.k = 'dtype';
        const rowMtp = qzCheck(advBody, 'Preserve MTP weights',
            'Keep mtp.* tensors and config fields in the output model so the Lightning MTP drafter still works.', 'mtp');
        const cbMtp = rowMtp._cb;
        // DeepSeek V4.1 only: keep Engram tables at source FP8 (-ngram suffix)
        const rowNgram = qzCheck(advBody, 'Keep original Engram tables',
            "Copy the Engram tables in their original FP8 storage instead of quantizing them to 4 bits. The output takes more disk space, but memory use stays the same with SSD N-gram Offload. Output name gets a -ngram suffix.", 'eng');
        const cbNgram = rowNgram._cb;
        rowNgram._hint.classList.add('h3');   // 3-line copy holds its slot
        const selCombine = qzSelect('None');
        const rowCombine = qzField(advBody, 'Combine other model\u2019s MTP head', selCombine,
            'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).', 'comb');
        const rowText = qzCheck(advBody, 'Text Only',
            'Excludes vision encoder weights. Output is a text-only model (~2-3% smaller).', 'txt');
        const cbText = rowText._cb;
        const setTextHint = warn => {
            rowText._hint.textContent = warn
                ? C.tf('uplift.ui.selected_model_is_a_vlm_vision_tower_will_be_ski', 'Selected model is a VLM — vision tower will be skipped.')
                : rowText._hintEn;
            rowText._hint.classList.toggle('warn-text', !!warn);
        };
        g.append(adv);

        // estimate reads as an instrument well; Start shares the line
        const run = document.createElement('div');
        run.className = 'qz-run'; run.style.gridArea = 'run';
        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '\u2014';
        run.append(est, start);
        g.append(run);

        const levelLabel = l => 'oQ' + l + (cbEnh.checked ? 'e' : '');
        const refreshLevelLabels = () => {
            for (const o of selLevel.options) o.textContent = levelLabel(o.value);
        };

        let estTimer = null;
        function refreshEst() {
            clearTimeout(estTimer);
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { est.textContent = '\u2014'; return; }
            estTimer = setTimeout(() => {
                const params = new URLSearchParams({
                    model_path: m.path, oq_level: selLevel.value,
                    preserve_mtp: (m.has_mtp_heads && cbMtp.checked) ? 'true' : 'false',
                    preserve_ngram_table: (m.model_type === 'deepseek_v41' && cbNgram.checked) ? 'true' : 'false',
                });
                QG.fetchJson(`${API}/admin/api/oq/estimate?${params}`).then(e => {
                    let mem = e.memory_streaming_formatted || '';
                    const sens = st.all.find(x => x.path === selSens.value);
                    if (sens) {   // client-side approximation, same as classic page
                        const bytes = Math.round(sens.size * 1.5) + 5 * 1024 ** 3;
                        mem = bytes > 1024 ** 3
                            ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
                            : Math.round(bytes / 1024 ** 2) + ' MB';
                    }
                    est.textContent = `est: ${e.output_size_formatted || C.fmtBytes(e.output_size_bytes)}` +
                        ` \u00b7 ${e.effective_bpw} bpw \u00b7 stream ${mem}`;
                }).catch(err => { est.textContent = 'estimate: ' + D.errText(err); });
            }, 300);
        }

        function fill(sel, items, label) {
            const keep = sel.value;
            for (const o of [...sel.options].slice(1)) o.remove();
            for (const m of items) {
                const o = document.createElement('option');
                o.value = m.path; o.textContent = label(m);
                sel.append(o);
            }
            sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
        }

        function updateConditional() {
            const m = st.models.find(x => x.path === selModel.value);
            // sensitivity candidates: quantized, same model_type, not the source
            const sens = m ? st.all.filter(x => x.path !== m.path && x.is_quantized &&
                x.model_type === m.model_type) : [];
            fill(selSens, sens, x => `${x.name} (${x.size_formatted})`);
            qzGate(rowSens, sens.length > 0, m
                ? 'No quantized build of this model to reuse.'
                : 'Select a source model first.');
            if (!sens.length) selSens.value = '';
            // preserve MTP availability (reason takes the hint line,
            // replacing the old free-floating mtp-na warning)
            const hasMtp = !!(m && m.has_mtp_heads);
            qzGate(rowMtp, hasMtp, m
                ? 'Source model has no MTP heads.'
                : 'Select a source model first.');
            if (!hasMtp) cbMtp.checked = false;
            // Engram-tables switch: deepseek_v41 only (mirror classic x-show)
            const isV41 = !!(m && m.model_type === 'deepseek_v41');
            qzGate(rowNgram, isV41, 'DeepSeek V4.1 models only.');
            if (!isV41) cbNgram.checked = false;
            // MTP donor / gemma4 assistant candidates (mirror the classic filter)
            let comb = [];
            if (m && m.model_type === 'gemma4') {
                comb = st.all.filter(x => x.model_type === 'gemma4_assistant');
                rowCombine.querySelector('span').textContent = 'Combine assistant model as MTP head';
                rowCombine._hintEn =
                    'Merge a separate gemma4_assistant checkpoint into the output as a Lightning MTP head.';
            } else if (m && oqMtpFamily(m.model_type) && !(hasMtp && cbMtp.checked)) {
                comb = st.all.filter(x => x.path !== m.path && x.has_mtp_heads &&
                    oqMtpFamily(x.model_type) === oqMtpFamily(m.model_type) &&
                    (!x.hidden_size || !m.hidden_size || x.hidden_size === m.hidden_size));
                rowCombine.querySelector('span').textContent = 'Combine other model\u2019s MTP head';
                rowCombine._hintEn =
                    'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).';
            }
            fill(selCombine, comb, x => `${x.name} (${x.size_formatted})`);
            qzGate(rowCombine, comb.length > 0, m
                ? 'No matching donor checkpoints found for this model.'
                : 'Select a source model first.');
            if (!comb.length) selCombine.value = '';
            // V4.1 policy (mirror classic oqApplyModelPolicy +
            // oqAvailableLevels): level list per model type, forced
            // bfloat16 output, text-only off, no sensitivity model at oQ4
            const levels = oqLevelsFor(m && m.model_type);
            if ([...selLevel.options].map(o => o.value).join(',') !==
                    levels.map(String).join(',')) {
                const keep = selLevel.value;
                for (const o of [...selLevel.options]) o.remove();
                for (const l of levels) {
                    const o = document.createElement('option');
                    o.value = l; selLevel.append(o);
                }
                // never assign a value matching no option (browser blanks
                // the select); classic snaps an unsupported pick to oQ4
                selLevel.value = levels.map(String).includes(keep) ? keep : '4';
                refreshLevelLabels();
            }
            if (m && m.model_type === 'deepseek_v41') {
                dtype.v = 'bfloat16';
                for (const x of dtypes.children)
                    x.classList.toggle('on', x.textContent === 'bfloat16');
                cbText.checked = false;
                if (selLevel.value === '4') selSens.value = '';
            }
            // VLM text-only warning: hint swap in the reserved line, never
            // an inserted node (insertion is what moved everything below)
            setTextHint(!!(m && m.is_vlm && cbText.checked));
            refreshEst();
        }

        QG.fetchJson(`${API}/admin/api/oq/models`).then(d => {
            st.all = d.all_models || d.models || [];
            st.models = st.all.filter(m => !m.is_quantized);
            fill(selModel, st.models,
                m => `${m.source_repo_id || m.name} (${m.size_formatted})`);
            $('qz-sub').textContent = `${st.models.length} quantizable models`;
            refreshLevelLabels();
            updateConditional();
        }).catch(e => QG.emptyMsg(host, D.errText(e)));

        selModel.onchange = updateConditional;
        selSens.onchange = refreshEst;
        selLevel.onchange = () => {
            // classic re-arms its policy effect on every level change:
            // oQ4 has no use for a sensitivity model on V4.1
            const m = st.models.find(x => x.path === selModel.value);
            if (m && m.model_type === 'deepseek_v41' && selLevel.value === '4')
                selSens.value = '';
            refreshEst();
        };
        cbMtp.onchange = () => { updateConditional(); };
        cbNgram.onchange = refreshEst;   // classic arms oqRefreshEstimate on this toggle
        cbText.onchange = updateConditional;
        cbEnh.onchange = () => {
            rowEnhOnly.hidden = !cbEnh.checked;
            refreshLevelLabels();     // labels gain the 'e' suffix, like the classic page
            refreshEst();
        };

        start.onclick = () => {
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { QG.toast(C.t('uplift.toast.select_a_model')); return; }
            const donor = st.all.find(x => x.path === selCombine.value);
            start.disabled = true;
            const payload = {
                model_path: m.path,
                oq_level: parseFloat(selLevel.value),
                group_size: 64,
                sensitivity_model_path: selSens.value || '',
                text_only: cbText.checked,
                dtype: dtype.v,
                preserve_mtp: m.has_mtp_heads ? cbMtp.checked : false,
                preserve_ngram_table: m.model_type === 'deepseek_v41' && cbNgram.checked,
                mtp_assistant_model_path: donor ? donor.path : '',
            };
            if (cbEnh.checked) {
                payload.enhanced = true;
                payload.imatrix_reuse_cache = cbReuse.checked;
                payload.imatrix_cache_path = inpCache.value.trim();
                payload.imatrix_strict = cbStrict.checked;
            }
            QG.postJson(`${API}/admin/api/oq/start`, payload).then(() => {
                QG.toast(`quantize queued${QG.GW_LIVE ? '' : ' (shadow)'}: ` + m.name);
                MO.tasks('qz-tasks', 'oq');
            }).catch(e => QG.toast(C.tf('uplift.mo.quantize_fail', 'quantize: ') + D.errText(e)))
              .finally(() => { start.disabled = false; });
        };
    }
    MO.tasks('qz-tasks', 'oq');
}


/* ---- oQ uploader: faithful port. Token -> validate-token (shadow:
   never forwarded, so a real token is never leaked to the real server's
   response path; username/orgs are simulated), model list comes from
   upload/oq-models, upload opens the same modal fields as the classic
   page (repo name prefilled namespace/name, README source, re-download
   notice only when no README source, private). -- */
function renderUploader() {
    const host = $('up-form');
    if (host.dataset.built) { MO.tasks('up-tasks', 'upload'); return; }
    host.dataset.built = '1';
    host.innerHTML = '';
    const st = { validated: false, ns: '', models: [] };
    const g = document.createElement('div');
    g.className = 'qz-form up-form';
    host.append(g);
    const tokWrap = document.createElement('div');
    tokWrap.className = 'qz-inline';
    const tok = document.createElement('input');
    tok.type = 'password'; tok.placeholder = 'Enter HF write token (hf_...)';
    const vbtn = document.createElement('button');
    vbtn.className = 'se-btn';
    // UP-5: JS-built label — tf() translates at build time (locale may
    // already be loaded), the data-i18n tag covers a later locale switch
    // via applyI18n's document-wide relabel pass.
    vbtn.textContent = C.tf('uplift.action.validate', 'Validate');
    vbtn.dataset.i18n = 'uplift.action.validate';
    vbtn.dataset.en = 'Validate';
    tokWrap.append(tok, vbtn);
    // the status line rides the field's own hint slot (the old third flex
    // child inside .qz-inline starved the password input to ~20px)
    const rowTok = qzField(g, 'HuggingFace Token', tokWrap,
        C.tf('uplift.ui.enter_a_token_to_list_uploadable_oq_models',
            'Enter a token to list uploadable oQ models.'), 'tok');
    const vmsg = rowTok._hint;
    const list = document.createElement('div');
    list.className = 'admin-table qz-list';
    const listT = document.createElement('div');
    listT.className = 'se-hint'; listT.textContent = 'oQ Models';
    host.append(listT, list);
    const tasksT = document.createElement('h3');
    tasksT.textContent = C.tf('uplift.ui.upload_queue', 'Upload Queue'); tasksT.style.margin = '16px 0 6px';

    function loadModels() {
        QG.fetchJson(`${API}/admin/api/upload/oq-models`).then(d => {
            st.models = d.oq_models || [];
            $('up-sub').textContent = `${st.models.length} oQ models`;
            list.innerHTML = '';
            if (!st.models.length) { D.emptyMsg(list, C.t('uplift.mo.none_found')); return; }
            for (const m of st.models) {
                const row = document.createElement('div'); row.className = 'urow usage';
                const name = QG.cell(m.name); name.className = 'uname';
                row.append(name, QG.cell(m.size_formatted || C.fmtBytes(m.size || 0)));
                const act = document.createElement('span'); act.className = 'rowacts';
                const b = document.createElement('button');
                b.className = 'se-btn act'; b.textContent = 'upload';
                b.disabled = !st.validated;
                b.onclick = () => uploadModal(m);
                act.append(b); row.append(act);
                list.append(row);
            }
            vbtn.disabledMsg = null;
        }).catch(e => QG.emptyMsg(list, D.errText(e)));
    }

    vbtn.onclick = () => {
        if (!tok.value.trim()) { vmsg.textContent = C.tf('uplift.ui.invalid_token_ensure_it_has_write_access', 'Invalid token. Ensure it has write access.'); return; }
        vbtn.disabled = true; vmsg.textContent = 'Validating...';
        QG.postJson(`${API}/admin/api/upload/validate-token`, { hf_token: tok.value.trim() })
            .then(d => {
                st.validated = true; st.ns = d.username || 'you';
                vmsg.textContent = C.tf('uplift.ui.authenticated_as', 'Authenticated as ') + st.ns;
                tok.value = tok.value;   // stays in the browser only
                loadModels();
            })
            .catch(e => { st.validated = false; vmsg.textContent = D.errText(e); })
            .finally(() => { vbtn.disabled = false; });
    };
    tok.addEventListener('keydown', e => { if (e.key === 'Enter') vbtn.onclick(); });

    function uploadModal(m) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const box = document.createElement('div');
        box.className = 'modal nasa';
        const h = document.createElement('h3'); h.textContent = 'Upload to HuggingFace';
        const repo = document.createElement('input');
        repo.type = 'text'; repo.value = st.ns + '/' + m.name;
        const readme = qzSelect('Auto-generate basic README');
        const rdSel = document.createElement('div');
        rdSel.append(readme);   // only auto-README is meaningful in the sandbox
        const cbRe = document.createElement('input'); cbRe.type = 'checkbox';
        const cbPr = document.createElement('input'); cbPr.type = 'checkbox';
        const bCancel = document.createElement('button'); bCancel.textContent = 'Cancel';
        const bGo = document.createElement('button'); bGo.className = 'danger'; bGo.textContent = 'Upload';
        bCancel.onclick = () => overlay.remove();
        bGo.onclick = () => {
            if (!repo.value.trim()) { QG.toast(C.t('uplift.toast.repo_name_required')); return; }
            bGo.disabled = true;
            QG.postJson(`${API}/admin/api/upload/start`, {
                model_path: m.path, repo_id: repo.value.trim(), hf_token: tok.value.trim(),
                readme_source_path: '', auto_readme: true,
                redownload_notice: cbRe.checked, private: cbPr.checked,
            }).then(() => {
                QG.toast(`upload queued${QG.GW_LIVE ? '' : ' (shadow)'}: ` + repo.value.trim());
                overlay.remove();
                MO.tasks('up-tasks', 'upload');
            }).catch(e => QG.toast(C.tf('uplift.mo.upload_fail', 'upload: ') + D.errText(e)))
              .finally(() => { bGo.disabled = false; });
        };
        const bar = document.createElement('div');
        bar.className = 'row buttons';
        bar.append(document.createElement('span'), bCancel, bGo);
        qzField(box, 'Repository Name', repo);
        qzField(box, 'README Source', rdSel);
        qzField(box, 'Show re-download notice', cbRe,
            'Add a notice at the top of README asking previous users to re-download');
        qzField(box, 'Private Repository', cbPr);
        box.append(h, bar);
        overlay.append(box);
        overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
        // Escape is handled by the global modal handler (uplift_state.js) —
        // this dialog used to have no Escape path at all (takes no focus)
        document.body.append(overlay);
    }

    MO.tasks('up-tasks', 'upload');
}

window.Uplift = window.Uplift || {};
window.Uplift.modelsops = { renderQuantizer, renderUploader };
})();
