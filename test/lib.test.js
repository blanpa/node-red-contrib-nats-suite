'use strict';

// Unit tests for the pure lib/ helpers extracted in Step 5 - no NATS, no
// Docker, no Node-RED runtime. attachStatus/resolveServer are exercised
// against minimal fake node/RED/config-node objects rather than a real
// deployed node, per the skill's "test the right layer" guidance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');
const { toPayload, fromMsg } = require('../lib/payload');
const { parseDuration, parseSize } = require('../lib/duration');

function fakeNode() {
  return {
    errors: [],
    statuses: [],
    error(msg) {
      this.errors.push(msg);
    },
    status(s) {
      this.statuses.push(s);
    },
  };
}

// --- lib/connect.js ------------------------------------------------------

test('resolveServer: no config.server -> errors, paints no-server, returns undefined', () => {
  const node = fakeNode();
  const RED = { nodes: { getNode: () => null } };
  const result = resolveServer(RED, node, {});
  assert.equal(result, undefined);
  assert.equal(node.errors.length, 1);
  assert.deepEqual(node.statuses[0], {
    fill: 'red',
    shape: 'ring',
    text: 'no server',
  });
});

test('resolveServer: config.server set but RED.nodes.getNode() returns null -> errors, paints not-found', () => {
  const node = fakeNode();
  const RED = { nodes: { getNode: () => null } };
  const result = resolveServer(RED, node, { server: 'srv1' });
  assert.equal(result, undefined);
  assert.equal(node.errors.length, 1);
  assert.deepEqual(node.statuses[0], {
    fill: 'red',
    shape: 'ring',
    text: 'server not found',
  });
});

test('resolveServer: server resolves -> returns the config node, no error/status painted', () => {
  const node = fakeNode();
  const serverConfig = { id: 'srv1' };
  const RED = {
    nodes: { getNode: id => (id === 'srv1' ? serverConfig : null) },
  };
  const result = resolveServer(RED, node, { server: 'srv1' });
  assert.equal(result, serverConfig);
  assert.equal(node.errors.length, 0);
  assert.equal(node.statuses.length, 0);
});

// --- lib/status.js --------------------------------------------------------

function fakeServerConfig() {
  let listener;
  return {
    addStatusListener(l) {
      listener = l;
    },
    removeStatusListener(l) {
      assert.equal(
        l,
        listener,
        'detach must remove the same listener that was added'
      );
      listener = null;
    },
    emit(statusInfo) {
      listener(statusInfo);
    },
    get attached() {
      return listener != null;
    },
  };
}

test('attachStatus: default paint for connected/disconnected/connecting, both string and object status forms', () => {
  const node = fakeNode();
  const cfg = fakeServerConfig();
  attachStatus(node, cfg);

  cfg.emit('connected');
  assert.deepEqual(node.statuses.at(-1), {
    fill: 'green',
    shape: 'dot',
    text: 'connected',
  });

  cfg.emit({ status: 'disconnected', reconnectAttempts: 3 });
  assert.deepEqual(node.statuses.at(-1), {
    fill: 'red',
    shape: 'ring',
    text: 'disconnected',
  });

  cfg.emit('connecting');
  assert.deepEqual(node.statuses.at(-1), {
    fill: 'yellow',
    shape: 'ring',
    text: 'connecting',
  });
});

test('attachStatus: unrecognized status is silently ignored (no paint, no throw)', () => {
  const node = fakeNode();
  const cfg = fakeServerConfig();
  attachStatus(node, cfg);
  cfg.emit('slowConsumer');
  assert.equal(node.statuses.length, 0);
});

test('attachStatus: a per-state handler overrides the default paint entirely', () => {
  const node = fakeNode();
  const cfg = fakeServerConfig();
  const seen = [];
  attachStatus(node, cfg, {
    connected: statusInfo => seen.push(statusInfo),
  });

  cfg.emit({ status: 'connected', reconnectAttempts: 0 });
  assert.deepEqual(seen, [{ status: 'connected', reconnectAttempts: 0 }]);
  assert.equal(
    node.statuses.length,
    0,
    'default paint must not run when a handler is provided'
  );

  // States without a handler still fall back to the default paint.
  cfg.emit('disconnected');
  assert.deepEqual(node.statuses.at(-1), {
    fill: 'red',
    shape: 'ring',
    text: 'disconnected',
  });
});

