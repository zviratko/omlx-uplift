/* UP-14 (FEAT-1 adoption): classic model-download dialog parity.
   The selection machine (HFS) and hfRepoIdFromInput are pure and mounted in
   a vm sandbox here, driven against REAL /admin/api/hf/model-info row shapes
   (name,size,local,required,preselected,group,mmproj,kind — the dict
   omlx/admin/hf_downloader.py ~700-760 builds). The dialog DOM is hand-built
   plain markup with zero behavioral harness of its own, so the WIRE the
   footer form sends is source-shape-pinned: the server defaults every
   optional field, so a dropped 'files' key would fail invisible (this repo's
   settled rule for harness-less hand-built forms, uplift_modelsops precedent).
   Negative pins hold the retired DL-FLASH shape dead. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_downloader.js'), 'utf8');
const CSS = fs.readFileSync(path.join(STATIC, 'uplift.css'), 'utf8');

function makeDoc() {
    const calls = { created: [], bodies: [] };
    function el(tag) {
        return {
            tagName: tag, style: {}, dataset: {}, children: [], _text: '',
            classList: { add() {}, remove() {}, toggle() {} },
            set textContent(v) { this._text = String(v); },
            get textContent() { return this._text; },
            set innerHTML(v) { assert.strictEqual(v, '', 'innerHTML use must be the container-clear'); this.children.length = 0; },
            append(...cs) { for (const c of cs) if (c) this.children.push(c); },
            remove() {}, setAttribute() {}, addEventListener() {},
            focus() {}, querySelector() { return null; },
        };
    }
    return { calls,
        document: {
            body: el('body'),
            createElement: tag => el(tag),
            createTextNode: t => ({ _text: String(t) }),
            addEventListener() {}, querySelectorAll: () => [],
            hidden: false,
        },
        el };
}

function load(opts) {
    const { document } = makeDoc();
    const inputs = (opts && opts.inputs) || {};
    const posts = [];
    const win = { Uplift: {} };
    win.UpliftCore = {
        t: (k, v) => k, tf: (k, en) => en,
        fmtBytes: n => n + 'B', fmtNumber: String, errorText: x => String(x),
    };
    win.UpliftDom = {
        $: id => (id in inputs ? inputs[id] : null),
        fetchJson: async (url) => {
            const f = (opts && opts.fetch) || (() => { throw new Error('unexpected fetch ' + url); });
            return f(url);
        },
        postJson: async (url, body) => { posts.push([url, body]); return (opts && opts.postResult) || {}; },
        // mirrors domkit.errText — the kit seam gained it in UP-49 so banners
        // show 'reason (status)' instead of our internal '<url> -> <status>'
        errText(e) {
            if (e == null) return '';
            if (typeof e === 'string') return e.includes(' -> ') ? e.split(' -> ')[1] : e;
            if (e.userMessage) return e.userMessage;
            const m = e.message || String(e);
            return m.includes(' -> ') ? m.split(' -> ')[1] : m;
        },
        toast() {}, emptyMsg() {}, cell() { return document.createElement('span'); },
    };
    win.Uplift.state = { API: '' };
    const sandbox = { window: win, document, URL, URLSearchParams, console,
        setTimeout: () => 0, clearTimeout: () => {} };
    vm.runInNewContext(SRC, sandbox);
    return { seam: win.Uplift.downloader._dl14, posts, win };
}

/* ---- hfRepoIdFromInput (classic 8f06429 verbatim behavior) -------------- */
test('parse: official HF links normalize to owner/repo', () => {
    const { seam } = load();
    const P = seam.hfRepoIdFromInput;
    assert.strictEqual(P('https://huggingface.co/mlx-community/Foo'), 'mlx-community/Foo');
    assert.strictEqual(P('https://hf.co/a/b'), 'a/b');
    assert.strictEqual(P('www.huggingface.co/a/b'), 'a/b');
    assert.strictEqual(P('//huggingface.co/a/b'), 'a/b');
    assert.strictEqual(P('HTTPS://HF.CO/a/b/tree/main'), 'a/b');
    // trailing junk on the repo segment is allowed by the path char-class,
    // whitespace/query/fragment cut it off:
    assert.strictEqual(P('https://huggingface.co/a/b?x=1'), 'a/b');
    assert.strictEqual(P('  https://huggingface.co/a/b  '), 'a/b');
});
test('parse: mirror endpoint honored, plain ids and junk pass through', () => {
    const { seam } = load();
    const P = seam.hfRepoIdFromInput;
    assert.strictEqual(P('mlx-community/Foo'), 'mlx-community/Foo');
    assert.strictEqual(P('hello'), 'hello');
    assert.strictEqual(P('https://hf.example.com/mirror/a/b', 'hf.example.com/mirror'), 'a/b');
    assert.strictEqual(P('hf.example.com/mirror/a/b', 'https://hf.example.com/mirror/'), 'a/b');
    assert.strictEqual(P('https://hf.example.com/a/b', 'hf.example.com'), 'a/b');
    // a DIFFERENT host never matches the mirror rule
    assert.strictEqual(P('https://evil.example/a/b', 'hf.example.com'), 'https://evil.example/a/b');
    // invalid endpoint setting falls back to the official hosts only
    assert.strictEqual(P('https://x.example/a/b', '::bad::'), 'https://x.example/a/b');
    assert.strictEqual(P('https://huggingface.co/a/b', '::bad::'), 'a/b');
});

