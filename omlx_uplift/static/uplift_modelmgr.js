/* Uplift MODEL MANAGER — facade (SPLIT-2 2026-10-01). The page was split
   user-gated into: uplift_inspector.js (RL-2 modal), uplift_mmchips.js
   (row chips/alias tree/DELETE ops), uplift_mmtemplates.js (templates
   box + filter listeners), uplift_mmtable.js (table, sort, flags,
   confirm dialog) and uplift_mmeditor.js (settings editor, profiles,
   templates editing, divergence). This file only assembles the stable
   window.Uplift.modelmgr surface consumed by uplift.js/boot/helper/feed/
   reqsearch. Load order (index.html): ...inspector, mmchips,
   mmtemplates, mmtable, modelmgr(facade), ... */
(function () {
'use strict';
const S = window.Uplift.state;
/* FE-6 step 4: every sibling read happens AT CALL time — the old eager
   consts (mmTable, mmTemplates, mmEditor, inspector.open) pinned the
   script order in index.html; the facade now only requires that the
   module exists by the first user action. */
const T = () => window.Uplift.mmTable;
const P = () => window.Uplift.mmTemplates;
const E = () => window.Uplift.mmEditor;

window.Uplift.modelmgr = {
    render: (...a) => T().render(...a),
    renderTemplates: (...a) => P().render(...a),
    openEditor: (...a) => E().openEditor(...a),
    closeEditor: (...a) => E().closeEditor(...a),
    openInspector: (...a) => window.Uplift.inspector.open(...a),
    get adminModels() { return S.adminModels; },
    get seModel() { return E().seModel; },
    confirmDialog: (...a) => T().confirmDialog(...a),
};
P().init();
})();
