## Changelog

### 0.0.4 – Documentation & Feature Coverage

#### New Features

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

#### Documentation Improvements
- All documentation files are now in English
- Added legend explaining status symbols
- Added feature-to-node mapping for easy reference
- Improved structure and readability of README

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