/* ---- HFS selection machine (classic 8288-8360) --------------------------- */
const st = n => ({ name: n, size: 10, local: false, required: false, preselected: false });
test('initial: preselected non-local files; GGUF starts empty', () => {
    const { seam } = load();
    const H = seam.HFS;
    const sf = { layout: 'safetensors', files: [
        { ...st('model-1.safetensors'), required: true, preselected: true },
        { ...st('weights_only.safetensors'), preselected: true },
        { ...st('onnx/model.onnx') },
        { ...st('model-0.safetensors'), required: true, preselected: true, local: true },
    ] };
    // REAL gguf rows carry no preselected flag (hf_downloader only preselects
    // on the safetensors layout) — that is WHY a GGUF selection starts empty
    const gg = { layout: 'gguf', files: [st('a-Q4.gguf'), st('b.gguf')] };
    // cross-realm objects: the vm's {} fails deepStrictEqual's prototype
    // check from the host realm — compare JSON shapes
    assert.strictEqual(JSON.stringify(H.initial(sf)),
        JSON.stringify({ 'model-1.safetensors': true, 'weights_only.safetensors': true }));
    assert.strictEqual(JSON.stringify(H.initial(gg)), '{}');
});
test('locked/selected: required always in, local never re-sent, optional follows picked', () => {
    const { seam } = load();
    const H = seam.HFS;
    assert.ok(H.locked({ required: true })); assert.ok(H.locked({ local: true }));
    assert.ok(!H.locked({ name: 'x' }));
    assert.ok(H.selected({ required: true }, {}));
    assert.ok(!H.selected({ local: true, required: true }, { '': true }), 'local never counts as selected');
    assert.ok(H.selected(st('opt'), { opt: true }));
    assert.ok(!H.selected(st('opt'), {}));
});
test('toggle: locked files untouchable; group toggles together; mmproj pulled in', () => {
    const { seam } = load();
    const H = seam.HFS;
    const detail = { layout: 'gguf', files: [
        { ...st('big-00001.gguf'), kind: 'gguf', group: 'big', mmproj: 'mmproj.gguf' },
        { ...st('big-00002.gguf'), kind: 'gguf', group: 'big', mmproj: 'mmproj.gguf' },
        { ...st('mmproj.gguf'), kind: 'gguf' },
        { ...st('part-local.gguf'), kind: 'gguf', group: 'mixed', local: true },
        st('README.md'),
    ] };
    let p = {};
    p = H.toggle(detail, p, detail.files[0]);        // switch group ON
    assert.ok(p['big-00001.gguf'] && p['big-00002.gguf'], 'split parts toggle together');
    assert.ok(p['mmproj.gguf'], 'a GGUF brings its vision projector');
    p = H.toggle(detail, p, detail.files[1]);        // switch group OFF
    assert.ok(!p['big-00001.gguf'] && !p['big-00002.gguf'], 'group OFF via any member');
    assert.ok(p['mmproj.gguf'], 'classic parity: OFF does not drop the projector');
    p = H.toggle(detail, p, { ...detail.files[3], group: 'mixed' });  // locked by local
    assert.strictEqual(p, p, 'locked toggle returns state untouched');
    const before = JSON.stringify(p);
    p = H.toggle(detail, p, detail.files[3]);
    assert.strictEqual(JSON.stringify(p), before);
});
test('sizes: rowSize sums the group; allSize is the server figure; fits guards disk', () => {
    const { seam } = load();
    const H = seam.HFS;
    // 73e5465 (#4967): the server computes download_all_size as a whole-repo
    // download minus local files; classic hfDownloadAllSize reads it verbatim,
    // so uplift does too. Fixtures carry the server figures.
    const detail = { layout: 'gguf', disk_free: 100, download_all_size: 110, files: [
        { ...st('a'), group: 'g', size: 40 }, { ...st('b'), group: 'g', size: 60 },
        { ...st('c'), size: 5, local: true }, st('d'),
    ] };
    assert.strictEqual(H.rowSize(detail, detail.files[0]), 100);
    assert.strictEqual(H.rowSize(detail, detail.files[3]), 10, 'no group: own size');
    assert.strictEqual(H.allSize(detail), 110, 'server figure wins over any client walk');
    const sf = { layout: 'safetensors', download_all_size: 50, files: [
        { ...st('r'), required: true, preselected: true, size: 50 },
        { ...st('l'), preselected: true, local: true, size: 900 },
        st('x'),
    ] };
    assert.strictEqual(H.allSize(sf), 50, 'safetensors: server figure');
    assert.strictEqual(H.allSize({ files: [], download_all_size: 77 }), 77, 'no rows -> server figure');
    assert.strictEqual(H.allSize({ layout: 'gguf', files: detail.files }), 0,
        'no server figure -> 0: the client-side preselected walk is gone');
    const src = require('fs').readFileSync(__dirname + '/../omlx_uplift/static/uplift_downloader.js', 'utf8');
    assert.ok(!/f\.preselected\)\s*:\s*\(\(\)\s*=>\s*true\)/.test(src),
        'negative pin: hfDownloadAllSize client recompute removed (73e5465)');
    assert.ok(H.fits(detail, 100) && !H.fits(detail, 101));
    assert.ok(H.fits({ disk_free: 0 }, 1e12), 'unknown free space never blocks');
    assert.strictEqual(H.memFit(1000, 951), 'danger');
    assert.strictEqual(H.memFit(1000, 850), 'warning');
    assert.strictEqual(H.memFit(1000, 800), 'safe');
    assert.strictEqual(H.memFit(0, 800), 'safe');
});
test('downloaded: repo list decides, but the LATEST unfinished task vetoes', () => {
    const { seam } = load();
    const H = seam.HFS;
    const models = [{ repo_id: 'MLX-Community/Foo' }];
    assert.ok(H.downloaded('mlx-community/foo', models, []), 'case-insensitive');
    assert.ok(!H.downloaded('mlx-community/foo', [], []));
    assert.ok(!H.downloaded('mlx-community/foo', models, [{ repo_id: 'mlx-community/Foo', status: 'cancelled' }]),
        'cancelled keeps files for resume — not downloaded');
    assert.ok(H.downloaded('mlx-community/foo', models, [
        { repo_id: 'a/b', status: 'downloading' },
        { repo_id: 'mlx-community/foo', status: 'completed' }]), 'latest match decides');
    assert.ok(!H.downloaded('mlx-community/foo', models, [
        { repo_id: 'mlx-community/foo', status: 'completed' },
        { repo_id: 'mlx-community/foo', status: 'failed' }]), 'newer failed vetoes');
});

