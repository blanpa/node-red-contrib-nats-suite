'use strict';

const { Svcm } = require('@nats-io/services');
const { jetstreamManager } = require('@nats-io/jetstream');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsServiceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.serverConfig = resolveServer(RED, node, config);
    if (!this.serverConfig) return;

    // Step 5 split the old serviceName field into an independent discovery
    // filter. Flows saved before that split have no discoveryFilter property.
    const discoveryFilter =
      (config.discoveryFilter ?? config.serviceName) || '*';

    let nc = null;
    let service = null;
    let closing = false;
    const isDebug = !!config.debug;

    // Service state
    let isServiceRunning = false;
    let serviceStats = {
      requests: 0,
      errors: 0,
      avgProcessingTime: 0,
      lastRequest: null,
    };

    // Health check state
    let healthCheckInterval = null;

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Status listener for connection changes (status painting only; the
    // service is started once at node start and its endpoint subscriptions
    // survive native reconnect on their own - the client transparently
    // restores them, and the underlying service object only self-closes when
    // the connection is closed for good, not on a transient disconnect - so
    // there is nothing to tear down or restart here). disconnected/connecting
    // use attachStatus's default paint (matches this node's prior behavior
    // exactly); 'connected' needs a custom handler because discover/stats/
    // ping/nats-stats modes must NOT repaint on every reconnect - they show
    // per-operation result text instead, which a generic "connected" would
    // clobber.
    const detachStatus = attachStatus(node, this.serverConfig, {
      connected: () => {
        if (config.mode === 'service') {
          // Repaint only - reflects the service surviving the reconnect.
          node.status({
            fill: 'green',
            shape: 'dot',
            text: isServiceRunning
              ? `${config.serviceName || 'default-service'} (running)`
              : 'connected',
          });
        } else if (config.mode === 'health') {
          node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        }
      },
    });

    // ==================== SERVICE FUNCTIONS ====================

    // Helper: Start service
    const startService = async () => {
      if (isServiceRunning) {
        node.warn('[SERVICE] Service already running');
        return;
      }

      try {
        nc = await node.serverConfig.getConnection();
        if (closing) throw new Error('Service node is closing');

        const serviceName = config.serviceName || 'default-service';
        const version = config.serviceVersion || '1.0.0';
        const description = config.serviceDescription || '';

        // Create service config
        const serviceConfig = {
          name: serviceName,
          version: version,
          description: description,
          queue: config.queueGroup || serviceName,
        };

        // Add metadata if configured
        if (config.metadata) {
          try {
            serviceConfig.metadata = JSON.parse(config.metadata);
          } catch (err) {
            node.warn(`[SERVICE] Failed to parse metadata: ${err.message}`);
          }
        }

        // Create service
        service = await new Svcm(nc).add(serviceConfig);
        if (closing) throw new Error('Service node is closing');

        // Add endpoint, optionally under a group. A ServiceGroup always
        // prefixes whatever subject it's given with its own subject
        // (ServiceGroupImpl.calcSubject: `${root}.${name}`) - passing the
        // same absolute `${serviceName}.${endpoint}` default used below
        // would double up under a group, so the default becomes just the
        // bare endpoint name when grouped and lets the group supply the
        // prefix. An explicit endpointSubject override still applies in
        // either case; it's just the group that decides what it's relative
        // to.
        const endpoint = config.endpoint || 'process';
        const endpointTarget = config.groupSubject
          ? service.addGroup(
              config.groupSubject,
              config.groupQueue || undefined
            )
          : service;
        const subject =
          config.endpointSubject ||
          (config.groupSubject ? endpoint : `${serviceName}.${endpoint}`);
        const effectiveSubject = config.groupSubject
          ? `${config.groupSubject}.${subject}`
          : subject;

        const endpointHandler = async (err, msg) => {
          const startTime = Date.now();

          try {
            serviceStats.requests++;
            serviceStats.lastRequest = Date.now();

            if (err) {
              serviceStats.errors++;
              node.error(`[SERVICE] Error in endpoint: ${err.message}`);
              return;
            }

            // Decode request
            const requestData = msg.string();
            let payload;
            try {
              payload = JSON.parse(requestData);
            } catch {
              payload = requestData;
            }

            if (isDebug) {
              node.log(
                `[SERVICE] Request received on ${subject}: ${JSON.stringify(payload)}`
              );
            }

            // Build output message
            const outMsg = {
              payload: payload,
              subject: msg.subject,
              service: serviceName,
              endpoint: endpoint,
              respond: response => {
                try {
                  const responseData =
                    typeof response === 'string'
                      ? response
                      : JSON.stringify(response);
                  msg.respond(responseData);

                  // Update stats
                  const processingTime = Date.now() - startTime;
                  serviceStats.avgProcessingTime =
                    (serviceStats.avgProcessingTime *
                      (serviceStats.requests - 1) +
                      processingTime) /
                    serviceStats.requests;

                  if (isDebug) {
                    node.log(`[SERVICE] Response sent in ${processingTime}ms`);
                  }
                } catch (err) {
                  serviceStats.errors++;
                  node.error(`[SERVICE] Failed to respond: ${err.message}`);
                }
              },
              respondError: (error, code) => {
                try {
                  serviceStats.errors++;
                  const errorResponse = {
                    error: error,
                    code: code || 'SERVICE_ERROR',
                  };
                  msg.respond(JSON.stringify(errorResponse));
                } catch (err) {
                  node.error(
                    `[SERVICE] Failed to send error response: ${err.message}`
                  );
                }
              },
            };

            // Send to output for processing
            node.send(outMsg);

            // Update status
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `${serviceName} (${serviceStats.requests} reqs)`,
            });
          } catch (err) {
            serviceStats.errors++;
            node.error(`[SERVICE] Handler error: ${err.message}`);

            try {
              msg.respond(
                JSON.stringify({
                  error: 'Internal service error',
                  code: 'INTERNAL_ERROR',
                })
              );
            } catch (respondErr) {
              node.error(
                `[SERVICE] Failed to send error response: ${respondErr.message}`
              );
            }
          }
        };

        // Add endpoint to the service (or group). addEndpoint() is
        // synchronous - it returns a QueuedIterator<ServiceMsg>, not a
        // Promise.
        endpointTarget.addEndpoint(endpoint, {
          subject,
          handler: endpointHandler,
        });
        isServiceRunning = true;

        if (isDebug) {
          node.log(`[SERVICE] Service started: ${serviceName} v${version}`);
          node.log(`[SERVICE] Endpoint: ${effectiveSubject}`);
        }
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `${serviceName} (running)`,
        });
      } catch (err) {
        if (service && !isServiceRunning) {
          try {
            await service.stop();
          } catch (stopErr) {
            node.warn(
              `[SERVICE] Failed to roll back startup: ${stopErr.message}`
            );
          }
          service = null;
        }
        node.status({ fill: 'red', shape: 'ring', text: 'start failed' });
        throw err;
      }
    };

    // Helper: Stop service
    const stopService = async () => {
      if (!isServiceRunning || !service) {
        return;
      }

      try {
        await service.stop();
        isServiceRunning = false;
        service = null;

        if (isDebug) node.log('[SERVICE] Service stopped');
        node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'stop failed' });
        throw err;
      }
    };

    // Helper: Service discovery. Only ever called from the input handler,
    // which reports failure via done(err) - no separate node.error() here.
    const discoverServices = async () => {
      nc = await node.serverConfig.getConnection();

      const serviceName = discoveryFilter;
      const services = [];

      // Get service client
      const client = new Svcm(nc).client();

      // Use info() for discovery - it returns service information
      const filter = serviceName === '*' ? undefined : serviceName;

      // Collect service info using async iterator
      for await (const info of await client.info(filter)) {
        services.push({
          name: info.name,
          id: info.id,
          version: info.version,
          type: info.type || 'service',
          description: info.description || '',
          metadata: info.metadata || {},
          endpoints: info.endpoints || [],
        });
      }

      return services;
    };

    // Helper: Service stats. Only ever called from the input handler, which
    // reports failure via done(err) - no separate node.error() here.
    const getServiceStats = async () => {
      nc = await node.serverConfig.getConnection();

      const serviceName = discoveryFilter;
      const stats = [];

      // Get service client
      const client = new Svcm(nc).client();

      // Get stats for services using async iterator
      const filter = serviceName === '*' ? undefined : serviceName;

      for await (const info of await client.stats(filter)) {
        stats.push({
          name: info.name,
          id: info.id,
          version: info.version,
          endpoints: info.endpoints || [],
          started: info.started,
          type: info.type || 'service',
        });
      }

      return stats;
    };

    // ==================== NATS STATS FUNCTIONS ====================

    // Get NATS server/connection statistics. Only ever called from the
    // input handler, which reports failure via done(err).
    const getNatsStats = async statsType => {
      nc = await node.serverConfig.getConnection();
      const type = statsType || config.statsType || 'server';

      switch (type) {
        case 'server': {
          const stats = nc.stats();
          return {
            type: 'server',
            inMsgs: stats.inMsgs,
            outMsgs: stats.outMsgs,
            inBytes: stats.inBytes,
            outBytes: stats.outBytes,
            // Stats has no reconnect count; the config node already
            // tracks it from the connection's status() events.
            reconnects:
              node.serverConfig.getConnectionStats().reconnectAttempts,
          };
        }

        case 'jetstream': {
          const jsm = await jetstreamManager(nc);
          const accountInfo = await jsm.getAccountInfo();
          return {
            type: 'jetstream',
            memory: accountInfo.memory,
            store: accountInfo.storage,
            api: accountInfo.api,
            limits: accountInfo.limits,
          };
        }

        case 'connections': {
          const serverInfo = nc.info;
          return {
            type: 'connections',
            server_id: serverInfo.server_id,
            version: serverInfo.version,
            connections: serverInfo.connections || 0,
          };
        }

        case 'all': {
          const stats = nc.stats();
          const jsm = await jetstreamManager(nc);
          const accountInfo = await jsm.getAccountInfo();
          const serverInfo = nc.info;

          return {
            type: 'all',
            server: {
              inMsgs: stats.inMsgs,
              outMsgs: stats.outMsgs,
              inBytes: stats.inBytes,
              outBytes: stats.outBytes,
              reconnects:
                node.serverConfig.getConnectionStats().reconnectAttempts,
            },
            jetstream: {
              memory: accountInfo.memory,
              store: accountInfo.storage,
              api: accountInfo.api,
              limits: accountInfo.limits,
            },
            connections: {
              server_id: serverInfo.server_id,
              version: serverInfo.version,
              connections: serverInfo.connections || 0,
            },
          };
        }

        default:
          throw new Error(`Unknown stats type: ${type}`);
      }
    };

    // ==================== HEALTH CHECK FUNCTIONS ====================

    // Helper functions for enhanced health monitoring
    const calculateThroughput = (inValue, outValue) => {
      const total = inValue + outValue;
      return total > 0 ? Math.round(total / 10) : 0;
    };

    const checkThresholds = (stats, connectionInfo, config) => {
      const alerts = [];

      // Latency threshold
      if (connectionInfo.latency > (config.latencyThreshold || 100)) {
        alerts.push({
          level: 'warning',
          type: 'latency',
          message: `High latency: ${connectionInfo.latency}ms`,
          value: connectionInfo.latency,
          threshold: config.latencyThreshold || 100,
        });
      }

      // Reconnect threshold
      if (stats.reconnects > (config.reconnectThreshold || 5)) {
        alerts.push({
          level: 'warning',
          type: 'reconnects',
          message: `High reconnect count: ${stats.reconnects}`,
          value: stats.reconnects,
          threshold: config.reconnectThreshold || 5,
        });
      }

      // Throughput threshold
      if (
        stats.throughput.messagesPerSecond >
        (config.throughputThreshold || 1000)
      ) {
        alerts.push({
          level: 'info',
          type: 'throughput',
          message: `High throughput: ${stats.throughput.messagesPerSecond} msg/s`,
          value: stats.throughput.messagesPerSecond,
          threshold: config.throughputThreshold || 1000,
        });
      }

      return alerts;
    };

    const generateSummary = (stats, connectionInfo, alerts) => {
      const summary = {
        overall: alerts.length === 0 ? 'healthy' : 'warning',
        connection: connectionInfo.connected ? 'stable' : 'unstable',
        performance:
          connectionInfo.latency < 50
            ? 'excellent'
            : connectionInfo.latency < 100
              ? 'good'
              : 'poor',
        activity:
          stats.inMsgs + stats.outMsgs > 1000
            ? 'high'
            : stats.inMsgs + stats.outMsgs > 100
              ? 'moderate'
              : 'low',
      };

      return summary;
    };

    const performConnectivityTests = async natsnc => {
      const results = [];
      let passed = 0;
      let failed = 0;

      try {
        // Test 1: Basic publish/subscribe
        const testSubject = `health.test.pubsub.${node.id}`;
        const testMessage = { test: 'connectivity', timestamp: Date.now() };
        const publishStart = Date.now();
        const subscription = natsnc.subscribe(testSubject, {
          max: 1,
          timeout: 1000,
        });

        natsnc.publish(testSubject, JSON.stringify(testMessage));
        await subscription[Symbol.asyncIterator]().next();
        results.push({
          test: 'publish_subscribe',
          status: 'passed',
          latency: `${Date.now() - publishStart}ms`,
        });
        passed++;

        // Test 2: Request/Response
        const requestSubject = `health.test.request.${node.id}`;
        const requestMessage = {
          test: 'request_response',
          timestamp: Date.now(),
        };
        const responseSub = natsnc.subscribe(requestSubject, { max: 1 });
        const respond = async () => {
          try {
            for await (const msg of responseSub) {
              if (msg.reply) {
                msg.respond(
                  JSON.stringify({ response: 'ok', timestamp: Date.now() })
                );
              }
              break;
            }
          } catch {
            // Unsubscribed or connection closed during a failed request.
          }
        };
        const responding = respond();
        await natsnc.flush();

        const requestStart = Date.now();
        try {
          const response = await natsnc.request(
            requestSubject,
            JSON.stringify(requestMessage),
            {
              timeout: 1000,
            }
          );
          await responding;
          const requestLatency = Date.now() - requestStart;

          if (response) {
            results.push({
              test: 'request_response',
              status: 'passed',
              latency: `${requestLatency}ms`,
            });
            passed++;
          } else {
            results.push({
              test: 'request_response',
              status: 'failed',
              error: 'No response received',
            });
            failed++;
          }
        } finally {
          responseSub.unsubscribe();
        }
      } catch (error) {
        results.push({
          test: 'connectivity',
          status: 'failed',
          error: error.message,
        });
        failed++;
      }

      return {
        total: passed + failed,
        passed,
        failed,
        results,
      };
    };

    // Enhanced health check function
    const performHealthCheck = async () => {
      try {
        node.status({ fill: 'yellow', shape: 'ring', text: 'checking' });

        // Check connection status BEFORE attempting health check
        if (this.serverConfig.connectionStatus !== 'connected') {
          const errorStatus = {
            status: 'disconnected',
            timestamp: Date.now(),
            error: {
              message:
                'Cannot perform health check - NATS server is not connected',
              code: 'NOT_CONNECTED',
              connectionStatus: this.serverConfig.connectionStatus,
              reconnectAttempts:
                this.serverConfig.connectionStats.reconnectAttempts,
            },
          };

          const msg = {
            payload: errorStatus,
            topic: 'nats.health',
            status: 'disconnected',
          };

          node.send(msg);
          node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
          return;
        }

        const natsnc = await this.serverConfig.getConnection();

        // Get server info
        const serverInfo = natsnc.info;

        // Measure latency using ping/pong
        const latencyStart = Date.now();
        await natsnc.flush();
        const latency = Date.now() - latencyStart;

        // Get extended server info
        const extendedServerInfo = {
          name: serverInfo.name,
          version: serverInfo.version,
          cluster: serverInfo.cluster,
          clientId: natsnc.info.client_id,
          clientIp: natsnc.info.client_ip,
          clientPort: natsnc.info.client_port,
          maxPayload: serverInfo.max_payload,
          protocol: serverInfo.proto,
          serverId: serverInfo.server_id,
          gitCommit: serverInfo.git_commit,
          goVersion: serverInfo.go,
          host: serverInfo.host,
          port: serverInfo.port,
          clusterPort: serverInfo.cluster_port,
          clusterConnectUrls: serverInfo.connect_urls || [],
          jetStream: serverInfo.jetstream || false,
          tlsRequired: serverInfo.tls_required || false,
          tlsVerify: serverInfo.tls_verify || false,
          tlsAvailable: serverInfo.tls_available || false,
        };

        // connected/draining/closed aren't properties on NatsConnection;
        // reconnects isn't on Stats either - the config node already
        // tracks it from the connection's status() events.
        const reconnects =
          node.serverConfig.getConnectionStats().reconnectAttempts;
        const ncStats = natsnc.stats();

        // Enhanced connection info
        const connectionInfo = {
          connected: !natsnc.isClosed(),
          draining: natsnc.isDraining(),
          closed: natsnc.isClosed(),
          latency: latency,
          uptime: reconnects === 0 ? 'stable' : `${reconnects} reconnects`,
          lastError: reconnects > 0 ? 'Connection was unstable' : null,
        };

        // Enhanced statistics
        const stats = {
          inMsgs: ncStats.inMsgs,
          outMsgs: ncStats.outMsgs,
          inBytes: ncStats.inBytes,
          outBytes: ncStats.outBytes,
          reconnects: reconnects,
          throughput: {
            messagesPerSecond: calculateThroughput(
              ncStats.inMsgs,
              ncStats.outMsgs
            ),
            bytesPerSecond: calculateThroughput(
              ncStats.inBytes,
              ncStats.outBytes
            ),
          },
        };

        // Check thresholds and generate alerts
        const alerts = checkThresholds(stats, connectionInfo, config);

        // Perform connectivity tests if enabled
        let connectivityTests = {};
        if (config.enableConnectivityTests) {
          connectivityTests = await performConnectivityTests(natsnc);
          if (connectivityTests.failed > 0) {
            alerts.push({
              level: 'error',
              type: 'connectivity',
              message: `${connectivityTests.failed} connectivity tests failed`,
              value: connectivityTests.failed,
              details: connectivityTests.results,
            });
          }
        }

        // Create enhanced health status message
        const healthStatus = {
          status: alerts.length > 0 ? 'warning' : 'healthy',
          timestamp: Date.now(),
          server: extendedServerInfo,
          connection: connectionInfo,
          stats: stats,
          alerts: alerts,
          connectivityTests: connectivityTests,
          summary: generateSummary(stats, connectionInfo, alerts),
        };

        // Send health status
        const msg = {
          payload: healthStatus,
          topic: 'nats.health',
          status: 'success',
        };

        node.send(msg);
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `healthy (${latency}ms)`,
        });
      } catch (err) {
        const errorStatus = {
          status: 'unhealthy',
          timestamp: Date.now(),
          error: {
            message: err.message,
            code: err.code,
            name: err.name,
          },
        };

        const msg = {
          payload: errorStatus,
          topic: 'nats.health',
          status: 'error',
        };

        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'unhealthy' });
      }
    };

    // ==================== INITIALIZATION ====================

    // Auto-start service if configured. startService() awaits
    // getConnection() internally, so it naturally waits for the first
    // connection rather than needing a delay-then-poll timer here.
    if (config.mode === 'service' && config.autoStart) {
      const autoStart = async () => {
        try {
          await startService();
        } catch (err) {
          if (!closing) {
            node.error(`[SERVICE] Failed to start service: ${err.message}`);
          }
        }
      };
      autoStart();
    } else if (config.mode === 'health') {
      // Initial health check
      if (config.checkOnStart) {
        void (async () => {
          try {
            // Bounded wait: connect timeout is the deadline when the broker
            // never comes up. The config node keeps retrying; this check
            // must not wait forever. performHealthCheck reports disconnected
            // if we still aren't up when the deadline fires.
            const deadlineMs = this.serverConfig.connectTimeout || 10000;
            await Promise.race([
              this.serverConfig.getConnection().catch(() => {}),
              new Promise(resolve => {
                setTimeout(resolve, deadlineMs);
              }),
            ]);
            if (!closing) await performHealthCheck();
          } catch (err) {
            if (!closing)
              node.warn(
                `[SERVICE] Initial health check failed: ${err.message}`
              );
          }
        })();
      }
      // Periodic health check if enabled
      if (config.periodicCheck && config.checkInterval > 0) {
        healthCheckInterval = setInterval(
          performHealthCheck,
          config.checkInterval * 1000
        );
      }
    } else {
      node.status({ fill: 'grey', shape: 'ring', text: 'ready' });
    }

    // ==================== INPUT HANDLER ====================

    node.on('input', async function (msg, send, done) {
      try {
        // For service mode, only handle start/stop operations
        // Service requests are handled automatically by the endpoint handler
        if (config.mode === 'service') {
          const operation = msg.operation;

          if (operation === 'start') {
            await startService();
            msg.payload = {
              operation: 'start',
              success: true,
              running: isServiceRunning,
            };
            send(msg);
            done();
            return;
          }

          if (operation === 'stop') {
            await stopService();
            msg.payload = {
              operation: 'stop',
              success: true,
              running: isServiceRunning,
            };
            send(msg);
            done();
            return;
          }

          if (operation === 'reset') {
            if (!service) {
              done(new Error('Cannot reset - service is not running'));
              return;
            }
            // service.reset() only clears the library's own per-endpoint
            // stats (what the 'stats' operation queries over the network).
            // This node also keeps its own local counters for status-text
            // painting - reset those too, or the status dot would keep
            // showing a stale request count while a network stats query
            // already reports zero.
            service.reset();
            serviceStats = {
              requests: 0,
              errors: 0,
              avgProcessingTime: 0,
              lastRequest: null,
            };
            msg.payload = { operation: 'reset', success: true };
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `${config.serviceName || 'default-service'} (running)`,
            });
            send(msg);
            done();
            return;
          }

          // For service mode, ignore other operations (service runs automatically)
          // Requests come through the endpoint handler, not the input handler
          done();
          return;
        }

        // For other modes, handle operations normally
        const operation =
          msg.operation || config.operation || config.mode || 'discover';

        switch (operation) {
          case 'start':
            await startService();
            msg.payload = {
              operation: 'start',
              success: true,
              running: isServiceRunning,
            };
            send(msg);
            break;

          case 'stop':
            await stopService();
            msg.payload = {
              operation: 'stop',
              success: true,
              running: isServiceRunning,
            };
            send(msg);
            break;

          case 'discover': {
            const services = await discoverServices();
            msg.payload = services;
            msg.operation = 'discover';
            msg.count = services.length;
            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `${services.length} services`,
            });
            send(msg);
            break;
          }

          case 'stats': {
            const statsResult = await getServiceStats();
            msg.payload = statsResult;
            msg.operation = 'stats';
            msg.count = statsResult.length;
            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `${statsResult.length} services`,
            });
            send(msg);
            break;
          }

          case 'ping': {
            const pingServiceName = msg.serviceName || discoveryFilter;
            nc = await node.serverConfig.getConnection();
            const client = new Svcm(nc).client();
            const pingResults = [];
            const filter =
              pingServiceName === '*' || !pingServiceName
                ? undefined
                : pingServiceName;

            for await (const info of await client.ping(filter)) {
              pingResults.push({
                name: info.name,
                id: info.id,
                version: info.version,
                type: info.type || 'service',
              });
            }

            msg.payload = pingResults;
            msg.operation = 'ping';
            msg.count = pingResults.length;
            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `${pingResults.length} services`,
            });
            send(msg);
            break;
          }

          case 'health':
            await performHealthCheck();
            break;

          case 'nats-stats': {
            const statsType = msg.statsType || config.statsType || 'server';
            const natsStatsResult = await getNatsStats(statsType);
            msg.payload = natsStatsResult;
            msg.operation = 'nats-stats';
            msg.statsType = statsType;
            node.status({
              fill: 'blue',
              shape: 'dot',
              text: `stats: ${statsType}`,
            });
            send(msg);
            break;
          }

          default:
            done(new Error(`Unknown operation: ${operation}`));
            return;
        }
        done();
      } catch (err) {
        msg.error = err.message;
        send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      }
    });

    // ==================== CLEANUP ====================

    node.on('close', async function (done) {
      closing = true;
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      let closeError;
      try {
        await stopService();
      } catch (err) {
        closeError = err;
      } finally {
        detachStatus();
        this.serverConfig.unregisterConnectionUser(node.id);
        node.status({});
        done(closeError);
      }
    });
  }

  RED.nodes.registerType('nats-suite-service', NatsServiceNode);
};
