'use strict';

// Tests for Step 6's Node-RED completion contract: on('input') must call
// done() on success / done(err) on failure (never node.error(err, msg) as
// well - that double-fires Catch nodes), and on('close') must take and call
// done(). Covers the four files that got this wiring in Step 6 - subscribe,
// stream-publisher, stream-consumer, server-manager. publish.js and
// server.js already had this contract before Step 6 and are covered by
// test/publish.test.js and test/reconnect.test.js respectively.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jetstreamManager } = require('@nats-io/jetstream');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  triggerInject,
  connectComms,
  connectDirectNats,
  serverNode,
} = require('./lib/harness');

async function checkStack(t) {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

async function ignoreFailure(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

let seq = 0;
const uid = base => `${base}${Date.now().toString(36)}${seq++}`;

function injectNode(id, wireTo, props) {
  return {
    id,
    type: 'inject',
    z: 'FLOW',
    name: '',
    props: props || [{ p: 'payload' }],
    repeat: '',
    once: false,
    topic: '',
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
    uncaught: false,
    wires: [[wireTo]],
  };
}

function subscribeNode(id, srv, subject, wireTo) {
  return {
    id,
    type: 'nats-suite-subscribe',
    z: 'FLOW',
    name: '',
    server: srv,
    debug: false,
    dataformat: 'auto',
    datapointid: subject,
    subscriptionMode: 'dynamic',
    queueGroup: '',
    wires: [[wireTo]],
  };
}

function streamPublisherNode(id, srv, streamName, subject, wireTo) {
  return {
    id,
    type: 'nats-suite-stream-publisher',
    z: 'FLOW',
    name: '',
    server: srv,
    streamName,
    subjectPattern: subject,
    defaultSubject: subject,
    retention: 'limits',
    maxMessages: -1,
    maxAge: '24h',
    maxBytes: -1,
    duplicateWindow: '2m',
    storage: 'file',
    replicas: 1,
    operation: 'publish',
    createOnInit: true,
    debug: false,
    wires: [[wireTo]],
  };
}

function streamConsumerNode(
  id,
  srv,
  streamName,
  consumerName,
  subject,
  wireTo
) {
  return {
    id,
    type: 'nats-suite-stream-consumer',
    z: 'FLOW',
    name: '',
    server: srv,
    streamName,
    consumerName,
    createOnInit: true,
    filterSubject: subject,
    ackPolicy: 'none',
    deliverPolicy: 'all',
    ackWait: '30s',
    maxDeliver: 5,
    maxAckPending: 1000,
    batchSize: 1,
    maxWait: 2000,
    operation: 'consume',
    debug: false,
    wires: [[wireTo]],
  };
}

function serverManagerNode(id, port, wireTo, overrides) {
  return {
    id,
    type: 'nats-suite-server-manager',
    z: 'FLOW',
    name: '',
    port,
    enableJetStream: false,
    storeDir: '',
    enableLeafNodeMode: false,
    leafPort: 7422,
    leafRemoteUrl: '',
    leafRemoteUser: '',
    autoStart: false,
    debug: false,
    wires: [wireTo ? [wireTo] : []],
    ...overrides,
  };
}

test('stream-publisher: Catch fires on a real operation failure, Complete fires on a real publish', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('spc-');
  const srv = `${id}srv`;
  const sp = `${id}sp`;
  const injFail = `${id}injfail`;
  const injOk = `${id}injok`;
  const cat = `${id}cat`;
  const cmp = `${id}cmp`;
  const dbgCat = `${id}dbgcat`;
  const dbgCmp = `${id}dbgcmp`;
  const streamName = `TEST_SPC_${id.replace(/-/g, '_')}`;
  const subject = `test.contracts.spc.${id}`;

  const nodes = [
    serverNode(srv),
    streamPublisherNode(sp, srv, streamName, subject, cmp),
    // Deterministic, config-driven failure: 'info' on a stream name that
    // never exists - independent of connectivity/timing races.
    injectNode(injFail, sp, [
      { p: 'operation', v: 'info', vt: 'str' },
      { p: 'stream', v: `${streamName}_NOPE`, vt: 'str' },
    ]),
    injectNode(injOk, sp, [{ p: 'payload', v: 'hello', vt: 'str' }]),
    catchNode(cat, [sp], dbgCat),
    debugNode(dbgCat),
    completeNode(cmp, [sp], dbgCmp),
    debugNode(dbgCmp),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(sp, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const caught = comms.waitForDebug(dbgCat, 8000);
    await triggerInject(injFail);
    const caughtMsg = await caught;
    assert.ok(caughtMsg.error, 'caught message should carry the error');
    assert.equal(
      caughtMsg.error.source.id,
      sp,
      'error should be attributed to the stream-publisher node'
    );

    const completed = comms.waitForDebug(dbgCmp, 8000);
    await triggerInject(injOk);
    const completeMsg = await completed;
    assert.equal(
      completeMsg.complete.source.id,
      sp,
      'complete event should be attributed to the stream-publisher node'
    );
    assert.equal(completeMsg.published, true);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

test('stream-consumer: Catch fires on a real operation failure, Complete fires on a real consume', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('scc-');
  const srv = `${id}srv`;
  const sc = `${id}sc`;
  const injFail = `${id}injfail`;
  const injOk = `${id}injok`;
  const cat = `${id}cat`;
  const cmp = `${id}cmp`;
  const dbgCat = `${id}dbgcat`;
  const dbgCmp = `${id}dbgcmp`;
  const streamName = `TEST_SCC_${id.replace(/-/g, '_')}`;
  const consumerName = `test_scc_${id.replace(/-/g, '_')}`;
  const subject = `test.contracts.scc.${id}`;

  const nodes = [
    serverNode(srv),
    streamConsumerNode(sc, srv, streamName, consumerName, subject, cmp),
    // Deterministic, config-driven failure: 'info' on a consumer that never
    // exists on the (real, existing) configured stream.
    injectNode(injFail, sc, [
      { p: 'operation', v: 'info', vt: 'str' },
      { p: 'consumer', v: `${consumerName}_nope`, vt: 'str' },
    ]),
    injectNode(injOk, sc, [{ p: 'payload', v: '', vt: 'str' }]),
    catchNode(cat, [sc], dbgCat),
    debugNode(dbgCat),
    completeNode(cmp, [sc], dbgCmp),
    debugNode(dbgCmp),
  ];

  const comms = connectComms();
  let directNc;
  let flowId;
  try {
    directNc = await connectDirectNats();
    // stream-consumer only creates the *consumer* on init - the stream
    // itself must already exist (same requirement proven in
    // test/jetstream.test.js's ack/nak/term test).
    const setupJsm = await jetstreamManager(directNc);
    await setupJsm.streams.add({ name: streamName, subjects: [subject] });

    await comms.ready;
    const connected = comms.waitForStatus(sc, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const caught = comms.waitForDebug(dbgCat, 8000);
    await triggerInject(injFail);
    const caughtMsg = await caught;
    assert.ok(caughtMsg.error, 'caught message should carry the error');
    assert.equal(
      caughtMsg.error.source.id,
      sc,
      'error should be attributed to the stream-consumer node'
    );

    directNc.publish(subject, 'hello');
    await directNc.flush();
    const completed = comms.waitForDebug(dbgCmp, 8000);
    await triggerInject(injOk);
    const completeMsg = await completed;
    assert.equal(
      completeMsg.complete.source.id,
      sc,
      'complete event should be attributed to the stream-consumer node'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    if (directNc) await ignoreFailure(directNc.close());
    comms.close();
  }
});

test('subscribe: Complete fires after a real dynamic-mode subscription update', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('subc-');
  const srv = `${id}srv`;
  const sub = `${id}sub`;
  const inj = `${id}inj`;
  const cmp = `${id}cmp`;
  const dbgCmp = `${id}dbgcmp`;
  const baseSubject = `test.contracts.subc.base.${id}`;
  const newSubject = `test.contracts.subc.new.${id}`;

  const nodes = [
    serverNode(srv),
    subscribeNode(sub, srv, baseSubject, cmp),
    injectNode(inj, sub, [{ p: 'topic', v: newSubject, vt: 'str' }]),
    completeNode(cmp, [sub], dbgCmp),
    debugNode(dbgCmp),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(sub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const completed = comms.waitForDebug(dbgCmp, 8000);
    await triggerInject(inj);
    const completeMsg = await completed;
    assert.equal(
      completeMsg.complete.source.id,
      sub,
      'complete event should be attributed to the subscribe node'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

test('server-manager: Catch/Complete fire correctly and close awaits process exit', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('smc-');
  const port = 4300 + (seq % 100);
  const sm = `${id}sm`;
  const badSm = `${id}badsm`;
  const injStatus = `${id}injstatus`;
  const injStart = `${id}injstart`;
  const injBadStart = `${id}injbadstart`;
  const cat = `${id}cat`;
  const dbgCat = `${id}dbgcat`;
  const cmp = `${id}cmp`;
  const dbgCmp = `${id}dbgcmp`;
  // The harness copies the current test broker's binary into the shared bin
  // mount, so this exercises Server Manager at the same supported version.
  const binOverrides = {
    binarySource: 'custom',
    customBinaryPath: '/data/bin/nats-server',
  };

  const nodes = [
    serverManagerNode(sm, port, cmp, binOverrides),
    serverManagerNode(badSm, port + 1, null, {
      binarySource: 'custom',
      customBinaryPath: '/definitely/missing/nats-server',
    }),
    injectNode(injStatus, sm, [{ p: 'command', v: 'status', vt: 'str' }]),
    injectNode(injStart, sm, [{ p: 'command', v: 'start', vt: 'str' }]),
    injectNode(injBadStart, badSm, [{ p: 'command', v: 'start', vt: 'str' }]),
    catchNode(cat, [badSm], dbgCat),
    debugNode(dbgCat),
    completeNode(cmp, [sm], dbgCmp),
    debugNode(dbgCmp),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const ready = comms.waitForStatus(sm, d => d.fill === 'grey', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    const caught = comms.waitForDebug(dbgCat, 8000);
    await triggerInject(injBadStart);
    const caughtMsg = await caught;
    assert.equal(caughtMsg.error.source.id, badSm);

    // 1) done() wiring: a "status" command (no real work, no failure path
    // to force deterministically) still has to reach the Complete node.
    const completed = comms.waitForDebug(dbgCmp, 8000);
    await triggerInject(injStatus);
    const completeMsg = await completed;
    assert.equal(completeMsg.complete.source.id, sm);

    // 2) The close-handler bug fix: start a real embedded nats-server, then
    // delete the flow. Before Step 6 the zero-arg async close handler was
    // never awaited by Node-RED (dispatch is by declared arity), so
    // deleteFlow() could resolve while the child process was still shutting
    // down. Proof it's fixed: immediately redeploying a fresh node bound to
    // the SAME port must succeed - if the old process were still holding
    // the port, the new one would get stuck in 'error' status instead of
    // reaching 'running'.
    const running = comms.waitForStatus(sm, d => d.fill === 'green', 20000);
    await triggerInject(injStart);
    await running;

    await deleteFlow(flowId);
    flowId = null;

    const sm2 = `${id}sm2`;
    const flow2 = [
      serverManagerNode(sm2, port, null, { ...binOverrides, autoStart: true }),
    ];
    const settled2 = comms.waitForStatus(
      sm2,
      d => d.fill === 'green' || d.fill === 'red',
      20000
    );
    const flowId2 = await deployFlow(flow2);
    try {
      const status = await settled2;
      assert.equal(
        status.fill,
        'green',
        'redeploying on the same port must succeed - the old process should already be gone by the time close() resolved'
      );
    } finally {
      await ignoreFailure(deleteFlow(flowId2));
    }
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});
