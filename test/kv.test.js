'use strict';

// Node-layer tests for nats-suite-kv-get / nats-suite-kv-put against the real
// dockerized Node-RED + NATS stack, proving the @nats-io/kv (Kvm) migration
// actually works: put -> get round-trip, history, and watch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Kvm } = require('@nats-io/kv');
const {
  NODE_RED_URL,
  NATS_CONTAINER_URL,
  ensureStackUp,
  deployFlow,
  deleteFlow,
  connectComms,
  connectDirectNats,
  triggerInject,
} = require('./lib/harness');

// connectComms().waitForDebug() resolves one waiter per call and only
// registers the next one after the previous resolves - fine for events
// that arrive one at a time, but two debug broadcasts that land in the same
// /comms websocket frame (e.g. two already-buffered KV history entries
// replayed back-to-back with ~0ms apart) get processed in one synchronous
// loop: the first message consumes the only waiter, and the second message
// finds none registered yet and is silently dropped. Collecting a known
// count of rapid-fire debug messages needs its own listener instead of N
// sequential waitForDebug() calls.
function collectDebugMessages(nodeId, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${NODE_RED_URL.replace(/^http/, 'ws')}/comms`);
    const collected = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for ${count} debug messages from "${nodeId}" (got ${collected.length})`
        )
      );
    }, timeoutMs);
    ws.onmessage = ev => {
      for (const { topic, data } of JSON.parse(ev.data)) {
        if (topic !== 'debug' || data.id !== nodeId) continue;
        collected.push(JSON.parse(data.msg));
        if (collected.length >= count) {
          clearTimeout(timer);
          ws.close();
          resolve(collected);
        }
      }
    };
    ws.onerror = err => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

