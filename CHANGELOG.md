## Changelog

### 0.3.0 – `@nats-io` v3 client, native reconnect, real-stack tests, Object Store and Service nodes

This release merges the renovation work from Paul Deng's fork
([pauldeng/node-red-contrib-nats-suite](https://github.com/pauldeng/node-red-contrib-nats-suite),
published there as `@pauldeng/node-red-contrib-nats-suite` 1.0.x) back into this package.
Thanks to @pauldeng. The fork's MIT-licensed contributions are attributed in `NOTICE`.

#### Breaking changes

- **NATS client:** `nats@2` (deprecated on npm) is replaced by the modular `@nats-io/*@3.4.0`
  packages. The runtime floor is now Node.js `>= 18` (was 14). The Node-RED floor stays `>= 3.0.0`.
- **Server Manager credentials:** `authPassword`, `authToken` and `leafRemotePass` moved from
  plain flow properties (stored unencrypted in `flows.json`) into Node-RED's encrypted credential
  store. Re-enter these values once after upgrading; the old plaintext properties are ignored.
- **Publish node slimmed down.** The built-in offline buffer (`enableBuffer`, `bufferSize*`,
  `bufferMode`, `bufferPersistence`, `bufferAutoSaveInterval`), the token-bucket rate limiter
  (`enableRateLimit`, `rateLimit*`), the batching engine (`enableBatch`, `batch*`), the
  never-functional message expiration (`enableMsgExpiration`, `msgExpiration`) and the never
  implemented `replyTimeout` were removed. Use the core `delay` node for rate limiting and
  delays, `batch`/`join` for batching, and JetStream for durable delivery. Existing flows keep
  publishing; the removed properties are ignored.
- **Stream Consumer:** the decorative push-consumer mode (`consumerType`, `idleHeartbeat`,
  `flowControl`) was removed. The node has always fetched from pull consumers; `idle_heartbeat`
  on a pull consumer is rejected by the server.
- **Stream Publisher:** `mirrorDirect` removed (never read). `allowDirect` stays and is now
  actually wired to the stream and to Direct Get.
- **Server config:** the "Max Reconnect Attempts" field removed (it never had an effect).
  Reconnects are indefinite and governed by "Reconnect Wait", which is now really used.
- **`nodes-dev/` is gone.** `nats-suite-object-get`, `nats-suite-object-put` and
  `nats-suite-service` are registered nodes now (see below).
- **Example flow `05-service.json`:** discovery/stats/ping nodes use the new `discoveryFilter`
  property instead of the overloaded `serviceName`.
- Repository hygiene: `TEST-CASES.md`, `tsconfig.json`, `jest.config.js`, `__tests__/` and the
  `bin/` binaries (53 MB) were removed from the repository. The npm package was already free of
  them since 0.2.3.
- **`nats-memory-server` is no longer an optional dependency.** Its transitive `decompress`
  dependency carries an unfixed critical advisory (Zip Slip), and current npm versions block its
  postinstall download anyway. The Server Manager still probes the `nats-memory-server` cache
  locations, so installing that package yourself next to Node-RED keeps working; otherwise use a
  `nats-server` on the `PATH` or a custom binary path.

#### New nodes

- **`nats-suite-object-get` / `nats-suite-object-put`** (promoted from `nodes-dev/`): put/get/
  delete/list objects, bucket create/info/delete/list, plus new `watch` (object-get) and
  `link`/`seal` operations (object-put). Fixed on the way: a non-existent
  `removeConnectionUser` call on close, `os.list()` iterated as an async iterator, `os.put()`
  called with a buffer instead of a stream (now `putBlob()`), bucket TTL passed as `max_age`
  instead of nanosecond `ttl`, object counts that included chunks and delete markers, and the
  `filePath` field that was never persisted.
- **`nats-suite-service`** (promoted from `nodes-dev/`): service/endpoint hosting, discovery,
  stats, ping, health, NATS stats, plus new service groups (`groupSubject`/`groupQueue`) and a
  `reset` operation. Fixed on the way: `jsm.account.info()` and `nc.stats` property reads that
  do not exist, a duplicate DOM id shared by the service name and the discovery filter.
- **`nats-suite-server-pool`**: read or replace the shared connection's known server list
  (`getServers`/`setServers`) with an optional explicit reconnect onto the new pool.

#### New features

- **Native reconnect** on `nats-suite-server`: the client's own reconnect loop (backoff, jitter,
  server rotation) replaces the hand-rolled one. Subscriptions, consumers and services survive
  broker restarts without redeploy; node status shows `connecting (n)` → `connected`. A broker
  that is down at deploy time is retried until it appears or the node is closed.
