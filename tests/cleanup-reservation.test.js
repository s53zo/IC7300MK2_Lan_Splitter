'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const packet = (payload, to = 0xe0, from = 0xb6) => Buffer.from([0xfe, 0xfe, to, from, ...payload, 0xfd]);
function fixture(t) {
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false; radio.commands = []; radio.serial = radio.audio = { invalidate() {} };
  radio.playback = { setKeyed() {} };
  radio.sendCiv = (bytes) => radio.commands.push([...bytes.subarray(4, -1)]);
  server.sendCiv = server.broadcastCiv = () => {};
  const broker = new Broker(radio, server, { pollMs: 100000, requestTimeoutMs: 10000 });
  radio.connected = true; broker.ready = true;
  const a = { id: 'owner', active: true, mediaGeneration: 1 };
  const b = { id: 'reader', active: true, mediaGeneration: 1 };
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); });
  return { radio, server, broker, a, b,
    send: (client, payload) => server.emit('command', client, packet(payload, 0xb6)),
    answer: (payload) => radio.emit('civ', packet(payload)) };
}

test('complete release reserves dispatch across every await and resumes queued reads afterward', async (t) => {
  const f = fixture(t);
  for (const payload of [[0x1c, 0, 1], [0x17, 65], [0x28, 0, 1], [0x1c, 1, 2], [0x16, 0x46, 1]]) {
    f.send(f.a, payload); f.answer([0xfb]);
  }
  f.radio.commands.length = 0;
  const release = f.broker.release();
  const expected = [[0x1c, 0, 0], [4], [0x17, 0xff], [0x28, 0, 0], [0x1c, 1, 0], [0x16, 0x46, 0], [0x1c, 0]];
  for (const payload of expected) {
    assert.deepEqual(f.radio.commands.at(-1), payload, 'reader must not enter the safety sequence');
    f.send(f.b, [3]);
    f.answer(payload[0] === 4 ? [4, 3, 1] : payload.length === 2 && payload[0] === 0x1c ? [0x1c, 0, 0] : [0xfb]);
    await tick();
  }
  assert.equal(await release, true);
  assert.deepEqual(f.radio.commands.slice(0, expected.length), expected);
  assert.deepEqual(f.radio.commands.at(-1), [3]);
  assert.equal(f.broker.releasing, false);
});

test('nested keyer continuation cannot admit work into a replacement generation', async (t) => {
  const f = fixture(t);
  const work = f.broker.stopKeyer(true, 'release');
  const result = work.then(() => 'completed', () => 'cancelled');
  f.answer([4, 3, 1]);
  f.radio.connected = false; f.broker.lost();
  assert.equal(await result, 'cancelled');
  assert.equal(f.broker.queue.length, 0);
  assert.equal(f.radio.commands.some((p) => p[0] === 0x17), false);
});

test('nested initiator continuation cannot admit remaining stops after session loss', async (t) => {
  const f = fixture(t); f.broker.txObligations = new Set(['voice', 'tuner', 'vox']);
  const work = f.broker.stopInitiators(true, 'release');
  const result = work.then(() => 'completed', () => 'cancelled');
  f.answer([0xfb]); f.radio.connected = false; f.broker.lost();
  assert.equal(await result, 'cancelled');
  assert.equal(f.broker.queue.length, 0);
  assert.deepEqual(f.radio.commands, [[0x28, 0, 0]]);
});

test('startup continuation cannot enqueue queries after its generation was replaced', async (t) => {
  const f = fixture(t); f.broker.ready = false;
  const sync = f.broker.synchronize();
  f.answer([0xfb]); f.radio.connected = false; f.broker.lost();
  await sync;
  assert.equal(f.broker.queue.length, 0);
  assert.equal(f.radio.commands.length, 1);
  assert.equal(f.broker.ready, false);
});

test('close reports unconfirmed owned or observed TX after upstream loss', async (t) => {
  const f = fixture(t); f.broker.owner = f.a; f.broker.observedTx = true;
  f.radio.connected = false;
  const result = await f.broker.close();
  assert.equal(result.releaseConfirmed, false);
  assert.equal(f.broker.closed, true);
});

test('real disconnect retains uncertainty about unowned observed TX until fresh startup confirms RX', async (t) => {
  const f = fixture(t); f.broker.observedTx = true;
  f.radio.connected = false; f.radio.emit('disconnected');
  assert.equal(f.broker.observedTx, false);
  const result = await f.broker.close();
  assert.equal(result.releaseConfirmed, false, 'loss of observation is not confirmation of RX');
});

test('fresh startup RX confirmation clears retained TX uncertainty', async (t) => {
  const f = fixture(t); f.broker.observedTx = true;
  f.radio.connected = false; f.radio.emit('disconnected');
  assert.equal(f.broker.releaseUnconfirmed, true);
  f.radio.connected = true;
  const startup = f.broker.synchronize();
  for (const reply of [[0xfb], [4, 1, 1], [0x1c, 0, 0], [0xfb], [0xfb]]) {
    f.answer(reply); await tick();
  }
  await startup;
  assert.equal(f.broker.ready, true);
  assert.equal(f.broker.releaseUnconfirmed, false);
  assert.equal((await f.broker.close()).releaseConfirmed, true);
});
