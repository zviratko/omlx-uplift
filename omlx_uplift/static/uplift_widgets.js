/* FE-6 step 1: one widget registry for the two form engines.

   mmeditor's seBind carried a 9-branch kind chain (select/bool/text/
   textarea/number + three inheritable variants); gsys's gsText/gsSelect/
   gsToggle re-implemented the same DOM shapes beside it. The builders
   here produce the EXACT elements (tag, attrs, order, placeholder
   wording) both hosts produced before the split — value extraction and
   state rules stay with the host (the FE-4 principle: pixels shared,
   state local).

   UMD like chartkit/gspec: require()-able in node for golden DOM tests,
   window.UpliftWidgets in the page. build(kind, o) -> {el, kind, evt};
   unknown kind returns null so a host can keep any bespoke control.

   o fields all optional unless noted:
     kind           text|textarea|bool|number|select|inheritable-*
     value          current value (already host-resolved)
     options        select: [{value, text}] — labels pre-localized by host
     selected       select: value to select (string-compared, v1 rule)
     picker         select: prepend '<v> (current)' when value not listed
     type           text: input type override (password)
     placeholder    text/number/textarea placeholder when value empty
     min max step   number attrs
     checked        bool/checkbox state
     baseVal        inheritable: base value for the '(inherited)' hint
     effHint        inheritable/number: server-default hint text
*/
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftWidgets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function build(kind, o) {
    o = o || {};
    let input;
    if (kind === 'range') {
        // gsys R10-1 range readout: a bare number input — the control IS
        // the readout; a caller placeholder stays inert like v1 gsys set it
        input = buildNumber(o);
        if (o.placeholder) input.placeholder = o.placeholder;
        return {el: input, kind: 'number', evt: 'input'};
    }
    if (kind === 'select') {
        input = document.createElement('select');
        for (const op of (o.options || [])) {
            const el = document.createElement('option');
            el.value = op.value;
            el.textContent = op.text != null ? op.text : op.value;
            if (String(o.selected) === String(op.value)) el.selected = true;
            input.append(el);
        }
        if (o.picker) {
            // draft-model picker: selected value may not be in the pool
            const cur = o.picker;
            if (cur && ![...input.options].some(el => el.value === cur)) {
                const el = document.createElement('option');
                el.value = cur;
                el.textContent = cur + ' (current)';
                el.selected = true;
                input.prepend(el);
            }
        }
    } else if (kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!o.checked;
    } else if (kind === 'text') {
        input = document.createElement('input');
        input.type = o.type || 'text';
        input.value = o.value == null ? '' : o.value;
        if (o.placeholder) input.placeholder = o.placeholder;
    } else if (kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = o.value == null ? '' : o.value;
    } else if (kind === 'inheritable-number') {
        // profile-tab number: value comes from the tab's OVERRIDES only;
        // empty = inherit, placeholder shows the base value.
        // U3: never a blind empty — base value, else the server's own default
        input = buildNumber(o);
        input.placeholder = o.baseVal != null ? String(o.baseVal) + ' (inherited)'
                                              : (o.effHint || '(default)');
        kind = 'number';
    } else if (kind === 'inheritable-text') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = o.value == null ? '' : o.value;
        if (o.baseVal != null && o.baseVal !== '') {
            input.placeholder = String(o.baseVal) + ' (inherited)';
        } else {
            input.placeholder = o.effHint || '(default)';
        }
        kind = 'text';
    } else if (kind === 'inheritable-bool') {
        // three-state: override-on / override-off / inherit (empty)
        input = document.createElement('select');
        const on = document.createElement('option');
        on.value = 'true';  on.textContent = 'Yes (override)';
        const off = document.createElement('option');
        off.value = 'false'; off.textContent = 'No (override)';
        const inh = document.createElement('option');
        const bv = o.baseVal;
        inh.value = '';
        inh.textContent = 'Inherited: ' + (bv === true ? 'Yes' : bv === false ? 'No' : '—');
        input.append(inh, on, off);
        const cur = o.value;
        input.value = cur === true || cur === 'true' ? 'true'
                    : cur === false || cur === 'false' ? 'false' : '';
    } else if (kind === 'number') {
        input = buildNumber(o);
        // placeholder rules differ per host (v1): gsys sets the caller's
        // placeholder unconditionally (inert while filled) and NEVER wants
        // a '(default)' hint; mmeditor's U3 rule replaces an EMPTY field
        // with effHint, defaulting to '(default)'. Contract: pass effHint
        // explicitly (including '' = never hint) to opt into the U3 rule.
        if (o.placeholder) input.placeholder = o.placeholder;
        if (input.value === '' && o.effHint !== undefined) {
            input.placeholder = o.effHint || '(default)';
        }
    } else {
        return null;                       // bespoke control stays with host
    }
    // event name the host should listen on (v1 seBind rule, kept exact)
    const evt = (kind === 'textarea' || kind === 'text' || kind === 'number')
        ? 'input' : 'change';
    return {el: input, kind, evt};
}

function buildNumber(o) {
    const input = document.createElement('input');
    input.type = 'number';
    if (o.min != null) input.min = o.min;
    if (o.max != null) input.max = o.max;
    if (o.step != null) input.step = o.step;
    input.value = (o.value === null || o.value === undefined) ? '' : o.value;
    return input;
}

return { build, buildNumber };
});
