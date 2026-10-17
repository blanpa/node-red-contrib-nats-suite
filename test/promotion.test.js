'use strict';

// Step 5 promotion checks: every packaged type registers, promoted nodes
// release their shared ownership, and the Object Store/Services wrappers work
// through real Node-RED flows against real NATS.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Kvm } = require('@nats-io/kv');
const { Objm } = require('@nats-io/obj');
const {
  NATS_CONTAINER_URL,
  ensureStackUp,
  deployFlow,
  deleteFlow,
  triggerInject,
  connectComms,
  connectDirectNats,
  serverNode,
} = require('./lib/harness');

const packageJson = require('../package.json');
const repoRoot = path.join(__dirname, '..');
let seq = 0;
const uid = base => `${base}${Date.now().toString(36)}${seq++}`;

async function removeFlow(flowId) {
  if (!flowId) return;
  try {
    await deleteFlow(flowId);
  } catch {
    // Cleanup is best-effort after the assertion result is known.
  }
}

async function closeNats(nc) {
  if (!nc) return;
  try {
    await nc.close();
  } catch {
    // Cleanup is best-effort after the assertion result is known.
  }
}

function fakeRed(serverConfig) {
  const constructors = new Map();
  return {
    constructors,
    nodes: {
      registerType(type, constructor) {
        constructors.set(type, constructor);
      },
      getNode(id) {
        return id === 'srv' ? serverConfig : undefined;
      },
      createNode(node, config) {
        node.id = config.id;
        node.handlers = new Map();
        node.on = (event, handler) => node.handlers.set(event, handler);
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        node.log = () => {};
        node.send = () => {};
      },
    },
  };
}

test('every package node mapping loads and registers its declared type', () => {
  for (const [type, relativePath] of Object.entries(
    packageJson['node-red'].nodes
  )) {
    const registered = [];
    require(path.join(repoRoot, relativePath))({
      nodes: {
        registerType(name) {
          registered.push(name);
        },
      },
    });
    assert.deepEqual(registered, [type], `${relativePath} registration`);
    assert.ok(
      fs.existsSync(
        path.join(repoRoot, relativePath.replace(/\.js$/, '.html'))
      ),
      `${type} must include its editor HTML`
    );
  }
});

test('every editor default and credential has a matching control', () => {
  for (const relativePath of Object.values(packageJson['node-red'].nodes)) {
    const editorPath = path.join(
      repoRoot,
      relativePath.replace(/\.js$/, '.html')
    );
    const html = fs.readFileSync(editorPath, 'utf8');
    const properties = new Set();

    for (const section of ['defaults', 'credentials']) {
      const block = html.match(
        new RegExp(`${section}:\\s*\\{([\\s\\S]*?)^ {4}\\},`, 'm')
      )?.[1];
      if (!block) continue;
      for (const match of block.matchAll(/^ {6}([A-Za-z_$][\w$]*):/gm)) {
        properties.add(match[1]);
      }
    }

    const controls = new Set(
      [...html.matchAll(/\bid=["']node-(?:config-)?input-([^"']+)["']/g)].map(
        match => match[1]
      )
    );
    for (const property of properties) {
      assert.ok(controls.has(property), `${editorPath}: missing ${property}`);
    }
    for (const control of controls) {
      assert.ok(
        properties.has(control) || control.endsWith('-nkey'),
        `${editorPath}: ${control} is not persisted`
      );
    }
  }
});

