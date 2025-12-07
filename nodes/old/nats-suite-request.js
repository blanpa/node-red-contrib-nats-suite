'use strict';

const { StringCodec } = require('nats');

// NATS Error Code Constants
const NATS_ERROR_CODES = {
  TIMEOUT: 'TIMEOUT',
  SERVICE_UNAVAILABLE: '503'
};

module.exports = function (RED) {
  function NatsRequestNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Define status functions
    const setStatusRed = () => {
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
    };

    // Set initial status to grey "ready"
    node.status({ fill: 'grey', shape: 'ring', text: 'ready' });

    // Validate server configuration ID
    if (!config.server) {
      node.error('NATS server configuration not selected. Please select a NATS server node.');
      setStatusRed();
      return;
    }
    
    this.config = RED.nodes.getNode(config.server);

    // Validate server configuration
    if (!this.config) {
      node.error(`NATS server configuration not found for ID: ${config.server}. Please configure a NATS server node.`);
      setStatusRed();
      return;
    }
    
    // Debug: Log server configuration details
    if (config.debug) {
      node.log(`[NATS-REQUEST] Using server config: ${this.config.name || this.config.id}`);
      node.log(`[NATS-REQUEST] Server connection status: ${this.config.connectionStatus || 'unknown'}`);
    }

    // Add status listener to server config
    const statusListener = status => {
      switch (status) {
        case 'connected':
          // Only set to ready if we're not in an error state
          if (!node.currentErrorState) {
            node.status({ fill: 'grey', shape: 'ring', text: 'ready' });
          }
          break;
        case 'disconnected':
          setStatusRed();
          break;
        case 'connecting':
          // Don't change status during connecting, keep current state
          break;
      }
    };

    this.config.addStatusListener(statusListener);
    
    // Connection Pool: Register this node as connection user
    this.config.registerConnectionUser(node.id);

    // Create StringCodec once for performance
    const sc = StringCodec();

    // on input send message
    node.on('input', async function (msg) {
      try {
        // Check connection status BEFORE attempting to send request
        if (this.config.connectionStatus !== 'connected') {
          const cleanError = {
            message: 'Cannot send request - NATS server is not connected',
            code: 'NOT_CONNECTED',
            status: this.config.connectionStatus,
            reconnectAttempts: this.config.connectionStats?.reconnectAttempts || 0
          };
          node.currentErrorState = true;
          node.status({ fill: 'red', shape: 'ring', text: 'not connected' });
          node.error(cleanError, msg);
          return; // Drop message to prevent failed requests during reconnection
        }

        // Validate subject configuration
        if (!config.subject || typeof config.subject !== 'string' || config.subject.trim() === '') {
          const cleanError = {
            message: 'Invalid subject configuration. Please provide a non-empty subject string.',
            code: 'INVALID_SUBJECT'
          };
          node.currentErrorState = true;
          node.status({ fill: 'orange', shape: 'ring', text: 'invalid subject' });
          node.error(cleanError, msg);
          return;
        }

        const natsnc = await this.config.getConnection();
        let message;
        let subject;

        // Set Subject
        subject = config.subject;

        try {
          message = sc.encode(JSON.stringify(msg.payload));
        } catch (e) {
          const cleanError = { message: 'Failed to serialize payload to JSON', code: 'SERIALIZE_ERROR', originalError: e.message };
          node.currentErrorState = true;
          node.status({ fill: 'orange', shape: 'ring', text: 'serialize error' });
          node.error(cleanError, msg);
          return;
        }

        switch (config.dataformat) {
          case 'uns_command':
            subject = 'cmd.' + config.subject;
            break;
          case 'uns_event':
            subject = 'evt.' + config.subject;
            break;
          case 'uns_value':
            subject = 'val.' + config.subject;
            break;
        }

        if (config.debug) {
          node.log(`[NATS-REQUEST] Sending request to subject: ${subject}`);
          node.log(`[NATS-REQUEST] Request payload: ${JSON.stringify(msg.payload)}`);
        }
        
        // Set status to indicate request is in progress
        node.status({ fill: 'yellow', shape: 'dot', text: 'requesting...' });
        
        const timeoutMs = Number(config.timeout) || 1000;

        natsnc
          .request(subject, message, {
            timeout: timeoutMs,
          })
          .then(response => {
            if (config.debug) {
              node.log(`[NATS-REQUEST] Response received from subject: ${subject}`);
            }
            
            // Decode the response data
            const responseData = sc.decode(response.data);
            if (config.debug) {
              node.log(`[NATS-REQUEST] Raw response data: ${responseData}`);
            }
            
            let parsedPayload;
            try {
              // First try to parse the response data
              parsedPayload = JSON.parse(responseData);
              if (config.debug) {
                node.log(`[NATS-REQUEST] Parsed response: ${JSON.stringify(parsedPayload)}`);
              }
              
              // Check if the parsed payload is a JSON string that needs further parsing
              if (typeof parsedPayload === 'string') {
                try {
                  parsedPayload = JSON.parse(parsedPayload);
                  if (config.debug) {
                    node.log(`[NATS-REQUEST] Double-parsed response: ${JSON.stringify(parsedPayload)}`);
                  }
                } catch (e) {
                  // If second parse fails, keep the string
                  if (config.debug) {
                    node.log(`[NATS-REQUEST] Second JSON parse failed, keeping string: ${e.message}`);
                  }
                }
              }
              
              // Filter out stream metadata if present
              if (parsedPayload && typeof parsedPayload === 'object') {
                // Remove common stream metadata fields
                const streamMetadataFields = ['stream', 'domain', 'seq', 'time', 'subject'];
                const filteredPayload = { ...parsedPayload };
                
                let hasStreamMetadata = false;
                streamMetadataFields.forEach(field => {
                  if (filteredPayload.hasOwnProperty(field)) {
                    delete filteredPayload[field];
                    hasStreamMetadata = true;
                  }
                });
                
                // If we removed stream metadata and payload is now empty or only has metadata,
                // keep the original payload
                if (hasStreamMetadata && Object.keys(filteredPayload).length === 0) {
                  parsedPayload = responseData; // Use raw string if only metadata was present
                } else if (hasStreamMetadata) {
                  parsedPayload = filteredPayload; // Use filtered payload
                }
                
                if (config.debug && hasStreamMetadata) {
                  node.log(`[NATS-REQUEST] Filtered stream metadata from response`);
                }
              }
            } catch (e) {
              // If JSON parsing fails, use the raw string
              if (config.debug) {
                node.log(`[NATS-REQUEST] JSON parsing failed, using raw string: ${e.message}`);
              }
              parsedPayload = responseData;
            }
            
            msg.topic = subject;
            msg.payload = parsedPayload;
            msg.status = 'success';
            
            // Reset status to ready after successful request
            node.currentErrorState = false;
            node.status({ fill: 'grey', shape: 'ring', text: 'ready' });
            node.send(msg);
          })
          .catch(err => {
            if (config.debug) {
              node.log(`[NATS-REQUEST] Error for subject ${subject}: ${err && err.message ? err.message : String(err)}`);
            }
            
            // Check if it's a timeout error
            if (err && (err.code === NATS_ERROR_CODES.TIMEOUT || (typeof err.message === 'string' && err.message.includes('timeout')))) {
              if (config.handleTimeout) {
                // Send timeout message instead of error
                msg.topic = subject;
                msg.payload = {
                  error: `Request timed out after ${timeoutMs}ms`,
                  details: 'No response received within timeout period'
                };
                msg.status = 'timeout';
                msg.error = {
                  message: `Request timed out after ${timeoutMs}ms`,
                  code: 'TIMEOUT',
                  originalError: err && err.message ? err.message : undefined,
                };
                
                // Set status to orange to indicate timeout but connection OK
                node.currentErrorState = true;
                node.status({ fill: 'orange', shape: 'ring', text: 'timeout' });
                node.send(msg);
              } else {
                // Handle timeout as node error but still set status
                const cleanError = {
                  message: `Request timed out after ${timeoutMs}ms`,
                  code: 'TIMEOUT',
                  originalError: err && err.message ? err.message : undefined,
                };
                
                // Set status to orange to indicate timeout but connection OK
                node.currentErrorState = true;
                node.status({ fill: 'orange', shape: 'ring', text: 'timeout' });
                node.error(cleanError, msg);
              }
            } else if (err && (err.code === NATS_ERROR_CODES.SERVICE_UNAVAILABLE || (typeof err.message === 'string' && err.message.includes('503')))) {
              // Handle 503 Service Unavailable
              if (config.debug) node.log(`[NATS-REQUEST] 503 Service Unavailable for subject: ${subject}`);
              msg.topic = subject;
              msg.payload = {
                error: `Service unavailable (503) for subject: ${subject}`,
                details: 'No service is listening on this subject or service is down'
              };
              msg.status = 'service_unavailable';
              msg.error = {
                message: `Service unavailable (503) for subject: ${subject}`,
                code: '503',
                originalError: err && err.message ? err.message : undefined,
                details: 'No service is listening on this subject or service is down'
              };
              
              // Set status to orange to indicate service unavailable but connection OK
              node.currentErrorState = true;
              node.status({ fill: 'orange', shape: 'ring', text: 'no service' });
              node.send(msg);
            } else {
              // For other errors or if timeout handling is disabled, use node.error
              const cleanError = {
                message: err && err.message ? err.message : 'Unknown error',
                code: err && err.code ? err.code : undefined,
                name: err && err.name ? err.name : undefined,
              };
              
              // Mark error status
              node.currentErrorState = true;
              node.status({ fill: 'orange', shape: 'ring', text: 'error' });
              node.error(cleanError, msg);
            }
          });
      } catch (err) {
        const cleanError = {
          message: err && err.message ? err.message : 'Unknown error',
          code: err && err.code ? err.code : undefined,
          name: err && err.name ? err.name : undefined,
        };

        // Mark error status
        node.currentErrorState = true;
        node.status({ fill: 'orange', shape: 'ring', text: 'error' });
        node.error(cleanError, msg);
      }
    });

    // on node close
    node.on('close', function (done) {
      this.config.removeStatusListener(statusListener);
      // Connection Pool: Unregister this node as connection user
      this.config.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-request', NatsRequestNode);
};
