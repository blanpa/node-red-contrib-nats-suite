'use strict';

const { TimeoutError, headers: natsHeaders } = require('@nats-io/nats-core');
const { resolveServer } = require('../lib/connect');
const { attachStatus } = require('../lib/status');

module.exports = function (RED) {
  function NatsPublishNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const isDebug = !!config.debug;
    const mode = config.mode || 'publish';
    const enableTopicOverride = !!config.enableTopicOverride;
    const requestTimeout = config.requestTimeout || 5000;
    const requestFallbackToPublish = config.requestFallbackToPublish !== false;
    const enableAutoReply = mode === 'reply' && !!config.enableAutoReply;

    const setStatusRed = () =>
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
    const setStatusGreen = () =>
      node.status({ fill: 'green', shape: 'dot', text: 'connected' });

    let statusRestoreTimer = null;

    setStatusRed();

    this.config = resolveServer(RED, node, config);
    if (!this.config) return;

    const detachStatus = attachStatus(node, this.config, {
      connected: () => {
        setStatusGreen();
      },
      disconnected: statusInfo => {
        node.status({
          fill: 'red',
          shape: 'ring',
          text: `disconnected (${statusInfo.reconnectAttempts || 0})`,
        });
      },
      connecting: statusInfo => {
        node.status({
          fill: 'yellow',
          shape: 'ring',
          text: `connecting (${statusInfo.reconnectAttempts || 0})`,
        });
      },
    });

    this.config.registerConnectionUser(node.id);

    // Resolve the subject to publish/reply on for the current mode
    function resolveSubject(msg) {
      if (mode === 'reply') {
        return msg._reply || msg._unsreply || null;
      }
      if (enableTopicOverride && msg.topic) {
        return msg.topic;
      }
      return config.datapointid || null;
    }

    // Encode msg.payload per the configured data format; undefined = unknown format
    function encodePayload(payload) {
      switch (config.dataformat) {
        case 'string':
          return String(payload);
        case 'buffer':
          if (Buffer.isBuffer(payload)) return payload;
          if (typeof payload === 'string') return Buffer.from(payload);
          return Buffer.from(JSON.stringify(payload));
        case 'json':
          return typeof payload === 'object'
            ? JSON.stringify(payload)
            : String(payload);
        default:
          return undefined;
      }
    }

    // Merge static config headers with dynamic msg.headers into a NATS MsgHdrs
    function buildHeaders(msg) {
      if (!config.enableHeaders) return undefined;
      const headersObj = {};
      if (config.headers && config.headers.trim() !== '') {
        try {
          Object.assign(headersObj, JSON.parse(config.headers));
        } catch (err) {
          node.warn(
            `[NATS-SUITE PUBLISH] Failed to parse static headers: ${err.message}`
          );
        }
      }
      if (msg.headers && typeof msg.headers === 'object') {
        Object.assign(headersObj, msg.headers);
      }
      if (Object.keys(headersObj).length === 0) return undefined;
      const msgHeaders = natsHeaders();
      Object.keys(headersObj).forEach(key =>
        msgHeaders.append(key, String(headersObj[key]))
      );
      return msgHeaders;
    }

    // Briefly show a transient status, then fall back to 'connected'
    function restoreStatusSoon() {
      if (statusRestoreTimer) clearTimeout(statusRestoreTimer);
      statusRestoreTimer = setTimeout(() => {
        statusRestoreTimer = null;
        if (node.config.connectionStatus === 'connected') setStatusGreen();
      }, 3000);
    }

    // Request-Reply mode (client side): send a request and wait for the reply.
    // Returns null on success, or the error object to report via done(err).
    async function handleRequest(msg, send) {
      if (node.config.connectionStatus !== 'connected') {
        msg.error = {
          message: 'Cannot send request - NATS server is not connected',
          code: 'NOT_CONNECTED',
        };
        send(msg);
        return msg.error;
      }

      const subject = resolveSubject(msg);
      if (!subject) {
        msg.error = {
          message:
            'No subject specified. Set subject in node config' +
            (enableTopicOverride ? ' or provide msg.topic' : ''),
          code: 'NO_SUBJECT',
        };
        send(msg);
        return msg.error;
      }

      const natsnc = await node.config.getConnection();
      const requestPayload = encodePayload(msg.payload);
      if (requestPayload === undefined) {
        msg.error = {
          message: `Unknown data format: ${config.dataformat}. Use 'json', 'string', or 'buffer'`,
          code: 'UNKNOWN_FORMAT',
        };
        send(msg);
        return msg.error;
      }
      const startTime = Date.now();

      node.status({ fill: 'blue', shape: 'ring', text: `request: ${subject}` });

      try {
        const response = await natsnc.request(subject, requestPayload, {
          timeout: requestTimeout,
          ...node.config.getTraceOptions(),
        });
        const requestTime = Date.now() - startTime;
        let responsePayload;
        try {
          responsePayload = response.json();
        } catch {
          responsePayload = response.string();
        }
        msg.payload = responsePayload;
        msg.requestTime = requestTime;
        msg.subject = response.subject;
        delete msg.error;
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `reply: ${requestTime}ms`,
        });
        restoreStatusSoon();
        send(msg);
        return null;
      } catch (requestErr) {
        const isTimeout = requestErr instanceof TimeoutError;

        if (isTimeout && requestFallbackToPublish) {
          try {
            natsnc.publish(subject, requestPayload);
            msg.fallback = 'publish';
            msg.fallbackReason = 'request_timeout';
            delete msg.error;
            node.status({
              fill: 'green',
              shape: 'dot',
              text: 'fallback publish',
            });
            restoreStatusSoon();
            send(msg);
            return null;
          } catch (publishErr) {
            node.warn(
              `[NATS-SUITE PUBLISH] Request timeout fallback failed: ${publishErr.message}`
            );
          }
        }

        msg.error = isTimeout
          ? {
              message: `Request timeout after ${requestTimeout}ms`,
              code: 'TIMEOUT',
            }
          : {
              message: requestErr.message || 'Request failed',
              code: requestErr.code || 'REQUEST_FAILED',
            };
        node.status({
          fill: isTimeout ? 'yellow' : 'red',
          shape: 'ring',
          text: isTimeout ? `timeout: ${requestTimeout}ms` : 'request failed',
        });
        restoreStatusSoon();
        send(msg);
        return msg.error;
      }
    }

    // Scatter-gather (client side): send one request, collect every reply
    // that arrives within the configured window into a single batch. Unlike
    // handleRequest() above, this never falls back to a plain publish - a
    // window that collects zero replies is a valid (if unusual) result, not
    // a failure needing a fallback.
    async function handleRequestMany(msg, send) {
      if (node.config.connectionStatus !== 'connected') {
        msg.error = {
          message: 'Cannot send request - NATS server is not connected',
          code: 'NOT_CONNECTED',
        };
        send(msg);
        return msg.error;
      }

      const subject = resolveSubject(msg);
      if (!subject) {
        msg.error = {
          message:
            'No subject specified. Set subject in node config' +
            (enableTopicOverride ? ' or provide msg.topic' : ''),
          code: 'NO_SUBJECT',
        };
        send(msg);
        return msg.error;
      }

      const strategy =
        msg.requestManyStrategy || config.requestManyStrategy || 'timer';
      const maxWait =
        parseInt(msg.requestManyMaxWait, 10) ||
        parseInt(config.requestManyMaxWait, 10) ||
        2000;
      if (!(maxWait > 0)) {
        msg.error = {
          message: `Invalid Request Many max wait: ${maxWait}`,
          code: 'INVALID_MAX_WAIT',
        };
        send(msg);
        return msg.error;
      }

      const requestManyOpts = {
        strategy,
        maxWait,
        ...node.config.getTraceOptions(),
      };

      // Verified against a real broker: maxMessages is only honored by the
      // 'count' strategy - 'timer'/'stall'/'sentinel' silently ignore it and
      // run their own stop condition to completion regardless of its value.
      // Only send it where it does something.
      if (strategy === 'count') {
        const maxMessagesRaw =
          msg.requestManyMaxMessages !== undefined
            ? msg.requestManyMaxMessages
            : config.requestManyMaxMessages;
        const maxMessages = parseInt(maxMessagesRaw, 10);
        if (maxMessages > 0) requestManyOpts.maxMessages = maxMessages;
      }

      if (strategy === 'stall') {
        const stallRaw =
          msg.requestManyStall !== undefined
            ? msg.requestManyStall
            : config.requestManyStall;
        const stall = parseInt(stallRaw, 10);
        if (stall > 0) requestManyOpts.stall = stall;
      }

      const natsnc = await node.config.getConnection();
      const requestPayload = encodePayload(msg.payload);
      if (requestPayload === undefined) {
        msg.error = {
          message: `Unknown data format: ${config.dataformat}. Use 'json', 'string', or 'buffer'`,
          code: 'UNKNOWN_FORMAT',
        };
        send(msg);
        return msg.error;
      }
      const startTime = Date.now();

      node.status({
        fill: 'blue',
        shape: 'ring',
        text: `requestMany: ${subject}`,
      });

      try {
        const iter = await natsnc.requestMany(
          subject,
          requestPayload,
          requestManyOpts
        );
        const replies = [];
        for await (const m of iter) {
          let replyPayload;
          try {
            replyPayload = m.json();
          } catch {
            replyPayload = m.string();
          }
          let replyHeaders;
          if (m.headers) {
            replyHeaders = {};
            for (const [key, values] of m.headers) {
              replyHeaders[key] = values.length === 1 ? values[0] : values;
            }
          }
          replies.push({
            payload: replyPayload,
            headers: replyHeaders,
            subject: m.subject,
          });
        }
        const elapsed = Date.now() - startTime;
        msg.payload = replies.map(r => r.payload);
        msg.replies = replies;
        msg.replyCount = replies.length;
        delete msg.error;
        node.status({
          fill: 'green',
          shape: 'dot',
          text: `${replies.length} replies (${elapsed}ms)`,
        });
        restoreStatusSoon();
        send(msg);
        return null;
      } catch (requestManyErr) {
        msg.error = {
          message: requestManyErr.message || 'Request Many failed',
          code: requestManyErr.code || 'REQUEST_MANY_FAILED',
        };
        node.status({ fill: 'red', shape: 'ring', text: 'requestMany failed' });
        restoreStatusSoon();
        send(msg);
        return msg.error;
      }
    }

    node.on('input', async function (msg, send, done) {
      try {
        // Request-Reply mode: full round trip handled separately, then stop
        if (mode === 'request' && !msg._requestReplyProcessed) {
          msg._requestReplyProcessed = true;
          const err = await handleRequest(msg, send);
          done(err);
          return;
        }

        // Scatter-gather mode: collect every reply within the window, then stop
        if (mode === 'requestMany' && !msg._requestManyProcessed) {
          msg._requestManyProcessed = true;
          const err = await handleRequestMany(msg, send);
          done(err);
          return;
        }

        // Auto-Reply (service side): forward to output; the real publish happens
        // when the processed response loops back through this same input
        if (enableAutoReply && !msg._autoReplyProcessed) {
          msg._autoReplyProcessed = true;
          if (isDebug)
            node.log(
              '[NATS-SUITE PUBLISH] Auto-reply: forwarded to output, awaiting response message'
            );
          send(msg);
          done();
          return;
        }

        if (node.config.connectionStatus !== 'connected') {
          done({
            message: 'Cannot publish - NATS server is not connected',
            code: 'NOT_CONNECTED',
            status: node.config.connectionStatus,
            reconnectAttempts: node.config.connectionStats.reconnectAttempts,
          });
          return;
        }

        const subject = resolveSubject(msg);
        if (!subject) {
          if (mode === 'reply') {
            done(
              new Error(
                'Reply mode: no reply subject (msg._reply or msg._unsreply) found. Cannot send reply.'
              )
            );
            return;
          }
          done(
            new Error(
              'No subject specified. Set subject in node config' +
                (enableTopicOverride ? ' or provide msg.topic' : '')
            )
          );
          return;
        }

        const encoded = encodePayload(msg.payload);
        if (encoded === undefined) {
          done(
            new Error(
              `Unknown data format: ${config.dataformat}. Use 'json', 'string', or 'buffer'`
            )
          );
          return;
        }

        const natsnc = await node.config.getConnection();
        const publishOptions = { ...node.config.getTraceOptions() };
        const hdrs = buildHeaders(msg);
        if (hdrs) publishOptions.headers = hdrs;

        natsnc.publish(subject, encoded, publishOptions);
        if (isDebug) node.log(`[NATS-SUITE PUBLISH] Published to ${subject}`);

        send(msg);
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on('close', function (done) {
      if (statusRestoreTimer) clearTimeout(statusRestoreTimer);
      statusRestoreTimer = null;
      detachStatus();
      node.config.unregisterConnectionUser(node.id);
      done();
    });
  }

  RED.nodes.registerType('nats-suite-publish', NatsPublishNode);
};
