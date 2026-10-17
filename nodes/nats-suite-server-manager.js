'use strict';

const { spawn } = require('child_process');
const { once } = require('node:events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseSize } = require('../lib/duration');

module.exports = function (RED) {
  function NatsServerManagerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.name = config.name || '';
    this.serverType = config.serverType || 'embedded'; // Always embedded now

    this.port = config.port || 4222;
    this.leafPort = config.leafPort || 7422;
    this.enableJetStream = config.enableJetStream || false;
    this.storeDir = config.storeDir || path.join(os.tmpdir(), 'nats-jetstream');
    this.leafRemoteUrl = config.leafRemoteUrl || '';
    this.leafRemoteUser = config.leafRemoteUser || '';
    // Credentials store (encrypted), not plain defaults - see credentials
    // block in server-manager.html. Breaking change in v1.0.0: existing
    // plaintext values from flows.json do not carry over.
    const credentials = this.credentials || {};
    this.leafRemotePass = credentials.leafRemotePass || '';
    this.autoStart = config.autoStart !== false;
    this.debug = config.debug || false;

    // Binary source: 'auto' (local/cache locations then system PATH), 'custom' (custom path), 'system' (system PATH)
    this.binarySource = config.binarySource || 'auto';
    this.customBinaryPath = config.customBinaryPath || '';

    // Config source: 'generated' (build from UI settings), 'file' (use external config file)
    this.configSource = config.configSource || 'generated';
    this.configFilePath = config.configFilePath || '';

    // MQTT options
    this.enableMqtt = config.enableMqtt || false;
    this.mqttPort = config.mqttPort || 1883;

    // WebSocket options
    this.enableWebsocket = config.enableWebsocket || false;
    this.websocketPort = config.websocketPort || 8080;

    // TLS options
    this.enableTls = config.enableTls || false;
    this.tlsCert = config.tlsCert || '';
    this.tlsKey = config.tlsKey || '';
    this.tlsCaCert = config.tlsCaCert || '';
    this.tlsVerify = config.tlsVerify || false;

    // Authentication options
    this.enableAuth = config.enableAuth || false;
    this.authUser = config.authUser || '';
    this.authPassword = credentials.authPassword || '';
    this.authToken = credentials.authToken || '';

    // New embedded server options
    this.serverName = config.serverName || '';
    this.maxConnections = config.maxConnections || '';
    this.maxPayload = config.maxPayload || '';
    this.maxSubscriptions = config.maxSubscriptions || '';
    this.maxControlLine = config.maxControlLine || '';
    this.writeDeadline = config.writeDeadline || '';
    this.httpPort = config.httpPort || '';
    this.httpsPort = config.httpsPort || '';
    this.logLevel = config.logLevel || 'info';
    this.enableTrace = config.enableTrace || false;
    this.enableDebugLog = config.enableDebugLog || false;
    this.noLog = config.noLog || false;
    this.logFile = config.logFile || '';
    this.pidFile = config.pidFile || '';
    this.maxMemoryStore = config.maxMemoryStore || '';
    this.maxFileStore = config.maxFileStore || '';
    this.memStoreOnly = config.memStoreOnly || false;
    this.syncInterval = config.syncInterval || '';
    this.hostAddr = config.hostAddr || '';
    this.clientAdvertise = config.clientAdvertise || '';
    this.noAdvertise = config.noAdvertise || false;
    this.connectRetries = config.connectRetries || '';
    this.enableLeafNodeMode = config.enableLeafNodeMode || false;

    let natsServerProcess = null;
    let serverPort = null;
    let natsServerVersion = null; // Declare natsServerVersion here
    let configFile = null; // Declare configFile here to be accessible by stopServer
    let versionProcess = null;
    let closing = false;

    const removeConfigFile = () => {
      if (!configFile) return;
      try {
        fs.unlinkSync(configFile);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          node.warn(`Failed to delete temporary config file: ${err.message}`);
        }
      }
      configFile = null;
    };

    const terminateProcess = async child => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;

      const exited = once(child, 'exit', {
        signal: AbortSignal.timeout(5000),
      });
      child.kill('SIGTERM');
      try {
        await exited;
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
        child.kill('SIGKILL');
        if (child.exitCode === null && child.signalCode === null) {
          await once(child, 'exit');
        }
      }
    };

    const log = message => {
      if (node.debug) {
        node.log(`[NATS-SERVER] ${message}`);
      }
    };

    const setStatus = (status, text) => {
      const statusMap = {
        stopped: { fill: 'grey', shape: 'ring', text: text || 'stopped' },
        initializing: {
          fill: 'blue',
          shape: 'ring',
          text: text || 'initializing...',
        },
        starting: {
          fill: 'yellow',
          shape: 'ring',
          text: text || 'starting...',
        },
        running: { fill: 'green', shape: 'dot', text: text || 'running' },
        error: { fill: 'red', shape: 'ring', text: text || 'error' },
      };
      const statusObj = statusMap[status] || statusMap.stopped;
      node.status(statusObj);
    };

    // Helper function to generate NATS config file content
    const generateNatsConfig = config => {
      let content = '# Auto-generated NATS Server Configuration\n';
      content += `# Generated at: ${new Date().toISOString()}\n\n`;

      const writeValue = (key, value, indent = 0) => {
        const spaces = '  '.repeat(indent);
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          content += `${spaces}${key} {\n`;
          for (const [k, v] of Object.entries(value)) {
            writeValue(k, v, indent + 1);
          }
          content += `${spaces}}\n`;
        } else if (Array.isArray(value)) {
          content += `${spaces}${key}: [\n`;
          for (const item of value) {
            if (typeof item === 'object') {
              content += `${spaces}  {\n`;
              for (const [k, v] of Object.entries(item)) {
                writeValue(k, v, indent + 2);
              }
              content += `${spaces}  }\n`;
            } else {
              content += `${spaces}  ${JSON.stringify(item)}\n`;
            }
          }
          content += `${spaces}]\n`;
        } else if (typeof value === 'string') {
          content += `${spaces}${key}: "${value}"\n`;
        } else if (typeof value === 'boolean') {
          content += `${spaces}${key}: ${value}\n`;
        } else if (typeof value === 'number') {
          content += `${spaces}${key}: ${value}\n`;
        }
      };

      for (const [key, value] of Object.entries(config)) {
        writeValue(key, value);
      }

      return content;
    };

    // Helper function to get NATS server version
    const getNatsServerVersion = async natsServerBinPath => {
      const child = spawn(natsServerBinPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      versionProcess = child;
      let versionOutput = '';
      child.stdout.on('data', data => {
        versionOutput += data.toString();
      });
      child.stderr.on('data', data => {
        versionOutput += data.toString();
      }); // NATS prints version to stderr

      try {
        await once(child, 'close');
      } catch {
        return 'unknown';
      } finally {
        if (versionProcess === child) versionProcess = null;
      }

      return versionOutput.match(/v(\d+\.\d+\.\d+)/)?.[1] || 'unknown';
    };

    // Start embedded NATS server (direct binary execution for reliability)
    const startEmbeddedServer = async () => {
      try {
        setStatus('initializing', 'initializing...');

        const requestedPort = parseInt(node.port) || 4222;
        const enableJetStream = node.enableJetStream !== false; // Default true
        const enableLeafNode = node.enableLeafNodeMode === true; // Only true if explicitly enabled

        // Validate Leaf Node configuration
        if (enableLeafNode && !node.leafRemoteUrl) {
          setStatus('error', 'missing remote URL');
          throw new Error('Leaf Node mode requires a Remote NATS Server URL');
        }

        let actualPort = requestedPort;
        let startupLogMessage = `Starting embedded NATS server on port ${requestedPort}...`;

        // Find nats-server binary based on binarySource setting
        setStatus('initializing', 'finding binary...');
        let natsServerBin = null;
        let binarySourceUsed = node.binarySource || 'auto';

        log(`Binary source configured: ${binarySourceUsed}`);

        switch (binarySourceUsed) {
          case 'custom':
            // Use custom binary path only
            if (!node.customBinaryPath) {
              setStatus('error', 'no binary path');
              throw new Error(
                'Custom binary source selected but no path specified'
              );
            }
            if (!fs.existsSync(node.customBinaryPath)) {
              setStatus('error', 'binary not found');
              throw new Error(
                `Custom binary not found: ${node.customBinaryPath}`
              );
            }
            natsServerBin = node.customBinaryPath;
            log(`Using custom binary: ${natsServerBin}`);
            break;

          case 'system':
            // Use system PATH only
            natsServerBin = 'nats-server';
            log('Using system PATH nats-server');
            break;

          case 'auto':
          default: {
            // Auto-detect: try available local/cache locations first, then system PATH
            const possibleBinPaths = [
              path.join(
                __dirname,
                '../node_modules/.cache/nats-memory-server/nats-server'
              ),
              path.join(
                __dirname,
                '../node_modules/nats-memory-server/.cache/nats-server'
              ),
              '/data/node_modules/node-red-contrib-nats-suite/node_modules/.cache/nats-memory-server/nats-server',
              '/usr/local/bin/nats-server',
              '/usr/bin/nats-server',
              'nats-server', // System PATH as fallback
            ];

            for (const binPath of possibleBinPaths) {
              try {
                if (binPath === 'nats-server' || fs.existsSync(binPath)) {
                  natsServerBin = binPath;
                  log(`Auto-detected nats-server binary at: ${binPath}`);
                  break;
                }
              } catch {
                // Continue to next path
              }
            }

            if (!natsServerBin) {
              const installHint =
                'Install nats-server on the host or select "Custom Binary" and mount your own.';
              setStatus('error', 'nats-server not found');
              throw new Error(`nats-server binary not found. ${installHint}`);
            }
            break;
          }
        }

        // Get NATS server version once at the start
        setStatus('initializing', 'checking version...');
        natsServerVersion = await getNatsServerVersion(natsServerBin);
        if (closing) throw new Error('Server manager is closing');
        log(`NATS server binary version: v${natsServerVersion}`);

        // Check if MQTT is enabled (requires JetStream and server_name)
        const enableMqtt = node.enableMqtt === true;
        if (enableMqtt) {
          // MQTT requires JetStream - auto-enable if not set
          if (!enableJetStream) {
            node.warn(
              'MQTT requires JetStream - enabling JetStream automatically'
            );
          }
          // MQTT requires server_name
          if (!node.serverName) {
            node.serverName = `nats-embedded-${Date.now()}`;
            log(
              `MQTT requires server_name - auto-generated: ${node.serverName}`
            );
          }
        }

        return new Promise((resolve, reject) => {
          const args = [];

          // Check if using external config file
          const useExternalConfig =
            node.configSource === 'file' && node.configFilePath;

          if (useExternalConfig) {
            // Use external config file directly
            if (!fs.existsSync(node.configFilePath)) {
              setStatus('error', 'config not found');
              reject(
                new Error(`Config file not found: ${node.configFilePath}`)
              );
              return;
            }

            log(`Using external config file: ${node.configFilePath}`);
            setStatus('initializing', 'loading config file...');
            args.push('-c', node.configFilePath);

            // Try to extract port from config file for status display
            try {
              const configContent = fs.readFileSync(
                node.configFilePath,
                'utf8'
              );
              const portMatch = configContent.match(/^port:\s*(\d+)/m);
              if (portMatch) {
                actualPort = parseInt(portMatch[1]);
                log(`Detected port ${actualPort} from config file`);
              }
            } catch (err) {
              log(
                `Could not read config file for port detection: ${err.message}`
              );
            }

            startupLogMessage = `Starting NATS server with config: ${node.configFilePath}...`;
          } else {
            // Determine if we need a generated config file (for advanced features)
            const needsConfigFile =
              enableLeafNode ||
              enableMqtt ||
              node.enableWebsocket ||
              node.enableTls ||
              node.enableAuth;

            if (needsConfigFile) {
              setStatus('initializing', 'generating config...');
              // Build config object
              const serverConfig = {};

              if (enableLeafNode) {
                actualPort = parseInt(node.leafPort) || 7422;
                startupLogMessage = `Starting embedded NATS Leaf Node on port ${actualPort}...`;

                serverConfig.port = actualPort;
                serverConfig.leafnodes = {
                  remotes: [
                    {
                      url: node.leafRemoteUrl || 'nats://localhost:4222',
                      ...(node.leafRemoteUser && {
                        credentials: null,
                        user: node.leafRemoteUser,
                      }),
                      ...(node.leafRemotePass && {
                        password: node.leafRemotePass,
                      }),
                    },
                  ],
                };
              } else {
                serverConfig.port = requestedPort;
              }

              // Server name (required for MQTT)
              if (node.serverName) {
                serverConfig.server_name = node.serverName;
              }

              // Host address
              if (node.hostAddr) {
                serverConfig.host = node.hostAddr;
              }

              // MQTT configuration
              if (enableMqtt) {
                const mqttPort = parseInt(node.mqttPort) || 1883;
                serverConfig.mqtt = {
                  port: mqttPort,
                };
                startupLogMessage = `Starting embedded NATS server on port ${actualPort} with MQTT on port ${mqttPort}...`;
                log(`MQTT enabled on port ${mqttPort}`);
              }

              // WebSocket configuration
              if (node.enableWebsocket) {
                const wsPort = parseInt(node.websocketPort) || 8080;
                serverConfig.websocket = {
                  port: wsPort,
                  no_tls: !node.enableTls,
                };
                log(`WebSocket enabled on port ${wsPort}`);
              }

              // TLS configuration
              if (node.enableTls) {
                if (!node.tlsCert || !node.tlsKey) {
                  node.warn(
                    'TLS enabled but certificate or key path not specified'
                  );
                } else {
                  serverConfig.tls = {
                    cert_file: node.tlsCert,
                    key_file: node.tlsKey,
                  };
                  if (node.tlsCaCert) {
                    serverConfig.tls.ca_file = node.tlsCaCert;
                  }
                  if (node.tlsVerify) {
                    serverConfig.tls.verify = true;
                  }
                  log(`TLS enabled with cert: ${node.tlsCert}`);
                }
              }

              // Authentication configuration
              if (node.enableAuth) {
                if (node.authToken) {
                  serverConfig.authorization = {
                    token: node.authToken,
                  };
                  log('Token authentication enabled');
                } else if (node.authUser && node.authPassword) {
                  serverConfig.authorization = {
                    user: node.authUser,
                    password: node.authPassword,
                  };
                  log(`User authentication enabled for user: ${node.authUser}`);
                } else {
                  node.warn(
                    'Authentication enabled but no credentials specified'
                  );
                }
              }

              // JetStream configuration (required for MQTT)
              if (enableJetStream || enableMqtt) {
                serverConfig.jetstream = {};
                if (node.storeDir) {
                  serverConfig.jetstream.store_dir = node.storeDir;
                }
                if (node.maxMemoryStore) {
                  const bytes = parseSize(node.maxMemoryStore);
                  if (bytes !== undefined) {
                    serverConfig.jetstream.max_memory_store = bytes;
                  }
                }
                if (node.maxFileStore) {
                  const bytes = parseSize(node.maxFileStore);
                  if (bytes !== undefined) {
                    serverConfig.jetstream.max_file_store = bytes;
                  }
                }
              }

              // HTTP Monitoring
              if (node.httpPort) {
                serverConfig.http_port = parseInt(node.httpPort);
              }

              // Logging
              if (node.enableDebugLog || node.logLevel === 'debug') {
                serverConfig.debug = true;
              }
              if (node.enableTrace || node.logLevel === 'trace') {
                serverConfig.trace = true;
              }

              // Limits
              if (node.maxConnections) {
                serverConfig.max_connections = parseInt(node.maxConnections);
              }
              if (node.maxPayload) {
                serverConfig.max_payload = parseInt(node.maxPayload);
              }

              // Write config to temp file (using NATS conf format, not JSON)
              configFile = path.join(
                os.tmpdir(),
                `nats-embedded-${Date.now()}.conf`
              );
              const configContent = generateNatsConfig(serverConfig);
              fs.writeFileSync(configFile, configContent, { mode: 0o600 });
              args.push('-c', configFile);
              log(`Using config file: ${configFile}`);
            } else {
              // Simple mode - use CLI arguments (no config file needed)
              args.push('-p', requestedPort.toString());

              // Host/Network options
              if (node.hostAddr) {
                args.push('-a', node.hostAddr);
              }
              if (node.serverName) {
                args.push('-n', node.serverName);
              }
              if (node.clientAdvertise) {
                args.push('--client_advertise', node.clientAdvertise);
              }
              if (node.noAdvertise) {
                args.push('--no_advertise');
              }

              // Limits
              if (node.maxConnections) {
                args.push('--max_connections', node.maxConnections.toString());
              }
              if (node.maxPayload) {
                args.push('--max_payload', node.maxPayload.toString());
              }
              if (node.maxSubscriptions) {
                args.push(
                  '--max_subscriptions',
                  node.maxSubscriptions.toString()
                );
              }
              if (node.maxControlLine) {
                args.push('--max_control_line', node.maxControlLine.toString());
              }
              if (node.writeDeadline) {
                args.push('--write_deadline', node.writeDeadline);
              }
              if (node.connectRetries) {
                args.push('--connect_retries', node.connectRetries.toString());
              }

              // HTTP Monitoring
              if (node.httpPort) {
                args.push('-m', node.httpPort.toString());
              }
              if (node.httpsPort) {
                args.push('-ms', node.httpsPort.toString());
              }

              // Logging
              if (node.noLog) {
                args.push('-l', '/dev/null'); // Suppress all logging
              } else {
                if (node.logFile) {
                  args.push('-l', node.logFile);
                }
                if (node.enableDebugLog || node.logLevel === 'debug') {
                  args.push('-D');
                }
                if (node.enableTrace || node.logLevel === 'trace') {
                  args.push('-V'); // Verbose/trace
                }
              }

              // PID file
              if (node.pidFile) {
                args.push('-P', node.pidFile);
              }

              // JetStream
              if (enableJetStream) {
                args.push('-js');
                if (node.memStoreOnly) {
                  args.push('--js_mem_store_only');
                } else if (node.storeDir) {
                  args.push('-sd', node.storeDir);
                }
                if (node.maxMemoryStore) {
                  // Parse size like "1GB", "512MB" to bytes
                  const bytes = parseSize(node.maxMemoryStore);
                  if (bytes !== undefined) {
                    args.push('--js_max_memory_store', bytes.toString());
                  }
                }
                if (node.syncInterval) {
                  args.push('--sync_interval', node.syncInterval);
                }
              }
            }
          } // End of else (not using external config)

          log(startupLogMessage);
          setStatus('starting', `spawning on :${actualPort}...`);
          log(`Spawning: ${natsServerBin} ${args.join(' ')}`);

          if (closing) {
            removeConfigFile();
            reject(new Error('Server manager is closing'));
            return;
          }

          // Spawn the nats-server process
          natsServerProcess = spawn(natsServerBin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          });

          let started = false;
          let startSettled = false;
          let startupOutput = '';
          let lastStatusPhase = '';
          let startupTimeout = null;
          let startupFailure = null;
          const resolveStart = () => {
            if (startSettled) return;
            startSettled = true;
            resolve();
          };
          const rejectStart = err => {
            if (startSettled) return;
            startSettled = true;
            reject(err);
          };

          const checkStarted = data => {
            startupOutput += data.toString();
            // Update status as server progresses (only if phase changes)
            if (!started) {
              if (
                startupOutput.includes('JetStream') &&
                lastStatusPhase !== 'jetstream'
              ) {
                lastStatusPhase = 'jetstream';
                setStatus('starting', 'JetStream loading...');
              } else if (
                startupOutput.includes('Starting nats-server') &&
                lastStatusPhase === ''
              ) {
                lastStatusPhase = 'nats';
                setStatus('starting', 'nats-server starting...');
              }
            }
            // NATS server outputs "Server is ready" when fully started
            if (
              !started &&
              (startupOutput.includes('Server is ready') ||
                startupOutput.includes('Listening for client connections'))
            ) {
              started = true;
              clearTimeout(startupTimeout);
              serverPort = actualPort; // Use actualPort (embedded or leaf port)
              const versionText =
                natsServerVersion !== 'unknown' ? `v${natsServerVersion}` : '';
              const sourceLabel =
                binarySourceUsed === 'custom'
                  ? 'bin'
                  : binarySourceUsed === 'system'
                    ? 'sys'
                    : 'npm';
              const statusText =
                `${sourceLabel}:${serverPort} ${versionText}`.trim();

              log(
                `Embedded NATS server is running on port ${serverPort} (${versionText})`
              );
              setStatus('running', statusText);

              const startedPayload = {
                type: enableLeafNode ? 'leaf' : 'embedded',
                port: serverPort,
                url: `nats://localhost:${serverPort}`,
                pid: natsServerProcess.pid,
                version: natsServerVersion,
                jetstream: enableJetStream || enableMqtt, // MQTT requires JetStream
                mqtt: enableMqtt
                  ? {
                      enabled: true,
                      port: parseInt(node.mqttPort) || 1883,
                      url: `mqtt://localhost:${parseInt(node.mqttPort) || 1883}`,
                    }
                  : { enabled: false },
                websocket: node.enableWebsocket
                  ? {
                      enabled: true,
                      port: parseInt(node.websocketPort) || 8080,
                      url: `ws://localhost:${parseInt(node.websocketPort) || 8080}`,
                    }
                  : { enabled: false },
                tls: node.enableTls
                  ? {
                      enabled: true,
                      verify: node.tlsVerify || false,
                    }
                  : { enabled: false },
                auth: node.enableAuth
                  ? {
                      enabled: true,
                      type: node.authToken ? 'token' : 'user',
                    }
                  : { enabled: false },
                binarySource: binarySourceUsed,
                binaryPath: natsServerBin,
                config: {
                  serverName: node.serverName || null,
                  maxConnections: node.maxConnections || null,
                  maxPayload: node.maxPayload || null,
                  httpPort: node.httpPort || null,
                },
              };

              // Add monitoring URL if HTTP port is configured
              if (node.httpPort) {
                startedPayload.monitoringUrl = `http://localhost:${node.httpPort}`;
                startedPayload.endpoints = {
                  varz: `http://localhost:${node.httpPort}/varz`,
                  connz: `http://localhost:${node.httpPort}/connz`,
                  subsz: `http://localhost:${node.httpPort}/subsz`,
                  healthz: `http://localhost:${node.httpPort}/healthz`,
                };
                if (enableJetStream) {
                  startedPayload.endpoints.jsz = `http://localhost:${node.httpPort}/jsz`;
                }
              }

              node.send({
                topic: 'server.started',
                payload: startedPayload,
              });
              resolveStart();
            }
          };

          natsServerProcess.stdout.on('data', data => {
            if (node.debug) {
              node.log(`[NATS-SERVER stdout] ${data.toString().trim()}`);
            }
            checkStarted(data);
          });

          natsServerProcess.stderr.on('data', data => {
            const output = data.toString().trim();
            // NATS server logs to stderr by default
            if (node.debug) {
              node.log(`[NATS-SERVER] ${output}`);
            }
            checkStarted(data);
          });

          natsServerProcess.on('error', err => {
            clearTimeout(startupTimeout);
            setStatus('error', err.message.substring(0, 20));
            removeConfigFile();
            natsServerProcess = null;
            rejectStart(err);
          });

          natsServerProcess.on('exit', (code, signal) => {
            clearTimeout(startupTimeout);
            if (!started) {
              setStatus('error', `exit: ${code || signal}`);
              removeConfigFile();
              rejectStart(
                startupFailure || new Error(`Server exited with code ${code}`)
              );
            } else {
              log(
                `Embedded NATS server stopped. Code: ${code}, Signal: ${signal}`
              );
              setStatus('stopped', 'stopped');
              removeConfigFile();
            }
            natsServerProcess = null;
            serverPort = null;
          });

          // Timeout for startup
          startupTimeout = setTimeout(async () => {
            startupTimeout = null;
            if (!started) {
              setStatus('error', 'start timeout');
              startupFailure = new Error('Server start timeout');
              if (!natsServerProcess) {
                removeConfigFile();
                rejectStart(startupFailure);
                return;
              }
              try {
                await terminateProcess(natsServerProcess);
              } catch (err) {
                rejectStart(err);
              }
            }
          }, 10000);
        });
      } catch (err) {
        setStatus('error', err.message.substring(0, 20));
        throw err; // Re-throw the error to be caught by the caller
      }
    };

    // Stop server
    const stopServer = async (notify = true) => {
      log('Stopping NATS server...');
      setStatus('stopped', 'stopping...');

      removeConfigFile();

      if (versionProcess) {
        const child = versionProcess;
        try {
          await terminateProcess(child);
        } catch {
          // A failed spawn is already handled by getNatsServerVersion().
        }
      }

      if (natsServerProcess) {
        const process = natsServerProcess;
        await terminateProcess(process);
        log('Server process stopped');
      }

      serverPort = null;
      setStatus('stopped');
      if (notify) {
        node.send({
          topic: 'server.stopped',
          payload: { type: node.serverType },
        });
      }
    };

    // Start server (always embedded now)
    const startServer = async () => {
      await startEmbeddedServer();
    };

    // Input handler
    node.on('input', async (msg, send, done) => {
      try {
        const command = msg.command || msg.payload?.command || msg.topic;

        if (!command) {
          node.warn(
            'No command specified. Use msg.command or msg.topic with: start, stop, restart, status, toggle'
          );
          done();
          return;
        }

        switch (command) {
          case 'start':
            if (natsServerProcess) {
              node.warn('Server is already running');
              break;
            }
            await startServer();
            break;
          case 'stop':
            if (!natsServerProcess) {
              node.warn('Server is not running');
              break;
            }
            await stopServer();
            break;
          case 'restart':
            await stopServer();
            await startServer();
            break;
          case 'status':
            send({
              topic: 'server.status',
              payload: {
                running: !!natsServerProcess,
                type: 'embedded', // Always embedded now
                port: serverPort,
                url: serverPort ? `nats://localhost:${serverPort}` : null,
                version: natsServerVersion, // Add NATS server version here
              },
            });
            break;
          case 'toggle':
            if (natsServerProcess) {
              await stopServer();
            } else {
              await startServer();
            }
            break;
          default:
            node.warn(
              `Unknown command: "${command}". Valid commands: start, stop, restart, status, toggle`
            );
            break;
        }
        done();
      } catch (err) {
        done(err);
      }
    });

    // Auto-start if configured
    if (node.autoStart) {
      const autoStart = async () => {
        try {
          await startServer();
        } catch (err) {
          if (!closing) node.error(`Error while starting: ${err.message}`);
        }
      };
      autoStart();
    } else {
      setStatus('stopped');
    }

    // Cleanup on close. Must take `done` - Node-RED dispatches close handlers
    // by declared arity (callback.length), so a zero-arg async function is
    // never awaited even though it looks correct; a redeploy could then start
    // a new instance before the old nats-server child process actually exits.
    node.on('close', async done => {
      closing = true;
      let closeError;
      try {
        await stopServer(false);
      } catch (err) {
        closeError = err;
      } finally {
        done(closeError);
      }
    });
  }

  RED.nodes.registerType('nats-suite-server-manager', NatsServerManagerNode, {
    credentials: {
      leafRemotePass: { type: 'password' },
      authPassword: { type: 'password' },
      authToken: { type: 'password' },
    },
  });
};
