'use strict';

// Step 7 theme checks for the kv-get/kv-put/object-get/object-put/service
// editor dialogs: no hardcoded colors (the bug this step fixes - a hardcoded
// background wins over the theme while the text color still comes from it),
// no leftover inline background/color style overrides, and no duplicate DOM
// ids (which silently breaks jQuery's .val() get/set for whichever id
// collides). defaults<->DOM control parity is already covered for every
// registered node, including these five, by promotion.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const FILES = [
  'nodes/nats-suite-kv-get.html',
  'nodes/nats-suite-kv-put.html',
  'nodes/nats-suite-object-get.html',
  'nodes/nats-suite-object-put.html',
  'nodes/nats-suite-service.html',
];

// The node's own palette-color swatch (RED.nodes.registerType's `color`
// option) is a legitimate hex literal - it's a static category-identity
// color every Node-RED node declares, unrelated to the dialog's theming and
// never affected by the light/dark theme bug. Skip only that one line.
function stripPaletteColor(html) {
  return html.replace(/^\s*color:\s*['"]#[0-9a-fA-F]{3,6}['"],?\s*$/m, '');
}

test('kv/object/service editor dialogs use theme variables, not hardcoded colors', () => {
  for (const relativePath of FILES) {
    const html = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const withoutPaletteColor = stripPaletteColor(html);

    assert.equal(
      withoutPaletteColor.match(/#[0-9a-fA-F]{3,6}\b/g),
      null,
      `${relativePath}: hardcoded hex color literal found outside the palette color`
    );
    assert.equal(
      html.match(/style\s*=\s*["'][^"']*(?:background|color)\s*:/i),
      null,
      `${relativePath}: inline style sets background/color directly`
    );
    assert.equal(
      html.match(/<style[\s>]/i),
      null,
      `${relativePath}: bespoke <style> block still present`
    );
  }
});

test('kv/object/service editor dialogs have no duplicate DOM ids', () => {
  for (const relativePath of FILES) {
    const html = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
    const seen = new Set();
    for (const id of ids) {
      assert.ok(!seen.has(id), `${relativePath}: duplicate id "${id}"`);
      seen.add(id);
    }
  }
});
