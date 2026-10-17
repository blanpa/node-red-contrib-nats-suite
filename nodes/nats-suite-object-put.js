'use strict';

const { readFile } = require('node:fs/promises');
const { Objm } = require('@nats-io/obj');
const { nanos, headers: natsHeaders } = require('@nats-io/nats-core');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsObjectPutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.serverConfig = resolveServer(RED, node, config);
    if (!this.serverConfig) return;

    this.bucket = config.bucket || '';
    this.description = config.description || '';
    this.maxAge = parseInt(config.maxAge) || 0;
    this.maxBytes = parseInt(config.maxBytes) || 0;
    this.storage = config.storage || 'file';
    this.replicas = parseInt(config.replicas) || 1;
    this.compression = !!config.compression;

    let objectStore = null;
    const isDebug = config.debug || this.serverConfig.debug || false;

    // Shared by put/delete/link - the "object name" field is resolved the
    // same way regardless of which of those three operations is running.
    const resolveObjectName = msg => {
      if (config.nameFrom === 'config') return config.objectName;
      if (config.nameFrom === 'msg') return msg.objectName || msg.name;
      if (config.nameFrom === 'topic') return msg.topic;
      return undefined;
    };

    // ObjectInfo.headers is a MsgHdrs instance (@nats-io/nats-core), not a
    // plain object - flatten it so msg.info stays JSON-serializable.
    // ponytail: hdrs.get() returns only the last value per key, so a
    // multi-valued header collapses to one string - matches how the rest of
    // this codebase treats headers. Switch to hdrs.values(key) if a caller
    // ever needs every value.
    const headersToObject = hdrs => {
      if (!hdrs) return {};
      const obj = {};
      for (const key of hdrs.keys()) obj[key] = hdrs.get(key);
      return obj;
    };

    // Helper: Get or create Object Store. Objm#create() is create-or-open
    // (a no-op if the bucket already exists), so it replaces the old
    // try-bare-open-then-create fallback.
    const getObjectStore = async () => {
      if (objectStore) return objectStore;

      const nc = await node.serverConfig.getConnection();
      const createOptions = {
        description: node.description || undefined,
        max_bytes: node.maxBytes || undefined,
        ttl: node.maxAge ? nanos(node.maxAge * 1000) : undefined,
        storage: node.storage === 'memory' ? 'memory' : 'file',
        replicas: node.replicas,
        compression: node.compression,
      };

      Object.keys(createOptions).forEach(key => {
        if (createOptions[key] === undefined) delete createOptions[key];
      });

      objectStore = await new Objm(nc).create(node.bucket, createOptions);
      return objectStore;
    };

    // Bucket Management Operations. Returns null on success, or the error
    // to report via done(err) - the caller sends msg itself in both cases.
    const performBucketOperation = async (msg, send) => {
      try {
        const nc = await node.serverConfig.getConnection();
        const objm = new Objm(nc);

        const operation = msg.operation || config.operation || 'put';
        const bucketName = msg.bucket || node.bucket || '';

        if (!bucketName && operation !== 'bucket-list') {
          return new Error('Bucket name required for operation');
        }

        switch (operation) {
          case 'bucket-create': {
            const createOptions = {
              description: msg.description || node.description || undefined,
              max_bytes: msg.maxBytes
                ? parseInt(msg.maxBytes, 10)
                : node.maxBytes || undefined,
              ttl: msg.maxAge
                ? nanos(parseInt(msg.maxAge, 10) * 1000)
                : node.maxAge
                  ? nanos(node.maxAge * 1000)
                  : undefined,
              storage:
                (msg.storage || node.storage) === 'memory' ? 'memory' : 'file',
              replicas: msg.replicas
                ? parseInt(msg.replicas, 10)
                : node.replicas || 1,
              compression:
                msg.compression !== undefined
                  ? !!msg.compression
                  : node.compression,
            };

            Object.keys(createOptions).forEach(key => {
              if (createOptions[key] === undefined) delete createOptions[key];
            });

            await objm.create(bucketName, createOptions);
            msg.payload = {
              operation: 'bucket-create',
              bucket: bucketName,
              success: true,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `created: ${bucketName}`,
            });
            break;
          }

          case 'bucket-info': {
            const os = await objm.create(bucketName);
            const status = await os.status();
            const objects = await os.list();
            msg.payload = {
              operation: 'bucket-info',
              bucket: bucketName,
              size: status.size || 0,
              objects: objects.length,
              deleted: status.streamInfo.state.num_deleted || 0,
            };
            node.status({ fill: 'green', shape: 'dot', text: bucketName });
            break;
          }

          case 'bucket-delete': {
            const os = await objm.create(bucketName);
            await os.destroy();
            msg.payload = {
              operation: 'bucket-delete',
              bucket: bucketName,
              success: true,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `deleted: ${bucketName}`,
            });
            break;
          }

          case 'seal': {
            const os = await objm.create(bucketName);
            const status = await os.seal();
            msg.payload = {
              operation: 'seal',
              bucket: bucketName,
              sealed: status.sealed,
              size: status.size,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `sealed: ${bucketName}`,
            });
            break;
          }

          case 'bucket-list': {
            const statuses = [];
            for await (const status of objm.list()) {
              statuses.push(status);
            }
            const buckets = [];
            for (const status of statuses) {
              const os = await objm.open(status.bucket);
              buckets.push({
                name: status.bucket,
                objects: (await os.list()).length,
                bytes: status.size || 0,
              });
            }
            msg.payload = buckets;
            msg.operation = 'bucket-list';
            msg.count = buckets.length;
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `${buckets.length} buckets`,
            });
            break;
          }

          default:
            return new Error(`Unknown bucket operation: ${operation}`);
        }

        send(msg);
        return null;
      } catch (err) {
        msg.error = err.message;
        send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        return err;
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    const detachStatus = attachStatus(node, this.serverConfig, {
      connected: () => {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
      },
    });

    // Input handler
    node.on('input', async function (msg, send, done) {
      // Declared here (not const-scoped inside the try) so the catch below
      // can tag msg.operation with whatever was actually attempted, instead
      // of a hardcoded 'PUT' that mislabeled delete/link failures too.
      let operation = 'put';
      try {
        // Check if this is a bucket management operation
        operation = msg.operation || config.operation || 'put';

        if (
          [
            'bucket-create',
            'bucket-info',
            'bucket-delete',
            'bucket-list',
            'seal',
          ].includes(operation)
        ) {
          done(await performBucketOperation(msg, send));
          return;
        }

        // Link operation: create a new entry that references another
        // object in the same store, or an entire other store. Not a
        // bucket-admin op (it creates an object-store entry, same family as
        // put/delete) so it's handled inline here rather than in
        // performBucketOperation.
        if (operation === 'link') {
          const objectName = resolveObjectName(msg);

          if (!objectName) {
            node.status({ fill: 'red', shape: 'ring', text: 'no name' });
            done(new Error('No object name specified'));
            return;
          }

          const targetName = msg.targetName || config.targetName || '';
          const targetBucket = msg.targetBucket || config.targetBucket || '';
          if (!targetName === !targetBucket) {
            done(
              new Error(
                'link requires exactly one of targetName (same-store link) or targetBucket (cross-store link)'
              )
            );
            return;
          }

          const os = await getObjectStore();
          let info;
          if (targetName) {
            const targetInfo = await os.info(targetName);
            if (!targetInfo) {
              done(new Error(`Link target not found: ${targetName}`));
              return;
            }
            info = await os.link(objectName, targetInfo);
          } else {
            const nc = await node.serverConfig.getConnection();
            const targetStore = await new Objm(nc).open(targetBucket);
            info = await os.linkStore(objectName, targetStore);
          }

          if (isDebug) {
            node.log(
              `[OBJECT LINK] Linked: ${objectName} -> ${targetName || targetBucket}`
            );
          }

          msg.info = { ...info, headers: headersToObject(info.headers) };
          msg.operation = 'LINK';
          msg.objectName = objectName;
          msg.bucket = node.bucket;

          send(msg);
          node.status({
            fill: 'green',
            shape: 'dot',
            text: `linked: ${objectName}`,
          });
          done();
          return;
        }

        // Check if this is a delete operation
        if (operation === 'delete') {
          const objectName = resolveObjectName(msg);

          if (!objectName) {
            node.status({ fill: 'red', shape: 'ring', text: 'no name' });
            done(new Error('No object name specified'));
            return;
          }

          const os = await getObjectStore();
          await os.delete(objectName);

          if (isDebug) {
            node.log(`[OBJECT DELETE] Deleted: ${objectName}`);
          }

          msg.operation = 'DELETE';
          msg.objectName = objectName;
          msg.bucket = node.bucket;
          msg.success = true;

          send(msg);
          node.status({
            fill: 'green',
            shape: 'dot',
            text: `deleted: ${objectName}`,
          });
          done();
          return;
        }

        // Default: put operation
        const objectName = resolveObjectName(msg);

        if (!objectName) {
          node.status({ fill: 'red', shape: 'ring', text: 'no name' });
          done(new Error('No object name specified'));
          return;
        }

        const os = await getObjectStore();

        // Get data from payload
        let data;
        if (config.dataFrom === 'payload') {
          data = msg.payload;
        } else if (config.dataFrom === 'buffer') {
          data = Buffer.isBuffer(msg.payload)
            ? msg.payload
            : Buffer.from(String(msg.payload));
        } else if (config.dataFrom === 'file') {
          const filePath = msg.filePath || config.filePath;
          if (!filePath) {
            done(new Error('No file path specified'));
            return;
          }
          data = await readFile(filePath);
        }

        if (data === undefined || data === null) {
          done(new Error('No data specified'));
          return;
        }

        // Convert to Buffer if needed
        if (!Buffer.isBuffer(data)) {
          if (typeof data === 'string') {
            data = Buffer.from(data, 'utf8');
          } else if (typeof data === 'object') {
            data = Buffer.from(JSON.stringify(data), 'utf8');
          } else {
            data = Buffer.from(String(data));
          }
        }

        // Prepare metadata
        const metadata = {};
        if (msg.metadata && typeof msg.metadata === 'object') {
          Object.assign(metadata, msg.metadata);
        }
        if (config.description) {
          metadata.description = config.description;
        }
        if (msg.contentType) {
          metadata['content-type'] = msg.contentType;
        } else if (config.contentType) {
          metadata['content-type'] = config.contentType;
        }

        // Upload object. putBlob() takes the fully-buffered bytes directly;
        // put() wants a ReadableStream, which we don't have here. headers
        // must be a MsgHdrs instance, not a plain object.
        let msgHeaders;
        const headerEntries = Object.entries(metadata).filter(
          ([k]) => k !== 'description'
        );
        if (headerEntries.length > 0) {
          msgHeaders = natsHeaders();
          headerEntries.forEach(([k, v]) => msgHeaders.set(k, String(v)));
        }

        const info = await os.putBlob(
          {
            name: objectName,
            description: metadata.description,
            headers: msgHeaders,
          },
          data
        );

        if (isDebug) {
          node.log(
            `[OBJECT PUT] Upload successful - Name: ${objectName}, Size: ${info.size}, Chunks: ${info.chunks}`
          );
        }

        msg.info = { ...info, headers: headersToObject(info.headers) };
        msg.operation = 'PUT';
        msg.objectName = objectName;
        msg.bucket = node.bucket;
        msg.size = info.size;
        msg.chunks = info.chunks;

        send(msg);
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `put: ${objectName}`,
        });
        done();
      } catch (err) {
        msg.error = err.message;
        // operation may be msg.operation, which is attacker/caller-controlled
        // and not guaranteed to be a string - guard so a bad value doesn't
        // throw again here and swallow the real error as an unhandled
        // rejection.
        msg.operation = String(operation).toUpperCase();
        send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      }
    });

    // Cleanup
    node.on('close', function (done) {
      detachStatus();
      this.serverConfig.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-object-put', NatsObjectPutNode);
};
