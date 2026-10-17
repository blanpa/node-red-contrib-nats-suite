'use strict';

const DEFAULT_PAINT = {
  connected: { fill: 'green', shape: 'dot', text: 'connected' },
  disconnected: { fill: 'red', shape: 'ring', text: 'disconnected' },
  connecting: { fill: 'yellow', shape: 'ring', text: 'connecting' },
};

// Wires node.status() to a server config node's connection-status listener
// (addStatusListener/removeStatusListener), normalizing both the legacy
// bare-string and the current {status, reconnectAttempts, ...} forms.
// `handlers` lets a caller override connected/disconnected/connecting with
// its own function(statusInfo) - for painting plus side effects like a
// timeout-warning timer or a domain-specific status label (e.g. a bucket or
// consumer name). States without a handler get the default paint above.
// Returns detach() for the node's close handler.
function attachStatus(node, cfg, handlers = {}) {
  const listener = statusInfo => {
    const status = statusInfo.status || statusInfo;
    const handler = handlers[status];
    if (handler) {
      handler(statusInfo);
      return;
    }
    const paint = DEFAULT_PAINT[status];
    if (paint) node.status(paint);
  };
  cfg.addStatusListener(listener);
  return () => cfg.removeStatusListener(listener);
}

module.exports = { attachStatus };
