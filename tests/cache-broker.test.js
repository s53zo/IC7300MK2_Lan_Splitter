'use strict';
// Mock transport adapted from tests/broker.test.js; replies use MK2 data widths.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cmd = (payload, from = 0xe0) => Buffer.from([0xfe, 0xfe, 0xb6, from, ...payload, 0xfd]);
const answer = (payload, to = 0xe0) => Buffer.from([0xfe, 0xfe, to, 0xb6, ...payload, 0xfd]);
class Radio extends EventEmitter {
  constructor() {
    super(); this.connected = false; this.auto = true; this.commands = []; this.ptt = false;
    this.serial = this.audio = { invalidate() {} };
    this.playback = { setKeyed() {} };
  }
  sendCiv(bytes) { this.commands.push(Buffer.from(bytes)); if (this.auto) queueMicrotask(() => this.respond(bytes)); }
  respond(bytes = this.commands.at(-1)) {
    const p = [...bytes.subarray(4, -1)]; let result = [0xfb];
    if (p.length === 1 && p[0] === 3) result = [3, 0, 0x40, 7, 0x14, 0];
    if (p.length === 1 && p[0] === 4) result = [4, 1, 1];
    if ([0x14, 0x15].includes(p[0]) && p.length === 2) result = [...p, 0, 0x42];
    if (p[0] === 0x16 && p.length === 2) result = [...p, 0];
    if (p[0] === 0x1c && p.length === 2) result = [...p, p[1] === 0 ? +this.ptt : 0];
    if (p[0] === 0x1c && p[1] === 0 && p.length === 3) this.ptt = !!p[2];
    this.emit('civ', answer(result));
  }
  fail(error) { this.connected = false; this.emit('disconnected', error); }
}
class Server extends EventEmitter {
  constructor() { super(); this.sent = []; this.broadcast = []; }
  sendCiv(client, bytes) { this.sent.push({ client, bytes }); }
  broadcastCiv(bytes) { this.broadcast.push(bytes); }
  broadcastAudio() {}
}
async function setup(t, options = {}) {
  let clock = 0;
  const radio = new Radio(), server = new Server();
  const broker = new Broker(radio, server, { pollMs: 100000, requestTimeoutMs: 1000, now: () => clock, ...options });
  t.after(async () => { radio.auto = true; if (broker.pending) radio.respond(); await broker.close(); });
  const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  radio.commands.length = 0; server.sent.length = 0; server.broadcast.length = 0;
  const a = { id: 'a', active: true, mediaGeneration: 1 }, b = { id: 'b', active: true, mediaGeneration: 1 };
  return { radio, server, broker, a, b, at: (value) => { clock = value; }, send: (client, payload, from) => server.emit('command', client, cmd(payload, from)) };
}
const meter = [0x15, 2];

test('meter cache expires at the exact 100 ms boundary and returns private addressed replies', async (t) => {
  const { radio, server, broker, a, b, send, at } = await setup(t);
  send(a, meter, 0xe1); await tick(); at(99); send(b, meter, 0xe2); await tick();
  assert.equal(radio.commands.length, 1); assert.equal(server.sent[1].client, b); assert.equal(server.sent[1].bytes[2], 0xe2);
  assert.equal(server.broadcast.length, 0);
  at(100); send(a, meter); await tick(); assert.equal(radio.commands.length, 2);
  const snapshot = broker.cacheSnapshot();
  assert.equal(snapshot.enabled, true); assert.equal(snapshot.requests, 3); assert.equal(snapshot.hits, 1); assert.equal(snapshot.misses, 2);
  assert.ok(snapshot.entries >= 1); assert.equal(typeof snapshot.byQuery, 'object');
});

test('identical concurrent reads coalesce without sharing controller addresses', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t); radio.auto = false;
  send(a, meter, 0xe1); send(b, meter, 0xe2); assert.equal(radio.commands.length, 1); radio.respond();
  assert.equal(radio.commands.length, 1); assert.deepEqual(server.sent.map((x) => [x.client.id, x.bytes[2]]), [['a', 0xe1], ['b', 0xe2]]);
  assert.equal(broker.cacheSnapshot().coalesced, 1);
});

test('queued writes form barriers for coalescing and dispatch order', async (t) => {
  const { radio, server, a, b, send } = await setup(t); radio.auto = false;
  send(a, meter); send(a, [0x14, 1, 0, 0x50]); send(b, meter);
  radio.respond(); assert.equal(radio.commands[1][4], 0x14); assert.equal(server.sent.length, 1);
  radio.respond(); assert.equal(radio.commands[2][4], 0x15); radio.respond();
  assert.equal(server.sent.at(-1).client, b); assert.equal(radio.commands.length, 3);
});

