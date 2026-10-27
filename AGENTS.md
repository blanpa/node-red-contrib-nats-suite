# Agent instructions

node-red-contrib-nats-suite is a Node-RED package of 12 nodes wrapping `@nats-io/*@3.4.0` (Core, JetStream, KV, Object Store, Services).

Floors: runtime Node.js `>=18`, Node-RED `>=3.0.0`, nats-server `>=2.10`. The development toolchain (ESLint 10, the `node:test` harness) needs Node.js `>=22.13`. No new runtime dependencies. Existing flows keep working: a missing property on an old flow falls back to the previous behaviour; a deliberate break gets a migration note in `CHANGELOG.md`.

## Commands

```bash
docker compose up -d nats-server nodered
npm test                          # real stack; node:test --test-concurrency=1
node --test --test-concurrency=1 test/<file>.test.js   # focused; npm test -- file still runs the glob
npm run lint
npm run format:check
npm pack --dry-run
```

`NODERED_IMAGE=nodered/node-red:4.1.16-18 docker compose up -d nats-server nodered` runs the same suite against the Node-RED 4 / Node.js 18 floor. Host ports are overridable through `.env` (see `docker-compose.yml`).

After `nodes/*.js` edits: `docker compose restart nodered` before any container test — Node-RED `require()`-caches the module at process start; flow redeploy does not reload it.

After `nodes/*.html` edits: restart `nodered` and hard-reload the editor (`Ctrl+Shift+R`). A plain refresh serves the cached `/nodes` bundle.

## Releasing

The npm name is `node-red-contrib-nats-suite`. Publishing runs only from GitHub Actions through npm trusted publishing (OIDC + provenance); the workflow file `.github/workflows/publish-npm.yml` is registered on npmjs.com as the trusted publisher. There is no `NPM_TOKEN`.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main`.
3. Push a tag `v<version>` (e.g. `v0.3.0`, matching the existing tags) whose version matches `package.json`. The workflow verifies the match, runs lint, format check, audit, the real-stack tests and the packed-contents check, then publishes.

Confirm with `npm view node-red-contrib-nats-suite@<version> dist` — a CI publish has an `attestations` field.

## Read when the task touches that surface

- [Runtime](docs/agents/runtime.md) — `done()`, Catch, close, connect timeout vs events
- [Testing](docs/agents/testing.md) — real Node-RED + real NATS, what not to mock
- [Editor](docs/agents/editor.md) — defaults, theme variables, help
- [NATS client and layout](docs/agents/nats-and-layout.md) — API source of truth, `lib/` vs `nodes/`
