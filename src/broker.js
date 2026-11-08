'use strict';

// SPDX-License-Identifier: AGPL-3.0-only
const { EventEmitter } = require('node:events');

const PREAMBLE = Buffer.from([0xfe, 0xfe]);
const controller = 0xe0;

class FrameParser {
  constructor(maxBytes = 4096) { this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); }
  reset() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length > this.maxBytes * 2) { this.reset(); return []; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length) {
      const start = this.buffer.indexOf(PREAMBLE);
      if (start < 0) {
        this.buffer = this.buffer.at(-1) === 0xfe ? Buffer.from([0xfe]) : Buffer.alloc(0);
        break;
      }
      this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(0xfd, 2);
      const restart = this.buffer.indexOf(PREAMBLE, 2);
      if (restart >= 0 && (end < 0 || restart < end)) { this.buffer = this.buffer.subarray(restart); continue; }
      if (end < 0) { if (this.buffer.length > this.maxBytes) this.reset(); break; }
      const frame = this.buffer.subarray(0, end + 1);
      this.buffer = this.buffer.subarray(end + 1);
      if (frame.length >= 6 && frame.length <= this.maxBytes) frames.push(Buffer.from(frame));
    }
    return frames;
  }
}

function frame(address, payload) { return Buffer.from([0xfe, 0xfe, address, controller, ...payload, 0xfd]); }

// Only positively identified reads may run while somebody else owns TX. All
// unknown/extended commands are mutations. TX initiators have explicit leases.
function classify(bytes) {
  const cmd = bytes[4], data = bytes.subarray(5, -1);
  let read = false, prefix = Buffer.alloc(0), tx = null, release = false;
  if ([0x02, 0x03, 0x04, 0x0f].includes(cmd) && !data.length) read = true;
  if ([0x14, 0x15, 0x16, 0x1b, 0x1c, 0x21, 0x27].includes(cmd) && data.length === 1) { read = true; prefix = data; }
  if (cmd === 0x19 && data.length === 1) { read = true; prefix = data; }
  if (cmd === 0x1a) {
    if ((data[0] === 5 && data.length === 3) || ([3, 4, 6].includes(data[0]) && data.length === 1)) { read = true; prefix = data; }
  }
  if ([0x25, 0x26].includes(cmd) && data.length === 1) { read = true; prefix = data; }
  if (cmd === 0x17) { tx = data[0] === 0xff ? null : 'cw'; release = data[0] === 0xff ? 'cw' : false; }
  if (cmd === 0x1c && data[0] === 0 && data.length === 2) { tx = data[1] ? 'ptt' : null; release = data[1] === 0 ? 'ptt' : false; }
  if (cmd === 0x1c && data[0] === 1 && data.length === 2) { tx = data[1] === 2 ? 'tuner' : null; release = data[1] !== 2 ? 'tuner' : false; }
  if (cmd === 0x28 && data[0] === 0 && data.length === 2) { tx = data[1] ? 'voice' : null; release = data[1] === 0 ? 'voice' : false; }
  if (cmd === 0x16 && data[0] === 0x46 && data.length === 2) { tx = data[1] ? 'vox' : null; release = data[1] === 0 ? 'vox' : false; }
  // Commands 00/01 are one-way transceive setters; radios do not ACK them.
  const invalid = (cmd === 0x28 && (data.length !== 2 || data[0] !== 0 || data[1] > 8))
    || (cmd === 0x17 && !data.length)
    || (cmd === 0x1c && data[0] === 0 && (data.length > 2 || (data.length === 2 && data[1] > 1)))
    || (cmd === 0x1c && data[0] === 1 && (data.length > 2 || (data.length === 2 && data[1] > 2)))
    || (cmd === 0x16 && data[0] === 0x46 && (data.length > 2 || (data.length === 2 && data[1] > 1)));
  return { read, invalid, prefix: Buffer.from(prefix), tx, release, oneWay: cmd === 0 || cmd === 1 };
}

