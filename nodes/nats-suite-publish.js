'use strict';

const { StringCodec, headers: natsHeaders } = require('nats');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function (RED) {
  function NatsPublishNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const sc = StringCodec();

    // Performance optimizations: Define functions and regex once
    const generateUUID = (() => {
        const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
        return () => template.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    })();
    
    // Compile UUID regex once
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isValidUUID = (uuid) => UUID_REGEX.test(uuid);
    
    // Error object template for better performance
    const createError = (message, code, details = {}) => ({
        message,
        code,
        ...details
    });

    // Batch state tracking (needs to be defined early for status functions)
    const enableBatch = !!config.enableBatch;
    let isBatchProcessing = false;
    let batchQueue = [];

    // Define status functions
    const setStatusRed = () => {
      // Don't override batch status if batch is processing
      if (isBatchProcessing) {
        return;
      }
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
    };

    const setStatusGreen = () => {
      // Don't override batch status if batch is enabled or processing
      if (isBatchProcessing || enableBatch) {
        return;
      }
      node.status({ fill: 'green', shape: 'dot', text: 'connected' });
    };

    const setStatusYellow = () => {
      // Don't override batch status if batch is processing
      if (isBatchProcessing) {
        return;
      }
      node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
    };

    let connectionTimeout = null;
    let connectionStartTime = null;
    
    // Message logging: Only log if debug flag is set
    const isDebug = !!config.debug;
    
    // Message Buffer: Queue for messages when disconnected
    const enableBuffer = !!config.enableBuffer;
    const bufferSizeType = config.bufferSizeType || 'count';
    const bufferSize = config.bufferSize || 1000; // Number of messages
    const MAX_BUFFER_SIZE_BYTES = 104857600; // Max: 100 MB
    const MIN_BUFFER_SIZE_BYTES = 1024; // Min: 1 KB
    let bufferSizeBytes = config.bufferSizeBytes || 10485760; // Size in bytes (10 MB)
    // Enforce buffer size limits
    if (bufferSizeBytes > MAX_BUFFER_SIZE_BYTES) {
      node.warn(`[NATS-SUITE PUBLISH] Buffer size ${bufferSizeBytes} bytes exceeds maximum of ${MAX_BUFFER_SIZE_BYTES} bytes (100 MB). Using maximum.`);
      bufferSizeBytes = MAX_BUFFER_SIZE_BYTES;
    } else if (bufferSizeBytes < MIN_BUFFER_SIZE_BYTES) {
      node.warn(`[NATS-SUITE PUBLISH] Buffer size ${bufferSizeBytes} bytes is below minimum of ${MIN_BUFFER_SIZE_BYTES} bytes (1 KB). Using minimum.`);
      bufferSizeBytes = MIN_BUFFER_SIZE_BYTES;
    }
    const bufferMode = config.bufferMode || 'drop-oldest';
    const bufferPersistence = config.bufferPersistence || 'none';
    const bufferAutoSaveInterval = Math.max(5, Math.min(300, parseInt(config.bufferAutoSaveInterval, 10) || 30)); // 5-300 seconds
    let messageQueue = [];
    let droppedMessages = 0;
    let isFlushing = false; // Flag to prevent concurrent flush operations
    
    // Cache for current buffer size in bytes (performance optimization)
    let cachedBufferSizeBytes = 0;
    let bufferSizeCacheValid = true;
    
    // Helper function: Format bytes to MB string
    const formatBytesToMB = (bytes) => {
      return (bytes / 1024 / 1024).toFixed(2);
    };
    
    // Helper function: Calculate message size in bytes
    const calculateMessageSize = (msg) => {
      // If already calculated, use cached value
      if (msg._bufferSize !== undefined) {
        return msg._bufferSize;
      }
      
      try {
        // Estimate size by stringifying the message
        // This includes payload, topic, and other properties
        const msgString = JSON.stringify(msg);
        const size = Buffer.byteLength(msgString, 'utf8');
        msg._bufferSize = size; // Cache the size
        return size;
      } catch (err) {
        // Fallback: estimate based on payload
        let size = 1024; // Default estimate: 1 KB
        try {
          if (typeof msg.payload === 'string') {
            size = Buffer.byteLength(msg.payload, 'utf8');
          } else if (typeof msg.payload === 'object' && msg.payload !== null) {
            size = Buffer.byteLength(JSON.stringify(msg.payload), 'utf8');
          }
        } catch (fallbackErr) {
          // If even fallback fails, use default
          size = 1024;
        }
        msg._bufferSize = size; // Cache the size
        return size;
      }
    };
    
    // Helper function: Calculate total buffer size in bytes (with caching)
    const calculateBufferSize = () => {
      if (bufferSizeCacheValid && cachedBufferSizeBytes >= 0) {
        return cachedBufferSizeBytes;
      }
      
      let totalSize = 0;
      for (const msg of messageQueue) {
        totalSize += msg._bufferSize || calculateMessageSize(msg);
      }
      cachedBufferSizeBytes = totalSize;
      bufferSizeCacheValid = true;
      return totalSize;
    };
    
    // Helper function: Invalidate buffer size cache
    const invalidateBufferSizeCache = () => {
      bufferSizeCacheValid = false;
    };
    
    // Helper function: Update buffer size cache when message added/removed
    const updateBufferSizeCache = (addedSize, removedSize = 0) => {
      if (bufferSizeCacheValid) {
        cachedBufferSizeBytes = Math.max(0, cachedBufferSizeBytes + addedSize - removedSize);
      }
    };
    
    if (enableBuffer && isDebug) {
      if (bufferSizeType === 'count') {
        node.log(`[NATS-SUITE PUBLISH] Message buffering enabled: size=${bufferSize} messages, mode=${bufferMode}`);
      } else {
        node.log(`[NATS-SUITE PUBLISH] Message buffering enabled: size=${bufferSizeBytes} bytes (${formatBytesToMB(bufferSizeBytes)} MB), mode=${bufferMode}`);
      }
    }
    
    // Persistence: File path for buffer storage
    const getBufferFilePath = () => {
      const userDir = RED.settings.userDir || os.homedir();
      const bufferDir = path.join(userDir, '.node-red', 'buffer');
      // Ensure directory exists
      if (!fs.existsSync(bufferDir)) {
        try {
          fs.mkdirSync(bufferDir, { recursive: true });
        } catch (err) {
          node.warn(`[NATS-SUITE PUBLISH] Failed to create buffer directory: ${err.message}`);
          return null;
        }
      }
      return path.join(bufferDir, `buffer-${node.id}.json`);
    };
    
    // Persistence: Load buffer from storage
    const loadBuffer = () => {
      if (!enableBuffer || bufferPersistence === 'none') {
        return;
      }
      
      let loadedFromContext = false;
      let loadedFromFile = false;
      
      // Load from Context Storage
      if (bufferPersistence === 'context' || bufferPersistence === 'both') {
        try {
          const context = node.context();
          const savedQueue = context.get('messageQueue');
          const savedDropped = context.get('droppedMessages') || 0;
          
          if (savedQueue && Array.isArray(savedQueue) && savedQueue.length > 0) {
            messageQueue = savedQueue;
            droppedMessages = savedDropped;
            invalidateBufferSizeCache();
            loadedFromContext = true;
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Loaded ${messageQueue.length} messages from Context Storage`);
            }
          }
        } catch (err) {
          node.warn(`[NATS-SUITE PUBLISH] Failed to load buffer from Context Storage: ${err.message}`);
        }
      }
      
      // Load from File System
      if (bufferPersistence === 'file' || bufferPersistence === 'both') {
        try {
          const filePath = getBufferFilePath();
          if (filePath && fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath, 'utf8');
            const saved = JSON.parse(fileData);
            
            if (saved.queue && Array.isArray(saved.queue) && saved.queue.length > 0) {
              // If already loaded from context and both is enabled, merge (file takes precedence)
              if (loadedFromContext && bufferPersistence === 'both') {
                if (isDebug) {
                  node.log(`[NATS-SUITE PUBLISH] Merging file buffer (${saved.queue.length} msgs) with context buffer (${messageQueue.length} msgs)`);
                }
                // Use file as source of truth (newer)
                messageQueue = saved.queue;
                droppedMessages = saved.droppedMessages || 0;
              } else {
                messageQueue = saved.queue;
                droppedMessages = saved.droppedMessages || 0;
              }
              invalidateBufferSizeCache();
              loadedFromFile = true;
              if (isDebug) {
                node.log(`[NATS-SUITE PUBLISH] Loaded ${messageQueue.length} messages from File System`);
              }
            }
          }
        } catch (err) {
          node.warn(`[NATS-SUITE PUBLISH] Failed to load buffer from File System: ${err.message}`);
        }
      }
      
      if ((loadedFromContext || loadedFromFile) && messageQueue.length > 0) {
        // Clean up loaded messages: remove internal flags that might interfere
        messageQueue = messageQueue.map(msg => {
          // Remove internal flags that shouldn't persist
          const cleanedMsg = { ...msg };
          delete cleanedMsg._flushing;
          delete cleanedMsg._batched;
          delete cleanedMsg._rateLimited;
          delete cleanedMsg._autoReplyProcessed;
          // Keep _originalTimestamp, _originalStartTime, _originalEndTime (needed for flush)
          // Ensure _bufferSize is recalculated if missing
          if (!cleanedMsg._bufferSize) {
            cleanedMsg._bufferSize = calculateMessageSize(cleanedMsg);
          }
          return cleanedMsg;
        });
        
        node.log(`[NATS-SUITE PUBLISH] Restored ${messageQueue.length} buffered messages from ${bufferPersistence === 'both' ? 'Context + File' : bufferPersistence}`);
        
        // Recalculate cache after cleaning
        invalidateBufferSizeCache();
        
        // Update status
        if (bufferSizeType === 'count') {
          node.status({ 
            fill: 'yellow', 
            shape: 'ring', 
            text: `restored (${messageQueue.length}/${bufferSize})` 
          });
        } else {
          const restoredSize = calculateBufferSize();
          node.status({ 
            fill: 'yellow', 
            shape: 'ring', 
            text: `restored (${formatBytesToMB(restoredSize)}/${formatBytesToMB(bufferSizeBytes)} MB)` 
          });
        }
        
        // Check if connection is already established and flush if so
        // This handles the case when Node-RED restarts but connection was already established
        // Use setImmediate to ensure config is initialized
        setImmediate(() => {
          setTimeout(() => {
            if (this.config && this.config.connectionStatus === 'connected' && messageQueue.length > 0 && !isFlushing) {
              node.log(`[NATS-SUITE PUBLISH] Connection already established, flushing ${messageQueue.length} restored messages...`);
              flushBuffer();
            }
          }, 500); // Delay to ensure connection is ready
        });
      }
    };
    
    // Persistence: Save buffer to storage
    const saveBuffer = (force = false) => {
      if (!enableBuffer || bufferPersistence === 'none') {
        return;
      }
      
      // If queue is empty and force is true, clear the persisted buffer
      if (messageQueue.length === 0 && force) {
        // Clear Context Storage
        if (bufferPersistence === 'context' || bufferPersistence === 'both') {
          try {
            const context = node.context();
            context.set('messageQueue', []);
            context.set('droppedMessages', 0);
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Cleared buffer from Context Storage`);
            }
          } catch (err) {
            node.warn(`[NATS-SUITE PUBLISH] Failed to clear buffer from Context Storage: ${err.message}`);
          }
        }
        
        // Clear File System
        if (bufferPersistence === 'file' || bufferPersistence === 'both') {
          try {
            const filePath = getBufferFilePath();
            if (filePath && fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              if (isDebug) {
                node.log(`[NATS-SUITE PUBLISH] Cleared buffer file from File System`);
              }
            }
          } catch (err) {
            node.warn(`[NATS-SUITE PUBLISH] Failed to clear buffer file from File System: ${err.message}`);
          }
        }
        return;
      }
      
      // Don't save if queue is empty (unless force clear)
      if (messageQueue.length === 0) {
        return;
      }
      
      // Clean messages before saving: remove internal flags that shouldn't persist
      const cleanedQueue = messageQueue.map(msg => {
        const cleanedMsg = { ...msg };
        // Remove internal processing flags
        delete cleanedMsg._flushing;
        delete cleanedMsg._batched;
        delete cleanedMsg._rateLimited;
        delete cleanedMsg._autoReplyProcessed;
        // Keep _bufferSize for performance
        return cleanedMsg;
      });
      
      const bufferData = {
        queue: cleanedQueue,
        droppedMessages: droppedMessages,
        timestamp: Date.now(),
        nodeId: node.id
      };
      
      // Save to Context Storage
      if (bufferPersistence === 'context' || bufferPersistence === 'both') {
        try {
          const context = node.context();
          context.set('messageQueue', messageQueue);
          context.set('droppedMessages', droppedMessages);
          if (isDebug && force) {
            node.log(`[NATS-SUITE PUBLISH] Saved ${messageQueue.length} messages to Context Storage`);
          }
        } catch (err) {
          node.warn(`[NATS-SUITE PUBLISH] Failed to save buffer to Context Storage: ${err.message}`);
        }
      }
      
      // Save to File System
      if (bufferPersistence === 'file' || bufferPersistence === 'both') {
        try {
          const filePath = getBufferFilePath();
          if (filePath) {
            fs.writeFileSync(filePath, JSON.stringify(bufferData, null, 2), 'utf8');
            if (isDebug && force) {
              node.log(`[NATS-SUITE PUBLISH] Saved ${messageQueue.length} messages to File System`);
            }
          }
        } catch (err) {
          node.warn(`[NATS-SUITE PUBLISH] Failed to save buffer to File System: ${err.message}`);
        }
      }
    };
    
    // Auto-save timer
    let autoSaveTimer = null;
    if (enableBuffer && bufferPersistence !== 'none') {
      autoSaveTimer = setInterval(() => {
        saveBuffer(false); // Silent auto-save
      }, bufferAutoSaveInterval * 1000);
    }
    
    // Batch Publishing: Collect messages and publish as batch
    // enableBatch, batchQueue and isBatchProcessing already defined above
    const batchSize = config.batchSize || 100;
    const batchInterval = config.batchInterval || 1000;
    const batchMode = config.batchMode || 'hybrid';
    let batchTimer = null;
    let batchedMessagesCount = 0;
    
    if (enableBatch && isDebug) {
      node.log(`[NATS-SUITE PUBLISH] Batch publishing enabled: size=${batchSize}, interval=${batchInterval}ms, mode=${batchMode}`);
    }
    
    // Request-Reply Mode (Client Side): Send request and wait for reply
    const mode = config.mode || 'publish';
    const enableRequestReply = (mode === 'request');
    const requestTimeout = config.requestTimeout || 5000;
    
    if (enableRequestReply && isDebug) {
      node.log(`[NATS-SUITE PUBLISH] Request-Reply mode enabled: timeout=${requestTimeout}ms`);
    }
    
    // Auto-Reply Handler: Automatically handle request-reply pattern
    const enableAutoReply = !!config.enableAutoReply;
    const replyTimeout = config.replyTimeout || 5000;
    const pendingReplies = new Map(); // Map of request subjects to timeout handlers
    
    if (enableAutoReply && isDebug) {
      node.log(`[NATS-SUITE PUBLISH] Auto-reply handler enabled: timeout=${replyTimeout}ms`);
    }
    
    // Rate Limiter: Token Bucket algorithm for message throttling
    const enableRateLimit = !!config.enableRateLimit;
    const rateLimit = config.rateLimit || 100; // messages per window
    const rateLimitWindow = config.rateLimitWindow || 1000; // milliseconds
    const rateLimitBurst = config.rateLimitBurst || 20; // burst capacity
    const rateLimitAction = config.rateLimitAction || 'drop';
    
    // Token Bucket state
    let tokenBucket = rateLimit + rateLimitBurst; // Start with full bucket + burst
    let lastRefillTime = Date.now();
    let droppedByRateLimit = 0;
    let delayQueue = [];
    let delayProcessing = false;
    
    // Calculate tokens per millisecond
    const tokensPerMs = rateLimit / rateLimitWindow;
    
    if (enableRateLimit && isDebug) {
      node.log(`[NATS-SUITE PUBLISH] Rate limiting enabled: ${rateLimit} msg/${rateLimitWindow}ms, burst=${rateLimitBurst}, action=${rateLimitAction}`);
    }
    
    // Helper function: Refill token bucket based on elapsed time
    const refillTokens = () => {
      const now = Date.now();
      const elapsed = now - lastRefillTime;
      const tokensToAdd = elapsed * tokensPerMs;
      
      // Add tokens, but cap at max capacity (rate limit + burst)
      tokenBucket = Math.min(tokenBucket + tokensToAdd, rateLimit + rateLimitBurst);
      lastRefillTime = now;
      
      if (isDebug && tokensToAdd > 0) {
        node.log(`[NATS-SUITE PUBLISH] Token bucket refilled: +${tokensToAdd.toFixed(2)} tokens (total: ${tokenBucket.toFixed(2)}/${rateLimit + rateLimitBurst})`);
      }
    };
    
    // Helper function: Check if message can be sent (has tokens available)
    const canSendMessage = () => {
      refillTokens();
      return tokenBucket >= 1;
    };
    
    // Helper function: Consume one token
    const consumeToken = () => {
      if (tokenBucket >= 1) {
        tokenBucket -= 1;
        return true;
      }
      return false;
    };
    
    // Helper function: Process delayed messages (for delay action)
    const processDelayQueue = async () => {
      if (delayProcessing || delayQueue.length === 0) return;
      
      delayProcessing = true;
      
      while (delayQueue.length > 0 && canSendMessage()) {
        const delayedMsg = delayQueue.shift();
        consumeToken();
        
        // Process message by triggering input handler
        delayedMsg._rateLimited = true; // Mark as already rate-limited
        node.receive(delayedMsg);
        
        // Small delay to avoid tight loop
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      delayProcessing = false;
      
      // Schedule next processing if queue still has messages
      if (delayQueue.length > 0) {
        const waitTime = Math.ceil(1 / tokensPerMs); // Time until next token
        setTimeout(() => processDelayQueue(), waitTime);
      }
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

    // Add status listener to server config
    const statusListener = (statusInfo) => {
      const status = statusInfo.status || statusInfo; // Backward compatibility
      
      switch (status) {
        case 'connected':
          // Don't update status if batch is currently being processed
          if (isBatchProcessing) {
            return; // Keep batch status visible
          }
          
          // Always show batch status if batch is enabled
          if (enableBatch) {
            // Use centralized status update function
            updateBatchStatus();
            // Don't proceed with connection status update - batch status takes priority
            // But still clear timeout and log if needed
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
            const connectionTime = connectionStartTime ? Math.floor((Date.now() - connectionStartTime) / 1000) : 0;
            if (connectionTime > 5) {
              node.log(`[NATS-PUBLISH] Connection established after ${connectionTime}s`);
            }
            return;
          }
          
          const uptime = statusInfo.uptimeFormatted || statusInfo.uptime;
          
          // Clear connection timeout
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          const connectionTime = connectionStartTime ? Math.floor((Date.now() - connectionStartTime) / 1000) : 0;
          if (connectionTime > 5) {
            node.log(`[NATS-PUBLISH] Connection established after ${connectionTime}s`);
          }
          
          // Show connected status (batch is not enabled)
          setStatusGreen();
          node.status({ fill: 'green', shape: 'dot', text: 'connected' });
          
          // Flush buffered messages if any
          if (enableBuffer && messageQueue.length > 0) {
            node.log(`[NATS-SUITE PUBLISH] Connection restored, flushing ${messageQueue.length} buffered messages...`);
            setTimeout(() => flushBuffer(), 100); // Small delay to ensure connection is stable
          }
          break;
        case 'disconnected':
          const attempts = statusInfo.reconnectAttempts || 0;
          setStatusRed();
          node.status({ fill: 'red', shape: 'ring', text: `disconnected (${attempts})` });
          break;
        case 'connecting':
          const attempt = statusInfo.reconnectAttempts || 0;
          setStatusYellow();
          node.status({ fill: 'yellow', shape: 'ring', text: `connecting (${attempt})` });
          
          // Start connection timeout warning
          connectionStartTime = Date.now();
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          
          // Warn after 10 seconds
          connectionTimeout = setTimeout(() => {
            const elapsed = Math.floor((Date.now() - connectionStartTime) / 1000);
            node.warn(`NATS connection taking longer than expected (${elapsed}s). Check server availability.`);
          }, 10000);
          break;
        case 'failed':
          setStatusRed();
          node.status({ fill: 'red', shape: 'ring', text: 'max attempts reached' });
          break;
      }
    };

    this.config.addStatusListener(statusListener);
    
    // Connection Pool: Register this node as connection user
    this.config.registerConnectionUser(node.id);
    
    // Helper function: Add message to buffer
    const bufferMessage = (msg) => {
      // Calculate message size and store it
      const msgSize = calculateMessageSize(msg);
      
      // Check if buffer is full based on size type
      let isFull = false;
      let currentLimit = 0;
      let currentValue = 0;
      
      if (bufferSizeType === 'count') {
        // Check by message count
        isFull = messageQueue.length >= bufferSize;
        currentLimit = bufferSize;
        currentValue = messageQueue.length;
      } else {
        // Check by total size in bytes (use cached value if available)
        const currentBufferSize = calculateBufferSize();
        isFull = (currentBufferSize + msgSize) > bufferSizeBytes;
        currentLimit = bufferSizeBytes;
        currentValue = currentBufferSize;
      }
      
      if (isFull) {
        // Buffer is full
        switch (bufferMode) {
          case 'drop-oldest':
            const droppedMsg = messageQueue.shift(); // Remove oldest
            const droppedSize = droppedMsg._bufferSize || 0;
            droppedMessages++;
            // Update cache
            if (bufferSizeType === 'size') {
              updateBufferSizeCache(0, droppedSize);
            }
            if (isDebug) {
              if (bufferSizeType === 'count') {
                node.log(`[NATS-SUITE PUBLISH] Buffer full (${messageQueue.length}/${bufferSize} messages), dropped oldest message`);
              } else {
                node.log(`[NATS-SUITE PUBLISH] Buffer full (${formatBytesToMB(currentValue)}/${formatBytesToMB(bufferSizeBytes)} MB), dropped oldest message`);
              }
            }
            break;
          case 'drop-newest':
            droppedMessages++;
            if (isDebug) {
              if (bufferSizeType === 'count') {
                node.log(`[NATS-SUITE PUBLISH] Buffer full (${messageQueue.length}/${bufferSize} messages), dropped newest message`);
              } else {
                node.log(`[NATS-SUITE PUBLISH] Buffer full (${formatBytesToMB(currentValue)}/${formatBytesToMB(bufferSizeBytes)} MB), dropped newest message`);
              }
            }
            return false; // Don't add new message
          case 'drop-on-full':
            if (bufferSizeType === 'count') {
              node.warn(`[NATS-SUITE PUBLISH] Buffer full (${messageQueue.length}/${bufferSize} messages), message rejected`);
            } else {
              node.warn(`[NATS-SUITE PUBLISH] Buffer full (${formatBytesToMB(currentValue)}/${formatBytesToMB(bufferSizeBytes)} MB), message rejected`);
            }
            return false; // Don't add new message
        }
      }
      
      messageQueue.push(msg);
      
      // Update cache
      if (bufferSizeType === 'size') {
        updateBufferSizeCache(msgSize, 0);
      }
      
      // Save buffer if persistence enabled (async, don't block)
      if (bufferPersistence !== 'none') {
        // Use setImmediate to avoid blocking
        setImmediate(() => {
          try {
            saveBuffer(false);
          } catch (err) {
            // Silent fail for auto-save
          }
        });
      }
      
      // Update status based on size type (throttled for performance)
      // Don't override batch status if batch is enabled
      if (!enableBatch) {
        if (bufferSizeType === 'count') {
          node.status({ 
            fill: 'yellow', 
            shape: 'ring', 
            text: `buffered (${messageQueue.length}/${bufferSize})` 
          });
        } else {
          const newBufferSize = calculateBufferSize();
          node.status({ 
            fill: 'yellow', 
            shape: 'ring', 
            text: `buffered (${formatBytesToMB(newBufferSize)}/${formatBytesToMB(bufferSizeBytes)} MB)` 
          });
        }
      }
      return true;
    };
    
    // Helper function: Flush buffer (send all queued messages)
    const flushBuffer = async () => {
      // Prevent concurrent flush operations
      if (isFlushing) {
        if (isDebug) {
          node.log(`[NATS-SUITE PUBLISH] Flush already in progress, skipping...`);
        }
        return;
      }
      
      if (messageQueue.length === 0) return;
      
      isFlushing = true; // Set flag to prevent concurrent flushes
      
      const flushCount = messageQueue.length;
      const flushSize = bufferSizeType === 'size' ? calculateBufferSize() : 0;
      
      if (bufferSizeType === 'count') {
        node.log(`[NATS-SUITE PUBLISH] Flushing ${flushCount} buffered messages...`);
      } else {
        node.log(`[NATS-SUITE PUBLISH] Flushing ${flushCount} buffered messages (${formatBytesToMB(flushSize)} MB)...`);
      }
      
      // Copy and clear queue
      const queueCopy = [...messageQueue];
      messageQueue = [];
      invalidateBufferSizeCache(); // Reset cache since queue is cleared
      
      // Check connection before starting
      if (node.config.connectionStatus !== 'connected') {
        // Connection lost, re-queue all messages
        messageQueue = queueCopy;
        invalidateBufferSizeCache();
        node.warn(`[NATS-SUITE PUBLISH] Connection lost before flush, ${messageQueue.length} messages re-queued`);
        isFlushing = false;
        return;
      }
      
      // Clean all messages before processing
      queueCopy.forEach(queuedMsg => {
        // Remove any stale flags that might interfere (especially from persisted messages)
        delete queuedMsg._flushing;
        delete queuedMsg._batched;
        delete queuedMsg._rateLimited;
        delete queuedMsg._autoReplyProcessed;
        // Mark as flushing to avoid recursion during flush
        queuedMsg._flushing = true;
      });
      
      // Send all messages in parallel for maximum performance
      const flushPromises = queueCopy.map(queuedMsg => 
        new Promise((resolve) => {
          try {
            // Use node.receive() to re-trigger input processing
            node.receive(queuedMsg);
            resolve({ success: true, msg: queuedMsg });
          } catch (err) {
            node.error(`[NATS-SUITE PUBLISH] Error flushing buffered message: ${err.message}`, queuedMsg);
            resolve({ success: false, msg: queuedMsg, error: err });
          }
        })
      );
      
      // Wait for all messages to be processed
      const results = await Promise.all(flushPromises);
      
      // Count successes and failures
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      if (droppedMessages > 0) {
        node.warn(`[NATS-SUITE PUBLISH] ${droppedMessages} messages were dropped due to buffer overflow`);
        droppedMessages = 0;
      }
      
      const remainingSize = bufferSizeType === 'size' ? calculateBufferSize() : 0;
      if (bufferSizeType === 'count') {
        node.log(`[NATS-SUITE PUBLISH] Buffer flushed: ${successCount} sent, ${failCount} failed, ${messageQueue.length} remaining`);
      } else {
        node.log(`[NATS-SUITE PUBLISH] Buffer flushed: ${successCount} sent, ${failCount} failed, ${messageQueue.length} remaining (${formatBytesToMB(remainingSize)} MB)`);
      }
      
      // Clear persisted buffer after successful flush (if all messages were sent)
      if (successCount > 0 && messageQueue.length === 0 && bufferPersistence !== 'none') {
        saveBuffer(true); // Save empty buffer to clear persistence
        if (isDebug) {
          node.log(`[NATS-SUITE PUBLISH] Cleared persisted buffer after successful flush`);
        }
      }
      
      // Reset flush flag
      isFlushing = false;
    };
    
    // Helper function: Publish batch (send all queued batch messages)
    const publishBatch = async () => {
      if (batchQueue.length === 0) return;
      
      // Mark that batch processing has started
      isBatchProcessing = true;
      
      // Clear timer
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      
      const batchCount = batchQueue.length;
      if (isDebug) {
        node.log(`[NATS-SUITE PUBLISH] Publishing batch: ${batchCount} messages`);
      }
      
      // Copy queue and update status to show processing
      const batchCopy = [...batchQueue];
      // Clear queue immediately to prevent duplicate processing
      batchQueue = [];
      
      // Show processing status
      node.status({ 
        fill: 'blue', 
        shape: 'ring', 
        text: `publishing ${batchCount} msgs...`
      });
      
      // Mark all messages as batched to prevent re-batching
      batchCopy.forEach(msg => msg._batched = true);
      
      // Publish all messages in parallel for maximum performance
      const publishPromises = batchCopy.map(batchedMsg => 
        processPublish(batchedMsg)
          .then(() => ({ success: true, msg: batchedMsg }))
          .catch(err => {
            node.error(`[NATS-SUITE PUBLISH] Error publishing batched message: ${err.message}`, batchedMsg);
            return { success: false, msg: batchedMsg, error: err };
          })
      );
      
      // Wait for all messages to be processed
      const results = await Promise.all(publishPromises);
      
      // Count successes and failures
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      batchedMessagesCount += successCount;
      
      if (isDebug) {
        node.log(`[NATS-SUITE PUBLISH] Batch published: ${successCount} sent, ${failCount} failed (total: ${batchedMessagesCount})`);
      }
      
      // Mark that batch processing is complete
      isBatchProcessing = false;
      
      // Update status to reflect current queue state immediately
      updateBatchStatus();
      
      // If queue reached size again during processing, publish immediately
      if ((batchMode === 'size' || batchMode === 'hybrid') && batchQueue.length >= batchSize && !isBatchProcessing) {
        publishBatch();
      }
      
      // Restart batch timer if in time or hybrid mode
      if ((batchMode === 'time' || batchMode === 'hybrid') && !batchTimer) {
        startBatchTimer();
      }
    };
    
    // Helper function: Start batch timer
    const startBatchTimer = () => {
      if (batchTimer) {
        clearTimeout(batchTimer);
      }
      
      batchTimer = setTimeout(() => {
        if (batchQueue.length > 0) {
          publishBatch();
        } else {
          // No messages, restart timer
          startBatchTimer();
        }
      }, batchInterval);
    };
    
    // Helper function: Update batch status (centralized status update)
    const updateBatchStatus = () => {
      if (enableBatch && this.config && this.config.connectionStatus === 'connected') {
        // Show only queue length, not total sent messages
        node.status({ 
          fill: 'blue', 
          shape: 'dot', 
          text: `batching (${batchQueue.length}/${batchSize})`
        });
      }
    };
    
    // Helper function: Add message to batch queue
    const addToBatch = (msg) => {
      // Store original timestamp if not already stored (for batched messages)
      if (!msg._originalTimestamp) {
        msg._originalTimestamp = Date.now();
      }
      
      // Store original event timestamps if present (for event dataformat)
      if (config.dataformat === 'event') {
        if (msg.startTime && !msg._originalStartTime) {
          msg._originalStartTime = msg.startTime;
        }
        if (msg.endTime && !msg._originalEndTime) {
          msg._originalEndTime = msg.endTime;
        }
      }
      
      batchQueue.push(msg);
      
      // Always update status immediately when message is added
      updateBatchStatus();
      
      if (isDebug) {
        node.log(`[NATS-SUITE PUBLISH] Message added to batch (${batchQueue.length}/${batchSize})`);
      }
      
      // Check if batch size reached (size or hybrid mode)
      // Only start new batch if not already processing
      if (!isBatchProcessing && (batchMode === 'size' || batchMode === 'hybrid') && batchQueue.length >= batchSize) {
        publishBatch();
      }
    };
    
    // Start batch timer if batch is enabled and in time/hybrid mode
    if (enableBatch && (batchMode === 'time' || batchMode === 'hybrid')) {
      startBatchTimer();
    }
    
    // Helper function: Process actual publish (extracted for batch usage)
    const processPublish = async (msg) => {
      // Simply trigger the input handler with the batched flag already set
      // This reuses all existing logic
      node.receive(msg);
    };

    // on input send message
    node.on('input', async function (msg) {
      try {
        // Request-Reply Mode (Client Side): Send request and wait for reply
        if (enableRequestReply && !msg._requestReplyProcessed) {
          msg._requestReplyProcessed = true;
          
          // Check connection status
          if (this.config.connectionStatus !== 'connected') {
            msg.error = {
              message: 'Cannot send request - NATS server is not connected',
              code: 'NOT_CONNECTED',
              status: this.config.connectionStatus
            };
            node.error(msg.error, msg);
            node.send(msg);
            return;
          }
          
          const natsnc = await this.config.getConnection();
          const subject = msg.topic || config.datapointid;
          
          if (!subject) {
            msg.error = {
              message: 'No subject specified. Set subject in node config or provide msg.topic',
              code: 'NO_SUBJECT'
            };
            node.error(msg.error, msg);
            node.send(msg);
            return;
          }
          
          // Prepare the request payload
          let requestPayload;
          if (typeof msg.payload === 'object') {
            requestPayload = JSON.stringify(msg.payload);
          } else {
            requestPayload = String(msg.payload);
          }
          
          const startTime = Date.now();
          
          if (isDebug) {
            node.log(`[NATS-SUITE PUBLISH] Request-Reply: Sending request to ${subject} (timeout: ${requestTimeout}ms)`);
          }
          
          node.status({ fill: 'blue', shape: 'ring', text: `request: ${subject}` });
          
          try {
            // Use NATS request() method - it handles inbox creation automatically
            const response = await natsnc.request(subject, sc.encode(requestPayload), { timeout: requestTimeout });
            
            const requestTime = Date.now() - startTime;
            
            // Decode response
            let responsePayload;
            try {
              const responseStr = sc.decode(response.data);
              responsePayload = JSON.parse(responseStr);
            } catch (parseErr) {
              responsePayload = sc.decode(response.data);
            }
            
            // Set response on message
            msg.payload = responsePayload;
            msg.requestTime = requestTime;
            msg.subject = response.subject;
            delete msg.error;
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Request-Reply: Response received in ${requestTime}ms`);
            }
            
            node.status({ fill: 'green', shape: 'dot', text: `reply: ${requestTime}ms` });
            
            // Clear status after 3 seconds
            setTimeout(() => {
              if (this.config.connectionStatus === 'connected') {
                node.status({ fill: 'green', shape: 'dot', text: 'connected' });
              }
            }, 3000);
            
            node.send(msg);
            
          } catch (requestErr) {
            const requestTime = Date.now() - startTime;
            
            // Handle timeout or other errors
            msg.error = {
              message: requestErr.message || 'Request failed',
              code: requestErr.code || 'REQUEST_FAILED',
              requestTime: requestTime
            };
            
            if (requestErr.code === 'TIMEOUT' || requestErr.message.includes('timeout')) {
              msg.error.code = 'TIMEOUT';
              msg.error.message = `Request timeout after ${requestTimeout}ms`;
              node.status({ fill: 'yellow', shape: 'ring', text: `timeout: ${requestTimeout}ms` });
            } else {
              node.status({ fill: 'red', shape: 'ring', text: 'request failed' });
            }
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Request-Reply: Error - ${msg.error.message}`);
            }
            
            node.error(msg.error, msg);
            node.send(msg);
            
            // Clear status after 3 seconds
            setTimeout(() => {
              if (this.config.connectionStatus === 'connected') {
                node.status({ fill: 'green', shape: 'dot', text: 'connected' });
              }
            }, 3000);
          }
          
          return;
        }
        
        // Auto-Reply Handler: Forward message to output and wait for reply
        if (enableAutoReply && !msg._autoReplyProcessed) {
          msg._autoReplyProcessed = true;
          
          // Forward message to output for processing
          node.send(msg);
          
          if (isDebug) {
            node.log(`[NATS-SUITE PUBLISH] Auto-reply: Waiting for response message...`);
          }
          
          // The actual reply will be sent when the message comes back through input
          // with msg._autoReplyResponse = true
          return;
        }
        
        // Check connection status BEFORE attempting to publish
        if (this.config.connectionStatus !== 'connected') {
          // Skip buffering if message is being flushed or batched
          if (msg._flushing || msg._batched) {
            node.warn(`[NATS-SUITE PUBLISH] Processing failed - connection lost`);
            return;
          }
          
          // If buffering is enabled, queue the message
          if (enableBuffer) {
            // Store original timestamp before buffering (to preserve it during flush)
            if (!msg._originalTimestamp) {
              msg._originalTimestamp = Date.now();
            }
            // Store original event timestamps if present
            if (config.dataformat === 'event') {
              if (msg.startTime && !msg._originalStartTime) {
                msg._originalStartTime = msg.startTime;
              }
              if (msg.endTime && !msg._originalEndTime) {
                msg._originalEndTime = msg.endTime;
              }
            }
            
            const buffered = bufferMessage(msg);
            if (buffered && isDebug) {
              if (bufferSizeType === 'count') {
                node.log(`[NATS-SUITE PUBLISH] Message buffered (${messageQueue.length}/${bufferSize} messages)`);
              } else {
                const currentBufferSize = calculateBufferSize();
                node.log(`[NATS-SUITE PUBLISH] Message buffered (${formatBytesToMB(currentBufferSize)}/${formatBytesToMB(bufferSizeBytes)} MB)`);
              }
            }
            return; // Message queued, exit
          }
          
          // No buffering: Drop message with error
          const cleanError = {
            message: 'Cannot publish - NATS server is not connected',
            code: 'NOT_CONNECTED',
            status: this.config.connectionStatus,
            reconnectAttempts: this.config.connectionStats.reconnectAttempts
          };
          node.error(cleanError, msg);
          return; // Drop message to prevent data loss during reconnection
        }
        
        // Rate Limiting: Check if message is allowed (Token Bucket)
        if (enableRateLimit && !msg._rateLimited && !msg._batched && !msg._flushing) {
          if (!canSendMessage()) {
            // Rate limit exceeded
            droppedByRateLimit++;
            
            switch (rateLimitAction) {
              case 'drop':
                // Silent drop
                if (isDebug) {
                  node.log(`[NATS-SUITE PUBLISH] Rate limit exceeded, message dropped (total: ${droppedByRateLimit})`);
                }
                return;
                
              case 'drop-warn':
                // Drop with warning
                node.warn(`[NATS-SUITE PUBLISH] Rate limit exceeded (${rateLimit}/${rateLimitWindow}ms), message dropped (total: ${droppedByRateLimit})`);
                return;
                
              case 'delay':
                // Queue and delay
                delayQueue.push(msg);
                if (isDebug) {
                  node.log(`[NATS-SUITE PUBLISH] Rate limit exceeded, message queued for delay (queue: ${delayQueue.length})`);
                }
                node.status({ 
                  fill: 'yellow', 
                  shape: 'ring', 
                  text: `rate limited (${delayQueue.length} queued)` 
                });
                
                // Start processing delay queue
                processDelayQueue();
                return;
            }
          }
          
          // Consume token and proceed
          consumeToken();
        }
        
        // Batch Publishing: Add to batch queue if enabled
        if (enableBatch && !msg._batched && !msg._flushing && !msg._rateLimited) {
          addToBatch(msg);
          return;
        }

        const natsnc = await this.config.getConnection();
        let message;
        let subject;

        // Get subject based on mode
        if (mode === 'reply') {
          // Reply mode: Use the reply-to subject from incoming message
          if (!msg._reply) {
            node.warn('Reply mode: No reply subject (msg._reply) found in incoming message. Cannot send reply.', msg);
            return;
          }
          subject = msg._reply;
          
          if (isDebug) {
            node.log(`[NATS-SUITE PUBLISH] Reply mode: Sending reply to ${subject}`);
          }
        } else {
          // Publish or Request mode: Get subject from config or msg.topic (if override enabled)
          const enableTopicOverride = !!config.enableTopicOverride;
          
          // Use msg.topic only if override is enabled AND msg.topic is provided
          if (enableTopicOverride && msg.topic) {
            subject = msg.topic;
          } else {
            subject = config.datapointid;
          }
          
          if (!subject) {
            node.error('No subject specified. Set subject in node config' + (enableTopicOverride ? ' or provide msg.topic' : ''), msg);
            return;
          }
        }

        switch (config.dataformat) {
          case 'json':
            // JSON: Automatically stringify objects
            if (typeof msg.payload === 'object') {
              message = JSON.stringify(msg.payload);
            } else {
              message = String(msg.payload);
            }
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] JSON payload: ${message}`);
              node.log(`[NATS-SUITE PUBLISH] Subject: ${subject}`);
            }
            break;
            
          case 'string':
            // String: Use as-is
            message = String(msg.payload);
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] String payload: ${message}`);
              node.log(`[NATS-SUITE PUBLISH] Subject: ${subject}`);
            }
            break;
            
          case 'buffer':
            // Buffer: Binary data
            if (Buffer.isBuffer(msg.payload)) {
              message = msg.payload;
            } else if (typeof msg.payload === 'string') {
              message = Buffer.from(msg.payload);
            } else {
              message = Buffer.from(JSON.stringify(msg.payload));
            }
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Buffer payload: ${message.length} bytes`);
              node.log(`[NATS-SUITE PUBLISH] Subject: ${subject}`);
            }
            break;

          case 'reply':
            // Reply: For request-reply pattern
            if (!msg._unsreply && !msg._reply) {
              node.error('No reply subject found. This format requires msg._unsreply or msg._reply', msg);
              return;
            }
            subject = msg._unsreply || msg._reply;
            
            if (typeof msg.payload === 'object') {
              message = JSON.stringify(msg.payload);
            } else {
              message = String(msg.payload);
            }
            
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Reply payload: ${message}`);
              node.log(`[NATS-SUITE PUBLISH] Reply subject: ${subject}`);
            }
            break;

          // Legacy UNS formats (kept for backward compatibility)
          case 'uns_value':
            message = {};
            message.value = msg.payload;
            
            // Debug logging for NATS-SUITE Value (only if debug enabled)
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Input payload: ${msg.payload} (type: ${typeof msg.payload})`);
            }
            
            // Automatic datatype detection
            switch (typeof message.value) {
              case 'string':
                message.datatype = 4;
                if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected string, datatype: 4`);
                break;
              case 'number':
                // Check if it's a Unix timestamp (reasonable range)
                const now = Date.now();
                const oneDayAgo = now - 86400000; // 24 hours ago
                const oneDayAhead = now + 86400000; // 24 hours ahead
                
                if (Number.isInteger(message.value) && 
                    message.value >= oneDayAgo && 
                    message.value <= oneDayAhead) {
                  message.datatype = 5; // Unix Timestamp
                  if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected Unix timestamp: ${message.value}, datatype: 5`);
                } else if (Number.isInteger(message.value)) {
                  message.datatype = 1; // Integer
                  if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected integer: ${message.value}, datatype: 1`);
                } else {
                  message.datatype = 2; // Float
                  if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected float: ${message.value}, datatype: 2`);
                }
                message.value = String(message.value);
                break;
              case 'boolean':
                message.datatype = 3;
                if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected boolean: ${message.value}, datatype: 3`);
                message.value = String(message.value);
                break;
              case 'object':
                message.datatype = 6;
                if (isDebug) node.log(`[NATS-SUITE PUBLISH] Detected object, datatype: 6`);
                break;
              default:
                if (isDebug) node.log(`[NATS-SUITE PUBLISH] Unknown type: ${typeof message.value}`);
                return;
            }

            message.id = config.datapointid;
            message.name = config.name;
            // Use original timestamp if available (from buffered message), otherwise create new one
            message.timestamp = msg._originalTimestamp || Date.now();

            message = JSON.stringify(message);

            // Log final message (only if debug enabled)
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Final message: ${message}`);
              node.log(`[NATS-SUITE PUBLISH] Subject: uns.${config.datapointid}`);
            }

            // Set Subject
            subject = 'uns.' + config.datapointid;
            break;

          case 'reply':
            if (!msg._unsreply) {
              const cleanError = {
                message: 'No reply subject found',
                code: 'NO_REPLY_SUBJECT',
              };
              node.error(cleanError, msg);
              return;
            }
            message = msg.payload;
            message = JSON.stringify(message);
            subject = msg._unsreply;
            break;

          case 'event':
            
            // Construct event message from msg properties
            message = {};
            
            // Debug logging for Event (only if debug enabled)
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Input event type: ${msg.type || 'point'}`);
            }
            
            // ID validation and Interval Event ID Management (optimized)
            const eventType = msg.type || 'point';
            
            if (msg.id) {
                if (!isValidUUID(msg.id)) {
                    node.error(createError(
                        `Invalid UUID format: ${msg.id}. Expected format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`,
                        'INVALID_UUID_FORMAT',
                        { invalidId: msg.id }
                    ), msg);
                    return;
                }
                message.id = msg.id;
                
                // Store ID for Interval Events
                if (eventType === 'interval_start' || eventType === 'interval_end') {
                    node.context().set('intervalId', msg.id);
                }
            } else {
                // For Interval Events: Use stored ID or generate new one
                if (eventType === 'interval_start') {
                    const newIntervalId = generateUUID();
                    node.context().set('intervalId', newIntervalId);
                    message.id = newIntervalId;
                } else if (eventType === 'interval_end') {
                    const storedIntervalId = node.context().get('intervalId');
                    if (storedIntervalId) {
                        message.id = storedIntervalId;
                    } else {
                        // Fallback: Generate new ID and warn
                        const newIntervalId = generateUUID();
                        node.warn(`No interval_start event found. Generated new ID: ${newIntervalId}`);
                        message.id = newIntervalId;
                    }
                } else {
                    // Normal events: Generate new UUID
                    message.id = generateUUID();
                    if (isDebug) node.log(`[NATS-SUITE PUBLISH] Generated UUID for event: ${message.id}`);
                }
            }
            
            message.unsElementId = config.datapointid;
            message.type = eventType;
            
            // Use original timestamps if available (from buffered message), otherwise generate new ones
            const nowIso = new Date().toISOString();
            
            // Event-specific timestamp logic (optimized)
            if (eventType === 'point') {
                // Point Events: startTime = endTime
                // Use original timestamp if available, otherwise use provided or current time
                const pointTime = msg._originalStartTime || msg.startTime || nowIso;
                message.startTime = pointTime;
                message.endTime = pointTime;
            } else if (eventType === 'interval_start') {
                // Interval Start: only startTime
                // Use original timestamp if available
                message.startTime = msg._originalStartTime || msg.startTime || nowIso;
            } else if (eventType === 'interval_end') {
                // Interval End: only endTime
                // Use original timestamp if available
                message.endTime = msg._originalEndTime || msg.endTime || nowIso;
            } else {
                // Other event types: both times (if set)
                // Use original timestamps if available
                if (msg._originalStartTime || msg.startTime) {
                  message.startTime = msg._originalStartTime || msg.startTime;
                }
                if (msg._originalEndTime || msg.endTime) {
                  message.endTime = msg._originalEndTime || msg.endTime;
                }
            }
            
            message.payload = msg.payload || {};

            // Convert message to JSON string
            message = JSON.stringify(message);
            
            // Log final event message (only if debug enabled)
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Final event message: ${message}`);
              node.log(`[NATS-SUITE PUBLISH] Subject: event.${config.datapointid}`);
            }

            // Set Subject
            subject = 'event.' + config.datapointid;
            break;
          
          // Legacy format (kept for backward compatibility)
          case 'specific_topic':
            if (typeof msg.payload === 'object') {
              message = JSON.stringify(msg.payload);
            } else {
              message = String(msg.payload);
            }
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Legacy specific_topic format`);
            }
            break;
            
          default:
            node.error(`Unknown data format: ${config.dataformat}. Use 'json', 'string', 'buffer', or 'reply'`, msg);
            return;
        }

        // Debug logging for events (only when debug mode is active)
        if (config.dataformat === 'event' && config.debug) {
          node.log(`[NATS-PUBLISH] Publishing event to subject: ${subject}`);
        }
        
        // Log before publishing (only in debug mode)
        if (config.debug) {
          node.log(`[NATS-SUITE PUBLISH] Publishing to NATS: ${subject}`);
        }
        
        // Prepare publish options with headers and message expiration
        const publishOptions = {};
        
        // Add headers if configured
        if (config.enableHeaders) {
          const headersObj = {};
          
          // Static headers from config
          if (config.headers && config.headers.trim() !== '') {
            try {
              const staticHeaders = JSON.parse(config.headers);
              Object.assign(headersObj, staticHeaders);
            } catch (err) {
              node.warn(`[NATS-SUITE PUBLISH] Failed to parse static headers: ${err.message}`);
            }
          }
          
          // Dynamic headers from msg.headers
          if (msg.headers && typeof msg.headers === 'object') {
            Object.assign(headersObj, msg.headers);
          }
          
          // Create NATS MsgHdrs object and add headers
          if (Object.keys(headersObj).length > 0) {
            const msgHeaders = natsHeaders();
            Object.keys(headersObj).forEach(key => {
              msgHeaders.append(key, String(headersObj[key]));
            });
            publishOptions.headers = msgHeaders;
            if (isDebug) {
              node.log(`[NATS-SUITE PUBLISH] Publishing with headers: ${JSON.stringify(headersObj)}`);
            }
          }
        }
        
        // Add message expiration (TTL) if configured - Note: This requires JetStream
        // For core NATS, message expiration is not supported directly
        // Keeping the code for potential JetStream integration
        if (config.enableMsgExpiration && config.msgExpiration > 0) {
          if (isDebug) {
            node.log(`[NATS-SUITE PUBLISH] Message expiration configured: ${config.msgExpiration}s (Note: requires JetStream)`);
          }
        }
        
        // Dynamic message expiration from msg.expiration (in seconds)
        if (msg.expiration && msg.expiration > 0) {
          if (isDebug) {
            node.log(`[NATS-SUITE PUBLISH] Message expiration (from msg): ${msg.expiration}s (Note: requires JetStream)`);
          }
        }
        
        // Encode message if it's a string (Buffer is already encoded)
        let encodedMessage;
        if (Buffer.isBuffer(message)) {
          encodedMessage = message;
        } else {
          encodedMessage = sc.encode(message);
        }
        
        // Publish with options - NATS.js publish is synchronous
        try {
          natsnc.publish(subject, encodedMessage, publishOptions);
          
          // Log successful publish (only in debug mode)
          if (config.debug) {
            node.log(`[NATS-SUITE PUBLISH] Successfully published to ${subject}`);
          }
        } catch (publishErr) {
          const cleanError = {
            message: publishErr.message,
            code: publishErr.code,
            name: publishErr.name,
          };
          node.error(cleanError, msg);
        }
      } catch (err) {
        const cleanError = {
          message: err.message,
          code: err.code,
          name: err.name,
        };
        node.error(cleanError, msg);
      }
    });

    // on node close
    node.on('close', function () {
      this.config.removeStatusListener(statusListener);
      // Connection Pool: Unregister this node as connection user
      this.config.unregisterConnectionUser(node.id);
      
      // Clean up batch timer
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      
      // Clean up auto-save timer
      if (autoSaveTimer) {
        clearInterval(autoSaveTimer);
        autoSaveTimer = null;
      }
      
      // Clean up pending reply timeouts
      for (const timeoutHandler of pendingReplies.values()) {
        clearTimeout(timeoutHandler);
      }
      pendingReplies.clear();
      
      // Save buffer before closing
      if (enableBuffer && bufferPersistence !== 'none' && messageQueue.length > 0) {
        saveBuffer(true); // Force save on close
        if (isDebug) {
          node.log(`[NATS-SUITE PUBLISH] Saved ${messageQueue.length} messages before closing`);
        }
      }
      
      if (isDebug) {
        node.log(`[NATS-SUITE PUBLISH] Node closed, cleaned up timers and saved buffer`);
      }
    });
    
    // Load buffer on startup
    loadBuffer();
  }
  RED.nodes.registerType('nats-suite-publish', NatsPublishNode);
};
