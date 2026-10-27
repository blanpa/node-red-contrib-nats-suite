# NATS client and layout

API ground truth is the installed `.d.ts` under `node_modules/@nats-io/*/lib/`. Do not cite nats.js `migration.md` for anything past v3.0.0.

Confirm signatures before writing call sites. Prefer the client's native operation (create-or-open, native reconnect, `requestMany`) over a wrapper.

Do not add `@synadia-io/orbit.js`. Fast Ingest, stream-as-counter, and real push-consumer delivery are out of scope. Stream mirrors/sources/republish stay `msg.payload` passthrough only — no editor UI unless asked.

`lib/` holds shared helpers (`connect`, `status`, `payload`, `duration`). Node files in `nodes/` own one type each. Do not add an abstraction with one implementation, a config for a value that never changes, or a second copy of a helper that already lives in `lib/`.
