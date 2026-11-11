'use strict';
// Independent adversarial oracle: assert physical order and private replies,
// rather than duplicating SharedTelemetry's scheduling calculations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (payload, destination = 0xb6, source = 0xe0) => Buffer.from([0xfe, 0xfe, destination, source, ...payload, 0xfd]);
function fixture(t, options = {}) {
  let now = 0;
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false; radio.commands = []; radio.serial = radio.audio = { invalidate() {} }; radio.playback = { setKeyed() {} };
  radio.sendCiv = (bytes) => radio.commands.push(Buffer.from(bytes));
  server.sent = []; server.sendCiv = (client, bytes) => server.sent.push({ client, bytes: Buffer.from(bytes) });
  server.broadcastCiv = server.broadcastAudio = () => {};
  const broker = new Broker(radio, server, { telemetryEnabled: true, pollMs: 100000, requestTimeoutMs: 100000, now: () => now, ...options });
  clearInterval(broker.timer); radio.connected = true; broker.ready = true;
  const a = { id: 'a', active: true, mediaGeneration: 1 }, b = { id: 'b', active: true, mediaGeneration: 1 };
  const body = (bytes) => bytes.subarray(4, -1).toString('hex');
  const answer = (payload) => radio.emit('civ', frame(payload, 0xe0, 0xb6));
  const respond = () => {
    const p = [...broker.pending.bytes.subarray(4, -1)];
    if (p[0] === 0x1c && p.length === 2) answer([...p, 0]);
    else if (p[0] === 0x15) answer([...p, ...(p[1] === 7 ? [0] : [0, 0x42])]);
    else if (p[0] === 0x19) answer([...p, 0xb6]);
    else answer([0xfb]);
  };
  const drain = () => { for (let i = 0; broker.pending && i < 20; i++) respond(); assert.equal(broker.pending, null); };
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); await tick(); });
  return { broker, radio, server, a, b, at: (value) => { now = value; }, body, answer, respond, drain,
    send: (client, payload, address = 0xe0) => server.emit('command', client, frame(payload, 0xb6, address)) };
}

test('audit: fresh priority safety poll is not leapfrogged by ordinary incoming clients', (t) => {
  const f = fixture(t);
  f.send(f.a, [0x19, 0]); f.broker.poll(); f.send(f.b, [0x15, 2]);
  assert.deepEqual(f.broker.queue.map((item) => f.body(item.bytes)), ['1c00', '1502']);
  f.respond(); assert.equal(f.body(f.radio.commands.at(-1)), '1c00');
  f.drain();
});

test('audit: optimistic PTT ownership cannot enable TX-only polls without a validated state sample', async (t) => {
  const f = fixture(t);
  f.send(f.a, [0x1c, 0, 1]); f.answer([0xfb]); await tick();
  assert.equal(f.broker.observedTx, true, 'legacy ownership ACK is optimistic');
  assert.equal(f.broker.telemetry.actualTx(), null);
  f.broker.telemetry.tick();
  assert.equal(f.body(f.broker.pending.bytes), '1c00');
  assert.equal(f.broker.queue.some((item) => /^151[123]$/.test(f.body(item.bytes))), false);
  f.answer([0x1c, 0, 0]); f.drain(); await tick();
  assert.equal(f.broker.telemetry.actualTx(), false);
  f.at(100); f.broker.telemetry.tick(); f.answer([0x1c, 0, 1]);
  f.broker.telemetry.tick();
  assert.equal(f.broker.telemetry.actualTx(), true);
  assert.deepEqual(f.broker.queue.filter((item) => /^151[123]$/.test(f.body(item.bytes))).map((item) => f.body(item.bytes)), ['1511', '1512', '1513']);
  f.drain();
});

test('audit: RX zero synthesis is private and stops at the exact state-age boundary', (t) => {
  const f = fixture(t); f.broker.telemetry.tick(); f.drain();
  const before = f.radio.commands.length;
  f.at(299); f.send(f.b, [0x15, 0x11], 0xe2);
  assert.equal(f.radio.commands.length, before);
  assert.equal(f.server.sent.at(-1).client, f.b);
  assert.deepEqual([...f.server.sent.at(-1).bytes], [0xfe, 0xfe, 0xe2, 0xb6, 0x15, 0x11, 0, 0, 0xfd]);
  f.at(300); f.send(f.b, [0x15, 0x11], 0xe2);
  assert.equal(f.radio.commands.length, before + 1, 'expired RX proof requires a real refresh/fallback');
  assert.equal(f.broker.telemetry.lookup({ bytes: frame([0x15, 0x11]), cacheEpoch: f.broker.cacheEpoch }), null);
  f.drain();
});

