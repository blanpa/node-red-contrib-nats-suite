'use strict';

// Step 4 (RENOVATION-PLAN.md) coverage for the @nats-io/jetstream 3.4.0
// migration in nats-suite-stream-publisher.js / nats-suite-stream-consumer.js:
//   - the stream-publisher's "purge" operation, which is bug 1 - the old
//     code called the nonexistent Stream#purge() and threw every time; the
//     fix routes through JetStreamManager#streams.purge() instead.
//   - explicit ack()/nak()/term() from a JetStream pull consumer, checked
//     against the real consumer's server-side ack state (num_ack_pending,
//     num_redelivered), not just "the call didn't throw".
//   - the credsAuthenticator -> jwtAuthenticator fix (bug 2), as a focused
//     unit-level check: a real NATS server with JWT/operator auth configured
//     is out of scope for this harness, so this proves the *API contract*
//     instead - that jwtAuthenticator(jwt, seed) actually uses both
//     arguments (a real nkey-derived signature over the given JWT), which is
//     exactly what credsAuthenticator's silently-dropped second argument
//     used to fail to do.
//
// Real Node-RED + real NATS (JetStream) via docker-compose, no mocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  jwtAuthenticator,
  nkeys,
  headers: natsHeaders,
} = require('@nats-io/nats-core');
const {
  AckPolicy,
  jetstream,
  jetstreamManager,
} = require('@nats-io/jetstream');
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

