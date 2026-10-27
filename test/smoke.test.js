'use strict';

// End-to-end smoke test proving the harness works: deploys a real flow
// (nats-suite-server + nats-suite-publish + nats-suite-subscribe) into the
// real Node-RED container, publishes a message, and asserts it round-trips
// through the real NATS server on both ends of the wire - what Node-RED's
// own subscribe node received, and what a direct NATS subscription from this
// test process received.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  NATS_CONTAINER_URL,
  ensureStackUp,
  deployFlow,
  deleteFlow,
  triggerInject,
  connectComms,
  connectDirectNats,
  subscribeOnce,
} = require('./lib/harness');

test('publish -> real NATS -> subscribe round-trip, with connected status', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const subject = `test.harness.smoke.${Date.now()}`;
  const probeValue = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const nodes = [
    {
      id: 'harness-srv',
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
    },
    {
      id: 'harness-inject',
      type: 'inject',
      z: 'FLOW',
      name: '',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      topic: '',
      payload: probeValue,
      payloadType: 'str',
      wires: [['harness-pub']],
    },
    {
      id: 'harness-pub',
      type: 'nats-suite-publish',
      z: 'FLOW',
      name: '',
      server: 'harness-srv',
      debug: false,
      mode: 'publish',
      dataformat: 'string',
      datapointid: subject,
      outputs: 0,
      wires: [],
    },
    {
      id: 'harness-sub',
      type: 'nats-suite-subscribe',
      z: 'FLOW',
      name: '',
      server: 'harness-srv',
      debug: false,
      dataformat: 'auto',
      datapointid: subject,
      subscriptionMode: 'static',
      queueGroup: '',
      wires: [['harness-debug']],
    },
    {
      id: 'harness-debug',
      type: 'debug',
      z: 'FLOW',
      name: '',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;

  try {
    await comms.ready;

    // Register status waiters before deploying, so a fast transition to
    // "connected" right after deploy can't be missed.
    const connected = d => d.fill === 'green';
    const serverConnected = comms.waitForStatus(
      'harness-srv',
      connected,
      20000
    );
    const pubConnected = comms.waitForStatus('harness-pub', connected, 20000);
    const subConnected = comms.waitForStatus('harness-sub', connected, 20000);

    flowId = await deployFlow(nodes);

    await Promise.all([serverConnected, pubConnected, subConnected]);

    // Register both observers on the wire before triggering the publish.
    const debugCaught = comms.waitForDebug('harness-debug', 10000);
    const directCaught = subscribeOnce(directNc, subject, 10000);

    await directNc.flush();
    await triggerInject('harness-inject');

    const [debugMsg, directPayload] = await Promise.all([
      debugCaught,
      directCaught,
    ]);

    assert.equal(
      directPayload,
      probeValue,
      'direct NATS subscription should see the exact published payload'
    );
    assert.equal(
      debugMsg.payload,
      probeValue,
      "Node-RED's own subscribe node should output the same payload it received back over NATS"
    );
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});
