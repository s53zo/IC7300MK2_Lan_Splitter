'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const query = (payload, from = 0xe0) => Buffer.from([0xfe, 0xfe, 0xb6, from, ...payload, 0xfd]);
const answer = (payload) => Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, ...payload, 0xfd]);
const key = (bytes) => bytes.subarray(4, -1).toString('hex');
class Radio extends EventEmitter {
  constructor() { super(); this.connected = false; this.auto = true; this.commands = []; this.ptt = false; this.serial = this.audio = { invalidate() {} }; this.playback = { setKeyed() {} }; }
  sendCiv(bytes) { this.commands.push(Buffer.from(bytes)); if (this.auto) queueMicrotask(() => this.respond(bytes)); }
  respond(bytes = this.commands.at(-1), replacement) {
    const p = [...bytes.subarray(4, -1)]; let response = [0xfb];
    if (p[0] === 4 && p.length === 1) response = [4, 1, 1];
    if (p[0] === 0x19) response = [...p, 0xb6];
    if (p[0] === 0x15 && p.length === 2) response = [...p, ...(p[1] === 7 ? [0] : [0, 0x42])];
    if (p[0] === 0x1c && p.length === 2) response = [...p, p[1] === 0 ? +this.ptt : 0];
    if (p[0] === 0x1c && p[1] === 0 && p.length === 3) this.ptt = Boolean(p[2]);
    this.emit('civ', answer(replacement || response));
  }
  fail(error) { this.connected = false; this.emit('disconnected', error); }
}
class Server extends EventEmitter {
  constructor() { super(); this.sent = []; }
  sendCiv(client, bytes) { this.sent.push({ id: client.id, bytes: Buffer.from(bytes) }); }
  broadcastCiv() {} broadcastAudio() {}
}
async function setup(t, options = {}) {
  let clock = 0;
  const radio = new Radio(), server = new Server();
  const broker = new Broker(radio, server, { telemetryEnabled: true, now: () => clock, pollMs: 100000, requestTimeoutMs: 500, ...options });
  t.after(async () => { radio.auto = true; if (broker.pending) radio.respond(); await broker.close(); });
  const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready; clearInterval(broker.timer);
  radio.commands.length = 0; server.sent.length = 0;
  const a = { id: 'a', active: true, mediaGeneration: 1 }, b = { id: 'b', active: true, mediaGeneration: 1 };
  return { radio, server, broker, a, b, at: (time) => { clock = time; }, send: (client, p, from) => server.emit('command', client, query(p, from)),
    async step(time) { clock = time; broker.telemetry.tick(); await tick(); } };
}
function counts(commands) { return Object.fromEntries(['1c00', '1502', '1507', '1511', '1512', '1513'].map((k) => [k, commands.filter((b) => key(b) === k).length])); }

test('shared RX schedule sends exactly 22 fresh reads per second and TX meters are absent', async (t) => {
  const x = await setup(t);
  for (let time = 0; time < 1000; time += 20) await x.step(time);
  assert.deepEqual(counts(x.radio.commands), { '1c00': 10, '1502': 10, '1507': 2, '1511': 0, '1512': 0, '1513': 0 });
  assert.equal(x.radio.commands.length, 22);
  assert.equal(x.broker.telemetrySnapshot().querySettings.find((r) => r.key === '1c00').rfPolls, 10);
});

test('fresh observed TX enables a shared 52 reads per second schedule; quiet ownership does not', async (t) => {
  const x = await setup(t); x.broker.owner = x.a; x.broker.lease = 'vox'; x.broker.activeTriggers.add('vox');
  await x.step(0); assert.equal(x.broker.telemetry.actualTx(), false);
  assert.equal(counts(x.radio.commands)['1511'], 0);
  x.radio.ptt = true; await x.step(100); await x.step(120);
  x.radio.commands.length = 0;
  for (let time = 200; time < 1200; time += 20) await x.step(time);
  assert.deepEqual(counts(x.radio.commands), { '1c00': 10, '1502': 10, '1507': 2, '1511': 10, '1512': 10, '1513': 10 });
  assert.equal(x.radio.commands.length, 52);
});

test('clients share sampled replies and documented RX zeros privately without radio queries', async (t) => {
  const x = await setup(t); await x.step(0); const before = x.radio.commands.length;
  for (const p of [[0x15, 2], [0x15, 7], [0x1c, 0], [0x15, 0x11], [0x15, 0x12], [0x15, 0x13]]) {
    x.send(x.a, p, 0xe1); x.send(x.b, p, 0xe2);
  }
  await tick(); assert.equal(x.radio.commands.length, before); assert.equal(x.server.sent.length, 12);
  assert.deepEqual(x.server.sent.map((r) => r.bytes[2]), [0xe1, 0xe2, 0xe1, 0xe2, 0xe1, 0xe2, 0xe1, 0xe2, 0xe1, 0xe2, 0xe1, 0xe2]);
  for (const r of x.server.sent.filter((r) => [0x11, 0x12, 0x13].includes(r.bytes[5]))) assert.deepEqual([...r.bytes.subarray(6, -1)], [0, 0]);
  assert.equal(x.broker.cacheSnapshot().hits, 12);
  const rows = x.broker.telemetrySnapshot().querySettings;
  assert.equal(rows.find((r) => r.key === '1511').zeroReplies, 2);
});

