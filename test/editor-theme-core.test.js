'use strict';

// Static parse checks for Step 7 (theme-correct editor UI) - the core-node
// half of the editor files (publish, subscribe, stream-publisher,
// stream-consumer, server, server-manager). Pure HTML/text parsing, no
// Docker/NATS/Node-RED runtime needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'nats-suite-server.html',
  'nats-suite-server-manager.html',
  'nats-suite-publish.html',
  'nats-suite-subscribe.html',
  'nats-suite-stream-publisher.html',
  'nats-suite-stream-consumer.html',
].map(name => path.join(__dirname, '..', 'nodes', name));

// The node's palette body color (RED.nodes.registerType(..., {color: '#..'}))
// is a legitimate hex literal - it is the module's own flow-canvas brand
// color and is unrelated to the dark-theme dialog bug (Node-RED renders the
// node body the same color regardless of editor theme). Every other hex
// literal in the file is the actual bug class this step fixes.
const PALETTE_COLOR_LINE = /^\s*color:\s*['"]#[0-9a-fA-F]{3,8}['"],?\s*$/m;

for (const file of FILES) {
  const html = fs.readFileSync(file, 'utf8');
  const name = path.basename(file);

  test(`${name}: zero hex color literals outside the palette color`, () => {
    const withoutPalette = html.replace(PALETTE_COLOR_LINE, '');
    const hexMatches = withoutPalette.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hexMatches, []);
  });

  test(`${name}: no inline style hardcodes a hex background/color`, () => {
    const styleAttrs = html.match(/style="[^"]*"/g) || [];
    const offenders = styleAttrs.filter(attr =>
      /#[0-9a-fA-F]{3,8}\b/.test(attr)
    );
    assert.deepEqual(offenders, []);
  });

  test(`${name}: no duplicate DOM id`, () => {
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
    const seen = new Set();
    const duplicates = ids.filter(id =>
      seen.has(id) ? true : (seen.add(id), false)
    );
    assert.deepEqual(duplicates, []);
  });

  test(`${name}: help block uses text/markdown`, () => {
    const helpTag = html.match(/<script\s+type="([^"]+)"\s+data-help-name=/);
    assert.ok(helpTag, 'no data-help-name script found');
    assert.equal(helpTag[1], 'text/markdown');
  });
}