- **Message tracing** (`nats-suite-server`): one connection-level switch with a trace
  destination, applied by `nats-suite-publish` and `nats-suite-stream-publisher`.
- **Scatter-gather requests** (`nats-suite-publish` mode `requestMany`): `timer`/`count`/
  `stall`/`sentinel` strategies, all replies collected into one output message.
- **Inbound headers** on `nats-suite-subscribe` are now delivered as `msg.headers`.
- **Stream Publisher:** editor fields for one-time and cron **message scheduling**, optimistic
  concurrency (`expectLastMsgID`/`expectLastSequence`), `persistMode`, `allowAtomic`, an
  **atomic `batch-publish`** operation, and `createOnInit` now honours every stream option in the
  editor.
- **Stream Consumer:** `get-message` (direct get or manager get), priority groups and pull
  overflow fields, `pedantic` consumer creation, and real server-side `pause`/`resume`.
- **KV:** `update` is a real compare-and-swap, marker TTL on `create`, advanced watch options
  (`headers_only`, include mode, resume revision, multi-key watch).
- **Object Store:** `watch`, same-store and cross-store `link`, `seal`.
- **Editor:** all dialogs use Node-RED theme variables (dark theme works), help texts are
  Markdown, every `defaults` entry has a matching input and vice versa.
- **Node.js 18 support for the Object Store nodes:** Node 18 exposes the Web Crypto API only
  behind a flag, and `@nats-io/obj` hashes object chunks with `crypto.subtle`. A guarded shim in
  `lib/webcrypto.js` provides the global on Node 18 and is a no-op elsewhere.

#### Bug fixes

- JWT authentication never worked: `credsAuthenticator` was called with a JWT and a seed, but it
  takes a single `.creds` blob. Now `jwtAuthenticator(jwt, seed)`.
- Connection leak: concurrent `getConnection()` calls at startup each opened their own
  connection; only the last one was ever closed. Connects are single-flight now.
- `purge` on `nats-suite-stream-publisher` and `nats-suite-stream-consumer` threw
  (`stream.purge` does not exist); it uses `jsm.streams.purge(name)` now. The consumer's
  stream-level operations were also unreachable because they required an empty consumer name.
- KV bucket `ttl` and `maxValueSize` were silently ignored (passed as `max_age`/
  `max_value_size`).
- Consumer monitor reported `ack_pending` as undefined, used the stream sequence as the
  delivered count and computed a delivery rate from a nanosecond timestamp.
- `close` handlers in kv-get, stream-consumer, stream-publisher, kv-put, object-get, object-put
  and server-manager were not awaited by Node-RED (no `done` parameter); a redeploy could race
  the KV watcher or the embedded server shutdown.
- Status-revert timers in stream-publisher, publish and service outlived the node and fired
  after redeploy; the connection-timeout warning and the deferred-close timer on the server
  config node were not cleared on close.
- Input handlers follow the Node-RED completion contract (`done()`/`done(err)`), so Catch nodes
  fire exactly once per failure and Complete nodes only after a real publish.
- Publish node: duplicate `case 'reply'` in the data-format switch, Auto-Reply had no checkbox in
  the editor, `outputs` inside `defaults` shadowed the real property.
