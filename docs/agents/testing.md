# Testing

Drive nodes through the real Node-RED container (`nodered/node-red:5.0.0` by default, `NODERED_IMAGE` overrides it, host port 1885, repo mounted at `/data/node_modules/node-red-contrib-nats-suite`) and real `nats:latest`. No `node-red-node-test-helper`, no in-process runtime, no NATS mocks.

Pure helpers in `lib/` may use host-side `node:test` with fakes (`test/lib.test.js`) — they must not claim to prove a node contract.

Register `waitForStatus` / `waitForDebug` **before** `deployFlow` / `triggerInject`. `waitForDebug` has no replay buffer; the first matching event wins.

`npm test` always expands `test/**/*.test.js`. A focused run is `node --test --test-concurrency=1 test/<file>.test.js`.

`.html` changes: parse defaults vs `node-input-*` ids (see `test/promotion.test.js`, `test/editor-theme-*.test.js`); inspect both themes after a hard reload. DOM assertions are not visual proof.
