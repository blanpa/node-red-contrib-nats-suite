'use strict';

// Coverage for Step 3 of RENOVATION-PLAN.md: connect/reconnect behavior and
// the node.status() shown in the UI for every affected node type, against
// real Node-RED + real NATS in Docker (no mocks).
//
// Claims under test (see RENOVATION-PLAN.md "Step 3 - Tests"):
//   1. Cold start with the broker already down -> red/ring, no crash.
//   2. Broker starts -> green/dot.
//   3. Broker killed mid-flow -> non-green transition, no crash.
//   4. Broker restarts -> green again AND messages flow again, no redeploy.
//   5. Repeated kill/restart cycles keep recovering, no unbounded growth.
//   6. Per-node-type status: server, publish, subscribe, stream-publisher,
//      stream-consumer (JetStream pull consumer - the highest-risk case).
//   7. A subscription established before the outage survives it.
//   8. No unhandled rejection / crash in the Node-RED container.
//
// The suite deploys one flow while the broker is down, then cycles that same
// flow through broker outages (1 cold-start + 3 repeated cycles).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { connect } = require('@nats-io/transport-node');
const { jetstreamManager } = require('@nats-io/jetstream');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  sweepHarnessFlows,
  triggerInject,
  connectComms,
  connectDirectNats,
  publishDirect,
  subscribeOnce,
  serverNode,
  NATS_URL,
  NODE_RED_URL,
} = require('./lib/harness');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- Docker lifecycle for the broker only (nodered stays up throughout -
// its health is exactly what claim 8 is checking) -------------------------

function compose(args) {
  execFileSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
}
const stopNats = () => compose(['stop', 'nats-server']);
const killNats = () => compose(['kill', 'nats-server']);

// Waits for the broker's HTTP monitor to actually answer, not just for
// `docker compose up` to return - a (re)started container needs a moment
// before it accepts connections, and `nats2.connect({waitOnFirstConnect:
// false})` does NOT retry its first dial; the server config owns the
// cancellable acquisition retry until the first connection succeeds. Every
// caller of startNats() gets this for free instead of each needing its own
// retry dance.
async function waitForNatsUp(timeoutMs = 20000) {
  const port = process.env.NATS_HTTP_PORT || 8222;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/varz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`NATS monitor did not come up within ${timeoutMs}ms`);
}

async function startNats() {
  compose(['up', '-d', 'nats-server']);
  await waitForNatsUp();
}
function bounded(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
const noderedLogsSince = since =>
  execFileSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', since, 'nodered'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }
  );

// --- JetStream admin (stream setup only - not the thing under test) ------

async function deleteStream(name) {
  // Generous retry budget (unlike harness.connectDirectNats's fail-fast
  // default): this is called right after startNats(), before anything has
  // confirmed the container is actually accepting connections yet, and a
  // freshly (re)started container needs a couple of seconds.
  const nc = await connect({
    servers: NATS_URL,
    tls: null,
    waitOnFirstConnect: false,
    reconnectTimeWait: 500,
  });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.streams.delete(name).catch(() => {});
  } finally {
    await nc.close();
  }
}

async function natsConnectionCount() {
  const port = process.env.NATS_HTTP_PORT || 8222;
  const res = await fetch(`http://localhost:${port}/varz`);
  if (!res.ok)
    throw new Error(`NATS monitor /varz returned HTTP ${res.status}`);
  return (await res.json()).connections;
}

// --- Node-config builders (mirrors the *.html `defaults` blocks) ---------

let seq = 0;
const uid = base => `${base}${Date.now().toString(36)}${seq++}`;

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

const injectNode = (id, wireTo) => ({
  id,
  type: 'inject',
  z: 'FLOW',
  name: '',
  props: [{ p: 'payload' }],
  repeat: '',
  once: false,
  topic: '',
  payload: '',
  payloadType: 'date',
  wires: [[wireTo]],
});

const publishNode = (id, srv, subject) => ({
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
  wires: [],
});

const subscribeNode = (id, srv, subject, wireTo) => ({
  id,
  type: 'nats-suite-subscribe',
  z: 'FLOW',
  name: '',
  server: srv,
  debug: false,
  dataformat: 'auto',
  datapointid: subject,
  subscriptionMode: 'static',
  queueGroup: '',
  wires: [[wireTo]],
});

const streamPublisherNode = (id, srv, streamName, subject, wireTo) => ({
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
});

