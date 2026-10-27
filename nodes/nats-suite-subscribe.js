'use strict';

const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');
const { fromMsg } = require('../lib/payload');

module.exports = function (RED) {
  function NatsSubscribeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let closing = false;

    // Define status functions
    const setStatusRed = () => {
      if (!closing)
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
    };

    const setStatusGreen = () => {
      if (!closing)
        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
    };

    const setStatusYellow = () => {
      if (!closing)
        node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
    };

    setStatusRed();

    this.config = resolveServer(RED, node, config);
    if (!this.config) return;

    let subscription = null;
    let subscriptionIterator = null; // For Async Iterator cleanup
    let currentSubject = ''; // Current active subscription subject
    const baseSubject = config.datapointid || ''; // Base subject from config (fallback)
    let connectionStartTime = null;
    let queueGroup = null; // Queue group for load balancing
    const baseQueueGroup = config.queueGroup || ''; // Base queue group from config (fallback)

    // Message logging: Only log if debug flag is set
    const isDebug = !!config.debug;

    // Initialize with base subject if available
    if (baseSubject) {
      currentSubject = baseSubject;
      if (isDebug) {
        node.log(
          `[[NATS-SUITE SUBSCRIBE] Initialized with base subject: ${baseSubject}`
        );
      }
    }

    // Initialize with base queue group if available
    if (baseQueueGroup) {
      queueGroup = baseQueueGroup;
      if (isDebug) {
        node.log(
          `[[NATS-SUITE SUBSCRIBE] Initialized with base queue group: ${baseQueueGroup}`
        );
      }
    }

    // Parse mode
    const parseMode = config.dataformat || 'auto';

    // Subscription mode: static or dynamic
    const subscriptionMode = config.subscriptionMode || 'static';

    // Helper function for message processing (DRY principle)
    const processMessage = msg => {
      if (closing) return;
      if (isDebug) {
        node.log(
          `[[NATS-SUITE SUBSCRIBE] Processing message from subject: ${currentSubject}`
        );
      }

      let send_message;

      try {
        let parsedPayload;
        try {
          parsedPayload = fromMsg(msg, parseMode);
        } catch (parseError) {
          // Only forced 'json' mode can throw here (see lib/payload.js).
          if (isDebug) {
            node.log(
              `[NATS-SUITE SUBSCRIBE] JSON parsing failed: ${parseError.message}`
            );
          }
          node.error(
            {
              message: 'JSON parsing failed',
              code: 'JSON_PARSE_ERROR',
              originalError: parseError.message,
            },
            {
              topic: msg.subject,
              rawData: msg.string(),
            }
          );
          return;
        }

        send_message = {
          topic: msg.subject,
          payload: parsedPayload,
        };

        if (msg.reply) {
          send_message._reply = msg.reply;
          if (isDebug) {
            node.log(`[NATS-SUITE SUBSCRIBE] Reply-To subject: ${msg.reply}`);
          }
        }

        if (msg.headers) {
          const headers = {};
          for (const [key, values] of msg.headers) {
            headers[key] = values.length === 1 ? values[0] : values;
          }
          send_message.headers = headers;
        }

        if (isDebug) {
          node.log(`[NATS-SUITE SUBSCRIBE] Sending output message`);
        }

        node.send(send_message);
      } catch (err) {
        const cleanError = {
          message: err.message || 'Unknown error',
          code: err.code || 'UNKNOWN',
          name: err.name || 'Error',
        };
        if (isDebug) {
          node.log(
            `[[NATS-SUITE SUBSCRIBE] Error processing message: ${err.stack}`
          );
        }
        // Safe error reporting with fallback
        node.error(cleanError, {
          topic: currentSubject || baseSubject,
          rawData: msg?.data ? String(msg.data) : 'N/A',
          errorContext: 'processMessage',
        });
      }
    };

    const setupSubscription = async (
      newSubject = null,
      newQueueGroup = null
    ) => {
      try {
        const natsnc = await this.config.getConnection();
        if (closing) return;

        // Determine subject to use
        // If newSubject is explicitly null, keep current; if undefined, use current/base
        let targetSubject;
        if (newSubject === null && subscriptionMode === 'dynamic') {
          // In dynamic mode, null means "keep current"
          targetSubject = currentSubject || baseSubject;
        } else if (newSubject !== null && newSubject !== undefined) {
          // Explicit new subject provided
          targetSubject = newSubject;
        } else {
          // Use current or base
          targetSubject = currentSubject || baseSubject;
        }

        if (!targetSubject || targetSubject.trim() === '') {
          setStatusRed();
          if (isDebug) {
            node.log(
              `[[NATS-SUITE SUBSCRIBE] setupSubscription aborted: no subject specified`
            );
          }
          throw new Error(
            'No subject specified. Please configure a NATS subject or provide msg.topic/msg.subject.'
          );
        }

        // Determine queue group
        const targetQueueGroup =
          newQueueGroup !== null ? newQueueGroup : queueGroup;

        // Check if subscription already exists and is active
        const hasActiveSubscription = subscription !== null;

        // Only update if subject or queue group actually changed, OR if no subscription exists yet
        const subjectChanged = targetSubject !== currentSubject;
        const queueGroupChanged = targetQueueGroup !== queueGroup;
        const needsNewSubscription =
          !hasActiveSubscription || subjectChanged || queueGroupChanged;

        if (needsNewSubscription) {
          // Cleanup old subscription
          if (subscription) {
            if (isDebug) {
              node.log(
                `[[NATS-SUITE SUBSCRIBE] Unsubscribing from previous subscription`
              );
            }
            subscription.unsubscribe();
            if (subscriptionIterator) await subscriptionIterator;
            if (closing) return;
            subscription = null;
          }

          subscriptionIterator = null;

          // Update current subject and queue group
          currentSubject = targetSubject;
          queueGroup = targetQueueGroup;
        } else {
          // No change needed, subscription already active
          return;
        }

        // New subscription with modern Async Iterator API
        if (targetQueueGroup) {
          // Subscribe with queue group for load balancing
          subscription = natsnc.subscribe(targetSubject, {
            queue: targetQueueGroup,
          });
          if (isDebug) {
            node.log(
              `Subscribed to "${targetSubject}" with queue group "${targetQueueGroup}"`
            );
            node.log(
              `[NATS-SUITE SUBSCRIBE] Subscription created for "${targetSubject}" with queue "${targetQueueGroup}"`
            );
          }
        } else {
          // Regular subscription without queue group
          subscription = natsnc.subscribe(targetSubject);
          if (isDebug) {
            node.log(`Subscribed to "${targetSubject}"`);
            node.log(
              `[NATS-SUITE SUBSCRIBE] Subscription created for "${targetSubject}"`
            );
          }
        }
        const activeSubscription = subscription;

        // Async iterator for message processing. Verified against the real
        // server (@nats-io/nats-core 3.4.0): the for-await loop never throws
        // on unsubscribe() or connection close - it just returns. The only
        // way to learn *why* it ended is `subscription.closed`, which
        // resolves (never rejects) to `undefined` on a normal close or an
        // Error on a server-side closure (e.g. a permissions violation).
        subscriptionIterator = (async () => {
          if (isDebug) {
            node.log(
              `[[NATS-SUITE SUBSCRIBE] Message listener started, waiting for messages...`
            );
          }
          for await (const msg of activeSubscription) {
            processMessage(msg);
          }
          if (closing) return;
          const closeErr = await activeSubscription.closed;
          if (closeErr && !closing) {
            const cleanError = {
              message: closeErr.message,
              code: closeErr.code,
              name: closeErr.name,
            };
            if (isDebug) {
              node.log(
                `[[NATS-SUITE SUBSCRIBE] Subscription closed with error: ${closeErr.message}`
              );
            }
            node.error(cleanError, { topic: targetSubject });
          }
        })();
      } catch (err) {
        if (closing) return;
        if (isDebug) {
          node.log(
            `[[NATS-SUITE SUBSCRIBE] setupSubscription error: ${err.message}`
          );
        }
        throw err;
      }
    };

    // Status listener on the server config for connection status painting.
    const detachStatus = attachStatus(node, this.config, {
      connected: () => {
        if (isDebug) node.log(`[NATS-SUITE SUBSCRIBE] Server connected`);

        const connectionTime = connectionStartTime
          ? Math.floor((Date.now() - connectionStartTime) / 1000)
          : 0;
        if (connectionTime > 5) {
          node.warn(`NATS connection established after ${connectionTime}s`);
        }

        setStatusGreen();
        // Subscription is established once at node start and survives native
        // reconnect (the client transparently restores it), so it is not
        // re-created here.
      },
      disconnected: () => {
        if (isDebug) node.log(`[NATS-SUITE SUBSCRIBE] Server disconnected`);

        setStatusRed();
        // Native reconnect restores the subscription itself; do not tear it
        // down here.
      },
      connecting: () => {
        if (isDebug) node.log(`[NATS-SUITE SUBSCRIBE] Server connecting...`);

        setStatusYellow();
        connectionStartTime = Date.now();
      },
    });

    // Connection Pool: Register this node as connection user
    this.config.registerConnectionUser(node.id);

    // Establish the subscription once at node start. getConnection() resolves
    // once connected, and the connection's identity is stable across native
    // reconnects, so this never needs to run again. setupSubscription() is
    // itself idempotent (it no-ops if the subject/queue hasn't changed).
    if (currentSubject || baseSubject) {
      const initializeSubscription = async () => {
        try {
          await setupSubscription();
        } catch (err) {
          if (!closing)
            node.error(err, { topic: currentSubject || baseSubject });
        }
      };
      initializeSubscription();
    }

    // Input handler for dynamic subscription changes
    node.on('input', async (msg, send, done) => {
      try {
        // Only process dynamic subscription changes if mode is set to dynamic
        if (subscriptionMode !== 'dynamic') {
          if (isDebug) {
            node.log(
              `[[NATS-SUITE SUBSCRIBE] Input received but subscription mode is static, ignoring`
            );
          }
          // In static mode, ignore input messages for subscription changes
          // Input messages are not used for subscription management
          done();
          return;
        }

        if (isDebug) {
          node.log(
            `[[NATS-SUITE SUBSCRIBE] Input received in dynamic mode, checking for subject/queue updates`
          );
        }

        // Check for dynamic subject in msg properties
        const dynamicSubject = msg.topic || msg.subject || null;
        const dynamicQueueGroup = msg.queueGroup || msg.queue || null;

        if (isDebug) {
          if (dynamicSubject) {
            node.log(
              `[[NATS-SUITE SUBSCRIBE] Dynamic subject from input: ${dynamicSubject}`
            );
          }
          if (dynamicQueueGroup) {
            node.log(
              `[[NATS-SUITE SUBSCRIBE] Dynamic queue group from input: ${dynamicQueueGroup}`
            );
          }
        }

        // Only update subscription if subject or queue group is provided
        if (dynamicSubject || dynamicQueueGroup !== null) {
          try {
            const natsnc = await this.config.getConnection();

            // Check if connection is ready
            if (!natsnc || natsnc.isClosed()) {
              node.warn(
                'NATS connection not ready. Subscription change will be applied when connected.'
              );
              if (isDebug) {
                node.log(
                  `[[NATS-SUITE SUBSCRIBE] NATS connection not ready for subscription update`
                );
              }
              done();
              return;
            }

            // Update subscription with new subject/queue group
            // If dynamicSubject is null but dynamicQueueGroup is set, keep current subject
            // If dynamicSubject is empty string, reset to base subject
            const newSubject =
              dynamicSubject !== null ? dynamicSubject || baseSubject : null;
            if (isDebug) {
              node.log(
                `[[NATS-SUITE SUBSCRIBE] Updating subscription with subject: ${newSubject}${dynamicQueueGroup ? `, queue: ${dynamicQueueGroup}` : ''}`
              );
            }
            await setupSubscription(newSubject, dynamicQueueGroup);
          } catch (err) {
            setStatusRed();
            throw err;
          }
          done();
        } else {
          // No dynamic properties provided - reset to base subject if in dynamic mode
          if (currentSubject !== baseSubject) {
            try {
              const natsnc = await this.config.getConnection();
              if (natsnc && !natsnc.isClosed()) {
                if (isDebug) {
                  node.log(
                    `[[NATS-SUITE SUBSCRIBE] Resetting subscription to base subject: ${baseSubject}`
                  );
                }
                await setupSubscription(baseSubject, null);
              }
            } catch (err) {
              setStatusRed();
              throw err;
            }
          }
          done();
        }
      } catch (err) {
        if (closing) {
          done();
          return;
        }
        // Genuinely unexpected - every anticipated failure above was already
        // logged and swallowed on purpose; escalate this one via done(err)
        // instead of node.error(), which would double-fire Catch nodes.
        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] Input handler error: ${err.stack}`);
        }
        done(err);
      }
    });

    // on node close
    node.on('close', async function (done) {
      let closeError;
      try {
        closing = true;
        detachStatus();
        if (subscription) {
          if (isDebug) {
            node.log('Unsubscribing from subscription on close');
          }
          subscription.unsubscribe();
          if (subscriptionIterator) await subscriptionIterator;
        }
      } catch (err) {
        closeError = err;
      } finally {
        this.config.unregisterConnectionUser(node.id);
        done(closeError);
      }
    });
  }

  RED.nodes.registerType('nats-suite-subscribe', NatsSubscribeNode);
};
