'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { NativeServer } = require('../src/server');

// Independent native client fixture: deliberately imports no production wire
// encoder, credential function or session implementation.
function envelope(length, type, sender, receiver = 0, seq = 0) {
  const p = Buffer.alloc(length);
  p.writeUInt32LE(length); p.writeUInt16LE(type, 4); p.writeUInt16LE(seq & 65535, 6);
  p.writeUInt32BE(sender, 8); p.writeUInt32BE(receiver, 12);
  return p;
}
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message = 'condition') {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) { const result = fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out waiting for ${message}`);
}

class Client {
  constructor(address) { this.address = address; this.channels = {}; this.inner = 0; }
  async bind() {
    for (const [index, role] of ['control', 'civ', 'audio'].entries()) {
      const socket = dgram.createSocket('udp4');
      const channel = this.channels[role] = { socket, id: 0xa0000100 + index, remote: 0, seq: 1, inbox: [] };
      socket.on('message', (packet) => channel.inbox.push(Buffer.from(packet)));
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    }
    return this;
  }
  send(role, p) { this.channels[role].socket.send(p, this.address[`${role}Port`], '127.0.0.1'); }
  packet(role, len, type = 0) { const c = this.channels[role]; return envelope(len, type, c.id, c.remote, type === 0 ? c.seq++ : 0); }
  async handshake(role) {
    const c = this.channels[role];
    this.send(role, envelope(16, 3, c.id));
    const here = await until(() => c.inbox.find((p) => p.readUInt16LE(4) === 4), 'HERE');
    c.remote = here.readUInt32BE(8);
    this.send(role, envelope(16, 6, c.id, c.remote, 1));
    await until(() => c.inbox.find((p) => p.readUInt16LE(4) === 6), 'READY');
  }
  innerPacket(length, kind) {
    const p = this.packet('control', length);
    p.writeUInt32BE(length - 16, 16); p[20] = 1; p[21] = kind; p.writeUInt16BE(this.inner++, 22);
    if (this.auth) this.auth.copy(p, 26);
    return p;
  }
  async login(valid = true) {
    await this.handshake('control');
    const p = this.innerPacket(128, 0);
    p.writeUInt16LE(0x1234, 26);
    // Published AetherSDR testPasscode vector for synthetic credential "beer".
    const credential = Buffer.from('2b3f555c000000000000000000000000', 'hex');
    credential.copy(p, 64); credential.copy(p, 80);
    if (!valid) p[80] ^= 1;
    p.write('fixture', 96);
    this.send('control', p);
    const reply = await until(() => this.channels.control.inbox.find((x) => x.length === 96), 'login response');
    this.auth = Buffer.from(reply.subarray(26, 32));
    return reply;
  }
  async capabilities() {
    const request = this.innerPacket(64, 2);
    this.send('control', request);
    const caps = await until(() => this.channels.control.inbox.find((p) => p.length === 168), 'capabilities');
    this.guid = Buffer.from(caps.subarray(66, 82));
    return caps;
  }
  streamRequest(codec = 4) {
    const p = this.innerPacket(144, 3);
    this.guid.copy(p, 32); p[112] = p[113] = 1; p[114] = p[115] = codec;
    p.writeUInt32BE(48000, 116); p.writeUInt32BE(48000, 120);
    p.writeUInt32BE(this.channels.civ.socket.address().port, 124);
    p.writeUInt32BE(this.channels.audio.socket.address().port, 128);
    return p;
  }
  async connect() {
    await this.bind(); await this.login(); await this.capabilities();
    this.send('control', this.streamRequest());
    await until(() => this.channels.control.inbox.find((p) => p.length === 80), 'stream status');
    await this.handshake('civ'); await this.handshake('audio');
    const open = this.packet('civ', 22); open[16] = 0xc0; open[17] = 1; open[21] = 5;
    this.send('civ', open);
    await pause();
    return this;
  }
  civ(bytes) {
    const p = this.packet('civ', 21 + bytes.length); p[16] = 0xc1;
    p.writeUInt16LE(bytes.length, 17); bytes.copy(p, 21); return p;
  }
  audio(bytes) {
    const p = this.packet('audio', 24 + bytes.length); p.writeUInt16BE(0x8000, 16);
    p.writeUInt16BE(bytes.length, 22); bytes.copy(p, 24); return p;
  }
  close() { for (const c of Object.values(this.channels)) c.socket.close(); }
}

async function fixture(t, options = {}) {
  const server = new NativeServer({ bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0,
    username: 'beer', password: 'beer', ...options });
  await server.start(); t.after(() => server.close());
  return server;
}
async function client(t, server) { const c = await new Client(server.address()).connect(); t.after(() => c.close()); return c; }

test('native server advertises literal MK2 capabilities and both client grant formats', async (t) => {
  const server = await fixture(t);
  const c = await client(t, server);
  const packets = c.channels.control.inbox;
  const login = packets.find((p) => p.length === 96);
  assert.equal(login[20], 1); assert.equal(login[21], 0); assert.equal(login.readUInt32BE(48), 0);
  assert.equal(login.subarray(64, 68).toString(), 'FTTH');
  const caps = packets.find((p) => p.length === 168);
  assert.equal(caps[20], 2); assert.equal(caps[21], 2); assert.equal(caps.readUInt16BE(64), 1);
  assert.equal(caps[148], 0xb6); assert.equal(caps.readUInt16BE(149), 8);
  assert.equal(caps.readUInt16BE(151), 8);
  const status = packets.find((p) => p.length === 80);
  assert.equal(status[20], 2); assert.equal(status[21], 3);
  assert.equal(status.readUInt16BE(66), server.address().civPort);
  assert.equal(status.readUInt16BE(70), server.address().audioPort);
  assert.ok(packets.some((p) => p.length === 144 && p.readUInt32LE(96) === 0));
  assert.ok(packets.some((p) => p.length === 144 && p.readUInt32LE(96) === 1));
});

test('same-IP clients have exact independent media associations and shared controller addresses', async (t) => {
  const server = await fixture(t), a = await client(t, server), b = await client(t, server);
  const commands = [], media = [];
  server.on('command', (owner, bytes) => commands.push({ owner, bytes }));
  server.on('audio', (owner, bytes) => media.push({ owner, bytes }));
  const frame = Buffer.from('fefeb6e003fd', 'hex');
  a.send('civ', a.civ(frame)); b.send('civ', b.civ(frame));
  await until(() => commands.length === 2);
  assert.notEqual(commands[0].owner.id, commands[1].owner.id);
  const pcm = Buffer.from([1, 2, 3, 4]); a.send('audio', a.audio(pcm)); b.send('audio', b.audio(pcm));
  await until(() => media.length === 2);
  assert.notEqual(media[0].owner.id, media[1].owner.id);
  assert.deepEqual(media[0].bytes, pcm);
  assert.equal(server.clients.size, 2);
  const clients = [...server.clients.values()];
  assert.notEqual(clients[0].streams.civ.localId, clients[1].streams.civ.localId);
  server.sendCiv(clients[0], frame);
  await until(() => a.channels.civ.inbox.some((p) => p[16] === 0xc1));
  assert.equal(b.channels.civ.inbox.some((p) => p[16] === 0xc1), false);
  server.broadcastCiv(frame); server.broadcastAudio(pcm);
  await until(() => b.channels.civ.inbox.some((p) => p[16] === 0xc1) && b.channels.audio.inbox.some((p) => p.length === 28));
  assert.deepEqual(b.channels.audio.inbox.find((p) => p.length === 28).subarray(24), pcm);
});

test('rejected credentials cannot negotiate capabilities or associate media', async (t) => {
  const server = await fixture(t);
  const c = await new Client(server.address()).bind(); t.after(() => c.close());
  const reply = await c.login(false);
  assert.equal(reply.readUInt32BE(48), 0xfffffffe);
  c.send('control', c.innerPacket(64, 2));
  c.send('civ', envelope(16, 3, c.channels.civ.id));
  await pause(30);
  assert.equal(c.channels.control.inbox.some((p) => p.length === 168), false);
  assert.equal(c.channels.civ.inbox.length, 0);
  assert.equal(server.peers.civ.size, 0);
});

test('unsupported audio is explicitly rejected without opening streams', async (t) => {
  const server = await fixture(t);
  const c = await new Client(server.address()).bind(); t.after(() => c.close());
  await c.login(); await c.capabilities(); c.send('control', c.streamRequest(2));
  const status = await until(() => c.channels.control.inbox.find((p) => p.length === 80));
  assert.equal(status.readUInt32LE(48), 0xffffffff);
  assert.equal([...server.clients.values()][0].granted, false);
  assert.equal(server.stats.rejectedFormats, 1);
});

test('control duplicate requests preserve token and do not create duplicate clients', async (t) => {
  const server = await fixture(t), c = await client(t, server);
  const owner = [...server.clients.values()][0], token = Buffer.from(owner.authId);
  const request = c.innerPacket(64, 5);
  c.send('control', request); c.send('control', request);
  await until(() => c.channels.control.inbox.filter((p) => p.length === 64 && p[21] === 5).length === 2);
  assert.deepEqual(owner.authId, token); assert.equal(server.clients.size, 1);
  assert.equal(owner.responses.size, 4);
});

test('duplicate CI-V does not execute twice; missing packet is reordered', async (t) => {
  const server = await fixture(t), c = await client(t, server);
  const commands = []; server.on('command', (_owner, bytes) => commands.push(bytes));
  const one = c.civ(Buffer.from('fefeb6e003fd', 'hex'));
  const two = c.civ(Buffer.from('fefeb6e004fd', 'hex'));
  c.send('civ', two); c.send('civ', two); await pause(15);
  assert.equal(commands.length, 0);
  c.send('civ', one);
  await until(() => commands.length === 2);
  assert.equal(commands[0][4], 3); assert.equal(commands[1][4], 4);
});

test('client replay and source-ID filtering are independent across same-IP clients', async (t) => {
  const server = await fixture(t), a = await client(t, server), b = await client(t, server);
  const frame = Buffer.from('fefee0b603fd', 'hex'); server.broadcastCiv(frame);
  const packet = await until(() => a.channels.civ.inbox.find((p) => p[16] === 0xc1));
  a.send('civ', envelope(16, 1, a.channels.civ.id, a.channels.civ.remote, packet.readUInt16LE(6)));
  await until(() => a.channels.civ.inbox.filter((p) => p.equals(packet)).length === 2);
  assert.equal(b.channels.civ.inbox.filter((p) => p.equals(packet)).length, 0);
  const before = server.stats.unauthenticated;
  const wrong = a.civ(Buffer.from('fefeb6e003fd', 'hex')); wrong.writeUInt32BE(0xff, 8); a.send('civ', wrong);
  await until(() => server.stats.unauthenticated > before);
});

test('only expired client disconnects and all its streams are removed', async (t) => {
  let now = 0; const server = await fixture(t, { now: () => now, timeoutMs: 1000 });
  await client(t, server); await client(t, server);
  const [a, b] = [...server.clients.values()];
  const disconnected = []; server.on('disconnect', (c) => disconnected.push(c.id));
  now = 1001; for (const stream of Object.values(b.streams)) stream.lastRx = now;
  server.tick(); assert.deepEqual(disconnected, [a.id]);
  assert.equal(server.clients.size, 1);
  for (const peers of Object.values(server.peers)) assert.equal(peers.size, 1);
});

test('buffers and queued UDP sends have explicit byte and packet bounds', async (t) => {
  const server = await fixture(t, { maxPackets: 3 }), c = await client(t, server);
  server.options.maxPendingBytes = 64;
  const owner = [...server.clients.values()][0];
  for (let i = 0; i < 20; i++) server.sendCiv(owner, Buffer.from('fefee0b603fd', 'hex'));
  assert.equal(owner.streams.civ.replay.size, 3);
  assert.ok(owner.streams.civ.pendingBytes <= 64);
  assert.ok(owner.streams.civ.dropped > 0);
  assert.ok(c);
});

test('media release retains authenticated control and permits a fresh stream request', async (t) => {
  const server = await fixture(t), c = await client(t, server);
  const owner = [...server.clients.values()][0];
  assert.equal(owner.mediaGeneration, 0);
  const released = []; server.on('disconnect', (peer) => released.push(peer.id));
  const request = c.innerPacket(64, 4); c.send('control', request);
  await until(() => !owner.granted);
  assert.equal(owner.active, true); assert.equal(owner.authenticated, true);
  assert.equal(owner.mediaGeneration, 1);
  assert.equal(server.clients.size, 1); assert.deepEqual(released, [owner.id]);
  assert.equal(server.peers.civ.size, 0); assert.equal(server.peers.audio.size, 0);
  assert.equal(owner.responses.size, 0);
  c.send('control', c.streamRequest());
  await until(() => owner.granted);
  assert.equal(server.clients.size, 1);
});

test('a cached token-renewal retry refreshes lease without rotating token', async (t) => {
  let now = 0;
  const server = await fixture(t, { now: () => now, tokenTimeoutMs: 1000 });
  const c = await client(t, server), owner = [...server.clients.values()][0];
  const request = c.innerPacket(64, 5);
  now = 400; c.send('control', request); await until(() => owner.lastAuth === 400);
  now = 900; c.send('control', request); await until(() => owner.lastAuth === 900);
  now = 1400; server.tick(); assert.equal(owner.active, true);
  now = 1901; server.tick(); assert.equal(owner.active, false);
});

test('two control sessions cannot claim the same authenticated media endpoint', async (t) => {
  const server = await fixture(t), a = await client(t, server);
  const b = await new Client(server.address()).bind(); t.after(() => b.close());
  await b.login(); await b.capabilities();
  const request = b.streamRequest();
  request.writeUInt32BE(a.channels.civ.socket.address().port, 124);
  b.send('control', request);
  const status = await until(() => b.channels.control.inbox.find((p) => p.length === 80));
  assert.equal(status.readUInt32LE(48), 0xffffffff);
  const active = [...server.clients.values()].filter((c) => c.granted);
  assert.equal(active.length, 1);
  assert.equal(server.stats.rejectedAssociations, 1);
});

test('invalid lengths and ungranted media cannot allocate peer state', async (t) => {
  const server = await fixture(t), c = await new Client(server.address()).bind(); t.after(() => c.close());
  c.send('control', Buffer.alloc(2));
  const malformed = envelope(16, 3, 0x1234); malformed.writeUInt32LE(17); c.send('control', malformed);
  c.send('civ', envelope(16, 3, 0x1234));
  await until(() => server.stats.malformed === 2 && server.stats.rejectedAssociations === 1);
  assert.equal(server.clients.size, 0); assert.equal(server.peers.civ.size, 0);
});

test('audio lease boundary retires buffered packets and rejects late gap fills', async (t) => {
  const server = await fixture(t), c = await client(t, server), owner = [...server.clients.values()][0];
  const audio = []; server.on('audio', (_client, pcm) => audio.push(pcm.readUInt16LE()));
  const packet = (n) => c.audio(Buffer.from([n, 0]));
  const one = packet(1), two = packet(2), three = packet(3), four = packet(4);
  c.send('audio', one); await until(() => audio.length === 1);
  c.send('audio', three); await until(() => owner.streams.audio.reorder.size === 1);
  server.retireAudio(owner);
  assert.equal(owner.streams.audio.lastDelivered, three.readUInt16LE(6));
  assert.equal(owner.streams.audio.reorder.size, 0);
  c.send('audio', two); c.send('audio', four);
  await until(() => audio.length === 2);
  assert.deepEqual(audio, [1, 4]);
});

test('client-work retirement rejects buffered CI-V keying and late missing commands', async (t) => {
  const server = await fixture(t), c = await client(t, server), owner = [...server.clients.values()][0];
  const commands = []; server.on('command', (_client, bytes) => commands.push(bytes[4]));
  const one = c.civ(Buffer.from('fefeb6e003fd', 'hex'));
  const two = c.civ(Buffer.from('fefeb6e0050040071400fd', 'hex'));
  const three = c.civ(Buffer.from('fefeb6e01c0001fd', 'hex'));
  const four = c.civ(Buffer.from('fefeb6e004fd', 'hex'));
  c.send('civ', one); await until(() => commands.length === 1);
  c.send('civ', three); await until(() => owner.streams.civ.reorder.size === 1);
  server.retireClientWork(owner);
  assert.equal(owner.streams.civ.lastDelivered, three.readUInt16LE(6));
  c.send('civ', two); c.send('civ', four);
  await until(() => commands.length === 2);
  assert.deepEqual(commands, [3, 4]);
});

test('lease retirement advances sequence watermark across wrap', async (t) => {
  const server = await fixture(t), c = await client(t, server), owner = [...server.clients.values()][0];
  const audio = []; server.on('audio', (_client, pcm) => audio.push(pcm.readUInt16LE()));
  c.channels.audio.seq = 65534;
  const one = c.audio(Buffer.from([1, 0])), two = c.audio(Buffer.from([2, 0]));
  const three = c.audio(Buffer.from([3, 0])), four = c.audio(Buffer.from([4, 0]));
  c.send('audio', one); await until(() => audio.length === 1);
  c.send('audio', three); await until(() => owner.streams.audio.reorder.size === 1);
  server.retireAudio(owner); assert.equal(owner.streams.audio.lastDelivered, 0);
  c.send('audio', two); c.send('audio', four);
  await until(() => audio.length === 2);
  assert.deepEqual(audio, [1, 4]);
});

test('malformed native TX audio identifiers cannot inject PCM', async (t) => {
  const server = await fixture(t), c = await client(t, server);
  const media = [];
  server.on('audio', (_owner, pcm) => media.push(pcm));
  const malformed = c.audio(Buffer.from([1, 2]));
  malformed.writeUInt16BE(0x1234, 16);
  c.send('audio', malformed);
  const good = Buffer.from([3, 4]);
  c.send('audio', c.audio(good));
  await until(() => media.length === 1);
  assert.deepEqual(media, [good]);
  assert.ok(server.stats.malformed > 0);
});
