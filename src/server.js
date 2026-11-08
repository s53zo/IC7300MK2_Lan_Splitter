'use strict';

// SPDX-License-Identifier: AGPL-3.0-only
// Native packet shapes follow wfview's GPL Icom server/packettypes and PiRO's
// LAN transport. See NOTICE.md for provenance and license texts.
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const { IcomStream } = require('./icom-lan/stream');
const P = require('./icom-lan/protocol');

const endpoint = (address, port) => `${address}:${port}`;

// A server association shares a listening socket, but never sequence/replay
// state. The authenticated control request binds media to exact source ports.
class Peer extends IcomStream {
  constructor(server, role, remote, sender) {
    super({ host: remote.address, port: remote.port, role,
      timeoutMs: server.options.timeoutMs, reorderMs: server.options.reorderMs,
      maxPackets: server.options.maxPackets, now: server.options.now });
    this.server = server;
    this.remoteId = sender;
    this.socket = server.sockets[role];
    this.pendingBytes = 0;
    this.dropped = 0;
    const now = this.now();
    this.startedAt = this.lastRx = this.lastHandshake = this.lastIdle = this.lastPing = now;
    this.on('failure', () => server.disconnect(this.client));
  }

  handshake() { this.raw(P.packet(16, P.TYPE.HERE, this.localId, this.remoteId)); }

  raw(p, onSent) {
    if (!this.socket || this.failed) { onSent?.(); return; }
    if (this.pendingBytes + p.length > this.server.options.maxPendingBytes) { this.dropped++; onSent?.(); return; }
    this.pendingBytes += p.length;
    this.socket.send(p, this.port, this.host, (err) => {
      this.pendingBytes -= p.length;
      if (err && this.socket) this.fail('Client UDP send failed');
      onSent?.();
    });
  }

  receive(p) {
    const h = P.header(p);
    if (h && h.type === P.TYPE.READY && p.length === 16 && h.receiver === this.localId && h.sender === this.remoteId) {
      this.lastRx = this.now();
      this.ready = true;
      this.raw(P.packet(16, P.TYPE.READY, this.localId, this.remoteId, 1));
      return;
    }
    super.receive(p);
  }

  retireInbound() {
    // A lease boundary retires packets already observed, including ones held
    // behind a gap. Merely clearing reorder would let a late gap-fill revive
    // old keying/audio on a later lease in the same native association.
    let watermark = this.lastDelivered;
    for (const seq of this.reorder.keys()) {
      if (watermark === null || P.after(seq, watermark)) watermark = seq;
    }
    this.counters.retired = (this.counters.retired || 0) + this.reorder.size;
    this.lastDelivered = watermark;
    this.reorder.clear();
    this.gapSince = undefined;
  }

  close() {
    if (this.socket && !this.failed) this.raw(P.packet(16, P.TYPE.DISCONNECT, this.localId, this.remoteId));
    this.socket = null;
    this.ready = false;
    this.replay.clear();
    this.reorder.clear();
  }
}

class NativeServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { bindAddress: '0.0.0.0', controlPort: 50001, civPort: 50002, audioPort: 50003,
      timeoutMs: 15000, tokenTimeoutMs: 90000, preAuthTimeoutMs: 10000, preAuthMemoryBudgetBytes: 8 * 1024 * 1024, reorderMs: 80, maxPackets: 256,
      maxPendingBytes: 256 * 1024, memoryBudgetBytes: 128 * 1024 * 1024,
      radioName: 'IC-7300MK2', radioAddress: 0xb6, now: () => performance.now(), ...options };
    // Retain only the wire credential comparison vectors on this side.
    this.username = P.passcode(this.options.username);
    this.password = P.passcode(this.options.password);
    delete this.options.username;
    delete this.options.password;
    for (const name of ['controlPort', 'civPort', 'audioPort']) {
      if (!Number.isInteger(this.options[name]) || this.options[name] < 0 || this.options[name] > 65535) throw new Error(`Invalid ${name}`);
    }
    const ports = [this.options.controlPort, this.options.civPort, this.options.audioPort].filter(Boolean);
    if (new Set(ports).size !== ports.length) throw new Error('Listening ports must be distinct');
    for (const name of ['timeoutMs', 'tokenTimeoutMs', 'preAuthTimeoutMs', 'reorderMs', 'maxPackets', 'maxPendingBytes', 'memoryBudgetBytes', 'preAuthMemoryBudgetBytes']) {
      if (!Number.isFinite(this.options[name]) || this.options[name] <= 0) throw new Error(`Invalid ${name}`);
    }
    for (const name of ['maxPackets', 'maxPendingBytes', 'memoryBudgetBytes', 'preAuthMemoryBudgetBytes']) {
      if (!Number.isSafeInteger(this.options[name])) throw new Error(`Invalid ${name}`);
    }
    // Before login only this control stream exists: no media or inbound
    // reorder queue, and outbound responses are at most 96 bytes. Include
    // bounded replay/response metadata and association overhead as well as
    // queued UDP sends. This pool is additional to memoryBudgetBytes.
    this.preAuthReservationBytes = this.options.maxPendingBytes
      + this.options.maxPackets * (96 + 64) + 64 * (96 + 160) + 4096;
    this.radioId = this.options.radioId ? Buffer.from(this.options.radioId) : randomBytes(16);
    if (this.radioId.length !== 16) throw new Error('radioId must be 16 bytes');
    this.clients = new Map();
    this.peers = { control: new Map(), civ: new Map(), audio: new Map() };
    this.sockets = {};
    this.started = false;
    this.stats = { malformed: 0, unauthenticated: 0, rejectedFormats: 0, rejectedAssociations: 0, resourceRejects: 0, preAuthEvictions: 0, preAuthExpired: 0 };
  }

  async start() {
    if (this.started) return this;
    try {
      for (const role of ['control', 'civ', 'audio']) {
        const socket = this.sockets[role] = dgram.createSocket('udp4');
        socket.on('message', (p, remote) => this.receive(role, p, remote));
        await new Promise((resolve, reject) => {
          socket.once('error', reject);
          socket.bind(this.options[`${role}Port`], this.options.bindAddress, () => { socket.off('error', reject); resolve(); });
        });
        socket.on('error', () => this.emit('failure', new Error(`${role} listener failed`)));
      }
      this.started = true;
      this.timer = setInterval(() => this.tick(), 20);
      return this;
    } catch (err) { await this.close(); throw err; }
  }

  address() {
    return { host: this.options.bindAddress, controlPort: this.sockets.control.address().port,
      civPort: this.sockets.civ.address().port, audioPort: this.sockets.audio.address().port };
  }

  receive(role, p, remote) {
    const h = P.header(p);
    if (!h || !h.sender) { this.stats.malformed++; return; }
    const key = endpoint(remote.address, remote.port);
    let peer = this.peers[role].get(key);
    if (peer && this.preAuthExpired(peer.client)) {
      this.stats.preAuthExpired++;
      this.disconnect(peer.client);
      return;
    }
    if (h.type === P.TYPE.THERE && p.length === 16 && h.receiver === 0) {
      if (peer && peer.remoteId !== h.sender) return;
      if (!peer) {
        let client;
        if (role === 'control') {
          // Discovery gets a separate bounded control-only pool. Eviction
          // cannot displace an authenticated client or consume its reservation.
          const reserve = this.preAuthReservationBytes;
          if (reserve > this.options.preAuthMemoryBudgetBytes) { this.stats.resourceRejects++; return; }
          const waiting = [...this.clients.values()].filter((c) => !c.authenticated);
          while ((waiting.length + 1) * reserve > this.options.preAuthMemoryBudgetBytes) {
            this.stats.preAuthEvictions++;
            this.disconnect(waiting.shift());
          }
          client = { id: randomBytes(8).toString('hex'), active: true, authenticated: false,
            granted: false, createdAt: this.options.now(), address: remote.address, streams: {}, responses: new Map(), serialSeq: 0, audioSeq: 0, mediaGeneration: 0 };
          this.clients.set(client.id, client);
        } else {
          const matching = [...this.clients.values()].filter((c) => c.active && c.authenticated && c.granted
            && c.address === remote.address && c[`${role}Port`] === remote.port);
          if (matching.length !== 1) { this.stats.rejectedAssociations++; return; }
          client = matching[0];
          if (client.streams[role]) return;
        }
        peer = new Peer(this, role, remote, h.sender);
        peer.client = client;
        client.streams[role] = peer;
        peer.on('payload', (data) => this.payload(client, role, data));
        this.peers[role].set(key, peer);
      }
      peer.lastRx = this.options.now();
      peer.handshake();
      return;
    }
    if (!peer || peer.remoteId !== h.sender || peer.localId !== h.receiver) { this.stats.unauthenticated++; return; }
    peer.receive(p);
  }

  payload(client, role, p) {
    if (!client.active) return;
    if (role === 'control') { this.control(client, p); return; }
    if (!client.authenticated || !client.granted) return;
    if (role === 'civ') {
      if (p.length === 22 && p[16] === 0xc0) {
        if (p[21] === 5) client.serialOpen = true;
        else if (p[21] === 0) this.disconnect(client);
        return;
      }
      const bytes = P.serialPayload(p);
      if (bytes) { client.serialOpen = true; this.emit('command', client, Buffer.from(bytes)); }
    } else if (role === 'audio' && client.txEnable) {
      // Native LPCM TX uses 80 00. RX identifiers can differ, so enforce
      // this only at the authenticated downstream transmit boundary.
      if (p.length < 24 || p.readUInt16BE(16) !== 0x8000) { this.stats.malformed++; return; }
      const pcm = P.audioPayload(p);
      if (pcm) this.emit('audio', client, Buffer.from(pcm));
    }
  }

  response(client, length, requestType, requestReply = 2, input) {
    const stream = client.streams.control;
    const p = P.packet(length, P.TYPE.IDLE, stream.localId, stream.remoteId);
    p.writeUInt32BE(length - 16, 16);
    p[20] = requestReply;
    p[21] = requestType;
    if (input) input.copy(p, 22, 22, 24);
    if (client.authId) client.authId.copy(p, 26);
    return p;
  }

  capabilities(client, input) {
    const p = this.response(client, 168, 2, 2, input);
    p.writeUInt16BE(1, 64);
    this.radioId.copy(p, 66);
    p.write(this.options.radioName.slice(0, 31), 82, 'ascii');
    p.write('ICOM_VAUDIO', 114, 'ascii');
    p[146] = 0x3f; p[147] = 7;
    p[148] = this.options.radioAddress;
    p.writeUInt16BE(8, 149); p.writeUInt16BE(8, 151); // 48 kHz only
    p[153] = p[154] = p[155] = 1;
    p.writeUInt32BE(115200, 156);
    p[160] = 1; p[161] = 0x50; p[163] = 0x90; p[164] = 1;
    return p;
  }

  connectionInfo(client, busy = false) {
    const p = this.response(client, 144, 0, 3);
    this.radioId.copy(p, 32);
    p.write(this.options.radioName.slice(0, 31), 64, 'ascii');
    p.writeUInt32LE(busy ? 1 : 0, 96);
    if (busy) {
      p.write(client.name || 'client', 100, 15, 'ascii');
      Buffer.from(client.address.split('.').map(Number)).copy(p, 132);
    }
    return p;
  }

  preAuthExpired(client) {
    return !client.authenticated && this.options.now() - client.createdAt >= this.options.preAuthTimeoutMs;
  }

  control(client, p) {
    if (client.rejectingLogin) return;
    if (![64, 128, 144].includes(p.length) || p[20] !== 1) return;
    const key = createHash('sha256').update(p.subarray(16)).digest('hex');
    if (client.authenticated && this.options.now() - client.lastAuth >= this.options.tokenTimeoutMs) { this.disconnect(client); return; }
    const cached = client.responses.get(key);
    if (cached) {
      if (client.authenticated && p.length === 64 && p[21] === 5 && timingSafeEqual(p.subarray(26, 32), client.authId)) client.lastAuth = this.options.now();
      for (const reply of cached) client.streams.control.tracked(Buffer.from(reply));
      return;
    }
    const replies = [];
    if (p.length === 128 && p[21] === 0) {
      // A second distinct login cannot replace an established session token.
      if (client.authenticated) return;
      const valid = timingSafeEqual(p.subarray(64, 80), this.username) && timingSafeEqual(p.subarray(80, 96), this.password);
      client.authId = Buffer.concat([p.subarray(26, 28), randomBytes(4)]);
      const reply = this.response(client, 96, 0, 1, p);
      reply.write('FTTH', 64, 'ascii');
      const reserve = this.options.maxPackets * 4096 * 6 + this.options.maxPendingBytes * 3;
      const authenticated = [...this.clients.values()].filter((c) => c.authenticated).length;
      if (valid && (authenticated + 1) * reserve > this.options.memoryBudgetBytes) {
        this.stats.resourceRejects++;
        client.rejectingLogin = true;
        reply.writeUInt32BE(0xfffffffe, 48);
        // Finish queuing the native rejection before closing this association.
        const peer = client.streams.control;
        reply.writeUInt16LE(peer.txSeq++ & 65535, 6);
        peer.raw(reply, () => this.disconnect(client));
        return;
      }
      if (!valid) reply.writeUInt32BE(0xfffffffe, 48);
      else { client.authenticated = true; client.lastAuth = this.options.now(); client.name = p.subarray(96, 112).toString('ascii').split('\0')[0]; }
      replies.push(reply);
      if (!valid) this.stats.unauthenticated++;
    } else {
      if (!client.authenticated || !timingSafeEqual(p.subarray(26, 32), client.authId)) { this.stats.unauthenticated++; return; }
      if (p.length === 64) {
        const kind = p[21];
        if (kind === 2) replies.push(this.capabilities(client, p), this.connectionInfo(client));
        else if (kind === 5) { client.lastAuth = this.options.now(); replies.push(this.response(client, 64, kind, 2, p)); }
        else if (kind === 1 || kind === 4) {
          const reply = this.response(client, 64, kind, 2, p);
          client.streams.control.tracked(reply);
          if (kind === 1) this.disconnect(client);
          else { this.releaseMedia(client); client.streams.control.tracked(this.connectionInfo(client)); }
          return;
        }
      } else if (p.length === 144 && p[21] === 3) {
        const civPort = p.readUInt32BE(124), audioPort = p.readUInt32BE(128);
        const formatOK = (!p[112] || (p[114] === 4 && p.readUInt32BE(116) === 48000))
          && (!p[113] || (p[115] === 4 && p.readUInt32BE(120) === 48000));
        const portsOK = civPort > 0 && civPort <= 65535 && audioPort > 0 && audioPort <= 65535 && civPort !== audioPort;
        const radioOK = p.subarray(32, 48).equals(this.radioId);
        const conflicts = [...this.clients.values()].some((c) => c !== client && c.active && c.granted && c.address === client.address
          && (c.civPort === civPort || c.audioPort === audioPort));
        let accepted = false;
        const grant = this.response(client, 80, 3, 2, p);
        this.radioId.copy(grant, 32);
        if (!formatOK || !portsOK || !radioOK || conflicts) {
          grant.writeUInt32LE(0xffffffff, 48);
          this.stats[!formatOK ? 'rejectedFormats' : 'rejectedAssociations']++;
        } else {
          // Changing requested ports requires a new control session so old
          // replay history cannot migrate to another producer.
          if (client.granted && (client.civPort !== civPort || client.audioPort !== audioPort)) return;
          client.civPort = civPort; client.audioPort = audioPort;
          client.rxEnable = Boolean(p[112]); client.txEnable = Boolean(p[113]); client.granted = true; accepted = true;
          grant.writeUInt16BE(this.address().civPort, 66);
          grant.writeUInt16BE(this.address().audioPort, 70);
        }
        replies.push(grant);
        if (accepted) replies.push(this.connectionInfo(client, true));
      }
    }
    if (!replies.length) return;
    client.responses.set(key, replies.map((reply) => Buffer.from(reply)));
    while (client.responses.size > 64) client.responses.delete(client.responses.keys().next().value);
    for (const reply of replies) client.streams.control.tracked(reply);
  }

  sendCiv(client, bytes) {
    const peer = client?.streams.civ;
    if (!client?.active || !client.granted || !peer?.ready || !client.serialOpen) return;
    peer.tracked(P.serial(peer.localId, peer.remoteId, client.serialSeq++ & 65535, bytes));
  }

  broadcastCiv(bytes) { for (const client of this.clients.values()) this.sendCiv(client, bytes); }

  broadcastAudio(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 4072) throw new Error('Expected aligned 48 kHz mono PCM audio');
    for (const client of this.clients.values()) {
      const peer = client.streams.audio;
      if (client.active && client.granted && client.rxEnable && peer?.ready) peer.tracked(P.audio(peer.localId, peer.remoteId, client.audioSeq++ & 65535, pcm));
    }
  }

  retireAudio(client) { client?.streams.audio?.retireInbound(); }

  retireClientWork(client) {
    this.retireAudio(client);
    client?.streams.civ?.retireInbound();
  }

  releaseMedia(client) {
    ++client.mediaGeneration;
    const hadMedia = client.granted;
    client.granted = false;
    client.serialOpen = false;
    for (const role of ['civ', 'audio']) {
      const peer = client.streams[role];
      if (!peer) continue;
      this.peers[role].delete(endpoint(peer.host, peer.port));
      peer.close();
      delete client.streams[role];
    }
    client.responses.clear();
    if (hadMedia) this.emit('disconnect', client);
  }

  disconnect(client) {
    if (!client?.active) return;
    client.active = false;
    this.clients.delete(client.id);
    for (const [role, peer] of Object.entries(client.streams)) {
      this.peers[role].delete(endpoint(peer.host, peer.port));
      peer.close();
    }
    client.responses.clear();
    this.emit('disconnect', client);
  }

  tick() {
    const now = this.options.now();
    for (const client of this.clients.values()) {
      if (this.preAuthExpired(client)) { this.stats.preAuthExpired++; this.disconnect(client); continue; }
      if (client.authenticated && now - client.lastAuth >= this.options.tokenTimeoutMs) { this.disconnect(client); continue; }
      for (const peer of Object.values(client.streams)) { if (client.active) peer.tick(); }
    }
  }

  async close() {
    clearInterval(this.timer);
    for (const client of [...this.clients.values()]) this.disconnect(client);
    await Promise.all(Object.values(this.sockets).map((socket) => new Promise((resolve) => {
      try { socket.close(resolve); } catch { resolve(); }
    })));
    this.sockets = {};
    this.started = false;
  }
}

module.exports = { NativeServer };
