'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  connectComms,
  serverNode,
} = require('./lib/harness');

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('stream-publisher close completes while initialization is pending', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const server = `${id}-server`;
  const publisher = `${id}-publisher`;
  const streamName = `TEST_CLOSE_${id.toUpperCase()}`;
  const nodes = [
    serverNode(server, { server: 'nats://127.0.0.1:1' }),
    {
      id: publisher,
      type: 'nats-suite-stream-publisher',
      z: 'FLOW',
      name: '',
      server,
      streamName,
      subjectPattern: `test.stream.close.${id}`,
      defaultSubject: `test.stream.close.${id}`,
      operation: 'publish',
      createOnInit: true,
      debug: false,
      wires: [],
    },
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    flowId = await deployFlow(nodes);
    await new Promise(resolve => setImmediate(resolve));

    const started = Date.now();
    await bounded(deleteFlow(flowId), 5000);
    flowId = null;
    assert.ok(Date.now() - started < 5000);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
  }
});