test('promoted nodes balance connection users and status listeners on close', async () => {
  const users = new Set();
  const listeners = new Set();
  const serverConfig = {
    debug: false,
    registerConnectionUser: id => users.add(id),
    unregisterConnectionUser: id => users.delete(id),
    addStatusListener: listener => listeners.add(listener),
    removeStatusListener: listener => listeners.delete(listener),
  };
  const RED = fakeRed(serverConfig);
  const types = [
    'nats-suite-object-get',
    'nats-suite-object-put',
    'nats-suite-service',
  ];

  for (const type of types) {
    require(path.join(repoRoot, packageJson['node-red'].nodes[type]))(RED);
  }

  const nodes = types.map((type, index) => {
    const Constructor = RED.constructors.get(type);
    return new Constructor({
      id: `promoted-${index}`,
      server: 'srv',
      mode: 'discover',
      bucket: 'promotion-test',
    });
  });

  assert.deepEqual(users, new Set(nodes.map(node => node.id)));
  assert.equal(
    listeners.size,
    types.length,
    'object-get, object-put, and service should each own a status listener'
  );

  for (const node of nodes) {
    await node.handlers.get('close').call(node, () => {});
  }

  assert.equal(users.size, 0, 'all connection users must be released');
  assert.equal(listeners.size, 0, 'all status listeners must be detached');
});

