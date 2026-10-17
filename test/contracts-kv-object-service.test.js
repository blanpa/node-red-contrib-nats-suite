'use strict';

// Step 6: Node-RED completion contract (done()/node.error()) for kv-get,
// kv-put, object-get, object-put, service. Each node gets one failure path
// (proving a wired Catch node receives node.error(err, msg) via done(err),
// not a parallel bare node.error() call) and one success path (proving a
// wired Complete node fires only after the real operation against NATS
// finished). Pattern matches test/publish.test.js's existing Catch/Complete
// tests. Real Node-RED + real NATS via test/lib/harness.js - no mocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Kvm } = require('@nats-io/kv');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  connectComms,
  connectDirectNats,
  triggerInject,
  serverNode,
} = require('./lib/harness');

let seq = 0;
const uid = base => `${base}${Date.now().toString(36)}${seq++}`;

async function checkStack(t) {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

function injectNode(id, wireTo, props) {
  return {
    id,
    type: 'inject',
    z: 'FLOW',
    name: '',
    props,
    repeat: '',
    once: false,
    payload: '',
    payloadType: 'date',
    wires: [[wireTo]],
  };
}

function debugNode(id) {
  return {
    id,
    type: 'debug',
    z: 'FLOW',
    name: '',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'true',
    wires: [],
  };
}

function catchNode(id, scope, wireTo) {
  return {
    id,
    type: 'catch',
    z: 'FLOW',
    name: '',
    scope,
    uncaught: false,
    wires: [[wireTo]],
  };
}

function completeNode(id, scope, wireTo) {
  return {
    id,
    type: 'complete',
    z: 'FLOW',
    name: '',
    scope,
    wires: [[wireTo]],
  };
}

async function ignoreFailure(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

// Runs `nodeUnderTest` twice against the same deployed server: once wired
// through a Catch node with `failProps` injected (expects node.error(err,msg)
// via done(err), original msg intact), once wired through a Complete node
// with `okProps` injected (expects done() only after the op actually runs).
async function assertCatchAndComplete(t, { type, config, failProps, okProps }) {
  if (!(await checkStack(t))) return;

  const id = uid('c-');
  const srv = `${id}srv`;

  // --- Catch path ---
  {
    const node = `${id}n1`;
    const inj = `${id}i1`;
    const cat = `${id}c1`;
    const dbg = `${id}d1`;
    const probe = `probe-${id}`;
    const nodes = [
      serverNode(srv),
      { id: node, type, z: 'FLOW', server: srv, ...config, wires: [[]] },
      injectNode(inj, node, [
        { p: 'payload', v: probe, vt: 'str' },
        ...failProps,
      ]),
      catchNode(cat, [node], dbg),
      debugNode(dbg),
    ];

    const comms = connectComms();
    let flowId;
    try {
      await comms.ready;
      const ready = comms.waitForStatus(srv, d => d.fill === 'green', 15000);
      flowId = await deployFlow(nodes);
      await ready;

      const caught = comms.waitForDebug(dbg, 8000);
      await triggerInject(inj);
      const caughtMsg = await caught;

      assert.ok(caughtMsg.error, 'caught message should carry the error');
      assert.equal(
        caughtMsg.error.source.id,
        node,
        'error should be attributed to the node under test'
      );
      assert.equal(
        caughtMsg.payload,
        probe,
        'the ORIGINAL message payload must survive into the Catch node'
      );
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
    }
  }

  // --- Complete path ---
  {
    const node = `${id}n2`;
    const inj = `${id}i2`;
    const cmp = `${id}c2`;
    const dbg = `${id}d2`;
    const probe = `probe-${id}-ok`;
    const nodes = [
      serverNode(srv),
      { id: node, type, z: 'FLOW', server: srv, ...config, wires: [[]] },
      injectNode(inj, node, [
        { p: 'payload', v: probe, vt: 'str' },
        ...okProps,
      ]),
      completeNode(cmp, [node], dbg),
      debugNode(dbg),
    ];

    const comms = connectComms();
    let flowId;
    try {
      await comms.ready;
      const ready = comms.waitForStatus(srv, d => d.fill === 'green', 15000);
      flowId = await deployFlow(nodes);
      await ready;

      const completed = comms.waitForDebug(dbg, 8000);
      await triggerInject(inj);
      const completeMsg = await completed;

      assert.equal(
        completeMsg.complete.source.id,
        node,
        'complete event should be attributed to the node under test'
      );
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
    }
  }
}

test('kv-get: Catch fires on "no key specified", Complete fires on a real (not-found) get', async t => {
  const bucket = uid('contracts_kvget');
  await assertCatchAndComplete(t, {
    type: 'nats-suite-kv-get',
    config: {
      bucket,
      history: 1,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'memory',
      mode: 'get',
      keyFrom: 'msg',
      key: '',
      watchPattern: '',
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: true,
      debug: false,
    },
    // keyFrom: 'msg' with no msg.key -> "No key specified" -> done(err)
    failProps: [],
    // A key that never existed still completes successfully (forwarded with
    // _notFound: true, not an error) - proves "not found" isn't miscategorized.
    okProps: [{ p: 'key', v: 'does-not-exist', vt: 'str' }],
  });
});

test('kv-put: Catch fires on "no key specified", Complete fires on a real put', async t => {
  const bucket = uid('contracts_kvput');
  await assertCatchAndComplete(t, {
    type: 'nats-suite-kv-put',
    config: {
      bucket,
      history: 1,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'memory',
      operation: 'put',
      keyFrom: 'msg',
      key: '',
      valueFrom: 'payload',
      stringifyJSON: false,
      debug: false,
    },
    failProps: [],
    okProps: [{ p: 'key', v: 'widget', vt: 'str' }],
  });
});

test('object-get: Catch fires on "no object name specified", Complete fires on list', async t => {
  const bucket = uid('contracts_objget');
  await assertCatchAndComplete(t, {
    type: 'nats-suite-object-get',
    config: {
      bucket,
      description: '',
      maxAge: 0,
      maxBytes: 0,
      storage: 'memory',
      replicas: 1,
      compression: false,
      nameFrom: 'msg',
      outputFormat: 'buffer',
      debug: false,
    },
    // nameFrom: 'msg' with no msg.objectName/name, and no operation ->
    // falls through to default get-mode -> "No object name specified".
    failProps: [],
    // 'list' always succeeds (empty array is fine) even before any object
    // has ever been put, once the bucket exists.
    okProps: [{ p: 'operation', v: 'list', vt: 'str' }],
  });
});

test('object-put: Catch fires on "no object name specified", Complete fires on a real put', async t => {
  const bucket = uid('contracts_objput');
  await assertCatchAndComplete(t, {
    type: 'nats-suite-object-put',
    config: {
      bucket,
      nameFrom: 'msg',
      dataFrom: 'payload',
      contentType: '',
      description: '',
      maxAge: 0,
      maxBytes: 0,
      storage: 'memory',
      replicas: 1,
      compression: false,
      debug: false,
    },
    failProps: [],
    okProps: [{ p: 'objectName', v: 'greeting.txt', vt: 'str' }],
  });
});

test('service (service mode): failed start fires Catch and real start fires Complete', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('svcm-');
  const srv = `${id}srv`;
  const node = `${id}n`;
  const badNode = `${id}bad`;
  const inj = `${id}i`;
  const badInj = `${id}badi`;
  const cmp = `${id}c`;
  const dbg = `${id}d`;
  const cat = `${id}cat`;
  const dbgCat = `${id}dbgcat`;
  const nodes = [
    serverNode(srv),
    {
      id: node,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'service',
      serviceName: uid('contracts-svc'),
      serviceVersion: '1.0.0',
      endpoint: 'process',
      endpointSubject: '',
      autoStart: false,
      debug: false,
      wires: [[]],
    },
    {
      id: badNode,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'service',
      serviceName: uid('contracts-bad-svc'),
      serviceVersion: 'not-semver',
      endpoint: 'process',
      endpointSubject: '',
      autoStart: false,
      debug: false,
      wires: [[]],
    },
    injectNode(inj, node, [{ p: 'operation', v: 'start', vt: 'str' }]),
    injectNode(badInj, badNode, [{ p: 'operation', v: 'start', vt: 'str' }]),
    completeNode(cmp, [node], dbg),
    debugNode(dbg),
    catchNode(cat, [badNode], dbgCat),
    debugNode(dbgCat),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const ready = comms.waitForStatus(srv, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    const caught = comms.waitForDebug(dbgCat, 8000);
    await triggerInject(badInj);
    const caughtMsg = await caught;
    assert.equal(caughtMsg.error.source.id, badNode);

    const completed = comms.waitForDebug(dbg, 8000);
    await triggerInject(inj);
    const completeMsg = await completed;

    assert.equal(
      completeMsg.complete.source.id,
      node,
      'complete event should be attributed to the service node'
    );
    assert.equal(completeMsg.payload.running, true);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

test('service (discover mode): Catch fires on an unknown operation', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('svc-');
  const srv = `${id}srv`;
  const node = `${id}n`;
  const inj = `${id}i`;
  const cat = `${id}c`;
  const dbg = `${id}d`;
  const probe = `probe-${id}`;
  const nodes = [
    serverNode(srv),
    {
      id: node,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'discover',
      discoveryFilter: '*',
      autoStart: false,
      debug: false,
      wires: [[]],
    },
    injectNode(inj, node, [
      { p: 'payload', v: probe, vt: 'str' },
      { p: 'operation', v: 'not-a-real-operation', vt: 'str' },
    ]),
    catchNode(cat, [node], dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const ready = comms.waitForStatus(srv, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    const caught = comms.waitForDebug(dbg, 8000);
    await triggerInject(inj);
    const caughtMsg = await caught;

    assert.ok(caughtMsg.error, 'caught message should carry the error');
    assert.equal(
      caughtMsg.error.source.id,
      node,
      'error should be attributed to the service node'
    );
    assert.equal(
      caughtMsg.payload,
      probe,
      'the ORIGINAL message payload must survive into the Catch node'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

// Bug: kv-get's close handler awaited stopWatch() but declared zero args, so
// Node-RED (which dispatches close callbacks on declared arity) never
// actually waited for it - deleting a watch-mode node could race a redeploy.
// A fresh watcher on the same bucket immediately after deletion proves the
// old ephemeral watch subscription finished before close completed.
test('kv-get: watch-mode close is awaited with no leaked watcher on immediate redeploy', async t => {
  if (!(await checkStack(t))) return;

  const bucket = uid('contracts_kvwatch');
  const srv = uid('srv');
  let directNc;
  const comms = connectComms();
  let flowId;
  try {
    directNc = await connectDirectNats();
    await comms.ready;

    const watchNode = id => ({
      id,
      type: 'nats-suite-kv-get',
      z: 'FLOW',
      server: srv,
      bucket,
      history: 1,
      maxAge: 0,
      maxBytes: 0,
      maxValueSize: 0,
      compression: false,
      replicas: 1,
      storage: 'memory',
      mode: 'watch',
      keyFrom: 'config',
      key: '',
      watchPattern: '',
      includeHistory: false,
      historyLimit: 1,
      ignoreDeletes: true,
      parseJSON: true,
      debug: false,
      wires: [[`${id}dbg`]],
    });

    // --- Cycle 1: deploy, confirm watching, delete ---
    const w1 = uid('w1');
    let nodes = [serverNode(srv), watchNode(w1), debugNode(`${w1}dbg`)];
    const watching1 = comms.waitForStatus(
      w1,
      d => d.text === 'watching',
      15000
    );
    flowId = await deployFlow(nodes);
    await watching1;

    await deleteFlow(flowId);
    flowId = undefined;

    // --- Cycle 2: a fresh watcher on the same bucket must still work ---
    const w2 = uid('w2');
    nodes = [serverNode(srv), watchNode(w2), debugNode(`${w2}dbg`)];
    const watching2 = comms.waitForStatus(
      w2,
      d => d.text === 'watching',
      15000
    );
    flowId = await deployFlow(nodes);
    await watching2;

    const event = comms.waitForDebug(`${w2}dbg`, 8000);
    const kv = await new Kvm(directNc).create(bucket);
    await kv.put('probe-key', 'probe-value');
    const seen = await event;
    assert.equal(seen.key, 'probe-key');
    assert.equal(seen.operation, 'PUT');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    if (directNc) {
      try {
        const kv = await new Kvm(directNc).open(bucket);
        await kv.destroy();
      } catch {
        // Bucket may not exist if setup failed.
      }
      await ignoreFailure(directNc.close());
    }
  }
});
