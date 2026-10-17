'use strict';

const { Objm } = require('@nats-io/obj');
const { nanos } = require('@nats-io/nats-core');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsObjectGetNode(config) {
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
    let watcher = null;
    let watchTask = null;
    let watchSetupTask = null;
    let pendingWatchStart = null;
    let isWatching = false;
    let statusTimer = null;
    let closing = false;
    const isDebug = config.debug || this.serverConfig.debug || false;

    const detachStatus = attachStatus(node, this.serverConfig, {
      connected: () => {
        if (isWatching) {
          node.status({ fill: 'green', shape: 'dot', text: 'watching' });
        } else if (config.operation !== 'watch') {
          node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
        }
      },
    });

    // ObjectInfo.headers is a MsgHdrs instance (@nats-io/nats-core), not a
    // plain object - flatten it for msg.metadata.
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

    // Objm#create() is create-or-open (a no-op if the bucket already
    // exists), so it replaces the old try-bare-open-then-create fallback.
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

    // Helper: Start watching the bucket for object changes. Mirrors
    // nats-suite-kv-get.js's startWatch/stopWatch shape exactly.
    const startWatch = () => {
      if (isWatching) return Promise.resolve();
      if (pendingWatchStart) return pendingWatchStart;

      pendingWatchStart = (async () => {
        try {
          const os = await getObjectStore();

          const watchOptions = {};
          if (config.watchIgnoreDeletes) watchOptions.ignoreDeletes = true;
          if (config.watchIncludeHistory) watchOptions.includeHistory = true;

          watcher = await os.watch(watchOptions);
          if (closing) {
            await watcher.stop();
            watcher = null;
            return;
          }
          const activeWatcher = watcher;
          isWatching = true;

          node.status({ fill: 'green', shape: 'dot', text: 'watching' });
          if (isDebug)
            node.log(`[OBJECT GET] Started watching bucket: ${node.bucket}`);

          const consumeWatch = async () => {
            try {
              for await (const info of activeWatcher) {
                if (!isWatching) break;

                const watchMsg = {
                  operation: 'WATCH',
                  objectName: info.name,
                  bucket: node.bucket,
                  info: { ...info, headers: headersToObject(info.headers) },
                  size: info.size,
                  metadata: headersToObject(info.headers),
                  isUpdate: info.isUpdate,
                  deleted: info.deleted,
                  _watchEvent: true,
                };

                node.send(watchMsg);

                node.status({
                  fill: 'blue',
                  shape: 'dot',
                  text: `${info.deleted ? 'DEL' : 'PUT'}: ${info.name}`,
                });

                if (statusTimer) clearTimeout(statusTimer);
                statusTimer = setTimeout(() => {
                  statusTimer = null;
                  if (isWatching) {
                    node.status({
                      fill: 'green',
                      shape: 'dot',
                      text: 'watching',
                    });
                  }
                }, 1000);
              }
            } catch (err) {
              isWatching = false;
              watcher = null;
              watchTask = null;
              if (statusTimer) {
                clearTimeout(statusTimer);
                statusTimer = null;
              }
              if (!closing) {
                node.error(`Watch error: ${err.message}`);
                node.status({
                  fill: 'red',
                  shape: 'ring',
                  text: 'watch error',
                });
              }
            }
          };
          watchTask = consumeWatch();
        } finally {
          pendingWatchStart = null;
        }
      })();

      return pendingWatchStart;
    };

    // Helper: Stop watching
    const stopWatch = async () => {
      if (watcher) {
        await watcher.stop();
        await watchTask;
        if (isDebug) node.log(`[OBJECT GET] Stopped watching`);
        watcher = null;
        watchTask = null;
      }
      isWatching = false;
    };

    this.serverConfig.registerConnectionUser(node.id);

    if (config.operation === 'watch') {
      const initializeWatch = async () => {
        try {
          await startWatch();
        } catch (err) {
          node.error(`Failed to start watch: ${err.message}`);
          node.status({ fill: 'red', shape: 'ring', text: 'watch failed' });
        }
      };
      watchSetupTask = initializeWatch();
    } else {
      node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
    }

    node.on('input', async function (msg, send, done) {
      // Declared here (not const-scoped inside the try) so the catch below
      // can tag msg.operation with whatever was actually attempted, instead
      // of a hardcoded 'GET' that would mislabel watch/list failures too.
      let operation = 'get';
      try {
        // Check if this is a list or watch operation
        operation = msg.operation || config.operation || 'get';

        if (operation === 'watch') {
          if (!isWatching) await startWatch();
          done();
          return;
        }

        if (operation === 'list') {
          const os = await getObjectStore();
          const objects = [];

          // os.list() resolves to a plain array, not an async iterable.
          for (const obj of await os.list()) {
            objects.push({
              name: obj.name,
              size: obj.size,
              chunks: obj.chunks,
              mtime: obj.mtime,
              metadata: headersToObject(obj.headers),
            });
          }

          msg.payload = objects;
          msg.operation = 'LIST';
          msg.bucket = node.bucket;
          msg.count = objects.length;

          if (isDebug) {
            node.log(`[OBJECT LIST] Found ${objects.length} objects`);
          }

          send(msg);
          node.status({
            fill: 'green',
            shape: 'dot',
            text: `${objects.length} objects`,
          });
          done();
          return;
        }

        // Default: get operation
        let objectName;
        if (config.nameFrom === 'config') {
          objectName = config.objectName;
        } else if (config.nameFrom === 'msg') {
          objectName = msg.objectName || msg.name;
        } else if (config.nameFrom === 'topic') {
          objectName = msg.topic;
        }

        if (!objectName) {
          node.status({ fill: 'red', shape: 'ring', text: 'no name' });
          done(new Error('No object name specified'));
          return;
        }

        const os = await getObjectStore();
        const obj = await os.get(objectName);

        if (!obj) {
          msg.error = 'Object not found';
          send(msg);
          done(new Error(`Object not found: ${objectName}`));
          return;
        }

        // Read data
        const chunks = [];
        for await (const chunk of obj.data) {
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);

        // Set payload based on output format
        if (config.outputFormat === 'buffer') {
          msg.payload = data;
        } else if (config.outputFormat === 'string') {
          msg.payload = data.toString('utf8');
        } else if (config.outputFormat === 'json') {
          try {
            msg.payload = JSON.parse(data.toString('utf8'));
          } catch {
            msg.payload = data.toString('utf8');
          }
        } else {
          msg.payload = data;
        }

        msg.info = { ...obj.info, headers: headersToObject(obj.info.headers) };
        msg.operation = 'GET';
        msg.objectName = objectName;
        msg.bucket = node.bucket;
        msg.size = obj.info.size;
        msg.metadata = headersToObject(obj.info.headers);

        if (isDebug) {
          node.log(
            `[OBJECT GET] Retrieved - Name: ${objectName}, Size: ${obj.info.size}`
          );
        }

        send(msg);
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `got: ${objectName}`,
        });
        done();
      } catch (err) {
        msg.error = err.message;
        msg.operation = operation.toUpperCase();
        send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      }
    });

    node.on('close', async function (done) {
      let closeError;
      try {
        closing = true;
        detachStatus();
        if (statusTimer) clearTimeout(statusTimer);
        if (watchSetupTask) await watchSetupTask;
        await stopWatch();
      } catch (err) {
        closeError = err;
      } finally {
        this.serverConfig.unregisterConnectionUser(node.id);
        objectStore = null;
        node.status({});
        done(closeError);
      }
    });
  }

  RED.nodes.registerType('nats-suite-object-get', NatsObjectGetNode);
};
