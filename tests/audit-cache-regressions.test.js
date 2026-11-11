'use strict';
// In-process audit regressions: physical commands and private replies are the
// oracle. No radio association or network listeners are used by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Broker } = require('../src/broker');
const query = (hex, source = 0xe1) => Buffer.from(`fefeb6${source.toString(16)}${hex}fd`, 'hex');
const reply = (hex) => Buffer.from(`fefee0b6${hex}fd`, 'hex');
const body = (bytes) => bytes.subarray(4, -1).toString('hex');
function fixture(t, options = {}) {
  let now = 0;
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false; radio.commands = [];
  radio.serial = radio.audio = { invalidate() {} }; radio.playback = { setKeyed() {} };
  radio.sendCiv = (bytes) => radio.commands.push(Buffer.from(bytes));
  server.sent = []; server.sendCiv = (client, bytes) => server.sent.push({ id: client.id, bytes: Buffer.from(bytes) });
  server.broadcastCiv = server.broadcastAudio = () => {};
  const broker = new Broker(radio, server, { telemetryEnabled: true, now: () => now, pollMs: 100000, requestTimeoutMs: 100000, ...options });
  clearInterval(broker.timer); radio.connected = true; broker.ready = true;
  const a = { id: 'a', active: true, mediaGeneration: 1 }, b = { id: 'b', active: true, mediaGeneration: 1 };
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); });
  return { radio, server, broker, a, b, at: (value) => { now = value; },
    send: (client, hex, source = client === a ? 0xe1 : 0xe2) => server.emit('command', client, query(hex, source)),
    answer: (hex) => radio.emit('civ', reply(hex)) };
}
function assertMisses(f, expected) {
  const counts = f.broker.metricsSnapshot().reasons.misses;
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), Object.values(expected).reduce((sum, value) => sum + value, 0));
  for (const [reason, value] of Object.entries(expected)) assert.equal(counts[reason], value, reason);
  assert.equal(f.broker.cacheSnapshot().misses, Object.values(expected).reduce((sum, value) => sum + value, 0));
}

test('AUD08: unsupported IF-filter shape is not shared with a queued second client', (t) => {
  const f = fixture(t, { telemetryEnabled: false });
  f.send(f.a, '1656'); f.send(f.b, '1656'); f.answer('165602');
  assert.deepEqual(f.radio.commands.map(body), ['1656', '1656']);
  assert.deepEqual(f.server.sent.map(({ id, bytes }) => [id, bytes[2], body(bytes)]), [['a', 0xe1, '165602']]);
  assert.equal(f.broker.cacheSnapshot().hits, 0);
  assert.equal(f.broker.metricsSnapshot().reasons.storeSkips.invalid_reply, 1);
  f.answer('165601');
  assert.deepEqual(f.server.sent.map(({ id, bytes }) => [id, bytes[2], body(bytes)]), [['a', 0xe1, '165602'], ['b', 0xe2, '165601']]);
});

test('AUD09: concurrent cold telemetry demand records one absent miss at physical fallback', (t) => {
  const f = fixture(t);
  f.send(f.a, '1502'); f.send(f.b, '1502');
  assertMisses(f, { absent: 1 });
  f.broker.pump(); assertMisses(f, { absent: 1 });
  f.answer('15020042');
  assert.equal(f.radio.commands.length, 1); assert.equal(f.server.sent.length, 2);
  assertMisses(f, { absent: 1 });
  assert.equal(f.broker.metricsSnapshot().byQuery['1502'].misses.absent, 1);
  assert.equal(f.broker.cacheSnapshot().hits, 1);
  assert.equal(f.broker.metricsSnapshot().eligible.completed, 2);
});

