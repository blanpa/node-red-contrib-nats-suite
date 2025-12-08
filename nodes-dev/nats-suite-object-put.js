'use strict';

module.exports = function (RED) {
  function NatsObjectPutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Server configuration (required)
    if (!config.server) {
      node.error('NATS server configuration not selected');
      node.status({ fill: 'red', shape: 'ring', text: 'no server' });
      return;
    }

    this.serverConfig = RED.nodes.getNode(config.server);
    if (!this.serverConfig) {
      node.error('NATS server configuration not found');
      node.status({ fill: 'red', shape: 'ring', text: 'server not found' });
      return;
    }

    // Bucket configuration - can use bucketConfig node OR direct settings
    this.bucket = config.bucket || '';
    this.bucketConfig = config.bucketConfig ? RED.nodes.getNode(config.bucketConfig) : null;
    
    // If bucketConfig node exists, use it; otherwise use direct settings
    if (this.bucketConfig) {
      this.bucket = this.bucketConfig.bucket;
      this.serverConfig = this.bucketConfig.serverConfig;
    } else {
      // Direct bucket settings
      this.description = config.description || '';
      this.maxAge = parseInt(config.maxAge) || 0;
      this.maxBytes = parseInt(config.maxBytes) || 0;
      this.storage = config.storage || 'file';
      this.replicas = parseInt(config.replicas) || 1;
      this.compression = !!config.compression;
    }

    let objectStore = null;
    const isDebug = config.debug || this.serverConfig.debug || false;

    // Helper: Get or create Object Store
    const getObjectStore = async () => {
      if (objectStore) return objectStore;
      
      try {
        const nc = await node.serverConfig.getConnection();
        const js = nc.jetstream();
        
        // Try to open existing bucket first
        try {
          objectStore = await js.views.os(node.bucket);
          return objectStore;
        } catch (err) {
          // Bucket doesn't exist, create it
          if (node.bucketConfig) {
            // Use bucket config node
            objectStore = await node.bucketConfig.getObjectStore();
          } else {
            // Use direct settings
            const createOptions = {
              description: node.description || undefined,
              max_bytes: node.maxBytes || undefined,
              max_age: node.maxAge * 1000 || undefined,
              storage: node.storage === 'memory' ? 'memory' : 'file',
              replicas: node.replicas,
              compression: node.compression
            };
            
            Object.keys(createOptions).forEach(key => {
              if (createOptions[key] === undefined) delete createOptions[key];
            });
            
            objectStore = await js.views.os(node.bucket, createOptions);
          }
          return objectStore;
        }
      } catch (err) {
        node.error(`Failed to get Object Store: ${err.message}`);
        throw err;
      }
    };

    // Bucket Management Operations
    const performBucketOperation = async (msg) => {
      try {
        const nc = await node.serverConfig.getConnection();
        const js = nc.jetstream();
        
        const operation = msg.operation || config.operation || 'put';
        const bucketName = msg.bucket || node.bucket || '';

        if (!bucketName && operation !== 'bucket-list') {
          node.error('Bucket name required for operation');
          return;
        }

        switch (operation) {
          case 'bucket-create': {
            const createOptions = {
              description: msg.description || node.description || undefined,
              max_bytes: msg.maxBytes ? parseInt(msg.maxBytes, 10) : (node.maxBytes || undefined),
              max_age: msg.maxAge ? parseInt(msg.maxAge, 10) * 1000 : (node.maxAge ? node.maxAge * 1000 : undefined),
              storage: msg.storage || node.storage === 'memory' ? 'memory' : 'file',
              replicas: msg.replicas ? parseInt(msg.replicas, 10) : (node.replicas || 1),
              compression: msg.compression !== undefined ? !!msg.compression : node.compression
            };

            Object.keys(createOptions).forEach(key => {
              if (createOptions[key] === undefined) delete createOptions[key];
            });

            await js.views.os(bucketName, createOptions);
            msg.payload = { operation: 'bucket-create', bucket: bucketName, success: true };
            node.status({ fill: 'green', shape: 'dot', text: `created: ${bucketName}` });
            break;
          }

          case 'bucket-info': {
            const os = await js.views.os(bucketName);
            const status = await os.status();
            msg.payload = {
              operation: 'bucket-info',
              bucket: bucketName,
              size: status.size || 0,
              objects: status.object_count || 0,
              deleted: status.deleted || 0
            };
            node.status({ fill: 'green', shape: 'dot', text: bucketName });
            break;
          }

          case 'bucket-delete': {
            const os = await js.views.os(bucketName);
            await os.destroy();
            msg.payload = { operation: 'bucket-delete', bucket: bucketName, success: true };
            node.status({ fill: 'green', shape: 'dot', text: `deleted: ${bucketName}` });
            break;
          }

          case 'bucket-list': {
            const buckets = [];
            // List all streams and filter Object Store buckets (they start with "OBJ_")
            const jsm = await nc.jetstreamManager();
            for await (const stream of jsm.streams.list()) {
              if (stream.config.name.startsWith('OBJ_')) {
                const bucketName = stream.config.name.replace('OBJ_', '');
                buckets.push({
                  name: bucketName,
                  objects: stream.state.messages || 0,
                  bytes: stream.state.bytes || 0
                });
              }
            }
            msg.payload = buckets;
            msg.operation = 'bucket-list';
            msg.count = buckets.length;
            node.status({ fill: 'green', shape: 'dot', text: `${buckets.length} buckets` });
            break;
          }

          default:
            node.error(`Unknown bucket operation: ${operation}`);
            return;
        }

        node.send(msg);
      } catch (err) {
        node.error(`Bucket operation failed: ${err.message}`, msg);
        msg.error = err.message;
        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });

    // Input handler
    node.on('input', async function (msg) {
      try {
        // Check if this is a bucket management operation
        const operation = msg.operation || config.operation || 'put';
        
        if (['bucket-create', 'bucket-info', 'bucket-delete', 'bucket-list'].includes(operation)) {
          await performBucketOperation(msg);
          return;
        }

        // Check if this is a delete operation
        if (operation === 'delete') {
          // Determine object name
          let objectName;
          if (config.nameFrom === 'config') {
            objectName = config.objectName;
          } else if (config.nameFrom === 'msg') {
            objectName = msg.objectName || msg.name;
          } else if (config.nameFrom === 'topic') {
            objectName = msg.topic;
          }

          if (!objectName) {
            node.error('No object name specified', msg);
            node.status({ fill: 'red', shape: 'ring', text: 'no name' });
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

          node.send(msg);
          node.status({ fill: 'green', shape: 'dot', text: `deleted: ${objectName}` });
          return;
        }

        // Default: put operation
        // Determine object name
        let objectName;
        if (config.nameFrom === 'config') {
          objectName = config.objectName;
        } else if (config.nameFrom === 'msg') {
          objectName = msg.objectName || msg.name;
        } else if (config.nameFrom === 'topic') {
          objectName = msg.topic;
        }

        if (!objectName) {
          node.error('No object name specified', msg);
          node.status({ fill: 'red', shape: 'ring', text: 'no name' });
          return;
        }

        const os = await getObjectStore();

        // Get data from payload
        let data;
        if (config.dataFrom === 'payload') {
          data = msg.payload;
        } else if (config.dataFrom === 'buffer') {
          data = Buffer.isBuffer(msg.payload) ? msg.payload : Buffer.from(String(msg.payload));
        } else if (config.dataFrom === 'file') {
          const fs = require('fs');
          const path = require('path');
          const filePath = msg.filePath || config.filePath;
          if (!filePath) {
            node.error('No file path specified', msg);
            return;
          }
          data = fs.readFileSync(filePath);
        }

        if (!data) {
          node.error('No data specified', msg);
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

        // Upload object
        const info = await os.put({
          name: objectName,
          description: metadata.description,
          headers: metadata
        }, data);

        if (isDebug) {
          node.log(`[OBJECT PUT] Upload successful - Name: ${objectName}, Size: ${info.size}, Chunks: ${info.chunks}`);
        }

        msg.info = info;
        msg.operation = 'PUT';
        msg.objectName = objectName;
        msg.bucket = node.bucket;
        msg.size = info.size;
        msg.chunks = info.chunks;
        
        node.send(msg);
        node.status({ fill: 'green', shape: 'dot', text: `put: ${objectName}` });
      } catch (err) {
        node.error(`Object Store PUT failed: ${err.message}`, msg);
        msg.error = err.message;
        msg.operation = 'PUT';
        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // Cleanup
    node.on('close', function () {
      this.serverConfig.removeConnectionUser(node.id);
    });
  }

  RED.nodes.registerType('nats-suite-object-put', NatsObjectPutNode);
};