test('mutation admission clears cached values before it reaches the radio', async (t) => {
  const { radio, broker, a, send } = await setup(t); send(a, meter); await tick();
  radio.auto = false; send(a, [4]); const epoch = broker.cacheSnapshot().epoch;
  send(a, [0x14, 1, 0, 0x50]);
  assert.equal(broker.cacheSnapshot().entries, 0); assert.ok(broker.cacheSnapshot().epoch > epoch);
  radio.respond(); radio.respond();
});

test('late pre-write replies cannot populate the new epoch', async (t) => {
  const { radio, broker, a, send } = await setup(t); radio.auto = false;
  send(a, meter); send(a, [0x14, 1, 0, 0x50]); radio.respond();
  assert.equal(broker.cacheSnapshot().entries, 0); radio.respond();
  send(a, meter); assert.equal(radio.commands.length, 3); radio.respond();
});

test('unknown admitted writes flush the cache', async (t) => {
  const { radio, broker, a, send } = await setup(t); send(a, meter); await tick();
  send(a, [0x30]); await tick(); assert.equal(broker.cacheSnapshot().entries, 0);
  send(a, meter); await tick(); assert.equal(radio.commands.length, 3);
});

test('invalid and queue-rejected writes do not invalidate existing cache entries', async (t) => {
  const { radio, broker, a, b, send } = await setup(t, { maxQueued: 1, maxPerClient: 4 });
  send(a, meter); await tick(); radio.auto = false; send(a, [4]); send(a, [0x16, 2]);
  const before = broker.cacheSnapshot(); send(b, [0x30]); send(b, [0x1c, 0, 1, 1]);
  assert.equal(broker.cacheSnapshot().epoch, before.epoch); assert.equal(broker.cacheSnapshot().entries, before.entries);
  radio.respond(); radio.respond();
});

test('unsolicited frequency and mode updates invalidate while waveform samples do not', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  for (const update of [[0, 0, 0x40, 7, 0x14, 0], [1, 1, 1]]) {
    send(a, meter); await tick(); const epoch = broker.cacheSnapshot().epoch;
    radio.emit('civ', answer([0x27, 0, 1, 2], 0)); assert.equal(broker.cacheSnapshot().epoch, epoch);
    radio.emit('civ', answer(update, 0)); assert.equal(broker.cacheSnapshot().entries, 0); assert.ok(broker.cacheSnapshot().epoch > epoch);
  }
});

test('queued cache hits still enforce client activity and media generation', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t); send(a, meter); await tick(); radio.auto = false;
  send(a, [4]); send(b, meter); b.mediaGeneration++; radio.respond();
  assert.equal(server.sent.some((x) => x.client === b), false); assert.equal(radio.commands.length, 2);
  const blocker = broker.internal([4]); // Always fresh, even with mode already cached.
  send(b, meter); b.active = false; server.emit('disconnect', b); radio.respond(); await blocker;
  assert.equal(server.sent.some((x) => x.client === b), false);
});

test('upstream reconnect flushes client entries including startup query results', async (t) => {
  const { radio, broker, a, send } = await setup(t); send(a, meter); await tick();
  radio.fail(new Error('link lost')); const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  assert.equal(broker.cacheSnapshot().entries, 0); radio.commands.length = 0;
  send(a, meter); await tick(); assert.equal(radio.commands.length, 1);
});

test('NG, malformed data and unrelated replies never become cached successes', async (t) => {
  const { radio, broker, a, send } = await setup(t); radio.auto = false;
  send(a, meter); radio.emit('civ', answer([0xfb])); radio.emit('civ', answer([0x15, 3, 0, 0x42]));
  radio.emit('civ', answer([0x15, 2, 0])); assert.equal(broker.cacheSnapshot().entries, 0);
  radio.emit('civ', answer([0xfa])); send(a, meter); assert.equal(radio.commands.length, 2);
  radio.emit('civ', answer([0x15, 2, 0xff, 0xff])); assert.equal(broker.cacheSnapshot().entries, 0);
  if (broker.pending) radio.emit('civ', answer([0xfa]));
  send(a, meter); assert.equal(radio.commands.length, 3); radio.respond();
});

test('internal state reads always transact freshly even with a client cached value', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  for (const payload of [[0x1c, 0], [0x1c, 1]]) {
    send(a, payload); await tick(); const before = radio.commands.length;
    await broker.internal(payload); await broker.internal(payload); assert.equal(radio.commands.length, before + 2);
  }
});

