'use strict';

// Encodes a JS value into a NATS Payload (Uint8Array|string): a Uint8Array
// (e.g. an already-encoded Buffer) passes through untouched, an object is
// JSON-stringified, everything else is coerced to a string. This is
// stream-publisher.js's own auto-detect encoder - NOT the same contract as
// publish.js's encodePayload(), which dispatches on an explicit
// config.dataformat and errors on an unrecognized one; that stays local,
// forcing it through this format-less auto-detector would silently change
// its error behavior on a missing/unknown dataformat.
function toPayload(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}

// Decodes a NATS message per dataformat. `msg` is anything with .string()/
// .json()/.data - both core Msg and JetStream JsMsg qualify. 'auto' (and
// any other/missing format) tries JSON, falling back to the raw string;
// 'json' throws on a parse failure so the caller can report it with its
// own context (subject, node prefix) and abort - it deliberately does not
// swallow the error itself.
function fromMsg(msg, format) {
  switch (format) {
    case 'json':
      return msg.json();
    case 'string':
      return msg.string();
    case 'buffer':
      return msg.data;
    default: {
      const data = msg.string();
      if (data.trim().length === 0) return data;
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
  }
}

module.exports = { toPayload, fromMsg };
