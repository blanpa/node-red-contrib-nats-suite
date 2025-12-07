'use strict';

const { StringCodec } = require('nats');

module.exports = function (RED) {
  function NatsServiceNode(config) {
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

    let nc = null;
    let service = null;
    const sc = StringCodec();
    const isDebug = !!config.debug;

    // Service state
    let isServiceRunning = false;
    let serviceStats = {
      requests: 0,
      errors: 0,
      avgProcessingTime: 0,
      lastRequest: null
    };

    // Health check state
    let healthCheckInterval = null;

    // Register with connection pool
    this.serverConfig.registerConnectionUser(node.id);

    // Status listener for connection changes
    const statusListener = (statusInfo) => {
      const status = statusInfo.status || statusInfo;
      
      switch (status) {
        case 'connected':
          if (config.mode === 'service' && config.autoStart) {
            startService();
          } else if (config.mode === 'health') {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
          }
          break;
        case 'disconnected':
          node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
          if (service) {
            stopService();
          }
          break;
        case 'connecting':
          node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
          break;
      }
    };

    this.serverConfig.addStatusListener(statusListener);

    // ==================== SERVICE FUNCTIONS ====================

    // Helper: Start service
    const startService = async () => {
      if (isServiceRunning) {
        node.warn('[SERVICE] Service already running');
        return;
      }

      try {
        nc = await node.serverConfig.getConnection();
        
        const serviceName = config.serviceName || 'default-service';
        const version = config.serviceVersion || '1.0.0';
        const description = config.serviceDescription || '';

        // Create service config
        const serviceConfig = {
          name: serviceName,
          version: version,
          description: description,
          queue: config.queueGroup || serviceName
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
        service = await nc.services.add(serviceConfig);
        isServiceRunning = true;

        // Add endpoint
        const endpoint = config.endpoint || 'process';
        const subject = config.endpointSubject || `${serviceName}.${endpoint}`;

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
            const requestData = sc.decode(msg.data);
            let payload;
            try {
              payload = JSON.parse(requestData);
            } catch (e) {
              payload = requestData;
            }

            if (isDebug) {
              node.log(`[SERVICE] Request received on ${subject}: ${JSON.stringify(payload)}`);
            }

            // Build output message
            const outMsg = {
              payload: payload,
              subject: msg.subject,
              service: serviceName,
              endpoint: endpoint,
              respond: (response) => {
                try {
                  const responseData = typeof response === 'string' ? response : JSON.stringify(response);
                  msg.respond(sc.encode(responseData));
                  
                  // Update stats
                  const processingTime = Date.now() - startTime;
                  serviceStats.avgProcessingTime = 
                    (serviceStats.avgProcessingTime * (serviceStats.requests - 1) + processingTime) / serviceStats.requests;
                  
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
                    code: code || 'SERVICE_ERROR'
                  };
                  msg.respond(sc.encode(JSON.stringify(errorResponse)));
                } catch (err) {
                  node.error(`[SERVICE] Failed to send error response: ${err.message}`);
                }
              }
            };

            // Send to output for processing
            node.send(outMsg);
            
            // Update status
            node.status({ 
              fill: 'green', 
              shape: 'dot', 
              text: `${serviceName} (${serviceStats.requests} reqs)` 
            });

          } catch (err) {
            serviceStats.errors++;
            node.error(`[SERVICE] Handler error: ${err.message}`);
            
            try {
              msg.respond(sc.encode(JSON.stringify({
                error: 'Internal service error',
                code: 'INTERNAL_ERROR'
              })));
            } catch (respondErr) {
              node.error(`[SERVICE] Failed to send error response: ${respondErr.message}`);
            }
          }
        };

        // Add endpoint to service
        await service.addEndpoint(endpoint, endpointHandler);

        node.log(`[SERVICE] Service started: ${serviceName} v${version}`);
        node.log(`[SERVICE] Endpoint: ${subject}`);
        node.status({ fill: 'green', shape: 'dot', text: `${serviceName} (running)` });

      } catch (err) {
        node.error(`[SERVICE] Failed to start service: ${err.message}`);
        node.status({ fill: 'red', shape: 'ring', text: 'start failed' });
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

        node.log('[SERVICE] Service stopped');
        node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });

      } catch (err) {
        node.error(`[SERVICE] Failed to stop service: ${err.message}`);
      }
    };

    // Helper: Service discovery
    const discoverServices = async () => {
      try {
        nc = await node.serverConfig.getConnection();
        
        const serviceName = config.serviceName || '*';
        const services = [];

        // Ping services
        const infos = await nc.services.ping(serviceName === '*' ? undefined : serviceName);

        for (const info of infos) {
          services.push({
            name: info.name,
            id: info.id,
            version: info.version,
            type: info.type,
            metadata: info.metadata || {}
          });
        }

        return services;

      } catch (err) {
        node.error(`[SERVICE] Discovery failed: ${err.message}`);
        throw err;
      }
    };

    // Helper: Service stats
    const getServiceStats = async () => {
      try {
        nc = await node.serverConfig.getConnection();
        
        const serviceName = config.serviceName || '*';
        const stats = [];

        // Get stats for services
        const infos = await nc.services.stats(serviceName === '*' ? undefined : serviceName);

        for (const info of infos) {
          stats.push({
            name: info.name,
            id: info.id,
            version: info.version,
            endpoints: info.endpoints || [],
            stats: info.stats || {}
          });
        }

        return stats;

      } catch (err) {
        node.error(`[SERVICE] Stats failed: ${err.message}`);
        throw err;
      }
    };

    // ==================== NATS STATS FUNCTIONS ====================

    // Get NATS server/connection statistics
    const getNatsStats = async (statsType) => {
      try {
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
              reconnects: stats.reconnects
            };
          }

          case 'jetstream': {
            const jsm = await nc.jetstreamManager();
            const accountInfo = await jsm.account.info();
            return {
              type: 'jetstream',
              memory: accountInfo.memory,
              store: accountInfo.store,
              api: accountInfo.api,
              limits: accountInfo.limits
            };
          }

          case 'connections': {
            const serverInfo = nc.info;
            return {
              type: 'connections',
              server_id: serverInfo.server_id,
              version: serverInfo.version,
              connections: serverInfo.connections || 0
            };
          }

          case 'all': {
            const stats = nc.stats();
            const jsm = await nc.jetstreamManager();
            const accountInfo = await jsm.account.info();
            const serverInfo = nc.info;
            
            return {
              type: 'all',
              server: {
                inMsgs: stats.inMsgs,
                outMsgs: stats.outMsgs,
                inBytes: stats.inBytes,
                outBytes: stats.outBytes,
                reconnects: stats.reconnects
              },
              jetstream: {
                memory: accountInfo.memory,
                store: accountInfo.store,
                api: accountInfo.api,
                limits: accountInfo.limits
              },
              connections: {
                server_id: serverInfo.server_id,
                version: serverInfo.version,
                connections: serverInfo.connections || 0
              }
            };
          }

          default:
            throw new Error(`Unknown stats type: ${type}`);
        }
      } catch (err) {
        node.error(`[STATS] Failed to get stats: ${err.message}`);
        throw err;
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
          threshold: config.latencyThreshold || 100
        });
      }
      
      // Reconnect threshold
      if (stats.reconnects > (config.reconnectThreshold || 5)) {
        alerts.push({
          level: 'warning',
          type: 'reconnects',
          message: `High reconnect count: ${stats.reconnects}`,
          value: stats.reconnects,
          threshold: config.reconnectThreshold || 5
        });
      }
      
      // Throughput threshold
      if (stats.throughput.messagesPerSecond > (config.throughputThreshold || 1000)) {
        alerts.push({
          level: 'info',
          type: 'throughput',
          message: `High throughput: ${stats.throughput.messagesPerSecond} msg/s`,
          value: stats.throughput.messagesPerSecond,
          threshold: config.throughputThreshold || 1000
        });
      }
      
      return alerts;
    };

    const generateSummary = (stats, connectionInfo, alerts) => {
      const summary = {
        overall: alerts.length === 0 ? 'healthy' : 'warning',
        connection: connectionInfo.connected ? 'stable' : 'unstable',
        performance: connectionInfo.latency < 50 ? 'excellent' : 
                    connectionInfo.latency < 100 ? 'good' : 'poor',
        activity: stats.inMsgs + stats.outMsgs > 1000 ? 'high' : 
                 stats.inMsgs + stats.outMsgs > 100 ? 'moderate' : 'low'
      };
      
      return summary;
    };

    const performConnectivityTests = async (natsnc, config) => {
      const results = [];
      let passed = 0;
      let failed = 0;
      
      try {
        // Test 1: Basic publish/subscribe
        const testSubject = 'health.test.pubsub';
        const testMessage = { test: 'connectivity', timestamp: Date.now() };
        
        const subscription = natsnc.subscribe(testSubject);
        const receivedMessages = [];
        
        const messageCollector = (async () => {
          try {
            for await (const msg of subscription) {
              receivedMessages.push(msg);
              break;
            }
          } catch (err) {
            // Subscription cancelled - normal for tests
          }
        })();
        
        natsnc.publish(testSubject, sc.encode(JSON.stringify(testMessage)));
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (receivedMessages.length > 0) {
          results.push({ test: 'publish_subscribe', status: 'passed', latency: '100ms' });
          passed++;
        } else {
          results.push({ test: 'publish_subscribe', status: 'failed', error: 'No message received' });
          failed++;
        }
        
        subscription.unsubscribe();
        
        // Test 2: Request/Response
        const requestSubject = 'health.test.request';
        const requestMessage = { test: 'request_response', timestamp: Date.now() };
        
        const responseSub = natsnc.subscribe(requestSubject);
        const responseHandler = (async () => {
          try {
            for await (const msg of responseSub) {
              if (msg.reply) {
                const response = { response: 'ok', timestamp: Date.now() };
                natsnc.publish(msg.reply, sc.encode(JSON.stringify(response)));
              }
            }
          } catch (err) {
            // Subscription cancelled - normal for tests
          }
        })();
        
        const requestStart = Date.now();
        const response = await natsnc.request(requestSubject, sc.encode(JSON.stringify(requestMessage)), {
          timeout: 1000
        });
        const requestLatency = Date.now() - requestStart;
        
        if (response) {
          results.push({ test: 'request_response', status: 'passed', latency: `${requestLatency}ms` });
          passed++;
        } else {
          results.push({ test: 'request_response', status: 'failed', error: 'No response received' });
          failed++;
        }
        
        responseSub.unsubscribe();
        
      } catch (error) {
        results.push({ test: 'connectivity', status: 'failed', error: error.message });
        failed++;
      }
      
      return {
        total: passed + failed,
        passed,
        failed,
        results
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
              message: 'Cannot perform health check - NATS server is not connected',
              code: 'NOT_CONNECTED',
              connectionStatus: this.serverConfig.connectionStatus,
              reconnectAttempts: this.serverConfig.connectionStats.reconnectAttempts
            }
          };
          
          const msg = {
            payload: errorStatus,
            topic: 'nats.health',
            status: 'disconnected'
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
          tlsAvailable: serverInfo.tls_available || false
        };
        
        // Enhanced connection info
        const connectionInfo = {
          connected: natsnc.connected,
          draining: natsnc.draining,
          closed: natsnc.closed,
          latency: latency,
          uptime: natsnc.stats.reconnects === 0 ? 'stable' : `${natsnc.stats.reconnects} reconnects`,
          lastError: natsnc.stats.reconnects > 0 ? 'Connection was unstable' : null
        };
        
        // Enhanced statistics
        const stats = {
          inMsgs: natsnc.stats.inMsgs,
          outMsgs: natsnc.stats.outMsgs,
          inBytes: natsnc.stats.inBytes,
          outBytes: natsnc.stats.outBytes,
          reconnects: natsnc.stats.reconnects,
          pending: natsnc.stats.pending,
          pings: natsnc.stats.pings,
          pongs: natsnc.stats.pongs,
          throughput: {
            messagesPerSecond: calculateThroughput(natsnc.stats.inMsgs, natsnc.stats.outMsgs),
            bytesPerSecond: calculateThroughput(natsnc.stats.inBytes, natsnc.stats.outBytes)
          }
        };
        
        // Check thresholds and generate alerts
        const alerts = checkThresholds(stats, connectionInfo, config);
        
        // Perform connectivity tests if enabled
        let connectivityTests = {};
        if (config.enableConnectivityTests) {
          connectivityTests = await performConnectivityTests(natsnc, config);
          if (connectivityTests.failed > 0) {
            alerts.push({
              level: 'error',
              type: 'connectivity',
              message: `${connectivityTests.failed} connectivity tests failed`,
              value: connectivityTests.failed,
              details: connectivityTests.results
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
          summary: generateSummary(stats, connectionInfo, alerts)
        };

        // Send health status
        const msg = {
          payload: healthStatus,
          topic: 'nats.health',
          status: 'success'
        };

        node.send(msg);
        node.status({ fill: 'green', shape: 'dot', text: `healthy (${latency}ms)` });

      } catch (err) {
        const errorStatus = {
          status: 'unhealthy',
          timestamp: Date.now(),
          error: {
            message: err.message,
            code: err.code,
            name: err.name
          }
        };

        const msg = {
          payload: errorStatus,
          topic: 'nats.health',
          status: 'error'
        };

        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'unhealthy' });
      }
    };

    // ==================== INITIALIZATION ====================

    // Auto-start service if configured
    if (config.mode === 'service' && config.autoStart) {
      setTimeout(() => {
        if (this.serverConfig.connectionStatus === 'connected') {
          startService();
        }
      }, 500);
    } else if (config.mode === 'health') {
      // Initial health check
      if (config.checkOnStart) {
        setTimeout(performHealthCheck, 2000);
      }
      // Periodic health check if enabled
      if (config.periodicCheck && config.checkInterval > 0) {
        healthCheckInterval = setInterval(performHealthCheck, config.checkInterval * 1000);
      }
    } else {
      node.status({ fill: 'grey', shape: 'ring', text: 'ready' });
    }

    // ==================== INPUT HANDLER ====================

    node.on('input', async function (msg) {
      try {
        const operation = msg.operation || config.operation || config.mode || 'discover';

        switch (operation) {
          case 'start':
            await startService();
            msg.payload = { operation: 'start', success: true, running: isServiceRunning };
            node.send(msg);
            break;

          case 'stop':
            await stopService();
            msg.payload = { operation: 'stop', success: true, running: isServiceRunning };
            node.send(msg);
            break;

          case 'discover':
            const services = await discoverServices();
            msg.payload = services;
            msg.operation = 'discover';
            msg.count = services.length;
            node.status({ fill: 'blue', shape: 'dot', text: `${services.length} services` });
            node.send(msg);
            break;

          case 'stats':
            const statsResult = await getServiceStats();
            msg.payload = statsResult;
            msg.operation = 'stats';
            msg.count = statsResult.length;
            node.status({ fill: 'blue', shape: 'dot', text: `${statsResult.length} services` });
            node.send(msg);
            break;

          case 'ping':
            const serviceName = msg.serviceName || config.serviceName;
            nc = await node.serverConfig.getConnection();
            const pingResults = await nc.services.ping(serviceName);
            msg.payload = pingResults;
            msg.operation = 'ping';
            msg.count = pingResults.length;
            node.send(msg);
            break;

          case 'health':
            await performHealthCheck();
            break;

          case 'nats-stats': {
            const statsType = msg.statsType || config.statsType || 'server';
            const natsStatsResult = await getNatsStats(statsType);
            msg.payload = natsStatsResult;
            msg.operation = 'nats-stats';
            msg.statsType = statsType;
            node.status({ fill: 'blue', shape: 'dot', text: `stats: ${statsType}` });
            node.send(msg);
            break;
          }

          default:
            node.error(`Unknown operation: ${operation}`);
            return;
        }

      } catch (err) {
        node.error(`Service operation failed: ${err.message}`, msg);
        msg.error = err.message;
        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // ==================== CLEANUP ====================

    node.on('close', async function () {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
      }
      await stopService();
      this.serverConfig.removeStatusListener(statusListener);
      this.serverConfig.unregisterConnectionUser(node.id);
      node.status({});
    });
  }

  RED.nodes.registerType('nats-suite-service', NatsServiceNode);
};