- Removed dead editor state: `bucketConfig` referencing a node type that does not exist,
  `topicfield` on subscribe, `bucketOperation` on kv-put.
- `.eslintrc` referenced configs that were never installed; lint runs for the first time and is
  clean.

#### Internals and tooling

- Shared helpers in `lib/` (`resolveServer`, `attachStatus`, `toPayload`/`fromMsg`,
  `parseDuration`/`parseSize`) replace up to nine copies of the same code.
- Tests: `npm test` runs `node:test` against a real Node-RED and a real NATS server in Docker
  (`docker-compose.yml`), driven through the Admin API and the `/comms` websocket. No mocks.
  `NODERED_IMAGE` selects the Node-RED image under test; CI runs the suite against Node-RED 5.0
  (Node 22 and 24) and against the floors Node-RED 4.1 and 3.1 on Node.js 18.
- ESLint 10 flat config, Prettier, GitHub Actions CI (lint, format check, audit, packed-contents
  check, tests on Node 22 and 24), Dependabot with a grouped `@nats-io/*` update.
- The publish workflow now verifies that the tag matches `package.json` and runs the full checks
  before publishing via npm trusted publishing.

---

### 0.2.3 – Relicensed to Apache-2.0

#### Changed

- **License changed from MIT to Apache-2.0.** Apache-2.0 is the license
  Node-RED itself uses. Compared to MIT it adds an explicit patent grant
  (section 3), keeps attribution intact downstream through the new `NOTICE`
  file (section 4d), and requires modified files to be marked as changed
  (section 4b). It remains fully permissive: commercial use, closed-source
  derivatives and forks are all still allowed.
- **`NOTICE` added** and verified to ship inside the npm tarball.
- **Contributing and fork guidance in the README.** Pull requests are welcome,
  including large ones — an issue up front means substantial work can usually
  land here instead of in a parallel package. Forks that are published under
  their own package name are asked to rename their Node-RED node type IDs and
  use their own palette category, so both packages can be installed side by
  side.
- **Package contents restricted via `files`.** The tarball shipped the whole
  repository, including `bin/act` (20.3 MB) and two `nats-server` binaries
  (33 MB combined) that the nodes never load — the server-manager node resolves
  `nats-server` from `nats-memory-server`, the system `PATH`, or a configured
  custom path, never from a bundled `bin/`. The published package drops from
  20.4 MB to 91 kB (480 kB unpacked).

### 0.2.2 – NKey-Only Authentication Fix

> Note: version `0.2.1` was published to npm directly without a corresponding commit on `main`. This release continues from `0.2.0` on `main` and skips `0.2.1` to avoid version drift.

#### Bug Fixes

**NATS Server (`nats-suite-server`)**

