'use strict';

// Direct integration tests for the @nats-io/services calls used by the
// registered service node. Real Node-RED wrapper behavior is covered
// separately in promotion.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Svcm } = require('@nats-io/services');
const { ensureStackUp, connectDirectNats } = require('./lib/harness');

test('services: add with a synchronous addEndpoint, request, discover, stats, ping', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const nc = await connectDirectNats();
  const serviceName = `test_svc_${Date.now().toString(36)}`;

  try {
    const service = await new Svcm(nc).add({
      name: serviceName,
      version: '1.0.0',
      description: 'object-4 migration probe',
    });

    // addEndpoint(name, handler) with no explicit subject subscribes on the
    // bare endpoint name when called on the top-level service (its root
    // subject is "") - not `${serviceName}.${name}` as the node's own
    // "endpoint subject" logging/UI field implies (pre-existing behavior,
    // unrelated to this migration; verified against the installed package's
    // service.js ServiceGroupImpl.calcSubject). Pass an explicit unique
    // subject instead of relying on that default, so this test can't
    // collide with anything else answering on the shared dev broker.
    const endpointSubject = `${serviceName}.process`;
    const iter = service.addEndpoint('process', {
      subject: endpointSubject,
      handler: (err, msg) => {
        if (err) return;
        const payload = JSON.parse(msg.string());
        msg.respond(JSON.stringify({ echoed: payload }));
      },
    });
    // addEndpoint() is synchronous - it returns a QueuedIterator<ServiceMsg>
    // immediately rather than a Promise (the pre-migration code awaited it).
    assert.equal(
      typeof iter.stop,
      'function',
      'addEndpoint() should return a QueuedIterator synchronously'
    );

    // addEndpoint() returns before its SUB has round-tripped the server;
    // flush() is the observable signal that the subscription is live.
    await nc.flush();

    const requestPayload = { hello: 'world' };
    const response = await nc.request(
      endpointSubject,
      JSON.stringify(requestPayload),
      { timeout: 2000 }
    );
    assert.deepEqual(response.json(), { echoed: requestPayload });

    const client = new Svcm(nc).client();

    const infos = [];
    for await (const info of await client.info(serviceName)) infos.push(info);
    assert.ok(
      infos.some(i => i.name === serviceName),
      'discovery via client.info() should find the service'
    );

    const stats = [];
    for await (const s of await client.stats(serviceName)) stats.push(s);
    assert.ok(
      stats.length > 0,
      'client.stats() should return at least one entry'
    );
    assert.ok(
      stats[0].endpoints.some(e => e.num_requests >= 1),
      'the request above should be reflected in endpoint stats'
    );

    const pings = [];
    for await (const p of await client.ping(serviceName)) pings.push(p);
    assert.ok(pings.some(p => p.name === serviceName));

    await service.stop();
  } finally {
    try {
      await nc.close();
    } catch {
      // Cleanup is best-effort after the assertion result is known.
    }
  }
});

// Step 8 (NATS-3.4-GAP-PLAN.md): Service.addGroup()/.reset(), exercised the
// same way as the test above - direct @nats-io/services calls, no Node-RED
// wrapper.
test('services: addGroup() namespaces an endpoint under the group subject, reset() zeroes real stats', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const nc = await connectDirectNats();
  const serviceName = `test_svc_grp_${Date.now().toString(36)}`;
  const groupSubject = `${serviceName}.orders`;
  const endpointName = `process_${Date.now().toString(36)}`;

  try {
    const service = await new Svcm(nc).add({
      name: serviceName,
      version: '1.0.0',
      description: 'group/reset probe',
    });

    // Tracked independently of the network response: this dev broker is
    // shared with other concurrently-running projects/sessions on this
    // machine (confirmed via jsm.streams.list() showing unrelated streams
    // like DAPR_EVENTS/NB_* from other work), so a bare, unnamespaced
    // subject can get a real-looking response from something that isn't
    // ours. Asserting "no responders" on the wire is unreliable here;
    // asserting our own handler never fired is not.
    let handlerCalls = 0;
    const group = service.addGroup(groupSubject);
    group.addEndpoint(endpointName, {
      handler: (err, msg) => {
        if (err) return;
        handlerCalls++;
        msg.respond(JSON.stringify({ echoed: JSON.parse(msg.string()) }));
      },
    });
    await nc.flush();

    // Reachable under the group prefix.
    const groupedSubject = `${groupSubject}.${endpointName}`;
    const okResponse = await nc.request(
      groupedSubject,
      JSON.stringify({ hello: 'grouped' }),
      { timeout: 2000 }
    );
    assert.deepEqual(okResponse.json(), { echoed: { hello: 'grouped' } });
    assert.equal(
      handlerCalls,
      1,
      'the grouped request should invoke our handler exactly once'
    );

    // NOT reachable at the bare endpoint name - proves the group actually
    // namespaces it rather than also/instead registering the bare name.
    // Whatever else may or may not answer on this shared broker, OUR
    // handler must not be the one that fires.
    try {
      await nc.request(endpointName, '{}', { timeout: 500 });
    } catch {
      // No responders (or someone else's responder erroring) is fine too -
      // the only thing under test is whether *our* handler fired.
    }
    assert.equal(
      handlerCalls,
      1,
      'the bare endpoint name must not reach our grouped handler'
    );

    const client = new Svcm(nc).client();
    const statsBefore = [];
    for await (const s of await client.stats(serviceName)) statsBefore.push(s);
    assert.ok(
      statsBefore[0].endpoints.some(e => e.num_requests >= 1),
      'the grouped request above should be reflected in endpoint stats before reset'
    );

    service.reset();
    await nc.flush();

    const statsAfter = [];
    for await (const s of await client.stats(serviceName)) statsAfter.push(s);
    assert.ok(
      statsAfter[0].endpoints.every(e => e.num_requests === 0),
      `reset() should zero every endpoint's num_requests, got ${JSON.stringify(statsAfter[0].endpoints)}`
    );

    await service.stop();
  } finally {
    try {
      await nc.close();
    } catch {
      // Cleanup is best-effort after the assertion result is known.
    }
  }
});
