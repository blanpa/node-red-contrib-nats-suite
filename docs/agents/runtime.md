# Runtime

Input handlers use `(msg, send, done)`. Call `done()` once on success and `done(err)` on failure. Do not also call `node.error(err, msg)` on that path — `done(err)` already fires Catch nodes.

Reserve bare `node.error(...)` for constructor-time guards where there is no `msg`/`done`.

Close handlers take `done` and call it after teardown. Await iterators, watchers, child processes, and connection unregister. Set a `closing` flag before tearing down so in-flight work cannot resurrect handles.

Shared NATS connections live on `nats-suite-server`. Resolve the config node with `RED.nodes.getNode`; never key a pool by display name. Register/unregister connection users on the immutable node id.

## Time vs events

Wait on a real signal when one exists: connect/reconnect via the client's `status()` iterator, message arrival, fetch/watch end, process exit, Admin API deploy return plus node construction (not the HTTP 204 alone).

A **timeout is required** when the signal never comes — unreachable broker, request with no reply, drain that can hang. Use the editor **Connection Timeout** (`connectTimeout`, default 10000ms) as the per-dial deadline. Do not replace it with an unbounded `getConnection()`. One-shot checks (health `checkOnStart`) race connect against that timeout, then report; the config node may keep retrying.

Timers for backoff, debounce (unused-connection close), ping, and periodic health are time-as-behavior. Do not convert those to events.
