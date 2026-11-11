'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until, frame, sleep } = require('./fixtures/harness');

test('bounded upstream audio overload cannot block confirmed release or drain stale queued media', { timeout: 15000 }, async (t) => {
  const x = await setup(t, { radio: { maxPendingPackets: 2, maxPendingBytes: 3000 }, broker: { pollMs: 100000 } });
  const client = await x.connect();
  client.sendCiv(frame(0x1c, [0, 1]));
  await until(() => x.service.session.playback.keyed, 'fixture TX gate');
  const stream = x.service.session.audio, socket = stream.socket, originalSend = socket.send, held = [];
  socket.send = function (packet, callback) {
    if (packet.length > 16 && packet.readUInt16LE(4) === 0) { held.push({ callback }); return; }
    return originalSend.call(socket, packet, callback);
  };
  try {
    client.playback.setKeyed(true);
    for (let n = 0; n < 50; n++) client.sendAudio(Buffer.alloc(1364, n));
    await until(() => stream.counters.sendDrops > 0, 'bounded upstream media drop');
    assert.equal(held.length, 2); assert.equal(stream.outstandingSends, 2);
    client.receivedCiv.length = 0;
    client.sendCiv(frame(0x1c, [0, 0]));
    await until(() => client.receivedCiv.some((bytes) => bytes[4] === 0xfb) && !x.service.broker.releasing, 'confirmed deferred OFF ACK');
    assert.equal(x.radio.ptt, false); assert.equal(x.service.broker.owner, null);
    const before = held.length;
    for (const pending of held) pending.callback();
    await sleep(20);
    assert.equal(held.length, before, 'callback completion must not drain an application media backlog');
    assert.equal(stream.outstandingSends, 0);
    assert.equal(stream.outstandingBytes, 0);
  } finally {
    socket.send = originalSend;
    for (const pending of held) pending.callback();
  }
});
