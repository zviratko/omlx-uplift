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
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const MO = { tasks: window.Uplift.downloader.renderTasks };
const QG = {
    get fetchJson() { return window.Uplift._modelsopsGlue.fetchJson; },
    get postJson() { return window.Uplift._modelsopsGlue.postJson; },
    get toast() { return window.Uplift._modelsopsGlue.toast; },
    get cell() { return window.Uplift._modelsopsGlue.cell; },
    get emptyMsg() { return window.Uplift._modelsopsGlue.emptyMsg; },
    get GW_LIVE() { return window.Uplift._modelsopsGlue.GW_LIVE; },
};
/* ---- oQ quantizer: faithful port of the classic page's form.
   All option lists come from the server (/oq/models); the candidate
   filters mirror oqSensitivityModelCandidates / oqMtpAssistantCandidates
   in dashboard.js; estimate mirrors oqRefreshEstimate (300 ms debounce,
   preserve_mtp param) including the client-side sensitivity-model memory
   approximation (size x 1.5 + 5 GB). Labels from models.oq.* in i18n. -- */
const OQ_LEVELS = [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8];
function oqMtpFamily(t) {
    if (!t) return null;
    if (t.startsWith('qwen3_6')) return 'qwen3_6';
    if (t.startsWith('qwen3_5')) return 'qwen3_5';
    return null;
}
function qzField(host, label, ctl, hint) {
    const row = document.createElement('label');
    row.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    row.append(t);
    if (ctl) row.append(ctl);
    if (hint) { const h = document.createElement('small'); h.textContent = hint; row.append(h); }
    host.append(row);
    return row;
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
        qzField(g, 'Source Model', selModel, 'full precision only');
        const rowSens = qzField(g, 'Sensitivity Model', null,
            'Use a quantized version of the source model to analyze layer sensitivity with ~4x less memory.');
        const selSens = qzSelect('None (use source model)');
        rowSens.insertBefore(selSens, rowSens.querySelector('small'));
        const selLevel = qzSelect(null);
        selLevel.remove(0);
        for (const l of OQ_LEVELS) {
            const o = document.createElement('option');
            o.value = l; selLevel.append(o);
        }
        selLevel.value = '4';
        const rowLevel = qzField(g, 'oQ Level', selLevel);
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start';
        g.append(rowLevel);

        // enhanced (oQe) block
        const cbEnh = document.createElement('input'); cbEnh.type = 'checkbox';
        qzField(g, 'Enhanced quantization (oQe)', cbEnh,
            'Use imatrix calibration to weight affine quantization by activation importance.');
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

        // advanced block
        const adv = document.createElement('div');
        adv.className = 'qz-adv';
        const advT = document.createElement('div');
        advT.className = 'qz-adv-title'; advT.textContent = 'Advanced Settings';
        adv.append(advT);
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
        qzField(adv, 'Non-quant weight dtype', dtypes,
            'float16 gives ~20% faster prefill on M1/M2 Apple Silicon (native fp16). bfloat16 is safer for newer models.').dataset.k = 'dtype';
        const cbMtp = document.createElement('input'); cbMtp.type = 'checkbox';
        const rowMtp = qzField(adv, 'Preserve MTP weights', cbMtp,
            'Keep mtp.* tensors and config fields in the output model so the Lightning MTP drafter still works.');
        const mtpNa = document.createElement('small');
        mtpNa.className = 'warn-text'; mtpNa.textContent = 'Source model has no MTP heads.';
        mtpNa.hidden = true; rowMtp.append(mtpNa);
        const selCombine = qzSelect('None');
        const rowCombine = qzField(adv, 'Combine other model\u2019s MTP head', selCombine,
            'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).');
        const cbText = document.createElement('input'); cbText.type = 'checkbox';
        const rowText = qzField(adv, 'Text only', cbText);
        const vlmWarn = document.createElement('small');
        vlmWarn.className = 'warn-text';
        vlmWarn.textContent = C.tf('uplift.ui.selected_model_is_a_vlm_vision_tower_will_be_ski', 'Selected model is a VLM — vision tower will be skipped.');
        vlmWarn.hidden = true; rowText.append(vlmWarn);
        g.append(adv);

        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '\u2014';
        g.append(est, start);

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
                }).catch(err => { est.textContent = 'estimate: ' + err.message; });
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
            rowSens.hidden = sens.length === 0;
            // preserve MTP availability
            const hasMtp = !!(m && m.has_mtp_heads);
            cbMtp.disabled = !hasMtp;
            if (!hasMtp) cbMtp.checked = false;
            mtpNa.hidden = hasMtp || !m;
            // MTP donor / gemma4 assistant candidates (mirror the classic filter)
            let comb = [];
            if (m && m.model_type === 'gemma4') {
                comb = st.all.filter(x => x.model_type === 'gemma4_assistant');
                rowCombine.querySelector('span').textContent = 'Combine assistant model as MTP head';
                rowCombine.querySelector('small').textContent =
                    'Merge a separate gemma4_assistant checkpoint into the output as a Lightning MTP head.';
            } else if (m && oqMtpFamily(m.model_type) && !(hasMtp && cbMtp.checked)) {
                comb = st.all.filter(x => x.path !== m.path && x.has_mtp_heads &&
                    oqMtpFamily(x.model_type) === oqMtpFamily(m.model_type) &&
                    (!x.hidden_size || !m.hidden_size || x.hidden_size === m.hidden_size));
                rowCombine.querySelector('span').textContent = 'Combine other model\u2019s MTP head';
                rowCombine.querySelector('small').textContent =
                    'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).';
            }
            fill(selCombine, comb, x => `${x.name} (${x.size_formatted})`);
            rowCombine.hidden = comb.length === 0;
            // VLM text-only warning
            vlmWarn.hidden = !(m && m.is_vlm && cbText.checked);
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
        }).catch(e => QG.emptyMsg(host, e.message));

        selModel.onchange = updateConditional;
        selSens.onchange = refreshEst;
        selLevel.onchange = refreshEst;
        cbMtp.onchange = () => { updateConditional(); };
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
            }).catch(e => QG.toast('quantize: ' + e.message))
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
    g.className = 'qz-form';
    host.append(g);
    const tokWrap = document.createElement('div');
    tokWrap.className = 'qz-inline';
    const tok = document.createElement('input');
    tok.type = 'password'; tok.placeholder = 'Enter HF write token (hf_...)';
    const vbtn = document.createElement('button');
    vbtn.className = 'se-btn'; vbtn.textContent = 'Validate';
    const vmsg = document.createElement('span');
    vmsg.className = 'stat-sub';
    tokWrap.append(tok, vbtn, vmsg);
    qzField(g, 'HuggingFace Token', tokWrap);
    const list = document.createElement('div');
    list.className = 'admin-table';
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
            if (!st.models.length) { list.innerHTML = '<div class="empty">No oQ models found in model directories.</div>'; return; }
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
        }).catch(e => QG.emptyMsg(list, e.message));
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
            .catch(e => { st.validated = false; vmsg.textContent = e.message; })
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
            }).catch(e => QG.toast('upload: ' + e.message))
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

    vmsg.textContent = C.tf('uplift.ui.enter_a_token_to_list_uploadable_oq_models', 'Enter a token to list uploadable oQ models.');
    MO.tasks('up-tasks', 'upload');
}

window.Uplift = window.Uplift || {};
window.Uplift.modelsops = { renderQuantizer, renderUploader };
})();
