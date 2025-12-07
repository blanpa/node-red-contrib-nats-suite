'use strict';

module.exports = function (RED) {
  function NatsStatsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    if (!config.server) {
      node.error('NATS server configuration not selected');
      return;
    }

    this.serverConfig = RED.nodes.getNode(config.server);
    if (!this.serverConfig) {
      node.error('NATS server configuration not found');
      return;
    }

    this.serverConfig.registerConnectionUser(node.id);
    node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });

    node.on('input', async function (msg) {
      try {
        const nc = await node.serverConfig.getConnection();
        const statsType = msg.statsType || config.statsType || 'server';

        switch (statsType) {
          case 'server': {
            const stats = nc.stats();
            msg.payload = {
              type: 'server',
              inMsgs: stats.inMsgs,
              outMsgs: stats.outMsgs,
              inBytes: stats.inBytes,
              outBytes: stats.outBytes,
              reconnects: stats.reconnects
            };
            break;
          }

          case 'jetstream': {
            const jsm = await nc.jetstreamManager();
            const accountInfo = await jsm.account.info();
            msg.payload = {
              type: 'jetstream',
              memory: accountInfo.memory,
              store: accountInfo.store,
              api: accountInfo.api,
              limits: accountInfo.limits
            };
            break;
          }

          case 'connections': {
            const serverInfo = await nc.info();
            msg.payload = {
              type: 'connections',
              server_id: serverInfo.server_id,
              version: serverInfo.version,
              connections: serverInfo.connections || 0
            };
            break;
          }

          case 'all': {
            const stats = nc.stats();
            const jsm = await nc.jetstreamManager();
            const accountInfo = await jsm.account.info();
            const serverInfo = await nc.info();
            
            msg.payload = {
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
            break;
          }

          default:
            node.error(`Unknown stats type: ${statsType}`);
            return;
        }

        node.send(msg);
        node.status({ fill: 'green', shape: 'dot', text: statsType });
      } catch (err) {
        node.error(`Stats failed: ${err.message}`, msg);
        msg.error = err.message;
        node.send(msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    node.on('close', function () {
      node.serverConfig.removeConnectionUser(node.id);
    });
  }

  RED.nodes.registerType('nats-suite-stats', NatsStatsNode);
};

