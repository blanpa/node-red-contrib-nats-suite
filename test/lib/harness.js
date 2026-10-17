'use strict';

// Test harness for driving the real docker-compose stack (nats-server +
// nodered, both already defined in docker-compose.yml). No mocks: flows are
// deployed into the real Node-RED admin API, status/output are observed over
// its real /comms websocket, and NATS is exercised directly from this
// process with the modular NATS transport declared as a dependency.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('@nats-io/transport-node');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// docker compose reads .env automatically; Node does not. Load it so a bare
// `npm test` dials the same host ports compose actually published. Missing
// .env (e.g. CI, where defaults are correct) is not an error.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  /* no .env - defaults apply */
}

// Reachable from this test process (host). Reachable from *inside* the
// nodered container is a different address (its own docker network hostname)
// - see NATS_CONTAINER_URL.
const NODE_RED_PORT = process.env.NODERED_PORT || 1885;
const NODE_RED_URL =
  process.env.NODE_RED_URL || `http://localhost:${NODE_RED_PORT}`;
// Default derives from NATS_CLIENT_PORT so the host-side port override used by
// docker-compose cannot drift from the port tests dial. If they drift, tests
// silently talk to a different broker than Node-RED does and time out obscurely.
const NATS_URL =
  process.env.NATS_URL || `localhost:${process.env.NATS_CLIENT_PORT || 4222}`;
const NATS_CONTAINER_URL =
  process.env.NATS_CONTAINER_URL || 'nats://nats-server:4222';
const HARNESS_LABEL = 'test-harness';

// --- Docker / compose lifecycle ----------------------------------------

function dockerAvailable() {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForAdminApi(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${NODE_RED_URL}/flows`);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    // ponytail: Node-RED's HTTP server exposes no "ready" event to an
    // external process, so polling is the only available signal here.
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(
    `Node-RED admin API not reachable at ${NODE_RED_URL}: ${lastErr && lastErr.message}`
  );
}

// Brings up the services already defined in docker-compose.yml and waits for
// Node-RED's admin API to answer. Only an unavailable Docker/Compose runtime
// is skippable; product or startup failures must fail the test.
async function ensureStackUp() {
  if (!dockerAvailable()) return 'Docker is not available on this host';
  try {
    fs.mkdirSync(path.join(REPO_ROOT, 'bin'), { recursive: true });
    execFileSync('docker', ['compose', 'up', '-d', 'nats-server', 'nodered'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    const natsBinaryPath = path.join(REPO_ROOT, 'bin', 'nats-server');
    execFileSync('docker', [
      'cp',
      'nats-server-dev:/nats-server',
      natsBinaryPath,
    ]);
    fs.chmodSync(natsBinaryPath, 0o755);
  } catch (err) {
    throw new Error(`docker compose up failed: ${err.message}`, { cause: err });
  }
  await waitForAdminApi();
  await sweepHarnessFlows().catch(() => {});
  return null;
}

// --- Node-RED admin API (flows) -----------------------------------------

// Deploys `nodes` as one new flow tab via POST /flow (adds to whatever is
// already deployed, rather than replacing the whole flow set). Node-RED
// always assigns its own id/z to a new tab regardless of what's supplied, so
// callers may put any placeholder string in each node's `z` - it gets
// rewritten to the real tab id. Node `id`s the caller sets ARE preserved, so
// tests can hardcode ids like 'srv1'/'pub1' and use them directly afterwards.
async function deployFlow(nodes) {
  const res = await fetch(`${NODE_RED_URL}/flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'harness', label: HARNESS_LABEL, nodes }),
  });
  if (!res.ok)
    throw new Error(
      `deployFlow failed: HTTP ${res.status} ${await res.text()}`
    );
  return (await res.json()).id;
}

// Deletes any 'test-harness' tabs left behind by a previous run. A test process
// killed mid-run (timeout, SIGINT) never reaches its `finally`, so leaked tabs
// would otherwise accumulate in the tracked node-red/flows.json forever.
async function sweepHarnessFlows() {
  const res = await fetch(`${NODE_RED_URL}/flows`);
  if (!res.ok) return 0;
  const flows = await res.json();
  const stale = flows.filter(
    n => n.type === 'tab' && n.label === HARNESS_LABEL
  );
  for (const tab of stale) await deleteFlow(tab.id).catch(() => {});
  return stale.length;
}

async function deleteFlow(flowId) {
  const res = await fetch(`${NODE_RED_URL}/flow/${flowId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`deleteFlow failed: HTTP ${res.status}`);
}

// Fires a deployed inject node on demand via the admin API, independent of
// its own repeat/once configuration.
async function triggerInject(nodeId) {
  const res = await fetch(`${NODE_RED_URL}/inject/${nodeId}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`triggerInject failed: HTTP ${res.status}`);
}

// --- Node-RED comms websocket (status + debug output) -------------------

