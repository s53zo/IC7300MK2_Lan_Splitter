'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Broker, FrameParser, classify } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cmd = (payload, from = 0xe0, to = 0xb6) => Buffer.from([0xfe, 0xfe, to, from, ...payload, 0xfd]);
const answer = (payload, to = 0xe0) => Buffer.from([0xfe, 0xfe, to, 0xb6, ...payload, 0xfd]);

class Radio extends EventEmitter {
  constructor() {
    super(); this.connected = false; this.commands = []; this.media = []; this.ptt = false; this.auto = true; this.invalidated = [];
    this.serial = { invalidate: (group) => this.invalidated.push(group) };
    this.audio = { invalidate: (group) => this.invalidated.push(group) };
    this.playback = { keyed: false, setKeyed: (on) => { this.playback.keyed = on; } };
  }
  sendCiv(bytes, options) {
    this.lastSendOptions = options;
    this.commands.push(Buffer.from(bytes));
    if (this.auto) queueMicrotask(() => this.respond(bytes));
  }
  respond(bytes = this.commands.at(-1)) {
    let payload = [0xfb];
    if (bytes[4] === 3) payload = [3, 0, 0x40, 7, 0x14, 0];
    if (bytes[4] === 4) payload = [4, 1, 1];
    if (bytes[4] === 0x1c && bytes[5] === 0) {
      if (bytes.length === 8) this.ptt = Boolean(bytes[6]);
      else payload = [0x1c, 0, +this.ptt];
    }
    if (bytes[4] === 0x17 && bytes[5] === 0xff) this.ptt = false;
    if (bytes[4] === 0x17 && bytes[5] !== 0xff) this.ptt = true;
    this.emit('civ', answer(payload));
  }
  sendAudio(bytes) { this.media.push(Buffer.from(bytes)); }
  fail(error) { this.failure = error; this.connected = false; this.emit('disconnected', error); }
}
class Server extends EventEmitter {
  constructor() { super(); this.sent = []; this.broadcast = []; this.audio = []; }
  sendCiv(client, bytes) { this.sent.push({ client, bytes }); }
  broadcastCiv(bytes) { this.broadcast.push(bytes); }
  broadcastAudio(bytes) { this.audio.push(bytes); }
}
async function setup(t, options = {}) {
  const radio = new Radio(), server = new Server();
  const broker = new Broker(radio, server, { pollMs: 10000, requestTimeoutMs: 500, ...options });
  t.after(() => broker.close());
  const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  radio.commands.length = 0; server.sent.length = 0;
  const a = { id: 'a', active: true }, b = { id: 'b', active: true };
  return { radio, server, broker, a, b, send: (client, payload, from) => server.emit('command', client, cmd(payload, from)) };
}

test('parser handles noise, fragmented and concatenated frames with bounded retained data', () => {
  const p = new FrameParser(64);
  assert.deepEqual(p.push(Buffer.from([1, 2, 0xfe])), []);
  assert.deepEqual(p.push(Buffer.from([0xfe, 0xb6, 0xe0, 3])), []);
  assert.deepEqual(p.push(Buffer.concat([Buffer.from([0xfd]), cmd([4])])), [cmd([3]), cmd([4])]);
  p.push(Buffer.from([0xfe, 0xfe, 1, 2])); p.push(Buffer.alloc(100)); assert.ok(p.buffer.length <= 64);
  assert.deepEqual(p.push(Buffer.concat([Buffer.from([0xfe, 0xfe, 1, 2]), cmd([3])])), [cmd([3])]);
  assert.deepEqual(p.push(Buffer.alloc(10000)), []);
});

