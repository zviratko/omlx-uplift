/* SPLIT-2 stage 3 (uplift_modelmgr.js split): the Global templates box
   and the Models-tab filter controls. Editor-side calls (confirmDialog,
   openEditor) late-bind through the modelmgr facade — init() runs from
   the facade tail, listener bodies at user-interaction time. Exports
   window.Uplift.mmTemplates. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const $ = D.$;
const API = window.Uplift.state.API;
const S = window.Uplift.state;
const MM_GLUE = { fetchJson: D.fetchJson, cell: D.cell };
const MMF = {
    get confirmDialog() { return (...a) => window.Uplift.modelmgr.confirmDialog(...a); },
    get openEditor() { return (...a) => window.Uplift.modelmgr.openEditor(...a); },
    get closeEditor() { return (...a) => window.Uplift.modelmgr.closeEditor(...a); },
    get render() { return (...a) => window.Uplift.modelmgr.render(...a); },
    get seModel() { return window.Uplift.modelmgr.seModel; },
};
/* Global templates (global_templates.json): slim model-style rows. The old
   description+date view said nothing useful (round 5) — a template is a
   settings bundle, so the row gets EDIT (opens the same editor on the
   template) and DELETE SETTINGS (removes the stored bundle). */
function renderTemplatesBox() {
    const host = $('ms-templates');
    if (!host) return;
    MM_GLUE.fetchJson(`${API}/admin/api/profile-templates`)
        .then(d => d.templates || []).catch(() => []).then(templates => {
        host.innerHTML = '';   // empty string + static markup only, no user data
        if (!templates.length) { D.emptyMsg(host, 'No global templates'); return; }
        window.__seTemplates = templates;
        for (const t of templates) {
            const row = document.createElement('div'); row.className = 'urow admin tpl';
            const name = document.createElement('span'); name.className = 'uname';
            const head1 = document.createElement('span'); head1.className = 'nrow1';
            const badge = document.createElement('span');
            badge.className = 'typebadge t-tpl'; badge.textContent = 'TEMPLATE';
            const nmain = document.createElement('span'); nmain.className = 'nmain';
            const uid = MM_GLUE.cell(t.display_name || t.name); uid.className = 'uid';
            // round 8 item 4: show the friendly name like models do — the
            // raw t-… id is an internal key (shown in EDIT/delete dialogs)
            uid.title = t.name;
            nmain.append(badge, uid);   // round 6 item 10: no copy icon for the internal id
            const desc = MM_GLUE.cell(t.description || ''); desc.className = 'dim umeta tpl-desc';
            head1.append(desc);
            name.append(nmain, head1);
            const box = document.createElement('span');
            box.className = 'settings-box hrow tpl-box solo';
            const aDel = document.createElement('span'); aDel.className = 'act-col';
            const del = document.createElement('button');
            del.className = 'se-btn act danger'; del.textContent = 'DELETE SETTINGS';
            del.title = C.tf('uplift.ui.delete_global_template',
                'Delete this global template (stored settings bundle)');
            del.onclick = () => MMF.confirmDialog('Delete template',
                `Delete the global template "${t.display_name || t.name}"? Models and profiles already created from it keep their own settings.`,
                async () => {
                    await D.deleteJson(`${API}/admin/api/profile-templates/${encodeURIComponent(t.name)}`);
                }, `Deleted template: ${t.display_name || t.name}`);
            aDel.append(del);
            const aEdit = document.createElement('span'); aEdit.className = 'act-col right';
            const ed = document.createElement('button');
            ed.className = 'se-btn act edit'; ed.textContent = 'EDIT';
            ed.title = C.tf('uplift.ui.edit_global_template', 'Edit this template');
            ed.onclick = () => MMF.openEditor(null, null, t.name);
            aEdit.append(ed);
            box.append(aDel, document.createElement('span'), aEdit);
            row.append(name, box);
            host.append(row);
        }
    });
}
function init() {
    $('ma-filter').oninput = () => {
        // the filter felt dead while the editor was open: close the editor on filter
        if (MMF.seModel) MMF.closeEditor();
        MMF.render(true);
    };
    $('ma-type').onchange = () => { if (MMF.seModel) MMF.closeEditor(); MMF.render(true); };
    $('ma-only-loaded').onchange = () => { if (MMF.seModel) MMF.closeEditor(); MMF.render(true); };
    $('ma-only-fav').onchange = () => { if (MMF.seModel) MMF.closeEditor(); MMF.render(true); };
    $('ma-present-only').onchange = () => { if (MMF.seModel) MMF.closeEditor(); MMF.render(true); };
}

window.Uplift.mmTemplates = { render: renderTemplatesBox, init: init };
})();