async function ignoreFailure(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

// Each test creates a real JetStream-backed KV bucket on the shared dev
// broker; leaving them undestroyed accumulates stream state across runs
// (unlike deleteFlow(), which only removes the Node-RED flow, not the
// bucket it created).
const destroyBucket = async bucket => {
  const nc = await connectDirectNats();
  try {
    let kv;
    try {
      kv = await new Kvm(nc).open(bucket);
    } catch {
      kv = null;
    }
    if (kv) await kv.destroy();
  } finally {
    await ignoreFailure(nc.close());
  }
};

const serverNode = id => ({
  id,
  type: 'nats-suite-server',
  server: NATS_CONTAINER_URL,
  authMethod: 'none',
  enableTLS: false,
  tlsRejectUnauthorized: true,
  reconnectTimeWait: 1000,
  timeout: 10000,
  pingInterval: 30000,
  maxPingOut: 3,
  debug: false,
});

test('kv put -> get round-trip, with history', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_${Date.now().toString(36)}`;
  const key = 'widget';

  const nodes = [
    serverNode('kv-srv'),
    {
      id: 'kv-put',
      type: 'nats-suite-kv-put',
      z: 'FLOW',
      server: 'kv-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      operation: 'put',
      keyFrom: 'config',
      key,
      valueFrom: 'config',
      value: JSON.stringify({ n: 1 }),
      stringifyJSON: false,
      debug: false,
      wires: [['kv-put-debug']],
    },
    {
      id: 'kv-put-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kv-get',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kv-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      mode: 'get',
      keyFrom: 'config',
      key,
      includeHistory: true,
      historyLimit: 5,
      ignoreDeletes: true,
      parseJSON: true,
      debug: false,
      wires: [['kv-debug']],
    },
    {
      id: 'kv-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kv-inject-put',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kv-put']],
    },
    {
      id: 'kv-inject-get',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kv-get']],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;

    // kv-put/kv-get don't paint a "connected" status of their own (unlike
    // publish/subscribe) - they only turn green after a successful
    // operation, so the only pre-condition to wait on here is the server.
    const srvConnected = comms.waitForStatus(
      'kv-srv',
      d => d.fill === 'green',
      20000
    );

    flowId = await deployFlow(nodes);
    await srvConnected;

    const putDone = comms.waitForDebug('kv-put-debug', 10000);
    await triggerInject('kv-inject-put');
    await putDone;

    const firstGet = comms.waitForDebug('kv-debug', 10000);
    await triggerInject('kv-inject-get');
    const firstMsg = await firstGet;
    assert.deepEqual(
      firstMsg.payload,
      { n: 1 },
      'kv-get should retrieve the JSON value kv-put stored'
    );
    assert.equal(firstMsg.key, key);
    assert.equal(firstMsg.bucket, bucket);
    assert.equal(typeof firstMsg.revision, 'number');
    assert.ok(
      Array.isArray(firstMsg._history) && firstMsg._history.length >= 1,
      'includeHistory should attach at least one entry'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

test('kv history accumulates revisions for repeated puts to the same key', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_hist_${Date.now().toString(36)}`;
  const key = 'counter';

  const nodes = [
    serverNode('kvh-srv'),
    {
      id: 'kvh-put',
      type: 'nats-suite-kv-put',
      z: 'FLOW',
      server: 'kvh-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      operation: 'put',
      keyFrom: 'config',
      key,
      valueFrom: 'config',
      value: 'v1',
      stringifyJSON: false,
      debug: false,
      wires: [['kvh-put-debug']],
    },
    {
      id: 'kvh-put-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kvh-get',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kvh-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      mode: 'get',
      keyFrom: 'config',
      key,
      includeHistory: true,
      historyLimit: 10,
      ignoreDeletes: true,
      parseJSON: false,
      debug: false,
      wires: [['kvh-debug']],
    },
    {
      id: 'kvh-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kvh-inject-put',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kvh-put']],
    },
    {
      id: 'kvh-inject-get',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kvh-get']],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;

    const connected = d => d.fill === 'green';
    const srvConnected = comms.waitForStatus('kvh-srv', connected, 20000);
    flowId = await deployFlow(nodes);
    await srvConnected;

    // Put the same key 3 times (value fixed by config = 'v1'); the server
    // still bumps the revision each time, which is all history needs to
    // grow. Wait for each put's own debug output before firing the next,
    // rather than a fixed sleep, so ordering is driven by an observable
    // completion signal.
    for (let i = 0; i < 3; i++) {
      const putDone = comms.waitForDebug('kvh-put-debug', 10000);
      await triggerInject('kvh-inject-put');
      await putDone;
    }

    const got = comms.waitForDebug('kvh-debug', 10000);
    await triggerInject('kvh-inject-get');
    const msg = await got;

    assert.ok(Array.isArray(msg._history), 'history array should be present');
    assert.ok(
      msg._history.length >= 3,
      `expected at least 3 history entries, got ${msg._history.length}`
    );
    assert.equal(msg._history[0].operation, 'PUT');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

test('kv watch mode emits an event when another node puts to the bucket', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_watch_${Date.now().toString(36)}`;
  const key = 'signal';

  const nodes = [
    serverNode('kvw-srv'),
    {
      id: 'kvw-watch',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kvw-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      mode: 'watch',
      keyFrom: 'config',
      key: '',
      watchPattern: key,
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: false,
      debug: false,
      wires: [['kvw-debug']],
    },
    {
      id: 'kvw-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kvw-put',
      type: 'nats-suite-kv-put',
      z: 'FLOW',
      server: 'kvw-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      operation: 'put',
      keyFrom: 'config',
      key,
      valueFrom: 'config',
      value: 'triggered',
      stringifyJSON: false,
      debug: false,
      wires: [[]],
    },
    {
      id: 'kvw-inject',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kvw-put']],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;

    const connected = d => d.fill === 'green';
    const srvConnected = comms.waitForStatus('kvw-srv', connected, 20000);
    const watching = comms.waitForStatus(
      'kvw-watch',
      d => d.text === 'watching',
      20000
    );

    flowId = await deployFlow(nodes);
    await srvConnected;
    await watching;

    const watchEvent = comms.waitForDebug('kvw-debug', 10000);
    await triggerInject('kvw-inject');
    const msg = await watchEvent;

    assert.equal(msg.key, key);
    assert.equal(msg.payload, 'triggered');
    assert.equal(msg.operation, 'PUT');
    assert.equal(msg._watchEvent, true);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

// Step 8 (NATS-3.4-GAP-PLAN.md): KV per-key marker TTL + advanced watch
// options. Two distinct markerTTL settings: bucketMarkerTTL (a bucket-level
// millisecond number that must be non-zero before per-key markers work at
// all - confirmed against a real broker that create() otherwise rejects
// with "per-message TTL is disabled") and createMarkerTTL (a per-call Go
// duration string on the `create` operation only).
test('kv create with bucketMarkerTTL enabled accepts a per-call createMarkerTTL', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_marker_${Date.now().toString(36)}`;
  const key = 'ttl-key';

  const nodes = [
    serverNode('kvm-srv'),
    {
      id: 'kvm-put',
      type: 'nats-suite-kv-put',
      z: 'FLOW',
      server: 'kvm-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      bucketMarkerTTL: 60000,
      operation: 'create',
      keyFrom: 'config',
      key,
      valueFrom: 'config',
      value: 'marked-value',
      stringifyJSON: false,
      createMarkerTTL: '10s',
      debug: false,
      wires: [['kvm-debug']],
    },
    {
      id: 'kvm-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kvm-inject',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kvm-put']],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;
    const srvConnected = comms.waitForStatus(
      'kvm-srv',
      d => d.fill === 'green',
      20000
    );
    flowId = await deployFlow(nodes);
    await srvConnected;

    const created = comms.waitForDebug('kvm-debug', 10000);
    await triggerInject('kvm-inject');
    const msg = await created;

    assert.equal(msg.operation, 'PUT');
    assert.equal(msg._created, true);

    // markerTTL (bucket-level "delete-marker" retention) has no client-
    // visible per-key header or introspection - checked directly against a
    // real broker: neither a live entry's nor its delete-marker's headers
    // ever expose it, with or without a per-call value. So this only proves
    // create() accepted the per-call string without the server rejecting
    // it (a real, if weaker, proof - a bad Go-duration string does throw)
    // and that the bucket-level flag it depends on is really set; it can't
    // prove the per-call "10s" differs from the bucket's 60s default
    // without waiting out both TTLs for real.
    const nc = await connectDirectNats();
    try {
      const kv = await new Kvm(nc).open(bucket);
      const status = await kv.status();
      assert.equal(status.markerTTL, 60000);
    } finally {
      await ignoreFailure(nc.close());
    }
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

test('kv watch with headersOnly delivers no payload but reports the real length', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_hdrs_${Date.now().toString(36)}`;
  const key = 'hdrs-key';
  const value = 'this-value-has-a-known-length';

  const nodes = [
    serverNode('kvh-srv'),
    {
      id: 'kvh-watch',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kvh-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      mode: 'watch',
      keyFrom: 'config',
      key: '',
      watchPattern: key,
      watchHeadersOnly: true,
      watchInclude: '',
      watchResumeFromRevision: 0,
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: false,
      debug: false,
      wires: [['kvh-debug']],
    },
    {
      id: 'kvh-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: 'kvh-put',
      type: 'nats-suite-kv-put',
      z: 'FLOW',
      server: 'kvh-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      operation: 'put',
      keyFrom: 'config',
      key,
      valueFrom: 'config',
      value,
      stringifyJSON: false,
      debug: false,
      wires: [[]],
    },
    {
      id: 'kvh-inject',
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'str',
      wires: [['kvh-put']],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;
    const srvConnected = comms.waitForStatus(
      'kvh-srv',
      d => d.fill === 'green',
      20000
    );
    const watching = comms.waitForStatus(
      'kvh-watch',
      d => d.text === 'watching',
      20000
    );
    flowId = await deployFlow(nodes);
    await srvConnected;
    await watching;

    const watchEvent = comms.waitForDebug('kvh-debug', 10000);
    await triggerInject('kvh-inject');
    const msg = await watchEvent;

    assert.equal(msg.key, key);
    assert.equal(msg.payload, null);
    assert.equal(msg.length, value.length);
    assert.equal(msg.operation, 'PUT');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

test('kv watch with a comma-separated pattern watches multiple keys at once', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_multi_${Date.now().toString(36)}`;
  const keyA = 'multi-a';
  const keyB = 'multi-b';

  const nodes = [
    serverNode('kvmk-srv'),
    {
      id: 'kvmk-watch',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kvmk-srv',
      bucket,
      history: 10,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'file',
      mode: 'watch',
      keyFrom: 'config',
      key: '',
      watchPattern: `${keyA},${keyB}`,
      watchHeadersOnly: false,
      watchInclude: '',
      watchResumeFromRevision: 0,
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: false,
      debug: false,
      wires: [['kvmk-debug']],
    },
    {
      id: 'kvmk-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;
    const srvConnected = comms.waitForStatus(
      'kvmk-srv',
      d => d.fill === 'green',
      20000
    );
    const watching = comms.waitForStatus(
      'kvmk-watch',
      d => d.text === 'watching',
      20000
    );
    flowId = await deployFlow(nodes);
    await srvConnected;
    await watching;

    const nc = await connectDirectNats();
    const kv = await new Kvm(nc).create(bucket, { storage: 'memory' });

    const firstEvent = comms.waitForDebug('kvmk-debug', 10000);
    await kv.put(keyA, 'value-a');
    const msgA = await firstEvent;

    const secondEvent = comms.waitForDebug('kvmk-debug', 10000);
    await kv.put(keyB, 'value-b');
    const msgB = await secondEvent;

    await ignoreFailure(nc.close());

    assert.equal(msgA.key, keyA);
    assert.equal(msgA.payload, 'value-a');
    assert.equal(msgB.key, keyB);
    assert.equal(msgB.payload, 'value-b');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});

test('kv watch with include "history" delivers prior revisions, not just the latest', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_kv_hist_watch_${Date.now().toString(36)}`;
  const key = 'hist-key';

  // Seed two revisions BEFORE the watcher starts, via a direct connection -
  // this is exactly what include:'history' is for: a watcher that needs to
  // see everything that already happened, not just changes from now on.
  const seedNc = await connectDirectNats();
  const seedKv = await new Kvm(seedNc).create(bucket, {
    storage: 'memory',
    history: 5,
  });
  await seedKv.put(key, 'revision-1');
  await seedKv.put(key, 'revision-2');
  await ignoreFailure(seedNc.close());

  const nodes = [
    serverNode('kvhw-srv'),
    {
      id: 'kvhw-watch',
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: 'kvhw-srv',
      bucket,
      history: 5,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'memory',
      mode: 'watch',
      keyFrom: 'config',
      key: '',
      watchPattern: key,
      watchHeadersOnly: false,
      watchInclude: 'history',
      watchResumeFromRevision: 0,
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: false,
      debug: false,
      wires: [['kvhw-debug']],
    },
    {
      id: 'kvhw-debug',
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
  ];

  const comms = connectComms();
  let flowId;

  try {
    await comms.ready;
    const srvConnected = comms.waitForStatus(
      'kvhw-srv',
      d => d.fill === 'green',
      20000
    );
    const watching = comms.waitForStatus(
      'kvhw-watch',
      d => d.text === 'watching',
      20000
    );
    // Registered before deploy: with mode "watch", both already-buffered
    // history entries can be replayed within milliseconds of the watcher
    // starting, so the collector has to be listening before the flow even
    // exists, not just before some later trigger.
    const events = collectDebugMessages('kvhw-debug', 2, 15000);

    flowId = await deployFlow(nodes);
    await srvConnected;
    await watching;

    const [msg1, msg2] = await events;

    assert.equal(msg1.key, key);
    assert.equal(msg1.revision, 1);
    assert.equal(msg1.payload, 'revision-1');
    assert.equal(msg2.revision, 2);
    assert.equal(msg2.payload, 'revision-2');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await destroyBucket(bucket);
  }
});