test('classification distinguishes common reads, setters and autonomous TX triggers', () => {
  for (const payload of [[3], [4], [0x15, 2], [0x1a, 5, 0, 0x79], [0x1c, 0]]) assert.ok(classify(cmd(payload)).read);
  for (const payload of [[5, 1], [0x14, 1, 0], [0x1a, 5, 0, 0x79, 0], [0x30]]) assert.equal(classify(cmd(payload)).read, false);
  assert.equal(classify(cmd([0x1c, 0, 1])).tx, 'ptt');
  assert.equal(classify(cmd([0x1c, 1, 2])).tx, 'tuner');
  assert.equal(classify(cmd([0x17, 65])).tx, 'cw');
  assert.equal(classify(cmd([0x16, 0x46, 1])).tx, 'vox');
  assert.ok(classify(cmd([0x17, 0xff])).release);
});

test('startup confirms receive state before clients may execute commands', async (t) => {
  const radio = new Radio(), server = new Server(), client = { id: 1, active: true };
  const broker = new Broker(radio, server, { pollMs: 10000 }); t.after(() => broker.close());
  server.emit('command', client, cmd([5, 1])); assert.equal(server.sent[0].bytes[4], 0xfa);
  const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  assert.deepEqual(radio.commands.map((b) => [...b.subarray(4, -1)]), [[0x17, 0xff], [0x1c, 0, 0], [0x1c, 0], [0x27, 0x10, 1], [0x27, 0x11, 1]]);
  assert.ok(broker.ready);
});

test('shared-address clients receive only their own ACKs and queries in arrival order', async (t) => {
  const { radio, server, a, b, send } = await setup(t);
  radio.auto = false;
  send(a, [5, 1], 0xe1); send(b, [6, 2]);
  assert.equal(radio.commands.length, 1); assert.equal(radio.commands[0][3], 0xe0);
  radio.emit('civ', answer([0xfb]));
  assert.equal(server.sent.length, 1); assert.equal(server.sent[0].client, a); assert.equal(server.sent[0].bytes[2], 0xe1);
  assert.equal(radio.commands.length, 2); radio.emit('civ', answer([0xfb]));
  assert.equal(server.sent[1].client, b);
  send(a, [3]); send(b, [4]);
  radio.respond(); radio.respond();
  assert.equal(server.sent[2].bytes[4], 3); assert.equal(server.sent[2].client, a);
  assert.equal(server.sent[3].bytes[4], 4); assert.equal(server.sent[3].client, b);
  assert.ok(server.broadcast.every((bytes) => bytes[2] === 0 && [0, 1].includes(bytes[4])));
});

test('echo, scope and unrelated replies cannot finish a pending query', async (t) => {
  const { radio, server, broker, a, send } = await setup(t);
  radio.auto = false; send(a, [0x1a, 5, 0, 0x79]);
  radio.emit('civ', cmd([0x1a, 5, 0, 0x79]));
  radio.emit('civ', answer([0x27, 0, 1, 2]));
  radio.emit('civ', answer([0x1a, 5, 0, 0x80, 0]));
  radio.emit('civ', answer([0xfb]));
  assert.ok(broker.pending); assert.equal(server.sent.length, 0); assert.equal(server.broadcast.length, 1);
  radio.emit('civ', answer([0x1a, 5, 0, 0x79, 0]));
  assert.equal(broker.pending, null); assert.equal(server.sent.length, 1);
});

test('TX owner blocks competing audio, mutations and keying while retaining read access', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick(); assert.equal(broker.owner, a);
  send(b, [5, 1]); send(b, [0x1c, 0, 1]); send(b, [0x17, 65]);
  server.emit('audio', b, Buffer.alloc(8, 1)); server.emit('audio', a, Buffer.alloc(8, 2));
  assert.equal(radio.media.length, 1); assert.equal(radio.media[0][0], 2);
  send(b, [3]); await tick();
  assert.equal(server.sent.filter((x) => x.client === b && x.bytes[4] === 0xfa).length, 3);
  assert.ok(server.sent.some((x) => x.client === b && x.bytes[4] === 3));
  send(a, [0x1c, 0, 0]); await tick();
  assert.equal(broker.owner, null); assert.equal(broker.releasing, false);
  assert.ok(!radio.playback.keyed);
  send(b, [3]); await tick();
  assert.equal(radio.commands.filter((x) => x[4] === 5).length, 0);
});

