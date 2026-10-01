/* SPLIT-2 stage 1 (uplift_modelmgr.js split, user override 2026-10-01):
   RL-2 request inspector extracted — detail modal with live tail. Zero
   deps on modelmgr internals (audit: only C, DOM glue, API), so it loads
   right after uplift_charts.js and BEFORE uplift_modelmgr.js, which keeps
   re-exporting openInspector on window.Uplift.modelmgr for its consumers
   (uplift.js, uplift_feed.js, uplift_reqsearch.js, uplift_helper.js).
   Plain script; exports window.Uplift.inspector. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const API = window.Uplift.state.API;
const MM_GLUE = { toast: D.toast, fetchJson: D.fetchJson };
let inspectorOverlay = null;
async function openInspector(reqId) {
    if (inspectorOverlay) inspectorOverlay.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa'; box.style.minWidth = '560px';
    overlay.append(box);
    let timer = null, follow = true, closed = false;

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function close() {
        if (closed) return; closed = true;
        stop(); overlay.remove();
        if (inspectorOverlay === overlay) inspectorOverlay = null;
    }

    const h = document.createElement('h3');
    const head = document.createElement('div');   // header line: chips + counters
    head.className = 'se-hint';
    const loopBanner = document.createElement('div');   // RL-4 caution banner
    loopBanner.className = 'se-hint';
    loopBanner.style.cssText = 'color:var(--accent);display:none;margin:2px 0';
    loopBanner.textContent = '⚠ ' + C.t('uplift.req.loop_hint');
    const promptBox = document.createElement('div');
    const outputBox = document.createElement('div');
    const paramsBox = document.createElement('div');
    paramsBox.className = 'se-hint';
    const outPre = document.createElement('pre');
    outPre.style.cssText = 'max-height:240px;overflow:auto;white-space:pre-wrap;margin:4px 0;background:var(--panel);padding:6px';
    const promptPre = document.createElement('pre');
    promptPre.style.cssText = 'max-height:140px;overflow:auto;white-space:pre-wrap;margin:4px 0;background:var(--panel);padding:6px';
    // ISSUE-3: prompts used to dump 32 KB of head — the tail (what the
    // model actually answers) was off-screen. Default view = last ~1K chars
    // + a SHOW FULL toggle; token-id prompts render their decoded text.
    const PROMPT_TAIL_CHARS = 1000;
    let promptFull = false, promptText = '';
    const promptToggle = document.createElement('button');
    promptToggle.type = 'button'; promptToggle.className = 'se-btn';
    promptToggle.style.cssText = 'font-size:10px;padding:1px 6px;margin-left:6px';
    promptToggle.onclick = () => { promptFull = !promptFull; paintPrompt(); };
    function paintPrompt() {
        if (!promptText) { promptPre.textContent = ''; return; }
        const long = promptText.length > PROMPT_TAIL_CHARS;
        promptPre.textContent = (long && !promptFull)
            ? '…\n' + promptText.slice(promptText.length - PROMPT_TAIL_CHARS)
            : promptText;
        promptToggle.textContent = long
            ? (promptFull ? C.t('uplift.req.show_tail') : C.t('uplift.req.show_full'))
            : '';
        promptToggle.style.display = long ? '' : 'none';
        promptPre.scrollTop = (long && !promptFull) ? 0 : promptPre.scrollHeight;
    }
    const followLbl = document.createElement('label');
    followLbl.style.cssText = 'font-size:10px;color:var(--dim);user-select:none';
    const followChk = document.createElement('input');
    followChk.type = 'checkbox'; followChk.checked = true;
    followLbl.append(followChk, ' ' + C.t('uplift.req.follow'));
    // ISSUE-3: the label alone was cryptic — say what it actually does.
    followLbl.title = C.t('uplift.req.follow_title');
    followChk.onchange = () => { follow = followChk.checked; };
    // user scrolls up -> stop following automatically (reader, not robot)
    outPre.onscroll = () => {
        const atBottom = outPre.scrollHeight - outPre.scrollTop - outPre.clientHeight < 24;
        if (!atBottom && follow) { follow = false; followChk.checked = false; }
    };
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'se-btn act danger'; cancelBtn.textContent = C.t('uplift.req.cancel');
    cancelBtn.style.display = 'none';
    cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        try {
            const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(reqId)}/cancel`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
            MM_GLUE.toast(C.t('uplift.toast.cancelled', { id: reqId.slice(0, 6) }));
        } catch (err) { MM_GLUE.toast(C.t('uplift.toast.cancel_failed', { msg: err.message })); }
        cancelBtn.disabled = false;
        refresh();
    };
    const closeBtn = document.createElement('button');
    closeBtn.className = 'se-btn act'; closeBtn.textContent = C.t('uplift.req.close');
    closeBtn.onclick = close;
    const bar = document.createElement('div'); bar.className = 'row buttons';
    bar.append(document.createElement('span'), cancelBtn, closeBtn);

    h.textContent = C.t('uplift.req.title', { id: reqId.slice(0, 8) });
    h.style.wordBreak = 'break-all';
    box.append(h, head, loopBanner);
    const pLabel = document.createElement('div'); pLabel.className = 'se-hint'; pLabel.textContent = C.t('uplift.req.prompt');
    const oLabel = document.createElement('div'); oLabel.className = 'se-hint';
    oLabel.textContent = C.t('uplift.req.output');
    box.append(pLabel, promptBox, oLabel, outputBox, paramsBox, bar);
    pLabel.append(promptToggle);
    promptBox.append(promptPre); outputBox.append(followLbl, outPre);

    function setBlock(pre, block, truncLabel) {
        if (!block) { pre.textContent = C.t('uplift.req.none'); return; }
        pre.textContent = block.text + (block.truncated ? `\n… ${truncLabel}` : '');
    }
    /* ISSUE-3 prompt pick: decoded token text wins when the server decoded
       the stored id sample; otherwise the raw captured string. A tail-
       sampled decode says so honestly (the middle of a long prompt is not
       shown, only head+tail were kept). */
    function setPrompt(d) {
        const dec = d.prompt_decoded;
        promptFull = false;
        if (dec && dec.text) {
            const bits = [];
            if (dec.sample_truncated) bits.push(C.t('uplift.req.decoded_gap'));
            if (d.prompt && d.prompt.truncated) bits.push(C.t('uplift.req.truncated'));
            promptText = dec.text + (bits.length ? `\n… ${bits.join(' · ')}` : '');
            paintPrompt();
            return;
        }
        if (dec && dec.note) {
            promptText = (d.prompt && d.prompt.text) || '';
            paintPrompt();
            const n = document.createElement('div');
            n.className = 'se-hint'; n.textContent = dec.note;
            promptBox.replaceChildren(promptPre, n);
            return;
        }
        const b = d.prompt;
        promptText = (b && b.text) || '';
        if (!promptText) {
            promptPre.textContent = C.t('uplift.req.none');
            promptToggle.style.display = 'none';
            return;
        }
        promptText += (b.truncated ? `\n… ${C.t('uplift.req.truncated')}` : '');
        paintPrompt();
    }
    async function refresh() {
        if (closed) return;
        let d;
        try {
            d = await MM_GLUE.fetchJson(`${API}/admin/api/requests/${encodeURIComponent(reqId)}`);
        } catch (err) { head.textContent = C.t('uplift.req.load_failed', { msg: err.message }); return; }
        if (closed) return;
        if (!d.found) {
            head.textContent = C.t('uplift.req.not_found');
            outPre.textContent = d.note || ''; promptPre.textContent = '—';
            promptText = ''; promptToggle.style.display = 'none';
            paramsBox.textContent = ''; cancelBtn.style.display = 'none';
            stop();   // honest empty state, never a spinner forever
            return;
        }
        const r = d.row || {};
        const bits = [r.model, r.state];
        if (r.prompt_tokens) bits.push(`in ${C.fmtCompact(r.prompt_tokens)}`);
        if (r.completion_tokens) bits.push(`out ${C.fmtCompact(r.completion_tokens)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(1)} t/s`);
        if (d.timings && d.timings.total_s !== undefined) bits.push(`${d.timings.total_s.toFixed(1)}s`);
        if (r.error) bits.push(`error: ${r.error}`);
        if (r.finish) bits.push(`finish: ${r.finish}`);
        if (d.source) bits.push(C.t('uplift.req.source.' + d.source));
        head.textContent = bits.filter(Boolean).join(' · ');
        setPrompt(d);
        setBlock(outPre, d.output, C.t('uplift.req.truncated'));
        if (follow && d.output) outPre.scrollTop = outPre.scrollHeight;
        paramsBox.textContent = d.params ? C.t('uplift.req.params') + ': ' + JSON.stringify(d.params) : '';
        loopBanner.style.display = r.loop_hint ? '' : 'none';
        cancelBtn.style.display = d.live ? '' : 'none';
        if (timer && !d.live) stop();   // request ended; keep last render visible
    }

    overlay.__upliftModalClose = close;   // Escape via global handler (stops tail timer)
    overlay.onclick = e => { if (e.target === overlay) close(); };
    document.body.append(overlay);
    inspectorOverlay = overlay;
    await refresh();
    timer = setInterval(refresh, 2000);   // only while open AND live
}

window.Uplift.inspector = { open: openInspector };
})();