test('stable internal PTT polling can prime display cache but hits cannot change observed TX', async (t) => {
  const { radio, broker, a, send } = await setup(t); assert.equal(broker.cacheSnapshot().entries, 0);
  broker.poll(); await tick(); const before = radio.commands.length;
  broker.observedTx = true; send(a, [0x1c, 0]); await tick();
  assert.equal(radio.commands.length, before); assert.equal(broker.observedTx, true);
  send(a, [0x1c, 0, 1]); assert.equal(broker.owner, null); assert.equal(radio.commands.length, before);
});

test('release safety checks neither consume nor populate cached reads', async (t) => {
  const { radio, broker, a, send } = await setup(t); send(a, [4]); await tick();
  send(a, [0x1c, 0, 1]); await tick(); const before = radio.commands.length;
  await broker.release(); assert.ok(radio.commands.slice(before).some((x) => x[4] === 4));
  assert.ok(radio.commands.slice(before).some((x) => x[4] === 0x1c && x.length === 7));
  assert.equal(broker.cacheSnapshot().entries, 0);
});

test('entry limits are bounded and disabling cache retains physical read behavior', async (t) => {
  const { broker, a, send } = await setup(t, { maxCacheEntries: 2 });
  for (const payload of [meter, [0x14, 1], [0x16, 2]]) { send(a, payload); await tick(); }
  assert.equal(broker.cacheSnapshot().entries, 2);
  const other = await setup(t, { cacheEnabled: false }); other.send(other.a, meter); await tick(); other.send(other.a, meter); await tick();
  assert.equal(other.radio.commands.length, 2); assert.equal(other.broker.cacheSnapshot().enabled, false); assert.equal(other.broker.cacheSnapshot().entries, 0);
});

test('tuning and operator settings use their distinct exact TTL boundaries', async (t) => {
  for (const [payload, ttl] of [[[3], 50], [[0x14, 1], 250], [[0x1c, 1], 100]]) {
    const { radio, a, send, at } = await setup(t);
    send(a, payload); await tick(); at(ttl - 1); send(a, payload); await tick();
    assert.equal(radio.commands.length, 1, `cache remains valid before ${ttl}`);
    at(ttl); send(a, payload); await tick(); assert.equal(radio.commands.length, 2, `expires at ${ttl}`);
  }
});

test('a competing owner rejected mutation cannot invalidate a display cache', async (t) => {
  const { radio, broker, a, b, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick(); send(b, meter); await tick();
  const before = broker.cacheSnapshot(); send(b, [0x14, 1, 0, 0x50]);
  assert.equal(broker.cacheSnapshot().epoch, before.epoch); assert.equal(broker.cacheSnapshot().entries, before.entries);
  const count = radio.commands.length; send(b, meter); await tick(); assert.equal(radio.commands.length, count);
});

test('zero family TTL disables its sharing while other families still cache', async (t) => {
  const { radio, broker, a, b, send } = await setup(t, { cacheMetersMs: 0 });
  send(a, meter); send(b, meter); await tick();
  assert.equal(radio.commands.filter((x) => x[4] === 0x15).length, 2);
  send(a, [0x14, 1]); await tick(); send(b, [0x14, 1]); await tick();
  assert.equal(radio.commands.filter((x) => x[4] === 0x14).length, 1);
  assert.equal(broker.cacheSnapshot().hits, 1);
});

test('fresh internal TX observation invalidates stale client state and blocks new TX ownership', async (t) => {
  const { radio, broker, server, a, b, send } = await setup(t);
  send(a, [0x1c, 0]); await tick(); radio.ptt = true;
  send(b, [0x1c, 0]); await tick();
  assert.equal(server.sent.at(-1).bytes[6], 0, 'client display may use approved 100 ms value');
  const fresh = await broker.internal([0x1c, 0]);
  assert.equal(fresh[6], 1); assert.equal(broker.observedTx, true);
  assert.equal(broker.cacheSnapshot().entries, 0);
  send(b, [0x1c, 0, 1]); assert.equal(server.sent.at(-1).bytes[4], 0xfa);
  assert.equal(broker.owner, null);
});

test('directed asynchronous state updates invalidate without completing another query', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  send(a, meter); await tick(); radio.auto = false; send(a, [3]);
  radio.emit('civ', answer([0x16, 0x40, 1]));
  assert.equal(broker.cacheSnapshot().entries, 0);
  assert.ok(broker.pending, 'unsolicited status cannot complete frequency read');
  radio.respond();
});

test('a fresh failed read invalidates an earlier successful display value', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  send(a, [0x1c, 0]); await tick(); assert.equal(broker.cacheSnapshot().entries, 1);
  radio.auto = false;
  const checking = assert.rejects(broker.internal([0x1c, 0]), /rejected/);
  radio.emit('civ', answer([0xfa])); await checking;
  assert.equal(broker.cacheSnapshot().entries, 0);
});