test('a delayed radio cannot accumulate polls or replay missed intervals in a burst', async (t) => {
  const x = await setup(t); x.radio.auto = false;
  for (let time = 0; time < 2000; time += 20) await x.step(time);
  assert.equal(x.radio.commands.length, 1); assert.equal(x.broker.queue.length, 2); assert.equal(x.broker.telemetry.jobs.size, 3);
  x.at(2000); x.radio.auto = true; x.radio.respond(); await tick();
  assert.equal(x.radio.commands.length, 3);
  await x.step(2020); const stateCount = counts(x.radio.commands)['1c00'];
  assert.equal(stateCount, 1, 'next state read waits a new 100 ms from dispatch instead of catching up');
});

test('cold concurrent reads use one bounded FIFO refresh and the following client is local', async (t) => {
  const x = await setup(t); x.radio.auto = false;
  x.send(x.a, [0x15, 2], 0xe1); x.send(x.b, [0x15, 2], 0xe2);
  assert.equal(x.radio.commands.length, 1); x.radio.respond(); await tick();
  assert.equal(x.radio.commands.length, 1); assert.equal(x.server.sent.length, 2);
  const row = x.broker.telemetrySnapshot().querySettings.find((r) => r.key === '1502');
  assert.equal(row.fallbacks, 1); assert.equal(row.localAnswers, 1);
});

test('stale samples fall back freshly and invalid replies never enter the sample bank', async (t) => {
  const x = await setup(t); await x.step(0); x.at(300); x.radio.auto = false;
  x.send(x.a, [0x15, 2]); assert.equal(x.radio.commands.at(-1)[5], 2);
  x.radio.respond(undefined, [0x15, 2, 0xff, 0xff]); await tick();
  assert.equal(x.broker.telemetry.entry('1502'), null);
  x.send(x.b, [0x15, 2]); assert.equal(x.radio.commands.filter((b) => key(b) === '1502').length, 3);
  x.radio.respond(); await tick(); assert.ok(x.broker.telemetry.entry('1502'));
});

test('mutation admission prevents stale samples and queued PTT cannot receive an old RX zero', async (t) => {
  const x = await setup(t); await x.step(0); x.radio.auto = false;
  x.send(x.a, [0x19, 0]); x.send(x.a, [0x1c, 0, 1]); x.send(x.b, [0x15, 0x11]);
  assert.equal(x.broker.telemetry.samples.size, 0);
  x.radio.respond(); x.radio.respond(); await tick();
  assert.equal(key(x.radio.commands.at(-1)), '1511'); x.radio.respond(); await tick();
  assert.equal(x.server.sent.at(-1).bytes[7], 0x42, 'read gets an actual post-PTT reply, not the old RX zero');
});

test('late pre-write samples cannot populate a new epoch or survive radio loss', async (t) => {
  const x = await setup(t); x.radio.auto = false;
  x.send(x.a, [0x15, 2]); x.send(x.a, [0x14, 1, 0, 0x50]); x.radio.respond();
  assert.equal(x.broker.telemetry.samples.size, 0); x.radio.respond(); await tick();
  x.radio.auto = true; await x.step(100); assert.ok(x.broker.telemetry.samples.size);
  x.radio.fail(new Error('fixture lost')); assert.equal(x.broker.telemetry.samples.size, 0); assert.equal(x.broker.telemetry.jobs.size, 0);
});

test('global cache disable leaves legacy safety only, while query/family zero opts out of meter sharing', async (t) => {
  const disabled = await setup(t, { cacheEnabled: false }); await disabled.step(0);
  assert.equal(disabled.radio.commands.length, 0); disabled.broker.poll(); await tick(); assert.equal(key(disabled.radio.commands[0]), '1c00');
  const x = await setup(t, { cacheMetersMs: 0, cacheStateMs: 0, cacheQueryTtls: { '1502': 200 } }); await x.step(0);
  assert.deepEqual(counts(x.radio.commands), { '1c00': 1, '1502': 1, '1507': 0, '1511': 0, '1512': 0, '1513': 0 });
  const before = x.radio.commands.length; x.send(x.a, [0x15, 2]); await tick(); assert.equal(x.radio.commands.length, before);
  x.send(x.a, [0x1c, 0]); await tick(); assert.equal(x.radio.commands.length, before + 1, 'disabled state sharing still forwards user requests despite fresh safety sampling');
});

test('active query settings distinguish sampling age from configured legacy lifetimes', async (t) => {
  const x = await setup(t, { cacheQueryTtls: { '1502': 1000, '1507': 0 } });
  const rows = x.broker.cacheSnapshot().querySettings;
  assert.deepEqual(rows.find((row) => row.key === '1502'), { key: '1502', label: 'S-meter', category: 'meters', overrideMs: 1000,
    configuredMs: 1000, effectiveMs: 300, source: 'telemetry', intervalMs: 100, maxAgeMs: 300 });
  assert.equal(rows.find((row) => row.key === '1507').effectiveMs, 0);
  assert.equal(rows.find((row) => row.key === '1507').source, 'cache');
  await x.step(0); x.at(301);
  const sample = x.broker.telemetrySnapshot().querySettings.find((row) => row.key === '1502');
  assert.equal(sample.sampleAgeMs, 301); assert.equal(sample.fresh, false);
});

test('100 ms safety observations still require a 500 ms stable RX span before automatic CW release', async (t) => {
  const x = await setup(t, { autoStartGraceMs: 0 });
  x.broker.owner = x.a; x.broker.lease = 'cw'; x.broker.activeTriggers.add('cw');
  x.broker.lastTxRequest = performance.now() - 2000; x.broker.cwDeadline = performance.now() - 1;
  for (let time = 0; time < 500; time += 100) { await x.step(time); assert.equal(x.broker.owner, x.a); }
  await x.step(500); await tick(); assert.equal(x.broker.owner, null);
  assert.equal(x.radio.commands.filter((b) => key(b) === '1c0000').length, 1);
});
