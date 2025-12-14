'use strict';

const { StringCodec, headers: natsHeaders } = require('nats');

module.exports = function (RED) {
  function UnsStreamPublisherNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Validate server configuration
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

    // Validate stream configuration
    if (!config.streamName) {
      node.error('Stream name is required');
      node.status({ fill: 'red', shape: 'ring', text: 'no stream' });
      return;
    }

    let jsClient = null;
    let streamInfo = null;
    const sc = StringCodec();

    // Helper: Update node status based on connection state
    const updateConnectionStatus = () => {
      const currentStatus = node.serverConfig.connectionStatus;
      if (currentStatus === 'connected') {
        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
      } else if (currentStatus === 'disconnected') {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      } else if (currentStatus === 'connecting') {
        node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
      }
    };

    // Helper: Parse duration string to nanoseconds (e.g., "24h" -> nanoseconds)
    const parseDuration = duration => {
      if (!duration) return 0;

      const match = duration.match(/^(\d+)([smhd])$/);
      if (!match) return 0;

      const [, num, unit] = match;
      const value = parseInt(num, 10);

      switch (unit) {
        case 's':
          return value * 1000000000; // seconds to nanoseconds
        case 'm':
          return value * 60 * 1000000000; // minutes
        case 'h':
          return value * 3600 * 1000000000; // hours
        case 'd':
          return value * 86400 * 1000000000; // days
        default:
          return 0;
      }
    };

    // Helper: Get or create stream
    const ensureStream = async () => {
      try {
        const nc = await node.serverConfig.getConnection();
        jsClient = nc.jetstream();
        const jsm = await nc.jetstreamManager();

        // Try to get existing stream
        try {
          streamInfo = await jsm.streams.info(config.streamName);
          node.log(`[STREAM PUB] Stream exists: ${config.streamName}`);
          return true;
        } catch (err) {
          // Stream doesn't exist, create it
          if (err.message && err.message.includes('stream not found')) {
            node.log(`[STREAM PUB] Creating stream: ${config.streamName}`);

            const streamConfig = {
              name: config.streamName,
              subjects: [config.subjectPattern || '*'],
              retention: config.retention || 'limits',
              storage: config.storage === 'memory' ? 'memory' : 'file',
              max_msgs: parseInt(config.maxMessages, 10) || 10000,
              max_bytes: parseInt(config.maxBytes, 10) || 10485760, // 10MB
              max_age: parseDuration(config.maxAge || '24h'),
              duplicate_window: parseDuration(config.duplicateWindow || '2m'),
              num_replicas: parseInt(config.replicas, 10) || 1,
              discard: 'old', // Discard old messages when limits reached
            };

            await jsm.streams.add(streamConfig);
            streamInfo = await jsm.streams.info(config.streamName);

            node.log(`[STREAM PUB] Stream created: ${config.streamName}`);

            // Show creation status for 2 seconds
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `stream ${config.streamName} created`,
            });

            // Revert to connection status after 2 seconds
            setTimeout(() => {
              updateConnectionStatus();
            }, 2000);

            return true;
          }
          throw err;
        }
      } catch (err) {
        node.error(`Failed to ensure stream: ${err.message}`);
        return false;
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Initialize stream
    ensureStream();

    // Status listener for connection changes
    const statusListener = statusInfo => {
      const status = statusInfo.status || statusInfo;

      switch (status) {
        case 'connected':
          node.status({ fill: 'green', shape: 'dot', text: 'connected' });
          // Re-ensure stream on reconnect
          ensureStream();
          break;
        case 'disconnected':
          node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
          jsClient = null;
          break;
        case 'connecting':
          node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
          break;
      }
    };

    this.serverConfig.addStatusListener(statusListener);

    // Stream Management Operations
    const performStreamOperation = async msg => {
      try {
        const nc = await node.serverConfig.getConnection();
        const js = nc.jetstream();
        const jsm = await nc.jetstreamManager();

        const operation = msg.operation || config.operation || 'publish';
        const streamName = msg.stream || config.streamName || '';

        if (!streamName && operation !== 'list') {
          node.error('Stream name required for operation');
          return;
        }

        switch (operation) {
          case 'create': {
            // Accept full stream config from msg.payload or build from individual properties
            let streamConfig;

            if (
              msg.payload &&
              typeof msg.payload === 'object' &&
              msg.payload.name
            ) {
              // Use msg.payload as full stream config (NATS native format)
              streamConfig = { ...msg.payload };
              node.log(
                `[STREAM PUB] Creating stream from payload config: ${streamConfig.name}`
              );
            } else {
              // Build config from individual msg/node properties (legacy support)
              const targetStreamName = msg.stream || streamName;
              streamConfig = {
                name: targetStreamName,
                subjects: msg.subjects
                  ? Array.isArray(msg.subjects)
                    ? msg.subjects
                    : msg.subjects.split(',').map(s => s.trim())
                  : [config.subjectPattern || targetStreamName + '.>'],
                retention: msg.retention || config.retention || 'limits',
                storage:
                  msg.storage ||
                  (config.storage === 'memory' ? 'memory' : 'file'),
                max_msgs:
                  msg.maxMessages !== undefined
                    ? parseInt(msg.maxMessages, 10)
                    : config.maxMessages !== undefined
                      ? parseInt(config.maxMessages, 10)
                      : -1,
                max_bytes:
                  msg.maxBytes !== undefined
                    ? parseInt(msg.maxBytes, 10)
                    : config.maxBytes !== undefined
                      ? parseInt(config.maxBytes, 10)
                      : -1,
                max_age: msg.maxAge
                  ? parseDuration(msg.maxAge)
                  : config.maxAge
                    ? parseDuration(config.maxAge)
                    : parseDuration('24h'),
                duplicate_window: msg.duplicateWindow
                  ? parseDuration(msg.duplicateWindow)
                  : config.duplicateWindow
                    ? parseDuration(config.duplicateWindow)
                    : parseDuration('2m'),
                num_replicas:
                  msg.replicas !== undefined
                    ? parseInt(msg.replicas, 10)
                    : config.replicas !== undefined
                      ? parseInt(config.replicas, 10)
                      : 1,
                discard: msg.discard || config.discard || 'old',
                // Extended NATS config options
                max_consumers:
                  msg.maxConsumers !== undefined
                    ? parseInt(msg.maxConsumers, 10)
                    : config.maxConsumers !== undefined
                      ? parseInt(config.maxConsumers, 10)
                      : -1,
                max_msgs_per_subject:
                  msg.maxMsgsPerSubject !== undefined
                    ? parseInt(msg.maxMsgsPerSubject, 10)
                    : config.maxMsgsPerSubject !== undefined
                      ? parseInt(config.maxMsgsPerSubject, 10)
                      : -1,
                max_msg_size:
                  msg.maxMsgSize !== undefined
                    ? parseInt(msg.maxMsgSize, 10)
                    : config.maxMsgSize !== undefined
                      ? parseInt(config.maxMsgSize, 10)
                      : -1,
                compression: msg.compression || config.compression || 'none',
                allow_direct:
                  msg.allowDirect !== undefined
                    ? msg.allowDirect
                    : config.allowDirect || false,
                mirror_direct:
                  msg.mirrorDirect !== undefined
                    ? msg.mirrorDirect
                    : config.mirrorDirect || false,
                sealed:
                  msg.sealed !== undefined
                    ? msg.sealed
                    : config.sealed || false,
                deny_delete:
                  msg.denyDelete !== undefined
                    ? msg.denyDelete
                    : config.denyDelete || false,
                deny_purge:
                  msg.denyPurge !== undefined
                    ? msg.denyPurge
                    : config.denyPurge || false,
                allow_rollup_hdrs:
                  msg.allowRollupHdrs !== undefined
                    ? msg.allowRollupHdrs
                    : config.allowRollupHdrs || false,
                allow_msg_ttl:
                  msg.allowMsgTtl !== undefined
                    ? msg.allowMsgTtl
                    : config.allowMsgTtl || false,
              };
              node.log(
                `[STREAM PUB] Creating stream from properties: ${streamConfig.name}`
              );
            }

            // Create the stream
            const createdStream = await jsm.streams.add(streamConfig);

            // Return full status with config and state
            msg.payload = {
              operation: 'create',
              success: true,
              stream: createdStream.config.name,
              config: createdStream.config,
              state: createdStream.state,
              created: createdStream.created,
            };
            node.log(
              `[STREAM PUB] Stream created successfully: ${createdStream.config.name}`
            );

            // Show creation status for 2 seconds
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `stream ${createdStream.config.name} created`,
            });

            // Revert to connection status after 2 seconds
            setTimeout(() => {
              updateConnectionStatus();
            }, 2000);

            break;
          }

          case 'update': {
            // Accept full stream config from msg.payload or build from individual properties
            let streamConfig;
            const targetStreamName =
              msg.payload?.name || msg.stream || streamName;

            // Get current stream config first
            const currentStream = await jsm.streams.info(targetStreamName);

            if (
              msg.payload &&
              typeof msg.payload === 'object' &&
              msg.payload.name
            ) {
              // Merge msg.payload with current config (NATS native format)
              streamConfig = { ...currentStream.config, ...msg.payload };
              node.log(
                `[STREAM PUB] Updating stream from payload config: ${streamConfig.name}`
              );
            } else {
              // Build config from individual msg/node properties (legacy support)
              streamConfig = {
                ...currentStream.config,
                subjects: msg.subjects
                  ? Array.isArray(msg.subjects)
                    ? msg.subjects
                    : msg.subjects.split(',').map(s => s.trim())
                  : currentStream.config.subjects,
                retention: msg.retention || currentStream.config.retention,
                max_msgs:
                  msg.maxMessages !== undefined
                    ? parseInt(msg.maxMessages, 10)
                    : currentStream.config.max_msgs,
                max_bytes:
                  msg.maxBytes !== undefined
                    ? parseInt(msg.maxBytes, 10)
                    : currentStream.config.max_bytes,
                max_age: msg.maxAge
                  ? parseDuration(msg.maxAge)
                  : currentStream.config.max_age,
                duplicate_window: msg.duplicateWindow
                  ? parseDuration(msg.duplicateWindow)
                  : currentStream.config.duplicate_window,
                num_replicas:
                  msg.replicas !== undefined
                    ? parseInt(msg.replicas, 10)
                    : currentStream.config.num_replicas,
                discard: msg.discard || currentStream.config.discard,
                // Extended NATS config options
                max_consumers:
                  msg.maxConsumers !== undefined
                    ? parseInt(msg.maxConsumers, 10)
                    : currentStream.config.max_consumers,
                max_msgs_per_subject:
                  msg.maxMsgsPerSubject !== undefined
                    ? parseInt(msg.maxMsgsPerSubject, 10)
                    : currentStream.config.max_msgs_per_subject,
                max_msg_size:
                  msg.maxMsgSize !== undefined
                    ? parseInt(msg.maxMsgSize, 10)
                    : currentStream.config.max_msg_size,
                compression:
                  msg.compression || currentStream.config.compression,
                allow_direct:
                  msg.allowDirect !== undefined
                    ? msg.allowDirect
                    : currentStream.config.allow_direct,
                mirror_direct:
                  msg.mirrorDirect !== undefined
                    ? msg.mirrorDirect
                    : currentStream.config.mirror_direct,
                sealed:
                  msg.sealed !== undefined
                    ? msg.sealed
                    : currentStream.config.sealed,
                deny_delete:
                  msg.denyDelete !== undefined
                    ? msg.denyDelete
                    : currentStream.config.deny_delete,
                deny_purge:
                  msg.denyPurge !== undefined
                    ? msg.denyPurge
                    : currentStream.config.deny_purge,
                allow_rollup_hdrs:
                  msg.allowRollupHdrs !== undefined
                    ? msg.allowRollupHdrs
                    : currentStream.config.allow_rollup_hdrs,
                allow_msg_ttl:
                  msg.allowMsgTtl !== undefined
                    ? msg.allowMsgTtl
                    : currentStream.config.allow_msg_ttl,
              };
              node.log(
                `[STREAM PUB] Updating stream from properties: ${streamConfig.name}`
              );
            }

            // Update the stream
            const updatedStream = await jsm.streams.update(
              targetStreamName,
              streamConfig
            );

            // Return full status with config and state
            msg.payload = {
              operation: 'update',
              success: true,
              stream: updatedStream.config.name,
              config: updatedStream.config,
              state: updatedStream.state,
            };
            node.log(
              `[STREAM PUB] Stream updated successfully: ${updatedStream.config.name}`
            );
            break;
          }

          case 'update-subjects': {
            // Update stream subjects only (without changing other config)
            const currentStream = await jsm.streams.info(streamName);
            const updatedConfig = {
              ...currentStream.config,
              subjects: msg.subjects
                ? msg.subjects.split(',').map(s => s.trim())
                : currentStream.config.subjects,
            };

            await jsm.streams.update(streamName, updatedConfig);
            msg.payload = {
              operation: 'update-subjects',
              stream: streamName,
              subjects: updatedConfig.subjects,
              success: true,
            };
            node.log(
              `[STREAM PUB] Updated subjects for ${streamName}: ${updatedConfig.subjects.join(', ')}`
            );
            break;
          }

          case 'info': {
            const targetStreamName =
              msg.payload?.name || msg.stream || streamName;
            const info = await jsm.streams.info(targetStreamName);
            msg.payload = {
              operation: 'info',
              success: true,
              stream: targetStreamName,
              config: info.config,
              state: info.state,
              created: info.created,
              cluster: info.cluster,
              mirror: info.mirror,
              sources: info.sources,
            };
            break;
          }

          case 'delete': {
            await jsm.streams.delete(streamName);
            msg.payload = {
              operation: 'delete',
              stream: streamName,
              success: true,
            };
            break;
          }

          case 'purge': {
            const stream = await js.streams.get(streamName);
            await stream.purge();
            msg.payload = {
              operation: 'purge',
              stream: streamName,
              success: true,
            };
            break;
          }

          case 'list': {
            const streams = [];
            for await (const stream of js.streams.list()) {
              streams.push({
                name: stream.config.name,
                subjects: stream.config.subjects,
                messages: stream.state.messages,
                bytes: stream.state.bytes,
              });
            }
            msg.payload = streams;
            msg.operation = 'list';
            msg.count = streams.length;
            break;
          }

          default:
            node.error(`Unknown operation: ${operation}`);
            return;
        }

        node.send(msg);
      } catch (err) {
        node.error(`Stream operation failed: ${err.message}`, msg);
        msg.error = err.message;
        node.send(msg);
      }
    };

    // Input handler
    node.on('input', async function (msg) {
      try {
        // Check if this is a stream management operation
        const operation = msg.operation || config.operation || 'publish';

        if (operation !== 'publish') {
          await performStreamOperation(msg);
          return;
        }

        // Ensure we have a JetStream client
        if (!jsClient) {
          const ready = await ensureStream();
          if (!ready) {
            node.error('Stream not ready', msg);
            return;
          }
        }

        // Determine subject
        let subject = msg.subject || config.defaultSubject;
        if (!subject) {
          node.error(
            'No subject specified (use msg.subject or configure default subject)',
            msg
          );
          return;
        }

        // Prepare payload
        let payload;
        if (typeof msg.payload === 'object') {
          payload = JSON.stringify(msg.payload);
        } else {
          payload = String(msg.payload);
        }

        // Prepare headers if provided
        let msgHeaders;
        if (msg.headers && typeof msg.headers === 'object') {
          msgHeaders = natsHeaders();
          Object.keys(msg.headers).forEach(key => {
            msgHeaders.append(key, String(msg.headers[key]));
          });
        }

        // Publish to stream
        const pubAck = await jsClient.publish(subject, sc.encode(payload), {
          headers: msgHeaders,
          msgID: msg._msgID || undefined, // Optional message ID for deduplication
        });

        // Update message with publish info
        msg.stream = pubAck.stream;
        msg.sequence = pubAck.seq;
        msg.published = true;
        msg.subject = subject;
        msg._duplicate = pubAck.duplicate || false;

        // Send message to output
        node.send(msg);

        // Periodically update stream info (every 100 messages)
        if (pubAck.seq % 100 === 0) {
          ensureStream(); // Refresh stats
        }
      } catch (err) {
        msg.published = false;
        msg.error = err.message;

        node.error(`Stream publish error: ${err.message}`, msg);

        // Send error message to output
        node.send(msg);
      }
    });

    // Cleanup on close
    node.on('close', function () {
      this.serverConfig.removeStatusListener(statusListener);
      this.serverConfig.unregisterConnectionUser(node.id);
      jsClient = null;
      streamInfo = null;
      node.status({});
    });
  }

  RED.nodes.registerType('nats-suite-stream-publisher', UnsStreamPublisherNode);
};
