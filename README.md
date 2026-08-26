# node-red-contrib-nats-suite

[![npm version](https://img.shields.io/npm/v/node-red-contrib-nats-suite.svg)](https://www.npmjs.com/package/node-red-contrib-nats-suite)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-nats-suite.svg)](https://www.npmjs.com/package/node-red-contrib-nats-suite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node-RED](https://img.shields.io/badge/Node--RED-node--red--contrib--nats--suite-red?logo=nodered)](https://flows.nodered.org/node/node-red-contrib-nats-suite)
[![Node.js Version](https://img.shields.io/node/v/node-red-contrib-nats-suite.svg)](https://nodejs.org/)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange.svg)]()
[![Discord](https://img.shields.io/discord/1234567890?logo=discord&label=Discord)](https://discord.gg/mrebeSaZzx)

A comprehensive Node-RED module for NATS (NATS Messaging System) with support for all major NATS features. This is a **generic NATS implementation** that works with any NATS server - not bound to a specific platform.

## Status & Versioning

- **Current version**: `0.2.2`
- **Stability**: APIs and node options may still change between minor versions.
- **Tested with**: Node-RED `>= 3.0.0`, Node.js `>= 14.0.0`, NATS Server `>= 2.9` (with JetStream enabled for JetStream/KV/Object Store features).
- For detailed manual test flows, see `TEST-CASES.md`. Automated tests are located in the `__tests__` directory and can be executed via `npm test`.

## Features

### Core NATS (Basic NATS Core Functionality)
- **Publish/Subscribe**: Full support for NATS Pub/Sub messaging
- **Request/Reply**: NATS Request/Reply pattern for synchronous communication
- **Queue Groups**: Load balancing with Queue Groups
- **Headers**: Support for NATS Headers
- **Wildcards**: Subject wildcards (*, >)
- **TLS**: Encrypted connections
- **Authentication**: Token, Username/Password, JWT or NKey
- **Reconnect**: Automatic reconnection on connection loss
- **Clustering**: Support for NATS clustering
- **Leaf Nodes**: Support for NATS Leaf Node connections

### JetStream (JetStream Functionality)
- **Streams**: JetStream Stream management with auto-creation
- **Publishers**: Publishes messages to streams
- **Consumers**: Pull/Push consumers with various modes
- **Retention Policies**: Limits, Interest, Work Queue
- **Replay**: Message replay functionality
- **Deduplication**: Automatic deduplication

### KV Store (NATS KV Functionality - uses JetStream)
- **Bucket Management**: Create and configure KV buckets
- **Get/Put**: Read and write values
- **Watch**: Monitor changes
- **History**: Access to revision history with configurable limit
- **TTL**: Time To Live support
- **Compression**: Value compression
- **Key Source**: Use `msg.topic` as key source

## Installation

```bash
npm install node-red-contrib-nats-suite
```

Or in the Node-RED Editor:
1. Menu → Manage palette → Install
2. Search for `node-red-contrib-nats-suite`
3. Install

## Node Overview

### Configuration & Management

| Node | Description | Category |
|------|-------------|----------|
| **nats-suite-server** | NATS Server connection configuration (for all other nodes) | Config |
| **nats-suite-server-manager** | Embedded NATS Server with MQTT bridge, JetStream, custom binaries, Leaf Node support | Management |

### Core NATS

| Node | Function | Input | Output |
|------|----------|-------|--------|
| **nats-suite-publish** | Publishes messages to subjects + Request/Reply mode + Headers + Message Expiration (TTL) | `msg.payload`, `msg.topic`, `msg.headers`, `msg.expiration`, `msg._reply` (reply mode) | `msg.payload` (request mode) |
| **nats-suite-subscribe** | Subscribes to messages from subjects | - | `msg.payload`, `msg.topic`, `msg.headers`, `msg._reply` (for request-reply) |

### JetStream

| Node | Function | Input | Output |
|------|----------|-------|--------|
| **nats-suite-stream-publisher** | Publishes to JetStream streams + Stream management (create/update/update-subjects/delete/purge/list/info) | `msg.payload`, Stream name, `msg.operation`, `msg.subjects` | - |
| **nats-suite-stream-consumer** | Consumes from JetStream streams + Consumer management (create/info/delete/list/pause/resume/monitor) + Stream management (info/delete/purge) | `msg.operation`, `msg.consumer` | `msg.payload` (Stream messages or Consumer info) |

### KV Store (Key-Value)

| Node | Function | Input | Output |
|------|----------|-------|--------|
| **nats-suite-kv-get** | Reads values from KV Store + List keys + Watch | Key, `msg.operation` (get/keys/watch) | `msg.payload` (Value/Keys array) |
| **nats-suite-kv-put** | Writes values to KV Store + Delete/Purge keys + Bucket management (create/info/delete/list) | Key, `msg.payload` (Value), `msg.operation` (put/create/update/delete/purge) | Status |

---

## Quick Reference

### Core NATS Workflow
```
[Inject] → [nats-suite-publish] → NATS Server → [nats-suite-subscribe] → [Debug]
```

### Request/Reply Pattern

**Option 1: Using Request Mode (Recommended)**
```
[Inject] → [nats-suite-publish (mode: request)] → NATS Server
                                                         ↓
                                    [nats-suite-subscribe] → [Function] → [nats-suite-publish (mode: reply)]
                                                         ↓
                                    [nats-suite-publish output] → [Debug]
```
- Request node automatically creates an inbox subject
- Reply node uses `msg._reply` (automatically set by subscribe node)
- Response appears at request node output

**Option 2: Manual Pub/Sub Pattern**
```
[Inject] → [nats-suite-publish] → NATS Server → [nats-suite-subscribe] → [Function] → [nats-suite-publish]
```
Note: Include `replyTo` subject in your payload for manual request/reply patterns.

### JetStream Workflow
```
[Inject] → [nats-suite-stream-publisher] → JetStream → [nats-suite-stream-consumer] → [Debug]
```

### KV Store Workflow
```
[Inject] → [nats-suite-kv-put] → KV Store
[Inject] → [nats-suite-kv-get] → KV Store → [Debug]
```

## Usage Examples

### 1. Publish/Subscribe
```
[Inject] → [nats-suite-publish] → [nats-suite-subscribe] → [Debug]
```
- Configure `nats-suite-server` with your NATS server URL
- `nats-suite-publish`: Subject `my.topic`, `msg.payload` = message
- `nats-suite-subscribe`: Subject `my.topic`

### 2. Request/Reply Pattern

**Using Request Mode:**
```
[Inject] → [nats-suite-publish (mode: request, subject: "my.service")]
                                 ↓
                    NATS Server (auto-creates inbox)
                                 ↓
        [nats-suite-subscribe (subject: "my.service")] → [Function Handler]
                                 ↓
        [nats-suite-publish (mode: reply)] → NATS Server
                                 ↓
        [nats-suite-publish output] → [Debug]
```
- Request node: Mode = "request", Subject = "my.service"
- Subscribe node: Subject = "my.service" (must match)
- Function handler: Receives `msg._reply` (automatically set by subscribe node)
- Reply node: Mode = "reply", automatically uses `msg._reply` as subject
- Response appears at request node output with `msg.payload` and `msg.requestTime`

**Note:** For advanced service patterns, you can build custom service handlers using the Request/Reply pattern shown above.

### 3. JetStream Streams
```
[Inject] → [nats-suite-stream-publisher] → [nats-suite-stream-consumer] → [Debug]
```
- Stream is automatically created
- Messages are persistently stored

### 4. KV Store
```
[Inject] → [nats-suite-kv-put] (Key: "mykey", Value: msg.payload)
[Inject] → [nats-suite-kv-get] (Key: "mykey") → [Debug]
```
- Bucket is automatically created
- Values are persistently stored

## NATS Server Setup

### Option 1: External NATS Server
```bash
docker run -p 4222:4222 nats:latest
# or
nats-server
```

### Option 2: NATS Server Manager (in Node-RED)
Use the `nats-suite-server-manager` node to run an embedded NATS server directly in Node-RED:

#### Binary Source Options
| Source | Description |
|--------|-------------|
| **Auto-detect** | Uses `nats-memory-server` npm package (optional dependency), falls back to system PATH |
| **Custom Binary** | Mount your own nats-server binary (e.g., `/data/bin/nats-server-v2.12.2-linux-amd64`) |
| **System PATH** | Uses `nats-server` from system PATH only |

#### Features
- **MQTT Bridge**: Enable MQTT protocol support (port configurable)
- **WebSocket**: Browser-based client connections
- **TLS/SSL**: Encrypted connections with certificate support
- **Authentication**: Token or username/password authentication
- **JetStream**: Persistent streams and KV store
- **Leaf Node Mode**: Connect to remote NATS clusters
- **HTTP Monitoring**: Server stats via HTTP endpoints (`/varz`, `/connz`, `/healthz`, etc.)

#### Pre-built Binaries
This package includes pre-built NATS server binaries in the `bin/` folder:
- `nats-server-v2.12.2-linux-amd64` (x86-64)
- `nats-server-v2.12.2-linux-arm64` (ARM64)

#### Control Commands
```javascript
msg.payload.command = "start"   // Start server
msg.payload.command = "stop"    // Stop server
msg.payload.command = "restart" // Restart server
msg.payload.command = "status"  // Get server status
msg.payload.command = "toggle"  // Toggle start/stop
```

#### Output Payload (on start)
```javascript
{
  type: "embedded",           // or "leaf"
  port: 4223,
  url: "nats://localhost:4223",
  version: "2.12.2",
  binarySource: "custom",     // "auto", "custom", or "system"
  binaryPath: "/data/bin/nats-server-v2.12.2-linux-amd64",
  mqtt: { enabled: true, port: 1884, url: "mqtt://localhost:1884" },
  jetstream: true
}
```

## Requirements

- Node-RED >= 3.0.0
- Node.js >= 14.0.0
- NATS Server (local, remote or Leaf Node)

---

## Advanced Features

### Server Manager Extensions

#### **Custom Binary Support**
- Mount your own `nats-server` binary for specific versions
- Binary source selection: Auto-detect, Custom Binary, System PATH
- Status display shows: `bin:4223 v2.12.2` (source:port version)

#### **MQTT Bridge**
- Enable MQTT protocol on embedded server
- Configurable MQTT port (default: 1883)
- Auto-enables JetStream (required for MQTT)
- Auto-generates server name if not set

#### **WebSocket Support**
- Enable WebSocket for browser-based clients
- Configurable WebSocket port (default: 8080)
- Works with nats.ws JavaScript client

#### **TLS/SSL Encryption**
- Enable TLS for encrypted connections
- Certificate and key file paths
- Optional CA certificate for client verification
- Client certificate verification option

#### **Authentication**
- Token-based authentication
- Username/password authentication
- Simple single-user setup

#### **HTTP Monitoring**
- Enable HTTP monitoring port for server statistics
- Endpoints: `/varz`, `/connz`, `/subsz`, `/jsz`, `/healthz`

### Core NATS Extensions

#### **Message Headers**
- Static headers in node configuration (JSON)
- Dynamic headers via `msg.headers`
- Automatic merging of static + dynamic headers
- Debugging support

#### **Message Expiration (TTL)**
- Configurable message-level TTL (0-86400 seconds)
- Dynamic TTL via `msg.expiration`
- Automatic conversion to nanoseconds for NATS

### JetStream Extensions

#### **Stream Subject Update**
- New operation `update-subjects` for Stream Publisher
- Updates only subjects without changing other stream config
- Input via `msg.subjects` (comma-separated)

#### **Consumer Pause/Resume**
- New operations `pause` and `resume` for Stream Consumer
- Temporarily stops/starts message fetching
- Local state management
- Status display in Node-RED

#### **Consumer Monitoring**
- New operation `monitor` for detailed consumer stats
- Metrics: pending, delivered, ack_pending, redelivered, waiting
- Delivery rate calculation (messages/second)
- Pause status display

### KV Store Extensions

#### **KV Delete Operations** *(already available, documented)*
- `delete` - Soft delete (marked as deleted)
- `purge` - Hard delete (removes all revisions)

#### **KV Keys List** *(already available, documented)*
- New operation `keys` in KV Get node
- Lists all keys of a bucket
- Output: Array with all keys + count

---

## NATS Feature Coverage

This section provides a comprehensive overview of NATS features and their implementation status in node-red-contrib-nats-suite.

### Feature Matrix

#### Core NATS Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Publish/Subscribe | ✅ Complete | `nats-suite-publish`, `nats-suite-subscribe` | Full pub/sub messaging |
| Request/Reply | ✅ Complete | `nats-suite-publish` (mode: request/reply) | Synchronous communication |
| Queue Groups | ✅ Complete | `nats-suite-subscribe` | Load balancing across subscribers |
| Headers | ✅ Complete | `nats-suite-publish` | Static + dynamic headers |
| Wildcards (*, >) | ✅ Complete | `nats-suite-subscribe` | Subject pattern matching |
| TLS/SSL | ✅ Complete | `nats-suite-server` | Encrypted connections |
| Token Auth | ✅ Complete | `nats-suite-server` | Token-based authentication |
| User/Password Auth | ✅ Complete | `nats-suite-server` | Basic authentication |
| JWT Auth | ✅ Complete | `nats-suite-server` | JWT-based authentication |
| NKey Auth | ✅ Complete | `nats-suite-server` | NKey-based authentication |
| Auto Reconnect | ✅ Complete | `nats-suite-server` | Automatic reconnection handling |
| Clustering | ✅ Complete | `nats-suite-server` | Multi-server connections |
| Leaf Nodes | ✅ Complete | `nats-suite-server-manager` | Edge server connections |
| Message TTL | ✅ Complete | `nats-suite-publish` | Message expiration |
| Subject Mapping | ❌ Not Implemented | - | Server-side subject transforms |
| Weighted Mapping | ❌ Not Implemented | - | Canary testing / A-B routing |

#### JetStream Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Stream Create | ✅ Complete | `nats-suite-stream-publisher` | Auto-creation supported |
| Stream Update | ✅ Complete | `nats-suite-stream-publisher` | Update stream configuration |
| Stream Delete | ✅ Complete | `nats-suite-stream-publisher` | Delete streams |
| Stream Purge | ✅ Complete | `nats-suite-stream-publisher` | Purge all messages |
| Stream Info | ✅ Complete | `nats-suite-stream-publisher` | Get stream details |
| Stream List | ✅ Complete | `nats-suite-stream-publisher` | List all streams |
| Update Subjects | ✅ Complete | `nats-suite-stream-publisher` | Update subjects only |
| Publish to Stream | ✅ Complete | `nats-suite-stream-publisher` | Persistent message publishing |
| Pull Consumer | ✅ Complete | `nats-suite-stream-consumer` | On-demand message fetching |
| Push Consumer | ✅ Complete | `nats-suite-stream-consumer` | Automatic message delivery |
| Consumer Create | ✅ Complete | `nats-suite-stream-consumer` | Create new consumers |
| Consumer Delete | ✅ Complete | `nats-suite-stream-consumer` | Delete consumers |
| Consumer Info | ✅ Complete | `nats-suite-stream-consumer` | Get consumer details |
| Consumer List | ✅ Complete | `nats-suite-stream-consumer` | List all consumers |
| Consumer Pause/Resume | ✅ Complete | `nats-suite-stream-consumer` | Pause/resume message fetching |
| Consumer Monitor | ✅ Complete | `nats-suite-stream-consumer` | Detailed stats & metrics |
| Retention: Limits | ✅ Complete | `nats-suite-stream-publisher` | Size/count/age limits |
| Retention: Interest | ✅ Complete | `nats-suite-stream-publisher` | Consumer interest-based |
| Retention: WorkQueue | ✅ Complete | `nats-suite-stream-publisher` | Work queue semantics |
| Message Replay | ✅ Complete | `nats-suite-stream-consumer` | Replay from sequence/time |
| Deduplication | ✅ Complete | `nats-suite-stream-publisher` | Via message ID |
| Stream Mirrors | ❌ Not Implemented | - | Read-only stream replication |
| Stream Sources | ❌ Not Implemented | - | Multi-stream aggregation |
| Stream Republish | ❌ Not Implemented | - | Auto-republish to subjects |
| Subject Transforms | ❌ Not Implemented | - | Stream-level subject mapping |
| Consumer Filter Subject | 🔄 Partial | `nats-suite-stream-consumer` | Basic filtering available |

#### KV Store Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Bucket Create | ✅ Complete | `nats-suite-kv-put` | Auto-creation supported |
| Bucket Delete | ✅ Complete | `nats-suite-kv-put` | Delete buckets |
| Bucket Info | ✅ Complete | `nats-suite-kv-put` | Get bucket details |
| Bucket List | ✅ Complete | `nats-suite-kv-put` | List all buckets |
| Get Value | ✅ Complete | `nats-suite-kv-get` | Read key values |
| Put Value | ✅ Complete | `nats-suite-kv-put` | Write key values |
| Create (if not exists) | ✅ Complete | `nats-suite-kv-put` | Conditional create |
| Update (if exists) | ✅ Complete | `nats-suite-kv-put` | Conditional update |
| Delete Key | ✅ Complete | `nats-suite-kv-put` | Soft delete (tombstone) |
| Purge Key | ✅ Complete | `nats-suite-kv-put` | Hard delete (all revisions) |
| List Keys | ✅ Complete | `nats-suite-kv-get` | List all keys in bucket |
| Watch | ✅ Complete | `nats-suite-kv-get` | Monitor key changes |
| TTL | ✅ Complete | `nats-suite-kv-put` | Time-to-live for entries |
| Compression | ✅ Complete | `nats-suite-kv-put` | Value compression |
| Key History | ✅ Complete | `nats-suite-kv-get` | Access revision history with configurable limit |
| CAS (Compare-And-Swap) | ❌ Not Implemented | - | Atomic conditional updates |

#### Object Store Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Bucket Create | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Bucket Delete | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Bucket Info | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Bucket List | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Put Object | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Get Object | 🔧 In Development | `nats-suite-object-get` | In `nodes-dev/` folder |
| Delete Object | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| List Objects | 🔧 In Development | `nats-suite-object-get` | In `nodes-dev/` folder |
| Object Metadata | 🔧 In Development | `nats-suite-object-put` | In `nodes-dev/` folder |
| Watch | ❌ Not Implemented | - | Monitor object changes |
| Object Links | ❌ Not Implemented | - | Create object references |
| Bucket Links | ❌ Not Implemented | - | Cross-bucket linking |
| Seal Bucket | ❌ Not Implemented | - | Make bucket read-only |

#### Services API Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Create Service | 🔧 In Development | `nats-suite-service` | In `nodes-dev/` folder |
| Add Endpoint | 🔧 In Development | `nats-suite-service` | In `nodes-dev/` folder |
| Start/Stop Service | 🔧 In Development | `nats-suite-service` | In `nodes-dev/` folder |
| Service Discovery | 🔧 In Development | `nats-suite-service` | Ping/Info operations |
| Service Stats | 🔧 In Development | `nats-suite-service` | Metrics collection |
| Health Monitoring | 🔧 In Development | `nats-suite-service` | Connection health checks |
| NATS Stats | 🔧 In Development | `nats-suite-service` | Server/JetStream stats |
| Service Groups | ❌ Not Implemented | - | Endpoint grouping |

#### Server Management Features

| Feature | Status | Node | Notes |
|---------|--------|------|-------|
| Embedded Server | ✅ Complete | `nats-suite-server-manager` | Run NATS in Node-RED |
| Custom Binary | ✅ Complete | `nats-suite-server-manager` | Use specific server version |
| MQTT Bridge | ✅ Complete | `nats-suite-server-manager` | MQTT protocol support |
| WebSocket | ✅ Complete | `nats-suite-server-manager` | Browser client support |
| JetStream Enable | ✅ Complete | `nats-suite-server-manager` | Enable persistence |
| HTTP Monitoring | ✅ Complete | `nats-suite-server-manager` | /varz, /connz, /healthz |
| Leaf Node Mode | ✅ Complete | `nats-suite-server-manager` | Connect to remote clusters |
| Start/Stop/Restart | ✅ Complete | `nats-suite-server-manager` | Server control commands |

### Coverage Summary

| Category | Implemented | In Development | Not Implemented | Coverage |
|----------|-------------|----------------|-----------------|----------|
| **Core NATS** | 15 | 0 | 2 | 88% |
| **JetStream** | 20 | 0 | 5 | 80% |
| **KV Store** | 15 | 0 | 1 | 94% |
| **Object Store** | 0 | 9 | 4 | 0% (prod) / 69% (dev) |
| **Services API** | 0 | 7 | 1 | 0% (prod) / 87% (dev) |
| **Server Management** | 8 | 0 | 0 | 100% |

### Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete - Available in production nodes |
| 🔧 | In Development - Available in `nodes-dev/` folder |
| 🔄 | Partial - Basic functionality available |
| ❌ | Not Implemented - Not yet available |

### Roadmap

Features planned for future releases:

1. **Object Store & Services API** - Move from `nodes-dev/` to production
2. **KV Compare-And-Swap** - Atomic conditional updates
3. **Stream Mirrors** - Read-only stream replication
4. **Stream Sources** - Aggregate from multiple streams
5. **Object Store Watch** - Monitor object changes

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2025-2026 blanpa

## Contributing and forks

Pull requests are welcome, including large ones. If you are planning a bigger
change — a dependency migration, a restructure, new nodes — please open an issue
first. We are happy to discuss it and to land substantial work here; that is
usually less effort than maintaining a parallel package, and it keeps a single
place for users to report bugs.

If you do publish a fork under its own package name, please also rename the
Node-RED node type IDs (for example `myprefix-nats-suite-*`) and use your own palette
category. Node-RED refuses to register a node type that is already claimed, so
identical type IDs make it impossible to install both packages side by side.

## Support

For issues or questions, please create an issue in the repository.

Join our Discord community: [Discord Server](https://discord.gg/gpMpUjd5ph)
