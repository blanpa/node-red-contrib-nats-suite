'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function (RED) {
  function NatsServerManagerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.name = config.name || "";
    
    this.port = config.port || 4222;
    this.leafPort = config.leafPort || 7422;
    this.enableJetStream = config.enableJetStream || false;
    this.storeDir = config.storeDir || path.join(os.tmpdir(), 'nats-jetstream');
    this.leafRemoteUrl = config.leafRemoteUrl || '';
    this.leafRemoteUser = config.leafRemoteUser || '';
    this.leafRemotePass = config.leafRemotePass || '';
    this.autoStart = config.autoStart !== false;
    this.debug = config.debug || false;
    
    // Binary source: 'auto' (nats-memory-server), 'custom' (custom path), 'system' (system PATH)
    this.binarySource = config.binarySource || 'auto';
    this.customBinaryPath = config.customBinaryPath || '';
    
    // MQTT options
    this.enableMqtt = config.enableMqtt || false;
    this.mqttPort = config.mqttPort || 1883;
    
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

    const log = (message) => {
      if (node.debug) {
        node.log(`[NATS-SERVER] ${message}`);
      }
    };

    const setStatus = (status, text) => {
      const statusMap = {
        'stopped': { fill: 'grey', shape: 'ring', text: text || 'stopped' },
        'starting': { fill: 'yellow', shape: 'ring', text: text || 'starting...' },
        'running': { fill: 'green', shape: 'dot', text: text || 'running' },
        'error': { fill: 'red', shape: 'ring', text: text || 'error' }
      };
      node.status(statusMap[status] || statusMap.stopped);
    };

    // Helper function to generate NATS config file content
    const generateNatsConfig = (config) => {
      let content = '# Auto-generated NATS Server Configuration\n';
      content += `# Generated at: ${new Date().toISOString()}\n\n`;
      
      const writeValue = (key, value, indent = 0) => {
        const spaces = '  '.repeat(indent);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
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
    const getNatsServerVersion = async (natsServerBinPath) => {
      return new Promise((resolve) => {
        const versionProcess = spawn(natsServerBinPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let versionOutput = '';
        versionProcess.stdout.on('data', (data) => { versionOutput += data.toString(); });
        versionProcess.stderr.on('data', (data) => { versionOutput += data.toString(); }); // NATS prints version to stderr
        versionProcess.on('close', (code) => {
          const match = versionOutput.match(/v(\d+\.\d+\.\d+)/);
          if (match && match[1]) {
            resolve(match[1]);
          } else {
            resolve('unknown');
          }
        });
        versionProcess.on('error', () => { resolve('unknown'); });
      });
    };

    // Start embedded NATS server (direct binary execution for reliability)
    const startEmbeddedServer = async () => {
      try {
        const requestedPort = parseInt(node.port) || 4222;
        const enableJetStream = node.enableJetStream !== false; // Default true
        const enableLeafNode = node.enableLeafNodeMode === true; // Only true if explicitly enabled

        // Validate Leaf Node configuration
        if (enableLeafNode && !node.leafRemoteUrl) {
          node.error('Leaf Node mode requires a Remote NATS Server URL');
          setStatus('error', 'missing remote URL');
          throw new Error('Leaf Node mode requires a Remote NATS Server URL');
        }

        let actualPort = requestedPort;
        let startupLogMessage = `Starting embedded NATS server on port ${requestedPort}...`;
        let statusText = 'starting embedded...';

        // Find nats-server binary based on binarySource setting
        let natsServerBin = null;
        let binarySourceUsed = node.binarySource || 'auto';
        
        log(`Binary source configured: ${binarySourceUsed}`);
        
        switch (binarySourceUsed) {
          case 'custom':
            // Use custom binary path only
            if (!node.customBinaryPath) {
              node.error('Custom binary source selected but no path specified');
              setStatus('error', 'no binary path');
              throw new Error('Custom binary source selected but no path specified');
            }
            if (!fs.existsSync(node.customBinaryPath)) {
              node.error(`Custom binary not found: ${node.customBinaryPath}`);
              setStatus('error', 'binary not found');
              throw new Error(`Custom binary not found: ${node.customBinaryPath}`);
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
          default:
            // Auto-detect: try nats-memory-server first, then system PATH
            const possibleBinPaths = [
              path.join(__dirname, '../node_modules/.cache/nats-memory-server/nats-server'),
              path.join(__dirname, '../node_modules/nats-memory-server/.cache/nats-server'),
              '/data/node_modules/node-red-contrib-nats-suite/node_modules/.cache/nats-memory-server/nats-server',
              '/usr/local/bin/nats-server',
              '/usr/bin/nats-server',
              'nats-server' // System PATH as fallback
            ];
            
            for (const binPath of possibleBinPaths) {
              try {
                if (binPath === 'nats-server' || fs.existsSync(binPath)) {
                  natsServerBin = binPath;
                  log(`Auto-detected nats-server binary at: ${binPath}`);
                  break;
                }
              } catch (err) {
                // Continue to next path
              }
            }
            
            if (!natsServerBin) {
              const installHint = 'Install nats-memory-server (npm install nats-memory-server) or select "Custom Binary" and mount your own.';
              node.error(`nats-server binary not found. ${installHint}`);
              setStatus('error', 'nats-server not found');
              throw new Error('nats-server binary not found');
            }
            break;
        }

        // Get NATS server version once at the start
        natsServerVersion = await getNatsServerVersion(natsServerBin);
        log(`NATS server binary version: v${natsServerVersion}`);

        // Check if MQTT is enabled (requires JetStream and server_name)
        const enableMqtt = node.enableMqtt === true;
        if (enableMqtt) {
          // MQTT requires JetStream - auto-enable if not set
          if (!enableJetStream) {
            node.warn('MQTT requires JetStream - enabling JetStream automatically');
          }
          // MQTT requires server_name
          if (!node.serverName) {
            node.serverName = `nats-embedded-${Date.now()}`;
            log(`MQTT requires server_name - auto-generated: ${node.serverName}`);
          }
        }

        return new Promise((resolve, reject) => {
          const args = [];
          
          // Determine if we need a config file (for MQTT or Leaf Node)
          const needsConfigFile = enableLeafNode || enableMqtt;

          if (needsConfigFile) {
            // Build config object
            const serverConfig = {};
            
            if (enableLeafNode) {
              actualPort = parseInt(node.leafPort) || 7422;
              startupLogMessage = `Starting embedded NATS Leaf Node on port ${actualPort}...`;
              statusText = 'starting embedded leaf...';
              
              serverConfig.port = actualPort;
              serverConfig.leafnodes = {
                remotes: [{
                  url: node.leafRemoteUrl || 'nats://localhost:4222',
                  ...(node.leafRemoteUser && { credentials: null, user: node.leafRemoteUser }),
                  ...(node.leafRemotePass && { password: node.leafRemotePass })
                }]
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
                port: mqttPort
              };
              startupLogMessage = `Starting embedded NATS server on port ${actualPort} with MQTT on port ${mqttPort}...`;
              statusText = `starting (MQTT:${mqttPort})...`;
              log(`MQTT enabled on port ${mqttPort}`);
            }
            
            // JetStream configuration (required for MQTT)
            if (enableJetStream || enableMqtt) {
              serverConfig.jetstream = {};
              if (node.storeDir) {
                serverConfig.jetstream.store_dir = node.storeDir;
              }
              if (node.maxMemoryStore) {
                const sizeMatch = node.maxMemoryStore.match(/^(\d+)(GB|MB|KB|B)?$/i);
                if (sizeMatch) {
                  let bytes = parseInt(sizeMatch[1]);
                  const unit = (sizeMatch[2] || 'B').toUpperCase();
                  if (unit === 'GB') bytes *= 1024 * 1024 * 1024;
                  else if (unit === 'MB') bytes *= 1024 * 1024;
                  else if (unit === 'KB') bytes *= 1024;
                  serverConfig.jetstream.max_memory_store = bytes;
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
            configFile = path.join(os.tmpdir(), `nats-embedded-${Date.now()}.conf`);
            const configContent = generateNatsConfig(serverConfig);
            fs.writeFileSync(configFile, configContent);
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
              args.push('--max_subscriptions', node.maxSubscriptions.toString());
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
                const sizeMatch = node.maxMemoryStore.match(/^(\d+)(GB|MB|KB|B)?$/i);
                if (sizeMatch) {
                  let bytes = parseInt(sizeMatch[1]);
                  const unit = (sizeMatch[2] || 'B').toUpperCase();
                  if (unit === 'GB') bytes *= 1024 * 1024 * 1024;
                  else if (unit === 'MB') bytes *= 1024 * 1024;
                  else if (unit === 'KB') bytes *= 1024;
                  args.push('--js_max_memory_store', bytes.toString());
                }
              }
              if (node.syncInterval) {
                args.push('--sync_interval', node.syncInterval);
              }
            }
          }

          log(startupLogMessage);
          setStatus('starting', statusText);
          log(`Spawning: ${natsServerBin} ${args.join(' ')}`);

          // Spawn the nats-server process
          natsServerProcess = spawn(natsServerBin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
          });

          let started = false;
          let startupOutput = '';

          const checkStarted = (data) => {
            startupOutput += data.toString();
            // NATS server outputs "Server is ready" when fully started
            if (!started && (startupOutput.includes('Server is ready') || startupOutput.includes('Listening for client connections'))) {
              started = true;
              serverPort = actualPort; // Use actualPort (embedded or leaf port)
              const versionText = natsServerVersion !== 'unknown' ? `v${natsServerVersion}` : '';
              const sourceLabel = binarySourceUsed === 'custom' ? 'bin' : (binarySourceUsed === 'system' ? 'sys' : 'npm');
              const statusText = `${sourceLabel}:${serverPort} ${versionText}`.trim();
              log(`Embedded NATS server is running on port ${serverPort} (${versionText})`);
              setStatus('running', statusText);
              
              const startedPayload = {
                type: enableLeafNode ? 'leaf' : 'embedded',
                port: serverPort,
                url: `nats://localhost:${serverPort}`,
                pid: natsServerProcess.pid,
                version: natsServerVersion,
                jetstream: enableJetStream || enableMqtt, // MQTT requires JetStream
                mqtt: enableMqtt ? {
                  enabled: true,
                  port: parseInt(node.mqttPort) || 1883,
                  url: `mqtt://localhost:${parseInt(node.mqttPort) || 1883}`
                } : { enabled: false },
                binarySource: binarySourceUsed,
                binaryPath: natsServerBin,
                config: {
                  serverName: node.serverName || null,
                  maxConnections: node.maxConnections || null,
                  maxPayload: node.maxPayload || null,
                  httpPort: node.httpPort || null
                }
              };
              
              // Add monitoring URL if HTTP port is configured
              if (node.httpPort) {
                startedPayload.monitoringUrl = `http://localhost:${node.httpPort}`;
                startedPayload.endpoints = {
                  varz: `http://localhost:${node.httpPort}/varz`,
                  connz: `http://localhost:${node.httpPort}/connz`,
                  subsz: `http://localhost:${node.httpPort}/subsz`,
                  healthz: `http://localhost:${node.httpPort}/healthz`
                };
                if (enableJetStream) {
                  startedPayload.endpoints.jsz = `http://localhost:${node.httpPort}/jsz`;
                }
              }
              
              node.send({
                topic: 'server.started',
                payload: startedPayload
              });
              resolve();
            }
          };

          natsServerProcess.stdout.on('data', (data) => {
            if (node.debug) {
              node.log(`[NATS-SERVER stdout] ${data.toString().trim()}`);
            }
            checkStarted(data);
          });

          natsServerProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            // NATS server logs to stderr by default
            if (node.debug) {
              node.log(`[NATS-SERVER] ${output}`);
            }
            checkStarted(data);
          });

          natsServerProcess.on('error', (err) => {
            node.error(`Failed to start embedded NATS server: ${err.message}`);
            setStatus('error', err.message.substring(0, 20));
            natsServerProcess = null;
            reject(err);
          });

          natsServerProcess.on('exit', (code, signal) => {
            if (!started) {
              node.error(`Embedded NATS server exited before starting. Code: ${code}, Signal: ${signal}`);
              setStatus('error', `exit: ${code || signal}`);
              // Clean up config file if it was created
              if (configFile) {
                try {
                  fs.unlinkSync(configFile);
                } catch (e) {
                  node.warn(`Failed to delete temporary config file: ${e.message}`);
                }
              }
              reject(new Error(`Server exited with code ${code}`));
            } else {
              log(`Embedded NATS server stopped. Code: ${code}, Signal: ${signal}`);
              setStatus('stopped', 'stopped');
              // Clean up config file if it was created
              if (configFile) {
                try {
                  fs.unlinkSync(configFile);
                } catch (e) {
                  node.warn(`Failed to delete temporary config file: ${e.message}`);
                }
              }
            }
            natsServerProcess = null;
            serverPort = null;
          });

          // Timeout for startup
          setTimeout(() => {
            if (!started) {
              node.error('Embedded NATS server start timeout');
              setStatus('error', 'start timeout');
              if (natsServerProcess) {
                natsServerProcess.kill('SIGTERM');
                natsServerProcess = null;
              }
              // Clean up config file if it was created
              if (configFile) {
                try {
                  fs.unlinkSync(configFile);
                } catch (e) {
                  node.warn(`Failed to delete temporary config file: ${e.message}`);
                }
              }
              reject(new Error('Server start timeout'));
            }
          }, 10000);

        });
      } catch (err) {
        node.error(`Failed to start embedded server: ${err.message}`);
        setStatus('error', err.message.substring(0, 20));
        throw err; // Re-throw the error to be caught by the caller
      }
    };

    // Stop server
    const stopServer = async () => {
      log('Stopping NATS server...');
      setStatus('stopped', 'stopping...');

      // Clean up config file if it was created
      if (configFile) {
        try {
          fs.unlinkSync(configFile);
        } catch (e) {
          node.warn(`Failed to delete temporary config file: ${e.message}`);
        }
        configFile = null; // Reset configFile after cleanup
      }

      if (natsServerProcess) {
        // Process server
        natsServerProcess.kill('SIGTERM');
        natsServerProcess = null;
        log('Server process stopped');
      }

      serverPort = null;
      setStatus('stopped');
      node.send({
        topic: 'server.stopped',
        payload: { type: node.serverType }
      });
    };

    // Start server (always embedded now)
    const startServer = async () => {
      try {
        await startEmbeddedServer();
      } catch (err) {
        node.error(`Error while starting: ${err.message}`);
        setStatus('error', err.message.substring(0, 20));
      }
    };

    // Input handler
    node.on('input', async (msg) => {
      const command = msg.payload?.command || msg.topic;

      if (!command) {
        node.warn('No command specified. Use msg.payload.command or msg.topic with: start, stop, restart, status, toggle');
        return;
      }

      switch (command) {
        case 'start':
          if (natsServerProcess) {
            node.warn('Server is already running');
            return;
          }
          await startServer();
          break;
        case 'stop':
          if (!natsServerProcess) {
            node.warn('Server is not running');
            return;
          }
          await stopServer();
          break;
        case 'restart':
          await stopServer();
          setTimeout(() => startServer(), 1000);
          break;
        case 'status':
          node.send({
            topic: 'server.status',
            payload: {
              running: !!(natsServerProcess),
              type: 'embedded', // Always embedded now
              port: serverPort,
              url: serverPort ? `nats://localhost:${serverPort}` : null,
              version: natsServerVersion // Add NATS server version here
            }
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
          node.warn(`Unknown command: "${command}". Valid commands: start, stop, restart, status, toggle`);
          break;
      }
    });

    // Auto-start if configured
    if (node.autoStart) {
      setTimeout(() => {
        startServer();
      }, 1000);
    } else {
      setStatus('stopped');
    }

    // Cleanup on close
    node.on('close', async () => {
      await stopServer();
    });
  }

  RED.nodes.registerType('nats-suite-server-manager', NatsServerManagerNode);
};