test('promoted service honors endpoint subjects and legacy discovery filters', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const srv = uid('srv');
  const serviceA = uid('servicea');
  const serviceB = uid('serviceb');
  const serviceNameA = uid('ServiceA');
  const serviceNameB = uid('ServiceB');
  const customSubject = `${uid('custom')}.request`;
  const defaultSubject = `${serviceNameB}.process`;
  const legacy = uid('legacy');
  const inject = uid('inject');
  const debug = uid('debug');
  const reply = uid('reply');
  const nodes = [
    serverNode(srv),
    {
      id: serviceA,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'service',
      serviceName: serviceNameA,
      serviceVersion: '1.0.0',
      endpoint: 'process',
      endpointSubject: customSubject,
      autoStart: true,
      wires: [[reply]],
    },
    {
      id: serviceB,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'service',
      serviceName: serviceNameB,
      serviceVersion: '1.0.0',
      endpoint: 'process',
      endpointSubject: '',
      autoStart: true,
      wires: [[reply]],
    },
    {
      id: reply,
      type: 'function',
      z: 'FLOW',
      name: '',
      func: 'msg.respond({ echoed: msg.payload, service: msg.service }); return null;',
      outputs: 0,
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      wires: [],
    },
    {
      id: legacy,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'discover',
      serviceName: serviceNameA,
      autoStart: false,
      wires: [[debug]],
    },
    {
      id: inject,
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'payload' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'date',
      wires: [[legacy]],
    },
    {
      id: debug,
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
  let nc;
  let flowId;
  try {
    await comms.ready;
    nc = await connectDirectNats();
    const serverReady = comms.waitForStatus(
      srv,
      status => status.fill === 'green',
      20000
    );
    const serviceAReady = comms.waitForStatus(
      serviceA,
      status => status.text?.includes('(running)'),
      20000
    );
    const serviceBReady = comms.waitForStatus(
      serviceB,
      status => status.text?.includes('(running)'),
      20000
    );

    flowId = await deployFlow(nodes);
    await serverReady;
    await serviceAReady;
    await serviceBReady;

    const discovered = comms.waitForDebug(debug, 10000);
    await triggerInject(inject);
    const discoveryMessage = await discovered;
    assert.deepEqual(
      discoveryMessage.payload.map(service => service.name),
      [serviceNameA],
      'a pre-Step-5 serviceName filter must remain selective'
    );

    const payload = { hello: 'world' };
    const customResponse = await nc.request(
      customSubject,
      JSON.stringify(payload),
      { timeout: 5000 }
    );
    assert.deepEqual(customResponse.json(), {
      echoed: payload,
      service: serviceNameA,
    });

    const defaultResponse = await nc.request(
      defaultSubject,
      JSON.stringify(payload),
      { timeout: 5000 }
    );
    assert.deepEqual(defaultResponse.json(), {
      echoed: payload,
      service: serviceNameB,
    });
  } finally {
    await removeFlow(flowId);
    comms.close();
    await closeNats(nc);
  }
});

test('promoted service: groupSubject reachability and reset zero real stats through a deployed flow', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const srv = uid('srv');
  const serviceA = uid('servicea');
  const serviceNameA = uid('ServiceA');
  const groupSubject = uid('group');
  const reply = uid('reply');
  const statsNode = uid('statsnode');
  const resetInject = uid('resetinject');
  const statsInject = uid('statsinject');
  const debug = uid('debug');
  const groupedSubject = `${groupSubject}.process`;

  const nodes = [
    serverNode(srv),
    {
      id: serviceA,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'service',
      serviceName: serviceNameA,
      serviceVersion: '1.0.0',
      endpoint: 'process',
      groupSubject,
      autoStart: true,
      wires: [[reply]],
    },
    {
      id: reply,
      type: 'function',
      z: 'FLOW',
      name: '',
      func: 'msg.respond({ echoed: msg.payload }); return null;',
      outputs: 0,
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      wires: [],
    },
    {
      id: statsNode,
      type: 'nats-suite-service',
      z: 'FLOW',
      server: srv,
      mode: 'discover',
      serviceName: serviceNameA,
      autoStart: false,
      wires: [[debug]],
    },
    {
      id: resetInject,
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'operation', v: 'reset', vt: 'str' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'date',
      wires: [[serviceA]],
    },
    {
      id: statsInject,
      type: 'inject',
      z: 'FLOW',
      props: [{ p: 'operation', v: 'stats', vt: 'str' }],
      repeat: '',
      once: false,
      payload: '',
      payloadType: 'date',
      wires: [[statsNode]],
    },
    {
      id: debug,
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
  let nc;
  let flowId;
  try {
    await comms.ready;
    nc = await connectDirectNats();
    const serverReady = comms.waitForStatus(
      srv,
      status => status.fill === 'green',
      20000
    );
    const serviceReady = comms.waitForStatus(
      serviceA,
      status => status.text?.includes('(running)'),
      20000
    );

    flowId = await deployFlow(nodes);
    await serverReady;
    await serviceReady;

    // groupSubject reachability: the endpoint only answers under the
    // group's prefix, proven by a real request landing there.
    const payload = { hello: 'group' };
    for (let i = 0; i < 3; i++) {
      const response = await nc.request(
        groupedSubject,
        JSON.stringify(payload),
        { timeout: 5000 }
      );
      assert.deepEqual(response.json(), { echoed: payload });
    }

    const beforeReset = comms.waitForDebug(debug, 10000);
    await triggerInject(statsInject);
    const beforeStats = await beforeReset;
    const beforeEndpoint = beforeStats.payload[0]?.endpoints?.[0];
    assert.ok(
      beforeEndpoint && beforeEndpoint.num_requests >= 3,
      `expected at least 3 real requests recorded before reset, got ${JSON.stringify(beforeEndpoint)}`
    );

    await triggerInject(resetInject);

    const afterReset = comms.waitForDebug(debug, 10000);
    await triggerInject(statsInject);
    const afterStats = await afterReset;
    const afterEndpoint = afterStats.payload[0]?.endpoints?.[0];
    assert.equal(
      afterEndpoint?.num_requests,
      0,
      `expected num_requests to be zeroed by a real reset through the deployed node, got ${JSON.stringify(afterEndpoint)}`
    );
  } finally {
    await removeFlow(flowId);
    comms.close();
    await closeNats(nc);
  }
});

function bucketCreateFlow(type, server, bucket) {
  const put = uid('put');
  const inject = uid('inject');
  const debug = uid('debug');
  return {
    put,
    inject,
    debug,
    nodes: [
      {
        id: put,
        type,
        z: 'FLOW',
        server,
        bucket,
        operation: 'put',
        storage: 'memory',
        replicas: 1,
        wires: [[debug]],
      },
      {
        id: inject,
        type: 'inject',
        z: 'FLOW',
        props: [
          { p: 'operation', v: 'bucket-create', vt: 'str' },
          { p: 'bucket', v: bucket, vt: 'str' },
          { p: 'storage', v: 'file', vt: 'str' },
        ],
        repeat: '',
        once: false,
        payload: '',
        payloadType: 'date',
        wires: [[put]],
      },
      {
        id: debug,
        type: 'debug',
        z: 'FLOW',
        active: true,
        tosidebar: true,
        console: false,
        complete: 'true',
        wires: [],
      },
    ],
  };
}

test('bucket creation preserves msg.storage file for Object Store and KV', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const srv = uid('srv');
  const objectBucket = uid('promotionobj');
  const kvBucket = uid('promotionkv');
  const objectFlow = bucketCreateFlow(
    'nats-suite-object-put',
    srv,
    objectBucket
  );
  const kvFlow = bucketCreateFlow('nats-suite-kv-put', srv, kvBucket);
  const nodes = [serverNode(srv), ...objectFlow.nodes, ...kvFlow.nodes];

  const comms = connectComms();
  let nc;
  let flowId;
  try {
    await comms.ready;
    nc = await connectDirectNats();
    const serverReady = comms.waitForStatus(
      srv,
      status => status.fill === 'green',
      20000
    );
    const objectReady = comms.waitForStatus(objectFlow.put, () => true, 20000);
    const kvReady = comms.waitForStatus(kvFlow.put, () => true, 20000);

    flowId = await deployFlow(nodes);
    await serverReady;
    await objectReady;
    await kvReady;

    for (const flow of [objectFlow, kvFlow]) {
      const created = comms.waitForDebug(flow.debug, 10000);
      await triggerInject(flow.inject);
      assert.equal((await created).payload.success, true);
    }

    const objectStore = await new Objm(nc).open(objectBucket);
    assert.equal((await objectStore.status()).storage, 'file');
    const kvStore = await new Kvm(nc).open(kvBucket);
    assert.equal((await kvStore.status()).storage, 'file');
  } finally {
    if (nc) {
      try {
        const objectStore = await new Objm(nc).open(objectBucket);
        await objectStore.destroy();
      } catch {
        // The Object Store bucket may not exist if setup failed.
      }
      try {
        const kvStore = await new Kvm(nc).open(kvBucket);
        await kvStore.destroy();
      } catch {
        // The KV bucket may not exist if setup failed.
      }
    }
    await removeFlow(flowId);
    comms.close();
    await closeNats(nc);
  }
});

// Step 6 (NATS-3.4-GAP-PLAN.md): Object Store watch parity with KV watch
// (test/kv.test.js's "kv watch mode emits an event..." test is the template
// this follows).
test('object-get watch mode emits an event when a put lands in the bucket', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const srv = uid('srv');
  const bucket = uid('objwatch');
  const watchId = uid('objwatch');
  const debugId = uid('debug');
  const putId = uid('put');
  const injectId = uid('inject');

  const nodes = [
    serverNode(srv),
    {
      id: watchId,
      type: 'nats-suite-object-get',
      z: 'FLOW',
      server: srv,
      bucket,
      operation: 'watch',
      watchIgnoreDeletes: false,
      watchIncludeHistory: false,
      wires: [[debugId]],
    },
    {
      id: debugId,
      type: 'debug',
      z: 'FLOW',
      active: true,
      tosidebar: true,
      console: false,
      complete: 'true',
      wires: [],
    },
    {
      id: putId,
      type: 'nats-suite-object-put',
      z: 'FLOW',
      server: srv,
      bucket,
      operation: 'put',
      storage: 'memory',
      replicas: 1,
      nameFrom: 'msg',
      dataFrom: 'payload',
      wires: [[]],
    },
    {
      id: injectId,
      type: 'inject',
      z: 'FLOW',
      props: [
        { p: 'payload', v: 'triggered', vt: 'str' },
        { p: 'objectName', v: 'signal.txt', vt: 'str' },
      ],
      repeat: '',
      once: false,
      payload: 'triggered',
      payloadType: 'str',
      wires: [[putId]],
    },
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const serverReady = comms.waitForStatus(
      srv,
      s => s.fill === 'green',
      20000
    );
    const watching = comms.waitForStatus(
      watchId,
      s => s.text === 'watching',
      20000
    );

    flowId = await deployFlow(nodes);
    await serverReady;
    await watching;

    const watchEvent = comms.waitForDebug(debugId, 10000);
    await triggerInject(injectId);
    const msg = await watchEvent;

    assert.equal(msg.objectName, 'signal.txt');
    assert.equal(msg.bucket, bucket);
    assert.equal(msg.operation, 'WATCH');
    assert.equal(msg._watchEvent, true);
    assert.equal(msg.deleted, false);
  } finally {
    await removeFlow(flowId);
    comms.close();
    const nc = await connectDirectNats();
    try {
      const os = await new Objm(nc).open(bucket);
      await os.destroy();
    } catch {
      // The bucket may not exist if setup failed.
    }
    await closeNats(nc);
  }
});

