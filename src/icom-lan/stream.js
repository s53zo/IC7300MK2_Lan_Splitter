'use strict';

const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const P = require('./protocol');

const TRANSPORT_COUNTERS = Object.freeze(['malformed', 'stale', 'duplicates', 'lost', 'replayed',
  'sendDrops', 'sendErrors', 'sendCompleted', 'payloadStalls']);

// One RS-BA1 UDP association. Each control/serial/audio stream has its own
// socket, random ID, sequence space, replay history and bounded reorder queue.
class IcomStream extends EventEmitter {
  constructor({ host, port, role, localPort = 0, bindAddress = '0.0.0.0', now = () => performance.now(),
    handshakeMs = 500, timeoutMs = 15000, reorderMs = 80, maxPackets = 256,
    maxPendingBytes = 256 * 1024, maxPendingPackets = 256, recoverPayloadStall = false,
    payloadStallMs = 2000, payloadStallPackets = 32 } = {}) {
    super();
    Object.assign(this, { host, port, role, localPort, bindAddress, now, handshakeMs, timeoutMs, reorderMs, maxPackets });
    Object.assign(this, { maxPendingBytes, maxPendingPackets, recoverPayloadStall, payloadStallMs, payloadStallPackets });
    for (const name of ['maxPendingBytes', 'maxPendingPackets', 'payloadStallPackets']) {
      if (!Number.isSafeInteger(this[name]) || this[name] <= 0) throw new Error(`Invalid Icom LAN ${name}`);
    }
    if (!Number.isFinite(payloadStallMs) || payloadStallMs <= 0) throw new Error('Invalid Icom LAN payloadStallMs');
    this.localId = randomBytes(4).readUInt32BE();
    this.remoteId = 0;
    this.socket = null;
    this.ready = false;
    this.txSeq = 1; // zero at startup makes a radio infer a preceding wrap.
    this.pingSeq = 0;
    this.lastDelivered = null;
    this.replay = new Map();
    this.reorder = new Map();
    this.counters = Object.fromEntries(TRANSPORT_COUNTERS.map((key) => [key, 0]));
    this.statisticsEpoch = 0;
    this.outstanding = new Map();
    this.outstandingBytes = this.outstandingSends = 0;
    this.pendingMediaBytes = this.pendingMediaSends = 0;
    this.resetPing();
  }

  resetPing() {
    this.pendingPings = new Map();
    this.pingReplies = [];
    this.pingSamples = 0;
    this.lastPingMs = this.pingMeasuredAt = null;
  }

  expirePings(now) {
    // Match only recent requests from this association. This map never
    // retains packet contents and stays bounded even if a peer never echoes.
    for (const [seq, sent] of this.pendingPings) {
      if (now - sent.at >= Math.min(this.timeoutMs, 5000)) this.pendingPings.delete(seq);
    }
  }

  pingSnapshot() {
    const now = this.now();
    this.expirePings(now);
    return { lastMs: this.lastPingMs,
      averageMs: this.pingReplies.length ? this.pingReplies.reduce((sum, ms) => sum + ms, 0) / this.pingReplies.length : null,
      samples: this.pingSamples, measuredAt: this.pingMeasuredAt,
      stale: !this.ready || this.failed === true || this.pingMeasuredAt === null
        || now - this.pingMeasuredAt >= Math.min(this.timeoutMs, 2000) };
  }

  observePingReply(seq, stamp) {
    const now = this.now();
    this.expirePings(now);
    const sent = this.pendingPings.get(seq);
    if (!sent || sent.stamp !== stamp) return;
    this.pendingPings.delete(seq);
    const ms = now - sent.at;
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastPingMs = ms;
    this.pingMeasuredAt = now;
    ++this.pingSamples;
    this.pingReplies.push(ms);
    if (this.pingReplies.length > 64) this.pingReplies.shift();
  }

