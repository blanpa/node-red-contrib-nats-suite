'use strict';

const { headers: natsHeaders } = require('@nats-io/nats-core');
const {
  JetStreamApiCodes,
  JetStreamApiError,
  jetstream,
  jetstreamManager,
} = require('@nats-io/jetstream');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');
const { toPayload } = require('../lib/payload');
const { parseDuration } = require('../lib/duration');

module.exports = function (RED) {
  function NatsStreamPublisherNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.serverConfig = resolveServer(RED, node, config);
    if (!this.serverConfig) return;

    const isDebug = !!(config.debug || this.serverConfig.debug);

    // Validate stream configuration
    if (!config.streamName) {
      node.error('Stream name is required');
      node.status({ fill: 'red', shape: 'ring', text: 'no stream' });
      return;
    }

    let jsClient = null;
    let jsm = null;
    let streamReady = false;
    let ensureStreamPromise = null;
    let statusRevertTimer = null;
    let closing = false;

    // Helper: Update node status based on connection state
    const updateConnectionStatus = () => {
      if (closing) return;
      const currentStatus = node.serverConfig.connectionStatus;
      if (currentStatus === 'connected') {
        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
      } else if (currentStatus === 'disconnected') {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      } else if (currentStatus === 'connecting') {
        node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
      }
    };

    // Helper: Revert a transient status message (e.g. "stream created") back
    // to the connection status after 2 seconds. Tracked so close() can cancel
    // a pending revert.
    const scheduleStatusRevert = () => {
      if (closing) return;
      if (statusRevertTimer) clearTimeout(statusRevertTimer);
      statusRevertTimer = setTimeout(() => {
        statusRevertTimer = null;
        if (closing) return;
        updateConnectionStatus();
      }, 2000);
    };

    const setStatus = status => {
      if (!closing) node.status(status);
    };

    // Helper: Acquire the JetStream client + manager once and cache them. The
    // connection object is stable across native reconnects, so there is no
    // need to re-derive these on every reconnect.
    const ensureJetStream = async () => {
      if (closing) throw new Error('Node is closing');
      if (jsClient && jsm) return;
      const nc = await node.serverConfig.getConnection();
      if (closing) throw new Error('Node is closing');
      const client = jetstream(nc);
      const manager = await jetstreamManager(nc);
      if (closing) throw new Error('Node is closing');
      jsClient = client;
      jsm = manager;
    };

    // Helper: Convert a plain {key: value} object into a real NATS MsgHdrs
    // instance, or undefined if there's nothing to convert. Shared by the
    // regular publish path and batch-publish so a future header-handling
    // change (e.g. multi-value headers) only needs to land in one place.
    const buildNatsHeaders = headersObj => {
      if (!headersObj || typeof headersObj !== 'object') return undefined;
      const h = natsHeaders();
      Object.keys(headersObj).forEach(key => {
        h.append(key, String(headersObj[key]));
      });
      return h;
    };

    // Helper: Build a ScheduleOptions fallback from the node's Schedule
    // config fields. Only used when nothing message-level already set a
    // schedule (see the input handler) - editor fields are a convenience on
    // top of the msg.schedule passthrough, not a replacement for it. Missing
    // scheduleTarget produces no schedule (the editor's own validate()
    // already requires it whenever scheduleType !== 'none'; a hand-edited or
    // imported flow that skipped that check gets a node.warn() at the call
    // site instead of silently publishing unscheduled).
    const buildConfigSchedule = () => {
      if (!config.scheduleTarget) return undefined;
      if (config.scheduleType === 'at') {
        return {
          specification: { at: config.scheduleAt },
          target: config.scheduleTarget,
        };
      }
      if (config.scheduleType === 'cron') {
        return {
          specification: { cron: config.scheduleCron },
          target: config.scheduleTarget,
          ...(config.scheduleTimezone
            ? { timezone: config.scheduleTimezone }
            : {}),
        };
      }
      return undefined;
    };

    // Helper: Parse subject patterns (comma-separated or array)
    const parseSubjects = subjects => {
      if (!subjects) return ['*'];
      if (Array.isArray(subjects)) return subjects;
      if (typeof subjects === 'string') {
        return subjects
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
      }
      return ['*'];
    };

    // Helper: Get or create stream. Concurrent callers (e.g. the fire-and-
    // forget init call racing an early input message) share one in-flight
    // call instead of each independently checking-then-creating the stream.
    const ensureStream = () => {
      if (closing) throw new Error('Node is closing');
      if (!ensureStreamPromise) {
        ensureStreamPromise = (async () => {
          try {
            return await ensureStreamImpl();
          } finally {
            if (!closing) ensureStreamPromise = null;
          }
        })();
      }
      return ensureStreamPromise;
    };

    const ensureStreamImpl = async () => {
      if (closing) throw new Error('Node is closing');
      try {
        await ensureJetStream();
        if (closing) throw new Error('Node is closing');

        // Try to get existing stream
        try {
          const info = await jsm.streams.info(config.streamName);
          if (closing) return;

          // persist_mode is fixed at stream creation and can never be
          // changed via update in either direction - confirmed against a
          // real broker: the server rejects the attempt outright with
          // "stream configuration update can not change persist mode",
          // even when nothing else in the update actually differs. Unlike
          // allow_msg_ttl/allow_msg_schedules (one-way latches) or
          // allow_direct (freely toggleable), there is no update call that
          // can reconcile a mismatch here, so it cannot join the
          // auto-upgrade check below - doing so would make ensureStream()
          // throw on every startup for any pre-existing stream whose
          // persist_mode doesn't already match the current config.
          if (
            config.persistMode === 'async' &&
            info.config.persist_mode !== 'async'
          ) {
            node.warn(
              `[STREAM PUB] Stream ${config.streamName} already exists with persist_mode ` +
                `"${info.config.persist_mode || 'default'}" - configured "async" cannot be applied ` +
                'to an existing stream (persist_mode is fixed at creation).'
            );
          }

          if (
            (config.allowMsgTtl && !info.config.allow_msg_ttl) ||
            (config.allowMsgSchedules && !info.config.allow_msg_schedules) ||
            (config.allowDirect && !info.config.allow_direct) ||
            (config.allowAtomic && !info.config.allow_atomic)
          ) {
            await jsm.streams.update(config.streamName, {
              ...info.config,
              allow_msg_ttl: info.config.allow_msg_ttl || !!config.allowMsgTtl,
              allow_msg_schedules:
                info.config.allow_msg_schedules || !!config.allowMsgSchedules,
              allow_direct: info.config.allow_direct || !!config.allowDirect,
              allow_atomic: info.config.allow_atomic || !!config.allowAtomic,
            });
            if (closing) return;
          }
          streamReady = true;
          if (isDebug) {
            node.log(`[STREAM PUB] Stream exists: ${config.streamName}`);
          }
          return true;
        } catch (err) {
          // Stream doesn't exist, create it
          if (
            err instanceof JetStreamApiError &&
            err.code === JetStreamApiCodes.StreamNotFound
          ) {
            if (closing) return;
            if (isDebug) {
              node.log(`[STREAM PUB] Creating stream: ${config.streamName}`);
            }

            const streamConfig = {
              name: config.streamName,
              subjects: parseSubjects(config.subjectPattern),
              retention: config.retention || 'limits',
              storage: config.storage === 'memory' ? 'memory' : 'file',
              max_msgs: parseInt(config.maxMessages, 10) || 10000,
              max_bytes: parseInt(config.maxBytes, 10) || 10485760, // 10MB
              max_age: parseDuration(config.maxAge || '24h'),
              duplicate_window: parseDuration(config.duplicateWindow || '2m'),
              num_replicas: parseInt(config.replicas, 10) || 1,
              discard: 'old', // Discard old messages when limits reached
              max_consumers: parseInt(config.maxConsumers, 10) || -1,
              max_msgs_per_subject:
                parseInt(config.maxMsgsPerSubject, 10) || -1,
              max_msg_size: parseInt(config.maxMsgSize, 10) || -1,
              compression: config.compression || 'none',
              deny_delete: !!config.denyDelete,
              deny_purge: !!config.denyPurge,
              allow_rollup_hdrs: !!config.allowRollupHdrs,
              allow_msg_ttl: !!config.allowMsgTtl,
              allow_msg_schedules: !!config.allowMsgSchedules,
              allow_direct: !!config.allowDirect,
              allow_atomic: !!config.allowAtomic,
              persist_mode:
                config.persistMode === 'async' ? 'async' : 'default',
            };

            await jsm.streams.add(streamConfig);
            if (closing) return;
            streamReady = true;

            if (isDebug) {
              node.log(`[STREAM PUB] Stream created: ${config.streamName}`);
            }

            // Show creation status for 2 seconds
            setStatus({
              fill: 'green',
              shape: 'dot',
              text: `stream ${config.streamName} created`,
            });

            // Revert to connection status after 2 seconds
            scheduleStatusRevert();

            return true;
          }
          throw err;
        }
      } catch (err) {
        if (closing) throw err;
        streamReady = false;

        // Show error status for 2 seconds
        setStatus({ fill: 'red', shape: 'ring', text: 'error' });

        // Revert to connection status after 2 seconds
        scheduleStatusRevert();

        throw err;
      }
    };

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Initialize stream only for publish operation when createOnInit is enabled
    const operation = config.operation || 'publish';
    if (operation === 'publish' && config.createOnInit !== false) {
      const initializeStream = async () => {
        try {
          await ensureStream();
        } catch (err) {
          if (!closing) node.error(`Failed to ensure stream: ${err.message}`);
        }
      };
      initializeStream();
    }

    // Status listener for connection changes (status painting only; the
    // JetStream client and stream handle are established once at node start
    // and stay valid across native reconnects, so there is nothing to tear
    // down or rebuild here). Default connected/disconnected/connecting paint
    // is exactly what this node needs - no custom handlers.
    const detachStatus = attachStatus(node, this.serverConfig);

    // Stream Management Operations. Returns null on success, or the error to
    // report via done(err) - node.error() itself is now the caller's job
    // (on('input')), so a single failure doesn't fire Catch nodes twice.
    const performStreamOperation = async (msg, send) => {
      try {
        await ensureJetStream();

        const operation = msg.operation || config.operation || 'publish';
        const streamName = msg.stream || config.streamName || '';

        if (!streamName && operation !== 'list') {
          return new Error('Stream name required for operation');
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
              if (isDebug) {
                node.log(
                  `[STREAM PUB] Creating stream from payload config: ${streamConfig.name}`
                );
              }
            } else {
              // Build config from individual msg/node properties (legacy support)
              const targetStreamName = msg.stream || streamName;
              streamConfig = {
                name: targetStreamName,
                subjects: msg.subjects
                  ? parseSubjects(msg.subjects)
                  : parseSubjects(
                      config.subjectPattern || targetStreamName + '.>'
                    ),
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
                allow_msg_schedules:
                  msg.allowMsgSchedules !== undefined
                    ? msg.allowMsgSchedules
                    : config.allowMsgSchedules || false,
                allow_direct:
                  msg.allowDirect !== undefined
                    ? msg.allowDirect
                    : config.allowDirect || false,
                allow_atomic:
                  msg.allowAtomic !== undefined
                    ? msg.allowAtomic
                    : config.allowAtomic || false,
                persist_mode:
                  msg.persistMode || config.persistMode || 'default',
                sealed:
                  msg.sealed !== undefined
                    ? msg.sealed
                    : config.sealed || false,
              };
              if (isDebug) {
                node.log(
                  `[STREAM PUB] Creating stream from properties: ${streamConfig.name}`
                );
              }
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
            if (isDebug) {
              node.log(
                `[STREAM PUB] Stream created successfully: ${createdStream.config.name}`
              );
            }

            // Show creation status for 2 seconds
            setStatus({
              fill: 'green',
              shape: 'dot',
              text: `stream ${createdStream.config.name} created`,
            });

            // Revert to connection status after 2 seconds
            scheduleStatusRevert();

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
              streamConfig.sealed =
                currentStream.config.sealed || streamConfig.sealed;
              streamConfig.allow_msg_ttl =
                currentStream.config.allow_msg_ttl ||
                streamConfig.allow_msg_ttl;
              streamConfig.allow_msg_schedules =
                currentStream.config.allow_msg_schedules ||
                streamConfig.allow_msg_schedules;
              // allow_direct and allow_atomic are freely toggleable (unlike
              // the one-way allow_msg_ttl/allow_msg_schedules/sealed
              // latches above), so both are intentionally left to the
              // spread's normal precedence: an explicit value in
              // msg.payload wins either way.
              // persist_mode is neither - it is fixed at creation and the
              // server rejects any attempt to actually change it via
              // update (see ensureStreamImpl above), so a msg.payload that
              // tries to change it will surface that real rejection here
              // rather than silently failing.
              if (isDebug) {
                node.log(
                  `[STREAM PUB] Updating stream from payload config: ${streamConfig.name}`
                );
              }
            } else {
              // Build config from individual msg/node properties (legacy support)
              streamConfig = {
                ...currentStream.config,
                subjects: msg.subjects
                  ? parseSubjects(msg.subjects)
                  : config.subjectPattern
                    ? parseSubjects(config.subjectPattern)
                    : currentStream.config.subjects,
                retention:
                  msg.retention ||
                  config.retention ||
                  currentStream.config.retention,
                max_msgs:
                  msg.maxMessages !== undefined
                    ? parseInt(msg.maxMessages, 10)
                    : config.maxMessages !== undefined
                      ? parseInt(config.maxMessages, 10)
                      : currentStream.config.max_msgs,
                max_bytes:
                  msg.maxBytes !== undefined
                    ? parseInt(msg.maxBytes, 10)
                    : config.maxBytes !== undefined
                      ? parseInt(config.maxBytes, 10)
                      : currentStream.config.max_bytes,
                max_age: msg.maxAge
                  ? parseDuration(msg.maxAge)
                  : config.maxAge
                    ? parseDuration(config.maxAge)
                    : currentStream.config.max_age,
                duplicate_window: msg.duplicateWindow
                  ? parseDuration(msg.duplicateWindow)
                  : config.duplicateWindow
                    ? parseDuration(config.duplicateWindow)
                    : currentStream.config.duplicate_window,
                num_replicas:
                  msg.replicas !== undefined
                    ? parseInt(msg.replicas, 10)
                    : config.replicas !== undefined
                      ? parseInt(config.replicas, 10)
                      : currentStream.config.num_replicas,
                discard:
                  msg.discard || config.discard || currentStream.config.discard,
                // Extended NATS config options
                max_consumers:
                  msg.maxConsumers !== undefined
                    ? parseInt(msg.maxConsumers, 10)
                    : config.maxConsumers !== undefined
                      ? parseInt(config.maxConsumers, 10)
                      : currentStream.config.max_consumers,
                max_msgs_per_subject:
                  msg.maxMsgsPerSubject !== undefined
                    ? parseInt(msg.maxMsgsPerSubject, 10)
                    : config.maxMsgsPerSubject !== undefined
                      ? parseInt(config.maxMsgsPerSubject, 10)
                      : currentStream.config.max_msgs_per_subject,
                max_msg_size:
                  msg.maxMsgSize !== undefined
                    ? parseInt(msg.maxMsgSize, 10)
                    : config.maxMsgSize !== undefined
                      ? parseInt(config.maxMsgSize, 10)
                      : currentStream.config.max_msg_size,
                compression:
                  msg.compression ||
                  config.compression ||
                  currentStream.config.compression,
                sealed:
                  msg.sealed !== undefined
                    ? msg.sealed
                    : config.sealed !== undefined
                      ? config.sealed
                      : currentStream.config.sealed,
                deny_delete:
                  msg.denyDelete !== undefined
                    ? msg.denyDelete
                    : config.denyDelete !== undefined
                      ? config.denyDelete
                      : currentStream.config.deny_delete,
                deny_purge:
                  msg.denyPurge !== undefined
                    ? msg.denyPurge
                    : config.denyPurge !== undefined
                      ? config.denyPurge
                      : currentStream.config.deny_purge,
                allow_rollup_hdrs:
                  msg.allowRollupHdrs !== undefined
                    ? msg.allowRollupHdrs
                    : config.allowRollupHdrs !== undefined
                      ? config.allowRollupHdrs
                      : currentStream.config.allow_rollup_hdrs,
                allow_msg_ttl:
                  currentStream.config.allow_msg_ttl ||
                  msg.allowMsgTtl === true ||
                  config.allowMsgTtl === true,
                allow_msg_schedules:
                  currentStream.config.allow_msg_schedules ||
                  msg.allowMsgSchedules === true ||
                  config.allowMsgSchedules === true,
                // Unlike allow_msg_ttl/allow_msg_schedules above, allow_direct
                // is freely toggleable in both directions (confirmed against
                // a real server: update can flip it true->false and
                // false->true) - it's a read-path switch, not a latch that
                // could orphan already-scheduled/TTL'd messages if disabled.
                allow_direct:
                  msg.allowDirect !== undefined
                    ? msg.allowDirect
                    : config.allowDirect !== undefined
                      ? config.allowDirect
                      : currentStream.config.allow_direct,
                // Same freely-toggleable shape as allow_direct - confirmed
                // against a real broker in both directions.
                allow_atomic:
                  msg.allowAtomic !== undefined
                    ? msg.allowAtomic
                    : config.allowAtomic !== undefined
                      ? config.allowAtomic
                      : currentStream.config.allow_atomic,
                // Unlike allow_direct/allow_atomic just above, persist_mode is fixed at
                // creation - the real server rejects an update that
                // actually changes it ("stream configuration update can
                // not change persist mode"), confirmed against a real
                // broker. Falling back to the stream's current value keeps
                // an unrelated property update working; a deliberate
                // attempt to change it here still surfaces that real
                // rejection rather than silently no-op-ing.
                persist_mode:
                  msg.persistMode ||
                  config.persistMode ||
                  currentStream.config.persist_mode,
              };
              if (isDebug) {
                node.log(
                  `[STREAM PUB] Updating stream from properties: ${streamConfig.name}`
                );
              }
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
            if (isDebug) {
              node.log(
                `[STREAM PUB] Stream updated successfully: ${updatedStream.config.name}`
              );
            }

            // Show update status for 2 seconds
            setStatus({
              fill: 'green',
              shape: 'dot',
              text: `stream ${updatedStream.config.name} updated`,
            });

            // Revert to connection status after 2 seconds
            scheduleStatusRevert();

            break;
          }

          case 'update-subjects': {
            // Update stream subjects only (without changing other config)
            const currentStream = await jsm.streams.info(streamName);
            const updatedConfig = {
              ...currentStream.config,
              subjects: msg.subjects
                ? parseSubjects(msg.subjects)
                : currentStream.config.subjects,
            };

            await jsm.streams.update(streamName, updatedConfig);
            msg.payload = {
              operation: 'update-subjects',
              stream: streamName,
              subjects: updatedConfig.subjects,
              success: true,
            };
            if (isDebug) {
              node.log(
                `[STREAM PUB] Updated subjects for ${streamName}: ${updatedConfig.subjects.join(', ')}`
              );
            }
            break;
          }

          case 'info': {
            const targetStreamName =
              msg.payload?.name || msg.stream || streamName;
            const info = await jsm.streams.info(targetStreamName, msg.options);
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

            // Show delete status for 2 seconds
            setStatus({
              fill: 'green',
              shape: 'dot',
              text: `stream ${streamName} deleted`,
            });

            // Revert to connection status after 2 seconds
            scheduleStatusRevert();

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
            break;
          }

          case 'batch-publish': {
            // Maps startBatch()/add()/commit()'s multi-call lifecycle onto
            // ONE Node-RED message carrying the whole batch - a stateful
            // multi-message protocol (separate 'batch-start'/'batch-add'/
            // 'batch-commit' operations correlated by a handle) would need
            // cross-message state tracking this plan doesn't ask for, and
            // this API's whole point is one atomic all-or-nothing publish.
            //
            // Confirmed against a real broker: startBatch() and add() do
            // NOT durably publish anything by themselves - an uncommitted
            // batch's messages never appear on the stream. commit() is what
            // makes the batch durable, and it ALSO publishes its own "last"
            // message as part of committing (not a bare close call). That
            // means the true minimum is 2 real messages - one via
            // startBatch (first), one via commit (last) - a "batch of 1" is
            // not representable through this API.
            const items = msg.batch;
            if (!Array.isArray(items) || items.length < 2) {
              return new Error(
                'batch-publish requires msg.batch to be an array of at least 2 items - ' +
                  'startBatch() and commit() each publish a real message, so a 1-item batch ' +
                  'is not representable through this API'
              );
            }
            // Server limit: a batch may not contain more than 1000
            // messages, including the start and commit messages. Checked
            // client-side to avoid wasting a round trip on an obviously
            // oversized array; the server would reject it anyway.
            if (items.length > 1000) {
              return new Error(
                `batch-publish: msg.batch has ${items.length} items, exceeding the server's ` +
                  '1000-message-per-batch limit (including the start and commit messages)'
              );
            }
            // Only subject is required. payload is intentionally not
            // validated - the regular (non-batch) publish path a few
            // dozen lines below doesn't require msg.payload either
            // (toPayload(undefined) just publishes an empty message,
            // which is a legitimate NATS message), so an item with a
            // subject but no payload is a valid empty-body batch item,
            // not an error.
            for (const item of items) {
              if (!item || !item.subject) {
                return new Error(
                  'Every batch item requires a subject (msg.batch[n].subject)'
                );
              }
            }
            // Confirmed against a real broker (not just reasoned from the
            // .d.ts): a mismatched `expect` on a middle (add()'ed) item is
            // silently ignored - it neither throws nor is it enforced by
            // the server, with or without `ack: true`. Letting it through
            // would be exactly the "field that looks like it does
            // something but doesn't" trap this whole plan exists to close,
            // so it is rejected client-side instead, same as the last item
            // (commit()'s options are Partial<RequestOptions> - no expect
            // field at all, so that one really would be silently dropped
            // by the type shape, not just practically inert).
            const last = items[items.length - 1];
            for (let i = 1; i < items.length; i++) {
              if (items[i].expect) {
                const where = i === items.length - 1 ? 'last' : 'a middle';
                return new Error(
                  `batch-publish: ${where} item cannot use "expect" - only the first item's ` +
                    'expect is actually enforced by the server; expect on any later item is ' +
                    'silently ignored (confirmed against a real broker), so it is rejected ' +
                    'here instead of accepted and quietly doing nothing'
                );
              }
            }

            // Message tracing is a single connection-level switch that
            // applies to every publish through this connection (NATS-3.4-
            // GAP-PLAN.md decision 2) - the regular publish path a few
            // hundred lines below applies it via a Nats-Trace-Dest header
            // rather than a JetStreamPublishOptions field (JetStream drops
            // unknown option keys), and batch-publish needs the exact same
            // treatment on every item, not just the first/last.
            const traceDestination =
              node.serverConfig.getTraceOptions()?.traceDestination;
            const buildItemOpts = item => {
              const opts = {};
              const itemHeaders = buildNatsHeaders(item.headers);
              if (itemHeaders) opts.headers = itemHeaders;
              if (traceDestination) {
                if (!opts.headers) opts.headers = natsHeaders();
                opts.headers.set('Nats-Trace-Dest', traceDestination);
              }
              if (item.expect) opts.expect = item.expect;
              return opts;
            };

            const first = items[0];
            const middle = items.slice(1, -1);

            const batch = await jsClient.startBatch(
              first.subject,
              toPayload(first.payload),
              buildItemOpts(first)
            );
            for (const item of middle) {
              const opts = buildItemOpts(item);
              // add()'s two overloads (fire-and-forget vs awaited-ack) both
              // return something await-safe, so always awaiting is correct
              // regardless of which one the ack flag selects.
              await batch.add(
                item.subject,
                toPayload(item.payload),
                item.ack ? { ...opts, ack: true } : opts
              );
            }
            const lastOpts = buildItemOpts(last);
            const batchAck = await batch.commit(
              last.subject,
              toPayload(last.payload),
              lastOpts.headers ? { headers: lastOpts.headers } : undefined
            );

            msg.operation = 'batch-publish';
            msg.payload = batchAck;
            if (isDebug) {
              node.log(
                `[STREAM PUB] Batch committed: ${batchAck.batch} (${batchAck.count} messages)`
              );
            }
            break;
          }

          case 'list': {
            const streams = [];
            for await (const stream of jsm.streams.list(msg.subject)) {
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
            return new Error(`Unknown operation: ${operation}`);
        }

        if (!closing) send(msg);
        return null;
      } catch (err) {
        if (closing) return null;
        msg.error = err.message;

        // Show error status for 2 seconds
        setStatus({ fill: 'red', shape: 'ring', text: 'error' });

        // Revert to connection status after 2 seconds
        scheduleStatusRevert();

        send(msg);
        return err;
      }
    };

    // Input handler
    node.on('input', async function (msg, send, done) {
      try {
        // Check if this is a stream management operation
        const operation = msg.operation || config.operation || 'publish';

        if (operation !== 'publish') {
          done(await performStreamOperation(msg, send));
          return;
        }

        // Ensure we have a JetStream client
        if (!streamReady) {
          await ensureStream();
        }
        if (closing) {
          done();
          return;
        }

        // Determine subject
        let subject = msg.subject || config.defaultSubject;
        if (!subject) {
          done(
            new Error(
              'No subject specified (use msg.subject or configure default subject)'
            )
          );
          return;
        }

        // Prepare payload
        const payload = toPayload(msg.payload);

        // Prepare headers if provided
        const msgHeaders = buildNatsHeaders(msg.headers);

        // Pass native JetStreamPublishOptions through so new client options
        // don't require a new node release. Direct schedule aliases keep
        // delayed delivery convenient in Node-RED flows.
        const publishOptions = { ...msg.options };
        if (msgHeaders) publishOptions.headers = msgHeaders;
        if (msg._msgID !== undefined) publishOptions.msgID = msg._msgID;
        if (publishOptions.schedule === undefined) {
          if (config.scheduleType !== 'none' && !config.scheduleTarget) {
            node.warn(
              'Schedule Type is set but Delivery Target Subject is empty - publishing immediately without a schedule'
            );
          }
          const configSchedule = buildConfigSchedule();
          if (configSchedule) publishOptions.schedule = configSchedule;
        }
        if (msg.schedule !== undefined) publishOptions.schedule = msg.schedule;

        // Optimistic-concurrency expect fields. Only "expected last-msg-ID"
        // and "expected last-sequence" get dedicated fields per the gap
        // plan's scope - the rest of StreamExpectations (streamName,
        // lastSubjectSequence*) stays msg.options.expect-passthrough-only.
        // Same fallback-only-if-still-undefined precedence as the schedule
        // default above: an explicit msg.options.expect (already captured
        // by the initial spread) is never clobbered by these convenience
        // fields.
        if (publishOptions.expect === undefined) {
          const expectLastMsgID = msg.expectLastMsgID ?? config.expectLastMsgID;
          const expectLastSequenceSource =
            msg.expectLastSequence ?? config.expectLastSequence;
          const expect = {};
          if (expectLastMsgID) expect.lastMsgID = expectLastMsgID;
          if (
            expectLastSequenceSource !== undefined &&
            expectLastSequenceSource !== ''
          ) {
            const parsedSequence = parseInt(expectLastSequenceSource, 10);
            if (!Number.isNaN(parsedSequence)) {
              expect.lastSequence = parsedSequence;
            }
          }
          if (Object.keys(expect).length > 0) publishOptions.expect = expect;
        }

        // @nats-io/jetstream's JetStreamPublishOptions has no
        // traceDestination field, and its publish() silently drops unknown
        // option keys (verified against the installed 3.4.0 client and a
        // real server) - message tracing only exists on the wire as the
        // Nats-Trace-Dest header, so the connection-level switch is applied
        // as a header instead of an option. Single connection-level toggle
        // only (NATS-3.4-GAP-PLAN.md decision 2) - no per-message override.
        // Set directly on publishOptions.headers (not a separate object)
        // so it merges with whatever headers already won above (msg.headers
        // or a native msg.options.headers passthrough) instead of clobbering
        // them.
        const traceDestination =
          node.serverConfig.getTraceOptions()?.traceDestination;
        if (traceDestination) {
          if (!publishOptions.headers) publishOptions.headers = natsHeaders();
          publishOptions.headers.set('Nats-Trace-Dest', traceDestination);
        }
        if (msg.cancelSchedule !== undefined)
          publishOptions.cancelSchedule = msg.cancelSchedule;

        const pubAck = await jsClient.publish(subject, payload, publishOptions);
        if (closing) {
          done();
          return;
        }

        // Update message with publish info
        msg.stream = pubAck.stream;
        msg.sequence = pubAck.seq;
        msg.published = true;
        msg.subject = subject;
        msg._duplicate = pubAck.duplicate || false;

        // Send message to output
        send(msg);
        done();
      } catch (err) {
        if (closing) {
          done();
          return;
        }
        msg.published = false;
        msg.error = err.message;

        // Send error message to output
        send(msg);
        done(err);
      }
    });

    // Cleanup on close
    node.on('close', async function (done) {
      closing = true;
      if (statusRevertTimer) {
        clearTimeout(statusRevertTimer);
        statusRevertTimer = null;
      }
      detachStatus();
      this.serverConfig.unregisterConnectionUser(node.id);
      jsClient = null;
      jsm = null;
      ensureStreamPromise = null;
      streamReady = false;
      node.status({});
      done();
    });
  }

  RED.nodes.registerType(
    'nats-suite-stream-publisher',
    NatsStreamPublisherNode
  );
};
