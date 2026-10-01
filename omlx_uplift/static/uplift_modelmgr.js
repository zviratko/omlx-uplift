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
const MM_TABLE = window.Uplift.mmTable;
const MM_TPL = window.Uplift.mmTemplates;
const MM_EDITOR = window.Uplift.mmEditor;

window.Uplift.modelmgr = {
    render: (...a) => MM_TABLE.render(...a),
    renderTemplates: (...a) => MM_TPL.render(...a),
    openEditor: (...a) => MM_EDITOR.openEditor(...a),
    closeEditor: (...a) => MM_EDITOR.closeEditor(...a),
    openInspector: window.Uplift.inspector.open,
    get adminModels() { return S.adminModels; },
    get seModel() { return MM_EDITOR.seModel; },
    confirmDialog: (...a) => MM_TABLE.confirmDialog(...a),
};
MM_TPL.init();
})();
