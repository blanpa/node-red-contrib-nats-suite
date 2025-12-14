# node-red-contrib-nats-suite

[![npm version](https://img.shields.io/npm/v/node-red-contrib-nats-suite.svg)](https://www.npmjs.com/package/node-red-contrib-nats-suite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange.svg)]()
[![Discord](https://img.shields.io/discord/1234567890?logo=discord&label=Discord)](https://discord.gg/77RsM7dV)

A comprehensive Node-RED module for NATS (NATS Messaging System) with support for all major NATS features. This is a **generic NATS implementation** that works with any NATS server - not bound to a specific platform.

## Status & Versioning

- **Current version**: `0.0.1` (initial preview release)
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
- **History**: Access to history
- **TTL**: Time To Live support
- **Compression**: Value compression

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
| **Auto-detect** | Uses `nats-memory-server` npm package, falls back to system PATH |
| **Custom Binary** | Mount your own nats-server binary (e.g., `/data/bin/nats-server-v2.12.2-linux-amd64`) |
| **System PATH** | Uses `nats-server` from system PATH only |

#### Features
- **MQTT Bridge**: Enable MQTT protocol support (port configurable)
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

## License

MIT License - see LICENSE file for details.

## Author

blanpa

## Support

For issues or questions, please create an issue in the repository.

Join our Discord community: [Discord Server](https://discord.gg/77RsM7dV)
