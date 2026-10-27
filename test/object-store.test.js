'use strict';

// Direct integration tests for the @nats-io/obj calls used by the registered
// Object Store nodes. Real Node-RED wrapper behavior is covered separately in
// promotion.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Objm } = require('@nats-io/obj');
const { headers: natsHeaders } = require('@nats-io/nats-core');
const { ensureStackUp, connectDirectNats } = require('./lib/harness');

async function cleanup(nc, bucket) {
  try {
    const os = await new Objm(nc).open(bucket);
    await os.destroy();
  } catch {
    // The bucket may not have been created if setup failed.
  }
  try {
    await nc.close();
  } catch {
    // Cleanup is best-effort after the assertion result is known.
  }
}

test('object store: create-or-open, putBlob with headers, get, list', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_obj_${Date.now().toString(36)}`;
  const nc = await connectDirectNats();

  try {
    const objm = new Objm(nc);

    // create() is create-or-open - calling it twice for the same bucket
    // must not throw (this is what replaces the old try-open-then-create
    // fallback in the node code).
    const os1 = await objm.create(bucket, { storage: 'file', replicas: 1 });
    const os2 = await objm.create(bucket);
    assert.ok(os1 && os2, 'create() should succeed both as create and as open');

    const hdrs = natsHeaders();
    hdrs.set('content-type', 'text/plain');

    const payload = Buffer.from('hello object store');
    const info = await os1.putBlob(
      { name: 'greeting.txt', headers: hdrs },
      payload
    );
    assert.equal(info.name, 'greeting.txt');
    assert.equal(info.size, payload.length);

    const got = await os1.get('greeting.txt');
    assert.ok(got, 'get() should find the object just put');
    const chunks = [];
    for await (const chunk of got.data) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello object store');
    assert.equal(got.info.headers.get('content-type'), 'text/plain');

    // Bug 5: list() resolves to a plain array, not an async iterable.
    const listed = await os1.list();
    assert.ok(Array.isArray(listed), 'list() must resolve to a plain array');
    assert.ok(listed.some(o => o.name === 'greeting.txt'));

    // Objm#list() (the Kvm-equivalent for Object Store buckets) replaces
    // the hand-rolled OBJ_-prefix stream filtering the node code used to do.
    const buckets = [];
    for await (const status of objm.list()) buckets.push(status);
    assert.ok(
      buckets.some(b => b.bucket === bucket),
      'Objm#list() should surface the bucket by its plain (unprefixed) name'
    );
  } finally {
    await cleanup(nc, bucket);
  }
});

test('object store: bucket-info/bucket-list count fields (object-put.js admin ops)', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_obj_admin_${Date.now().toString(36)}`;
  const nc = await connectDirectNats();

  try {
    const objm = new Objm(nc);
    const os = await objm.create(bucket);
    const before = (await os.status()).streamInfo.state.messages;

    await os.putBlob({ name: 'a.txt' }, Buffer.from('a'));
    await os.putBlob({ name: 'b.txt' }, Buffer.from('b'));

    const objects = await os.list();
    assert.equal(
      objects.length,
      2,
      'object count must count objects, not backing stream messages'
    );

    const afterPuts = await os.status();
    assert.equal(afterPuts.bucket, bucket);
    assert.equal(typeof afterPuts.size, 'number');
    assert.ok(
      afterPuts.streamInfo.state.messages > before,
      'messages should grow after putBlob calls'
    );

    await os.delete('a.txt');
    const afterDelete = await os.status();
    // num_deleted is absent (not 0) when the server has nothing to report -
    // matches why object-put.js's bucket-info reads it with `|| 0`.
    assert.ok(
      afterDelete.streamInfo.state.num_deleted === undefined ||
        typeof afterDelete.streamInfo.state.num_deleted === 'number'
    );

    const buckets = [];
    for await (const s of objm.list()) buckets.push(s);
    const listed = buckets.find(b => b.bucket === bucket);
    assert.ok(listed, 'objm.list() should surface the bucket');
    assert.equal(
      listed.streamInfo.state.messages,
      afterDelete.streamInfo.state.messages,
      'objm.list() and os.status() should agree'
    );
  } finally {
    await cleanup(nc, bucket);
  }
});

