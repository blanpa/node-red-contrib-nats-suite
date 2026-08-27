## Changelog

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