for (const [key, value, maxAge] of [['1502', '0042', 300], ['1507', '00', 1000]]) {
  test(`AUD09: ${key} records expired exactly at its ${maxAge} ms telemetry age boundary`, (t) => {
    const f = fixture(t); f.send(f.a, key); f.answer(key + value); f.broker.resetStatistics();
    f.at(maxAge - 1); f.send(f.b, key); assert.equal(f.radio.commands.length, 1);
    f.at(maxAge); f.send(f.a, key); assert.equal(f.radio.commands.length, 2);
    assertMisses(f, { expired: 1 }); f.answer(key + value);
    f.send(f.b, key); assert.equal(f.radio.commands.length, 2); assertMisses(f, { expired: 1 });
  });
}

test('AUD09: expired RX authority explains a TX-meter fallback', (t) => {
  const f = fixture(t); f.send(f.a, '1c00'); f.answer('1c0000'); f.broker.resetStatistics();
  f.at(299); f.send(f.b, '1511'); assert.equal(f.radio.commands.length, 1);
  f.at(300); f.send(f.b, '1511'); assert.equal(f.radio.commands.length, 2);
  assertMisses(f, { expired: 1 }); f.answer('15110042');
});

test('AUD09: FIFO mutation barrier distinguishes admission and entry coherence misses', (t) => {
  const f = fixture(t); f.send(f.a, '1502'); f.answer('15020042'); f.broker.resetStatistics();
  f.send(f.a, '1900'); f.send(f.a, '1502'); f.send(f.a, '14020050'); f.send(f.b, '1502');
  assertMisses(f, {});
  f.answer('1900b6'); assertMisses(f, { admission_epoch: 1 }); f.answer('15020011');
  assert.equal(body(f.broker.pending.bytes), '14020050'); f.answer('fb');
  assertMisses(f, { admission_epoch: 1, entry_epoch: 1 }); f.answer('15020022');
  assert.deepEqual(f.radio.commands.map(body), ['1502', '1900', '1502', '14020050', '1502']);
  assert.deepEqual(f.server.sent.filter(({ bytes }) => bytes[4] === 0x15).map(({ bytes }) => body(bytes)), ['15020042', '15020011', '15020022']);
});

test('AUD09: a retired generation explains fallback after radio loss without resurrecting samples', (t) => {
  const f = fixture(t); f.send(f.a, '1502'); f.answer('15020042'); f.broker.resetStatistics();
  f.broker.lost(); f.broker.ready = true;
  assert.equal(f.broker.telemetry.samples.size, 0);
  f.send(f.b, '1502'); assertMisses(f, { generation: 1 }); f.answer('15020011');
  assert.equal(f.radio.commands.length, 2);
});

test('AUD09: reset suppresses old queued logical misses while fresh fallbacks still count', (t) => {
  const f = fixture(t); f.send(f.a, '1900'); f.send(f.b, '1502'); f.broker.resetStatistics();
  f.answer('1900b6'); assert.equal(f.radio.commands.length, 2); assertMisses(f, {});
  f.answer('15020042'); assertMisses(f, {});
  assert.equal(f.broker.metricsSnapshot().physical.clientRead, 1);
  assert.equal(f.broker.metricsSnapshot().logical.completed, 0);
  f.at(300); f.send(f.a, '1502'); assertMisses(f, { expired: 1 }); f.answer('15020011');
});

test('AUD09: background polls and cache opt-outs never record logical miss reasons', async (t) => {
  const f = fixture(t);
  const work = f.broker.internal([0x15, 2], false, false, 'telemetryPoll'); f.answer('15020042'); await work;
  assertMisses(f, {}); assert.equal(f.broker.metricsSnapshot().physical.telemetryPoll, 1);
  for (const options of [{ cacheEnabled: false }, { cacheMetersMs: 0 }, { cacheQueryTtls: { '1502': 0 } }]) {
    const disabled = fixture(t, options); disabled.send(disabled.a, '1502'); disabled.answer('15020042');
    assertMisses(disabled, {}); assert.equal(disabled.radio.commands.length, 1);
  }
});