// Step 6 of NATS-3.4-GAP-PLAN.md: link (same-store and cross-store) and seal,
// exercised at the same @nats-io/obj call level nats-suite-object-put.js
// itself uses (os.info/os.link/os.linkStore/os.seal), matching this file's
// existing direct-integration style.
test('object store: link() to another object in the same bucket resolves to the same data', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_obj_link_${Date.now().toString(36)}`;
  const nc = await connectDirectNats();

  try {
    const objm = new Objm(nc);
    const os = await objm.create(bucket);

    const payload = Buffer.from('link target payload');
    await os.putBlob({ name: 'target.txt' }, payload);

    const targetInfo = await os.info('target.txt');
    assert.ok(targetInfo, 'os.info() should find the just-created target');

    const linkInfo = await os.link('alias.txt', targetInfo);
    assert.equal(linkInfo.name, 'alias.txt');

    const got = await os.get('alias.txt');
    assert.ok(got, 'get() on the link name should resolve');
    const chunks = [];
    for await (const chunk of got.data) chunks.push(chunk);
    assert.equal(
      Buffer.concat(chunks).toString('utf8'),
      'link target payload',
      "reading through the link must return the target object's actual data"
    );

    // "links of links are rejected" per the upstream doc comment - the
    // node code deliberately doesn't pre-validate this, it lets the
    // server's own rejection propagate. Confirm that's real, not assumed.
    const linkInfoAgain = await os.info('alias.txt');
    await assert.rejects(
      () => os.link('alias-of-alias.txt', linkInfoAgain),
      /is a link/i,
      'linking to an existing link must be rejected by the real server'
    );
  } finally {
    await cleanup(nc, bucket);
  }
});

test('object store: linkStore() to an entire other bucket resolves', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucketA = `test_obj_linkstore_a_${Date.now().toString(36)}`;
  const bucketB = `test_obj_linkstore_b_${Date.now().toString(36)}`;
  const nc = await connectDirectNats();

  try {
    const objm = new Objm(nc);
    const osA = await objm.create(bucketA);
    const osB = await objm.create(bucketB);
    await osB.putBlob({ name: 'inner.txt' }, Buffer.from('other bucket data'));

    const otherStore = await objm.open(bucketB);
    const linkInfo = await osA.linkStore('whole-store-link', otherStore);
    assert.equal(linkInfo.name, 'whole-store-link');
    assert.equal(
      linkInfo.options?.link?.bucket,
      bucketB,
      'the created entry must record it links to bucketB as a whole (no per-object name)'
    );
    assert.equal(
      linkInfo.options?.link?.name,
      undefined,
      'a whole-store link must not carry a specific object name'
    );
  } finally {
    await cleanup(nc, bucketA);
    await cleanup(nc, bucketB);
  }
});

test('object store: seal() causes the real server to reject a subsequent put', async t => {
  const skipReason = await ensureStackUp();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const bucket = `test_obj_seal_${Date.now().toString(36)}`;
  const nc = await connectDirectNats();

  try {
    const objm = new Objm(nc);
    const os = await objm.create(bucket);
    await os.putBlob({ name: 'before-seal.txt' }, Buffer.from('ok'));

    const status = await os.seal();
    assert.equal(
      status.sealed,
      true,
      'seal() must report the bucket as sealed'
    );

    await assert.rejects(
      () => os.putBlob({ name: 'after-seal.txt' }, Buffer.from('rejected')),
      /seal/i,
      'a put against a sealed bucket must be rejected by the real server, not just locally'
    );

    const finalStatus = await os.status();
    assert.equal(
      finalStatus.sealed,
      true,
      'sealed state must persist and be readable back from the server'
    );
  } finally {
    await cleanup(nc, bucket);
  }
});
