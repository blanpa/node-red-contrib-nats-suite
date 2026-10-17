'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headers: natsHeaders } = require('@nats-io/nats-core');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  connectComms,
  connectDirectNats,
  serverNode,
} = require('./lib/harness');

const debugNode = id => ({
  id,
  type: 'debug',
  z: 'FLOW',
  name: '',
  active: true,
  tosidebar: true,
  console: false,
  complete: 'true',
  wires: [],
});

const subscribeNode = (id, server, subject, dataformat, wireTo) => ({
  id,
  type: 'nats-suite-subscribe',
  z: 'FLOW',
  name: '',
  server,
  debug: false,
  dataformat,
  datapointid: subject,
  subscriptionMode: 'static',
  queueGroup: '',
  wires: [[wireTo]],
});

test('subscribe serializes inbound NATS headers', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const server = `${id}-server`;
  const headerSubject = `test.subscribe.headers.${id}`;
  const headerSub = `${id}-header-sub`;
  const headerDebug = `${id}-header-debug`;

  const nodes = [
    serverNode(server),
    subscribeNode(headerSub, server, headerSubject, 'auto', headerDebug),
    debugNode(headerDebug),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(
      headerSub,
      status => status.fill === 'green',
      15000
    );
    flowId = await deployFlow(nodes);
    await connected;

    const headerCaught = comms.waitForDebug(headerDebug, 8000);

    const headers = natsHeaders();
    headers.set('X-Test', 'yes');
    headers.append('X-Multi', 'one');
    headers.append('X-Multi', 'two');
    directNc.publish(headerSubject, JSON.stringify({ ok: true }), { headers });
    await directNc.flush();

    const headerMsg = await headerCaught;
    assert.deepEqual(headerMsg.headers, {
      'X-Test': 'yes',
      'X-Multi': ['one', 'two'],
    });
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('subscribe stops forwarding messages after the flow is closed', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const server = `${id}-server`;
  const subject = `test.subscribe.close.${id}`;
  const sub = `${id}-sub`;
  const debug = `${id}-debug`;
  const nodes = [
    serverNode(server),
    subscribeNode(sub, server, subject, 'auto', debug),
    debugNode(debug),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(
      sub,
      status => status.fill === 'green',
      15000
    );
    flowId = await deployFlow(nodes);
    await connected;

    await deleteFlow(flowId);
    const noMessage = comms.waitForDebug(debug, 1000);
    directNc.publish(subject, 'after-close');
    await directNc.flush();
    await assert.rejects(noMessage, /Timed out/);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});
