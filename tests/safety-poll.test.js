'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const packet = (payload, to = 0xe0, from = 0xb6) => Buffer.from([0xfe, 0xfe, to, from, ...payload, 0xfd]);
function fixture(t) {
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false; radio.commands = []; radio.serial = { invalidate() {} };
  radio.sendCiv = (bytes) => radio.commands.push([...bytes.subarray(4, -1)]);
  server.sendCiv = server.broadcastCiv = () => {};
  const broker = new Broker(radio, server, { pollMs: 100000, requestTimeoutMs: 100000, autoStartGraceMs: 10000 });
  radio.connected = true; broker.ready = true;
  const client = { id: 'a', active: true, mediaGeneration: 1 };
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); });
  return { broker, radio, client,
    send: (payload) => server.emit('command', client, packet(payload, 0xb6, 0xe0)),
    answer: (payload) => radio.emit('civ', packet(payload)) };
}
async function startTuner(f) {
  f.send([0x1c, 1, 2]); f.answer([0xfb]); await tick();
  assert.equal(f.broker.activeTriggers.has('tuner'), true);
}
function ageStart(broker) { broker.lastTxRequest = performance.now() - broker.options.autoStartGraceMs - 1; }

test('RX poll before queued tuner start cannot stop it inside startup grace', async (t) => {
  const f = fixture(t); f.broker.receivePolls = 2;
  f.broker.poll(); f.send([0x1c, 1, 2]); f.answer([0x1c, 0, 0]); await tick();
  f.answer([0xfb]); await tick();
  if (f.broker.pending) f.answer([0x1c, 1, 0]);
  await tick();
  assert.equal(f.broker.releasing, false);
  assert.equal(f.radio.commands.some((p) => p.join() === '28,0,0'), false);
});

test('slow tuner status cannot stop a same-owner restarted tuner', async (t) => {
  const f = fixture(t); await startTuner(f); ageStart(f.broker); f.broker.receivePolls = 2;
  f.broker.poll(); f.answer([0x1c, 0, 0]); await tick();
  assert.deepEqual(f.radio.commands.at(-1), [0x1c, 1]);
  f.send([0x1c, 1, 2]); f.answer([0x1c, 1, 0]); await tick();
  assert.equal(f.broker.releasing, false);
  f.answer([0xfb]); await tick(); assert.equal(f.broker.releasing, false);
});

test('rejected tuner start cannot become an acknowledged automatic lease', async (t) => {
  const f = fixture(t); f.send([0x1c, 1, 2]); f.answer([0xfa]); await tick();
  assert.equal(f.broker.activeTriggers.has('tuner'), false);
  assert.equal(f.broker.releasing, true, 'failed start retains normal safety cleanup');
  assert.equal(f.radio.commands.some((p) => p.join() === '28,1'), false);
});

test('poll continuation from a lost association cannot release a new tuner', async (t) => {
  const f = fixture(t); await startTuner(f); ageStart(f.broker); f.broker.receivePolls = 2;
  f.broker.poll(); f.answer([0x1c, 0, 0]); await tick();
  f.answer([0x1c, 1, 0]);
  f.broker.lost(); f.broker.ready = true;
  await startTuner(f);
  assert.equal(f.broker.releasing, false);
});

test('acknowledged tuner completes after grace and three fresh RX observations', async (t) => {
  const f = fixture(t); await startTuner(f); ageStart(f.broker);
  for (let i = 0; i < 3; i++) { f.broker.poll(); f.answer([0x1c, 0, 0]); await tick(); }
  assert.deepEqual(f.radio.commands.at(-1), [0x1c, 1]);
  f.answer([0x1c, 1, 0]); await tick();
  assert.equal(f.broker.releasing, true);
  assert.deepEqual(f.radio.commands.at(-1), [0x1c, 0, 0]);
});
