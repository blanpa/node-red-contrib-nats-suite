'use strict';

const { Kvm } = require('@nats-io/kv');
const { JetStreamApiCodes, JetStreamApiError } = require('@nats-io/jetstream');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsKvPutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.serverConfig = resolveServer(RED, node, config);
    if (!this.serverConfig) return;

    this.bucket = config.bucket || '';
    this.description = config.description || '';
    this.history = Number.parseInt(config.history, 10);
    if (!Number.isFinite(this.history)) this.history = 10;
    this.maxAge = Number.parseInt(config.maxAge, 10);
    if (!Number.isFinite(this.maxAge)) this.maxAge = 0;
    this.maxBytes = parseInt(config.maxBytes) || 0;
    this.maxValueSize = parseInt(config.maxValueSize) || 0;
    this.compression = !!config.compression;
    this.replicas = parseInt(config.replicas) || 1;
    this.storage = config.storage || 'file';
    this.bucketMarkerTTL = parseInt(config.bucketMarkerTTL) || 0;

    let kvStore = null;
    let statusTimer = null;
    const isDebug = config.debug || this.serverConfig.debug || false;

    // Helper: Get or create KV bucket. Kvm#create() is create-or-open (a
    // no-op if the bucket already exists), so it replaces the old
    // try-bare-open-then-create-with-options fallback outright.
    const getKVBucket = async () => {
      if (kvStore) return kvStore;

      const nc = await node.serverConfig.getConnection();
      const createOptions = {
        history: node.history,
        ttl: node.maxAge * 1000,
        max_bytes: node.maxBytes || undefined,
        maxValueSize: node.maxValueSize || undefined,
        compression: node.compression,
        replicas: node.replicas,
        storage: node.storage === 'memory' ? 'memory' : 'file',
        markerTTL: node.bucketMarkerTTL || undefined,
      };

      Object.keys(createOptions).forEach(key => {
        if (createOptions[key] === undefined) delete createOptions[key];
      });

      kvStore = await new Kvm(nc).create(node.bucket, createOptions);
      return kvStore;
    };

    // Helper: Stringify value if needed
    const prepareValue = value => {
      if (config.stringifyJSON && typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    };

    // Bucket Management Operations. Returns null on success, or the error
    // to report via done(err) - the caller sends msg itself in both cases.
    const performBucketOperation = async (msg, send) => {
      try {
        const nc = await node.serverConfig.getConnection();
        const kvm = new Kvm(nc);

        const operation = msg.operation || config.operation || 'put';
        const bucketName = msg.bucket || node.bucket || '';

        if (!bucketName && operation !== 'bucket-list') {
          return new Error('Bucket name required for operation');
        }

        switch (operation) {
          case 'bucket-create': {
            const createOptions = {
              history:
                msg.history !== undefined && msg.history !== null
                  ? parseInt(msg.history, 10)
                  : (node.history ?? 10),
              ttl:
                msg.maxAge !== undefined && msg.maxAge !== null
                  ? parseInt(msg.maxAge, 10) * 1000
                  : node.maxAge !== undefined && node.maxAge !== null
                    ? node.maxAge * 1000
                    : undefined,
              max_bytes:
                msg.maxBytes !== undefined && msg.maxBytes !== null
                  ? parseInt(msg.maxBytes, 10)
                  : node.maxBytes !== undefined && node.maxBytes !== null
                    ? node.maxBytes
                    : undefined,
              maxValueSize:
                msg.maxValueSize !== undefined && msg.maxValueSize !== null
                  ? parseInt(msg.maxValueSize, 10)
                  : node.maxValueSize !== undefined &&
                      node.maxValueSize !== null
                    ? node.maxValueSize
                    : undefined,
              compression:
                msg.compression !== undefined
                  ? !!msg.compression
                  : node.compression,
              replicas:
                msg.replicas !== undefined && msg.replicas !== null
                  ? parseInt(msg.replicas, 10)
                  : (node.replicas ?? 1),
              storage:
                (msg.storage || node.storage) === 'memory' ? 'memory' : 'file',
              markerTTL:
                msg.bucketMarkerTTL !== undefined &&
                msg.bucketMarkerTTL !== null
                  ? parseInt(msg.bucketMarkerTTL, 10)
                  : node.bucketMarkerTTL !== undefined &&
                      node.bucketMarkerTTL !== null
                    ? node.bucketMarkerTTL
                    : undefined,
            };

            Object.keys(createOptions).forEach(key => {
              if (createOptions[key] === undefined) delete createOptions[key];
            });

            await kvm.create(bucketName, createOptions);
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
            const kv = await kvm.create(bucketName);
            const status = await kv.status();
            msg.payload = {
              operation: 'bucket-info',
              bucket: bucketName,
              values: status.values || 0,
              bytes: status.size || 0,
              markerTTL: status.markerTTL || 0,
            };
            node.status({ fill: 'green', shape: 'dot', text: bucketName });
            break;
          }

          case 'bucket-delete': {
            const kv = await kvm.create(bucketName);
            await kv.destroy();
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

          case 'bucket-list': {
            const buckets = [];
            for await (const status of kvm.list()) {
              buckets.push({
                name: status.bucket,
                values: status.values || 0,
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
      try {
        // Check if this is a bucket management operation
        const operation = msg.operation || config.operation || 'put';

        if (
          [
            'bucket-create',
            'bucket-info',
            'bucket-delete',
            'bucket-list',
          ].includes(operation)
        ) {
          done(await performBucketOperation(msg, send));
          return;
        }

        // Determine key
        let key;
        if (config.keyFrom === 'config') {
          key = config.key;
        } else if (config.keyFrom === 'msg') {
          key = msg.key;
        } else if (config.keyFrom === 'topic') {
          key = msg.topic;
        }

        if (!key) {
          node.status({ fill: 'red', shape: 'ring', text: 'no key' });
          done(new Error('No key specified'));
          return;
        }

        const kv = await getKVBucket();

        // Debug logging for operation
        if (isDebug) {
          node.log(
            `[KV PUT] Operation: ${operation.toUpperCase()}, Key: ${key}, Bucket: ${node.bucket}`
          );
        }

        // Perform operation - use msg.operation if provided, otherwise config.operation
        const op = operation;
        switch (op) {
          case 'put': {
            // Determine value
            let value;
            if (config.valueFrom === 'payload') {
              value = msg.payload;
            } else if (config.valueFrom === 'config') {
              value = config.value;
            } else if (config.valueFrom === 'msg') {
              value = msg.value;
            }

            if (value === undefined || value === null) {
              done(new Error('No value specified'));
              return;
            }

            const preparedValue = prepareValue(value);

            // Note: TTL is only supported at bucket level, not per-key
            // Individual key TTL is not supported by NATS KV Store
            const revision = await kv.put(key, preparedValue);

            if (isDebug) {
              node.log(
                `[KV PUT] PUT successful - Key: ${key}, Revision: ${revision}`
              );
            }

            msg.revision = revision;
            msg.operation = 'PUT';
            msg.key = key;
            msg.bucket = node.bucket;

            send(msg);
            node.status({ fill: 'green', shape: 'dot', text: `put: ${key}` });
            break;
          }

          case 'create': {
            // Create only if key doesn't exist
            let value;
            if (config.valueFrom === 'payload') {
              value = msg.payload;
            } else if (config.valueFrom === 'config') {
              value = config.value;
            } else if (config.valueFrom === 'msg') {
              value = msg.value;
            }

            if (value === undefined || value === null) {
              done(new Error('No value specified'));
              return;
            }

            const preparedValue = prepareValue(value);

            // markerTTL here is a per-create-call Go duration string
            // ("10s"/"1m"/"1h") - a different thing from the bucket-level
            // markerTTL (a plain millisecond number set at bucket creation,
            // which must be non-zero first or the server rejects this with
            // "per-message TTL is disabled", confirmed against a real broker).
            const markerTTL =
              msg.markerTTL || config.createMarkerTTL || undefined;

            try {
              const revision = await kv.create(key, preparedValue, markerTTL);

              if (isDebug) {
                node.log(
                  `[KV PUT] CREATE successful - Key: ${key}, Revision: ${revision}`
                );
              }

              msg.revision = revision;
              msg.operation = 'PUT';
              msg.key = key;
              msg.bucket = node.bucket;
              msg._created = true;

              send(msg);
              node.status({
                fill: 'green',
                shape: 'dot',
                text: `created: ${key}`,
              });
            } catch (err) {
              if (
                err instanceof JetStreamApiError &&
                [
                  JetStreamApiCodes.StreamWrongLastSequence,
                  JetStreamApiCodes.StreamWrongLastSequenceUnknown,
                ].includes(err.code)
              ) {
                node.status({
                  fill: 'red',
                  shape: 'ring',
                  text: 'already exists',
                });
                done(new Error(`Key already exists: ${key}`));
                return;
              }
              throw err;
            }
            break;
          }

          case 'update': {
            // Update only if key exists
            let value;
            if (config.valueFrom === 'payload') {
              value = msg.payload;
            } else if (config.valueFrom === 'config') {
              value = config.value;
            } else if (config.valueFrom === 'msg') {
              value = msg.value;
            }

            if (value === undefined || value === null) {
              done(new Error('No value specified'));
              return;
            }

            const preparedValue = prepareValue(value);

            // Get current revision first
            const current = await kv.get(key);
            if (!current) {
              node.status({ fill: 'red', shape: 'ring', text: 'not found' });
              done(new Error(`Key does not exist: ${key}`));
              return;
            }

            // Note: TTL is only supported at bucket level, not per-key
            // Individual key TTL is not supported by NATS KV Store
            const revision = await kv.update(
              key,
              preparedValue,
              current.revision
            );

            if (isDebug) {
              node.log(
                `[KV PUT] UPDATE successful - Key: ${key}, Revision: ${revision}`
              );
            }

            msg.revision = revision;
            msg.operation = 'PUT';
            msg.key = key;
            msg.bucket = node.bucket;
            msg._updated = true;

            send(msg);
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `updated: ${key}`,
            });
            break;
          }

          case 'delete': {
            // Soft delete (mark as deleted)
            await kv.delete(key);

            if (isDebug) {
              node.log(`[KV PUT] DELETE successful - Key: ${key}`);
            }

            msg.operation = 'DEL';
            msg.key = key;
            msg.bucket = node.bucket;
            msg._deleted = true;

            send(msg);
            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `deleted: ${key}`,
            });
            break;
          }

          case 'purge': {
            // Hard delete (remove all revisions)
            await kv.purge(key);

            if (isDebug) {
              node.log(`[KV PUT] PURGE successful - Key: ${key}`);
            }

            msg.operation = 'PURGE';
            msg.key = key;
            msg.bucket = node.bucket;
            msg._purged = true;

            send(msg);
            node.status({ fill: 'blue', shape: 'dot', text: `purged: ${key}` });
            break;
          }

          default:
            done(new Error(`Unknown operation: ${op}`));
            return;
        }

        // Reset status after 1 second
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
          statusTimer = null;
          node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
        }, 1000);
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      }
    });

    // Cleanup on close
    node.on('close', function (done) {
      if (statusTimer) clearTimeout(statusTimer);
      detachStatus();
      this.serverConfig.unregisterConnectionUser(node.id);
      kvStore = null;
      node.status({});
      done();
    });
  }

  RED.nodes.registerType('nats-suite-kv-put', NatsKvPutNode);
};
