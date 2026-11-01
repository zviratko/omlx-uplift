/* QA-2 class D: a disabled control must not advertise an active pointer. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

test('disabled native controls use the default cursor', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const rule = /:is\(button, select, input, textarea\):disabled\s*\{([^}]+)\}/.exec(css);
    assert.ok(rule, 'one shared disabled rule must cover buttons, selects, inputs and textareas');
    assert.match(rule[1], /cursor:\s*default/, 'disabled controls must not keep cursor:pointer');
    assert.ok(css.indexOf(rule[0]) > css.indexOf('input[type="checkbox"]'),
        'the disabled rule must follow the enabled checkbox pointer rule');
});
