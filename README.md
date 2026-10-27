# node-red-contrib-nats-suite

[![npm version](https://img.shields.io/npm/v/node-red-contrib-nats-suite.svg)](https://www.npmjs.com/package/node-red-contrib-nats-suite)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-nats-suite.svg)](https://www.npmjs.com/package/node-red-contrib-nats-suite)
[![CI](https://github.com/blanpa/node-red-contrib-nats-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/blanpa/node-red-contrib-nats-suite/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-node--red--contrib--nats--suite-red?logo=nodered)](https://flows.nodered.org/node/node-red-contrib-nats-suite)
[![Node.js Version](https://img.shields.io/node/v/node-red-contrib-nats-suite.svg)](https://nodejs.org/)
[![Discord](https://img.shields.io/discord/1234567890?logo=discord&label=Discord)](https://discord.gg/mrebeSaZzx)

A comprehensive Node-RED module for NATS (NATS Messaging System) with support for all major NATS features. This is a **generic NATS implementation** that works with any NATS server - not bound to a specific platform.

## Status & Versioning

- **Current version**: `0.3.0`
- **Stability**: APIs and node options may still change between minor versions.
- **Requires**: Node-RED `>= 3.0.0`, Node.js `>= 18`, NATS Server `>= 2.10` (JetStream enabled for JetStream/KV/Object Store features). Some newer JetStream features need a newer server; see the notes in the feature matrix.
- Automated tests are in `test/` (`npm test` against the Docker stack).

> **Server Manager credential migration:** authentication passwords, tokens, and Leaf Node passwords now use Node-RED's encrypted credential store. After upgrading, re-enter these values in each Server Manager node; old plaintext flow properties are ignored.

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
- **Consumers**: Pull consumers with various delivery/deliver-policy modes
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

In the Node-RED editor, open **Menu → Manage palette → Install**, search for
`node-red-contrib-nats-suite`, and install it.

From the command line, install it in your Node-RED user directory and restart Node-RED:

```bash
cd ~/.node-red
npm install node-red-contrib-nats-suite
```

## Node Overview

### Configuration & Management

| Node                          | Description                                                                          | Category   |
| ----------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| **nats-suite-server**         | NATS Server connection configuration (for all other nodes)                           | Config     |
| **nats-suite-server-pool**    | Get/set the shared connection's known server pool (`getServers`/`setServers`)        | Management |
| **nats-suite-server-manager** | Embedded NATS Server with MQTT bridge, JetStream, custom binaries, Leaf Node support | Management |

### Core NATS

| Node                     | Function                                                                | Input                                                                | Output                                                                      |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **nats-suite-publish**   | Publishes messages to subjects + Request/Reply / Request-Many + Headers | `msg.payload`, `msg.topic`, `msg.headers`, `msg._reply` (reply mode) | `msg.payload` (request / requestMany)                                       |
| **nats-suite-subscribe** | Subscribes to messages from subjects                                    | -                                                                    | `msg.payload`, `msg.topic`, `msg.headers`, `msg._reply` (for request-reply) |

### JetStream

| Node                            | Function                                                                                                                                     | Input                                                       | Output                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| **nats-suite-stream-publisher** | Publishes to JetStream streams + Stream management (create/update/update-subjects/delete/purge/list/info)                                    | `msg.payload`, Stream name, `msg.operation`, `msg.subjects` | -                                                |
| **nats-suite-stream-consumer**  | Consumes from JetStream streams + Consumer management (create/info/delete/list/pause/resume/monitor) + Stream management (info/delete/purge) | `msg.operation`, `msg.consumer`                             | `msg.payload` (Stream messages or Consumer info) |

### KV Store (Key-Value)

| Node                  | Function                                                                                    | Input                                                                        | Output                           |
| --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| **nats-suite-kv-get** | Reads values from KV Store + List keys + Watch                                              | Key, `msg.operation` (get/keys/watch)                                        | `msg.payload` (Value/Keys array) |
| **nats-suite-kv-put** | Writes values to KV Store + Delete/Purge keys + Bucket management (create/info/delete/list) | Key, `msg.payload` (Value), `msg.operation` (put/create/update/delete/purge) | Status                           |

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

| Source            | Description                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto-detect**   | Checks available local/cache locations, then `/usr/local/bin`, `/usr/bin`, and system PATH. This package neither bundles a NATS server binary nor declares a `nats-memory-server` dependency. |
| **Custom Binary** | Mount your own nats-server binary (e.g., `/data/bin/nats-server-v2.14.0-linux-amd64`)                                                                                                         |
| **System PATH**   | Uses `nats-server` from system PATH only                                                                                                                                                      |

#### Features

- **MQTT Bridge**: Enable MQTT protocol support (port configurable)
- **WebSocket**: Browser-based client connections
- **TLS/SSL**: Encrypted connections with certificate support
- **Authentication**: Token or username/password authentication
- **JetStream**: Persistent streams and KV store
- **Leaf Node Mode**: Connect to remote NATS clusters
- **HTTP Monitoring**: Server stats via HTTP endpoints (`/varz`, `/connz`, `/healthz`, etc.)

No NATS server binary is bundled. Install `nats-server` on the host, mount a
custom binary, or provide an externally managed binary in one of the locations
checked by auto-detect.

#### Control Commands

```javascript
msg.payload.command = 'start'; // Start server
msg.payload.command = 'stop'; // Stop server
msg.payload.command = 'restart'; // Restart server
msg.payload.command = 'status'; // Get server status
msg.payload.command = 'toggle'; // Toggle start/stop
```

#### Output Payload (on start)

```javascript
{
  type: "embedded",           // or "leaf"
  port: 4223,
  url: "nats://localhost:4223",
  version: "2.14.0",
  binarySource: "custom",     // "auto", "custom", or "system"
  binaryPath: "/data/bin/nats-server-v2.14.0-linux-amd64",
  mqtt: { enabled: true, port: 1884, url: "mqtt://localhost:1884" },
  jetstream: true
}
```

## Requirements

- Node-RED >= 3.0.0
- Node.js >= 18
- NATS Server >= 2.10 (local, remote or Leaf Node)

---

## Advanced Features

### Server Manager Extensions

#### **Custom Binary Support**

- Mount your own `nats-server` binary for specific versions
- Binary source selection: Auto-detect, Custom Binary, System PATH
- Status display shows: `bin:4223 v2.14.0` (source:port version)

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

#### **KV Delete Operations** _(already available, documented)_

- `delete` - Soft delete (marked as deleted)
- `purge` - Hard delete (removes all revisions)

#### **KV Keys List** _(already available, documented)_

- New operation `keys` in KV Get node
- Lists all keys of a bucket
- Output: Array with all keys + count

---

## NATS Feature Coverage

This section provides a comprehensive overview of NATS features and their implementation status in `node-red-contrib-nats-suite`.

### Feature Matrix

#### Core NATS Features

| Feature                | Status             | Node                                         | Notes                                                                                                                             |
| ---------------------- | ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Publish/Subscribe      | ✅ Complete        | `nats-suite-publish`, `nats-suite-subscribe` | Full pub/sub messaging                                                                                                            |
| Request/Reply          | ✅ Complete        | `nats-suite-publish` (mode: request/reply)   | Synchronous communication                                                                                                         |
| Queue Groups           | ✅ Complete        | `nats-suite-subscribe`                       | Load balancing across subscribers                                                                                                 |
| Headers                | ✅ Complete        | `nats-suite-publish`, `nats-suite-subscribe` | Static + dynamic headers; inbound header serialization                                                                            |
| Wildcards (*, >)       | ✅ Complete        | `nats-suite-subscribe`                       | Subject pattern matching                                                                                                          |
| TLS/SSL                | ✅ Complete        | `nats-suite-server`                          | Encrypted connections                                                                                                             |
| Token Auth             | ✅ Complete        | `nats-suite-server`                          | Token-based authentication                                                                                                        |
| User/Password Auth     | ✅ Complete        | `nats-suite-server`                          | Basic authentication                                                                                                              |
| JWT Auth               | ✅ Complete        | `nats-suite-server`                          | JWT-based authentication                                                                                                          |
| NKey Auth              | ✅ Complete        | `nats-suite-server`                          | NKey-based authentication                                                                                                         |
| Auto Reconnect         | ✅ Complete        | `nats-suite-server`                          | Automatic reconnection handling                                                                                                   |
| Clustering             | ✅ Complete        | `nats-suite-server`                          | Multi-server connections                                                                                                          |
| Leaf Nodes             | ✅ Complete        | `nats-suite-server-manager`                  | Edge server connections                                                                                                           |
| Message Tracing        | 🔄 Partial         | `nats-suite-server`                          | One connection-level switch; covers `nats-suite-publish` and `nats-suite-stream-publisher` today, not yet KV/Object Store/Service |
| Dynamic Server Pool    | ✅ Complete        | `nats-suite-server-pool`                     | Get/set the client's known server list; `reconnectAfterSet` forces an explicit reconnect onto the new pool                        |
| Scatter-Gather Request | ✅ Complete        | `nats-suite-publish`                         | `requestMany` mode; `timer`/`count`/`stall`/`sentinel` strategies, collects all replies into one output message                   |
| Subject Mapping        | ❌ Not Implemented | -                                            | Server-side subject transforms                                                                                                    |
| Weighted Mapping       | ❌ Not Implemented | -                                            | Canary testing / A-B routing                                                                                                      |

#### JetStream Features

| Feature                         | Status      | Node                                                         | Notes                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream Create                   | ✅ Complete | `nats-suite-stream-publisher`                                | Auto-creation supported                                                                                                                                                                                                                                               |
| Stream Update                   | ✅ Complete | `nats-suite-stream-publisher`                                | Update stream configuration                                                                                                                                                                                                                                           |
| Stream Delete                   | ✅ Complete | `nats-suite-stream-publisher`                                | Delete streams                                                                                                                                                                                                                                                        |
| Stream Purge                    | ✅ Complete | `nats-suite-stream-publisher`                                | Purge all messages                                                                                                                                                                                                                                                    |
| Stream Info                     | ✅ Complete | `nats-suite-stream-publisher`                                | Get stream details                                                                                                                                                                                                                                                    |
| Stream List                     | ✅ Complete | `nats-suite-stream-publisher`                                | List all streams                                                                                                                                                                                                                                                      |
| Update Subjects                 | ✅ Complete | `nats-suite-stream-publisher`                                | Update subjects only                                                                                                                                                                                                                                                  |
| Publish to Stream               | ✅ Complete | `nats-suite-stream-publisher`                                | Persistent message publishing                                                                                                                                                                                                                                         |
| Pull Consumer                   | ✅ Complete | `nats-suite-stream-consumer`                                 | On-demand message fetching - the only delivery mode this suite implements (a decorative "push" option existed early on but never did real push delivery; removed)                                                                                                     |
| Consumer Create                 | ✅ Complete | `nats-suite-stream-consumer`                                 | Create new consumers                                                                                                                                                                                                                                                  |
| Consumer Delete                 | ✅ Complete | `nats-suite-stream-consumer`                                 | Delete consumers                                                                                                                                                                                                                                                      |
| Consumer Info                   | ✅ Complete | `nats-suite-stream-consumer`                                 | Get consumer details                                                                                                                                                                                                                                                  |
| Consumer List                   | ✅ Complete | `nats-suite-stream-consumer`                                 | List all consumers                                                                                                                                                                                                                                                    |
| Consumer Pause/Resume           | ✅ Complete | `nats-suite-stream-consumer`                                 | Pause/resume message fetching                                                                                                                                                                                                                                         |
| Consumer Monitor                | ✅ Complete | `nats-suite-stream-consumer`                                 | Detailed stats & metrics                                                                                                                                                                                                                                              |
| Retention: Limits               | ✅ Complete | `nats-suite-stream-publisher`                                | Size/count/age limits                                                                                                                                                                                                                                                 |
| Retention: Interest             | ✅ Complete | `nats-suite-stream-publisher`                                | Consumer interest-based                                                                                                                                                                                                                                               |
| Retention: WorkQueue            | ✅ Complete | `nats-suite-stream-publisher`                                | Work queue semantics                                                                                                                                                                                                                                                  |
| Message Replay                  | ✅ Complete | `nats-suite-stream-consumer`                                 | Replay from sequence/time                                                                                                                                                                                                                                             |
| Direct Message Get              | ✅ Complete | `nats-suite-stream-publisher` / `nats-suite-stream-consumer` | `allow_direct` is wired on stream create/update; `nats-suite-stream-consumer`'s `get-message` operation reads by sequence or last-by-subject via the faster `jsm.direct.getMessage()` (when enabled) or the always-available manager-level `jsm.streams.getMessage()` |
| Deduplication                   | ✅ Complete | `nats-suite-stream-publisher`                                | Via message ID                                                                                                                                                                                                                                                        |
| Message Scheduling              | ✅ Complete | `nats-suite-stream-publisher`                                | Editor fields for one-time (ISO date) and recurring (cron) delayed delivery on the supported nats-server ≥2.14 floor; `every`/`predefined`/`rollup`/`source` reachable via `msg.schedule` passthrough, which always overrides the editor fields                       |
| Stream Mirrors                  | 🔄 Partial  | `nats-suite-stream-publisher`                                | No dedicated editor fields yet; reachable today via a native `msg.payload` config override on create/update                                                                                                                                                           |
| Stream Sources                  | 🔄 Partial  | `nats-suite-stream-publisher`                                | Same as Mirrors - no editor UI, works via raw `msg.payload`                                                                                                                                                                                                           |
| Stream Republish                | 🔄 Partial  | `nats-suite-stream-publisher`                                | Same as Mirrors - no editor UI, works via raw `msg.payload`                                                                                                                                                                                                           |
| Subject Transforms              | 🔄 Partial  | `nats-suite-stream-publisher`                                | Same as Mirrors - no editor UI, works via raw `msg.payload`                                                                                                                                                                                                           |
| Atomic Batch Publish            | ✅ Complete | `nats-suite-stream-publisher`                                | `operation: batch-publish`, one `msg.batch` array staged atomically via `startBatch()`/`add()`/`commit()`; requires the stream's `allowAtomic` flag                                                                                                                   |
| Consumer Filter Subject         | 🔄 Partial  | `nats-suite-stream-consumer`                                 | Basic filtering available                                                                                                                                                                                                                                             |
| Optimistic Concurrency          | ✅ Complete | `nats-suite-stream-publisher`                                | Editor fields for expected last-msg-ID/last-sequence; other `StreamExpectations` fields stay `msg.options.expect`-passthrough-only                                                                                                                                    |
| Persist Mode                    | ✅ Complete | `nats-suite-stream-publisher`                                | `default`/`async` write-durability mode, fixed at stream creation - the server rejects any attempt to change it later                                                                                                                                                 |
| Priority Groups & Pull Overflow | ✅ Complete | `nats-suite-stream-consumer`                                 | Editor fields for `priority_groups`/`priority_policy`/`priority_timeout` (consumer create) and `group`/`min_pending`/`min_ack_pending`/`priority` (per-fetch defaults)                                                                                                |
| Pedantic Consumer Creation      | ✅ Complete | `nats-suite-stream-consumer`                                 | Server-side strict validation at consumer creation time                                                                                                                                                                                                               |

#### KV Store Features

| Feature                | Status      | Node                | Notes                                                                                              |
| ---------------------- | ----------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Bucket Create          | ✅ Complete | `nats-suite-kv-put` | Auto-creation supported                                                                            |
| Bucket Delete          | ✅ Complete | `nats-suite-kv-put` | Delete buckets                                                                                     |
| Bucket Info            | ✅ Complete | `nats-suite-kv-put` | Get bucket details                                                                                 |
| Bucket List            | ✅ Complete | `nats-suite-kv-put` | List all buckets                                                                                   |
| Get Value              | ✅ Complete | `nats-suite-kv-get` | Read key values                                                                                    |
| Put Value              | ✅ Complete | `nats-suite-kv-put` | Write key values                                                                                   |
| Create (if not exists) | ✅ Complete | `nats-suite-kv-put` | Conditional create                                                                                 |
| Update (if exists)     | ✅ Complete | `nats-suite-kv-put` | Conditional update                                                                                 |
| Delete Key             | ✅ Complete | `nats-suite-kv-put` | Soft delete (tombstone)                                                                            |
| Purge Key              | ✅ Complete | `nats-suite-kv-put` | Hard delete (all revisions)                                                                        |
| List Keys              | ✅ Complete | `nats-suite-kv-get` | List all keys in bucket                                                                            |
| Watch                  | ✅ Complete | `nats-suite-kv-get` | Monitor key changes                                                                                |
| TTL                    | ✅ Complete | `nats-suite-kv-put` | Time-to-live for entries                                                                           |
| Compression            | ✅ Complete | `nats-suite-kv-put` | Value compression                                                                                  |
| Key History            | ✅ Complete | `nats-suite-kv-get` | Access revision history with configurable limit                                                    |
| CAS (Compare-And-Swap) | ✅ Complete | `nats-suite-kv-put` | `update` operation is revision-checked (`kv.update(key, value, revision)`)                         |
| Marker TTL             | ✅ Complete | `nats-suite-kv-put` | Per-call marker TTL on `create` (Go duration string), gated by a bucket-level enable flag          |
| Advanced Watch Options | ✅ Complete | `nats-suite-kv-get` | `headers_only`, `include` (last value/history/updates-only), `resumeFromRevision`, multi-key watch |

#### Object Store Features

| Feature         | Status      | Node                    | Notes                                                                                        |
| --------------- | ----------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| Bucket Create   | ✅ Complete | `nats-suite-object-put` | Configurable storage, limits, replicas, and compression                                      |
| Bucket Delete   | ✅ Complete | `nats-suite-object-put` | Delete buckets                                                                               |
| Bucket Info     | ✅ Complete | `nats-suite-object-put` | Get bucket details                                                                           |
| Bucket List     | ✅ Complete | `nats-suite-object-put` | List all buckets                                                                             |
| Put Object      | ✅ Complete | `nats-suite-object-put` | Upload messages, buffers, or files                                                           |
| Get Object      | ✅ Complete | `nats-suite-object-get` | Download object data                                                                         |
| Delete Object   | ✅ Complete | `nats-suite-object-put` | Delete objects                                                                               |
| List Objects    | ✅ Complete | `nats-suite-object-get` | List bucket contents                                                                         |
| Object Metadata | ✅ Complete | `nats-suite-object-put` | Content type and NATS headers                                                                |
| Watch           | ✅ Complete | `nats-suite-object-get` | Monitor object changes (`operation: watch`), with `watchIgnoreDeletes`/`watchIncludeHistory` |
| Object Links    | ✅ Complete | `nats-suite-object-put` | `operation: link` with `targetName` (same-store)                                             |
| Bucket Links    | ✅ Complete | `nats-suite-object-put` | `operation: link` with `targetBucket` (cross-store)                                          |
| Seal Bucket     | ✅ Complete | `nats-suite-object-put` | `operation: seal` - irreversible, rejects further writes                                     |

#### Services API Features

| Feature            | Status      | Node                 | Notes                                                                                              |
| ------------------ | ----------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| Create Service     | ✅ Complete | `nats-suite-service` | Register a named service                                                                           |
| Add Endpoint       | ✅ Complete | `nats-suite-service` | Configurable endpoint subject                                                                      |
| Start/Stop Service | ✅ Complete | `nats-suite-service` | Runtime lifecycle operations                                                                       |
| Service Discovery  | ✅ Complete | `nats-suite-service` | Ping/Info operations                                                                               |
| Service Stats      | ✅ Complete | `nats-suite-service` | Metrics collection                                                                                 |
| Health Monitoring  | ✅ Complete | `nats-suite-service` | Connection health checks                                                                           |
| NATS Stats         | ✅ Complete | `nats-suite-service` | Server/JetStream stats                                                                             |
| Service Groups     | ✅ Complete | `nats-suite-service` | `groupSubject`/`groupQueue` namespace endpoints under a subject prefix via `addGroup()`            |
| Reset Stats        | ✅ Complete | `nats-suite-service` | `operation: reset` zeroes both the library's real per-endpoint stats and the node's local counters |

#### Server Management Features

| Feature            | Status      | Node                        | Notes                       |
| ------------------ | ----------- | --------------------------- | --------------------------- |
| Embedded Server    | ✅ Complete | `nats-suite-server-manager` | Run NATS in Node-RED        |
| Custom Binary      | ✅ Complete | `nats-suite-server-manager` | Use specific server version |
| MQTT Bridge        | ✅ Complete | `nats-suite-server-manager` | MQTT protocol support       |
| WebSocket          | ✅ Complete | `nats-suite-server-manager` | Browser client support      |
| JetStream Enable   | ✅ Complete | `nats-suite-server-manager` | Enable persistence          |
| HTTP Monitoring    | ✅ Complete | `nats-suite-server-manager` | /varz, /connz, /healthz     |
| Leaf Node Mode     | ✅ Complete | `nats-suite-server-manager` | Connect to remote clusters  |
| Start/Stop/Restart | ✅ Complete | `nats-suite-server-manager` | Server control commands     |

### Coverage Summary

| Category              | Implemented | In Development | Not Implemented | Coverage |
| --------------------- | ----------- | -------------- | --------------- | -------- |
| **Core NATS**         | 16          | 1              | 2               | 84%      |
| **JetStream**         | 24          | 5              | 0               | 83%      |
| **KV Store**          | 18          | 0              | 0               | 100%     |
| **Object Store**      | 13          | 0              | 0               | 100%     |
| **Services API**      | 9           | 0              | 0               | 100%     |
| **Server Management** | 8           | 0              | 0               | 100%     |

### Legend

| Symbol | Meaning                                  |
| ------ | ---------------------------------------- |
| ✅     | Complete - Available in production nodes |
| 🔄     | Partial - Basic functionality available  |
| ❌     | Not Implemented - Not yet available      |

### Out of scope

Stream mirrors, sources, republish, and subject transforms have no dedicated editor fields; they remain reachable via a raw `msg.payload` override on stream create/update.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2025-2026 blanpa

## Credits

The `@nats-io` v3 migration, the native-reconnect rework, the real-stack test
suite, the promotion of the Object Store and Service nodes and many of the
JetStream, KV and Object Store features in 0.3.0 were developed by
[Paul Deng](https://github.com/pauldeng) in his fork and merged back here.
See [NOTICE](NOTICE) for the attribution details.

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