// Connects to the runtime's /comms websocket - the same channel the editor
// uses - and lets callers await specific status/debug events. Subscribing to
// "status/#" makes the runtime immediately replay the *current* status of
// every deployed node, then keep streaming live updates; "debug" messages
// (from active debug nodes) are broadcast to every connected client without
// a separate subscribe call. Verified against the real running container.
function connectComms() {
  const ws = new WebSocket(`${NODE_RED_URL.replace(/^http/, 'ws')}/comms`);
  const waiters = new Map(); // topic -> [{ predicate, resolve, timer }]

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ subscribe: 'status/#' }));
      resolve();
    };
    ws.onerror = () =>
      reject(new Error(`comms websocket error connecting to ${NODE_RED_URL}`));
  });

  ws.onmessage = ev => {
    for (const { topic, data } of JSON.parse(ev.data)) {
      const list = waiters.get(topic);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].predicate(data)) {
          clearTimeout(list[i].timer);
          list[i].resolve(data);
          list.splice(i, 1);
        }
      }
    }
  };

  // Race-safe: register the waiter (and thus start buffering matching
  // events) before returning, so a caller can register a wait and only then
  // trigger the action that produces it without missing a fast/synchronous
  // reply.
  function waitFor(topic, predicate, timeoutMs = 10000) {
    if (!waiters.has(topic)) waiters.set(topic, []);
    const list = waiters.get(topic);
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for comms topic "${topic}"`
            )
          );
        }, timeoutMs),
      };
      list.push(entry);
    });
  }

  return {
    ready,
    waitForStatus: (nodeId, predicate, timeoutMs) =>
      waitFor(`status/${nodeId}`, predicate, timeoutMs),
    waitForDebug: async (nodeId, timeoutMs) => {
      const d = await waitFor('debug', d => d.id === nodeId, timeoutMs);
      return JSON.parse(d.msg);
    },
    close: () => ws.close(),
  };
}

// --- Reusable node-config fragments --------------------------------------

// Standard nats-suite-server config, shared by every test file that needs one
// deployed alongside the node(s) under test. Matches the fields exercised in
// smoke.test.js; callers override only what a given test needs to vary
// (e.g. reconnectTimeWait: 500 to shorten a recovery check).
function serverNode(id, overrides = {}) {
  return {
    id,
    type: 'nats-suite-server',
    server: NATS_CONTAINER_URL,
    authMethod: 'none',
    enableTLS: false,
    tlsRejectUnauthorized: true,
    reconnectTimeWait: 1000,
    timeout: 10000,
    pingInterval: 30000,
    maxPingOut: 3,
    debug: false,
    ...overrides,
  };
}

// --- Direct NATS access (the other side of the wire) ---------------------

// Connects to the real NATS server directly from the test process, so a test
// can assert on both ends: what the Node-RED nodes did, and what actually
// crossed the wire. `tls: null` matches what nats-suite-server.js itself
// sets when TLS is disabled - without it, nats.js performs an opportunistic
// TLS upgrade against this server's self-signed cert and connect() fails
// with UNABLE_TO_VERIFY_LEAF_SIGNATURE (verified against the real container).
async function connectDirectNats(overrides = {}) {
  return connect({
    servers: NATS_URL,
    tls: null,
    // ponytail: NOT waitOnFirstConnect - verified against the modular client's
    // source that true makes the first connect retry
    // forever, ignoring maxReconnectAttempts entirely. A test harness needs
    // the opposite: fail fast (verified ~12ms) when NATS is genuinely down,
    // with just enough retry budget to absorb a container that's mid-boot.
    maxReconnectAttempts: 5,
    reconnectTimeWait: 500,
    ...overrides,
  });
}

function publishDirect(nc, subject, payload) {
  nc.publish(subject, new TextEncoder().encode(String(payload)));
}

// Resolves with the decoded payload of the first message received on
// `subject`, or rejects after `timeoutMs`. Call this *before* triggering
// whatever produces the message. Call `await nc.flush()` after creating the
// waiter so the server has processed the subscription before an external
// producer is triggered.
async function subscribeOnce(nc, subject, timeoutMs = 8000) {
  const sub = nc.subscribe(subject);
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const m of sub) return new TextDecoder().decode(m.data);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for a message on "${subject}"`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try {
      sub.unsubscribe();
    } catch {
      // already closed - fine
    }
  }
}

// Same wait as subscribeOnce, but resolves with the raw NATS Msg instead of a
// decoded string - needed whenever a test must inspect wire-level detail
// subscribeOnce deliberately throws away (headers, exact bytes for a
// non-UTF8 buffer payload). Kept as a separate function rather than
// rewriting subscribeOnce in terms of it: subscribeOnce is depended on by
// smoke.test.js and is not this file's to restructure.
async function subscribeOnceMsg(nc, subject, timeoutMs = 8000) {
  const sub = nc.subscribe(subject);
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const m of sub) return m;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for a message on "${subject}"`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try {
      sub.unsubscribe();
    } catch {
      // already closed - fine
    }
  }
}

module.exports = {
  NODE_RED_URL,
  NATS_URL,
  NATS_CONTAINER_URL,
  ensureStackUp,
  deployFlow,
  deleteFlow,
  sweepHarnessFlows,
  triggerInject,
  connectComms,
  connectDirectNats,
  publishDirect,
  subscribeOnce,
  subscribeOnceMsg,
  serverNode,
};
