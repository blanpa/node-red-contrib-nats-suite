# Editor

Runtime `.js` and editor `.html` share no code path. Every `defaults` key needs a matching `node-input-*` (or `node-config-input-*`) control; every control needs a default. Credentials go in Node-RED credentials, not exported properties.

Use Node-RED 5 theme variables (`--red-ui-*`). Do not hardcode hex backgrounds or text colors — they break dark theme.

Help is `text/markdown`. Keep it aligned with actual operations, defaults, and errors.

Do not add a config-node picker for a type that does not exist (`bucketConfig` was this class of bug).

Editor defaults initialize **new** nodes only. Missing properties on old JSON are not backfilled by Node-RED, so the runtime must fall back to the previous behaviour for them (e.g. `config.createOnInit !== false`).
