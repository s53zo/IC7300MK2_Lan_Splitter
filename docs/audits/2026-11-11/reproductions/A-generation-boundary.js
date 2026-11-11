'use strict';

// Fault-boundary probe only. This confirms missing helper-local guards, not
// physical unsafe transmission. No network or credentials are involved.
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { Broker } = require(path.resolve(__dirname, '../../../../src/broker'));
const frame = (payload, response = false) => Buffer.from([0xfe, 0xfe,
  response ? 0xe0 : 0xb6, response ? 0xb6 : 0xe0, ...payload, 0xfd]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function main() {
  const radio = new EventEmitter(), server = new EventEmitter();
  Object.assign(radio, { connected: false, auto: true,
    serial: { invalidate() {} }, audio: { invalidate() {} }, playback: { setKeyed() {} } });
  Object.assign(server, { sendCiv() {}, broadcastCiv() {}, broadcastAudio() {} });
  const broker = new Broker(radio, server, { pollMs: 60000, requestTimeoutMs: 1000 });
  radio.respond = (bytes = broker.pending.bytes) => {
    let payload = [0xfb];
    if (bytes[4] === 4) payload = [4, 3, 1];
    if (bytes[4] === 0x1c && bytes.length === 7) payload = [0x1c, 0, 0];
    radio.emit('civ', frame(payload, true));
  };
  radio.sendCiv = (bytes) => { if (radio.auto) queueMicrotask(() => radio.respond(bytes)); };
  radio.fail = (error) => { radio.connected = false; radio.emit('disconnected', error); };
  try {
    const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
    const owner = { id: 'owner', active: true };
    server.emit('command', owner, frame([0x1c, 0, 1])); await tick();
    radio.auto = false;
    const originalGeneration = broker.generation, released = broker.release();
    radio.respond(); await tick(); // PTT off, followed by mode read.
    assert.equal(broker.pending.bytes[4], 4);
    radio.respond(); // Fulfil stopKeyer's await, but interrupt before its continuation.
    radio.fail(new Error('isolated failure immediately after mode reply'));
    await tick();
    const stale = broker.queue.find((item) => item.bytes[4] === 0x17);
    assert.ok(stale, 'old stopKeyer continuation admitted another internal command');
    assert.equal(stale.generation, broker.generation);
    assert.notEqual(stale.generation, originalGeneration);
    assert.equal(radio.connected, false);
    process.stdout.write(`${JSON.stringify({ reproducedGuardGap: true,
      originalGeneration, currentGeneration: broker.generation,
      queuedPayload: stale.bytes.subarray(4, -1).toString('hex'),
      queuedItemGeneration: stale.generation, sentAfterDisconnect: false,
      note: 'Reconnect synchronize() currently purges this queue; no unsafe send or stale success ACK demonstrated.' }, null, 2)}\n`);
    await broker.close(); assert.equal(await released, false);
  } finally { radio.connected = false; broker.owner = null; await broker.close(); }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
