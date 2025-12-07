'use strict';

const { StringCodec } = require('nats');

module.exports = function (RED) {
  function NatsHealthNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Define status functions
    const setStatusRed = () => {
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
    };

    const setStatusGreen = () => {
      node.status({ fill: 'green', shape: 'dot', text: 'connected' });
    };

    const setStatusYellow = () => {
      node.status({ fill: 'yellow', shape: 'ring', text: 'checking' });
    };

    setStatusRed();

    // Validate server configuration ID
    if (!config.server) {
      node.error('NATS server configuration not selected. Please select a NATS server node.');
      setStatusRed();
      return;
    }
    
    this.config = RED.nodes.getNode(config.server);

    // Validate server configuration
    if (!this.config) {
      node.error('NATS server configuration not found. Please configure a NATS server node.');
      setStatusRed();
      return;
    }

    // Add status listener to server config
    const statusListener = (status) => {
      switch (status) {
        case 'connected':
          setStatusGreen();
          break;
        case 'disconnected':
          setStatusRed();
          break;
        case 'connecting':
          setStatusYellow();
          break;
      }
    };

    this.config.addStatusListener(statusListener);
    
    // Connection Pool: Register this node as connection user
    this.config.registerConnectionUser(node.id);

    // Create StringCodec once for performance
    const sc = StringCodec();

    // Helper functions for enhanced health monitoring
    const calculateThroughput = (inValue, outValue) => {
      const total = inValue + outValue;
      // Simple calculation - in real scenarios you'd track over time
      return total > 0 ? Math.round(total / 10) : 0; // Rough estimate
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
        // Test 1: Basic publish/subscribe (modernized with Async Iterator)
        const testSubject = 'health.test.pubsub';
        const testMessage = { test: 'connectivity', timestamp: Date.now() };
        
        const subscription = natsnc.subscribe(testSubject);
        const receivedMessages = [];
        
        // Modern Async Iterator for message handling
        const messageCollector = (async () => {
          try {
            for await (const msg of subscription) {
              receivedMessages.push(msg);
              break; // Only first message for test
            }
          } catch (err) {
            // Subscription cancelled - normal for tests
          }
        })();
        
        // Publish test message
        natsnc.publish(testSubject, sc.encode(JSON.stringify(testMessage)));
        
        // Wait for message
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (receivedMessages.length > 0) {
          results.push({ test: 'publish_subscribe', status: 'passed', latency: '100ms' });
          passed++;
        } else {
          results.push({ test: 'publish_subscribe', status: 'failed', error: 'No message received' });
          failed++;
        }
        
        subscription.unsubscribe();
        
        // Test 2: Request/Response (modernized with Async Iterator)
        const requestSubject = 'health.test.request';
        const requestMessage = { test: 'request_response', timestamp: Date.now() };
        
        // Set up response handler with Async Iterator
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
        
        // Send request
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
        setStatusYellow();
        
        // Check connection status BEFORE attempting health check
        if (this.config.connectionStatus !== 'connected') {
          const errorStatus = {
            status: 'disconnected',
            timestamp: Date.now(),
            error: {
              message: 'Cannot perform health check - NATS server is not connected',
              code: 'NOT_CONNECTED',
              connectionStatus: this.config.connectionStatus,
              reconnectAttempts: this.config.connectionStats.reconnectAttempts
            }
          };
          
          const msg = {
            payload: errorStatus,
            topic: 'nats.health',
            status: 'disconnected'
          };
          
          node.send(msg);
          setStatusRed();
          return; // Skip health check when not connected
        }
        
        const natsnc = await this.config.getConnection();
        
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
          // Extended info
          maxPayload: serverInfo.max_payload,
          protocol: serverInfo.proto,
          serverId: serverInfo.server_id,
          gitCommit: serverInfo.git_commit,
          goVersion: serverInfo.go,
          host: serverInfo.host,
          port: serverInfo.port,
          // Cluster info
          clusterPort: serverInfo.cluster_port,
          clusterConnectUrls: serverInfo.connect_urls || [],
          // JetStream info (if available)
          jetStream: serverInfo.jetstream || false,
          // TLS info
          tlsRequired: serverInfo.tls_required || false,
          tlsVerify: serverInfo.tls_verify || false,
          tlsAvailable: serverInfo.tls_available || false
        };
        
        // Enhanced connection info
        const connectionInfo = {
          connected: natsnc.connected,
          draining: natsnc.draining,
          closed: natsnc.closed,
          // Extended connection details
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
          // Extended stats
          pending: natsnc.stats.pending,
          pings: natsnc.stats.pings,
          pongs: natsnc.stats.pongs,
          // Calculated metrics
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
          // Add connectivity test alerts
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
        setStatusGreen();

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
        setStatusRed();
      }
    };

    // Handle input messages
    node.on('input', async function (msg) {
      await performHealthCheck();
    });

    // Periodic health check if enabled
    let healthCheckInterval = null;
    if (config.periodicCheck && config.checkInterval > 0) {
      healthCheckInterval = setInterval(performHealthCheck, config.checkInterval * 1000);
    }

    // Initial health check
    if (config.checkOnStart) {
      setTimeout(performHealthCheck, 2000); // Wait 2 seconds for initial connection
    }

    // Cleanup on close
    node.on('close', function (done) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
      }
      this.config.removeStatusListener(statusListener);
      // Connection Pool: Unregister this node as connection user
      this.config.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-health', NatsHealthNode);
};