test('commands queued after a TX request are checked again and discarded', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t);
  radio.auto = false; send(b, [3]); send(a, [0x1c, 0, 1]); send(b, [5, 2]);
  radio.respond(); // completes earlier read, executes first TX, drops later setter.
  assert.equal(broker.owner, a); assert.equal(radio.commands.length, 2);
  radio.respond(); assert.equal(radio.commands.length, 2);
  assert.ok(server.sent.some((x) => x.client === b && x.bytes[4] === 0xfa));
  radio.auto = true;
});

test('owner loss invalidates retransmits, releases PTT/CW and confirms RX before handover', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick();
  radio.auto = false; a.active = false; server.emit('disconnect', a);
  assert.ok(broker.releasing); assert.equal(broker.owner, a);
  send(b, [0x1c, 0, 1]); assert.equal(server.sent.at(-1).bytes[4], 0xfa);
  assert.ok(['audio', 'cw', 'ptt'].every((group) => radio.invalidated.includes(group)));
  radio.respond(); await tick(); radio.respond(); await tick();
  assert.equal(broker.owner, a); // PTT-off ACK is insufficient.
  radio.respond(); await tick(); assert.equal(broker.owner, null);
  radio.auto = true; send(b, [0x1c, 0, 1]); await tick(); assert.equal(broker.owner, b);
});

test('client disappearance drains in-flight reply without delivering it to the next client', async (t) => {
  const { radio, server, a, b, send } = await setup(t);
  radio.auto = false; send(a, [5, 1]); send(b, [6, 2]); a.active = false; server.emit('disconnect', a);
  radio.emit('civ', answer([0xfb])); assert.equal(server.sent.length, 0);
  radio.emit('civ', answer([0xfb])); assert.equal(server.sent.length, 1); assert.equal(server.sent[0].client, b);
});

test('timeout resets upstream and never replays queued or old TX work after reconnect', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t, { requestTimeoutMs: 15 });
  radio.auto = false; send(a, [0x1c, 0, 1]); send(b, [3]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(radio.failure); assert.equal(broker.ready, false); assert.equal(broker.owner, null);
  const before = radio.commands.length;
  radio.emit('civ', answer([0xfb])); assert.equal(radio.commands.length, before);
  radio.auto = true; const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  assert.deepEqual(radio.commands.slice(before).map((x) => [...x.subarray(4, -1)]), [[0x17, 0xff], [0x1c, 0, 0], [0x1c, 0], [0x27, 0x10, 1], [0x27, 0x11, 1]]);
  assert.ok(server.sent.some((x) => x.client === a && x.bytes[4] === 0xfa));
});

test('slow or flooding clients cannot grow command queues without bounds', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t, { maxQueued: 3, maxPerClient: 2 });
  radio.auto = false; send(a, [3]); send(a, [3]); send(a, [3]); send(b, [4]); send(b, [4]); send(b, [4]);
  assert.ok(broker.queue.length <= 3);
  assert.equal(server.sent.filter((x) => x.bytes[4] === 0xfa).length, 2);
  radio.auto = true; while (broker.pending) { radio.respond(); await tick(); }
});

test('CW completion is observed before releasing its automatic lease', async (t) => {
  const { radio, broker, a, send } = await setup(t, { pollMs: 10, autoStartGraceMs: 10 });
  send(a, [0x17, 65]); await tick(); assert.equal(broker.owner, a);
  radio.ptt = false;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(broker.owner, a); // A quiet gap does not imply the buffered text ended.
  broker.cwDeadline = performance.now() - 1; // Advance the conservative text clock in this unit test.
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(broker.owner, null);
});

