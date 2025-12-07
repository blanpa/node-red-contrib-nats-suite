const { connect, StringCodec, credsAuthenticator } = require('nats');
const fs = require('fs');
const path = require('path');

module.exports = function (RED) {
  function NatsServerNode(n) {
    RED.nodes.createNode(this, n);
    this.server = n.server;
    
    // Get credentials from Node-RED credentials store (secure)
    this.authMethod = n.authMethod || 'userpass';
    this.user = this.credentials.user || '';
    this.pass = this.credentials.pass || '';
    this.token = this.credentials.token || '';
    this.jwt = this.credentials.jwt || '';
    this.nkeySeed = this.credentials.nkeySeed || '';
    
    // TLS Configuration
    this.enableTLS = !!n.enableTLS;
    this.tlsRejectUnauthorized = n.tlsRejectUnauthorized !== false; // Default true
    this.tlsCaFile = n.tlsCaFile || '';
    this.tlsCertFile = n.tlsCertFile || '';
    this.tlsKeyFile = n.tlsKeyFile || '';
    
    const isDebug = !!n.debug;
    
    if (isDebug) {
      this.log(`[NATS] Configuration loaded:`);
      this.log(`  - Auth Method: ${this.authMethod}`);
      this.log(`  - TLS Enabled: ${this.enableTLS}`);
      if (this.enableTLS) {
        this.log(`  - TLS CA File: ${this.tlsCaFile || 'none'}`);
        this.log(`  - TLS Cert File: ${this.tlsCertFile || 'none'}`);
        this.log(`  - TLS Key File: ${this.tlsKeyFile || 'none'}`);
        this.log(`  - Verify Certificate: ${this.tlsRejectUnauthorized}`);
      }
    }
    
    // Debug connection info
    if (isDebug) this.log(`[NATS] Connecting to: ${this.server}`);
    this.connection = null;
    this.connectionStatus = 'disconnected';
    this.listeners = new Set();
    
    // Connection Pool: Track which nodes are using this connection
    this.connectionUsers = new Set(); // Set of node IDs using this connection
    this.connectionRefCount = 0; // Reference counter
    
    // Define helper functions early
    this.getUptime = () => {
      if (!this.connectionStats.connectionStartTime) {
        return 0;
      }
      return Date.now() - this.connectionStats.connectionStartTime;
    };

    this.formatUptime = (ms) => {
      if (ms === 0 || ms < 1000) return '';
      
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

    // Define emitStatusChange early
    this.emitStatusChange = () => {
      const statusInfo = {
        status: this.connectionStatus,
        reconnectAttempts: this.connectionStats.reconnectAttempts,
        maxReconnectAttempts: this.connectionStats.maxReconnectAttempts,
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime()),
        lastConnected: this.connectionStats.lastConnected,
        lastDisconnected: this.connectionStats.lastDisconnected,
        isReconnecting: isReconnecting,
        nextReconnectAttempt: reconnectTimer ? 'scheduled' : 'none'
      };
      
      // OPC UA-style status display
      let statusText = '';
      switch (this.connectionStatus) {
        case 'connected':
          statusText = 'connected';
          break;
        case 'disconnected':
          if (isReconnecting) {
            statusText = `reconnecting (${this.connectionStats.reconnectAttempts})`;
          } else {
            statusText = `disconnected (${this.connectionStats.reconnectAttempts})`;
          }
          break;
        case 'connecting':
          statusText = `connecting (${this.connectionStats.reconnectAttempts})`;
          break;
        default:
          statusText = this.connectionStatus;
      }
      
      // Note: Failsafe removed - reconnection is handled by exponential backoff timer
      // Automatic failsafe was causing duplicate reconnection attempts

      // Update node status like OPC UA
      this.status({ 
        fill: this.connectionStatus === 'connected' ? 'green' : 
              this.connectionStatus === 'connecting' ? 'yellow' : 'red',
        shape: this.connectionStatus === 'connected' ? 'dot' : 'ring',
        text: statusText
      });
      
      this.listeners.forEach(listener => listener(statusInfo));
    };
    
    // Connection tracking
    this.connectionStats = {
      reconnectAttempts: 0,
      maxReconnectAttempts: n.maxReconnectAttempts || 10,
      lastConnected: null,
      lastDisconnected: null,
      totalUptime: 0,
      totalDowntime: 0,
      connectionStartTime: null
    };

    const servers = this.server.split(',');

    // Build Connection Options
    const ConnectionOptions = {
      servers: servers,
      maxReconnectAttempts: 0, // Disable NATS-native reconnection completely, use custom logic instead
      reconnect: false, // Explicitly disable automatic reconnection
      waitOnFirstConnect: false, // Don't wait/retry on first connect, fail fast
      timeout: n.timeout || 10000, // 10 second timeout
      pingInterval: n.pingInterval || 30000, // 30 second ping interval
      maxPingOut: n.maxPingOut || 3, // Max ping outs before disconnect
    };

    // Authentication Configuration
    try {
      switch (this.authMethod) {
        case 'userpass':
          if (this.user) {
            ConnectionOptions.user = this.user;
            ConnectionOptions.pass = this.pass || '';
            if (isDebug) this.log(`[NATS] Using username/password authentication`);
          }
          break;

        case 'token':
          if (this.token) {
            ConnectionOptions.token = this.token;
            if (isDebug) this.log(`[NATS] Using token authentication`);
          }
          break;

        case 'jwt':
          if (this.jwt && this.nkeySeed) {
            // JWT requires both JWT and NKey seed
            ConnectionOptions.authenticator = credsAuthenticator(
              new TextEncoder().encode(this.jwt),
              new TextEncoder().encode(this.nkeySeed)
            );
            if (isDebug) this.log(`[NATS] Using JWT authentication`);
          } else if (this.jwt) {
            this.warn('[NATS] JWT authentication requires both JWT token and NKey seed. Missing NKey seed.');
          }
          break;

        case 'nkey':
          if (this.nkeySeed) {
            // NKey authentication
            ConnectionOptions.authenticator = credsAuthenticator(
              new TextEncoder().encode(this.nkeySeed)
            );
            if (isDebug) this.log(`[NATS] Using NKey authentication`);
          }
          break;

        case 'none':
        default:
          if (isDebug) this.log(`[NATS] No authentication configured`);
          break;
      }
    } catch (authErr) {
      this.error(`[NATS] Authentication configuration error: ${authErr.message}`);
      if (isDebug) this.log(`[NATS] Auth error stack: ${authErr.stack}`);
    }

    // TLS Configuration
    if (this.enableTLS) {
      ConnectionOptions.tls = {
        rejectUnauthorized: this.tlsRejectUnauthorized
      };

      try {
        // Load CA certificate if provided
        if (this.tlsCaFile && fs.existsSync(this.tlsCaFile)) {
          ConnectionOptions.tls.ca = fs.readFileSync(this.tlsCaFile);
          if (isDebug) this.log(`[NATS] Loaded CA certificate from: ${this.tlsCaFile}`);
        }

        // Load client certificate if provided (for mTLS)
        if (this.tlsCertFile && fs.existsSync(this.tlsCertFile)) {
          ConnectionOptions.tls.cert = fs.readFileSync(this.tlsCertFile);
          if (isDebug) this.log(`[NATS] Loaded client certificate from: ${this.tlsCertFile}`);
        }

        // Load client key if provided (for mTLS)
        if (this.tlsKeyFile && fs.existsSync(this.tlsKeyFile)) {
          ConnectionOptions.tls.key = fs.readFileSync(this.tlsKeyFile);
          if (isDebug) this.log(`[NATS] Loaded client key from: ${this.tlsKeyFile}`);
        }

        if (isDebug) {
          this.log(`[NATS] TLS enabled with:`);
          this.log(`  - Reject Unauthorized: ${this.tlsRejectUnauthorized}`);
          this.log(`  - CA Certificate: ${this.tlsCaFile ? 'loaded' : 'none'}`);
          this.log(`  - Client Certificate: ${this.tlsCertFile ? 'loaded' : 'none'}`);
          this.log(`  - Client Key: ${this.tlsKeyFile ? 'loaded' : 'none'}`);
        }

        // Security Warning: Check if production connection without TLS
        if (!this.enableTLS && this.server && 
            (this.server.includes('production') || this.server.includes('prod') || 
             !this.server.includes('localhost') && !this.server.includes('127.0.0.1'))) {
          this.warn('⚠️ WARNING: Production connection without TLS encryption! Consider enabling TLS for security.');
        }
      } catch (tlsErr) {
        this.error(`[NATS] TLS configuration error: ${tlsErr.message}`);
        if (isDebug) this.log(`[NATS] TLS error stack: ${tlsErr.stack}`);
      }
    } else {
      if (isDebug) this.log(`[NATS] TLS is disabled for this connection`);
      ConnectionOptions.tls = null;
    }

    const connectNats = async () => {
      try {
        this.connectionStatus = 'connecting';
        this.connectionStats.reconnectAttempts++;
        this.emitStatusChange();
        
        // Start connection timeout warning
        const connectionStartTime = Date.now();
        const connectionTimeout = setTimeout(() => {
          const elapsed = Math.floor((Date.now() - connectionStartTime) / 1000);
          if (isDebug) this.log(`[NATS] WARNING: Connection attempt taking longer than expected (${elapsed}s)`);
          this.warn(`NATS connection attempt taking longer than expected (${elapsed}s). Check server availability.`);
        }, 10000);
        
        // Log connection attempt with auth method and TLS info
        let authInfo = 'no authentication';
        switch (this.authMethod) {
          case 'userpass':
            authInfo = this.user ? `username/password (user: ***)` : 'no authentication';
            break;
          case 'token':
            authInfo = this.token ? 'token authentication (***)' : 'no authentication';
            break;
          case 'jwt':
            authInfo = this.jwt ? 'JWT authentication (***+***)' : 'no authentication';
            break;
          case 'nkey':
            authInfo = this.nkeySeed ? 'NKey authentication (***)' : 'no authentication';
            break;
        }
        
        const tlsInfo = this.enableTLS ? 'with TLS/SSL' : 'without TLS';
        
        if (isDebug) {
          this.log(`[NATS] Connection attempt ${this.connectionStats.reconnectAttempts}:`);
          this.log(`  - Servers: ${servers.join(', ')}`);
          this.log(`  - Auth: ${authInfo}`);
          this.log(`  - Security: ${tlsInfo}`);
          this.log(`  - Timeout: ${n.timeout || 10000}ms`);
        }
        

        
        this.connection = await connect(ConnectionOptions);
        if (isDebug) this.log(`[NATS] Connection established successfully!`);

        // Monitor connection status
        (async () => {
          for await (const s of this.connection.status()) {
            // Only log non-ping events to reduce noise
            if (s.type !== 'pingTimer' && isDebug) {
              this.log(`[NATS] Connection status event: ${s.type}`);
            }
            
            if (s.type === 'disconnect') {
              if (isDebug) this.log(`[NATS] Connection disconnected`);
              this.connectionStatus = 'disconnected';
              this.connectionStats.lastDisconnected = Date.now();
              this.connectionStats.connectionStartTime = null;
              this.emitStatusChange();
              // Trigger custom reconnection logic
              if (!isReconnecting) {
                setTimeout(() => startReconnection(), 0);
              }
            }
            if (s.type === 'error') {
              if (isDebug) this.log(`[NATS] Connection error:`, s.error);
              this.connectionStatus = 'disconnected';
              this.connectionStats.lastDisconnected = Date.now();
              this.emitStatusChange();
              // Trigger custom reconnection logic
              if (!isReconnecting) {
                setTimeout(() => startReconnection(), 0);
              }
            }
          }
        })().then();

        this.connectionStatus = 'connected';
        this.connectionStats.lastConnected = Date.now();
        this.connectionStats.connectionStartTime = Date.now();
        this.connectionStats.reconnectAttempts = 0; // Reset counter on successful connection
        this.emitStatusChange();
        
        // Clear connection timeout warning
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        
        return this.connection;
      } catch (err) {
        if (isDebug) this.log(`[NATS] Connection failed with error: ${err.message}`);
        if (isDebug) this.log(`[NATS] Error details:`, {
          name: err.name,
          code: err.code,
          stack: err.stack?.split('\n')[0]
        });
        
        this.connectionStatus = 'disconnected';
        this.connectionStats.lastDisconnected = Date.now();
        this.emitStatusChange();
        throw err;
      }
    };

    // OPC UA-style reconnection logic
    const self = this;
    let reconnectTimer = null;
    let isReconnecting = false;
    
    const startReconnection = () => {
      if (isReconnecting) {
        if (isDebug) self.log(`[NATS] Reconnection already in progress, skipping...`);
        return;
      }
      
      isReconnecting = true;
      if (isDebug) self.log(`[NATS] Starting reconnection attempt ${self.connectionStats.reconnectAttempts + 1}`);
      
      // Update status to show reconnecting
      self.connectionStatus = 'connecting';
      self.emitStatusChange();
      
      connectNats().then(() => {
        // Connection successful
        isReconnecting = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (isDebug) self.log(`[NATS] Reconnection successful!`);
        
        // Update status to show connected
        self.connectionStatus = 'connected';
        self.emitStatusChange();
      }).catch(err => {
        if (isDebug) self.log(`[NATS] Reconnection attempt ${self.connectionStats.reconnectAttempts} failed: ${err.message}`);
        
        // Update status to show disconnected and reconnecting
        self.connectionStatus = 'disconnected';
        self.emitStatusChange();
        
        // OPC UA-style exponential backoff with jitter
        const baseDelay = 5000; // 5 seconds base
        const maxDelay = 60000; // 60 seconds max
        const attempt = self.connectionStats.reconnectAttempts;
        
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s...
        // After reaching max delay, stay at 60s forever (infinite retries)
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        
        // Add jitter (±20%) to prevent thundering herd
        const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
        const finalDelay = Math.max(1000, exponentialDelay + jitter);
        
        if (isDebug) self.log(`[NATS] Reconnection attempt ${attempt} failed. Next attempt in ${Math.round(finalDelay/1000)}s (base: ${Math.round(exponentialDelay/1000)}s + jitter: ${Math.round(jitter/1000)}s)`);
        
        // Schedule next attempt (infinite retries)
        reconnectTimer = setTimeout(() => {
          isReconnecting = false;
          startReconnection();
        }, finalDelay);
      });
    };
    
    // Set initial status
    this.emitStatusChange();
    
    // Start initial connection
    startReconnection();

    this.getConnection = async () => {
      if (!this.connection) {
        await connectNats();
      }
      return this.connection;
    };
    
    // Connection Pool: Register a node as user of this connection
    this.registerConnectionUser = (nodeId) => {
      if (!nodeId) {
        if (isDebug) this.log(`[NATS] Warning: registerConnectionUser called without nodeId`);
        return;
      }
      
      const wasNew = !this.connectionUsers.has(nodeId);
      this.connectionUsers.add(nodeId);
      this.connectionRefCount = this.connectionUsers.size;
      
      if (wasNew && isDebug) {
        this.log(`[NATS] Node ${nodeId} registered as connection user (total: ${this.connectionRefCount})`);
      }
    };
    
    // Connection Pool: Unregister a node as user of this connection
    this.unregisterConnectionUser = (nodeId) => {
      if (!nodeId) {
        if (isDebug) this.log(`[NATS] Warning: unregisterConnectionUser called without nodeId`);
        return;
      }
      
      const hadUser = this.connectionUsers.has(nodeId);
      this.connectionUsers.delete(nodeId);
      this.connectionRefCount = this.connectionUsers.size;
      
      if (hadUser && isDebug) {
        this.log(`[NATS] Node ${nodeId} unregistered as connection user (remaining: ${this.connectionRefCount})`);
      }
      
      // Automatic cleanup: Close connection if no users left
      if (this.connectionRefCount === 0 && this.connection) {
        if (isDebug) this.log(`[NATS] No more connection users - scheduling connection cleanup in 30s`);
        
        // Wait 30 seconds before closing (in case new nodes are deployed)
        setTimeout(() => {
          if (this.connectionRefCount === 0 && this.connection) {
            if (isDebug) this.log(`[NATS] Closing unused connection`);
            
            // Stop reconnection attempts
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            isReconnecting = false;
            
            // Close connection
            this.connection.close();
            this.connection = null;
            this.connectionStatus = 'disconnected';
            this.emitStatusChange();
          }
        }, 30000);
      }
    };
    
    // Connection Pool: Get statistics
    this.getPoolStats = () => {
      return {
        activeUsers: this.connectionRefCount,
        userNodeIds: Array.from(this.connectionUsers),
        connectionActive: !!this.connection,
        connectionStatus: this.connectionStatus
      };
    };

    this.addStatusListener = listener => {
      this.listeners.add(listener);
      // Send current status to new listener (object form)
      listener({
        status: this.connectionStatus,
        reconnectAttempts: this.connectionStats.reconnectAttempts,
        maxReconnectAttempts: this.connectionStats.maxReconnectAttempts,
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime())
      });
    };

    this.removeStatusListener = listener => {
      this.listeners.delete(listener);
    };

    this.getConnectionStats = () => {
      return {
        ...this.connectionStats,
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime())
      };
    };

    this.on('close', () => {
      if (isDebug) this.log(`[NATS] Node closing, cleaning up connections...`);
      
      // Stop reconnection attempts
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      isReconnecting = false;
      
      // Close NATS connection
      if (this.connection) {
        this.connection.close();
        this.connection = null;
      }
      
      // Clear status
      this.status({});
    });
  }
  RED.nodes.registerType('nats-suite-server', NatsServerNode, {
    credentials: {
      user: { type: "text" },
      pass: { type: "password" },
      token: { type: "password" },
      jwt: { type: "password" },
      nkeySeed: { type: "password" }
    }
  });
};