test('object-get watch mode: watchIgnoreDeletes suppresses delete events, disabled lets them through', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const srv = uid('srv');
  const bucketAll = uid('objwatchall');
  const bucketFiltered = uid('objwatchflt');

  const watchAllId = uid('watchall');
  const debugAllId = uid('debugall');
  const putAllId = uid('putall');
  const injectPutAllId = uid('injputall');
  const deleteAllId = uid('delall');
  const injectDeleteAllId = uid('injdelall');

  const watchFilteredId = uid('watchflt');
  const debugFilteredId = uid('debugflt');
  const putFilteredId = uid('putflt');
  const injectPutFilteredId = uid('injputflt');
  const deleteFilteredId = uid('delflt');
  const injectDeleteFilteredId = uid('injdelflt');

  const objectPutNode = (id, server, bucket, operation) => ({
    id,
    type: 'nats-suite-object-put',
    z: 'FLOW',
    server,
    bucket,
    operation,
    storage: 'memory',
    replicas: 1,
    nameFrom: 'msg',
    dataFrom: 'payload',
    wires: [[]],
  });

  const debugNode = id => ({
    id,
    type: 'debug',
    z: 'FLOW',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'true',
    wires: [],
  });

  const injectNode = (id, wireTo, objectName) => ({
    id,
    type: 'inject',
    z: 'FLOW',
    props: [
      { p: 'payload', v: 'x', vt: 'str' },
      { p: 'objectName', v: objectName, vt: 'str' },
    ],
    repeat: '',
    once: false,
    payload: 'x',
    payloadType: 'str',
    wires: [[wireTo]],
  });

  const nodes = [
    serverNode(srv),
    {
      id: watchAllId,
      type: 'nats-suite-object-get',
      z: 'FLOW',
      server: srv,
      bucket: bucketAll,
      operation: 'watch',
      watchIgnoreDeletes: false,
      watchIncludeHistory: false,
      wires: [[debugAllId]],
    },
    debugNode(debugAllId),
    objectPutNode(putAllId, srv, bucketAll, 'put'),
    injectNode(injectPutAllId, putAllId, 'x.txt'),
    objectPutNode(deleteAllId, srv, bucketAll, 'delete'),
    injectNode(injectDeleteAllId, deleteAllId, 'x.txt'),

    {
      id: watchFilteredId,
      type: 'nats-suite-object-get',
      z: 'FLOW',
      server: srv,
      bucket: bucketFiltered,
      operation: 'watch',
      watchIgnoreDeletes: true,
      watchIncludeHistory: false,
      wires: [[debugFilteredId]],
    },
    debugNode(debugFilteredId),
    objectPutNode(putFilteredId, srv, bucketFiltered, 'put'),
    injectNode(injectPutFilteredId, putFilteredId, 'y.txt'),
    objectPutNode(deleteFilteredId, srv, bucketFiltered, 'delete'),
    injectNode(injectDeleteFilteredId, deleteFilteredId, 'y.txt'),
  ];

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    const serverReady = comms.waitForStatus(
      srv,
      s => s.fill === 'green',
      20000
    );
    const watchingAll = comms.waitForStatus(
      watchAllId,
      s => s.text === 'watching',
      20000
    );
    const watchingFiltered = comms.waitForStatus(
      watchFilteredId,
      s => s.text === 'watching',
      20000
    );

    flowId = await deployFlow(nodes);
    await serverReady;
    await watchingAll;
    await watchingFiltered;

    // Unfiltered watcher: both the put and the delete must arrive.
    const putEventAll = comms.waitForDebug(debugAllId, 10000);
    await triggerInject(injectPutAllId);
    const putMsgAll = await putEventAll;
    assert.equal(putMsgAll.deleted, false);

    const deleteEventAll = comms.waitForDebug(debugAllId, 10000);
    await triggerInject(injectDeleteAllId);
    const deleteMsgAll = await deleteEventAll;
    assert.equal(deleteMsgAll.deleted, true);

    // Filtered watcher (watchIgnoreDeletes: true): the put must still
    // arrive, but the delete must not - proven by triggering the delete and
    // confirming no second debug event shows up within a bounded window.
    const putEventFiltered = comms.waitForDebug(debugFilteredId, 10000);
    await triggerInject(injectPutFilteredId);
    const putMsgFiltered = await putEventFiltered;
    assert.equal(putMsgFiltered.deleted, false);

    const noDeleteEvent = comms.waitForDebug(debugFilteredId, 3000);
    await triggerInject(injectDeleteFilteredId);
    await assert.rejects(
      noDeleteEvent,
      /Timed out/,
      'watchIgnoreDeletes: true must suppress the delete event entirely'
    );
  } finally {
    await removeFlow(flowId);
    comms.close();
    const nc = await connectDirectNats();
    for (const bucket of [bucketAll, bucketFiltered]) {
      try {
        const os = await new Objm(nc).open(bucket);
        await os.destroy();
      } catch {
        // The bucket may not exist if setup failed.
      }
    }
    await closeNats(nc);
  }
});

