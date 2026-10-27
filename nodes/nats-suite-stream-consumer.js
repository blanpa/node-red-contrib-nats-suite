'use strict';

const {
  JetStreamApiCodes,
  JetStreamApiError,
  jetstream,
  jetstreamManager,
} = require('@nats-io/jetstream');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');
const { fromMsg } = require('../lib/payload');
const { parseDuration } = require('../lib/duration');

module.exports = function (RED) {
  function NatsStreamConsumerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.serverConfig = resolveServer(RED, node, config);
    if (!this.serverConfig) return;

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
    let jsm = null;
    let consumer = null;
    let isConsuming = false;
    let isPaused = false; // Pause state
    let idleTimeout = null; // Timer for idle status
    let fetchTask = null;
    let activeMessages = null;
    let closing = false;
    let lastStatusText = '';

    const setGreenStatus = (text, shape = 'dot') => {
      if (node.serverConfig.connectionStatus !== 'connected') return false;
      node.status({ fill: 'green', shape, text });
      return true;
    };

    // Output configuration
    const isDebug = !!config.debug;
    const parseMode = config.dataformat || 'auto';

    // Helper: Convert BigInt to Number safely
    const toNumber = value => {
      if (value === undefined || value === null) return 0;
      if (typeof value === 'bigint') return Number(value);
      return value;
    };

    // Builds the PriorityGroups fields (priority_groups/priority_policy/
    // priority_timeout) shared by both consumer-creation paths below.
    // priority_timeout is nanoseconds (Nanos = number), same unit as
    // ack_wait/max_age elsewhere in this codebase, so it reuses the same
    // parseDuration() helper - unlike KV's markerTTL (a different Step-8
    // bullet), which is a raw Go-duration string passed straight through.
    const buildPriorityFields = ({ groups, policy, timeout }) => {
      const fields = {};
      if (groups) {
        const list = String(groups)
          .split(',')
          .map(g => g.trim())
          .filter(Boolean);
        if (list.length) fields.priority_groups = list;
      }
      if (policy && policy !== 'none') fields.priority_policy = policy;
      if (timeout) {
        const nanos = parseDuration(timeout);
        if (nanos) fields.priority_timeout = nanos;
      }
      return fields;
    };

    // Helper: Acquire the JetStream client + manager once and cache them. The
    // connection object is stable across native reconnects, so there is no
    // need to re-derive these on every reconnect.
    const ensureJetStream = async () => {
      if (jsClient && jsm) return;
      const nc = await node.serverConfig.getConnection();
      jsClient = jetstream(nc);
      jsm = await jetstreamManager(nc);
    };

    // Helper: Get or create consumer
    const ensureConsumer = async () => {
      try {
        await ensureJetStream();

        // Check if stream exists
        try {
          await jsm.streams.info(config.streamName);
        } catch (err) {
          if (
            err instanceof JetStreamApiError &&
            err.code === JetStreamApiCodes.StreamNotFound
          ) {
            node.status({
              fill: 'red',
              shape: 'ring',
              text: 'stream not found',
            });
            throw new Error(`Stream not found: ${config.streamName}`, {
              cause: err,
            });
          }
          throw err;
        }

        const createOnInit = config.createOnInit !== false;

        // Try to get existing consumer first
        try {
          consumer = await jsClient.consumers.get(
            config.streamName,
            config.consumerName
          );
          if (isDebug) {
            node.log(
              `[STREAM CONSUMER] Consumer exists: ${config.consumerName}`
            );
          }
        } catch (err) {
          // Consumer doesn't exist
          if (
            err instanceof JetStreamApiError &&
            err.code === JetStreamApiCodes.ConsumerNotFound
          ) {
            if (createOnInit) {
              // Configure consumer
              const consumerConfig = {
                durable_name: config.consumerName,
                ack_policy: config.ackPolicy || 'explicit',
                ack_wait: parseDuration(config.ackWait || '30s'),
                max_deliver: parseInt(config.maxDeliver, 10) || 5,
                max_ack_pending: parseInt(config.maxAckPending, 10) || 1000,
                deliver_policy: config.deliverPolicy || 'new',
                ...buildPriorityFields({
                  groups: config.priorityGroups,
                  policy: config.priorityPolicy,
                  timeout: config.priorityTimeout,
                }),
              };

              // ConsumerConfig.idle_heartbeat and flow_control both require a
              // push-based consumer (verified against a real nats-server:
              // "consumer idle heartbeat requires a push based consumer");
              // this node is pull-only, so neither is ever set.

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

              if (isDebug) {
                node.log(
                  `[STREAM CONSUMER] Creating consumer: ${config.consumerName}`
                );
              }
              // pedantic is a separate 3rd argument (ConsumerCreateOptions),
              // not a field on the consumer config itself.
              await jsm.consumers.add(config.streamName, consumerConfig, {
                pedantic: !!config.pedantic,
              });
              consumer = await jsClient.consumers.get(
                config.streamName,
                config.consumerName
              );
              if (isDebug) {
                node.log(
                  `[STREAM CONSUMER] Consumer created: ${config.consumerName}`
                );
              }
            } else {
              // createOnInit is disabled, consumer must exist
              node.status({
                fill: 'red',
                shape: 'ring',
                text: 'consumer not found',
              });
              throw new Error(
                `Consumer not found: ${config.consumerName}. Enable "Create Consumer on initialization" or create the consumer manually.`,
                { cause: err }
              );
            }
          } else {
            throw err;
          }
        }

        setGreenStatus(`${config.consumerName} (ready)`);
        return true;
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'consumer error' });
        throw err;
      }
    };

    // Helper: Process a single message
    const processMessage = async (send, jetMsg) => {
      try {
        if (isDebug) {
          node.log(
            `[STREAM CONSUMER] Processing message from subject: ${jetMsg.subject}`
          );
        }

        // Parse based on mode (shared with the subscribe node's decoder)
        let payload;
        try {
          payload = fromMsg(jetMsg, parseMode);
        } catch (parseError) {
          // Only forced 'json' mode can throw here (see lib/payload.js).
          if (isDebug) {
            node.log(
              `[STREAM CONSUMER] JSON parsing failed: ${parseError.message}`
            );
          }
          const err = new Error('JSON parsing failed', { cause: parseError });
          err.code = 'JSON_PARSE_ERROR';
          err.rawData = jetMsg.data;
          throw err;
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
          redelivery_count: toNumber(jetMsg.info.redeliveryCount) || 0,
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
              if (isDebug) {
                node.log(`[STREAM CONSUMER] ACK: seq ${jetMsg.seq}`);
              }
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
              if (isDebug) {
                node.log(`[STREAM CONSUMER] NAK: seq ${jetMsg.seq}`);
              }
            } catch (err) {
              node.warn(`Failed to NAK message: ${err.message}`);
            }
          };

          outMsg.term = () => {
            try {
              jetMsg.term();
              if (isDebug) {
                node.log(`[STREAM CONSUMER] TERM: seq ${jetMsg.seq}`);
              }
            } catch (err) {
              node.warn(`Failed to TERM message: ${err.message}`);
            }
          };

          outMsg.inProgress = () => {
            try {
              jetMsg.working();
              if (isDebug) {
                node.log(`[STREAM CONSUMER] IN-PROGRESS: seq ${jetMsg.seq}`);
              }
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
        send(outMsg);

        // Update status only when pending count text changes
        const pending = toNumber(jetMsg.info.pending) || 0;
        const statusText = `${config.consumerName} (${pending} pending)`;
        if (statusText !== lastStatusText) {
          lastStatusText = statusText;
          node.status({
            fill: 'blue',
            shape: 'dot',
            text: statusText,
          });
        }

        // Clear any existing idle timeout
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }

        // Set timeout to change to idle status after 2 seconds
        idleTimeout = setTimeout(() => {
          if (!closing && !isConsuming && !isPaused) {
            setGreenStatus(`${config.consumerName} (idle)`, 'ring');
            lastStatusText = '';
          }
          idleTimeout = null;
        }, 2000);
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'message error' });
        throw err;
      }
    };

    // Helper: Consume messages
    const consumeMessages = async (msg, send) => {
      if (!consumer || isPaused || closing) return;
      if (isConsuming) throw new Error('consume already in progress');

      try {
        isConsuming = true;

        const maxWait =
          parseInt(msg.options?.expires ?? config.maxWait, 10) || 1000;
        const batch =
          parseInt(
            msg.options?.max_messages ?? msg.batchSize ?? config.batchSize,
            10
          ) || 1;

        // Set waiting status (blue) before fetching
        node.status({
          fill: 'blue',
          shape: 'ring',
          text: `${config.consumerName} (waiting)`,
        });

        if (isDebug) {
          node.log(
            `[STREAM CONSUMER] Fetching ${batch} messages (max wait: ${maxWait}ms)`
          );
        }
        lastStatusText = '';

        // Pull overflow/prioritized-pull fields (group/min_pending/
        // min_ack_pending/priority) were already reachable via a raw
        // msg.options passthrough with zero editor support - these config
        // fields are first-class defaults, seeded in BEFORE msg.options so
        // an explicit msg.options value still overrides them, matching this
        // codebase's established msg-wins-over-config precedence.
        const pullDefaults = {};
        if (config.pullGroup) {
          pullDefaults.group = config.pullGroup;
          if (config.pullMinPending)
            pullDefaults.min_pending = parseInt(config.pullMinPending, 10);
          if (config.pullMinAckPending)
            pullDefaults.min_ack_pending = parseInt(
              config.pullMinAckPending,
              10
            );
          if (config.pullPriority !== undefined && config.pullPriority !== '')
            pullDefaults.priority = parseInt(config.pullPriority, 10);
        }

        // Fetch messages
        fetchTask = consumer.fetch({
          ...pullDefaults,
          ...msg.options,
          max_messages: batch,
          expires: maxWait,
        });
        const messages = await fetchTask;
        fetchTask = null;
        activeMessages = messages;
        if (closing) messages.stop();

        let count = 0;
        for await (const jetMsg of messages) {
          // Check if paused during iteration
          if (isPaused || closing) {
            if (isDebug) {
              node.log(`[STREAM CONSUMER] Paused during consumption`);
            }
            break;
          }
          try {
            await processMessage(send, jetMsg);
          } catch (err) {
            // Don't let one bad message (e.g. JSON parse failure) abort the
            // rest of an already-fetched batch; log and move on so the
            // remaining pulled messages still get processed/acked.
            node.warn(
              `[STREAM CONSUMER] Failed to process message seq ${jetMsg.seq}: ${err.message}`
            );
          }
          count++;
        }

        if (count > 0) {
          if (isDebug) {
            node.log(`[STREAM CONSUMER] Processed ${count} messages`);
          }
        } else if (!isPaused) {
          // No messages found after timeout, change to idle status (green)
          setGreenStatus(`${config.consumerName} (idle)`, 'ring');
        }
      } catch (err) {
        if (!closing && (!err.message || !err.message.includes('timeout'))) {
          node.status({ fill: 'red', shape: 'ring', text: 'consume error' });
          throw err;
        }
      } finally {
        fetchTask = null;
        activeMessages?.stop();
        activeMessages = null;
        isConsuming = false;
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Initialize consumer
    const initializeConsumer = async () => {
      try {
        await ensureConsumer();
      } catch (err) {
        node.error(`Failed to ensure consumer: ${err.message}`);
      }
    };
    initializeConsumer();

    // Status listener for connection changes (status painting only; the
    // consumer is established once at node start and its handle stays valid
    // across native reconnects, so there is nothing to tear down or rebuild
    // here). disconnected/connecting use the default paint; 'connected'
    // shows the consumer name instead of the generic text.
    const detachStatus = attachStatus(node, this.serverConfig, {
      connected: () => setGreenStatus(`${config.consumerName} (ready)`),
    });

    // Stream Management Operations
    // Returns null on success, or the error to report via done(err) -
    // node.error() itself is the caller's job now, so one failure doesn't
    // fire Catch nodes twice.
    const performStreamOperation = async (msg, send) => {
      try {
        await ensureJetStream();

        const operation = msg.operation || config.operation || 'consume';
        const streamName = msg.stream || config.streamName || '';

        if (!streamName) {
          return new Error('Stream name required for operation');
        }

        switch (operation) {
          case 'info': {
            const streamInfo = await jsm.streams.info(streamName, msg.options);
            msg.payload = {
              operation: 'info',
              stream: streamName,
              config: streamInfo.config,
              state: streamInfo.state,
            };
            setGreenStatus(streamName);
            break;
          }

          case 'delete': {
            await jsm.streams.delete(streamName);
            msg.payload = {
              operation: 'delete',
              stream: streamName,
              success: true,
            };
            setGreenStatus(`deleted: ${streamName}`);
            break;
          }

          case 'purge': {
            // jsClient.streams.get(name) returns a Stream with no .purge() -
            // only JetStreamManager.streams has it (verified against
            // @nats-io/jetstream 3.4.0 types).
            await jsm.streams.purge(streamName, msg.options);
            msg.payload = {
              operation: 'purge',
              stream: streamName,
              success: true,
            };
            setGreenStatus(`purged: ${streamName}`);
            break;
          }

          case 'get-message': {
            const hasSeq = msg.seq !== undefined && msg.seq !== null;
            const hasLastBySubject =
              msg.lastBySubject !== undefined && msg.lastBySubject !== null;
            if (hasSeq === hasLastBySubject) {
              return new Error(
                'get-message requires exactly one of msg.seq (number) or msg.lastBySubject (string)'
              );
            }

            const query = hasSeq
              ? { seq: parseInt(msg.seq, 10) }
              : { last_by_subj: msg.lastBySubject };

            // jsm.direct.getMessage() is the faster path but the server
            // rejects it unless the stream has allow_direct: true -
            // jsm.streams.getMessage() (manager-level) always works.
            const useDirectGet =
              msg.useDirectGet !== undefined
                ? !!msg.useDirectGet
                : !!config.useDirectGet;
            const storedMsg = useDirectGet
              ? await jsm.direct.getMessage(streamName, query)
              : await jsm.streams.getMessage(streamName, query);

            // null is a valid "no match" result, not a thrown error - a
            // targeted lookup finding nothing is a real failure here, not a
            // silent empty success.
            if (!storedMsg) {
              return new Error('No message found for the given query');
            }

            // Mirrors the 'list' case below: the real content belongs at
            // the top level of msg (like a live consume), not nested inside
            // msg.payload the way the metadata-only info/delete/purge cases
            // above do - there's no separate "content" for those to hold.
            msg.operation = 'get-message';
            msg.payload = fromMsg(storedMsg, parseMode);
            msg.stream = streamName;
            msg.subject = storedMsg.subject;
            msg.sequence = toNumber(storedMsg.seq);
            msg.timestamp = storedMsg.timestamp;
            if (storedMsg.header) {
              const headers = {};
              for (const [key, values] of storedMsg.header) {
                headers[key] = values.length === 1 ? values[0] : values;
              }
              msg.headers = headers;
            }
            setGreenStatus(streamName);
            break;
          }

          default:
            return new Error(`Unknown operation: ${operation}`);
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

    // Consumer Management Operations. Same return contract as
    // performStreamOperation above.
    const performConsumerOperation = async (msg, send) => {
      try {
        await ensureJetStream();

        const operation = msg.operation || config.operation || 'consume';
        const streamName = msg.stream || config.streamName || '';
        const consumerName = msg.consumer || config.consumerName || '';

        if (!streamName && operation !== 'list') {
          return new Error('Stream name required for consumer operation');
        }

        if (!consumerName && operation !== 'list' && operation !== 'create') {
          return new Error('Consumer name required for operation');
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
              ...buildPriorityFields({
                groups: msg.priorityGroups || config.priorityGroups,
                policy: msg.priorityPolicy || config.priorityPolicy,
                timeout: msg.priorityTimeout || config.priorityTimeout,
              }),
            };

            // Remove undefined values
            Object.keys(consumerConfig).forEach(key => {
              if (consumerConfig[key] === undefined) delete consumerConfig[key];
            });

            // pedantic is a separate opts arg, not a config field. msg.options
            // is this file's existing raw-passthrough override channel (like
            // msg.config above) - if it already sets pedantic, that wins;
            // otherwise fall back to the msg/config convenience fields.
            const pedantic =
              msg.options?.pedantic !== undefined
                ? msg.options.pedantic
                : msg.pedantic !== undefined
                  ? msg.pedantic
                  : config.pedantic;
            const createdConsumer = await jsm.consumers.add(
              streamName,
              consumerConfig,
              { ...msg.options, pedantic: !!pedantic }
            );
            msg.payload = {
              operation: 'create',
              consumer: createdConsumer.name,
              success: true,
            };
            setGreenStatus(`created: ${createdConsumer.name}`);
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
              ack_pending: consumerInfo.num_ack_pending,
            };
            setGreenStatus(consumerName);
            break;
          }

          case 'delete': {
            await jsm.consumers.delete(streamName, consumerName);
            msg.payload = {
              operation: 'delete',
              consumer: consumerName,
              success: true,
            };
            setGreenStatus(`deleted: ${consumerName}`);
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
            setGreenStatus(`${consumers.length} consumers`);
            break;
          }

          case 'pause': {
            const result = await jsm.consumers.pause(
              streamName,
              consumerName,
              new Date(msg.until || '9999-12-31T23:59:59.999Z')
            );
            isPaused = result.paused;
            msg.payload = {
              operation: 'pause',
              consumer: consumerName,
              success: true,
              ...result,
            };
            node.status({
              fill: 'yellow',
              shape: 'ring',
              text: `${consumerName} (paused)`,
            });
            if (isDebug) {
              node.log(`[STREAM CONSUMER] Consumer paused: ${consumerName}`);
            }
            break;
          }

          case 'resume': {
            const result = await jsm.consumers.resume(streamName, consumerName);
            isPaused = result.paused;
            msg.payload = {
              operation: 'resume',
              consumer: consumerName,
              success: true,
              ...result,
            };
            setGreenStatus(`${consumerName} (resumed)`);
            if (isDebug) {
              node.log(`[STREAM CONSUMER] Consumer resumed: ${consumerName}`);
            }
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
            const delivered = consumerInfo.delivered?.consumer_seq || 0;
            const ackPending = consumerInfo.num_ack_pending || 0;
            const redelivered = consumerInfo.num_redelivered || 0;
            const waiting = consumerInfo.num_waiting || 0;

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

            if (isDebug) {
              node.log(
                `[STREAM CONSUMER] Monitor: pending=${pending}, ack_pending=${ackPending}, delivered=${delivered}`
              );
            }
            break;
          }

          default:
            return new Error(`Unknown consumer operation: ${operation}`);
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

    // Input handler - trigger message consumption, stream management, or consumer management
    node.on('input', async function (msg, send, done) {
      try {
        // Check if this is a stream management or consumer management operation
        const operation = msg.operation || config.operation || 'consume';

        // Stream management operations
        if (operation === 'purge' || operation === 'get-message') {
          done(await performStreamOperation(msg, send));
          return;
        }

        // Consumer management operations
        if (
          [
            'create',
            'add',
            'info',
            'delete',
            'list',
            'pause',
            'resume',
            'monitor',
          ].includes(operation)
        ) {
          done(await performConsumerOperation(msg, send));
          return;
        }

        // Default: consume messages
        if (operation !== 'consume') {
          done(new Error(`Unknown operation: ${operation}`));
          return;
        }

        // Ensure consumer is ready
        if (!consumer) {
          await ensureConsumer();
        }

        await consumeMessages(msg, send);
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      }
    });

    // Cleanup on close
    node.on('close', async function (done) {
      let closeError;
      try {
        closing = true;
        if (idleTimeout) clearTimeout(idleTimeout);
        const messages = activeMessages || (fetchTask && (await fetchTask));
        if (messages) {
          messages.stop();
          await messages.closed();
        }
      } catch (err) {
        closeError = err;
      } finally {
        detachStatus();
        this.serverConfig.unregisterConnectionUser(node.id);
        consumer = null;
        jsClient = null;
        jsm = null;
        node.status({});
        done(closeError);
      }
    });
  }

  RED.nodes.registerType('nats-suite-stream-consumer', NatsStreamConsumerNode);
};
