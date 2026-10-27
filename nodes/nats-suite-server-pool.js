'use strict';

const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsServerPoolNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    this.config = resolveServer(RED, node, config);
    if (!this.config) return;

    const operation = config.operation || 'get-servers';
    const reconnectAfterSet = !!config.reconnectAfterSet;

    const detachStatus = attachStatus(node, this.config);
    this.config.registerConnectionUser(node.id);

    // Shared by both operations: the resulting pool, in both the plain
    // round-trip shape (.listen) and the full diagnostic shape.
    function emitCurrentPool(msg) {
      const servers = node.config.getServers();
      msg.payload = servers.map(s => s.listen);
      msg.servers = servers;
    }

    node.on('input', async function (msg, send, done) {
      try {
        if (node.config.connectionStatus !== 'connected') {
          done({
            message: 'Cannot get/set servers - NATS server is not connected',
            code: 'NOT_CONNECTED',
            status: node.config.connectionStatus,
            reconnectAttempts: node.config.connectionStats.reconnectAttempts,
          });
          return;
        }

        const op = msg.operation || operation;

        if (op === 'get-servers') {
          emitCurrentPool(msg);
          send(msg);
          done();
          return;
        }

        if (op === 'set-servers') {
          const list = msg.payload;
          if (
            !Array.isArray(list) ||
            list.length === 0 ||
            !list.every(s => typeof s === 'string' && s.trim() !== '')
          ) {
            done(
              new Error(
                'set-servers: msg.payload must be a non-empty array of non-empty host:port strings'
              )
            );
            return;
          }

          try {
            node.config.setServers(list);
          } catch (err) {
            done(new Error(`set-servers failed: ${err.message}`));
            return;
          }

          const shouldReconnect =
            msg.reconnectAfterSet !== undefined
              ? !!msg.reconnectAfterSet
              : reconnectAfterSet;
          if (shouldReconnect) {
            try {
              await node.config.reconnect();
            } catch (err) {
              done(
                new Error(`reconnect after set-servers failed: ${err.message}`)
              );
              return;
            }
          }

          emitCurrentPool(msg);
          send(msg);
          done();
          return;
        }

        done(new Error(`Unknown operation: ${op}`));
      } catch (err) {
        done(err);
      }
    });

    node.on('close', function (done) {
      detachStatus();
      node.config.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-server-pool', NatsServerPoolNode);
};