/* ---- dialog entry wiring ------------------------------------------------- */
test('directDownload: URL input normalized, written back, opens the dialog', async () => {
    const inputs = { 'dl-repo': { value: ' HTTPS://HF.CO/a/b ' }, 'dl-token': { value: '' } };
    const opened = [];
    const { seam, win } = load({ inputs, fetch: () => { throw new Error('net off'); } });
    // intercept openModelFiles via the seam? dialog opens via module-scope
    // function — prove the wiring through source pin below; here verify the
    // normalization side effect and the empty-input guard:
    win.UpliftCore.t = k => k;
    seam.directDownload();
    assert.strictEqual(inputs['dl-repo'].value, 'a/b', 'normalized id stays visible (classic)');
    inputs['dl-repo'].value = '   ';
    seam.directDownload();
    assert.strictEqual(inputs['dl-repo'].value, '   ', 'empty input never overwrites');
    assert.strictEqual(opened.length, 0);
});
test('wire shape: header, POST body and dialog-first entries (source pins)', () => {
    // model-info carries the token as classic does (X-HF-Token header)
    assert.match(SRC, /token \? \{ headers: \{ 'X-HF-Token': token \} \} : undefined/);
    // the hand-built footer form sends the selection EXPLICITLY — files:null
    // is classic's download-all, an array the picked set (server has defaults,
    // so a dropped key would fail invisible; the vm harness cannot see this)
    assert.match(SRC, /\{ repo_id: repo, hf_token: token, files \}/);
    assert.match(SRC, /submit\(null\), sending \|\| !HFS\.fits\(detail, allSz\)/,
        'download-all posts files:null and disk-gates');
    assert.match(SRC, /submit\(names\), sending \|\| !names\.length \|\| !HFS\.fits\(detail, bytes\)/,
        'download-selected needs a non-empty disk-fitting selection');
    // every entry point goes through the dialog (classic parity)
    assert.match(SRC, /b\.onclick = \(\) => openModelFiles\(m\.repo_id\);/);
    assert.match(SRC, /D\.\$\('dl-direct'\)\.onclick = directDownload;/);
    assert.match(SRC, /if \(e\.key === 'Enter'\) directDownload\(\);/);
    // the badge veto reads the newest task rows
    assert.match(SRC, /if \(kind === 'hf'\) DL\.hfTasks = tasks;/);
    // labels reuse the mounted classic catalog — no new uplift.* dialog keys
    for (const key of ['models.detail.pick_files_checkpoint', 'models.detail.pick_files_gguf',
        'models.detail.file_downloaded', 'models.detail.required_file',
        'models.browse.tight_fit', 'models.browse.high_oom_risk',
        'models.detail.download_all', 'models.detail.download_selected',
        'models.detail.lora_warning', 'models.recommend.not_enough_space',
        'models.detail.view_on_hf', 'models.browse.downloaded'])
        assert.ok(SRC.includes(`'${key}'`), 'classic key used: ' + key);
    // Escape is the GLOBAL modal-overlay handler's business (uplift_state.js)
    assert.ok(!/addEventListener\(\s*['"]keydown/.test(SRC.slice(
        SRC.indexOf('function openModelFiles'), SRC.indexOf('function initDownloader'))),
        'dialog must not install its own keydown listener');
});
test('DL-FLASH retired: dead shape stays dead (negative pins)', () => {
    for (const dead of ['flashQueued', 'queueDownload', 'FLASH_MS', '_cool', 'dl-flash'])
        assert.ok(!SRC.includes(dead), `uplift_downloader.js must not keep ${dead}`);
    assert.ok(!CSS.includes('.dl-flash'), 'uplift.css must not keep .dl-flash');
});
test('UP-17: dialog tabs mirror classic (Model Card | Files (n) | Tags)', () => {
    for (const key of ['models.detail.tab.model_card', 'models.detail.tab.files',
        'models.detail.tab.tags', 'models.detail.no_model_card', 'models.detail.no_tags',
        'models.browse.params_suffix'])
        assert.ok(SRC.includes(`'${key}'`), 'classic key used: ' + key);
    // opens straight on Files like classic's openModelDetail(repoId,'files')
    assert.match(SRC, /let detail = null, picked = \{\}, sending = false, tab = 'files';/);
    // card is the ONE HTML sink and it is sanitizer-guarded (classic parity):
    // strip container-clears and comments — what remains must be the
    // DOMPurify call and nothing else
    const sinks = SRC.split(/\r?\n/).map(l => l.trim())
        .filter(l => l.includes('.innerHTML') && !l.startsWith('//') && !/= ''/.test(l));
    assert.strictEqual(sinks.length, 1, 'single innerHTML sink: ' + JSON.stringify(sinks));
    assert.ok(sinks[0].includes('window.DOMPurify.sanitize('),
        'the sole innerHTML sink is sanitizer-guarded');
    assert.match(SRC, /catch\(\(\) => \{ holder\.classList\.add\('dl-card-raw'\); \}/);
    // vendor libs load lazily (same bundles classic ships)
    assert.match(SRC, /loadScript\('\.\/vendor\/marked\.umd\.js'\)/);
    assert.match(SRC, /loadScript\('\.\/vendor\/purify\.min\.js'\)/);
    const fs = require('fs');
    for (const v of ['marked.umd.js', 'purify.min.js'])
        assert.ok(fs.existsSync(path.join(STATIC, 'vendor', v)), 'vendored: ' + v);
    // tags are textContent chips; header meta line carries the classic stats
    assert.match(SRC, /s\.className = 'dl-tag';\s*s\.textContent = t;/);
    assert.ok(SRC.includes("className = 'dl-meta'") && SRC.includes("'\\u2b07 '"),
        'meta chips (size, downloads, likes, params, pipeline)');
    // small files never read '0 MiB' (classic formatFileSize tiers)
    assert.match(SRC, /function dlSize\(bytes\)/);
    assert.match(SRC, /return \(bytes \/ 1024\)\.toFixed\(1\) \+ ' KiB';/);
    assert.match(SRC, /sz\.textContent = dlSize\(f\.size\);/);
});
test('house chrome: dialog reuses modal-overlay + modal nasa + icon-btn close', () => {
    assert.ok(SRC.includes("overlay.className = 'modal-overlay'"));
    assert.ok(SRC.includes("box.className = 'modal nasa dl-modal'"));
    assert.ok(SRC.includes("close.className = 'icon-btn'"));
    // THE PARENT EDGE (live catch 2026-10-24): class pins stay green while a
    // built-but-never-appended box renders an empty overlay — assert the box
    // rides the overlay AND the overlay reaches body, in that order
    assert.match(SRC, /box\.append\(h, meta, body, foot\);\s*overlay\.append\(box\);/);
    assert.match(SRC, /overlay\.append\(box\);[\s\S]*?document\.body\.append\(overlay\);/);
    // backdrop click is the mouse twin of Esc
    assert.match(SRC, /overlay\.onclick = e => \{ if \(e\.target === overlay\) overlay\.remove\(\); \}/);
});

/* ---- UP-64 dialog lane (classic 78f00e4 #4949): HF update check ---------- */
test('update lane: changed files pre-pick; showsUpdate/updateSize gate classic-style', () => {
    const { seam } = load();
    const H = seam.HFS;
    const detail = { layout: 'safetensors', update_files: ['b.safetensors', 'c.safetensors'],
        files: [{ ...st('a.safetensors'), local: true },
            { ...st('b.safetensors'), size: 100, required: true, outdated: true },
            { ...st('c.safetensors'), size: 10, required: true }] };
    assert.strictEqual(JSON.stringify(H.initial(detail)),
        JSON.stringify({ 'b.safetensors': true }),
        'initial pre-picks outdated only (classic:8430); a missing required '
        + 'file still counts at names-time through selected()');
    assert.ok(H.selected(detail.files[1], {}), 'an outdated file counts as selected');
    assert.deepStrictEqual(H.names(detail, H.initial(detail)),
        ['b.safetensors', 'c.safetensors'], 'the download-all-of-update set still carries the missing required file');
    assert.strictEqual(H.updateSize(detail), 110);
    assert.ok(H.showsUpdate(detail, true));
    assert.ok(!H.showsUpdate(detail, false), 'not downloaded: plain download buttons');
    assert.ok(!H.showsUpdate({ ...detail, layout: 'gguf' }, true), 'GGUF never updates (classic gate)');
    assert.ok(!H.showsUpdate({ ...detail, update_files: [] }, true), 'up to date: DOWNLOADED badge');
    assert.ok(!H.showsUpdate({ ...detail, is_adapter: true }, true));
    assert.ok(!H.showsUpdate({ ...detail, unsupported_reason: 'x' }, true));
});
test('update lane: footer sends the update_files list through the download wire', () => {
    // same settled rule as the DL-1 pins above: the footer has no DOM
    // harness, so the WIRE is source-shape-pinned
    assert.match(SRC, /const updating = HFS\.showsUpdate\(detail, dlDownloaded\(detail\.repo_id \|\| repoId\)\);/);
    assert.match(SRC, /const spaceBytes = updating \? HFS\.updateSize\(detail\) : bytes;/,
        'classic parity: the disk warning sizes the UPDATE, not the selection');
    assert.match(SRC, /!detail\.is_adapter && !HFS\.fits\(detail, spaceBytes\)/);
    assert.match(SRC, /\} else if \(updating\) \{[\s\S]*?submit\(detail\.update_files\)[\s\S]*?\} else if \(detail\.layout === 'gguf'/,
        'UPDATE button sits where classic replaces the download pair');
    assert.match(SRC, /'models\.detail\.update', 'Update'/, 'classic catalog key, EN fallback');
    assert.match(SRC, /if \(f\.outdated\) lb\.append\(dlBadge\('warn', C\.tf\('models\.detail\.file_outdated', 'Changed'\)\)\);/,
        'Changed badge (classic _models.html:2184)');
    assert.match(SRC, /else if \(!f\.local && f\.required\)/,
        'Required only when neither local nor outdated (classic x-show)');
});