test('VOX is a persistent TX lease and is disabled on owner loss', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t);
  send(a, [0x16, 0x46, 1]); await tick(); assert.equal(broker.owner, a);
  radio.ptt = false; broker.poll(); await tick(); assert.equal(broker.owner, a);
  send(b, [0x14, 1, 0]); assert.equal(server.sent.at(-1).bytes[4], 0xfa);
  a.active = false; server.emit('disconnect', a); await tick();
  assert.ok(radio.commands.some((x) => x.subarray(4, -1).equals(Buffer.from([0x16, 0x46, 0]))));
  assert.equal(broker.owner, null);
});

test('RX audio and unsolicited shared state are distributed without becoming transactions', async (t) => {
  const { radio, server } = await setup(t);
  const pcm = Buffer.from([1, 2, 3, 4]); radio.emit('rx-audio', pcm);
  radio.emit('civ', answer([0, 0, 0x40, 7, 0x14, 0], 0));
  assert.deepEqual(server.audio, [pcm]); assert.equal(server.broadcast.length, 1);
});


test('scope subscriptions remain enabled when one client disables its output', async (t) => {
  const { radio, server, a, b, send } = await setup(t);
  send(a, [0x27, 0x11, 0]); send(b, [0x27, 0x10, 1]); send(a, [0x27, 0x11]);
  assert.equal(radio.commands.length, 0);
  assert.equal(server.sent[0].bytes[4], 0xfb);
  assert.equal(server.sent[1].bytes[4], 0xfb);
  assert.deepEqual([...server.sent[2].bytes.subarray(4, -1)], [0x27, 0x11, 1]);
  radio.emit('civ', answer([0x27, 0, 1, 2]));
  assert.equal(server.broadcast.length, 1);
});

test('retired transactions cannot be retransmitted after their replies', async (t) => {
  const { radio, a, send } = await setup(t);
  radio.invalidated.length = 0;
  send(a, [0x1c, 1, 2]); await tick();
  assert.deepEqual(radio.lastSendOptions, { group: 'transaction' });
  assert.ok(radio.invalidated.includes('transaction'));
});

test('custom advertised CI-V address is used before startup cleanup', async (t) => {
  const radio = new Radio(), server = new Server(); radio.advertisedAddress = 0x94;
  const original = radio.respond.bind(radio);
  radio.respond = (bytes) => { const emit = radio.emit.bind(radio); radio.emit = (name, data) => { if (name === 'civ') data[3] = 0x94; return emit(name, data); }; original(bytes); radio.emit = emit; };
  const broker = new Broker(radio, server, { pollMs: 10000 }); t.after(() => broker.close());
  const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  assert.ok(radio.commands.every((bytes) => bytes[2] === 0x94));
});


test('malformed TX initiators cannot bypass ownership classification', async (t) => {
  const { radio, server, a, send } = await setup(t);
  send(a, [0x1c, 0, 1, 1]); send(a, [0x1c, 1, 2, 0]); send(a, [0x16, 0x46, 1, 0]);
  assert.equal(radio.commands.length, 0);
  assert.equal(server.sent.length, 3);
  assert.ok(server.sent.every((item) => item.bytes[4] === 0xfa));
});

test('scope is addressed as broadcast so clients with different controllers receive it', async (t) => {
  const { radio, server } = await setup(t);
  radio.emit('civ', answer([0x27, 0, 1, 2]));
  assert.equal(server.broadcast.at(-1)[2], 0);
});


test('lease acquisition and release retire downstream media and queued reorder work', async (t) => {
  const { server, broker, a, send } = await setup(t);
  const retired = [];
  server.retireAudio = (client) => retired.push(['audio', client]);
  server.retireClientWork = (client) => retired.push(['all', client]);
  send(a, [0x1c, 0, 1]); await tick();
  assert.deepEqual(retired[0], ['audio', a]);
  send(a, [0x1c, 0, 0]); await tick();
  assert.ok(retired.some(([kind, client]) => kind === 'all' && client === a));
  assert.equal(broker.owner, null);
});


