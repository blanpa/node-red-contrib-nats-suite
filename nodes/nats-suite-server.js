const { connect } = require('@nats-io/transport-node');
const { jwtAuthenticator, nkeyAuthenticator } = require('@nats-io/nats-core');
const fs = require('fs');

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

    // Message tracing (NATS-3.4-GAP-PLAN.md Step 2): one connection-level
    // switch, not a per-message option. The editor requires traceDestination
    // once enableTracing is checked, so "on but empty" can't be saved.
    this.enableTracing = !!n.enableTracing;
    this.traceDestination = (n.traceDestination || '').trim();

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
    if (this.authMethod === 'nkey' && this.nkeySeed.length == 0) {
      this.error(
        `[NATS] Auth Method: ${this.authMethod} requires the nkeySeed to be set.`
      );
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

    this.formatUptime = ms => {
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
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime()),
        lastConnected: this.connectionStats.lastConnected,
        lastDisconnected: this.connectionStats.lastDisconnected,
      };

      // OPC UA-style status display
      let statusText;
      switch (this.connectionStatus) {
        case 'connected':
          statusText = 'connected';
          break;
        case 'connecting':
          statusText = `connecting (${this.connectionStats.reconnectAttempts})`;
          break;
        case 'disconnected':
          statusText = `disconnected (${this.connectionStats.reconnectAttempts})`;
          break;
        default:
          statusText = this.connectionStatus;
      }

      // Update node status like OPC UA
      this.status({
        fill:
          this.connectionStatus === 'connected'
            ? 'green'
            : this.connectionStatus === 'connecting'
              ? 'yellow'
              : 'red',
        shape: this.connectionStatus === 'connected' ? 'dot' : 'ring',
        text: statusText,
      });

      this.listeners.forEach(listener => listener(statusInfo));
    };

    // Connection tracking
    this.connectionStats = {
      reconnectAttempts: 0,
      lastConnected: null,
      lastDisconnected: null,
      totalUptime: 0,
      totalDowntime: 0,
      connectionStartTime: null,
    };

    const servers = this.server.split(',');

    this.connectTimeout = parseInt(n.timeout, 10);
    if (!Number.isFinite(this.connectTimeout) || this.connectTimeout < 1000) {
      this.connectTimeout = 10000;
    }

    // Build Connection Options
    const ConnectionOptions = {
      servers: servers,
      reconnect: true, // Use the NATS client's native reconnect: backoff, jitter and server-pool
      // rotation are all handled internally - do not reimplement any of it here.
      maxReconnectAttempts: -1, // Never give up once a connection has been established
      reconnectTimeWait: n.reconnectTimeWait || 1000,
      waitOnFirstConnect: false, // Fail fast on the *first* connect attempt so getConnection() can
      // retry on demand instead of blocking; native reconnect above only
      // governs recovery after that first connection succeeds.
      timeout: this.connectTimeout,
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
            if (isDebug)
              this.log(`[NATS] Using username/password authentication`);
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
            // JWT requires both JWT and NKey seed. jwtAuthenticator (not
            // credsAuthenticator, which takes a single .creds blob) is what
            // matches this two-field UI: it takes the JWT string and the
            // NKey seed as separate arguments.
            ConnectionOptions.authenticator = jwtAuthenticator(
              this.jwt,
              new TextEncoder().encode(this.nkeySeed)
            );
            if (isDebug) this.log(`[NATS] Using JWT authentication`);
          } else if (this.jwt) {
            this.warn(
              '[NATS] JWT authentication requires both JWT token and NKey seed. Missing NKey seed.'
            );
          }
          break;

        case 'nkey':
          if (this.nkeySeed) {
            // NKey authentication
            ConnectionOptions.authenticator = nkeyAuthenticator(
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
      this.error(
        `[NATS] Authentication configuration error: ${authErr.message}`
      );
      if (isDebug) this.log(`[NATS] Auth error stack: ${authErr.stack}`);
    }

    // TLS Configuration
    if (this.enableTLS) {
      ConnectionOptions.tls = {
        rejectUnauthorized: this.tlsRejectUnauthorized,
      };

      try {
        // Load CA certificate if provided
        if (this.tlsCaFile && fs.existsSync(this.tlsCaFile)) {
          ConnectionOptions.tls.ca = fs.readFileSync(this.tlsCaFile);
          if (isDebug)
            this.log(`[NATS] Loaded CA certificate from: ${this.tlsCaFile}`);
        }

        // Load client certificate if provided (for mTLS)
        if (this.tlsCertFile && fs.existsSync(this.tlsCertFile)) {
          ConnectionOptions.tls.cert = fs.readFileSync(this.tlsCertFile);
          if (isDebug)
            this.log(
              `[NATS] Loaded client certificate from: ${this.tlsCertFile}`
            );
        }

        // Load client key if provided (for mTLS)
        if (this.tlsKeyFile && fs.existsSync(this.tlsKeyFile)) {
          ConnectionOptions.tls.key = fs.readFileSync(this.tlsKeyFile);
          if (isDebug)
            this.log(`[NATS] Loaded client key from: ${this.tlsKeyFile}`);
        }

        if (isDebug) {
          this.log(`[NATS] TLS enabled with:`);
          this.log(`  - Reject Unauthorized: ${this.tlsRejectUnauthorized}`);
          this.log(`  - CA Certificate: ${this.tlsCaFile ? 'loaded' : 'none'}`);
          this.log(
            `  - Client Certificate: ${this.tlsCertFile ? 'loaded' : 'none'}`
          );
          this.log(`  - Client Key: ${this.tlsKeyFile ? 'loaded' : 'none'}`);
        }
      } catch (tlsErr) {
        this.error(`[NATS] TLS configuration error: ${tlsErr.message}`);
        if (isDebug) this.log(`[NATS] TLS error stack: ${tlsErr.stack}`);
      }
    } else {
      if (isDebug) this.log(`[NATS] TLS is disabled for this connection`);
      ConnectionOptions.tls = null;
    }

    // Watch the connection's lifecycle events. Started exactly once below, right after the
    // connection object is created, since native reconnect keeps that object's identity stable
    // across every disconnect/reconnect cycle for as long as the connection lives.
    const watchConnectionStatus = async nc => {
      // 3.4.0 dropped the Events/DebugEvents enums entirely (verified: no
      // runtime export on @nats-io/nats-core, only `s.type` string literals
      // now - "disconnect", "reconnecting", "reconnect", "error", "ldm",
      // "staleConnection", "ping", "update", plus "close"/"slowConsumer"/
      // "forceReconnect" this node doesn't act on). Matching against the old
      // enum members here silently killed this whole watcher on the first
      // real event (case-label evaluation throws on `undefined.Disconnect`),
      // which is why reconnect status never left "connected" - reproduced
      // against a real docker-killed broker before this fix.
      for await (const s of nc.status()) {
        switch (s.type) {
          case 'disconnect':
            if (isDebug) this.log(`[NATS] Connection disconnected`);
            this.connectionStatus = 'disconnected';
            this.connectionStats.lastDisconnected = Date.now();
            this.connectionStats.connectionStartTime = null;
            this.emitStatusChange();
            break;

          case 'reconnecting':
            if (isDebug) this.log(`[NATS] Reconnecting...`);
            this.connectionStatus = 'connecting';
            this.connectionStats.reconnectAttempts++;
            this.emitStatusChange();
            break;

          case 'reconnect':
            if (isDebug) this.log(`[NATS] Reconnected`);
            this.connectionStatus = 'connected';
            this.connectionStats.lastConnected = Date.now();
            this.connectionStats.connectionStartTime = Date.now();
            this.connectionStats.reconnectAttempts = 0;
            this.emitStatusChange();
            break;

          case 'error':
            // Async error reported by the server (e.g. a permissions violation) - surface it,
            // don't swallow it. Connection status is unaffected here; a disconnect/reconnecting
            // event will follow separately if the connection is actually impacted.
            this.error(`[NATS] Connection error: ${s.error}`);
            break;

          case 'ldm':
            this.warn(
              '[NATS] Server is entering Lame Duck Mode; it will disconnect clients soon.'
            );
            break;

          case 'staleConnection':
            // Precedes an actual disconnect - treat it the same way so status reflects it early.
            if (isDebug)
              this.log(
                `[NATS] Stale connection detected, heading for a disconnect`
              );
            this.connectionStatus = 'disconnected';
            this.emitStatusChange();
            break;

          case 'ping':
            // Pure noise, fires constantly - ignore entirely.
            break;

          case 'update':
            if (isDebug)
              this.log(
                `[NATS] Cluster topology update: added=${JSON.stringify(s.added)} deleted=${JSON.stringify(s.deleted)}`
              );
            break;

          default:
            if (isDebug)
              this.log(`[NATS] Unhandled connection status event: ${s.type}`);
        }
      }
    };

    let closing = false;
    let retryTimer = null;
    let retryWake = null;
    let cancelDial = null;
    const closeError = () => new Error('NATS server node is closing');
    const waitForRetry = () => {
      if (closing) return Promise.reject(closeError());
      return new Promise(resolve => {
        retryWake = resolve;
        // Same jitter size as the native client's own default (non-TLS)
        // reconnect delay, so many config nodes retrying an unreachable
        // broker at Node-RED startup don't all hammer it in lockstep every
        // second (the native client itself jitters up to 1000ms for TLS,
        // but this pre-first-connect loop doesn't need to match that).
        const jitter = Math.floor(Math.random() * 100);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          retryWake = null;
          resolve();
        }, ConnectionOptions.reconnectTimeWait + jitter);
      });
    };

    const connectNats = async () => {
      while (!closing) {
        try {
          this.connectionStatus = 'connecting';
          this.connectionStats.reconnectAttempts++;
          this.emitStatusChange();

          const connectionStartTime = Date.now();
          const connectionTimeout = setTimeout(() => {
            const elapsed = Math.floor(
              (Date.now() - connectionStartTime) / 1000
            );
            if (isDebug)
              this.log(
                `[NATS] WARNING: Connection attempt taking longer than expected (${elapsed}s)`
              );
            this.warn(
              `NATS connection attempt taking longer than expected (${elapsed}s). Check server availability.`
            );
          }, this.connectTimeout);

          // Log connection attempt with auth method and TLS info
          let authInfo = 'no authentication';
          switch (this.authMethod) {
            case 'userpass':
              authInfo = this.user
                ? `username/password (user: ***)`
                : 'no authentication';
              break;
            case 'token':
              authInfo = this.token
                ? 'token authentication (***)'
                : 'no authentication';
              break;
            case 'jwt':
              authInfo = this.jwt
                ? 'JWT authentication (***+***)'
                : 'no authentication';
              break;
            case 'nkey':
              authInfo = this.nkeySeed
                ? 'NKey authentication (***)'
                : 'no authentication';
              break;
          }

          const tlsInfo = this.enableTLS ? 'with TLS/SSL' : 'without TLS';

          if (isDebug) {
            this.log(
              `[NATS] Connection attempt ${this.connectionStats.reconnectAttempts}:`
            );
            this.log(`  - Servers: ${servers.join(', ')}`);
            this.log(`  - Auth: ${authInfo}`);
            this.log(`  - Security: ${tlsInfo}`);
            this.log(`  - Timeout: ${this.connectTimeout}ms`);
          }

          try {
            const dial = connect(ConnectionOptions);
            // nats.connect() has no abort signal. Race it with close so the
            // Node-RED close callback never waits on a dead broker, and close
            // any late connection if the dial wins after shutdown.
            cancelDial = null;
            const cancelled = new Promise((_, reject) => {
              cancelDial = () => reject(closeError());
            });
            void (async () => {
              try {
                const connection = await dial;
                if (closing) await connection.close();
              } catch {
                // Failure is handled by Promise.race([dial, cancelled]) below.
              }
            })();
            const connection = await Promise.race([dial, cancelled]);
            if (closing) {
              await connection.close();
              throw closeError();
            }
            this.connection = connection;
            scheduleDeferredClose();
          } finally {
            cancelDial = null;
            clearTimeout(connectionTimeout);
          }
          if (isDebug) this.log(`[NATS] Connection established successfully!`);

          // Start the lifecycle watcher once for this connection object; it runs for as long as
          // the connection lives (native reconnect keeps it alive across drops).
          (async () => {
            try {
              await watchConnectionStatus(this.connection);
            } catch (err) {
              if (isDebug)
                this.log(`[NATS] Status iterator ended: ${err.message}`);
            }
          })();

          this.connectionStatus = 'connected';
          this.connectionStats.lastConnected = Date.now();
          this.connectionStats.connectionStartTime = Date.now();
          this.connectionStats.reconnectAttempts = 0; // Reset counter on successful connection
          this.emitStatusChange();

          return this.connection;
        } catch (err) {
          if (isDebug)
            this.log(`[NATS] Connection failed with error: ${err.message}`);
          if (isDebug)
            this.log(`[NATS] Error details:`, {
              name: err.name,
              code: err.code,
              stack: err.stack?.split('\n')[0],
            });

          this.connectionStatus = 'disconnected';
          this.connectionStats.lastDisconnected = Date.now();
          this.emitStatusChange();
          if (closing) throw err;
          await waitForRetry();
        }
      }
      throw closeError();
    };

    // Set initial status
    this.emitStatusChange();

    // Single-flight connect. Every consumer node calls getConnection() at startup,
    // and the config node kicks off its own initial attempt, so without this a
    // not-yet-connected config node fans out into one connect() per caller. Only
    // the last would be assigned to this.connection; the rest leaked forever as
    // orphaned sockets (observed: 8 of 9 connections on the broker with subs=0).
    // The initial attempt below MUST go through here too, or it races the first
    // getConnection() and leaks one connection per config node on every startup.
    let pendingConnect = null;
    let deferredCloseTimer = null;
    let deferredClosePromise = null;
    const connectOnce = () => {
      if (this.connection) return Promise.resolve(this.connection);
      if (!pendingConnect) {
        pendingConnect = (async () => {
          try {
            if (deferredClosePromise) await deferredClosePromise;
            if (this.connection) return this.connection;
            if (closing) throw closeError();
            return await connectNats();
          } finally {
            pendingConnect = null;
          }
        })();
      }
      return pendingConnect;
    };

    this.getConnection = async () => {
      if (this.connection) return this.connection;
      await connectOnce();
      if (!this.connection) throw closeError();
      return this.connection;
    };

    // Start the initial acquisition. It retries until the broker is reachable or this node
    // closes; native reconnect then owns recovery for the lifetime of the connection.
    (async () => {
      try {
        await connectOnce();
      } catch {
        // Failure is already reflected via emitStatusChange().
      }
    })();

    // Connection Pool: Register a node as user of this connection
    this.registerConnectionUser = nodeId => {
      if (!nodeId) {
        if (isDebug)
          this.log(
            `[NATS] Warning: registerConnectionUser called without nodeId`
          );
        return;
      }

      const wasNew = !this.connectionUsers.has(nodeId);
      this.connectionUsers.add(nodeId);
      this.connectionRefCount = this.connectionUsers.size;

      if (wasNew && isDebug) {
        this.log(
          `[NATS] Node ${nodeId} registered as connection user (total: ${this.connectionRefCount})`
        );
      }
    };

    // Connection Pool: Unregister a node as user of this connection
    const scheduleDeferredClose = () => {
      if (
        closing ||
        this.connectionRefCount !== 0 ||
        !this.connection ||
        deferredCloseTimer ||
        deferredClosePromise
      )
        return;

      if (isDebug)
        this.log(
          `[NATS] No more connection users - scheduling connection cleanup in 250ms`
        );
      deferredCloseTimer = setTimeout(() => {
        deferredCloseTimer = null;
        if (this.connectionRefCount !== 0 || !this.connection || closing)
          return;

        if (isDebug) this.log(`[NATS] Closing unused connection`);

        // Detach before awaiting close so a new user cannot acquire a
        // connection that is already draining. The close promise stays
        // owned here until the node close handler has awaited it.
        const connection = this.connection;
        this.connection = null;
        let closePromise;
        closePromise = (async () => {
          try {
            await closeConnection(connection);
            if (this.connectionRefCount === 0 && !this.connection) {
              this.connectionStatus = 'disconnected';
              this.emitStatusChange();
            }
          } catch (err) {
            this.error(
              `[NATS] Failed to close unused connection: ${err.message}`
            );
          } finally {
            if (deferredClosePromise === closePromise) {
              deferredClosePromise = null;
              scheduleDeferredClose();
            }
          }
        })();
        deferredClosePromise = closePromise;
      }, 250);
    };
    this.unregisterConnectionUser = nodeId => {
      if (!nodeId) {
        if (isDebug)
          this.log(
            `[NATS] Warning: unregisterConnectionUser called without nodeId`
          );
        return;
      }

      const hadUser = this.connectionUsers.has(nodeId);
      this.connectionUsers.delete(nodeId);
      this.connectionRefCount = this.connectionUsers.size;

      if (hadUser && isDebug) {
        this.log(
          `[NATS] Node ${nodeId} unregistered as connection user (remaining: ${this.connectionRefCount})`
        );
      }

      // Automatic cleanup: Close connection if no users left
      scheduleDeferredClose();
    };

    this.addStatusListener = listener => {
      this.listeners.add(listener);
      // Send current status to new listener (object form)
      listener({
        status: this.connectionStatus,
        reconnectAttempts: this.connectionStats.reconnectAttempts,
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime()),
      });
    };

    this.removeStatusListener = listener => {
      this.listeners.delete(listener);
    };

    this.getConnectionStats = () => {
      return {
        ...this.connectionStats,
        uptime: this.getUptime(),
        uptimeFormatted: this.formatUptime(this.getUptime()),
      };
    };

    // TraceOptions per @nats-io/nats-core: {traceDestination?, traceOnly?}.
    // traceOnly suppresses delivery entirely (trace-only dry run) - never set
    // it here, this switch means "also trace", not "don't actually publish".
    this.getTraceOptions = () => {
      if (!this.enableTracing || !this.traceDestination) return undefined;
      return { traceDestination: this.traceDestination };
    };

    // Pass-throughs to the real NatsConnection. setServers() only replaces
    // the pool for future reconnect attempts - it does not drop the live
    // connection. reconnect() is upstream's own "experimental, subject to
    // be removed" API; it forces an immediate reconnect and rejects any
    // in-flight requests when it does.
    this.getServers = () => {
      if (!this.connection) return [];
      return this.connection.getServers();
    };

    this.setServers = servers => {
      if (!this.connection)
        throw new Error('Cannot set servers: not connected');
      this.connection.setServers(servers);
    };

    this.reconnect = () => {
      if (!this.connection) throw new Error('Cannot reconnect: not connected');
      return this.connection.reconnect();
    };

    const closeConnection = async connection => {
      const bounded = async (promise, timeout = 1000) => {
        let timer;
        try {
          await Promise.race([
            Promise.resolve(promise).catch(() => {}),
            new Promise(resolve => {
              timer = setTimeout(resolve, timeout);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!connection || connection.isClosed()) return;
      await bounded(connection.drain());
      if (!connection.isClosed()) await bounded(connection.close());
    };

    this.on('close', async done => {
      if (isDebug) this.log(`[NATS] Node closing, cleaning up connections...`);

      closing = true;
      if (cancelDial) cancelDial();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (retryWake) {
        const wake = retryWake;
        retryWake = null;
        wake();
      }

      // Let the single-flight acquisition observe closing before completing
      // node shutdown. A late dial is separately closed by its handler above.
      if (pendingConnect) await pendingConnect.catch(() => {});

      if (deferredCloseTimer) {
        clearTimeout(deferredCloseTimer);
        deferredCloseTimer = null;
      }
      if (deferredClosePromise) await deferredClosePromise;

      // Close NATS connection gracefully - drain flushes pending work before closing;
      // fall back to a hard close if drain itself fails.
      const connection = this.connection;
      await closeConnection(connection);
      this.connection = null;
      this.connectionStatus = 'disconnected';

      // Clear status
      this.status({});
      done();
    });
  }
  RED.nodes.registerType('nats-suite-server', NatsServerNode, {
    credentials: {
      user: { type: 'text' },
      pass: { type: 'password' },
      token: { type: 'password' },
      jwt: { type: 'password' },
      nkeySeed: { type: 'password' },
    },
  });
};
