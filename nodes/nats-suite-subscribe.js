'use strict';

const { StringCodec } = require('nats');

// NATS Error Code Constants
const NATS_ERROR_CODES = {
  CANCELLED: 'CANCELLED',
  BAD_SUBSCRIPTION: 'BAD_SUBSCRIPTION',
  TIMEOUT: 'TIMEOUT',
  SERVICE_UNAVAILABLE: '503'
};

module.exports = function (RED) {
  function NatsSubscribeNode(config) {
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
      node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
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

    let subscription = null;
    let subscriptionIterator = null; // For Async Iterator cleanup
    let currentSubject = ''; // Current active subscription subject
    let baseSubject = ''; // Base subject from config (fallback)
    let connectionTimeout = null;
    let connectionStartTime = null;
    let queueGroup = null; // Queue group for load balancing
    let baseQueueGroup = ''; // Base queue group from config (fallback)

    // Message logging: Only log if debug flag is set
    const isDebug = !!config.debug;

    // Get base subject from config (used as fallback if no dynamic subject provided)
    baseSubject = config.datapointid || '';
    
    // Get base queue group from config (used as fallback if no dynamic queue group provided)
    baseQueueGroup = config.queueGroup || '';
    
    // Initialize with base subject if available
    if (baseSubject) {
      currentSubject = baseSubject;
      if (isDebug) {
        node.log(`[[NATS-SUITE SUBSCRIBE] Initialized with base subject: ${baseSubject}`);
      }
    }
    
    // Initialize with base queue group if available
    if (baseQueueGroup) {
      queueGroup = baseQueueGroup;
      if (isDebug) {
        node.log(`[[NATS-SUITE SUBSCRIBE] Initialized with base queue group: ${baseQueueGroup}`);
      }
    }
    
    // Parse mode
    const parseMode = config.dataformat || 'auto';
    
    // Subscription mode: static or dynamic
    const subscriptionMode = config.subscriptionMode || 'static';

    // Create StringCodec once for performance
    const sc = StringCodec();

    // Helper function for message processing (DRY principle)
    const processMessage = (msg) => {
      if (isDebug) {
        node.log(`[[NATS-SUITE SUBSCRIBE] Processing message from subject: ${currentSubject}`);
      }
      
      let message = sc.decode(msg.data);
      let send_message;

      try {
        // Parse based on mode
        let parsedPayload = message;
        
        switch (parseMode) {
          case 'auto':
            // Auto-detect: Try JSON, fallback to string
            if (typeof message === 'string' && message.trim().length > 0) {
              try {
                parsedPayload = JSON.parse(message);
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Parsed message as JSON`);
                }
              } catch (parseError) {
                // Keep as string (expected for non-JSON messages)
                parsedPayload = message;
              }
            }
            break;
            
          case 'json':
            // Force JSON parsing
            try {
              parsedPayload = JSON.parse(message);
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Parsed message as JSON (forced mode)`);
              }
            } catch (parseError) {
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] JSON parsing failed: ${parseError.message}`);
              }
              node.error({
                message: 'JSON parsing failed',
                code: 'JSON_PARSE_ERROR',
                originalError: parseError.message
              }, {
                topic: msg.subject,
                rawData: message
              });
              return; // Stop processing on error
            }
            break;
            
          case 'string':
            // Keep as string
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Message kept as string`);
            }
            parsedPayload = message;
            break;
            
          case 'buffer':
            // Keep as buffer
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Message kept as buffer`);
            }
            parsedPayload = msg.data;
            break;
            
          // Legacy formats (kept for backward compatibility)
          case 'uns_value':
            // Safe JSON parsing with error handling
            try {
              message = JSON.parse(message);
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Parsed uns_value message as JSON`);
              }
            } catch (parseError) {
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] JSON parsing failed for uns_value: ${parseError.message}`);
              }
              node.error({
                message: 'Invalid JSON in NATS-SUITE value message',
                code: 'JSON_PARSE_ERROR',
                originalError: parseError.message
              }, { 
                topic: msg.subject, 
                rawData: message,
                errorContext: 'uns_value parsing'
              });
              return; // Stop processing on invalid JSON
            }
            
            // Datatype conversion with switch for better performance & readability
            switch (message.datatype) {
              case 1: // Integer
                message.value = parseInt(message.value, 10);
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Converted value to integer: ${message.value}`);
                }
                break;
              case 2: // Float
                message.value = parseFloat(message.value);
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Converted value to float: ${message.value}`);
                }
                break;
              case 3: // Boolean
                message.value = message.value === 'true' || message.value === '1';
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Converted value to boolean: ${message.value}`);
                }
                break;
              case 4: // String
                // String stays string - no conversion needed
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Value is string type`);
                }
                break;
              case 5: // JSON
                try {
                  message.value = JSON.parse(message.value);
                  if (isDebug) {
                    node.log(`[[NATS-SUITE SUBSCRIBE] Converted value to JSON`);
                  }
                } catch (e) {
                  // If JSON parsing fails, keep as string
                  if (isDebug) {
                    node.log(`[[NATS-SUITE SUBSCRIBE] JSON parsing failed for value, keeping as string`);
                  }
                  // Silent fail - keep as string
                }
                break;
              default:
                // Unknown datatype - value stays unchanged
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Unknown datatype ${message.datatype}, value unchanged`);
                }
                break;
            }
            
            // For NATS-SUITE Value: Only value as payload, rest as msg properties
            send_message = {
              topic: msg.subject,
              payload: message.value,
              datatype: message.datatype,
              id: message.id,
              name: message.name,
              timestamp: message.timestamp
            };
            break;
          case 'uns_event':
            // For NATS-SUITE Events: Parse JSON and extract event information
            try {
              message = JSON.parse(message);
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Parsed uns_event message as JSON`);
              }
              
              // Set topic field based on configuration
              let topicValue = msg.subject; // Default
              if (config.topicfield === 'id') {
                topicValue = message.id;
              } else if (config.topicfield === 'name') {
                topicValue = message.type || 'event';
              } else if (config.topicfield === 'datatype') {
                topicValue = 'event';
              }
              
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Event topic set to: ${topicValue}`);
              }
              
              // For NATS-SUITE Events: Event details as payload, additional properties available
              send_message = {
                topic: topicValue,
                payload: message.payload || message,
                id: message.id,
                type: message.type,
                startTime: message.startTime,
                endTime: message.endTime,
                timestamp: message.timestamp || Date.now()
              };
            } catch (parseError) {
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] JSON parsing failed for uns_event: ${parseError.message}`);
              }
              // If JSON parsing fails, log error and use raw message
              node.warn({
                message: 'Invalid JSON in NATS-SUITE event message, using raw data',
                code: 'JSON_PARSE_ERROR',
                originalError: parseError.message
              });
              send_message = {
                topic: msg.subject,
                payload: message,
                _parseError: true
              };
            }
            break;
        }
        
        // If not legacy format, create standard message
        if (!send_message) {
          send_message = {
            topic: msg.subject,
            payload: parsedPayload
          };
        }

        // Add reply subject if present (NATS message has reply property)
        if (msg.reply) {
          send_message._reply = msg.reply;
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Reply-To subject: ${msg.reply}`);
          }
        }
        
        // Also preserve any existing reply fields from the message
        if (msg._reply && !send_message._reply) {
          send_message._reply = msg._reply;
        }

        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] Sending output message`);
        }

        node.send(send_message);
      } catch (err) {
        const cleanError = {
          message: err.message || 'Unknown error',
          code: err.code || 'UNKNOWN',
          name: err.name || 'Error',
        };
        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] Error processing message: ${err.stack}`);
        }
        // Safe error reporting with fallback
        node.error(cleanError, { 
          topic: currentSubject || baseSubject, 
          rawData: msg?.data ? String(msg.data) : 'N/A',
          errorContext: 'processMessage'
        });
      }
    };

    const setupSubscription = async (newSubject = null, newQueueGroup = null) => {
      try {
        const natsnc = await this.config.getConnection();
        
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
          node.error('No subject specified. Please configure a NATS subject or provide msg.topic/msg.subject.');
          setStatusRed();
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] setupSubscription aborted: no subject specified`);
          }
          return;
        }
        
        // Determine queue group
        const targetQueueGroup = newQueueGroup !== null ? newQueueGroup : queueGroup;
        
        // Check if subscription already exists and is active
        const hasActiveSubscription = subscription !== null;
        
        // Only update if subject or queue group actually changed, OR if no subscription exists yet
        const subjectChanged = targetSubject !== currentSubject;
        const queueGroupChanged = targetQueueGroup !== queueGroup;
        const needsNewSubscription = !hasActiveSubscription || subjectChanged || queueGroupChanged;
        
        if (needsNewSubscription) {
          // Cleanup old subscription
          if (subscription) {
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Unsubscribing from previous subscription`);
            }
            subscription.unsubscribe();
            subscription = null;
          }
          
          // Cleanup running iterator
          if (subscriptionIterator) {
            subscriptionIterator = null;
          }
          
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
          subscription = natsnc.subscribe(targetSubject, { queue: targetQueueGroup });
          node.log(`Subscribed to "${targetSubject}" with queue group "${targetQueueGroup}"`);
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Subscription created for "${targetSubject}" with queue "${targetQueueGroup}"`);
          }
        } else {
          // Regular subscription without queue group
          subscription = natsnc.subscribe(targetSubject);
          node.log(`Subscribed to "${targetSubject}"`);
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Subscription created for "${targetSubject}"`);
          }
        }
        
        // Async iterator for message processing
        subscriptionIterator = (async () => {
          try {
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Message listener started, waiting for messages...`);
            }
            for await (const msg of subscription) {
              processMessage(msg);
            }
          } catch (err) {
            // Iterator was stopped or error occurred
            if (err.code !== NATS_ERROR_CODES.CANCELLED && err.code !== NATS_ERROR_CODES.BAD_SUBSCRIPTION) {
              const cleanError = {
                message: err.message,
                code: err.code,
                name: err.name,
              };
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Iterator error: ${err.code} - ${err.message}`);
              }
              node.error(cleanError, { topic: currentSubject });
            }
          }
        })();
        
      } catch (err) {
        const cleanError = {
          message: err.message,
          code: err.code,
          name: err.name,
        };
        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] setupSubscription error: ${err.message}`);
        }
        node.error(cleanError, { topic: currentSubject || baseSubject });
      }
    };

    // Add status listener to server config
    const statusListener = status => {
      // Handle both old format (string) and new format (object)
      const statusValue = typeof status === 'object' ? status.status : status;
      
      switch (statusValue) {
        case 'connected':
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Server connected`);
          }
          
          // Clear connection timeout
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          const connectionTime = connectionStartTime ? Math.floor((Date.now() - connectionStartTime) / 1000) : 0;
          if (connectionTime > 5) {
            node.warn(`NATS connection established after ${connectionTime}s`);
          }
          
          setStatusGreen();
          // Only setup subscription if we have a subject (from config or previous input)
          if (currentSubject || baseSubject) {
            setupSubscription();
          }
          break;
        case 'disconnected':
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Server disconnected`);
          }
          
          // Clear connection timeout
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          setStatusRed();
          if (subscription) {
            subscription.unsubscribe();
            subscription = null;
          }
          break;
        case 'connecting':
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Server connecting...`);
          }
          
          setStatusYellow();
          
          // Start connection timeout warning
          connectionStartTime = Date.now();
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          
          // Warn after 10 seconds
          connectionTimeout = setTimeout(() => {
            const elapsed = Math.floor((Date.now() - connectionStartTime) / 1000);
            node.warn(`NATS connection taking longer than expected (${elapsed}s). Check server availability.`);
            setStatusYellow();
          }, 10000);
          break;
        default:
          // Unknown status - ignore
      }
    };

    this.config.addStatusListener(statusListener);
    
    // Connection Pool: Register this node as connection user
    this.config.registerConnectionUser(node.id);


    // Input handler for dynamic subscription changes
    node.on('input', async (msg) => {
      try {
        // Only process dynamic subscription changes if mode is set to dynamic
        if (subscriptionMode !== 'dynamic') {
          if (isDebug) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Input received but subscription mode is static, ignoring`);
          }
          // In static mode, ignore input messages for subscription changes
          // Input messages are not used for subscription management
          return;
        }
        
        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] Input received in dynamic mode, checking for subject/queue updates`);
        }
        
        // Check for dynamic subject in msg properties
        const dynamicSubject = msg.topic || msg.subject || null;
        const dynamicQueueGroup = msg.queueGroup || msg.queue || null;
        
        if (isDebug) {
          if (dynamicSubject) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Dynamic subject from input: ${dynamicSubject}`);
          }
          if (dynamicQueueGroup) {
            node.log(`[[NATS-SUITE SUBSCRIBE] Dynamic queue group from input: ${dynamicQueueGroup}`);
          }
        }
        
        // Only update subscription if subject or queue group is provided
        if (dynamicSubject || dynamicQueueGroup !== null) {
          try {
            const natsnc = await this.config.getConnection();
            
            // Check if connection is ready
            if (!natsnc || natsnc.isClosed()) {
              node.warn('NATS connection not ready. Subscription change will be applied when connected.');
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] NATS connection not ready for subscription update`);
              }
              return;
            }
            
            // Update subscription with new subject/queue group
            // If dynamicSubject is null but dynamicQueueGroup is set, keep current subject
            // If dynamicSubject is empty string, reset to base subject
            const newSubject = dynamicSubject !== null ? (dynamicSubject || baseSubject) : null;
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Updating subscription with subject: ${newSubject}${dynamicQueueGroup ? `, queue: ${dynamicQueueGroup}` : ''}`);
            }
            await setupSubscription(newSubject, dynamicQueueGroup);
          } catch (err) {
            node.warn(`Cannot update subscription: ${err.message}. Will retry when connected.`);
            if (isDebug) {
              node.log(`[[NATS-SUITE SUBSCRIBE] Subscription update failed: ${err.message}`);
            }
          }
        } else {
          // No dynamic properties provided - reset to base subject if in dynamic mode
          if (currentSubject !== baseSubject) {
            try {
              const natsnc = await this.config.getConnection();
              if (natsnc && !natsnc.isClosed()) {
                if (isDebug) {
                  node.log(`[[NATS-SUITE SUBSCRIBE] Resetting subscription to base subject: ${baseSubject}`);
                }
                await setupSubscription(baseSubject, null);
              }
            } catch (err) {
              // Ignore errors during reset
              if (isDebug) {
                node.log(`[[NATS-SUITE SUBSCRIBE] Reset to base subject failed (ignoring): ${err.message}`);
              }
            }
          }
        }
        
      } catch (err) {
        const cleanError = {
          message: err.message || 'Error handling input message',
          code: err.code || 'INPUT_ERROR',
          name: err.name || 'Error',
        };
        if (isDebug) {
          node.log(`[[NATS-SUITE SUBSCRIBE] Input handler error: ${err.stack}`);
        }
        node.error(cleanError);
      }
    });

    // on node close
    node.on('close', function (done) {
      if (subscription) {
        node.log('Unsubscribing from subscription on close');
        subscription.unsubscribe();
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      this.config.removeStatusListener(statusListener);
      // Connection Pool: Unregister this node as connection user
      this.config.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-subscribe', NatsSubscribeNode);
};
