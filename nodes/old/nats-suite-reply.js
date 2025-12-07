'use strict';

const { StringCodec } = require('nats');

module.exports = function (RED) {
  function NatsReplyNode(config) {
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
    const sc = StringCodec();
    let subscription = null;

    node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });

    // Subscribe to subject for incoming requests
    const startSubscription = async () => {
      try {
        const nc = await node.serverConfig.getConnection();
        const subject = config.subject || '';
        
        if (!subject) {
          node.status({ fill: 'red', shape: 'ring', text: 'no subject' });
          return;
        }

        subscription = nc.subscribe(subject, {
          callback: (err, msg) => {
            if (err) {
              node.error(`Subscription error: ${err.message}`);
              return;
            }

            // Prepare reply message
            const replyMsg = {
              payload: sc.decode(msg.data),
              topic: msg.subject,
              _reply: msg.reply,
              _headers: msg.headers
            };

            // Send to output for processing
            node.send(replyMsg);
          }
        });

        node.status({ fill: 'green', shape: 'dot', text: `listening: ${subject}` });
      } catch (err) {
        node.error(`Failed to subscribe: ${err.message}`);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    };

    // Handle incoming messages (requests) and outgoing replies
    node.on('input', async function (msg) {
      try {
        const nc = await node.serverConfig.getConnection();

        // If message has reply subject, send reply
        if (msg._reply || msg.reply) {
          const replySubject = msg._reply || msg.reply;
          let replyData;

          if (typeof msg.payload === 'object') {
            replyData = JSON.stringify(msg.payload);
          } else {
            replyData = String(msg.payload);
          }

          nc.publish(replySubject, sc.encode(replyData), {
            headers: msg.headers
          });

          node.status({ fill: 'green', shape: 'dot', text: 'replied' });
        } else {
          // Start subscription if not already started
          if (!subscription) {
            await startSubscription();
          }
        }
      } catch (err) {
        node.error(`Reply failed: ${err.message}`, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // Start subscription on deploy if subject is configured
    if (config.subject) {
      setTimeout(() => startSubscription(), 1000);
    }

    node.on('close', function () {
      if (subscription) {
        subscription.unsubscribe();
      }
      node.serverConfig.removeConnectionUser(node.id);
    });
  }

  RED.nodes.registerType('nats-suite-reply', NatsReplyNode);
};