  async bind() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (p) => this.receive(p));
    await new Promise((resolve, reject) => {
      const fail = (err) => reject(err);
      this.socket.once('error', fail);
      this.socket.bind(this.localPort, this.bindAddress, () => {
        this.socket.connect(this.port, this.host, () => {
          this.socket.off('error', fail);
          this.socket.on('error', () => this.fail(`${this.role} UDP socket error`));
          this.localPort = this.socket.address().port;
          resolve();
        });
      });
    });
  }

  start() {
    const t = this.now();
    this.resetPing();
    this.unusablePayload = undefined;
    this.lastHeartbeatRx = undefined;
    this.startedAt = this.lastRx = this.lastHandshake = t;
    this.lastIdle = this.lastPing = t;
    this.handshake();
    this.timer = setInterval(() => this.tick(), 20);
  }

  handshake() {
    const p = P.packet(16, this.remoteId ? P.TYPE.READY : P.TYPE.THERE, this.localId, this.remoteId, this.remoteId ? 1 : 0);
    this.raw(p);
    this.raw(p);
  }

  raw(p) {
    const socket = this.socket;
    if (!socket || this.closing) return false;
    const bytes = p.length;
    const media = this.role === 'audio' && bytes > 16 && p.readUInt16LE(4) === P.TYPE.IDLE;
    if (this.role === 'audio' && (media
      ? this.pendingMediaBytes + bytes > this.maxPendingBytes || this.pendingMediaSends >= this.maxPendingPackets
      : this.outstandingBytes - this.pendingMediaBytes + bytes > 4096 || this.outstandingSends - this.pendingMediaSends >= 64)) {
      ++this.counters.sendDrops;
      return false;
    }
    // Metadata only: there is no application media queue to drain after a
    // lease ends. Already submitted UDP datagrams cannot be recalled.
    const token = {}, epoch = this.statisticsEpoch;
    this.outstanding.set(token, { bytes, media });
    this.outstandingBytes += bytes;
    ++this.outstandingSends;
    if (media) { this.pendingMediaBytes += bytes; ++this.pendingMediaSends; }
    const done = (err) => {
      if (!this.outstanding.delete(token)) return;
      this.outstandingBytes -= bytes;
      --this.outstandingSends;
      if (media) { this.pendingMediaBytes -= bytes; --this.pendingMediaSends; }
      if (epoch === this.statisticsEpoch) {
        ++this.counters.sendCompleted;
        if (err) ++this.counters.sendErrors;
      }
      if (err && this.socket === socket && !this.closing) this.fail(`${this.role} UDP send failed`);
    };
    try { socket.send(p, done); }
    catch (err) { done(err); return false; }
    return true;
  }

  resetStatistics() {
    ++this.statisticsEpoch;
    for (const key of Object.keys(this.counters)) this.counters[key] = 0;
  }

  tracked(p, { group, append = false } = {}) {
    if (!this.ready) throw new Error(`${this.role} stream is disconnected`);
    if (group && !append) this.invalidate(group);
    const seq = this.txSeq;
    this.txSeq = (seq + 1) & 0xffff;
    p.writeUInt16LE(seq, 6);
    this.replay.delete(seq);
    this.replay.set(seq, { packet: p, group });
    while (this.replay.size > this.maxPackets) this.replay.delete(this.replay.keys().next().value);
    if (this.raw(p) === false) {
      const retained = this.replay.get(seq);
      if (retained) retained.packet = null;
    }
    return seq;
  }

  invalidate(group) {
    for (const retained of this.replay.values()) if (retained.group === group) retained.packet = null;
  }

  receive(p) {
    if (this.failed || this.closing) return;
    const h = P.header(p);
    if (!h) { this.counters.malformed++; return; }
    if (h.receiver !== this.localId || (this.remoteId && h.sender !== this.remoteId)) {
      this.counters.stale++;
      return;
    }
    if (!this.remoteId) {
      if (h.type !== P.TYPE.HERE || p.length !== 16 || !h.sender) return;
      this.remoteId = h.sender;
      this.lastRx = this.now();
      this.handshake();
      return;
    }
    this.lastRx = this.now();
    if (!this.ready) {
      if (h.type === P.TYPE.READY && p.length === 16) {
        this.ready = true;
        this.emit('ready');
      }
      return;
    }
    if (h.type === P.TYPE.PING && p.length === 21) {
      if (p[16] === 0 || p[16] === 1) this.lastHeartbeatRx = this.now();
      if (p[16] === 0) {
        const reply = P.packet(21, P.TYPE.PING, this.localId, this.remoteId, h.seq);
        reply[16] = 1;
        p.copy(reply, 17, 17, 21);
        this.raw(reply);
      } else if (p[16] === 1) this.observePingReply(h.seq, p.readUInt32LE(17));
      return;
    }
    if (h.type === P.TYPE.DISCONNECT) { this.fail(`${this.role} stream closed by radio`); return; }
    if (h.type === P.TYPE.RETRANSMIT) {
      const ranges = p.length === 16 ? [[h.seq, h.seq]] : [];
      for (let at = 16; at + 4 <= p.length; at += 4) {
        const a = p.readUInt16LE(at), b = p.readUInt16LE(at + 2);
        if (a || b) ranges.push([a, b]);
      }
      let budget = 10;
      for (const [a, b] of ranges) {
        for (let n = 0; n <= P.distance(b, a) && budget-- > 0; n++) {
          const seq = (a + n) & 0xffff;
          this.raw(this.replay.get(seq)?.packet || P.packet(16, 0, this.localId, this.remoteId, seq));
          this.counters.replayed++;
        }
        if (budget <= 0) break;
      }
      return;
    }
    if (h.type !== P.TYPE.IDLE) return;
    // The reference clients dispatch control replies directly. Their inner
    // request/token correlation is authoritative; control notifications do
    // not share the media streams' ordered delivery contract (some peers
    // reuse outer sequence zero). Session handlers deduplicate by meaning.
    if (this.role === 'control') { this.deliver(p); return; }
    if (this.lastDelivered === null) {
      this.lastDelivered = h.seq;
      this.deliver(p);
    } else if (P.after(h.seq, this.lastDelivered)) {
      if (!this.reorder.has(h.seq)) this.reorder.set(h.seq, p);
      this.drain();
      if (this.reorder.size && this.gapSince === undefined) this.gapSince = this.now();
      if (this.reorder.size > this.maxPackets) this.skipGap();
    } else {
      this.counters.duplicates++;
      this.observeUnusablePayload(p, h.seq);
    }
  }

  observeUnusablePayload(p, seq) {
    // Only the upstream audio association opts in. Server peers retain their
    // receive watermark across leases; changing it could revive stale TX.
    if (!this.recoverPayloadStall || this.role !== 'audio' || !P.audioPayload(p)
      || P.distance(seq, this.lastDelivered) < 0x8000) return;
    const now = this.now();
    let stalled = this.unusablePayload;
    if (!stalled || now - stalled.lastAt >= this.payloadStallMs) {
      stalled = this.unusablePayload = { since: now, lastAt: now, seq, packets: 1 };
    } else if (P.after(seq, stalled.seq)) { stalled.seq = seq; stalled.lastAt = now; ++stalled.packets; }
    else return; // Repeated replay of one packet is not fresh media progress.
    if (now - stalled.since >= this.payloadStallMs && stalled.packets >= this.payloadStallPackets
      && this.lastHeartbeatRx !== undefined && now - this.lastHeartbeatRx < Math.min(this.timeoutMs, 2000)) {
      ++this.counters.payloadStalls;
      this.fail('audio sequence progress stalled; renewing Icom LAN association');
    }
  }

  deliver(p) {
    if (p.length > 16) {
      if (this.role === 'audio' && P.audioPayload(p)) this.unusablePayload = undefined;
      this.emit('payload', p);
    }
  }

  drain() {
    let next = (this.lastDelivered + 1) & 0xffff;
    while (this.reorder.has(next)) {
      const p = this.reorder.get(next);
      this.reorder.delete(next);
      this.lastDelivered = next;
      this.deliver(p);
      next = (next + 1) & 0xffff;
    }
    if (!this.reorder.size) this.gapSince = undefined;
  }

  nearest() {
    let best, distance = 0x10000;
    for (const seq of this.reorder.keys()) {
      const d = P.distance(seq, this.lastDelivered);
      if (d < distance) { distance = d; best = seq; }
    }
    return best;
  }

  skipGap() {
    const seq = this.nearest();
    if (seq === undefined) return;
    const lost = P.distance(seq, this.lastDelivered) - 1;
    this.counters.lost += lost;
    this.emit('lost', lost);
    this.lastDelivered = (seq - 1) & 0xffff;
    this.gapSince = undefined;
    this.drain();
    if (this.reorder.size) this.gapSince = this.now();
  }

  tick() {
    if (this.failed || this.closing) return;
    const now = this.now();
    if (now - this.lastRx >= this.timeoutMs) { this.fail(`${this.role} stream timed out; check radio address, ports and Network Control`); return; }
    if (!this.ready) {
      if (now - this.lastHandshake >= this.handshakeMs) { this.lastHandshake = now; this.handshake(); }
      return;
    }
    if (now - this.lastPing >= 500) {
      this.lastPing = now;
      const p = P.packet(21, P.TYPE.PING, this.localId, this.remoteId, this.pingSeq++ & 0xffff);
      p.writeUInt32LE(Math.floor(now) >>> 0, 17);
      this.expirePings(now);
      this.pendingPings.set(p.readUInt16LE(6), { at: now, stamp: p.readUInt32LE(17) });
      while (this.pendingPings.size > 32) this.pendingPings.delete(this.pendingPings.keys().next().value);
      this.raw(p);
    }
    if (this.role !== 'audio' && now - this.lastIdle >= 100) {
      this.lastIdle = now;
      this.tracked(P.packet(16, 0, this.localId, this.remoteId));
    }
    if (this.gapSince !== undefined && now - this.gapSince >= this.reorderMs) {
      if (now - this.gapSince >= this.reorderMs * 2) this.skipGap();
      else {
        const count = Math.min(10, P.distance(this.nearest(), this.lastDelivered) - 1);
        for (let n = 1; n <= count; n++) this.raw(P.packet(16, P.TYPE.RETRANSMIT, this.localId, this.remoteId, (this.lastDelivered + n) & 0xffff));
      }
    }
  }

  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.resetPing();
    this.emit('failure', new Error(message));
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    clearInterval(this.timer);
    this.resetPing();
    const socket = this.socket;
    if (socket && this.remoteId) this.raw(P.packet(16, P.TYPE.DISCONNECT, this.localId, this.remoteId));
    this.closing = true;
    this.socket = null;
    this.ready = false;
    this.replay.clear();
    this.reorder.clear();
    this.outstanding.clear();
    this.outstandingBytes = this.outstandingSends = this.pendingMediaBytes = this.pendingMediaSends = 0;
    if (socket) this.closePromise = new Promise((resolve) => { try { socket.close(resolve); } catch { resolve(); } });
    return this.closePromise;
  }
}

module.exports = { IcomStream, TRANSPORT_COUNTERS };
