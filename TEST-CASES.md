# NATS Suite - Test Cases & Use Cases

Complete test suite for all nodes and features of the NATS Suite.

---

## Table of Contents

1. [Setup & Preparation](#setup--preparation)
2. [Core NATS Tests](#core-nats-tests)
3. [JetStream Tests](#jetstream-tests)
4. [KV Store Tests](#kv-store-tests)
5. [Object Store Tests](#object-store-tests)
6. [Service API Tests](#service-api-tests)
7. [New Features Tests](#new-features-tests)

---

## Setup & Preparation

### NATS Server start

**Option 1: Docker**
```bash
docker run -p 4222:4222 -p 8222:8222 nats:latest -js
```

**Option 2: Local Installation**
```bash
nats-server -js
```

**Option 3: Server Manager Node use**
- Node: `nats-suite-server-manager`
- Config: Mode = "Embedded" or "Process"
- Inject: `msg.payload.command = "start"`

---

## Core NATS Tests

### 1. NATS Server Config Node

**Test: Server Connection**

Flow:
```
[inject] → [nats-suite-service (mode: health)] → [debug]
```

**Config:**
- Server Node: `nats://localhost:4222`
- Mode: `health`
- No Authentication

**Expected Output:**
```json
{
  "payload": {
    "status": "healthy",
    "server": "nats://localhost:4222",
    "latency": 5
  }
}
```

---

### 2. Publish/Subscribe - Basic

**Test: Simple Pub/Sub**

Flow:
```
[inject] → [nats-suite-publish] → (NATS) → [nats-suite-subscribe] → [debug]
```

**Publish Config:**
- Server: nats-server
- Dataformat: `specific_topic`
- Datapoint/Subject: `test.basic`

**Subscribe Config:**
- Server: nats-server
- Dataformat: `specific_subject`
- Datapoint/Subject: `test.basic`

**Inject:**
```json
{
  "payload": "Hello NATS!"
}
```

**Expected Output:**
```json
{
  "payload": "Hello NATS!",
  "topic": "test.basic"
}
```

---

### 3. Publish - Message Headers

**Test: Headers send**

Flow:
```
[inject] → [nats-suite-publish] → (NATS) → [nats-suite-subscribe] → [debug]
```

**Publish Config:**
- Server: nats-server
- Dataformat: `specific_topic`
- Subject: `test.headers`
- Enable Headers: TRUE
- Static Headers: `{"X-App": "Node-RED", "X-Version": "1.0"}`
- Debug Logging: TRUE

**Inject:**
```json
{
  "payload": {
    "message": "Test with headers"
  },
  "headers": {
    "X-User": "TestUser",
    "X-Request-ID": "12345"
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "message": "Test with headers"
  },
  "topic": "test.headers",
  "headers": {
    "X-App": "Node-RED",
    "X-Version": "1.0",
    "X-User": "TestUser",
    "X-Request-ID": "12345"
  }
}
```

**Expected Debug Log:**
```
[NATS-SUITE PUBLISH] Publishing with headers: {"X-App":"Node-RED","X-Version":"1.0","X-User":"TestUser","X-Request-ID":"12345"}
```

---

### 4. Publish - Message Expiration (TTL)

**Test: Message TTL**

Flow:
```
[inject] → [nats-suite-publish] → [debug]
```

**Publish Config:**
- Server: nats-server
- Dataformat: `specific_topic`
- Subject: `test.expiration`
- Enable Message Expiration: TRUE
- Expiration Time: `5` (seconds)
- Debug Logging: TRUE

**Test A - Static TTL:**
```json
{
  "payload": "This message expires in 5 seconds"
}
```

**Test B - Dynamic TTL:**
```json
{
  "payload": "This message expires in 10 seconds",
  "expiration": 10
}
```

**Expected Debug Log:**
```
[NATS-SUITE PUBLISH] Message expiration: 5s
[NATS-SUITE PUBLISH] Message expiration (from msg): 10s
```

**Note:** TTL only works with JetStream Streams, not with Core NATS!

---

### 5. Request/Reply Pattern (using Publish/Subscribe)

**Test: Request-Reply with Pub/Sub**

Flow 1 (Client):
```
[inject] → [function: add replyTo] → [nats-suite-publish] → ...
[nats-suite-subscribe: reply subject] → [debug]
```

Flow 2 (Server):
```
[nats-suite-subscribe] → [function: process & extract replyTo] → [nats-suite-publish]
```

**Client Function (Add replyTo):**
```javascript
// Add replyTo to payload (only payload is sent over NATS)
msg.payload = {
  message: msg.payload.message,
  replyTo: 'demo.reply.inbox'
};
msg.topic = 'service.echo';
return msg;
```

**Publish Config (Client):**
- Server: nats-server
- Subject: `service.echo`

**Subscribe Config (Server):**
- Server: nats-server
- Subject: `service.echo`

**Function Node (Echo Server):**
```javascript
// Extract replyTo from payload and echo back
const replyTo = msg.payload.replyTo;
if (!replyTo) {
  node.warn('No replyTo in payload!');
  return null;
}

msg.topic = replyTo;
msg.payload = {
  echo: msg.payload.message,
  timestamp: Date.now()
};
return msg;
```

**Publish Config (Reply):**
- Server: nats-server
- Subject: (from msg.topic)

**Subscribe Config (Client Reply):**
- Server: nats-server
- Subject: `demo.reply.inbox`

**Inject (Client Request):**
```json
{
  "payload": {
    "message": "Echo this!"
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "echo": "Echo this!",
    "timestamp": 1234567890
  }
}
```

---

### 6. Health & Stats (via nats-suite-service)

**Test A: Health Check**

Flow:
```
[inject] → [nats-suite-service (mode: health)] → [debug]
```

**Config:**
- Server: nats-server
- Mode: `health`
- Enable Connectivity Tests: TRUE

**Inject:**
```json
{}
```

**Expected Output:**
```json
{
  "payload": {
    "status": "healthy",
    "connected": true,
    "server": "localhost:4222",
    "latency": 5,
    "checks": {
      "connectivity": "passed"
    }
  }
}
```

**Test B: NATS Stats**

Flow:
```
[inject] → [nats-suite-service (mode: nats-stats)] → [debug]
```

**Config:**
- Server: nats-server
- Mode: `nats-stats`
- Stats Type: `all`

**Expected Output:**
```json
{
  "payload": {
    "server": {
      "serverId": "...",
      "version": "2.9.x"
    },
    "jetstream": {
      "memory": 0,
      "storage": 0
    },
    "connection": {
      "inMsgs": 1234,
      "outMsgs": 5678,
      "inBytes": 123456,
      "outBytes": 567890
    }
  }
}
```

---

## JetStream Tests

### 7. Stream Publisher - Create Stream

**Test: Stream create**

Flow:
```
[inject] → [nats-suite-stream-publisher] → [debug]
```

**Config:**
- Server: nats-server
- Operation: `create`
- Stream Name: `test-stream`
- Subject Pattern: `test.>`

**Inject:**
```json
{
  "operation": "create",
  "stream": "test-stream",
  "subjects": "test.>, sensor.>",
  "retention": "limits",
  "maxMessages": 1000,
  "maxAge": "1h"
}
```

**Expected Output:**
```json
{
  "payload": {
    "operation": "create",
    "stream": "test-stream",
    "success": true
  }
}
```

---

### 8. Stream Publisher - Update Subjects

**Test: Only Subjects update**

Flow:
```
[inject] → [nats-suite-stream-publisher] → [debug]
```

**Config:**
- Operation: `update-subjects`
- Stream Name: `test-stream`

**Inject:**
```json
{
  "operation": "update-subjects",
  "stream": "test-stream",
  "subjects": "test.>, sensor.>, data.>"
}
```

**Expected Output:**
```json
{
  "payload": {
    "operation": "update-subjects",
    "stream": "test-stream",
    "subjects": ["test.>", "sensor.>", "data.>"],
    "success": true
  }
}
```

---

### 9. Stream Publisher - Publish Messages

**Test: Messages in Stream publish**

Flow:
```
[inject] → [nats-suite-stream-publisher] → [debug]
```

**Config:**
- Operation: `publish`
- Stream Name: `test-stream`
- Default Subject: `test.data`

**Inject:**
```json
{
  "payload": {
    "temperature": 23.5,
    "humidity": 45,
    "timestamp": "2025-11-17T10:00:00Z"
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "seq": 1,
    "duplicate": false
  }
}
```

---

### 10. Stream Consumer - Consume Messages

**Test: Messages from Stream consume**

Flow:
```
[inject] → [nats-suite-stream-consumer] → [debug]
```

**Config:**
- Operation: `consume`
- Stream Name: `test-stream`
- Consumer Name: `test-consumer`
- Consumer Type: `pull`
- Ack Policy: `explicit`
- Deliver Policy: `all`
- Batch Size: `10`

**Inject (Trigger):**
```json
{
  "batchSize": 5
}
```

**Expected Output:**
```json
{
  "payload": {
    "temperature": 23.5,
    "humidity": 45
  },
  "stream": "test-stream",
  "consumer": "test-consumer",
  "subject": "test.data",
  "sequence": 1,
  "timestamp": 1234567890,
  "pending": 9,
  "ack": [Function],
  "nak": [Function]
}
```

**Function Node (ACK Message):**
```javascript
// Acknowledge message
if (msg.ack) {
  msg.ack();
  node.log('Message acknowledged');
}
return msg;
```

---

### 11. Consumer - Pause/Resume

**Test A: Consumer pause**

Flow:
```
[inject] → [nats-suite-stream-consumer] → [debug]
```

**Config:**
- Operation: `pause`
- Stream Name: `test-stream`
- Consumer Name: `test-consumer`

**Inject:**
```json
{
  "operation": "pause"
}
```

**Expected Output:**
```json
{
  "payload": {
    "operation": "pause",
    "consumer": "test-consumer",
    "success": true,
    "paused": true
  }
}
```

**Test B: Consumer resume**

**Inject:**
```json
{
  "operation": "resume"
}
```

**Expected Output:**
```json
{
  "payload": {
    "operation": "resume",
    "consumer": "test-consumer",
    "success": true,
    "paused": false
  }
}
```

**Test C: Pause during Consumption**

Setup:
1. Stream with 100 messages
2. Consumer with Batch Size 100 start
3. After 2 seconds: Pause send
4. Consumer should stop (in the middle of batch)

---

### 12. Consumer - Monitor Stats

**Test: Detailed Consumer Stats**

Flow:
```
[inject] → [nats-suite-stream-consumer] → [debug]
```

**Config:**
- Operation: `monitor`
- Stream Name: `test-stream`
- Consumer Name: `test-consumer`

**Inject:**
```json
{
  "operation": "monitor"
}
```

**Expected Output:**
```json
{
  "payload": {
    "operation": "monitor",
    "stream": "test-stream",
    "consumer": "test-consumer",
    "stats": {
      "pending": 10,
      "delivered": 50,
      "ack_pending": 2,
      "redelivered": 1,
      "waiting": 0,
      "delivery_rate": 5.25,
      "paused": false
    },
    "config": { /* Consumer Config */ },
    "timestamp": 1234567890
  }
}
```

**Monitoring Loop (Function Node):**
```javascript
// Monitoring all 5 seconds
const interval = context.get('monitorInterval');
if (!interval) {
  const id = setInterval(() => {
    node.send({ operation: 'monitor' });
  }, 5000);
  context.set('monitorInterval', id);
}
return null;
```

---

## KV Store Tests

### 13. KV Put - Create/Update Keys

**Test: Key-Value store**

Flow:
```
[inject] → [nats-suite-kv-put] → [debug]
```

**Config:**
- Server: nats-server
- Bucket: `config-store`
- Operation: `put`
- Key From: `msg.key`
- Value From: `payload`
- Stringify JSON: TRUE

**Inject:**
```json
{
  "key": "app.config.timeout",
  "payload": {
    "value": 5000,
    "unit": "ms"
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "value": 5000,
    "unit": "ms"
  },
  "key": "app.config.timeout",
  "bucket": "config-store",
  "revision": 1,
  "operation": "PUT"
}
```

---

### 14. KV Delete/Purge Keys

**Test A: Soft Delete**

Flow:
```
[inject] → [nats-suite-kv-put] → [debug]
```

**Config:**
- Operation: `delete`
- Bucket: `config-store`
- Key From: `msg.key`

**Inject:**
```json
{
  "key": "app.config.timeout"
}
```

**Expected Output:**
```json
{
  "payload": {},
  "key": "app.config.timeout",
  "bucket": "config-store",
  "operation": "DEL",
  "_deleted": true
}
```

**Test B: Hard Delete (Purge)**

**Config:**
- Operation: `purge`

**Inject:**
```json
{
  "key": "app.config.timeout"
}
```

**Expected Output:**
```json
{
  "payload": {},
  "key": "app.config.timeout",
  "bucket": "config-store",
  "operation": "PURGE",
  "_purged": true
}
```

---

### 15. KV Get - Read Keys

**Test: Key read**

Flow:
```
[inject] → [nats-suite-kv-get] → [debug]
```

**Config:**
- Mode: `get`
- Bucket: `config-store`
- Key From: `msg.key`
- Parse JSON: TRUE

**Inject:**
```json
{
  "key": "app.config.timeout"
}
```

**Expected Output:**
```json
{
  "payload": {
    "value": 5000,
    "unit": "ms"
  },
  "key": "app.config.timeout",
  "bucket": "config-store",
  "revision": 1,
  "created": "2025-11-17T10:00:00.000Z"
}
```

---

### 16. KV List Keys

**Test: All Keys list**

Flow:
```
[inject] → [nats-suite-kv-get] → [debug]
```

**Config:**
- Mode: `keys`
- Bucket: `config-store`

**Inject:**
```json
{}
```

**Expected Output:**
```json
{
  "payload": [
    "app.config.timeout",
    "app.config.retries",
    "app.config.debug",
    "user.preferences.theme"
  ],
  "operation": "LIST",
  "bucket": "config-store",
  "count": 4
}
```

---

### 17. KV Watch Keys

**Test: Key changes monitor**

Flow:
```
[nats-suite-kv-get] → [debug]
```

**Config:**
- Mode: `watch`
- Bucket: `config-store`
- Watch Pattern: `app.config.*` (or empty for all)
- Ignore Deletes: FALSE

**No Inject needed - runs automatically**

**Expected Output (on change):**
```json
{
  "payload": {
    "value": 10000,
    "unit": "ms"
  },
  "key": "app.config.timeout",
  "operation": "PUT",
  "revision": 2,
  "created": "2025-11-17T10:05:00.000Z",
  "bucket": "config-store",
  "_watchEvent": true
}
```

---

## Object Store Tests

### 18. Object Put - Upload

**Test: Object upload**

Flow:
```
[inject] → [nats-suite-object-put] → [debug]
```

**Config:**
- Server: nats-server
- Bucket: `files`
- Object Name From: `msg.filename`

**Inject:**
```json
{
  "filename": "config.json",
  "payload": {
    "app": "MyApp",
    "version": "1.0.0",
    "settings": {
      "theme": "dark",
      "language": "de"
    }
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "name": "config.json",
    "size": 123,
    "chunks": 1
  }
}
```

---

### 19. Object Get - Download

**Test: Object download**

Flow:
```
[inject] → [nats-suite-object-get] → [debug]
```

**Config:**
- Bucket: `files`
- Object Name From: `msg.filename`

**Inject:**
```json
{
  "filename": "config.json"
}
```

**Expected Output:**
```json
{
  "payload": {
    "app": "MyApp",
    "version": "1.0.0",
    "settings": {
      "theme": "dark",
      "language": "de"
    }
  },
  "filename": "config.json",
  "metadata": {
    "size": 123,
    "chunks": 1
  }
}
```

---

### 20. Object List

**Test: All Objects list**

Flow:
```
[inject] → [nats-suite-object-get] → [debug]
```

**Config:**
- Operation: `list`
- Bucket: `files`

**Inject:**
```json
{
  "operation": "list"
}
```

**Expected Output:**
```json
{
  "payload": [
    {
      "name": "config.json",
      "size": 123,
      "modified": "2025-11-17T10:00:00.000Z"
    },
    {
      "name": "data.csv",
      "size": 45678,
      "modified": "2025-11-17T09:30:00.000Z"
    }
  ],
  "count": 2
}
```

---

## Service API Tests

### 21. Service - Discovery

**Test: Services discover**

Flow:
```
[inject] → [nats-suite-service] → [debug]
```

**Config:**
- Mode: `discover`
- Service Name Filter: `*` (all services)

**Inject:**
```json
{
  "operation": "discover"
}
```

**Expected Output:**
```json
{
  "payload": [
    {
      "name": "auth-service",
      "id": "abc123",
      "version": "1.0.0",
      "type": "service",
      "metadata": {
        "region": "eu",
        "env": "prod"
      }
    },
    {
      "name": "data-processor",
      "id": "def456",
      "version": "2.1.0",
      "type": "service",
      "metadata": {}
    }
  ],
  "operation": "discover",
  "count": 2
}
```

---

### 22. Service - Stats

**Test: Service Stats retrieve**

Flow:
```
[inject] → [nats-suite-service] → [debug]
```

**Config:**
- Mode: `stats`
- Service Name: `auth-service` (or `*`)

**Inject:**
```json
{
  "operation": "stats"
}
```

**Expected Output:**
```json
{
  "payload": [
    {
      "name": "auth-service",
      "id": "abc123",
      "version": "1.0.0",
      "endpoints": ["login", "logout", "validate"],
      "stats": {
        "requests": 1234,
        "errors": 5,
        "processing_time": "15ms"
      }
    }
  ],
  "operation": "stats",
  "count": 1
}
```

---

### 23. Service - Ping

**Test: Service check availability**

Flow:
```
[inject] → [nats-suite-service] → [debug]
```

**Config:**
- Mode: `ping`
- Service Name: `auth-service`

**Inject:**
```json
{
  "operation": "ping",
  "serviceName": "auth-service"
}
```

**Expected Output:**
```json
{
  "payload": [
    {
      "name": "auth-service",
      "id": "abc123-instance-1",
      "version": "1.0.0"
    },
    {
      "name": "auth-service",
      "id": "abc123-instance-2",
      "version": "1.0.0"
    }
  ],
  "operation": "ping",
  "count": 2
}
```

---

### 24. Service - Run Service Endpoint

**Test: Echo Service create**

Flow 1 (Service):
```
[nats-suite-service] → [function] → (response)
```

Flow 2 (Client - using Pub/Sub):
```
[inject] → [function: add replyTo] → [nats-suite-publish] → ...
[nats-suite-subscribe: reply subject] → [debug]
```

**Service Config:**
- Mode: `service`
- Service Name: `echo-service`
- Version: `1.0.0`
- Description: `Simple Echo Service`
- Endpoint: `process`
- Endpoint Subject: `echo.process` (optional)
- Queue Group: `echo-service`
- Auto-Start: TRUE
- Debug: TRUE

**Function Node (Echo Handler):**
```javascript
// Process request and respond
const request = msg.payload;

// Validate request
if (!request || !request.message) {
  msg.respondError('Missing message field', 'VALIDATION_ERROR');
  return null;
}

// Process and respond
const response = {
  echo: request.message,
  timestamp: Date.now(),
  service: 'echo-service',
  version: '1.0.0'
};

msg.respond(response);

// Don't send to output
return null;
```

**Client Function (Add replyTo):**
```javascript
msg.payload = {
  message: msg.payload.message,
  replyTo: 'echo.reply.inbox'
};
msg.topic = 'echo.process';
return msg;
```

**Client Publish Config:**
- Subject: `echo.process`

**Client Subscribe Config (for reply):**
- Subject: `echo.reply.inbox`

**Inject (Client):**
```json
{
  "payload": {
    "message": "Hello from client!"
  }
}
```

**Expected Output (Client):**
```json
{
  "payload": {
    "echo": "Hello from client!",
    "timestamp": 1234567890,
    "service": "echo-service",
    "version": "1.0.0"
  }
}
```

---

### 25. Service - Calculator Service (Complex)

**Test: Calculator Service with multiple Endpoints**

Flow (Service):
```
[nats-suite-service] → [switch] → [function: add/sub/mul/div] → (response)
```

**Service Config:**
- Service Name: `calculator`
- Endpoint: `calculate`
- Subject: `calc.calculate`

**Switch Node (Operation Router):**
```javascript
// Route by operation
const op = msg.payload.operation;
return [
  op === 'add' ? msg : null,
  op === 'sub' ? msg : null,
  op === 'mul' ? msg : null,
  op === 'div' ? msg : null
];
```

**Function Node (Add):**
```javascript
const { a, b } = msg.payload;
if (typeof a !== 'number' || typeof b !== 'number') {
  msg.respondError('Invalid numbers', 'VALIDATION_ERROR');
  return null;
}
msg.respond({ result: a + b, operation: 'add' });
return null;
```

**Client Inject:**
```json
{
  "payload": {
    "operation": "add",
    "a": 10,
    "b": 5
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "result": 15,
    "operation": "add"
  },
  "status": "success"
}
```

---

## Complete Integration Tests

### 26. Full Stack Test - IoT Sensor Pipeline

**Scenario:** Sensor Data → Stream → Processing → KV Store → Monitoring

**Flow:**
```
[inject: Sensor] 
  → [nats-suite-stream-publisher] 
  → (JetStream) 
  → [nats-suite-stream-consumer] 
  → [function: Process] 
  → [nats-suite-kv-put] 
  → [nats-suite-service: alert-check] 
  → [debug]
```

**Setup:**

1. **Stream Publisher Config:**
   - Stream: `sensor-data`
   - Subjects: `sensor.>`
   - Subject: `sensor.temperature`

2. **Stream Consumer Config:**
   - Stream: `sensor-data`
   - Consumer: `processor`
   - Batch Size: 10

3. **Processing Function:**
```javascript
// Calculate average and store in KV
const data = msg.payload;
const avg = (data.values || []).reduce((a,b) => a+b, 0) / data.values.length;

msg.key = `sensor.${data.sensorId}.avg`;
msg.payload = {
  average: avg,
  timestamp: Date.now(),
  count: data.values.length
};

// Acknowledge message
if (msg.ack) msg.ack();

return msg;
```

4. **KV Put Config:**
   - Bucket: `sensor-cache`
   - Key From: `msg.key`

5. **Alert Service:**
```javascript
// Check if alert needed
const avg = msg.payload.average;
if (avg > 30) {
  msg.respondError('Temperature too high!', 'ALERT');
} else {
  msg.respond({ status: 'ok', value: avg });
}
return null;
```

**Inject (Sensor Data):**
```json
{
  "payload": {
    "sensorId": "temp-001",
    "values": [23.5, 24.1, 25.3, 26.8, 27.2],
    "timestamp": "2025-11-17T10:00:00Z"
  }
}
```

**Expected Final Output:**
```json
{
  "payload": {
    "average": 25.38,
    "timestamp": 1234567890,
    "count": 5
  },
  "key": "sensor.temp-001.avg"
}
```

---

### 27. Full Stack Test - Microservices Orchestration

**Scenario:** API Gateway → Service Discovery → Load Balanced Services

**Services Setup:**

1. **Auth Service** (Instance 1 & 2)
2. **Data Service** (Instance 1 & 2)
3. **Gateway Service**

**Auth Service Flow:**
```
[nats-suite-service: auth] → [function: validate] → (response)
```

**Auth Config:**
- Service: `auth-service`
- Endpoint: `validate`
- Queue Group: `auth-service` (auto load balancing)

**Auth Handler:**
```javascript
const { token } = msg.payload;
if (token === 'valid-token-123') {
  msg.respond({ 
    valid: true, 
    user: 'admin',
    permissions: ['read', 'write']
  });
} else {
  msg.respondError('Invalid token', 'AUTH_ERROR');
}
return null;
```

**Gateway Flow:**
```
[inject] 
  → [nats-suite-service: discover] 
  → [function: select-service & add replyTo] 
  → [nats-suite-publish: auth.validate] 
  → ...
[nats-suite-subscribe: gateway.reply] → [debug]
```

**Test Inject:**
```json
{
  "payload": {
    "token": "valid-token-123"
  }
}
```

**Expected Output:**
```json
{
  "payload": {
    "valid": true,
    "user": "admin",
    "permissions": ["read", "write"]
  },
  "status": "success"
}
```

---

## Performance Tests

### 28. Throughput Test - Publish

**Test: 1000 messages/sec**

Flow:
```
[inject: repeat 1000] → [nats-suite-publish] → [counter]
```

**Inject Loop (Function):**
```javascript
// Send 1000 messages
for (let i = 0; i < 1000; i++) {
  node.send({
    payload: {
      id: i,
      timestamp: Date.now()
    }
  });
}
return null;
```

**Expected:** All 1000 Messages successfully sent

---

### 29. Stress Test - Consumer with Pause

**Test: Pause under load**

Setup:
1. Stream with 10.000 messages
2. Consumer with Batch 100 start
3. After 50 Batches: Pause
4. After 5 seconds: Resume
5. Verify: All Messages consumed

**Expected:** No lost messages

---

## Error Handling Tests

### 30. Connection Loss Recovery

**Test:** Buffering on Connection Interruption

1. Start NATS Server
2. Start Publish Flow with buffering enabled
3. Stop NATS Server
4. Send 100 Messages (will be buffered)
5. Start NATS Server
6. Verify: All 100 Messages will be flushed

---

## Validation Tests

### Checklist

- [ ] Server Config Connection
- [ ] Basic Pub/Sub
- [ ] Message Headers
- [ ] Message Expiration
- [ ] Request/Reply
- [ ] Health & Stats
- [ ] Stream Create/Update
- [ ] Stream Subject Update
- [ ] Stream Publish/Consume
- [ ] Consumer Pause/Resume
- [ ] Consumer Monitoring
- [ ] KV Put/Get
- [ ] KV Delete/Purge
- [ ] KV List Keys
- [ ] KV Watch
- [ ] Object Put/Get/List
- [ ] Service Discovery
- [ ] Service Stats
- [ ] Service Ping
- [ ] Service Endpoints
- [ ] Integration Tests
- [ ] Performance Tests
- [ ] Error Handling

---

**Status:** All Use Cases defined and ready for testing!

