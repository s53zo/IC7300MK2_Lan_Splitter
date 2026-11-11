'use strict';

// Isolated fixture: no sockets, credentials, radio, or production service.
// Run from any working directory: node <repo>/docs/audits/2026-11-11/reproductions/A-release-read-interleave.js
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { Broker } = require(path.resolve(__dirname, '../../../../src/broker'));
const command = (payload) => Buffer.from([0xfe, 0xfe, 0xb6, 0xe0, ...payload, 0xfd]);
const answer = (payload) => Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, ...payload, 0xfd]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const radio = new EventEmitter(), server = new EventEmitter();
  const trace = [];
  Object.assign(radio, { connected: false, auto: true, vox: false,
    serial: { invalidate() {} }, audio: { invalidate() {} }, playback: { setKeyed() {} },
  });
  Object.assign(server, { sendCiv() {}, broadcastCiv() {}, broadcastAudio() {} });
  const broker = new Broker(radio, server, { pollMs: 60000, requestTimeoutMs: 40 });
  radio.fail = (error) => { radio.failure = error; radio.connected = false; radio.emit('disconnected', error); };
  radio.respond = (bytes = broker.pending?.bytes) => {
    assert.ok(bytes, 'a real broker transaction must be pending');
    let payload = [0xfb];
    if (bytes[4] === 3) payload = [3, 0, 0x40, 7, 0x14, 0];
    if (bytes[4] === 4) payload = [4, 1, 1];
    if (bytes[4] === 0x1c && bytes.length === 7) payload = [0x1c, 0, 0];
    if (bytes[4] === 0x16 && bytes[5] === 0x46) radio.vox = Boolean(bytes[6]);
    radio.emit('civ', answer(payload));
  };
  radio.sendCiv = (bytes) => {
    trace.push({ payload: bytes.subarray(4, -1).toString('hex'),
      internal: broker.pending.internal, purpose: broker.pending.purpose || 'client' });
    if (radio.auto) queueMicrotask(() => radio.respond(bytes));
  };
  try {
    const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
    const owner = { id: 'owner', active: true }, reader = { id: 'reader', active: true };
    server.emit('command', owner, command([0x16, 0x46, 1])); await tick();
    assert.equal(broker.owner, owner); assert.equal(radio.vox, true);
    trace.length = 0; radio.auto = false;
    server.emit('command', reader, command([3]));
    server.emit('command', reader, command([4]));
    owner.active = false; server.emit('disconnect', owner);
    const released = broker.releasePromise;
    radio.respond(); // Complete the already in-flight frequency read.
    assert.equal(trace.at(-1).purpose, 'release');
    assert.equal(trace.at(-1).payload, '1c0000');
    radio.respond(); // PTT-off itself succeeds.
    // The next pending request is the unrelated reader's queued mode query.
    assert.equal(broker.pending.client, reader);
    assert.equal(broker.pending.internal, undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await released, false);
    assert.equal(radio.vox, true, 'the remaining VOX cleanup was never sent');
    assert.ok(radio.failure);
    assert.equal(trace.some((row) => row.payload === '164600'), false);
    process.stdout.write(`${JSON.stringify({ reproduced: true, trace, releaseSucceeded: false,
      voxDisableSent: false, failure: radio.failure.message }, null, 2)}\n`);
  } finally {
    radio.connected = false; broker.owner = null; await broker.close();
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
