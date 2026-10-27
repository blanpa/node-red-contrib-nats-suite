'use strict';

// Step 3 (NATS-3.4-GAP-PLAN.md) coverage for nats-suite-server-pool.js, the
// new node exposing NatsConnection#getServers()/#setServers()/#reconnect():
//   - get-servers echoes the pool the shared connection actually dialed.
//   - set-servers validates its input before touching the connection, and a
//     rejected call leaves the existing connection/pool untouched.
//   - set-servers + reconnectAfterSet actually moves a shared connection
//     (proven by driving a real publish through nats-suite-publish sharing
//     the same server config) onto a second real broker: the embedded NATS
//     server that this repo's own default dev flow (node-red/flows.json,
//     nats-suite-server-manager, autoStart: true) already runs on port 4223
//     for the life of the nodered container - not something this test starts
//     itself (an earlier version of this test tried to start a second
//     instance on the same port and collided with this one: "Server exited
//     with code 1").
//
// Real Node-RED + real NATS via docker-compose, no mocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  triggerInject,
  connectComms,
  connectDirectNats,
  subscribeOnce,
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

let seq = 0;
const uid = base => `${base}${Date.now().toString(36)}${seq++}`;

async function ignoreFailure(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
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

function serverPoolNode(id, srv, operation, wireTo, overrides = {}) {
  return {
    id,
    type: 'nats-suite-server-pool',
    z: 'FLOW',
    name: '',
    server: srv,
    operation,
    reconnectAfterSet: false,
    wires: [[wireTo]],
    ...overrides,
  };
}

function publishNode(id, srv, subject, wireTo) {
  return {
    id,
    type: 'nats-suite-publish',
    z: 'FLOW',
    name: '',
    server: srv,
    debug: false,
    mode: 'publish',
    dataformat: 'string',
    datapointid: subject,
    enableTopicOverride: false,
    requestTimeout: 5000,
    requestFallbackToPublish: true,
    enableAutoReply: false,
    enableHeaders: false,
    headers: '',
    outputs: 0,
    wires: wireTo ? [[wireTo]] : [],
  };
}

test('server-pool: get-servers returns the pool the shared connection actually dialed', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('gs-');
  const srv = `${id}srv`;
  const pool = `${id}pool`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    serverPoolNode(pool, srv, 'get-servers', dbg),
    injectNode(inj, pool, []),
    debugNode(dbg),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pool, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const result = comms.waitForDebug(dbg, 8000);
    await triggerInject(inj);
    const msg = await result;

    assert.ok(
      Array.isArray(msg.payload) && msg.payload.length > 0,
      'payload must be a non-empty list'
    );
    assert.ok(
      msg.payload.some(s => s.includes('4222')),
      `expected the main broker's port in ${JSON.stringify(msg.payload)}`
    );
    assert.ok(
      Array.isArray(msg.servers) && msg.servers.length === msg.payload.length,
      'msg.servers must be the raw diagnostic list matching msg.payload 1:1'
    );
    assert.ok(
      typeof msg.servers[0].gossiped === 'boolean',
      'msg.servers entries must carry the real Server diagnostic shape, not just .listen strings'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

test('server-pool: set-servers rejects an invalid payload without touching the connection', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('bad-');
  const srv = `${id}srv`;
  const pool = `${id}pool`;
  const injBad = `${id}injbad`;
  const injGet = `${id}injget`;
  const cat = `${id}cat`;
  const dbgCat = `${id}dbgcat`;
  const dbgGet = `${id}dbgget`;

  const nodes = [
    serverNode(srv),
    serverPoolNode(pool, srv, 'get-servers', dbgGet),
    injectNode(injBad, pool, [
      { p: 'operation', v: 'set-servers', vt: 'str' },
      { p: 'payload', v: '[]', vt: 'json' },
    ]),
    injectNode(injGet, pool, []),
    {
      id: cat,
      type: 'catch',
      z: 'FLOW',
      name: '',
      scope: [pool],
      uncaught: false,
      wires: [[dbgCat]],
    },
    debugNode(dbgCat),
    debugNode(dbgGet),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pool, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const caught = comms.waitForDebug(dbgCat, 8000);
    await triggerInject(injBad);
    const caughtMsg = await caught;
    assert.match(caughtMsg.error.message, /non-empty array/);

    // The connection must be untouched: get-servers still returns the
    // original, unmodified pool.
    const result = comms.waitForDebug(dbgGet, 8000);
    await triggerInject(injGet);
    const msg = await result;
    assert.ok(
      msg.payload.some(s => s.includes('4222')),
      'original pool must survive a rejected set-servers'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
  }
});

test('server-pool: set-servers + reconnectAfterSet moves a shared connection onto a second real broker', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('mv-');
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const pool = `${id}pool`;
  const injSet = `${id}injset`;
  const injPub = `${id}injpub`;
  const dbgPool = `${id}dbgpool`;
  const subject = `test.serverpool.reach.${id}`;
  const embeddedHostUrl = `localhost:${process.env.NATS_EMBEDDED_PORT || 4223}`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, srv, subject, null),
    serverPoolNode(pool, srv, 'set-servers', dbgPool, {
      reconnectAfterSet: true,
    }),
    injectNode(injSet, pool, [
      { p: 'payload', v: '["localhost:4223"]', vt: 'json' },
    ]),
    injectNode(injPub, pub, [{ p: 'payload', v: 'hello-embedded', vt: 'str' }]),
    debugNode(dbgPool),
  ];

  const comms = connectComms();
  const mainNc = await connectDirectNats();
  const embeddedNc = await connectDirectNats({ servers: embeddedHostUrl });
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    // Baseline, before any swap: the message lands on the main broker only -
    // rules out a false-positive later where the embedded broker "sees" it
    // for an unrelated reason (wrong subject bleed-through, stale sub, etc).
    const baselineMain = subscribeOnce(mainNc, subject, 5000);
    const baselineEmbeddedShouldTimeout = subscribeOnce(
      embeddedNc,
      subject,
      2000
    ).then(
      () => {
        throw new Error(
          'message unexpectedly reached the embedded broker before any swap'
        );
      },
      () => 'not-there'
    );
    await Promise.all([mainNc.flush(), embeddedNc.flush()]);
    await triggerInject(injPub);
    assert.equal(await baselineMain, 'hello-embedded');
    assert.equal(await baselineEmbeddedShouldTimeout, 'not-there');

    // Perform the swap: point the pool at the embedded broker and force an
    // immediate reconnect onto it.
    const setResult = comms.waitForDebug(dbgPool, 10000);
    await triggerInject(injSet);
    const setMsg = await setResult;
    assert.deepEqual(setMsg.payload, ['localhost:4223']);

    // Proof: the SAME shared connection (used by nats-suite-publish) now
    // reaches the embedded broker, and no longer the main one.
    const afterEmbedded = subscribeOnce(embeddedNc, subject, 5000);
    const afterMainShouldTimeout = subscribeOnce(mainNc, subject, 2000).then(
      () => {
        throw new Error(
          'message unexpectedly still reached the main broker after the swap'
        );
      },
      () => 'not-there'
    );
    await Promise.all([mainNc.flush(), embeddedNc.flush()]);
    await triggerInject(injPub);
    assert.equal(await afterEmbedded, 'hello-embedded');
    assert.equal(await afterMainShouldTimeout, 'not-there');
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await ignoreFailure(mainNc.close());
    await ignoreFailure(embeddedNc.close());
  }
});