// ackPolicy 'none': the debug-node output the test reads back is a JSON
// snapshot (functions like msg.ack don't survive the /comms websocket), so
// there is no way for this test to actually call msg.ack(). With 'explicit'
// that would leave every fetched message permanently pending and eligible
// for redelivery after ackWait, which would make a *later* cycle's fetch
// non-deterministically return a stale message instead of the fresh one it
// just published. 'none' sidesteps that - JetStream tracks no ack state at
// all, so there is nothing to redeliver.
const streamConsumerNode = (
  id,
  srv,
  streamName,
  consumerName,
  subject,
  wireTo
) => ({
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
  // The flow is deployed before its stream exists. "all" lets the consumer
  // still observe the first message if stream creation wins the startup race.
  deliverPolicy: 'all',
  ackWait: '30s',
  maxDeliver: 5,
  maxAckPending: 1000,
  batchSize: 1,
  maxWait: 2000,
  operation: 'consume',
  dataformat: 'auto',
  debug: false,
  wires: [[wireTo]],
});

// --- The suite -------------------------------------------------------------

test('reconnect + status: connect, disconnect, recover across every node type', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const runId = uid('rc');
  const streamName = `${runId}-stream`;
  const consumerName = `${runId}-consumer`;
  const jsSubject = `test.reconnect.js.${runId}`;
  const pubSubject = `test.reconnect.pub.${runId}`;
  const coreSubject = `test.reconnect.core.${runId}`;

  const srv = `${runId}-srv`;
  const pub = `${runId}-pub`;
  const pubInj = `${runId}-pubinj`;
  const sub = `${runId}-sub`;
  const subDbg = `${runId}-subdbg`;
  const spub = `${runId}-spub`;
  const spubDbg = `${runId}-spubdbg`;
  const spubInj = `${runId}-spubinj`;
  const scon = `${runId}-scon`;
  const sconDbg = `${runId}-scondbg`;
  const sconInj = `${runId}-sconinj`;
  const pendingCloseSrv = `${runId}-pending-close-srv`;

  // All five node types under coverage requirement 6, table-driven so the
  // per-type checks below (cold-start-red, then connected-green) are one
  // assertion loop instead of five near-identical copies.
  const nodeTypes = [
    { label: 'server', id: srv },
    { label: 'publish', id: pub },
    { label: 'subscribe', id: sub },
    { label: 'stream-publisher', id: spub },
    { label: 'stream-consumer', id: scon },
  ];

  const comms = connectComms();
  let flowAId;
  let pendingFlowId;
  const startedAt = new Date();

  try {
    await comms.ready;

    // ======================================================================
    // Phase 1 - broker down from the start. Covers claim 1.
    // ======================================================================
    await t.test(
      '1. cold start with broker down -> every node type shows red/ring, runtime stays up',
      async () => {
        stopNats();

        const flowANodes = [
          serverNode(srv, { reconnectTimeWait: 500 }),
          publishNode(pub, srv, pubSubject),
          subscribeNode(sub, srv, coreSubject, subDbg),
          debugNode(subDbg),
          streamPublisherNode(spub, srv, streamName, jsSubject, spubDbg),
          debugNode(spubDbg),
          streamConsumerNode(
            scon,
            srv,
            streamName,
            consumerName,
            jsSubject,
            sconDbg
          ),
          debugNode(sconDbg),
          injectNode(pubInj, pub),
          injectNode(spubInj, spub),
          injectNode(sconInj, scon),
        ];

        // Register every waiter before deploying: node construction for all
        // five types starts concurrently, so a waiter added after the fact can
        // miss a status broadcast that already happened (proven while writing
        // this file - a sequential registration loop silently dropped events).
        const waiters = nodeTypes.map(({ id }) =>
          comms.waitForStatus(id, d => d.fill === 'red', 20000)
        );

        flowAId = await deployFlow(flowANodes);
        const results = await Promise.all(waiters);

        results.forEach((d, i) => {
          assert.equal(
            d.fill,
            'red',
            `${nodeTypes[i].label} should show fill=red when the broker is down`
          );
          assert.equal(
            d.shape,
            'ring',
            `${nodeTypes[i].label} should show shape=ring (disconnected), not a dot`
          );
        });

        // Not "eventually times out" - the admin API must answer right now,
        // proving a broker outage at construction time didn't crash the runtime.
        const res = await fetch(`${NODE_RED_URL}/flows`);
        assert.ok(
          res.ok,
          'Node-RED admin API must stay responsive with the broker down at deploy time'
        );

        // A disposable config node proves that deleting a node whose initial
        // dial is still retrying completes without waiting for the broker.
        pendingFlowId = await deployFlow([
          serverNode(pendingCloseSrv, { reconnectTimeWait: 500 }),
        ]);
        const started = Date.now();
        await bounded(
          deleteFlow(pendingFlowId),
          10000,
          'pending-dial close did not resolve'
        );
        pendingFlowId = null;
        assert.ok(
          Date.now() - started < 10000,
          'pending-dial close must be bounded'
        );
      }
    );

    // ======================================================================
    // Phase 2 - bring the broker up. The flow was deployed while it was down;
    // every later phase reuses that same flow, proving recovery without a
    // redeploy.
    // ======================================================================
    await t.test(
      '2. broker comes up -> the already-deployed flow shows green',
      async () => {
        await startNats();

        const waiters = nodeTypes.map(({ id }) =>
          comms.waitForStatus(id, d => d.fill === 'green', 45000)
        );
        const results = await Promise.all(waiters);

        results.forEach((d, i) => {
          assert.equal(
            d.fill,
            'green',
            `${nodeTypes[i].label} should reach fill=green once the broker is reachable`
          );
        });
      }
    );

    // A single reusable check for "the whole pipe still works", called once
    // as a pre-outage baseline and again after every kill/restart cycle.
    async function proveMessageFlow(label) {
      // 1) Node-RED publish node -> real NATS: a direct subscriber sees it.
      {
        const directNc = await connectDirectNats();
        try {
          const delivered = subscribeOnce(directNc, pubSubject, 8000);
          await directNc.flush();
          await triggerInject(pubInj);
          const wireValue = await delivered;
          assert.ok(
            wireValue,
            `${label}: publish node should still reach NATS`
          );
        } finally {
          await directNc.close().catch(() => {});
        }
      }

      // 2) Direct NATS publish -> the SAME subscribe node established before
      // any outage -> its debug tap. This is claim 7: subscription survival.
      {
        const directNc = await connectDirectNats();
        try {
          const debugCaught = comms.waitForDebug(subDbg, 8000);
          publishDirect(directNc, coreSubject, `${label}-sub-check`);
          const msg = await debugCaught;
          assert.equal(
            msg.payload,
            `${label}-sub-check`,
            `${label}: pre-existing subscription must still deliver`
          );
        } finally {
          await directNc.close().catch(() => {});
        }
      }

      // 3) JetStream round trip: stream-publisher publishes, stream-consumer
      // (a durable PULL consumer, the highest-risk case per the brief)
      // fetches it. Both nodes are reused unchanged from Phase 2 - no redeploy.
      {
        const pubDebugCaught = comms.waitForDebug(spubDbg, 8000);
        await triggerInject(spubInj);
        const pubMsg = await pubDebugCaught;
        assert.equal(
          pubMsg.published,
          true,
          `${label}: JetStream publish should report published:true`
        );

        // Give the fetch a moment after the publish ack so the message is
        // durably visible to the pull consumer's next fetch() call.
        await new Promise(r => setTimeout(r, 300));

        const conDebugCaught = comms.waitForDebug(sconDbg, 8000);
        await triggerInject(sconInj);
        const conMsg = await conDebugCaught;
        assert.equal(
          conMsg.payload,
          pubMsg.payload,
          `${label}: JetStream pull consumer should deliver the message just published`
        );
      }
    }

    await t.test(
      'baseline (pre-outage): pub/sub and JetStream both work',
      async () => {
        await proveMessageFlow('baseline');
      }
    );

    const baselineConnections = await natsConnectionCount();

    // ======================================================================
    // Phase 3 - repeated kill/restart cycles. Covers claims 3, 4, 5, 7.
    // ======================================================================
    const CYCLES = 3;
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await t.test(
        `cycle ${cycle}/${CYCLES}: kill -> non-green -> restart -> green + messages resume, no redeploy`,
        async () => {
          // --- kill: claim 3 --------------------------------------------------
          // Both sets of waiters are registered up front, before killNats(), so
          // a fast transition can't be missed - and so that a failure in the
          // non-green assertions below still leaves startNats() reachable via
          // the finally, instead of stranding the broker down for every
          // subsequent cycle (a real failure mode hit while writing this file).
          const nonGreenWaiters = nodeTypes.map(({ id }) =>
            comms.waitForStatus(id, d => d.fill !== 'green', 10000)
          );
          const greenWaiters = nodeTypes.map(({ id }) =>
            comms.waitForStatus(id, d => d.fill === 'green', 45000)
          );

          killNats();
          try {
            const nonGreenResults = await Promise.all(nonGreenWaiters);
            nonGreenResults.forEach((d, i) => {
              assert.notEqual(
                d.fill,
                'green',
                `cycle ${cycle}: ${nodeTypes[i].label} must leave green when the broker is killed`
              );
              assert.equal(
                d.shape,
                'ring',
                `cycle ${cycle}: ${nodeTypes[i].label} non-green status should be shape=ring`
              );
            });
          } finally {
            await startNats();
          }

          // --- restart: claim 4a ----------------------------------------------
          const greenResults = await Promise.all(greenWaiters);
          greenResults.forEach((d, i) => {
            assert.equal(
              d.fill,
              'green',
              `cycle ${cycle}: ${nodeTypes[i].label} must return to green after the broker restarts`
            );
          });

          // --- messages flow again, same deployed flow: claims 4b, 5, 7 -------
          await proveMessageFlow(`cycle${cycle}`);
        }
      );
    }

    await t.test(
      '5. repeated cycles leave no growth in NATS connection count',
      async () => {
        const finalConnections = await natsConnectionCount();
        assert.ok(
          finalConnections <= baselineConnections + 1,
          `connection count should not grow across ${CYCLES} kill/restart cycles (baseline ${baselineConnections}, final ${finalConnections})`
        );
      }
    );

    await t.test(
      '6. deleting the established flow while the broker is down is bounded',
      async () => {
        killNats();
        const started = Date.now();
        await bounded(
          deleteFlow(flowAId),
          10000,
          'established close did not resolve'
        );
        flowAId = null;
        assert.ok(
          Date.now() - started < 10000,
          'established close must be bounded'
        );
      }
    );

    await t.test(
      '8. no unhandled rejection / crash in the Node-RED container after all outages',
      async () => {
        const logs = noderedLogsSince(startedAt.toISOString());
        assert.doesNotMatch(
          logs.toLowerCase(),
          /unhandledrejection|unhandled promise rejection/,
          'Node-RED logs must contain no unhandled promise rejection after repeated broker outages'
        );

        const res = await fetch(`${NODE_RED_URL}/flows`);
        assert.ok(
          res.ok,
          'Node-RED admin API must still be responsive after all cycles'
        );
      }
    );
  } finally {
    if (flowAId) await deleteFlow(flowAId).catch(() => {});
    if (pendingFlowId) await deleteFlow(pendingFlowId).catch(() => {});
    await sweepHarnessFlows().catch(() => {});
    comms.close();
    await deleteStream(streamName).catch(() => {});
    // Always leave the broker running for other agents / the next run, even
    // if an assertion above threw mid-outage.
    await startNats().catch(() => {});
  }
});