test('attachStatus: detach() removes the listener from the config node', () => {
  const node = fakeNode();
  const cfg = fakeServerConfig();
  const detach = attachStatus(node, cfg);
  assert.equal(cfg.attached, true);
  detach();
  assert.equal(cfg.attached, false);
});

// --- lib/payload.js ---------------------------------------------------------

test('toPayload: Uint8Array passes through untouched', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(toPayload(bytes), bytes);
});

test('toPayload: object is JSON-stringified', () => {
  assert.equal(toPayload({ a: 1 }), '{"a":1}');
});

test('toPayload: string and number are coerced with String()', () => {
  assert.equal(toPayload('hello'), 'hello');
  assert.equal(toPayload(42), '42');
});

function fakeMsg({ string, json, data }) {
  return {
    string: () => (string instanceof Error ? throwIt(string) : string),
    json: () => (json instanceof Error ? throwIt(json) : json),
    data,
  };
}
function throwIt(err) {
  throw err;
}

test('fromMsg: json mode calls msg.json() and propagates a parse failure', () => {
  assert.equal(fromMsg(fakeMsg({ json: { a: 1 } }), 'json').a, 1);
  assert.throws(
    () => fromMsg(fakeMsg({ json: new SyntaxError('bad json') }), 'json'),
    SyntaxError
  );
});

test('fromMsg: string mode calls msg.string()', () => {
  assert.equal(fromMsg(fakeMsg({ string: 'hello' }), 'string'), 'hello');
});

test('fromMsg: buffer mode returns msg.data untouched', () => {
  const data = new Uint8Array([9]);
  assert.equal(fromMsg(fakeMsg({ data }), 'buffer'), data);
});

test('fromMsg: auto mode parses JSON when possible, falls back to the raw string, never throws', () => {
  assert.deepEqual(fromMsg(fakeMsg({ string: '{"a":1}' }), 'auto'), { a: 1 });
  assert.equal(fromMsg(fakeMsg({ string: 'not json' }), 'auto'), 'not json');
  assert.equal(fromMsg(fakeMsg({ string: '' }), 'auto'), '');
});

test('fromMsg: an unrecognized format behaves like auto', () => {
  assert.deepEqual(fromMsg(fakeMsg({ string: '{"a":1}' }), 'nonsense'), {
    a: 1,
  });
});

// --- lib/duration.js ---------------------------------------------------------

test('parseDuration: converts s/m/h/d to nanoseconds', () => {
  assert.equal(parseDuration('30s'), 30 * 1e9);
  assert.equal(parseDuration('5m'), 5 * 60 * 1e9);
  assert.equal(parseDuration('2h'), 2 * 3600 * 1e9);
  assert.equal(parseDuration('1d'), 86400 * 1e9);
});

test('parseDuration: missing or malformed input returns 0', () => {
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(undefined), 0);
  assert.equal(parseDuration('not-a-duration'), 0);
  assert.equal(parseDuration('30x'), 0);
});

test('parseSize: converts KB/MB/GB/B (case-insensitive) to bytes, bare number defaults to bytes', () => {
  assert.equal(parseSize('100'), 100);
  assert.equal(parseSize('100B'), 100);
  assert.equal(parseSize('512KB'), 512 * 1024);
  assert.equal(parseSize('10MB'), 10 * 1024 * 1024);
  assert.equal(parseSize('1GB'), 1024 * 1024 * 1024);
  assert.equal(parseSize('1gb'), 1024 * 1024 * 1024);
});

test('parseSize: missing or malformed input returns undefined (caller skips the field)', () => {
  assert.equal(parseSize(''), undefined);
  assert.equal(parseSize(undefined), undefined);
  assert.equal(parseSize('1TB'), undefined);
  assert.equal(parseSize('big'), undefined);
});