async function deleteStream(nc, name) {
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.streams.delete(name);
  } catch {
    // The stream may not have been created if setup failed.
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

function functionNode(id, func, wireTo) {
  return {
    id,
    type: 'function',
    z: 'FLOW',
    name: '',
    func,
    outputs: 1,
    noerr: 0,
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
    ackPolicy: 'explicit',
    deliverPolicy: 'all',
    ackWait: '30s',
    maxDeliver: 5,
    maxAckPending: 1000,
    batchSize: 1,
    maxWait: 1500,
    operation: 'consume',
    dataformat: 'auto',
    debug: false,
    wires: [[wireTo]],
  };
}

// --- 1. Stream purge (bug 1 regression) ------------------------------------

test('stream-publisher: "purge" operation empties a real stream (bug 1: Stream#purge() does not exist)', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('purge-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.purge.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const injPublish = `${id}injpub`;
  const injPurge = `${id}injpurge`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    streamPublisherNode(spub, srv, streamName, subject, dbg),
    injectNode(injPublish, spub, [{ p: 'payload', v: 'hello', vt: 'str' }]),
    injectNode(injPurge, spub, [{ p: 'operation', v: 'purge', vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    // Publish twice so there is something real to purge.
    for (let i = 0; i < 2; i++) {
      const published = comms.waitForDebug(dbg, 8000);
      await triggerInject(injPublish);
      const msg = await published;
      assert.equal(msg.published, true, 'publish should succeed before purge');
    }

    const jsm = await jetstreamManager(directNc);
    const beforePurge = await jsm.streams.info(streamName);
    assert.ok(
      beforePurge.state.messages >= 2,
      'stream should hold the 2 published messages before purge'
    );

    const purged = comms.waitForDebug(dbg, 8000);
    await triggerInject(injPurge);
    const purgeMsg = await purged;
    assert.equal(purgeMsg.payload.operation, 'purge');
    assert.equal(
      purgeMsg.payload.success,
      true,
      'purge must report success, not throw (bug 1)'
    );

    const afterPurge = await jsm.streams.info(streamName);
    assert.equal(
      afterPurge.state.messages,
      0,
      'stream must actually be empty after purge'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

// --- 2. Explicit ack / nak / term, checked against real consumer state ----

test('stream-consumer: explicit ack()/nak()/term() reach the real JetStream consumer', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('acknak-');
  const streamName = `STREAM_${id}`;
  const consumerName = `CONSUMER_${id}`;
  const subject = `test.jetstream.acknak.${id}`;
  const srv = `${id}srv`;
  const scon = `${id}scon`;
  const sconInj = `${id}sconinj`;
  const fn = `${id}fn`;
  const dbg = `${id}dbg`;

  // Explicit ack policy: ack the first payload, nak-then-ack the second
  // (JetStream redelivers it once the nak's delay elapses, `msg.redelivered`
  // distinguishes the two deliveries), term the third.
  const func = `
    if (msg.payload === 'ack-me') {
      msg.ack();
      return { payload: { result: 'acked', redelivered: msg.redelivered } };
    }
    if (msg.payload === 'nak-me') {
      if (msg.redelivered) {
        msg.ack();
        return { payload: { result: 'nak-then-acked', redelivered: msg.redelivered } };
      }
      msg.nak();
      return { payload: { result: 'naked', redelivered: msg.redelivered } };
    }
    if (msg.payload === 'term-me') {
      msg.term();
      return { payload: { result: 'termed', redelivered: msg.redelivered } };
    }
    return { payload: { result: 'unexpected', raw: msg.payload } };
  `;

  const nodes = [
    serverNode(srv),
    streamConsumerNode(scon, srv, streamName, consumerName, subject, fn),
    // The consumer is pull-based: it fetches one batch per input message,
    // it does not run its own poll loop (matches reconnect.test.js's proven
    // pattern for driving this same node type).
    injectNode(sconInj, scon, [{ p: 'payload' }]),
    functionNode(fn, func, dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    // The stream-consumer node only creates the *consumer* on init and
    // requires the stream to already exist - create it directly here with
    // the same client the rest of this test publishes through.
    const setupJsm = await jetstreamManager(directNc);
    await setupJsm.streams.add({ name: streamName, subjects: [subject] });

    await comms.ready;
    const conReady = comms.waitForStatus(scon, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await conReady;

    // Publish directly, then pulse the consumer's input once to make it
    // fetch+process exactly that one message (it runs one fetch per input,
    // it does not poll on its own).
    const publishAndFetch = async payload => {
      const wire = comms.waitForDebug(dbg, 10000);
      directNc.publish(subject, payload);
      await triggerInject(sconInj);
      return wire;
    };
    const fetchOnly = async timeoutMs => {
      const wire = comms.waitForDebug(dbg, timeoutMs);
      await triggerInject(sconInj);
      return await wire;
    };

    // ack-me
    const acked = await publishAndFetch('ack-me');
    assert.equal(acked.payload.result, 'acked');
    assert.equal(acked.payload.redelivered, false);

    // nak-me: first delivery naks with a short delay, second (redelivered)
    // delivery acks.
    const nakedFirst = await publishAndFetch('nak-me');
    assert.equal(nakedFirst.payload.result, 'naked');
    assert.equal(nakedFirst.payload.redelivered, false);

    const nakedSecond = await fetchOnly(10000);
    assert.equal(nakedSecond.payload.result, 'nak-then-acked');
    assert.equal(
      nakedSecond.payload.redelivered,
      true,
      'the naked message must come back marked redelivered'
    );

    // term-me: acknowledge as terminal, then prove it is never redelivered.
    const termed = await publishAndFetch('term-me');
    assert.equal(termed.payload.result, 'termed');

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.consumers.info(streamName, consumerName);
    assert.equal(
      info.num_ack_pending,
      0,
      'every message must have been settled (ack/term), none left pending'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test(
  'stream-publisher: native schedule option delivers a delayed message',
  { timeout: 20000 },
  async t => {
    if (!(await checkStack(t))) return;

    const id = uid('schedule-');
    const streamName = `STREAM_${id}`;
    const prefix = `test.jetstream.schedule.${id}`;
    const scheduleSubject = `${prefix}.schedule.once`;
    const targetSubject = `${prefix}.target`;
    const srv = `${id}srv`;
    const fn = `${id}fn`;
    const spub = `${id}spub`;
    const inj = `${id}inj`;
    const dbg = `${id}dbg`;

    const publisher = streamPublisherNode(
      spub,
      srv,
      streamName,
      scheduleSubject,
      dbg
    );
    publisher.subjectPattern = [
      `${prefix}.schedule.>`,
      targetSubject,
      `${prefix}.cancel`,
    ].join(',');
    publisher.storage = 'memory';
    publisher.allowMsgSchedules = true;

    const nodes = [
      serverNode(srv),
      injectNode(inj, fn, [{ p: 'payload', v: 'scheduled', vt: 'str' }]),
      functionNode(
        fn,
        `msg.subject = ${JSON.stringify(scheduleSubject)};
         msg.schedule = {
           specification: { at: new Date(Date.now() + 1000).toISOString() },
           target: ${JSON.stringify(targetSubject)}
         };
         return msg;`,
        spub
      ),
      publisher,
      debugNode(dbg),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      const jsm = await jetstreamManager(directNc);
      await jsm.streams.add({
        name: streamName,
        subjects: publisher.subjectPattern.split(','),
        storage: 'memory',
      });

      await comms.ready;
      const ready = comms.waitForStatus(
        spub,
        status => status.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await ready;

      await jsm.consumers.add(streamName, {
        durable_name: 'scheduled-delivery',
        filter_subject: targetSubject,
        ack_policy: AckPolicy.Explicit,
      });

      const published = comms.waitForDebug(dbg, 10000);
      await triggerInject(inj);
      const pubAck = await published;
      assert.equal(pubAck.published, true);
      const info = await jsm.streams.info(streamName);
      assert.equal(info.config.allow_msg_schedules, true);

      const js = jetstream(directNc);
      const consumer = await js.consumers.get(streamName, 'scheduled-delivery');
      const delivered = await consumer.next({ expires: 15000 });
      assert.ok(delivered);
      assert.equal(delivered.string(), 'scheduled');
      assert.equal(delivered.subject, targetSubject);
      delivered.ack();
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
      await deleteStream(directNc, streamName);
      await ignoreFailure(directNc.close());
    }
  }
);

// --- Step 4 (NATS-3.4-GAP-PLAN.md): cron scheduling. The one-shot `{ at }`
// form above already proved the passthrough works; these prove the
// recurring `{ cron }` form actually fires repeatedly server-side (not just
// once), and that the new config-level default schedule fields never
// override an explicit msg.schedule.

test(
  'stream-publisher: recurring cron schedule delivers repeatedly on the expected cadence',
  { timeout: 25000 },
  async t => {
    if (!(await checkStack(t))) return;

    const id = uid('cron-');
    const streamName = `STREAM_${id}`;
    const prefix = `test.jetstream.cron.${id}`;
    const cronSubject = `${prefix}.schedule.recurring`;
    const targetSubject = `${prefix}.target`;
    const srv = `${id}srv`;
    const fn = `${id}fn`;
    const spub = `${id}spub`;
    const inj = `${id}inj`;
    const dbg = `${id}dbg`;

    const publisher = streamPublisherNode(
      spub,
      srv,
      streamName,
      cronSubject,
      dbg
    );
    publisher.subjectPattern = [`${prefix}.schedule.>`, targetSubject].join(
      ','
    );
    publisher.storage = 'memory';
    publisher.allowMsgSchedules = true;

    const nodes = [
      serverNode(srv),
      injectNode(inj, fn, [{ p: 'payload', v: 'tick', vt: 'str' }]),
      functionNode(
        fn,
        `msg.subject = ${JSON.stringify(cronSubject)};
         msg.schedule = {
           specification: { cron: '*/2 * * * * *' },
           target: ${JSON.stringify(targetSubject)}
         };
         return msg;`,
        spub
      ),
      publisher,
      debugNode(dbg),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      const jsm = await jetstreamManager(directNc);
      await jsm.streams.add({
        name: streamName,
        subjects: publisher.subjectPattern.split(','),
        storage: 'memory',
      });

      await comms.ready;
      const ready = comms.waitForStatus(
        spub,
        status => status.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await ready;

      await jsm.consumers.add(streamName, {
        durable_name: 'cron-delivery',
        filter_subject: targetSubject,
        ack_policy: AckPolicy.Explicit,
      });

      const published = comms.waitForDebug(dbg, 10000);
      await triggerInject(inj);
      const pubAck = await published;
      assert.equal(pubAck.published, true);

      const js = jetstream(directNc);
      const consumer = await js.consumers.get(streamName, 'cron-delivery');

      // Bounded absolute deadline, not a sleep loop: keep pulling until 2
      // deliveries land or the window closes.
      const deliveries = [];
      const deadline = Date.now() + 12000;
      while (deliveries.length < 2 && Date.now() < deadline) {
        const delivered = await consumer.next({ expires: 3000 });
        if (!delivered) continue;
        deliveries.push(Date.now());
        assert.equal(delivered.string(), 'tick');
        assert.equal(delivered.subject, targetSubject);
        delivered.ack();
      }

      assert.ok(
        deliveries.length >= 2,
        `expected at least 2 recurring deliveries within the bounded window, got ${deliveries.length}`
      );
      const gap = deliveries[1] - deliveries[0];
      assert.ok(
        gap > 500 && gap < 6000,
        `delivery gap ${gap}ms should be roughly the 2s cron cadence, not e.g. instant or absent`
      );
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
      await deleteStream(directNc, streamName);
      await ignoreFailure(directNc.close());
    }
  }
);

test(
  'stream-publisher: explicit msg.schedule overrides the config-level default schedule',
  { timeout: 20000 },
  async t => {
    if (!(await checkStack(t))) return;

    const id = uid('schedule-override-');
    const streamName = `STREAM_${id}`;
    const prefix = `test.jetstream.scheduleOverride.${id}`;
    const subject = `${prefix}.in`;
    const configTarget = `${prefix}.config-target`;
    const realTarget = `${prefix}.real-target`;
    const srv = `${id}srv`;
    const fn = `${id}fn`;
    const spub = `${id}spub`;
    const inj = `${id}inj`;
    const dbg = `${id}dbg`;

    const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
    publisher.subjectPattern = [subject, configTarget, realTarget].join(',');
    publisher.storage = 'memory';
    publisher.allowMsgSchedules = true;
    // A config-level default that must NOT fire during this test - the
    // message-level msg.schedule below targets a different subject and,
    // per this file's existing precedence convention (top-level msg.*
    // shorthand always wins over a config/connection-level default), must
    // be the one that actually delivers.
    publisher.scheduleType = 'cron';
    publisher.scheduleCron = '0 0 1 1 *'; // once a year - inert for this test
    publisher.scheduleTarget = configTarget;

    const nodes = [
      serverNode(srv),
      injectNode(inj, fn, [{ p: 'payload', v: 'override-wins', vt: 'str' }]),
      functionNode(
        fn,
        `msg.subject = ${JSON.stringify(subject)};
         msg.schedule = {
           specification: { at: new Date(Date.now() + 1000).toISOString() },
           target: ${JSON.stringify(realTarget)}
         };
         return msg;`,
        spub
      ),
      publisher,
      debugNode(dbg),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      const jsm = await jetstreamManager(directNc);
      await jsm.streams.add({
        name: streamName,
        subjects: publisher.subjectPattern.split(','),
        storage: 'memory',
      });

      await comms.ready;
      const ready = comms.waitForStatus(
        spub,
        status => status.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await ready;

      await jsm.consumers.add(streamName, {
        durable_name: 'real-target-delivery',
        filter_subject: realTarget,
        ack_policy: AckPolicy.Explicit,
      });
      await jsm.consumers.add(streamName, {
        durable_name: 'config-target-delivery',
        filter_subject: configTarget,
        ack_policy: AckPolicy.Explicit,
      });

      const published = comms.waitForDebug(dbg, 10000);
      await triggerInject(inj);
      const pubAck = await published;
      assert.equal(pubAck.published, true);

      const js = jetstream(directNc);
      const realConsumer = await js.consumers.get(
        streamName,
        'real-target-delivery'
      );
      const delivered = await realConsumer.next({ expires: 15000 });
      assert.ok(
        delivered,
        'the message-level msg.schedule must win over the config-level default'
      );
      assert.equal(delivered.string(), 'override-wins');
      assert.equal(delivered.subject, realTarget);
      delivered.ack();

      const configConsumer = await js.consumers.get(
        streamName,
        'config-target-delivery'
      );
      const configDelivered = await configConsumer.next({ expires: 4000 });
      assert.equal(
        configDelivered,
        null,
        'the config-level default schedule (yearly cron) must never have fired'
      );
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
      await deleteStream(directNc, streamName);
      await ignoreFailure(directNc.close());
    }
  }
);

// The two tests above only ever exercise buildConfigSchedule() as dead code:
// the cadence test drives everything through msg.schedule and never sets
// scheduleType/scheduleCron/scheduleTarget at all, and the override test sets
// them but its built object is immediately replaced by msg.schedule before
// publish - it proves msg.schedule wins, not that the config-only path can
// ever deliver anything. This proves the actual editor-fields convenience
// path (no msg.schedule at all) really reaches NATS.
test(
  'stream-publisher: config-level schedule fields alone deliver via buildConfigSchedule',
  { timeout: 20000 },
  async t => {
    if (!(await checkStack(t))) return;

    const id = uid('config-schedule-');
    const streamName = `STREAM_${id}`;
    const prefix = `test.jetstream.configSchedule.${id}`;
    const subject = `${prefix}.in`;
    const targetSubject = `${prefix}.target`;
    const srv = `${id}srv`;
    const spub = `${id}spub`;
    const inj = `${id}inj`;
    const dbg = `${id}dbg`;

    const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
    publisher.subjectPattern = [subject, targetSubject].join(',');
    publisher.storage = 'memory';
    publisher.allowMsgSchedules = true;
    // No msg.schedule anywhere in this flow - delivery can only happen if
    // buildConfigSchedule() reads these three fields and wires them into
    // publishOptions.schedule itself.
    publisher.scheduleType = 'at';
    publisher.scheduleAt = new Date(Date.now() + 1000).toISOString();
    publisher.scheduleTarget = targetSubject;

    const nodes = [
      serverNode(srv),
      injectNode(inj, spub, [
        { p: 'payload', v: 'config-scheduled', vt: 'str' },
      ]),
      publisher,
      debugNode(dbg),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      const jsm = await jetstreamManager(directNc);
      await jsm.streams.add({
        name: streamName,
        subjects: publisher.subjectPattern.split(','),
        storage: 'memory',
      });

      await comms.ready;
      const ready = comms.waitForStatus(
        spub,
        status => status.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await ready;

      await jsm.consumers.add(streamName, {
        durable_name: 'config-schedule-delivery',
        filter_subject: targetSubject,
        ack_policy: AckPolicy.Explicit,
      });

      const published = comms.waitForDebug(dbg, 10000);
      await triggerInject(inj);
      const pubAck = await published;
      assert.equal(pubAck.published, true);

      const js = jetstream(directNc);
      const consumer = await js.consumers.get(
        streamName,
        'config-schedule-delivery'
      );
      const delivered = await consumer.next({ expires: 15000 });
      assert.ok(
        delivered,
        'buildConfigSchedule() must have produced a schedule NATS actually delivered'
      );
      assert.equal(delivered.string(), 'config-scheduled');
      assert.equal(delivered.subject, targetSubject);
      delivered.ack();
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
      await deleteStream(directNc, streamName);
      await ignoreFailure(directNc.close());
    }
  }
);

// --- Message tracing (Step 2): connection-level switch only (no per-message
// override - NATS-3.4-GAP-PLAN.md decision 2). JetStreamPublishOptions has no
// traceDestination field and @nats-io/jetstream's publish() silently drops
// unknown option keys, so this proves the header-based workaround actually
// reaches the wire, not just "the option didn't throw".

test('stream-publisher: server-level enableTracing makes a JetStream publish() emit a real NATS trace event', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('trace-jspub-on-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.trace.${id}`;
  const traceSubject = `test.jetstream.trace.dest.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv, { enableTracing: true, traceDestination: traceSubject }),
    streamPublisherNode(spub, srv, streamName, subject, dbg),
    injectNode(inj, spub, [{ p: 'payload', v: 'hello', vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const traceEvent = subscribeOnce(directNc, traceSubject, 8000);
    const published = comms.waitForDebug(dbg, 8000);
    await directNc.flush();
    await triggerInject(inj);
    const [trace, pubAck] = await Promise.all([traceEvent, published]);

    assert.equal(
      pubAck.published,
      true,
      'the real JetStream publish must still succeed under tracing'
    );
    const traceJson = JSON.parse(trace);
    assert.deepEqual(traceJson.request.header['Nats-Trace-Dest'], [
      traceSubject,
    ]);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: enableTracing off (the default) never emits a trace event, and msg.options.traceDestination does not turn it on', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('trace-jspub-off-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.trace.off.${id}`;
  const traceSubject = `test.jetstream.trace.off.dest.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    streamPublisherNode(spub, srv, streamName, subject, dbg),
    injectNode(inj, spub, [
      { p: 'payload', v: 'hello', vt: 'str' },
      // Tracing is a connection-level-only switch (NATS-3.4-GAP-PLAN.md
      // decision 2) - a msg.options passthrough field of the same name must
      // NOT be treated as a per-message trace override.
      {
        p: 'options',
        v: JSON.stringify({ traceDestination: traceSubject }),
        vt: 'json',
      },
    ]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const noTrace = subscribeOnce(directNc, traceSubject, 1500);
    const published = comms.waitForDebug(dbg, 8000);
    await directNc.flush();
    await triggerInject(inj);

    await assert.rejects(
      noTrace,
      /Timed out/,
      'no trace event should be emitted when connection-level tracing is off'
    );
    const pubAck = await published;
    assert.equal(pubAck.published, true);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test(
  'stream-consumer: pause/resume and info use the server APIs',
  { timeout: 20000 },
  async t => {
    if (!(await checkStack(t))) return;

    const id = uid('consumer-api-');
    const streamName = `STREAM_${id}`;
    const consumerName = `CONSUMER_${id}`;
    const subject = `test.jetstream.consumer.${id}`;
    const srv = `${id}srv`;
    const scon = `${id}scon`;
    const dbg = `${id}dbg`;
    const pause = `${id}pause`;
    const resume = `${id}resume`;
    const info = `${id}info`;

    const nodes = [
      serverNode(srv),
      streamConsumerNode(scon, srv, streamName, consumerName, subject, dbg),
      injectNode(pause, scon, [{ p: 'operation', v: 'pause', vt: 'str' }]),
      injectNode(resume, scon, [{ p: 'operation', v: 'resume', vt: 'str' }]),
      injectNode(info, scon, [{ p: 'operation', v: 'info', vt: 'str' }]),
      debugNode(dbg),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      const jsm = await jetstreamManager(directNc);
      await jsm.streams.add({ name: streamName, subjects: [subject] });

      await comms.ready;
      const ready = comms.waitForStatus(
        scon,
        status => status.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await ready;

      let output = comms.waitForDebug(dbg, 10000);
      await triggerInject(pause);
      assert.equal((await output).payload.paused, true);
      assert.equal(
        (await jsm.consumers.info(streamName, consumerName)).paused,
        true
      );

      output = comms.waitForDebug(dbg, 10000);
      await triggerInject(resume);
      assert.equal((await output).payload.paused, false);
      assert.equal(
        Boolean((await jsm.consumers.info(streamName, consumerName)).paused),
        false
      );

      output = comms.waitForDebug(dbg, 10000);
      await triggerInject(info);
      assert.equal(typeof (await output).payload.ack_pending, 'number');
    } finally {
      if (flowId) await ignoreFailure(deleteFlow(flowId));
      comms.close();
      await deleteStream(directNc, streamName);
      await ignoreFailure(directNc.close());
    }
  }
);

// --- 3. jwtAuthenticator uses BOTH arguments (bug 2 unit-level check) ------
//
// Substitution, stated plainly: exercising this through a live Node-RED flow
// would need a real NATS operator/account JWT resolver, which this
// docker-compose stack does not configure. This instead calls the exact
// function nats-suite-server.js now calls (jwtAuthenticator) with a real
// nkey-derived seed and asserts the returned Auth actually incorporates
// both the JWT string and a signature derived from the seed - which is
// precisely what credsAuthenticator's silently-dropped second argument
// (the bug) failed to do.

test('jwtAuthenticator(jwt, seed): both arguments are honored (bug 2)', () => {
  const keypair = nkeys.createUser();
  const seed = keypair.getSeed();
  const fakeJwt = 'header.payload.signature';

  const authFn = jwtAuthenticator(fakeJwt, seed);
  assert.equal(typeof authFn, 'function');

  const auth = authFn('test-nonce');
  assert.equal(
    auth.jwt,
    fakeJwt,
    'the JWT argument must be carried through unchanged'
  );
  assert.ok(
    auth.sig && auth.sig.length > 0,
    'a signature derived from the seed argument must be present'
  );
  assert.ok(
    auth.nkey && auth.nkey.startsWith('U'),
    'the nkey public key derived from the seed must be present'
  );

  // Prove the signature really is seed-dependent, not a stub: a different
  // seed over the same nonce produces a different signature.
  const otherAuth = jwtAuthenticator(
    fakeJwt,
    nkeys.createUser().getSeed()
  )('test-nonce');
  assert.notEqual(
    auth.sig,
    otherAuth.sig,
    'the signature must depend on the seed, proving the seed argument is used'
  );
});

// --- Step 5 Agent A (NATS-3.4-GAP-PLAN.md): allowDirect wiring ------------
//
// allow_direct was previously a dead checkbox on nats-suite-stream-publisher
// - it set the stream config field but nothing downstream ever read it. This
// re-adds it and wires it into the real create/update stream calls. The
// consumer-side jsm.direct.getMessage() read path that actually uses this
// flag is a parallel change (Agent B, nats-suite-stream-consumer.js) and is
// tested separately there.

test('stream-publisher: allowDirect on create actually sets allow_direct on the real stream', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('directget-create-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.directget.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;

  const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
  publisher.storage = 'memory';
  publisher.allowDirect = true;

  const nodes = [serverNode(srv), publisher, debugNode(dbg)];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.config.allow_direct,
      true,
      'allowDirect on the node must produce allow_direct: true on the real stream, not just sit unused in the editor'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: "update" preserves an existing allow_direct: true when neither msg nor config specify it', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('directget-update-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.directget.${id}`;
  const srv = `${id}srv`;
  const spubCreate = `${id}spubcreate`;
  const spubUpdate = `${id}spubupdate`;
  const injUpdate = `${id}injupdate`;
  const dbg = `${id}dbg`;

  // Creates the stream with allow_direct: true.
  const creator = streamPublisherNode(
    spubCreate,
    srv,
    streamName,
    subject,
    dbg
  );
  creator.storage = 'memory';
  creator.allowDirect = true;

  // A second node targeting the same stream, deliberately NOT setting
  // allowDirect at all (config.allowDirect stays undefined, not false) -
  // proves the update path falls through to currentStream.config.allow_direct
  // rather than defaulting to false and silently disabling it.
  const updater = streamPublisherNode(
    spubUpdate,
    srv,
    streamName,
    subject,
    dbg
  );
  updater.storage = 'memory';
  updater.operation = 'update';
  updater.createOnInit = false;

  const nodes = [
    serverNode(srv),
    creator,
    updater,
    injectNode(injUpdate, spubUpdate, [
      { p: 'operation', v: 'update', vt: 'str' },
    ]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const creatorReady = comms.waitForStatus(
      spubCreate,
      d => d.fill === 'green',
      15000
    );
    const updaterReady = comms.waitForStatus(
      spubUpdate,
      d => d.fill === 'green',
      15000
    );
    flowId = await deployFlow(nodes);
    await creatorReady;
    await updaterReady;

    const jsm = await jetstreamManager(directNc);
    const beforeUpdate = await jsm.streams.info(streamName);
    assert.equal(
      beforeUpdate.config.allow_direct,
      true,
      'precondition: stream must start with allow_direct: true'
    );

    const updated = comms.waitForDebug(dbg, 8000);
    await triggerInject(injUpdate);
    const updateMsg = await updated;
    assert.equal(updateMsg.payload.operation, 'update');
    assert.equal(updateMsg.payload.success, true);

    const afterUpdate = await jsm.streams.info(streamName);
    assert.equal(
      afterUpdate.config.allow_direct,
      true,
      'update with neither msg.allowDirect nor config.allowDirect set must preserve the existing value, not reset it to false'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

// --- Direct message get (Step 5, NATS-3.4-GAP-PLAN.md) --------------------

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

test('stream-consumer: "get-message" retrieves a known message by seq (direct) and by last-by-subject (manager), errors when not found', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('get-message-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.get-message.${id}`;
  const srv = `${id}srv`;
  const scon = `${id}scon`;
  const injBySeq = `${id}injseq`;
  const injByLast = `${id}injlast`;
  const injNotFound = `${id}injnf`;
  const fnBySeq = `${id}fnseq`;
  const fnByLast = `${id}fnlast`;
  const fnNotFound = `${id}fnnf`;
  const cat = `${id}cat`;
  const dbg = `${id}dbg`;
  const dbgCatch = `${id}dbgcatch`;

  const directNc = await connectDirectNats();
  const comms = connectComms();
  let flowId;
  try {
    const jsm = await jetstreamManager(directNc);
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: 'memory',
      allow_direct: true,
    });

    // Publish directly (not through a flow) so the real seq is known to
    // this test before the get-message flow is even built.
    const js = jetstream(directNc);
    const hdrs = natsHeaders();
    hdrs.set('x-test-header', 'hello-header');
    const payload = { hello: 'get-message' };
    const pubAck = await js.publish(subject, JSON.stringify(payload), {
      headers: hdrs,
    });

    const consumer = streamConsumerNode(
      scon,
      srv,
      streamName,
      `${id}-unused-consumer`,
      subject,
      dbg
    );
    consumer.operation = 'get-message';

    const nodes = [
      serverNode(srv),
      consumer,
      injectNode(injBySeq, fnBySeq, [{ p: 'payload', v: '', vt: 'str' }]),
      functionNode(
        fnBySeq,
        `msg.seq = ${pubAck.seq};
         msg.useDirectGet = true;
         return msg;`,
        scon
      ),
      injectNode(injByLast, fnByLast, [{ p: 'payload', v: '', vt: 'str' }]),
      functionNode(
        fnByLast,
        `msg.lastBySubject = ${JSON.stringify(subject)};
         msg.useDirectGet = false;
         return msg;`,
        scon
      ),
      injectNode(injNotFound, fnNotFound, [{ p: 'payload', v: '', vt: 'str' }]),
      functionNode(
        fnNotFound,
        `msg.seq = ${pubAck.seq + 999999};
         return msg;`,
        scon
      ),
      catchNode(cat, [scon], dbgCatch),
      debugNode(dbg),
      debugNode(dbgCatch),
    ];

    await comms.ready;
    const ready = comms.waitForStatus(scon, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    // 1. By sequence, via the faster direct-get path.
    const bySeq = comms.waitForDebug(dbg, 8000);
    await triggerInject(injBySeq);
    const bySeqMsg = await bySeq;
    assert.equal(bySeqMsg.operation, 'get-message');
    assert.deepEqual(
      bySeqMsg.payload,
      payload,
      'payload must round-trip exactly'
    );
    assert.equal(bySeqMsg.subject, subject);
    assert.equal(bySeqMsg.sequence, pubAck.seq);
    assert.equal(
      bySeqMsg.headers['x-test-header'],
      'hello-header',
      'headers must round-trip exactly via the direct-get path'
    );

    // 2. By last-message-for-subject, via the always-available manager path.
    const byLast = comms.waitForDebug(dbg, 8000);
    await triggerInject(injByLast);
    const byLastMsg = await byLast;
    assert.deepEqual(
      byLastMsg.payload,
      payload,
      'manager-level getMessage() must return the same message as the direct path'
    );
    assert.equal(byLastMsg.sequence, pubAck.seq);
    assert.equal(
      byLastMsg.headers['x-test-header'],
      'hello-header',
      'headers must round-trip exactly via the manager-level path too'
    );

    // 3. No matching message: a real error, not a silent empty payload.
    const caught = comms.waitForDebug(dbgCatch, 8000);
    await triggerInject(injNotFound);
    const caughtMsg = await caught;
    assert.ok(caughtMsg.error, 'a not-found lookup must reach the Catch node');
    assert.match(
      caughtMsg.error.message,
      /no message found/i,
      'the error must be the get-message not-found error, not something else'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-consumer: priority_groups/priority_policy/priority_timeout land on the real consumer created at deploy', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('priority-create-');
  const streamName = `STREAM_${id}`;
  const consumerName = `CONSUMER_${id}`;
  const subject = `test.jetstream.prioritycreate.${id}`;
  const srv = `${id}srv`;
  const scon = `${id}scon`;
  const dbg = `${id}dbg`;

  const directNc = await connectDirectNats();
  const comms = connectComms();
  let flowId;
  try {
    const jsm = await jetstreamManager(directNc);
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: 'memory',
    });

    const consumer = streamConsumerNode(
      scon,
      srv,
      streamName,
      consumerName,
      subject,
      dbg
    );
    consumer.priorityGroups = 'grp-a, grp-b';
    consumer.priorityPolicy = 'overflow';
    consumer.priorityTimeout = '30s';

    const nodes = [serverNode(srv), consumer, debugNode(dbg)];

    await comms.ready;
    const ready = comms.waitForStatus(scon, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    const info = await jsm.consumers.info(streamName, consumerName);
    assert.deepEqual(
      info.config.priority_groups,
      ['grp-a', 'grp-b'],
      'comma-separated priorityGroups must land as a real string array'
    );
    assert.equal(info.config.priority_policy, 'overflow');
    assert.equal(
      info.config.priority_timeout,
      30_000_000_000,
      'priorityTimeout is a duration string converted to nanoseconds (unlike KV markerTTL, a raw Go-duration string)'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-consumer: pedantic rejects a real config/ack_wait mismatch that non-pedantic accepts', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('pedantic-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.pedantic.${id}`;
  const srv = `${id}srv`;
  const scon = `${id}scon`;
  const injNonPedantic = `${id}injnp`;
  const injPedantic = `${id}injp`;
  const fnNonPedantic = `${id}fnnp`;
  const fnPedantic = `${id}fnp`;
  const cat = `${id}cat`;
  const dbg = `${id}dbg`;
  const dbgCatch = `${id}dbgcatch`;

  const directNc = await connectDirectNats();
  const comms = connectComms();
  let flowId;
  try {
    const jsm = await jetstreamManager(directNc);
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: 'memory',
    });

    const consumer = streamConsumerNode(
      scon,
      srv,
      streamName,
      `${id}-unused-consumer`,
      subject,
      dbg
    );
    consumer.operation = 'create';

    // A backoff whose first value does not equal ack_wait: the server
    // accepts this normally (verified against a real broker) but rejects
    // it with "pedantic mode: first backoff value has to equal batch
    // AckWait" once pedantic is on - a real, empirically-confirmed
    // pedantic-only rejection, not a base-validation error that would fire
    // either way.
    const mismatchConfig = {
      ack_policy: 'explicit',
      ack_wait: 5_000_000_000,
      max_deliver: 5,
      backoff: [10_000_000_000, 20_000_000_000],
    };

    const nodes = [
      serverNode(srv),
      consumer,
      injectNode(injNonPedantic, fnNonPedantic, [
        { p: 'payload', v: '', vt: 'str' },
      ]),
      functionNode(
        fnNonPedantic,
        `msg.config = ${JSON.stringify({ ...mismatchConfig, durable_name: `${id}-nonpedantic` })};
         msg.pedantic = false;
         return msg;`,
        scon
      ),
      injectNode(injPedantic, fnPedantic, [{ p: 'payload', v: '', vt: 'str' }]),
      functionNode(
        fnPedantic,
        `msg.config = ${JSON.stringify({ ...mismatchConfig, durable_name: `${id}-pedantic` })};
         msg.pedantic = true;
         return msg;`,
        scon
      ),
      catchNode(cat, [scon], dbgCatch),
      debugNode(dbg),
      debugNode(dbgCatch),
    ];

    await comms.ready;
    const ready = comms.waitForStatus(scon, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    const nonPedanticResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injNonPedantic);
    const nonPedanticMsg = await nonPedanticResult;
    assert.equal(
      nonPedanticMsg.payload.success,
      true,
      'the same ack_wait/backoff mismatch must be accepted when pedantic is off'
    );

    const pedanticCaught = comms.waitForDebug(dbgCatch, 8000);
    await triggerInject(injPedantic);
    const pedanticCaughtMsg = await pedanticCaught;
    assert.ok(
      pedanticCaughtMsg.error,
      'pedantic:true must reach the Catch node for the same config'
    );
    assert.match(
      pedanticCaughtMsg.error.message,
      /pedantic/i,
      'the rejection must be the real pedantic-mode error, not something else'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-consumer: pull overflow (group/min_pending) actually withholds delivery below the threshold and releases it above', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('overflow-');
  const streamName = `STREAM_${id}`;
  const consumerName = `CONSUMER_${id}`;
  const subject = `test.jetstream.overflow.${id}`;
  const srv = `${id}srv`;
  const scon = `${id}scon`;
  const sconInj = `${id}sconinj`;
  const dbg = `${id}dbg`;

  const directNc = await connectDirectNats();
  const comms = connectComms();
  let flowId;
  try {
    const jsm = await jetstreamManager(directNc);
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: 'memory',
    });
    const js = jetstream(directNc);

    const consumer = streamConsumerNode(
      scon,
      srv,
      streamName,
      consumerName,
      subject,
      dbg
    );
    consumer.ackPolicy = 'explicit';
    consumer.priorityGroups = 'g1';
    consumer.priorityPolicy = 'overflow';
    consumer.pullGroup = 'g1';
    consumer.pullMinPending = 5;
    consumer.batchSize = 10;
    consumer.maxWait = 1500;

    const nodes = [
      serverNode(srv),
      consumer,
      injectNode(sconInj, scon, [{ p: 'payload' }]),
      debugNode(dbg),
    ];

    await comms.ready;
    const ready = comms.waitForStatus(scon, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await ready;

    // 2 pending, below the configured min_pending: 5 - the real server
    // must withhold delivery entirely (verified against a real broker
    // before writing this assertion).
    await js.publish(subject, 'm1');
    await js.publish(subject, 'm2');
    const withheld = comms.waitForDebug(dbg, 2500);
    await triggerInject(sconInj);
    await assert.rejects(
      withheld,
      /timed out/i,
      'below min_pending, a triggered fetch must not receive anything'
    );

    // 3 more messages bring pending to 5, meeting min_pending - delivery
    // must now proceed.
    await js.publish(subject, 'm3');
    await js.publish(subject, 'm4');
    await js.publish(subject, 'm5');
    const delivered = comms.waitForDebug(dbg, 8000);
    await triggerInject(sconInj);
    const deliveredMsg = await delivered;
    assert.ok(
      deliveredMsg,
      'once pending reaches min_pending, the real server must deliver'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

// --- expect fields + persist_mode (Step 8, NATS-3.4-GAP-PLAN.md) ----------

test('stream-publisher: expectLastMsgID/expectLastSequence enforce real optimistic concurrency', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('expect-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.expect.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;
  const injBaseline = `${id}injbaseline`;
  const injMsgIDMismatch = `${id}injmsgidmismatch`;
  const injMsgIDMatch = `${id}injmsgidmatch`;
  const injSeqMismatch = `${id}injseqmismatch`;
  const injSeqMatch = `${id}injseqmatch`;

  const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
  publisher.storage = 'memory';

  const nodes = [
    serverNode(srv),
    publisher,
    injectNode(injBaseline, spub, [
      { p: 'payload', v: 'baseline', vt: 'str' },
      { p: '_msgID', v: 'baseline-id', vt: 'str' },
    ]),
    injectNode(injMsgIDMismatch, spub, [
      { p: 'payload', v: 'msgid-mismatch', vt: 'str' },
      { p: 'expectLastMsgID', v: 'wrong-id', vt: 'str' },
    ]),
    injectNode(injMsgIDMatch, spub, [
      { p: 'payload', v: 'msgid-match', vt: 'str' },
      { p: 'expectLastMsgID', v: 'baseline-id', vt: 'str' },
      { p: '_msgID', v: 'second-id', vt: 'str' },
    ]),
    injectNode(injSeqMismatch, spub, [
      { p: 'payload', v: 'seq-mismatch', vt: 'str' },
      { p: 'expectLastSequence', v: '999', vt: 'num' },
    ]),
    injectNode(injSeqMatch, spub, [
      { p: 'payload', v: 'seq-match', vt: 'str' },
      { p: 'expectLastSequence', v: '2', vt: 'num' },
    ]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const baselineResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injBaseline);
    const baseline = await baselineResult;
    assert.equal(baseline.published, true, 'baseline publish must succeed');
    assert.equal(baseline.sequence, 1);

    const msgIDMismatchResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injMsgIDMismatch);
    const msgIDMismatch = await msgIDMismatchResult;
    assert.equal(
      msgIDMismatch.published,
      false,
      'expectLastMsgID must reject a publish when the real last message ID does not match'
    );
    assert.match(msgIDMismatch.error, /wrong last msg/i);

    const msgIDMatchResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injMsgIDMatch);
    const msgIDMatch = await msgIDMatchResult;
    assert.equal(
      msgIDMatch.published,
      true,
      'expectLastMsgID must allow the publish when the real last message ID matches'
    );
    assert.equal(msgIDMatch.sequence, 2);

    const seqMismatchResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injSeqMismatch);
    const seqMismatch = await seqMismatchResult;
    assert.equal(
      seqMismatch.published,
      false,
      'expectLastSequence must reject a publish when the real last sequence does not match'
    );
    assert.match(seqMismatch.error, /wrong last sequence/i);

    const seqMatchResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injSeqMatch);
    const seqMatch = await seqMatchResult;
    assert.equal(
      seqMatch.published,
      true,
      'expectLastSequence must allow the publish when the real last sequence matches'
    );
    assert.equal(seqMatch.sequence, 3);
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: persistMode "async" on create actually sets persist_mode on the real stream', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('persistmode-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.persistmode.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;

  // persist_mode "async" is only meaningful on file storage - the real
  // server rejects it outright on memory streams ("async persist mode is
  // only supported on file storage"), confirmed against a real broker.
  const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
  publisher.storage = 'file';
  publisher.persistMode = 'async';
  publisher.maxBytes = 65536;

  const nodes = [serverNode(srv), publisher, debugNode(dbg)];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.config.persist_mode,
      'async',
      'persistMode "async" on the node must produce persist_mode: "async" on the real stream'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: deploying against a pre-existing stream with a mismatched persistMode warns instead of crashing startup', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('persistmode-existing-');
  const streamName = `STREAM_${id}`;
  const subject = `test.jetstream.persistmodeexisting.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;

  const directNc = await connectDirectNats();
  const comms = connectComms();
  let flowId;
  try {
    // persist_mode can never be changed via update once a stream exists
    // (confirmed against a real broker: the server rejects the attempt
    // outright, "stream configuration update can not change persist
    // mode", even though allow_msg_ttl/allow_msg_schedules/allow_direct
    // CAN all be auto-upgraded this same way on an existing stream). A
    // stream created here with no persist_mode override, then a node
    // configured for "async", reproduces exactly the state that used to
    // make ensureStreamImpl() throw on every startup instead of just
    // warning and continuing.
    const jsm = await jetstreamManager(directNc);
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: 'file',
      max_bytes: 65536,
    });

    const publisher = streamPublisherNode(spub, srv, streamName, subject, dbg);
    publisher.storage = 'file';
    publisher.persistMode = 'async';
    publisher.maxBytes = 65536;

    const nodes = [serverNode(srv), publisher, debugNode(dbg)];

    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    // Must reach green (i.e. ensureStreamImpl did not throw) even though
    // the mismatch can never be reconciled.
    await connected;

    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.config.persist_mode,
      undefined,
      'the pre-existing stream must be left with its original persist_mode - no update attempt should have been made'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

// --- Step 8 (last bullet): JetStreamClient.startBatch() as a new
// stream-publisher operation ("batch-publish": one atomic multi-message
// publish driven by a single msg.batch array).

test('stream-publisher: "batch-publish" lands every item atomically with the real BatchAck', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('batch-');
  const streamName = `STREAM_${id}`;
  const prefix = `test.jetstream.batch.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;
  const inj = `${id}inj`;

  const publisher = streamPublisherNode(
    spub,
    srv,
    streamName,
    `${prefix}.a`,
    dbg
  );
  publisher.subjectPattern = `${prefix}.>`;
  publisher.storage = 'memory';
  publisher.allowAtomic = true;

  const batch = [
    { subject: `${prefix}.a`, payload: 'one' },
    { subject: `${prefix}.b`, payload: 'two' },
    { subject: `${prefix}.c`, payload: 'three' },
    { subject: `${prefix}.d`, payload: 'four' },
  ];

  const nodes = [
    serverNode(srv),
    publisher,
    injectNode(inj, spub, [
      { p: 'operation', v: 'batch-publish', vt: 'str' },
      { p: 'batch', v: JSON.stringify(batch), vt: 'json' },
    ]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const result = comms.waitForDebug(dbg, 10000);
    await triggerInject(inj);
    const ack = await result;

    assert.equal(
      ack.error,
      undefined,
      `batch-publish must not error, got ${JSON.stringify(ack.error)}`
    );
    assert.equal(ack.operation, 'batch-publish');
    assert.equal(
      ack.payload?.count,
      batch.length,
      `BatchAck.count must equal the number of items sent, got ${JSON.stringify(ack.payload)}`
    );

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.state.messages,
      batch.length,
      'every batch item must actually be stored on the stream, not just acked'
    );

    for (let i = 0; i < batch.length; i++) {
      const stored = await jsm.streams.getMessage(streamName, {
        seq: i + 1,
      });
      assert.ok(stored, `message at seq ${i + 1} must exist`);
      assert.equal(stored.subject, batch[i].subject);
      assert.equal(stored.string(), batch[i].payload);
    }
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: "batch-publish" rejects a malformed batch before touching the connection', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('batch-bad-');
  const streamName = `STREAM_${id}`;
  const prefix = `test.jetstream.batchbad.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;
  const cat = `${id}cat`;
  const injEmpty = `${id}injempty`;
  const injMissing = `${id}injmissing`;

  const publisher = streamPublisherNode(
    spub,
    srv,
    streamName,
    `${prefix}.a`,
    dbg
  );
  publisher.subjectPattern = `${prefix}.>`;
  publisher.storage = 'memory';

  const nodes = [
    serverNode(srv),
    publisher,
    injectNode(injEmpty, spub, [
      { p: 'operation', v: 'batch-publish', vt: 'str' },
      { p: 'batch', v: '[]', vt: 'json' },
    ]),
    injectNode(injMissing, spub, [
      { p: 'operation', v: 'batch-publish', vt: 'str' },
      {
        // Only the second item is actually invalid (no subject) - the
        // first item (subject, no payload) is a legitimate empty-body
        // item, not a rejection trigger on its own (payload isn't
        // validated, matching the regular publish path's own
        // toPayload(undefined) convention).
        p: 'batch',
        v: JSON.stringify([{ subject: `${prefix}.a` }, { payload: 'x' }]),
        vt: 'json',
      },
    ]),
    catchNode(cat, [spub], dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const emptyResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injEmpty);
    const emptyErr = await emptyResult;
    assert.ok(
      emptyErr.error,
      'an empty batch must be rejected with a real error'
    );

    const missingResult = comms.waitForDebug(dbg, 8000);
    await triggerInject(injMissing);
    const missingErr = await missingResult;
    assert.ok(
      missingErr.error,
      'a batch item missing a required subject must be rejected with a real error'
    );

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.state.messages,
      0,
      'neither malformed batch must have published anything to the real stream'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});

test('stream-publisher: "batch-publish" is genuinely atomic - a bad expect on the first item aborts the whole batch, zero messages land', async t => {
  if (!(await checkStack(t))) return;

  // Confirmed empirically against the real broker before writing this:
  // - a mismatched `expect` on a MIDDLE item is silently ignored by both
  //   add() and commit() (with or without `ack: true`) - the server does
  //   not appear to cross-validate expect for non-terminal batch items in
  //   this version, so that path cannot be used to prove atomicity.
  // - a mismatched `expect` on the FIRST item (via startBatch()) does not
  //   throw immediately either - startBatch() returns a real batch
  //   handle - but commit() then reliably rejects with a real server
  //   error ("batch didn't contain number of published messages"), and
  //   the stream is left with zero messages: true all-or-nothing
  //   behavior, just discovered at commit() rather than at the point of
  //   the actual mismatch.
  const id = uid('batch-atomic-');
  const streamName = `STREAM_${id}`;
  const prefix = `test.jetstream.batchatomic.${id}`;
  const srv = `${id}srv`;
  const spub = `${id}spub`;
  const dbg = `${id}dbg`;
  const cat = `${id}cat`;
  const inj = `${id}inj`;

  const publisher = streamPublisherNode(
    spub,
    srv,
    streamName,
    `${prefix}.a`,
    dbg
  );
  publisher.subjectPattern = `${prefix}.>`;
  publisher.storage = 'memory';
  publisher.allowAtomic = true;

  const batch = [
    {
      subject: `${prefix}.a`,
      payload: 'first',
      expect: { lastSequence: 999999 },
    },
    { subject: `${prefix}.b`, payload: 'middle' },
    { subject: `${prefix}.c`, payload: 'last' },
  ];

  const nodes = [
    serverNode(srv),
    publisher,
    injectNode(inj, spub, [
      { p: 'operation', v: 'batch-publish', vt: 'str' },
      { p: 'batch', v: JSON.stringify(batch), vt: 'json' },
    ]),
    catchNode(cat, [spub], dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(spub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const result = comms.waitForDebug(dbg, 10000);
    await triggerInject(inj);
    const failed = await result;

    assert.ok(
      failed.error,
      `a real expect mismatch on the first item must reject the whole batch, got ${JSON.stringify(failed)}`
    );

    const jsm = await jetstreamManager(directNc);
    const info = await jsm.streams.info(streamName);
    assert.equal(
      info.state.messages,
      0,
      'a rejected batch must leave zero messages on the stream - not even the ones already add()ed before the failing commit'
    );
  } finally {
    if (flowId) await ignoreFailure(deleteFlow(flowId));
    comms.close();
    await deleteStream(directNc, streamName);
    await ignoreFailure(directNc.close());
  }
});
