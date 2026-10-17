'use strict';

// Tests for nats-suite-publish.js against its post-rewrite contract (13
// config properties: name, server, debug, mode, dataformat, datapointid,
// enableTopicOverride, requestTimeout, requestFallbackToPublish,
// enableAutoReply, enableHeaders, headers). Deliberately does NOT cover the
// deleted disk buffer / batching / rate limiting / message expiration.
//
// Everything runs against the real Node-RED + real NATS docker-compose
// stack via test/lib/harness.js - no mocks, no node-red-node-test-helper.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headers: natsHeaders } = require('@nats-io/nats-core');
const {
  ensureStackUp,
  deployFlow,
  deleteFlow,
  triggerInject,
  connectComms,
  connectDirectNats,
  subscribeOnce,
  subscribeOnceMsg,
  serverNode,
} = require('./lib/harness');

// --- Small node-config builders (local to this file; each test assembles a
// short flow from these instead of repeating full node objects) -----------

function publishNode(id, overrides) {
  return {
    id,
    type: 'nats-suite-publish',
    z: 'FLOW',
    name: '',
    server: '',
    debug: false,
    mode: 'publish',
    dataformat: 'string',
    datapointid: '',
    enableTopicOverride: false,
    requestTimeout: 5000,
    requestFallbackToPublish: true,
    enableAutoReply: false,
    enableHeaders: false,
    headers: '',
    outputs: 0,
    wires: [],
    ...overrides,
  };
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

async function collectMessages(sub, count, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const messages = [];
        for await (const message of sub) {
          messages.push(message);
          if (messages.length === count) return messages;
        }
        throw new Error(
          `Subscription ended before receiving ${count} messages`
        );
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for ${count} messages`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    sub.unsubscribe();
  }
}

// Keep the subscription open after the first request long enough for the
// configured request timeout plus an explicit settle window. This makes a
// no-fallback assertion observe a possible second wire occurrence instead of
// treating the first message as proof that no fallback happened.
async function collectMessagesThroughSettle(
  sub,
  firstMessageTimeoutMs,
  settleMs
) {
  const messages = [];
  let firstTimer;
  let settleTimer;
  let finish;
  const finished = new Promise(resolve => {
    finish = resolve;
  });
  const collecting = (async () => {
    for await (const message of sub) {
      messages.push(message);
      if (messages.length === 1) {
        settleTimer = setTimeout(finish, settleMs);
      } else {
        clearTimeout(settleTimer);
        finish();
        return;
      }
    }
  })();

  try {
    const firstMessage = new Promise((_, reject) => {
      firstTimer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out after ${firstMessageTimeoutMs}ms waiting for the first message`
            )
          ),
        firstMessageTimeoutMs
      );
    });
    await Promise.race([finished, collecting, firstMessage]);
    return messages;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(settleTimer);
    sub.unsubscribe();
    await collecting.catch(() => {});
  }
}

// --- Shared setup / teardown ----------------------------------------------

// Skips (does not fail) when Docker itself is unavailable; any other startup
// problem is a real failure, per harness.ensureStackUp's own contract.
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

async function natsMonitorConnections() {
  const port = process.env.NATS_HTTP_PORT || 8222;
  const res = await fetch(`http://localhost:${port}/varz`);
  if (!res.ok)
    throw new Error(`NATS monitor /varz returned HTTP ${res.status}`);
  return (await res.json()).connections;
}

async function waitForConnectionCountAtMost(maxCount, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const count = await natsMonitorConnections();
    if (count <= maxCount) return count;
    await new Promise(r => setTimeout(r, 50));
  }
  return natsMonitorConnections();
}

// --- 1. Payload encoding per dataformat -----------------------------------
// Table-driven: json/string/buffer differ only in the inject typedInput used
// to build msg.payload and how the raw wire bytes are checked back out.