// Coverage for Step 3 of NATS-3.4-GAP-PLAN.md: getServers()/setServers()/
// reconnect() pass-throughs on nats-suite-server. These are exercised by
// instantiating the real node file against the real broker, using the same
// minimal RED shim `promotion.test.js` uses for unit-level checks - no
// node-red-node-test-helper, and no NATS mocking (the node's own connect()
// call reaches the real Docker broker).
//
// Kept as a direct-construction shim rather than a deployed flow through
// nats-suite-server-pool (test/server-pool.test.js) on purpose: that node
// validates its own input and never calls setServers([]) on the real client,
// so it can't prove the client itself throws on an empty pool. This test
// proves the raw config-node contract; server-pool.test.js proves the
// consumer-facing msg shapes, validation-before-touching-the-connection, and
// (via reconnectAfterSet) that reconnect() really moves a live connection.
function fakeRedForServerNode() {
  const constructors = new Map();
  return {
    constructors,
    nodes: {
      registerType(type, constructor) {
        constructors.set(type, constructor);
      },
      createNode(node, config) {
        node.id = config.id;
        node.credentials = {};
        node.handlers = new Map();
        node.on = (event, handler) => node.handlers.set(event, handler);
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        node.log = () => {};
      },
    },
  };
}

test('getServers()/setServers() round-trip against the real broker', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const RED = fakeRedForServerNode();
  require(path.join(REPO_ROOT, 'nodes/nats-suite-server.js'))(RED);
  const Constructor = RED.constructors.get('nats-suite-server');
  const node = new Constructor({ id: 'server-pool-test', server: NATS_URL });

  try {
    await node.getConnection();

    const before = node.getServers();
    assert.ok(
      before.some(s => s.listen === NATS_URL),
      `getServers() must include the connected broker (${NATS_URL}), got ${JSON.stringify(before)}`
    );

    assert.throws(
      () => node.setServers([]),
      'setServers([]) must throw rather than silently accept an empty pool'
    );

    node.setServers([NATS_URL, 'localhost:4223']);
    const after = node.getServers().map(s => s.listen);
    assert.deepEqual(
      after.sort(),
      [NATS_URL, 'localhost:4223'].sort(),
      'getServers() must reflect the pool just written by setServers(), round-tripped via .listen'
    );
  } finally {
    await node.handlers.get('close').call(node, () => {});
  }
});
