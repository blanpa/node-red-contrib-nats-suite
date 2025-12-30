'use strict';

const { StringCodec } = require('nats');

module.exports = function (RED) {
  function UnsStreamConsumerNode(config) {
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

    // Validate stream/consumer configuration
    if (!config.streamName) {
      node.error('Stream name is required');
      node.status({ fill: 'red', shape: 'ring', text: 'no stream' });
      return;
    }

    if (!config.consumerName) {
      node.error('Consumer name is required');
      node.status({ fill: 'red', shape: 'ring', text: 'no consumer' });
      return;
    }

    let jsClient = null;
    let consumer = null;
    let isConsuming = false;
    let isPaused = false; // Pause state
    const sc = StringCodec();

    // Output configuration
    const isDebug = !!config.debug;
    const parseMode = config.dataformat || 'auto';

    // Helper: Convert BigInt to Number safely
    const toNumber = value => {
      if (value === undefined || value === null) return 0;
      if (typeof value === 'bigint') return Number(value);
      return value;
    };

    // Helper: Parse duration string to nanoseconds
    const parseDuration = duration => {
      if (!duration) return 0;

      const match = duration.match(/^(\d+)([smhd])$/);
      if (!match) return 0;

      const [, num, unit] = match;
      const value = parseInt(num, 10);

      switch (unit) {
        case 's':
          return value * 1000000000;
        case 'm':
          return value * 60 * 1000000000;
        case 'h':
          return value * 3600 * 1000000000;
        case 'd':
          return value * 86400 * 1000000000;
        default:
          return 0;
      }
    };

    // Helper: Get or create consumer
    const ensureConsumer = async () => {
      try {
        const nc = await node.serverConfig.getConnection();
        jsClient = nc.jetstream();
        const jsm = await nc.jetstreamManager();

        // Check if stream exists
        try {
          await jsm.streams.info(config.streamName);
        } catch (err) {
          node.error(`Stream not found: ${config.streamName}`);
          node.status({ fill: 'red', shape: 'ring', text: 'stream not found' });
          return false;
        }

        // Configure consumer
        const consumerConfig = {
          durable_name: config.consumerName,
          ack_policy: config.ackPolicy || 'explicit',
          ack_wait: parseDuration(config.ackWait || '30s'),
          max_deliver: parseInt(config.maxDeliver, 10) || 5,
          max_ack_pending: parseInt(config.maxAckPending, 10) || 1000,
          deliver_policy: config.deliverPolicy || 'new',
          flow_control: !!config.flowControl,
        };

        // Only add idle_heartbeat for push-based consumers
        // Note: idle_heartbeat is only valid for push-based consumers
        // For pull-based consumers (default), this should not be set
        if (config.consumerType === 'push' && config.idleHeartbeat) {
          consumerConfig.idle_heartbeat = parseDuration(config.idleHeartbeat);
        }

        // Add filter subject if specified
        if (config.filterSubject) {
          consumerConfig.filter_subject = config.filterSubject;
        }

        // Add deliver policy specific options
        if (config.deliverPolicy === 'by_start_sequence') {
          consumerConfig.opt_start_seq =
            parseInt(config.startSequence, 10) || 1;
        } else if (config.deliverPolicy === 'by_start_time') {
          consumerConfig.opt_start_time =
            config.startTime || new Date().toISOString();
        }

        // Try to get existing consumer or create new one
        try {
          consumer = await jsClient.consumers.get(
            config.streamName,
            config.consumerName
          );
          node.log(`[STREAM CONSUMER] Consumer exists: ${config.consumerName}`);
        } catch (err) {
          // Consumer doesn't exist, create it
          if (err.message && err.message.includes('consumer not found')) {
            node.log(
              `[STREAM CONSUMER] Creating consumer: ${config.consumerName}`
            );
            await jsm.consumers.add(config.streamName, consumerConfig);
            consumer = await jsClient.consumers.get(
              config.streamName,
              config.consumerName
            );
            node.log(
              `[STREAM CONSUMER] Consumer created: ${config.consumerName}`
            );
          } else {
            throw err;
          }
        }

        node.status({
          fill: 'green',
          shape: 'dot',
          text: `${config.consumerName} (ready)`,
        });
        return true;
      } catch (err) {
        node.error(`Failed to ensure consumer: ${err.message}`);
        node.status({ fill: 'red', shape: 'ring', text: 'consumer error' });
        return false;
      }
    };

    // Helper: Process a single message
    const processMessage = async (msg, jetMsg) => {
      try {
        // Decode payload
        const data = sc.decode(jetMsg.data);

        if (isDebug) {
          node.log(
            `[STREAM CONSUMER] Processing message from subject: ${jetMsg.subject}`
          );
        }

        // Parse based on mode (same logic as subscribe node)
        let payload;

        switch (parseMode) {
          case 'auto':
            // Auto-detect: Try JSON, fallback to string
            if (typeof data === 'string' && data.trim().length > 0) {
              try {
                payload = JSON.parse(data);
                if (isDebug) {
                  node.log(`[STREAM CONSUMER] Parsed message as JSON`);
                }
              } catch (parseError) {
                // Keep as string (expected for non-JSON messages)
                payload = data;
                if (isDebug) {
                  node.log(
                    `[STREAM CONSUMER] Message kept as string (JSON parse failed)`
                  );
                }
              }
            } else {
              payload = data;
            }
            break;

          case 'json':
            // Force JSON parsing
            try {
              payload = JSON.parse(data);
              if (isDebug) {
                node.log(
                  `[STREAM CONSUMER] Parsed message as JSON (forced mode)`
                );
              }
            } catch (parseError) {
              if (isDebug) {
                node.log(
                  `[STREAM CONSUMER] JSON parsing failed: ${parseError.message}`
                );
              }
              node.error(
                {
                  message: 'JSON parsing failed',
                  code: 'JSON_PARSE_ERROR',
                  originalError: parseError.message,
                },
                {
                  topic: jetMsg.subject,
                  rawData: data,
                }
              );
              return; // Stop processing on error
            }
            break;

          case 'string':
            // Keep as string
            if (isDebug) {
              node.log(`[STREAM CONSUMER] Message kept as string`);
            }
            payload = data;
            break;

          case 'buffer':
            // Keep as buffer
            if (isDebug) {
              node.log(`[STREAM CONSUMER] Message kept as buffer`);
            }
            payload = jetMsg.data;
            break;

          default:
            // Fallback to auto behavior
            try {
              payload = JSON.parse(data);
            } catch (e) {
              payload = data;
            }
            break;
        }

        // Build output message
        const outMsg = {
          payload: payload,
          stream: jetMsg.info.stream,
          consumer: jetMsg.info.consumer,
          subject: jetMsg.subject,
          sequence: toNumber(jetMsg.seq),
          timestamp: Date.now(),
          redelivered: jetMsg.info.redelivered || false,
          pending: toNumber(jetMsg.info.pending) || 0,
        };

        // Add headers if present
        if (jetMsg.headers) {
          const headers = {};
          for (const [key, values] of jetMsg.headers) {
            headers[key] = values.length === 1 ? values[0] : values;
          }
          outMsg.headers = headers;
        }

        // Add acknowledgment functions based on policy
        if (config.ackPolicy === 'explicit') {
          outMsg.ack = () => {
            try {
              jetMsg.ack();
              node.log(`[STREAM CONSUMER] ACK: seq ${jetMsg.seq}`);
            } catch (err) {
              node.warn(`Failed to ACK message: ${err.message}`);
            }
          };

          outMsg.nak = delay => {
            try {
              if (delay) {
                jetMsg.nak(delay);
              } else {
                jetMsg.nak();
              }
              node.log(`[STREAM CONSUMER] NAK: seq ${jetMsg.seq}`);
            } catch (err) {
              node.warn(`Failed to NAK message: ${err.message}`);
            }
          };

          outMsg.term = () => {
            try {
              jetMsg.term();
              node.log(`[STREAM CONSUMER] TERM: seq ${jetMsg.seq}`);
            } catch (err) {
              node.warn(`Failed to TERM message: ${err.message}`);
            }
          };

          outMsg.inProgress = () => {
            try {
              jetMsg.working();
              node.log(`[STREAM CONSUMER] IN-PROGRESS: seq ${jetMsg.seq}`);
            } catch (err) {
              node.warn(`Failed to mark in-progress: ${err.message}`);
            }
          };
        } else if (config.ackPolicy === 'all') {
          // Auto-acknowledge
          jetMsg.ack();
        }
        // 'none' policy doesn't require acknowledgment

        // Send message
        if (isDebug) {
          node.log(
            `[STREAM CONSUMER] Sending output message for seq ${jetMsg.seq}`
          );
        }
        node.send(outMsg);

        // Update status
        const pending = toNumber(jetMsg.info.pending) || 0;
        node.status({
          fill: 'blue',
          shape: 'dot',
          text: `${config.consumerName} (${pending} pending)`,
        });
      } catch (err) {
        node.error(`Error processing message: ${err.message}`, msg);
      }
    };

    // Helper: Consume messages
    const consumeMessages = async (batchSize = 1) => {
      if (!consumer || isConsuming || isPaused) return;

      try {
        isConsuming = true;

        const maxWait = parseInt(config.maxWait, 10) || 1000;
        const batch =
          parseInt(batchSize, 10) || parseInt(config.batchSize, 10) || 1;

        node.log(
          `[STREAM CONSUMER] Fetching ${batch} messages (max wait: ${maxWait}ms)`
        );

        // Fetch messages
        const messages = await consumer.fetch({
          max_messages: batch,
          expires: maxWait,
        });

        let count = 0;
        for await (const msg of messages) {
          // Check if paused during iteration
          if (isPaused) {
            node.log(`[STREAM CONSUMER] Paused during consumption`);
            break;
          }
          await processMessage({}, msg);
          count++;
        }

        if (count > 0) {
          node.log(`[STREAM CONSUMER] Processed ${count} messages`);
        } else if (!isPaused) {
          node.status({
            fill: 'green',
            shape: 'ring',
            text: `${config.consumerName} (idle)`,
          });
        }
      } catch (err) {
        if (err.message && !err.message.includes('timeout')) {
          node.error(`Consume error: ${err.message}`);
          node.status({ fill: 'red', shape: 'ring', text: 'consume error' });
        }
      } finally {
        isConsuming = false;
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Initialize consumer
    ensureConsumer();

    // Status listener for connection changes
    const statusListener = statusInfo => {
      const status = statusInfo.status || statusInfo;

      switch (status) {
        case 'connected':
          // Re-ensure consumer on reconnect
          ensureConsumer();
          break;
        case 'disconnected':
          node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
          consumer = null;
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

        const operation = msg.operation || config.operation || 'consume';
        const streamName = msg.stream || config.streamName || '';

        if (!streamName) {
          node.error('Stream name required for operation');
          return;
        }

        switch (operation) {
          case 'info': {
            const streamInfo = await jsm.streams.info(streamName);
            msg.payload = {
              operation: 'info',
              stream: streamName,
              config: streamInfo.config,
              state: streamInfo.state,
            };
            node.status({ fill: 'green', shape: 'dot', text: streamName });
            break;
          }

          case 'delete': {
            await jsm.streams.delete(streamName);
            msg.payload = {
              operation: 'delete',
              stream: streamName,
              success: true,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `deleted: ${streamName}`,
            });
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
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `purged: ${streamName}`,
            });
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
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    };

    // Consumer Management Operations
    const performConsumerOperation = async msg => {
      try {
        const nc = await node.serverConfig.getConnection();
        const jsm = await nc.jetstreamManager();

        const operation = msg.operation || config.operation || 'consume';
        const streamName = msg.stream || config.streamName || '';
        const consumerName = msg.consumer || config.consumerName || '';

        if (!streamName && operation !== 'list') {
          node.error('Stream name required for consumer operation');
          return;
        }

        if (!consumerName && operation !== 'list' && operation !== 'create') {
          node.error('Consumer name required for operation');
          return;
        }

        switch (operation) {
          case 'create':
          case 'add': {
            const consumerConfig = msg.config || {
              durable_name: consumerName || config.consumerName,
              deliver_subject: msg.deliverSubject,
              deliver_policy:
                msg.deliverPolicy || config.deliverPolicy || 'all',
              ack_policy: msg.ackPolicy || config.ackPolicy || 'explicit',
              max_deliver: msg.maxDeliver
                ? parseInt(msg.maxDeliver, 10)
                : config.maxDeliver
                  ? parseInt(config.maxDeliver, 10)
                  : -1,
              filter_subject: msg.filterSubject || config.filterSubject,
              ack_wait: msg.ackWait
                ? parseDuration(msg.ackWait)
                : config.ackWait
                  ? parseDuration(config.ackWait)
                  : undefined,
              max_ack_pending: msg.maxAckPending
                ? parseInt(msg.maxAckPending, 10)
                : config.maxAckPending
                  ? parseInt(config.maxAckPending, 10)
                  : undefined,
              flow_control:
                msg.flowControl !== undefined
                  ? !!msg.flowControl
                  : config.flowControl !== undefined
                    ? !!config.flowControl
                    : undefined,
            };

            // Remove undefined values
            Object.keys(consumerConfig).forEach(key => {
              if (consumerConfig[key] === undefined) delete consumerConfig[key];
            });

            const createdConsumer = await jsm.consumers.add(
              streamName,
              consumerConfig
            );
            msg.payload = {
              operation: 'create',
              consumer: createdConsumer.name,
              success: true,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `created: ${createdConsumer.name}`,
            });
            break;
          }

          case 'info': {
            const consumerInfo = await jsm.consumers.info(
              streamName,
              consumerName
            );
            msg.payload = {
              operation: 'info',
              stream: streamName,
              consumer: consumerName,
              config: consumerInfo.config,
              delivered: consumerInfo.delivered,
              ack_pending: consumerInfo.ack_pending,
            };
            node.status({ fill: 'green', shape: 'dot', text: consumerName });
            break;
          }

          case 'delete': {
            await jsm.consumers.delete(streamName, consumerName);
            msg.payload = {
              operation: 'delete',
              consumer: consumerName,
              success: true,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `deleted: ${consumerName}`,
            });
            break;
          }

          case 'list': {
            const consumers = [];
            for await (const consumer of jsm.consumers.list(streamName)) {
              consumers.push({
                name: consumer.name,
                stream: streamName,
                config: consumer.config,
              });
            }
            msg.payload = consumers;
            msg.operation = 'list';
            msg.count = consumers.length;
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `${consumers.length} consumers`,
            });
            break;
          }

          case 'pause': {
            // Pause consumer (local operation - stops fetching new messages)
            isPaused = true;
            msg.payload = {
              operation: 'pause',
              consumer: consumerName,
              success: true,
              paused: true,
            };
            node.status({
              fill: 'yellow',
              shape: 'ring',
              text: `${consumerName} (paused)`,
            });
            node.log(`[STREAM CONSUMER] Consumer paused: ${consumerName}`);
            break;
          }

          case 'resume': {
            // Resume consumer (local operation - starts fetching messages again)
            isPaused = false;
            msg.payload = {
              operation: 'resume',
              consumer: consumerName,
              success: true,
              paused: false,
            };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `${consumerName} (resumed)`,
            });
            node.log(`[STREAM CONSUMER] Consumer resumed: ${consumerName}`);
            break;
          }

          case 'monitor': {
            // Get detailed consumer monitoring stats
            const consumerInfo = await jsm.consumers.info(
              streamName,
              consumerName
            );

            // Calculate additional stats
            const pending = consumerInfo.num_pending || 0;
            const delivered = consumerInfo.delivered
              ? consumerInfo.delivered.stream_seq
              : 0;
            const ackPending = consumerInfo.num_ack_pending || 0;
            const redelivered = consumerInfo.num_redelivered || 0;
            const waiting = consumerInfo.num_waiting || 0;

            // Calculate delivery rate (messages/sec) if timestamps available
            let deliveryRate = 0;
            if (consumerInfo.delivered && consumerInfo.delivered.last_active) {
              const lastActive = new Date(
                consumerInfo.delivered.last_active
              ).getTime();
              const now = Date.now();
              const secondsSinceActive = (now - lastActive) / 1000;
              if (secondsSinceActive > 0 && delivered > 0) {
                deliveryRate = (delivered / secondsSinceActive).toFixed(2);
              }
            }

            msg.payload = {
              operation: 'monitor',
              stream: streamName,
              consumer: consumerName,
              stats: {
                pending: pending,
                delivered: delivered,
                ack_pending: ackPending,
                redelivered: redelivered,
                waiting: waiting,
                delivery_rate: parseFloat(deliveryRate),
                paused: isPaused,
              },
              config: consumerInfo.config,
              timestamp: Date.now(),
            };

            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `${consumerName} (${pending}p/${ackPending}ap)`,
            });

            node.log(
              `[STREAM CONSUMER] Monitor: pending=${pending}, ack_pending=${ackPending}, delivered=${delivered}`
            );
            break;
          }

          default:
            node.error(`Unknown consumer operation: ${operation}`);
            return;
        }

        node.send(msg);
      } catch (err) {
        node.error(`Consumer operation failed: ${err.message}`, msg);
        msg.error = err.message;
        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    };

    // Input handler - trigger message consumption, stream management, or consumer management
    node.on('input', async function (msg) {
      try {
        // Check if this is a stream management or consumer management operation
        const operation = msg.operation || config.operation || 'consume';

        // Stream management operations
        if (
          ['info', 'delete', 'purge'].includes(operation) &&
          !msg.consumer &&
          !config.consumerName
        ) {
          await performStreamOperation(msg);
          return;
        }

        // Consumer management operations
        if (['create', 'add', 'info', 'delete', 'list'].includes(operation)) {
          await performConsumerOperation(msg);
          return;
        }

        // Default: consume messages
        if (operation !== 'consume') {
          node.error(`Unknown operation: ${operation}`);
          return;
        }

        // Ensure consumer is ready
        if (!consumer) {
          const ready = await ensureConsumer();
          if (!ready) {
            node.error('Consumer not ready', msg);
            return;
          }
        }

        // Determine batch size (from msg or config)
        const batchSize = msg.batchSize || config.batchSize || 1;

        // Consume messages
        await consumeMessages(batchSize);
      } catch (err) {
        node.error(`Consumer error: ${err.message}`, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // Cleanup on close
    node.on('close', async function () {
      this.serverConfig.removeStatusListener(statusListener);
      this.serverConfig.unregisterConnectionUser(node.id);

      // Don't delete the consumer - it's durable and should persist
      consumer = null;
      jsClient = null;
      node.status({});
    });
  }

  RED.nodes.registerType('nats-suite-stream-consumer', UnsStreamConsumerNode);
};