test('voice memory and tuner acquire exclusive leases and issue specific stop commands', async (t) => {
  const { radio, server, broker, a, b, send } = await setup(t);
  send(a, [0x28, 0, 1]); await tick();
  assert.equal(broker.owner, a); assert.equal(broker.lease, 'voice');
  send(b, [0x1c, 0, 1]); assert.equal(server.sent.at(-1).bytes[4], 0xfa);
  a.active = false; server.emit('disconnect', a); await tick();
  assert.ok(radio.commands.some((x) => x.subarray(4, -1).equals(Buffer.from([0x28, 0, 0]))));
  assert.equal(broker.owner, null);
  send(b, [0x1c, 1, 2]); await tick(); assert.equal(broker.lease, 'tuner');
  b.active = false; server.emit('disconnect', b); await tick();
  assert.ok(radio.commands.some((x) => x.subarray(4, -1).equals(Buffer.from([0x1c, 1, 0]))));
});

test('uncertain VOX writes retain cleanup obligations across an upstream timeout', async (t) => {
  const { radio, broker, a, send } = await setup(t, { requestTimeoutMs: 15 });
  radio.auto = false; send(a, [0x16, 0x46, 1]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(broker.txObligations.has('vox'));
  const before = radio.commands.length;
  radio.auto = true; const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
  assert.ok(radio.commands.slice(before).some((x) => x.subarray(4, -1).equals(Buffer.from([0x16, 0x46, 0]))));
  assert.equal(broker.txObligations.size, 0);
});

test('regranted media generation never receives earlier replies or queued work', async (t) => {
  const { radio, server, a, send } = await setup(t);
  a.mediaGeneration = 1; radio.auto = false;
  send(a, [3]); send(a, [5, 1]);
  a.mediaGeneration = 2;
  radio.respond();
  assert.equal(server.sent.length, 0);
  assert.equal(radio.commands.length, 1);
  radio.auto = true;
});


test('partial client frames are discarded at TX retirement and upstream reconnect', async (t) => {
  const { radio, server, broker, a, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick();
  server.emit('command', a, cmd([5, 1]).subarray(0, -1));
  await broker.release();
  const before = radio.commands.length;
  server.emit('command', a, Buffer.from([0xfd]));
  assert.equal(radio.commands.length, before);
  server.emit('command', a, cmd([5, 1]).subarray(0, -1));
  radio.fail(new Error('link down'));
  assert.equal(broker.parsers.get(a).buffer.length, 0);
});

test('voice repeat lease is not handed over during silent playback intervals', async (t) => {
  const { radio, broker, a, send } = await setup(t, { pollMs: 10, autoStartGraceMs: 1 });
  send(a, [0x28, 0, 1]); await tick(); radio.ptt = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(broker.owner, a);
  send(a, [0x28, 0, 0]); await tick(); assert.equal(broker.owner, null);
});


test('disabling VOX does not unexpectedly release an explicit PTT transmission', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  send(a, [0x16, 0x46, 1]); await tick();
  send(a, [0x1c, 0, 1]); await tick();
  send(a, [0x16, 0x46, 0]); await tick();
  assert.equal(broker.owner, a); assert.equal(broker.lease, 'ptt'); assert.ok(radio.ptt);
  assert.equal(broker.txObligations.has('vox'), false);
});


test('PTT then VOX enable/disable retains explicit PTT and owner audio', async (t) => {
  const { radio, server, broker, a, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick();
  send(a, [0x16, 0x46, 1]); await tick();
  assert.equal(broker.lease, 'ptt');
  send(a, [0x16, 0x46, 0]); await tick();
  assert.equal(broker.owner, a); assert.equal(broker.lease, 'ptt'); assert.ok(radio.ptt);
  server.emit('audio', a, Buffer.alloc(8, 4)); assert.equal(radio.media.length, 1);
  send(a, [0x1c, 0, 0]); await tick(); assert.equal(broker.owner, null);
});

test('stopping a voice or tuner source does not erase another active source', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick();
  send(a, [0x28, 0, 1]); await tick();
  send(a, [0x1c, 1, 2]); await tick();
  send(a, [0x28, 0, 0]); await tick();
  send(a, [0x1c, 1, 0]); await tick();
  assert.equal(broker.owner, a); assert.equal(broker.lease, 'ptt'); assert.ok(radio.ptt);
  assert.deepEqual([...broker.activeTriggers], ['ptt']);
});


test('a rejected extra TX initiator does not cancel existing explicit PTT', async (t) => {
  const { radio, broker, a, send } = await setup(t);
  send(a, [0x1c, 0, 1]); await tick();
  radio.auto = false; send(a, [0x28, 0, 1]); radio.emit('civ', answer([0xfa]));
  assert.equal(broker.owner, a); assert.equal(broker.lease, 'ptt'); assert.ok(radio.ptt);
  assert.equal(broker.txObligations.has('voice'), false);
  radio.auto = true;
});


test('selected-VFO setters keep ACK private and broadcast shared frequency and mode', async (t) => {
  const { radio, server, a, b, send } = await setup(t);
  const frequency = [0, 0x40, 7, 0x14, 0];
  send(a, [0x25, 0, ...frequency], 0xe1); await tick();
  assert.equal(server.sent.length, 1); assert.equal(server.sent[0].client, a);
  assert.equal(server.sent[0].bytes[2], 0xe1); assert.equal(server.sent[0].bytes[4], 0xfb);
  assert.deepEqual(server.broadcast[0], answer([0, ...frequency], 0));
  send(b, [0x25, 1, ...frequency]); await tick();
  assert.equal(server.broadcast.length, 1); // Unselected VFO never replaces the selected frequency.
  send(a, [0x26, 0, 1, 1, 2]); await tick();
  assert.equal(server.sent.at(-1).client, a); assert.equal(server.sent.at(-1).bytes[4], 0xfb);
  assert.deepEqual(server.broadcast[1], answer([1, 1, 2], 0));
  assert.deepEqual(server.broadcast[2], answer([0x26, 0, 1, 1, 2], 0));
  send(b, [0x26, 1, 3, 0, 1]); await tick(); assert.equal(server.broadcast.length, 3);
  assert.equal(radio.commands.length, 4);
});

test('selected-VFO read reply remains private while distributing shared state', async (t) => {
  const { radio, server, a, send } = await setup(t);
  radio.auto = false;
  const frequency = [0, 0x40, 7, 0x14, 0];
  send(a, [0x25, 0], 0xe1);
  radio.emit('civ', answer([0x25, 0, ...frequency]));
  assert.equal(server.sent.length, 1); assert.equal(server.sent[0].client, a);
  assert.equal(server.sent[0].bytes[2], 0xe1);
  assert.deepEqual([...server.sent[0].bytes.subarray(4, -1)], [0x25, 0, ...frequency]);
  assert.deepEqual(server.broadcast[0], answer([0, ...frequency], 0));
  send(a, [0x26, 0]); radio.emit('civ', answer([0x26, 0, 3, 0, 1]));
  assert.equal(server.sent.length, 2); assert.equal(server.sent[1].bytes[4], 0x26);
  assert.deepEqual(server.broadcast[1], answer([1, 3, 1], 0));
  radio.auto = true;
});

test('CW completion bound includes maximum dash weighting at the slowest keying speed', async (t) => {
  const { broker, a, send } = await setup(t);
  const before = performance.now(); send(a, [0x17, 0x30, 0x30]); await tick();
  assert.ok(broker.cwDeadline >= before + 12000);
});