- Fixed broken NKey-only authentication (#14, fixes #15):
  - Resolved duplicate HTML element ID `node-config-input-nkeySeed` shared between the JWT and NKey-only sections, which caused the seed value entered in the NKey-only form to never be persisted by Node-RED.
  - The two NKey seed fields are now kept in sync via jQuery so the value entered in either section ends up in the credential store.
  - Replaced incorrect use of `credsAuthenticator` with `nkeyAuthenticator` for the NKey-only authentication path (`credsAuthenticator` is only valid for combined JWT + NKey credentials files).
  - Added a clear error message when `authMethod` is `nkey` but no NKey seed is configured.

#### Credits

- Thanks to @cfedersp for reporting (#15) and contributing the fix (#14).

---

### 0.0.5 – Stream Consumer Enhancements & Documentation

#### New Features

**Stream Consumer (`nats-suite-stream-consumer`)**

- **Create on Init option**: New `createOnInit` setting to control whether a consumer is automatically created on node initialization
- **Output data format**: Configurable output format and debug logging for consumed messages
- **Flow control UI**: Improved UI with idle status indicator for better visibility of consumer state
- **Consumer config visibility**: Refactored UI to show/hide consumer configuration options based on context

**Stream Publisher (`nats-suite-stream-publisher`)**

- **Create on Init option**: New `createOnInit` setting to control whether a stream is automatically created on node initialization

**NATS Feature Coverage Documentation**

- Added comprehensive NATS Feature Coverage section to README
- Detailed feature matrix for all NATS areas:
  - Core NATS (17 features documented)
  - JetStream (25 features documented)
  - KV Store (16 features documented)
  - Object Store (13 features documented)
  - Services API (8 features documented)
  - Server Management (8 features documented)
- Coverage summary with implementation percentages
- Clear status indicators (✅ Complete, 🔧 In Development, 🔄 Partial, ❌ Not Implemented)
- Roadmap for planned features

#### Improvements

- `nats-memory-server` moved from `dependencies` to `optionalDependencies` – no longer required for installation
- Added contributors to `package.json`
- Added npm downloads and Node.js version badges to README

#### Documentation

- All documentation files are now in English
- Added legend explaining status symbols
- Added feature-to-node mapping for easy reference
- Improved structure and readability of README
- Updated test cases in `TEST-CASES.md`

#### CI/CD

- Added workflow to create GitHub issues from TODO comments
- Simplified todo-workflow by removing unused steps and permissions
- Refactored `.npmignore` and updated `package.json` for development environment

---

### 0.0.3 – Stability & Bug Fixes

#### Improvements

- Improved connection handling stability
- Better error messages for common issues
- Enhanced debug logging across all nodes

#### Bug Fixes

- Fixed edge cases in KV Store watch operation
- Improved Stream Consumer message acknowledgment handling
- Fixed status display inconsistencies

---

### 0.0.2 – Server Manager Enhancements

#### New Features

**Server Manager (`nats-suite-server-manager`)**

- **External Config File Support**: Use a mounted `.conf` file instead of generating config from UI settings
- **WebSocket Support**: Enable WebSocket connections for browser-based clients (configurable port)
- **TLS/SSL Encryption**: Full TLS support with certificate, key, and CA file configuration
- **Authentication**: Token-based or username/password authentication for the embedded server
- **Max File Store**: Configure JetStream file storage limits
- **Improved Status Display**: Shows startup phases (initializing → starting → running)
- **Debug Logging Options**: Enable NATS server debug (`-D`) and trace (`-V`) modes from UI
- **Simplified Command API**: Use `msg.command` instead of `msg.payload.command`

**Pre-built Binaries**

- Included NATS server binaries v2.12.2 for Linux (AMD64 and ARM64)
- Custom binary path support for mounting your own nats-server

**Example Configs**

- Added `config/nats-embedded.conf` as example configuration for the server manager

#### Improvements

- Config sections hide automatically when using external config file
- Better port detection from external config files
- Connection verification before marking server as "running"
- Removed "NEW" badges from stabilized features

#### Bug Fixes

- Fixed `credentials: null` in Leaf Node configuration
- Fixed `node.serverType` undefined in stop payload
- Fixed repeated status updates during stdout processing

---

### 0.0.1 – Initial preview

- Initial public release of `node-red-contrib-nats-suite`.
- Core NATS nodes: `nats-suite-server`, `nats-suite-publish`, `nats-suite-subscribe`.
- JetStream nodes: `nats-suite-stream-publisher`, `nats-suite-stream-consumer` (including stream/consumer management operations).
- Key-Value Store nodes: `nats-suite-kv-get`, `nats-suite-kv-put`.
- Object Store nodes (dev): `nats-suite-object-put`, `nats-suite-object-get`.
- Service API node (dev): `nats-suite-service` (service discovery, stats, endpoints, ping).
- NATS Server Manager node: `nats-suite-server-manager` for starting/stopping NATS directly from Node-RED.
- Added Jest configuration and initial test cases under `__tests__` plus detailed manual scenarios in `TEST-CASES.md`.