async function importExample(t, filename, extraNodeIds) {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const all = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'examples', filename), 'utf8')
  );
  const nodes = all
    .filter(node => node.type !== 'tab')
    .map(node =>
      node.type === 'nats-suite-server'
        ? { ...node, server: NATS_CONTAINER_URL }
        : node
    );
  const serverNodeId = all.find(node => node.type === 'nats-suite-server').id;

  const comms = connectComms();
  let flowId;
  try {
    await comms.ready;
    for (let cycle = 0; cycle < 2; cycle++) {
      const statusWaits = extraNodeIds.map(id =>
        comms.waitForStatus(id, status => Boolean(status?.text), 15000)
      );
      const serverReady = comms.waitForStatus(
        serverNodeId,
        status => status.fill === 'green',
        15000
      );

      flowId = await deployFlow(nodes);
      for (const statusWait of statusWaits) await statusWait;
      await serverReady;
      await deleteFlow(flowId);
      flowId = undefined;
    }
  } finally {
    await removeFlow(flowId);
    comms.close();
  }
}

test('example 04-object-store.json imports, connects, and redeploys', async t => {
  await importExample(t, '04-object-store.json', [
    'object-put',
    'object-delete',
    'object-get',
    'object-list',
  ]);
});

test('example 05-service.json imports, connects, and redeploys', async t => {
  await importExample(t, '05-service.json', [
    'service-echo',
    'service-discover',
    'service-stats',
    'service-ping',
    'service-health',
    'service-nats-stats',
  ]);
});
