'use strict';

// Resolves and validates the NATS server config node referenced by
// config.server. Paints the node's own red/ring error status and calls
// node.error() when either no server is selected or the referenced config
// node no longer exists (deleted). Returns the resolved server config node,
// or undefined on failure - callers must check the return value and stop
// node construction, matching every existing call site's early-return.
function resolveServer(RED, node, config) {
  if (!config.server) {
    node.error('NATS server configuration not selected');
    node.status({ fill: 'red', shape: 'ring', text: 'no server' });
    return undefined;
  }
  const serverConfig = RED.nodes.getNode(config.server);
  if (!serverConfig) {
    node.error('NATS server configuration not found');
    node.status({ fill: 'red', shape: 'ring', text: 'server not found' });
    return undefined;
  }
  return serverConfig;
}

module.exports = { resolveServer };
