'use strict';

// Node.js 18 ships the Web Crypto API only behind --experimental-global-webcrypto
// (it is on by default from Node 19). @nats-io/obj hashes object chunks with the
// global `crypto.subtle`, so without this shim every Object Store put/get/watch
// fails on Node 18 with "ReferenceError: crypto is not defined" (reproduced
// against nodered/node-red:4.1.16-18). Runtimes that already provide the
// global are left untouched.
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}

module.exports = globalThis.crypto;