const dataformatCases = [
  {
    dataformat: 'json',
    injectProp: {
      p: 'payload',
      v: JSON.stringify({ a: 1, note: 'hello nats' }),
      vt: 'json',
    },
    checkWire: raw =>
      assert.deepEqual(JSON.parse(Buffer.from(raw).toString('utf8')), {
        a: 1,
        note: 'hello nats',
      }),
  },
  {
    dataformat: 'string',
    injectProp: { p: 'payload', v: 'plain string payload €', vt: 'str' },
    checkWire: raw =>
      assert.equal(Buffer.from(raw).toString('utf8'), 'plain string payload €'),
  },
  {
    dataformat: 'buffer',
    injectProp: { p: 'payload', v: '[0,1,2,255,254,253]', vt: 'bin' },
    checkWire: raw =>
      assert.equal(
        Buffer.compare(Buffer.from(raw), Buffer.from([0, 1, 2, 255, 254, 253])),
        0
      ),
  },
];

for (const c of dataformatCases) {
  test(`publish: dataformat "${c.dataformat}" reaches NATS with the exact bytes`, async t => {
    if (!(await checkStack(t))) return;

    const id = uid(`df-${c.dataformat}-`);
    const subject = `test.publish.dataformat.${id}`;
    const srv = `${id}srv`;
    const pub = `${id}pub`;
    const inj = `${id}inj`;

    const nodes = [
      serverNode(srv),
      publishNode(pub, {
        server: srv,
        dataformat: c.dataformat,
        datapointid: subject,
      }),
      injectNode(inj, pub, [c.injectProp]),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      await comms.ready;
      const connected = comms.waitForStatus(
        pub,
        d => d.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await connected;

      const received = subscribeOnceMsg(directNc, subject, 8000);
      await directNc.flush();
      await triggerInject(inj);
      const msg = await received;

      c.checkWire(msg.data);
    } finally {
      if (flowId) await deleteFlow(flowId).catch(() => {});
      comms.close();
      await directNc.close().catch(() => {});
    }
  });
}

// --- 2. Subject resolution: datapointid vs msg.topic ----------------------

const subjectCases = [
  {
    name: 'enableTopicOverride off: datapointid wins even when msg.topic is set',
    enableTopicOverride: false,
    expected: 'configured',
  },
  {
    name: 'enableTopicOverride on: msg.topic wins over datapointid',
    enableTopicOverride: true,
    expected: 'topic',
  },
];

for (const c of subjectCases) {
  test(`publish: subject resolution - ${c.name}`, async t => {
    if (!(await checkStack(t))) return;

    const id = uid(`subj-${c.expected}-`);
    const configuredSubject = `test.publish.subject.configured.${id}`;
    const topicSubject = `test.publish.subject.topic.${id}`;
    const probe = `probe-${id}`;
    const srv = `${id}srv`;
    const pub = `${id}pub`;
    const inj = `${id}inj`;

    const nodes = [
      serverNode(srv),
      publishNode(pub, {
        server: srv,
        dataformat: 'string',
        datapointid: configuredSubject,
        enableTopicOverride: c.enableTopicOverride,
      }),
      injectNode(inj, pub, [
        { p: 'payload', v: probe, vt: 'str' },
        { p: 'topic', v: topicSubject, vt: 'str' },
      ]),
    ];

    const comms = connectComms();
    const directNc = await connectDirectNats();
    let flowId;
    try {
      await comms.ready;
      const connected = comms.waitForStatus(
        pub,
        d => d.fill === 'green',
        15000
      );
      flowId = await deployFlow(nodes);
      await connected;

      const expectedSubject =
        c.expected === 'configured' ? configuredSubject : topicSubject;
      const otherSubject =
        c.expected === 'configured' ? topicSubject : configuredSubject;

      const arrived = subscribeOnce(directNc, expectedSubject, 8000);
      const unexpected = subscribeOnce(directNc, otherSubject, 500);
      await directNc.flush();
      await triggerInject(inj);
      assert.equal(
        await arrived,
        probe,
        `message should have been published on ${expectedSubject}`
      );

      // The observer was active before the one publish. Its bounded timeout
      // checks that no copy was routed to the other exact subject.
      await assert.rejects(
        unexpected,
        /Timed out/,
        `message should NOT have been published on ${otherSubject}`
      );
    } finally {
      if (flowId) await deleteFlow(flowId).catch(() => {});
      comms.close();
      await directNc.close().catch(() => {});
    }
  });
}

// --- 3. Request/reply -------------------------------------------------------

test('publish: mode "request" emits the responder\'s reply with Auto-Reply ignored outside Reply mode', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('req-ok-');
  const subject = `test.publish.request.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'request',
      datapointid: subject,
      enableAutoReply: true,
      requestTimeout: 5000,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    // Test process acts as the responder.
    const sub = directNc.subscribe(subject);
    (async () => {
      for await (const m of sub) {
        const requestText = new TextDecoder().decode(m.data);
        m.respond(
          new TextEncoder().encode(
            JSON.stringify({ ok: true, echoed: requestText })
          )
        );
        break;
      }
    })().catch(() => {});

    const debugCaught = comms.waitForDebug(dbg, 8000);
    await directNc.flush();
    await triggerInject(inj);
    const debugMsg = await debugCaught;

    assert.deepEqual(debugMsg.payload, { ok: true, echoed: probe });
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: auto-reply forwards a service request and publishes the processed response back to its reply subject', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('auto-reply-');
  const subject = `test.publish.auto-reply.${id}`;
  const srv = `${id}srv`;
  const sub = `${id}sub`;
  const pub = `${id}pub`;
  const fn = `${id}fn`;

  const nodes = [
    serverNode(srv),
    {
      id: sub,
      type: 'nats-suite-subscribe',
      z: 'FLOW',
      name: '',
      server: srv,
      debug: false,
      dataformat: 'string',
      datapointid: subject,
      subscriptionMode: 'static',
      queueGroup: '',
      wires: [[pub]],
    },
    publishNode(pub, {
      server: srv,
      mode: 'reply',
      dataformat: 'string',
      enableAutoReply: true,
      outputs: 1,
      wires: [[fn]],
    }),
    {
      id: fn,
      type: 'function',
      z: 'FLOW',
      name: 'process service request',
      func: 'msg.payload = `handled:${msg.payload}`; return msg;',
      outputs: 1,
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      wires: [[pub]],
    },
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const publishReady = comms.waitForStatus(
      pub,
      d => d.fill === 'green',
      15000
    );
    const serviceReady = comms.waitForStatus(
      sub,
      d => d.fill === 'green',
      15000
    );
    flowId = await deployFlow(nodes);
    await Promise.all([publishReady, serviceReady]);

    const response = await directNc.request(
      subject,
      new TextEncoder().encode('request'),
      { timeout: 5000 }
    );
    assert.equal(new TextDecoder().decode(response.data), 'handled:request');
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: requestTimeout with requestFallbackToPublish=false surfaces an error, no fallback publish happens', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('req-timeout-nofb-');
  const subject = `test.publish.request.timeout.nofb.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'request',
      datapointid: subject,
      requestTimeout: 500,
      requestFallbackToPublish: false,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    debugNode(dbg),
  ];

  // A subscriber that never replies is required to exercise the *timeout* path.
  // With zero subscribers NATS answers immediately with 503 no-responders and
  // never waits for requestTimeout, which is a different code path (and one
  // where falling back to publish would discard the message anyway, since 503
  // means nothing at all is listening on the subject).
  const comms = connectComms();
  const directNc = await connectDirectNats();
  let subjectSub;
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    subjectSub = directNc.subscribe(subject);
    const observed = collectMessagesThroughSettle(subjectSub, 5000, 750);
    const debugCaught = comms.waitForDebug(dbg, 5000);
    const errorStatus = comms.waitForStatus(pub, d => d.fill !== 'green', 5000);
    await directNc.flush();
    await triggerInject(inj);
    const [received, debugMsg, status] = await Promise.all([
      observed,
      debugCaught,
      errorStatus,
    ]);

    assert.ok(
      received[0].reply,
      'the persistent subscriber should observe the original request first'
    );
    assert.equal(
      received.length,
      1,
      'no fallback publish should occur after the request timeout is handled'
    );
    assert.equal(
      debugMsg.error.code,
      'TIMEOUT',
      'msg.error should record a timeout, not a fallback'
    );
    assert.equal(
      debugMsg.fallback,
      undefined,
      'no fallback publish should have happened'
    );
    assert.notEqual(
      status.fill,
      'green',
      'node status should show a non-connected/error state on timeout'
    );
  } finally {
    if (subjectSub) subjectSub.unsubscribe();
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: requestTimeout with requestFallbackToPublish=true publishes instead of erroring', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('req-timeout-fb-');
  const subject = `test.publish.request.timeout.fb.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'request',
      datapointid: subject,
      requestTimeout: 500,
      requestFallbackToPublish: true,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let subjectSub;
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    // The persistent subscriber sees the request first and the fallback
    // publish second; the reply field distinguishes the two wire messages.
    subjectSub = directNc.subscribe(subject);
    const fallbackDelivered = collectMessages(subjectSub, 2, 5000);
    const debugCaught = comms.waitForDebug(dbg, 5000);
    const backToGreen = comms.waitForStatus(pub, d => d.fill === 'green', 5000);

    await directNc.flush();
    await triggerInject(inj);

    const [messages, debugMsg] = await Promise.all([
      fallbackDelivered,
      debugCaught,
      backToGreen,
    ]);

    assert.equal(
      messages.length,
      2,
      'fallback should produce a second wire message after the original request'
    );
    assert.ok(
      messages[0].reply,
      'the first wire message should be the request'
    );
    assert.equal(
      messages[1].reply,
      '',
      'the second wire message should be the fallback publish'
    );
    assert.equal(
      new TextDecoder().decode(messages[1].data),
      probe,
      'fallback publish should carry the original request payload'
    );
    assert.equal(debugMsg.fallback, 'publish');
    assert.equal(
      debugMsg.error,
      undefined,
      'fallback success should not leave msg.error set'
    );
  } finally {
    if (subjectSub) subjectSub.unsubscribe();
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

// --- 4. Headers --------------------------------------------------------------

test('publish: enableHeaders sends configured + dynamic msg.headers as real NATS headers', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('hdr-');
  const subject = `test.publish.headers.${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      dataformat: 'string',
      datapointid: subject,
      enableHeaders: true,
      headers: JSON.stringify({ 'X-Static': 'config-value' }),
    }),
    injectNode(inj, pub, [
      { p: 'payload', v: 'header-test-payload', vt: 'str' },
      {
        p: 'headers',
        v: JSON.stringify({ 'X-Dynamic': 'msg-value' }),
        vt: 'json',
      },
    ]),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const received = subscribeOnceMsg(directNc, subject, 8000);
    await directNc.flush();
    await triggerInject(inj);
    const msg = await received;

    assert.ok(msg.headers, 'message should carry real NATS headers');
    assert.equal(msg.headers.get('X-Static'), 'config-value');
    assert.equal(msg.headers.get('X-Dynamic'), 'msg-value');
    assert.equal(Buffer.from(msg.data).toString('utf8'), 'header-test-payload');
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