test('audit: delayed radio cannot accumulate polls or produce a catch-up burst', async (t) => {
  const f = fixture(t); f.broker.telemetry.tick();
  for (let time = 20; time <= 1000; time += 20) { f.at(time); f.broker.telemetry.tick(); }
  assert.equal(f.radio.commands.length, 1);
  assert.equal(f.broker.queue.length, 2);
  assert.equal(f.broker.telemetry.jobs.size, 3);
  f.drain(); await tick(); f.broker.telemetry.tick(); f.drain();
  const commands = f.radio.commands.map(f.body);
  assert.equal(commands.filter((key) => key === '1c00').length, 1);
  assert.equal(commands.filter((key) => key === '1502').length, 1);
  assert.equal(commands.filter((key) => key === '1507').length, 1);
  f.at(1100); f.broker.telemetry.tick(); f.drain();
  assert.equal(f.radio.commands.map(f.body).filter((key) => key === '1c00').length, 2);
  assert.equal(f.radio.commands.map(f.body).filter((key) => key === '1502').length, 2);
  assert.equal(f.radio.commands.map(f.body).filter((key) => key === '1507').length, 1);
});

test('audit: pre-write read and post-write read retain FIFO values and requester addresses', (t) => {
  const f = fixture(t); f.broker.telemetry.tick(); f.drain(); f.radio.commands.length = 0;
  f.send(f.a, [0x19, 0]); f.send(f.a, [0x15, 2], 0xe1);
  f.send(f.a, [0x14, 2, 0, 0x50]); f.send(f.b, [0x15, 2], 0xe2);
  f.respond(); assert.equal(f.body(f.broker.pending.bytes), '1502'); f.answer([0x15, 2, 0, 0x11]);
  assert.equal(f.body(f.broker.pending.bytes), '14020050'); f.answer([0xfb]);
  assert.equal(f.body(f.broker.pending.bytes), '1502'); f.answer([0x15, 2, 0, 0x22]);
  assert.deepEqual(f.radio.commands.map(f.body), ['1900', '1502', '14020050', '1502']);
  const replies = f.server.sent.filter(({ bytes }) => bytes[4] === 0x15);
  assert.deepEqual(replies.map(({ client, bytes }) => [client.id, bytes[2], bytes[7]]), [['a', 0xe1, 0x11], ['b', 0xe2, 0x22]]);
});

test('audit: malformed or pre-notification RX replies never become zero-response authority', async (t) => {
  const f = fixture(t); f.broker.telemetry.tick(); f.answer([0x1c, 0, 2]);
  assert.equal(f.broker.telemetry.actualTx(), null);
  assert.equal(f.broker.telemetry.snapshot().querySettings.some((row) => row.txOnly && row.polling), false);
  f.drain(); await tick(); f.at(100); f.broker.telemetry.tick();
  f.radio.emit('civ', frame([1, 1, 1], 0, 0xb6));
  f.answer([0x1c, 0, 0]);
  assert.equal(f.broker.telemetry.actualTx(), null, 'notification invalidates an earlier in-flight sample');
  f.send(f.b, [0x15, 0x12]); assert.equal(f.body(f.broker.pending.bytes), '1512'); f.drain();
});

test('audit: global cache disable opts out of the telemetry feed and local replies', (t) => {
  const f = fixture(t, { cacheEnabled: false });
  f.broker.telemetry.tick(); assert.equal(f.radio.commands.length, 0);
  for (let i = 0; i < 2; i++) { f.send(f.a, [0x15, 2]); f.respond(); }
  assert.equal(f.radio.commands.length, 2);
  assert.equal(f.broker.telemetry.snapshot().enabled, false);
  assert.equal(f.broker.cacheSnapshot().hits, 0);
});

test('audit: faster RX state sampling preserves a 500 ms automatic-release observation window', async (t) => {
  const f = fixture(t);
  f.broker.owner = f.a; f.broker.lease = 'tuner'; f.broker.activeTriggers.add('tuner');
  f.broker.lastTxRequest = performance.now() - f.broker.options.autoStartGraceMs - 1;
  for (const now of [0, 100, 200, 300, 400]) {
    f.at(now); f.broker.poll(); f.answer([0x1c, 0, 0]); await tick();
    assert.equal(f.broker.releasing, false);
    assert.equal(f.radio.commands.some((bytes) => f.body(bytes) === '1c01'), false);
  }
  f.at(500); f.broker.poll(); f.answer([0x1c, 0, 0]); await tick();
  assert.equal(f.body(f.broker.pending.bytes), '1c01');
  f.answer([0x1c, 1, 0]); await tick();
  assert.equal(f.broker.releasing, true);
  assert.equal(f.body(f.broker.pending.bytes), '1c0000');
});

test('audit: an RX poll continuation before queued tuner start cannot release the new incarnation', async (t) => {
  const f = fixture(t); f.broker.receivePolls = 10; f.broker.receivePollSince = -1000;
  f.broker.poll(); f.send(f.a, [0x1c, 1, 2]); f.answer([0x1c, 0, 0]); await tick();
  assert.equal(f.body(f.broker.pending.bytes), '1c0102');
  f.answer([0xfb]); await tick();
  assert.equal(f.broker.activeTriggers.has('tuner'), true);
  assert.equal(f.broker.releasing, false);
  assert.equal(f.broker.receivePolls, 0);
  assert.equal(f.broker.receivePollSince, null);
  assert.equal(f.radio.commands.some((bytes) => f.body(bytes) === '1c0000'), false);
});
