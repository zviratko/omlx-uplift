/* FE-3: pre-paint theme resolve, moved verbatim out of index.html's inline
   <script> so it joins the node-test surface (static-src.cjs enumerates
   index.html's script set). Loads synchronously in <head> AFTER core.js
   (the only import: SKIN_NAME_RE + storage-key names — core.js is
   contractually DOM-free, keep it that way).

   Runs before the first paint: sets data-theme and, for skins, injects the
   skin stylesheet link with its FINAL id ('uplift-skin-css') so
   applyPrefs() later reuses — never duplicates — this element.
   Mirrors applyPrefs() exactly (auto resolves via matchMedia; a skin needs
   its <name>-<mtime> dir: applyPrefs caches the resolved dir under
   SKIN_DIR_KEY when the listing last resolved it; an exact pinned name IS
   its own dir). No cache + base name -> leave the default, applyPrefs
   fixes it after loadSkins() as before. Failures are silent by design:
   this is a paint optimization, not an authority. */
(function () {
'use strict';
var C = (typeof window !== 'undefined' && window.UpliftCore) ||
        (typeof module !== 'undefined' && require('./core.js'));
try {
    var p = JSON.parse(localStorage.getItem(C.PREFS_KEY)) || {};
    var root = document.documentElement;
    var t = p.theme;
    if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (['light', 'dark', 'enhanced', 'cockpit'].includes(t)) {
        root.dataset.theme = t;
    } else if (typeof t === 'string' && C.SKIN_NAME_RE.test(t)) {
        var dir = /-\d{10}$/.test(t) ? t : localStorage.getItem(C.SKIN_DIR_KEY);
        if (dir && C.SKIN_NAME_RE.test(dir) && /-\d{10}$/.test(dir)) {
            root.dataset.theme = dir;
            var l = document.createElement('link');
            l.id = 'uplift-skin-css'; l.rel = 'stylesheet';
            l.href = '/uplift/api/skins/' + encodeURIComponent(dir) + '/theme.css';
            document.head.appendChild(l);
        }
    }
    if (p.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches)
        root.dataset.motion = 'off';
} catch (_) { /* storage denied / private mode: defaults stand */ }
})();