// --- 5. Node-RED contracts ---------------------------------------------------

test('publish: a wired Catch node receives node.error(err, msg) with the original msg intact on failure', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('catch-');
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const cat = `${id}cat`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    // No subject configured and no override -> deterministic, config-driven
    // failure on every input message (not a connectivity/timeout race).
    publishNode(pub, {
      server: srv,
      dataformat: 'string',
      datapointid: '',
      enableTopicOverride: false,
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    catchNode(cat, [pub], dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const caught = comms.waitForDebug(dbg, 5000);
    await triggerInject(inj);
    const caughtMsg = await caught;

    // Node.prototype.error() only dispatches to Catch nodes when called with
    // a real msg object (see @node-red/runtime Node.js `error(logMessage,msg)`
    // -> `if (msg && typeof msg === 'object') this._flow.handleError(...)`).
    // A 1-arg node.error(err) would just log and never reach this Catch node
    // at all, so the Catch node firing IS the proof of the 2-arg form.
    assert.ok(caughtMsg.error, 'caught message should carry the error');
    assert.equal(
      caughtMsg.error.source.id,
      pub,
      'error should be attributed to the publish node'
    );
    assert.equal(
      caughtMsg.payload,
      probe,
      'the ORIGINAL message payload must survive into the Catch node'
    );
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
  }
});

test('publish: a wired Complete node fires (done()) only after a real publish succeeds', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('complete-');
  const subject = `test.publish.complete.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const cmp = `${id}cmp`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      dataformat: 'string',
      datapointid: subject,
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    completeNode(cmp, [pub], dbg),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const delivered = subscribeOnce(directNc, subject, 8000);
    const completed = comms.waitForDebug(dbg, 8000);
    await directNc.flush();
    await triggerInject(inj);

    const [wirePayload, completeMsg] = await Promise.all([
      delivered,
      completed,
    ]);

    assert.equal(
      wirePayload,
      probe,
      'the message should genuinely have reached NATS'
    );
    assert.equal(
      completeMsg.complete.source.id,
      pub,
      'complete event should be attributed to the publish node'
    );
    assert.equal(completeMsg.payload, probe);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

// --- 6. Message tracing (Step 2: connection-level switch) -------------------
// nats-server actually implements tracing (verified against the real
// nats-server:2.14.5 container: publishing with traceDestination set delivers
// both the original message AND a JSON trace event to that destination
// subject) so these assert on the real wire trace event, not just "no throw".

test('publish: server-level enableTracing makes a plain publish() emit a real NATS trace event and still deliver the message', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('trace-pub-on-');
  const subject = `test.publish.trace.data.${id}`;
  const traceSubject = `test.publish.trace.dest.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;

  const nodes = [
    serverNode(srv, { enableTracing: true, traceDestination: traceSubject }),
    publishNode(pub, {
      server: srv,
      dataformat: 'string',
      datapointid: subject,
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const traceEvent = subscribeOnce(directNc, traceSubject, 8000);
    const delivered = subscribeOnce(directNc, subject, 8000);
    await directNc.flush();
    await triggerInject(inj);
    const [trace, wirePayload] = await Promise.all([traceEvent, delivered]);

    assert.equal(
      wirePayload,
      probe,
      'the real message must still be delivered, not swallowed by tracing'
    );
    const traceJson = JSON.parse(trace);
    assert.deepEqual(traceJson.request.header['Nats-Trace-Dest'], [
      traceSubject,
    ]);
    assert.ok(Array.isArray(traceJson.events) && traceJson.events.length > 0);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: enableTracing off (the default) never emits a trace event', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('trace-pub-off-');
  const subject = `test.publish.trace.off.data.${id}`;
  const traceSubject = `test.publish.trace.off.dest.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      dataformat: 'string',
      datapointid: subject,
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const noTrace = subscribeOnce(directNc, traceSubject, 1500);
    const delivered = subscribeOnce(directNc, subject, 8000);
    await directNc.flush();
    await triggerInject(inj);

    await assert.rejects(
      noTrace,
      /Timed out/,
      'no trace event should be emitted when tracing is off'
    );
    assert.equal(await delivered, probe);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: server-level enableTracing also threads through mode "request"', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('trace-req-on-');
  const subject = `test.publish.trace.request.${id}`;
  const traceSubject = `test.publish.trace.request.dest.${id}`;
  const probe = `probe-${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv, { enableTracing: true, traceDestination: traceSubject }),
    publishNode(pub, {
      server: srv,
      mode: 'request',
      datapointid: subject,
      requestTimeout: 5000,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: probe, vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    // Test process acts as the responder.
    const sub = directNc.subscribe(subject);
    (async () => {
      for await (const m of sub) {
        m.respond(new TextEncoder().encode('pong'));
        break;
      }
    })().catch(() => {});

    const traceEvent = subscribeOnce(directNc, traceSubject, 8000);
    const debugCaught = comms.waitForDebug(dbg, 8000);
    await directNc.flush();
    await triggerInject(inj);
    const [trace, debugMsg] = await Promise.all([traceEvent, debugCaught]);

    assert.equal(
      debugMsg.payload,
      'pong',
      'the request/reply round trip must still complete under tracing'
    );
    const traceJson = JSON.parse(trace);
    assert.deepEqual(traceJson.request.header['Nats-Trace-Dest'], [
      traceSubject,
    ]);
  } finally {
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

// --- 7. Teardown / redeploy leak check ---------------------------------------

test('publish: redeploying the flow repeatedly does not grow NATS connection count', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('teardown-');
  const subject = `test.publish.teardown.${id}`;
  const comms = connectComms();
  try {
    await comms.ready;
    const baseline = await natsMonitorConnections();

    for (let i = 0; i < 3; i++) {
      // Use fresh ids each time. Reusing ids lets comms replay the previous
      // flow's green status before the replacement node has connected.
      const srv = `${id}${i}srv`;
      const pub = `${id}${i}pub`;
      const inj = `${id}${i}inj`;
      const nodes = [
        serverNode(srv),
        publishNode(pub, {
          server: srv,
          dataformat: 'string',
          datapointid: subject,
        }),
        injectNode(inj, pub, [{ p: 'payload', v: 'ping', vt: 'str' }]),
      ];
      const connected = comms.waitForStatus(
        pub,
        d => d.fill === 'green',
        15000
      );
      const flowId = await deployFlow(nodes);
      await connected;

      const directNc = await connectDirectNats();
      try {
        const received = subscribeOnce(directNc, subject, 5000);
        await directNc.flush();
        await triggerInject(inj);
        assert.equal(
          await received,
          'ping',
          `iteration ${i}: publish should still work after redeploy`
        );
      } finally {
        await directNc.close().catch(() => {});
      }

      await deleteFlow(flowId);
      await waitForConnectionCountAtMost(baseline + 1);
    }

    const final = await natsMonitorConnections();
    assert.ok(
      final <= baseline + 1,
      `NATS connection count should not grow across redeploys (baseline ${baseline}, final ${final})`
    );
  } finally {
    comms.close();
  }
});

// --- mode "requestMany" (scatter-gather) ---------------------------------
//
// Empirically confirmed against the real broker before writing these
// (@nats-io/nats-core 3.4.0, nats-server 2.14.5):
//   - strategy "timer" always waits out the full maxWait, regardless of how
//     fast replies arrive - it is not a "stop early once done" strategy.
//   - maxMessages has no effect on strategy "timer" (setting it to 1 still
//     collected every reply and still waited the full window) - it only
//     bounds strategy "count".
//   - strategy "stall" stops early once `stall` ms pass with no new reply,
//     bounded above by maxWait.
//   - when a subject has zero subscriber interest, requestMany() itself
//     REJECTS synchronously with a NoResponders error - a different failure
//     mode from "subscribers exist but none replied", which instead
//     completes normally with 0 replies once maxWait elapses. The real
//     nats-suite-publish.js implementation catches the reject case and
//     surfaces it via done(err); the exists-but-silent case is a normal
//     success with replyCount: 0.

function respondOnce(nc, subject, payload) {
  const sub = nc.subscribe(subject);
  (async () => {
    for await (const m of sub) {
      m.respond(new TextEncoder().encode(payload));
      break;
    }
  })().catch(() => {});
  return sub;
}

test('publish: mode "requestMany" collects every real reply within the window (strategy "timer" waits out the full maxWait)', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('rm-ok-');
  const subject = `test.publish.requestMany.${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;
  const maxWait = 1800;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'requestMany',
      datapointid: subject,
      requestManyStrategy: 'timer',
      requestManyMaxWait: maxWait,
      requestManyMaxMessages: 0,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: 'scatter', vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  const subs = [];
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    for (let i = 0; i < 3; i++) {
      subs.push(respondOnce(directNc, subject, `responder-${i}`));
    }

    const debugCaught = comms.waitForDebug(dbg, maxWait + 5000);
    await directNc.flush();
    const start = Date.now();
    await triggerInject(inj);
    const debugMsg = await debugCaught;
    const elapsed = Date.now() - start;

    assert.equal(debugMsg.replyCount, 3);
    assert.deepEqual([...debugMsg.payload].sort(), [
      'responder-0',
      'responder-1',
      'responder-2',
    ]);
    assert.ok(Array.isArray(debugMsg.replies) && debugMsg.replies.length === 3);
    // "timer" strategy: confirmed empirically to always wait out the full
    // window even when every reply lands almost instantly - assert that,
    // not "returns quickly".
    assert.ok(
      elapsed >= maxWait - 200,
      `"timer" strategy should wait out the full ${maxWait}ms window; only took ${elapsed}ms`
    );
    assert.ok(
      elapsed < maxWait + 3000,
      `"timer" strategy should not run far past its ${maxWait}ms window; took ${elapsed}ms`
    );
  } finally {
    subs.forEach(s => s.unsubscribe());
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: mode "requestMany" does not hang past the window when a subscriber never replies', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('rm-silent-');
  const subject = `test.publish.requestMany.${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;
  const maxWait = 1500;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'requestMany',
      datapointid: subject,
      requestManyStrategy: 'timer',
      requestManyMaxWait: maxWait,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: 'scatter', vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  // Interest exists (so requestMany() itself does not reject with
  // NoResponders) but nobody ever calls respond() - the window must still
  // bound the wait and the node must still complete, with a partial result.
  const silentSub = directNc.subscribe(subject);
  (async () => {
    for await (const m of silentSub) {
      void m; /* never respond */
    }
  })().catch(() => {});
  const repliers = [respondOnce(directNc, subject, 'the-one-that-replies')];
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const debugCaught = comms.waitForDebug(dbg, maxWait + 5000);
    await directNc.flush();
    const start = Date.now();
    await triggerInject(inj);
    const debugMsg = await debugCaught;
    const elapsed = Date.now() - start;

    assert.equal(debugMsg.replyCount, 1);
    assert.deepEqual([...debugMsg.payload], ['the-one-that-replies']);
    assert.equal(debugMsg.error, undefined);
    assert.ok(
      elapsed < maxWait + 3000,
      `a silent subscriber must not hang the node past the ${maxWait}ms window; took ${elapsed}ms`
    );
  } finally {
    silentSub.unsubscribe();
    repliers.forEach(s => s.unsubscribe());
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: mode "requestMany" msg-level requestManyMaxWait overrides the configured default', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('rm-override-');
  const subject = `test.publish.requestMany.${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;
  const configuredMaxWait = 8000;
  const overrideMaxWait = 700;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'requestMany',
      datapointid: subject,
      requestManyStrategy: 'timer',
      requestManyMaxWait: configuredMaxWait,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [
      { p: 'payload', v: 'scatter', vt: 'str' },
      { p: 'requestManyMaxWait', v: String(overrideMaxWait), vt: 'num' },
    ]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  // Interest only (no reply) - if the msg-level override were ignored, this
  // test would take ~8s (the config default) instead of ~0.7s.
  const silentSub = directNc.subscribe(subject);
  (async () => {
    for await (const m of silentSub) {
      void m; /* never respond */
    }
  })().catch(() => {});
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const debugCaught = comms.waitForDebug(dbg, configuredMaxWait);
    await directNc.flush();
    const start = Date.now();
    await triggerInject(inj);
    const debugMsg = await debugCaught;
    const elapsed = Date.now() - start;

    assert.equal(debugMsg.replyCount, 0);
    assert.ok(
      elapsed < overrideMaxWait + 3000,
      `msg.requestManyMaxWait (${overrideMaxWait}ms) should win over the configured ${configuredMaxWait}ms default; took ${elapsed}ms`
    );
  } finally {
    silentSub.unsubscribe();
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});

test('publish: mode "requestMany" surfaces real NATS headers on each collected reply', async t => {
  if (!(await checkStack(t))) return;

  const id = uid('rm-headers-');
  const subject = `test.publish.requestMany.${id}`;
  const srv = `${id}srv`;
  const pub = `${id}pub`;
  const inj = `${id}inj`;
  const dbg = `${id}dbg`;

  const nodes = [
    serverNode(srv),
    publishNode(pub, {
      server: srv,
      mode: 'requestMany',
      datapointid: subject,
      requestManyStrategy: 'timer',
      requestManyMaxWait: 1200,
      outputs: 1,
      wires: [[dbg]],
    }),
    injectNode(inj, pub, [{ p: 'payload', v: 'scatter', vt: 'str' }]),
    debugNode(dbg),
  ];

  const comms = connectComms();
  const directNc = await connectDirectNats();
  const sub = directNc.subscribe(subject);
  (async () => {
    for await (const m of sub) {
      const h = natsHeaders();
      h.set('X-Responder-Id', 'only-one');
      m.respond(new TextEncoder().encode('with-headers'), { headers: h });
      break;
    }
  })().catch(() => {});
  let flowId;
  try {
    await comms.ready;
    const connected = comms.waitForStatus(pub, d => d.fill === 'green', 15000);
    flowId = await deployFlow(nodes);
    await connected;

    const debugCaught = comms.waitForDebug(dbg, 6000);
    await directNc.flush();
    await triggerInject(inj);
    const debugMsg = await debugCaught;

    assert.equal(debugMsg.replyCount, 1);
    assert.ok(Array.isArray(debugMsg.replies) && debugMsg.replies.length === 1);
    assert.equal(debugMsg.replies[0].payload, 'with-headers');
    assert.equal(debugMsg.replies[0].headers?.['X-Responder-Id'], 'only-one');
  } finally {
    sub.unsubscribe();
    if (flowId) await deleteFlow(flowId).catch(() => {});
    comms.close();
    await directNc.close().catch(() => {});
  }
});