class Broker extends EventEmitter {
  constructor(session, server, options = {}) {
    super();
    this.session = session;
    this.server = server;
    this.explicitAddress = options.address !== undefined;
    this.options = { address: 0xb6, requestTimeoutMs: 2000, maxQueued: 1024, maxPerClient: 64, pollMs: 250, autoStartGraceMs: 1000, ...options };
    for (const key of ['maxQueued', 'maxPerClient']) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new Error(`Invalid broker ${key}`);
    }
    this.queue = [];
    this.parsers = new Map();
    this.radioParser = new FrameParser();
    this.ready = false;
    this.owner = null;
    this.lease = null;
    this.txObligations = new Set();
    this.activeTriggers = new Set();
    this.observedTx = false;
    this.releasing = false;
    this.stopRequested = false;
    this.generation = 0;
    this.stats = { commands: 0, rejected: 0, timeouts: 0, audioDropped: 0 };
    this.listeners = [
      [server, 'command', (client, bytes) => this.command(client, bytes)],
      [server, 'audio', (client, pcm) => this.audio(client, pcm)],
      [server, 'disconnect', (client) => this.disconnect(client)],
      [session, 'civ', (bytes) => this.receive(bytes)],
      [session, 'rx-audio', (pcm) => { if (this.ready) server.broadcastAudio(pcm); }],
      [session, 'connected', () => this.synchronize()],
      [session, 'disconnected', () => this.lost()],
    ];
    for (const [emitter, event, listener] of this.listeners) emitter.on(event, listener);
    this.timer = setInterval(() => this.poll(), this.options.pollMs);
    if (session.connected) queueMicrotask(() => this.synchronize());
  }

  start() { if (this.session.connected && !this.synchronizing && !this.ready) this.synchronize(); return this; }

  invalidateTx() {
    if (this.owner) {
      this.server.retireClientWork?.(this.owner);
      this.parsers.get(this.owner)?.reset();
    }
    this.session.playback?.setKeyed(false);
    for (const group of ['audio']) this.session.audio?.invalidate(group);
    for (const group of ['cw', 'ptt', 'transaction']) this.session.serial?.invalidate(group);
  }

  lost() {
    ++this.generation;
    this.ready = false;
    this.synchronizing = false;
    this.releasing = false;
    this.stopRequested = false;
    this.invalidateTx();
    this.owner = null;
    this.lease = null;
    this.activeTriggers.clear();
    this.observedTx = false;
    this.radioParser.reset();
    for (const parser of this.parsers.values()) parser.reset();
    this.cancelAll(new Error('Radio session lost'));
    this.emit('status', { state: 'disconnected' });
  }

  cancelAll(error) {
    const work = [...this.queue];
    this.queue = [];
    if (this.pending) { clearTimeout(this.pending.timer); work.unshift(this.pending); this.pending = null; }
    for (const item of work) this.reject(item, error);
  }

  reset(error) {
    this.stats.timeouts++;
    this.lost();
    this.session.fail(error);
  }

  async synchronize() {
    if (this.closed || this.synchronizing || !this.session.connected) return;
    this.lost();
    this.synchronizing = true;
    const advertised = this.session.advertisedAddress;
    if (!this.explicitAddress && Number.isInteger(advertised) && advertised > 0 && advertised < 0xe0) this.options.address = advertised;
    const generation = this.generation;
    try {
      // A fresh association prevents stale acknowledgements from earlier
      // sessions confirming these cleanup commands. No mode/routing changes.
      await this.internal([0x1c, 0, 0]);
      await this.stopKeyer();
      await this.stopInitiators();
      const result = await this.internal([0x1c, 0]);
      if (result[6] !== 0) throw new Error('Radio has not confirmed receive state');
      // Output subscriptions belong to the splitter. One client turning off
      // its waterfall must not stop the stream for all other clients.
      await this.internal([0x27, 0x10, 1]);
      await this.internal([0x27, 0x11, 1]);
      if (generation !== this.generation || this.closed) return;
      this.txObligations.clear();
      this.activeTriggers.clear();
      this.cwDeadline = 0;
      this.ready = true;
      this.synchronizing = false;
      this.emit('ready');
      this.emit('status', { state: 'ready' });
      this.pump();
    } catch (error) {
      if (generation === this.generation && this.session.connected) this.reset(error);
    }
  }

  internal(payload, allowNG = false, priority = false) {
    return new Promise((resolve, reject) => {
      const bytes = frame(this.options.address, payload);
      const item = { bytes, policy: classify(bytes), internal: true, allowNG, resolve, reject, generation: this.generation };
      if (priority) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    });
  }

  negative(client, bytes) {
    this.stats.rejected++;
    if (client?.active !== false) this.server.sendCiv(client, Buffer.from([0xfe, 0xfe, bytes[3], this.options.address, 0xfa, 0xfd]));
  }

  allowed(client, policy) {
    if (!this.ready || this.closed || client?.active === false || policy.invalid) return false;
    if (policy.read) return true;
    if (this.releasing) return false;
    if (this.stopRequested && policy.release !== 'ptt') return false;
    if (this.owner && this.owner !== client) return false;
    if (this.observedTx && !this.owner) return false;
    return true;
  }

  command(client, chunk) {
    if (!client || client.active === false) return;
    let parser = this.parsers.get(client);
    if (!parser) { parser = new FrameParser(); this.parsers.set(client, parser); }
    for (const bytes of parser.push(chunk)) {
      if (bytes[2] !== this.options.address && bytes[2] !== 0) { this.negative(client, bytes); continue; }
      const policy = classify(bytes);
      const urgent = this.owner === client && Boolean(policy.release) && this.allowed(client, policy);
      if (urgent) {
        // A TX stop cannot be refused because ordinary client polling filled
        // the queue. Cancel this producer's queued work, then keep one bounded
        // priority position without preempting the in-flight CI-V reply.
        const keep = [];
        for (const item of this.queue) {
          if (item.client === client) this.reject(item, new Error('Owner requested TX stop'));
          else keep.push(item);
        }
        this.queue = keep;
        if (this.queue.length >= this.options.maxQueued) this.reject(this.queue.pop(), new Error('TX stop needs queue capacity'));
        if (policy.release === 'ptt') {
          this.stopRequested = true;
          this.invalidateTx();
        }
      }
      const count = this.queue.reduce((n, item) => n + (item.client === client ? 1 : 0), this.pending?.client === client ? 1 : 0);
      if (!this.allowed(client, policy) || (!urgent && (this.queue.length >= this.options.maxQueued || count >= this.options.maxPerClient))) {
        this.negative(client, bytes);
        continue;
      }
      this.stats.commands++;
      const item = { client, bytes, policy, generation: this.generation, mediaGeneration: client.mediaGeneration };
      if (urgent) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    }
  }

  reject(item, error) {
    if (item.internal) item.reject(error);
    else if (item.mediaGeneration === item.client.mediaGeneration) this.negative(item.client, item.bytes);
  }

  pump() {
    if (this.pending || !this.session.connected || this.closed) return;
    while (this.queue.length) {
      const item = this.queue.shift();
      if (item.generation !== this.generation || (!item.internal && (!this.allowed(item.client, item.policy) || item.mediaGeneration !== item.client.mediaGeneration))) {
        this.reject(item, new Error('Command no longer permitted'));
        continue;
      }
      if (!item.internal && item.bytes[4] === 0x27 && [0x10, 0x11].includes(item.bytes[5])
        && (item.bytes.length === 7 || (item.bytes.length === 8 && [0, 1].includes(item.bytes[6])))) {
        const response = item.policy.read ? [0x27, item.bytes[5], 1] : [0xfb];
        this.server.sendCiv(item.client, Buffer.from([0xfe, 0xfe, item.bytes[3], this.options.address, ...response, 0xfd]));
        continue;
      }
      if (!item.internal && item.policy.tx && !this.owner) {
        this.owner = item.client;
        this.server.retireAudio?.(this.owner);
        this.lease = item.policy.tx;
        // Work received after the TX request must not execute after its end.
        const keep = [];
        for (const queued of this.queue) {
          if (!queued.internal && queued.client !== this.owner && !queued.policy.read) this.reject(queued, new Error('Another client owns TX'));
          else keep.push(queued);
        }
        this.queue = keep;
        this.emit('status', { state: 'tx-reserved', clientId: this.owner.id });
      }
      if (!item.internal && item.policy.tx) this.txObligations.add(item.policy.tx);
      const bytes = Buffer.from(item.bytes);
      bytes[2] = this.options.address;
      bytes[3] = controller;
      this.pending = item;
      if (!item.policy.oneWay) item.timer = setTimeout(() => {
        if (this.pending === item) this.reset(new Error('CI-V reply timed out; resetting upstream session'));
      }, this.options.requestTimeoutMs);
      try { this.session.sendCiv(bytes, { group: 'transaction' }); }
      catch (error) { this.reset(error); return; }
      if (item.policy.oneWay) {
        // Transceive writes have no ACK by definition. The transport still
        // preserves ordering and TX ownership checks.
        this.pending = null;
        this.session.serial?.invalidate('transaction');
        this.broadcastState(bytes);
        continue;
      }
      return;
    }
  }

  broadcastState(bytes) {
    let cmd = bytes[4];
    if (cmd === 0x25 || cmd === 0x26) {
      // Selector 01 describes the unselected VFO and must never overwrite
      // the selected receiver's shared transceive state.
      if (bytes[5] !== 0) return;
      if (cmd === 0x25 && bytes.length === 12) {
        this.server.broadcastCiv(Buffer.from([0xfe, 0xfe, 0, this.options.address, 0, ...bytes.subarray(6, -1), 0xfd]));
      }
      if (cmd === 0x26 && bytes.length >= 8 && bytes.length <= 10) {
        // 26 carries selector, mode, DATA and optional filter. Transceive
        // mode 01 carries mode and optional filter, not the DATA flag.
        const mode = [bytes[6]];
        if (bytes.length === 10) mode.push(bytes[8]);
        this.server.broadcastCiv(Buffer.from([0xfe, 0xfe, 0, this.options.address, 1, ...mode, 0xfd]));
        const selected = Buffer.from(bytes); selected[2] = 0; selected[3] = this.options.address;
        this.server.broadcastCiv(selected);
      }
      return;
    }
    if ([0x03, 0x05].includes(cmd)) cmd = 0;
    else if ([0x04, 0x06].includes(cmd)) cmd = 1;
    else if (cmd !== 0 && cmd !== 1) return;
    const update = Buffer.from(bytes);
    update[2] = 0;
    update[3] = this.options.address;
    update[4] = cmd;
    this.server.broadcastCiv(update);
  }

  receive(chunk) {
    if (!this.session.connected || this.closed) return;
    for (const bytes of this.radioParser.push(chunk)) {
      if (bytes[3] !== this.options.address) continue; // Includes command echo.
      const cmd = bytes[4];
      if (cmd === 0x27 && bytes[5] === 0) {
        const scope = Buffer.from(bytes); scope[2] = 0;
        this.server.broadcastCiv(scope); continue;
      }
      if (bytes[2] === 0 || cmd === 0 || cmd === 1) { this.server.broadcastCiv(bytes); continue; }
      if (bytes[2] !== controller || !this.pending) continue;
      const item = this.pending;
      const ack = cmd === 0xfb || cmd === 0xfa;
      if (ack && bytes.length !== 6) continue;
      if (!ack) {
        if (cmd !== item.bytes[4]) continue;
        const prefix = item.policy.prefix;
        const minData = item.policy.read ? (cmd === 3 ? 5 : cmd === 4 ? 2 : prefix.length + 1) : 0;
        if (bytes.length < 6 + minData) continue;
        if (prefix.length && !bytes.subarray(5, 5 + prefix.length).equals(prefix)) continue;
      }
      // Read commands require their actual data; an ACK cannot be their
      // answer. NG does terminate a rejected read.
      if (item.policy.read && cmd === 0xfb) continue;
      clearTimeout(item.timer);
      this.pending = null;
      this.session.serial?.invalidate('transaction');
      if (cmd === 0x1c && bytes[5] === 0 && bytes.length >= 8) this.observedTx = Boolean(bytes[6]);
      if (item.internal) {
        if (cmd === 0xfa && !item.allowNG) item.reject(new Error('Radio rejected safety/query command'));
        else item.resolve(bytes);
      } else {
        if (item.client.active !== false && item.mediaGeneration === item.client.mediaGeneration) {
          const reply = Buffer.from(bytes);
          reply[2] = item.bytes[3];
          this.server.sendCiv(item.client, reply);
        }
        if (cmd !== 0xfa) {
          this.broadcastState(item.policy.read ? bytes : item.bytes);
          if (item.bytes[4] === 0x16 && item.bytes[5] === 0x46 && item.bytes[6] === 0) this.txObligations.delete('vox');
          if (item.policy.tx && item.client.active !== false
            && item.mediaGeneration === item.client.mediaGeneration && !this.releasing && !this.stopRequested) {
            this.activeTriggers.add(item.policy.tx);
            this.updateLease();
            if (item.policy.tx === 'ptt' || item.policy.tx === 'vox') this.session.playback?.setKeyed(true);
            this.observedTx = item.policy.tx !== 'vox';
            this.lastTxRequest = performance.now();
            if (item.policy.tx === 'cw') {
              // CI-V text is buffered inside the radio; receive gaps do not
              // establish that the text queue is empty. Bound completion by
              // the slowest supported speed (6 WPM), 30 Morse time units per
              // character (including maximum 4.5 dash weighting), and
              // accumulate across every accepted text chunk.
              this.cwDeadline = Math.max(this.cwDeadline || 0, this.lastTxRequest) + (item.bytes.length - 6) * 6000;
            }
            this.receivePolls = 0;
          }
          if (item.policy.release && this.owner === item.client) {
            this.activeTriggers.delete(item.policy.release);
            this.updateLease();
            if (item.policy.release === 'ptt' || !this.activeTriggers.size) this.release();
          }
        } else if (item.policy.tx && this.owner === item.client) {
          if (!this.activeTriggers.has(item.policy.tx)) this.txObligations.delete(item.policy.tx);
          if (!this.activeTriggers.size) this.release();
        }
      }
      this.pump();
    }
  }

  audio(client, pcm) {
    if (!this.ready || this.releasing || this.stopRequested || this.owner !== client || client.active === false || !['ptt', 'vox'].includes(this.lease)) {
      this.stats.audioDropped++;
      return;
    }
    // Raw native media is already framed/paced by the client's UDP stream.
    // Do not buffer it across ownership changes or reconnects.
    this.session.sendAudio(pcm);
  }

  disconnect(client) {
    this.parsers.delete(client);
    const keep = [];
    for (const item of this.queue) {
      if (item.client === client) this.reject(item, new Error('Client disconnected'));
      else keep.push(item);
    }
    this.queue = keep;
    if (this.owner === client) this.release();
    // An in-flight read/write still has to consume its reply, or reset on
    // timeout, so it cannot confirm the next client's command.
  }

  async release() {
    if (this.releasing) return this.releasePromise;
    this.releasing = true;
    this.stopRequested = true;
    this.invalidateTx();
    const generation = this.generation;
    this.releasePromise = (async () => {
      try {
        // Do not place cleanup behind old owner work. Cancel all its queued
        // commands, retain reads from other clients and reject their writes.
        const keep = [];
        for (const item of this.queue) {
          if (!item.internal && (!item.policy.read || item.client === this.owner)) this.reject(item, new Error('TX lease ending'));
          else keep.push(item);
        }
        this.queue = keep;
        if (!this.session.connected) return;
        await this.internal([0x1c, 0, 0], false, true);
        await this.stopKeyer(true);
        await this.stopInitiators(true);
        const result = await this.internal([0x1c, 0], false, true);
        if (result[6] !== 0) throw new Error('Radio has not confirmed TX release');
        if (generation !== this.generation) return;
        this.owner = null;
        this.lease = null;
        this.txObligations.clear();
        this.activeTriggers.clear();
        this.cwDeadline = 0;
        this.observedTx = false;
        this.releasing = false;
        this.stopRequested = false;
        this.emit('status', { state: 'ready' });
        this.pump();
      } catch (error) {
        if (generation === this.generation && this.session.connected) this.reset(error);
      }
    })();
    return this.releasePromise;
  }

  updateLease() {
    // Independent initiators can coexist for one client. A persistent PTT
    // or VOX trigger must not disappear when the client enables/stops an
    // automatic source (or when VOX is toggled during explicit PTT).
    this.lease = ['ptt', 'vox', 'voice', 'tuner', 'cw'].find((kind) => this.activeTriggers.has(kind)) || null;
  }

  async stopKeyer(priority = false) {
    // The physical MK2 rejects 17 FF outside CW/CW-R. Do not manufacture
    // an avoidable NG or change the operator's mode just for cleanup.
    const mode = await this.internal([0x04], false, priority);
    if (mode[5] === 3 || mode[5] === 7) await this.internal([0x17, 0xff], false, priority);
  }

  async stopInitiators(priority = false) {
    if (this.txObligations.has('voice')) await this.internal([0x28, 0, 0], false, priority);
    if (this.txObligations.has('tuner')) await this.internal([0x1c, 1, 0], false, priority);
    if (this.txObligations.has('vox')) await this.internal([0x16, 0x46, 0], false, priority);
  }

  poll() {
    if (!this.ready || this.releasing || !this.session.connected || this.closed) return;
    if (this.polling) return;
    this.polling = true;
    const generation = this.generation;
    this.internal([0x1c, 0], false, true).then(async (bytes) => {
      if (generation !== this.generation) return;
      if (bytes[6]) this.receivePolls = 0;
      else this.receivePolls = (this.receivePolls || 0) + 1;
      if (!this.owner || this.receivePolls < 3 || performance.now() - this.lastTxRequest <= this.options.autoStartGraceMs) return;
      if (this.lease === 'cw' && performance.now() >= this.cwDeadline) this.release();
      if (this.lease === 'tuner') {
        const tuner = await this.internal([0x1c, 1], false, true);
        if (generation === this.generation && this.lease === 'tuner' && tuner[6] !== 2) this.release();
      }
      // Voice memories may repeat after arbitrarily long silence. Their
      // owner must send the explicit stop command (or disconnect); a quiet
      // PTT status is not evidence that the playback loop has ended.
    }).catch(() => {}).finally(() => { this.polling = false; });
  }

  async close() {
    clearInterval(this.timer);
    if (this.session.connected && this.owner) await this.release();
    this.closed = true;
    this.lost();
    this.parsers.clear();
    for (const [emitter, event, listener] of this.listeners) emitter.off(event, listener);
  }
}

module.exports = { Broker, FrameParser, classify };
