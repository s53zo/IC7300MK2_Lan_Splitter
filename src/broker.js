'use strict';

// SPDX-License-Identifier: AGPL-3.0-only
const { EventEmitter } = require('node:events');
const { policyFor, validReply, validateQueryTtls, cacheQuerySettings } = require('./read-cache');
const { BrokerMetrics } = require('./metrics');
const { SharedTelemetry } = require('./telemetry');

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
  const cacheRead = policyFor(bytes);
  if (cacheRead) { read = true; prefix = cacheRead.prefix; }
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
    this.options = { address: 0xb6, requestTimeoutMs: 2000, maxQueued: 1024, maxPerClient: 64, pollMs: 250, autoStartGraceMs: 1000, cacheEnabled: true, telemetryEnabled: false, cacheMetersMs: 100, cacheStateMs: 100, cacheSettingsMs: 250, cacheTuningMs: 50, cacheQueryTtls: {}, maxCacheEntries: 128, now: () => performance.now(), ...options };
    for (const key of ['maxQueued', 'maxPerClient', 'maxCacheEntries']) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new Error(`Invalid broker ${key}`);
    }
    for (const key of ['cacheMetersMs', 'cacheStateMs', 'cacheSettingsMs', 'cacheTuningMs']) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 0 || this.options[key] > 1000) throw new Error(`Invalid broker ${key}`);
    }
    if (typeof this.options.cacheEnabled !== 'boolean' || typeof this.options.now !== 'function') throw new Error('Invalid read-cache options');
    if (typeof this.options.telemetryEnabled !== 'boolean') throw new Error('Invalid telemetryEnabled option');
    this.options.cacheQueryTtls = validateQueryTtls(this.options.cacheQueryTtls);
    this.metrics = new BrokerMetrics(this.options.now);
    this.coherenceEpoch = 0;
    this.readCache = new Map();
    this.cacheEpoch = 0;
    this.requestSerial = 0;
    this.cacheStats = { requests: 0, hits: 0, coalesced: 0, misses: 0, invalidations: 0 };
    this.cacheByQuery = new Map();
    this.queue = [];
    this.deferredStops = new Set();
    this.parsers = new Map();
    this.radioParser = new FrameParser();
    this.ready = false;
    this.owner = null;
    this.lease = null;
    this.txObligations = new Set();
    this.activeTriggers = new Set();
    this.txIncarnation = 0;
    this.observedTx = false;
    this.releaseUnconfirmed = false;
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
    this.telemetry = new SharedTelemetry(this);
    this.timer = setInterval(() => this.telemetry.active ? this.telemetry.tick() : this.poll(), this.telemetry.active ? 5 : this.options.pollMs);
    if (session.connected) queueMicrotask(() => this.synchronize());
  }

  resetStatistics() {
    // Retire only accounting for existing admissions; their work and replies
    // continue unchanged. Physical sends after this boundary still count.
    for (const item of [...this.queue, this.pending, ...this.deferredStops].filter(Boolean)) {
      item.suppressCacheStatistics = true;
      if (!item.internal) item.metricsFinished = true;
    }
    this.metrics = new BrokerMetrics(this.options.now);
    for (const key of Object.keys(this.cacheStats)) this.cacheStats[key] = 0;
    this.cacheByQuery.clear();
    for (const key of Object.keys(this.stats)) this.stats[key] = 0;
    this.telemetry.resetStatistics();
    this.session.resetTransportStatistics?.();
    for (const role of ['control', 'serial', 'audio']) {
      const counters = this.session[role]?.counters;
      if (counters) for (const key of Object.keys(counters)) counters[key] = 0;
    }
  }

  telemetrySnapshot() { return this.telemetry.snapshot(); }

  cacheSnapshot() {
    const sampled = new Map(this.telemetry.snapshot().querySettings.filter((row) => row.sharing).map((row) => [row.key, row]));
    const querySettings = cacheQuerySettings(this.options).map((row) => {
      const telemetry = sampled.get(row.key);
      return telemetry ? { ...row, source: 'telemetry', configuredMs: row.effectiveMs, effectiveMs: telemetry.maxAgeMs,
        intervalMs: telemetry.intervalMs, maxAgeMs: telemetry.maxAgeMs } : { ...row, source: 'cache', configuredMs: row.effectiveMs };
    });
    return { ttlMs: { meters: this.options.cacheMetersMs, state: this.options.cacheStateMs, settings: this.options.cacheSettingsMs, tuning: this.options.cacheTuningMs }, enabled: this.options.cacheEnabled, entries: this.readCache.size, epoch: this.cacheEpoch,
      ...this.cacheStats, querySettings, byQuery: Object.fromEntries([...this.cacheByQuery].map(([key, value]) => [key, { ...value }])) };
  }

  metricsSnapshot() {
    const snapshot = this.metrics.snapshot();
    snapshot.eligible.queued = this.queue.filter((item) => !item.internal && !item.metricsFinished && item.cachePolicy).length;
    snapshot.eligible.inFlight = this.pending && !this.pending.internal && !this.pending.metricsFinished && this.pending.cachePolicy ? 1 : 0;
    snapshot.transport = this.session.transportSnapshot?.() || Object.fromEntries(['control', 'serial', 'audio'].map((role) => [role,
      Object.fromEntries(['malformed', 'stale', 'duplicates', 'lost', 'replayed'].map((key) => [key, this.session[role]?.counters?.[key] || 0]))]));
    return snapshot;
  }

  cachePolicy(bytes) {
    if (!this.options.cacheEnabled) return null;
    const policy = policyFor(bytes, this.options);
    return policy?.ttlMs > 0 ? policy : null;
  }

  countCache(policy, kind, item) {
    if (item?.suppressCacheStatistics) return;
    ++this.cacheStats[kind];
    if (!this.cacheByQuery.has(policy.key)) this.cacheByQuery.set(policy.key, { requests: 0, hits: 0, coalesced: 0, misses: 0 });
    ++this.cacheByQuery.get(policy.key)[kind];
  }

  clearReadEntries(reason) {
    const removed = this.readCache.size;
    this.readCache.clear();
    this.telemetry?.invalidate();
    this.metrics.reason('invalidations', reason);
    this.metrics.invalidationEntries.removed += removed;
    if (!removed) this.metrics.invalidationEntries.empty++;
    if (reason !== 'mutation_admission') ++this.coherenceEpoch;
  }

  invalidateReads(reason = 'other') {
    this.clearReadEntries(reason);
    ++this.cacheEpoch;
    ++this.cacheStats.invalidations;
  }

  cachedReply(item) {
    if (!item.cachePolicy) return null;
    if (item.cacheEpoch !== this.cacheEpoch) { this.metrics.reason('misses', 'admission_epoch', item.cachePolicy, item); return null; }
    const entry = this.readCache.get(item.cachePolicy.key);
    if (!entry) { this.metrics.reason('misses', 'absent', item.cachePolicy, item); return null; }
    const now = this.options.now();
    const reason = entry.epoch !== this.cacheEpoch ? 'entry_epoch' : entry.generation !== this.generation ? 'generation' : now >= entry.expiresAt ? 'expired' : null;
    if (reason) {
      this.metrics.reason('misses', reason, item.cachePolicy, item);
      this.readCache.delete(item.cachePolicy.key); return null;
    }
    this.metrics.hit(item, entry, now - entry.filledAt);
    this.countCache(item.cachePolicy, 'hits', item);
    if (item.serial <= entry.filledThroughSerial) this.countCache(item.cachePolicy, 'coalesced', item);
    return Buffer.from(entry.reply);
  }

  rememberReply(item, bytes) {
    const policy = item.cachePolicy || this.cachePolicy(item.bytes);
    if (!policy) {
      const known = policyFor(item.bytes);
      this.metrics.reason('storeSkips', !this.options.cacheEnabled ? 'disabled' : known
        ? this.options.cacheQueryTtls[known.key] === 0 ? 'query_disabled' : 'family_disabled' : 'unknown_query', known, item);
      return;
    }
    if (!this.ready || this.synchronizing || this.releasing || this.stopRequested) {
      this.metrics.reason('storeSkips', 'unstable', policy, item); return;
    }
    if (item.cacheEpoch !== this.cacheEpoch) {
      this.metrics.reason('storeSkips', 'admission_epoch', policy, item);
      if (item.coherenceAtDispatch === this.coherenceEpoch && validReply(item.bytes, bytes)) {
        for (const queued of this.queue) {
          if (!queued.policy.read) break;
          if (!queued.internal && queued.cachePolicy?.key === policy.key && queued.cacheEpoch === item.cacheEpoch
            && !queued.suppressCacheStatistics && !queued.suppressedSharingCounted && queued.client.active !== false
            && queued.mediaGeneration === queued.client.mediaGeneration) {
            queued.suppressedSharingCounted = true; this.metrics.suppressedQueuedReads++;
          }
        }
      }
      return;
    }
    if (!validReply(item.bytes, bytes)) {
      this.metrics.reason('storeSkips', 'invalid_reply', policy, item);
      this.readCache.delete(policy.key); return;
    }
    this.readCache.delete(policy.key);
    const filledAt = this.options.now();
    this.readCache.set(policy.key, { reply: Buffer.from(bytes), epoch: this.cacheEpoch, filledAt, fillOrigin: item.internal ? item.purpose : 'client',
      generation: this.generation, expiresAt: filledAt + policy.ttlMs,
      filledThroughSerial: this.requestSerial });
    while (this.readCache.size > this.options.maxCacheEntries) { this.readCache.delete(this.readCache.keys().next().value); this.metrics.evictions++; }
  }

  sendReadReply(item, bytes) {
    if (item.client.active === false || item.mediaGeneration !== item.client.mediaGeneration) return false;
    const reply = Buffer.from(bytes);
    reply[2] = item.bytes[3];
    this.server.sendCiv(item.client, reply);
    return true;
  }

  start() { if (this.session.connected && !this.synchronizing && !this.ready) this.synchronize(); return this; }

  invalidateTx(reason = 'tx_transition') {
    this.advanceTxIncarnation();
    this.invalidateReads(reason);
    if (this.owner) {
      this.server.retireClientWork?.(this.owner);
      this.parsers.get(this.owner)?.reset();
    }
    this.session.playback?.setKeyed(false);
    for (const group of ['audio']) this.session.audio?.invalidate(group);
    for (const group of ['cw', 'ptt', 'transaction']) this.session.serial?.invalidate(group);
  }

  lost() {
    this.releaseUnconfirmed ||= Boolean(this.owner || this.observedTx || this.releasing || this.stopRequested || this.txObligations.size);
    ++this.generation;
    this.ready = false;
    this.synchronizing = false;
    this.releasing = false;
    this.stopRequested = false;
    this.invalidateTx('lifecycle');
    this.owner = null;
    this.lease = null;
    this.activeTriggers.clear();
    this.observedTx = false;
    this.radioParser.reset();
    for (const parser of this.parsers.values()) parser.reset();
    this.cancelAll(new Error('Radio session lost'));
    this.emit('status', { state: 'disconnected' });
  }

  cancelAll(error, reason = 'session_loss') {
    for (const item of this.deferredStops) this.metrics.finish(item, 'cancelled', reason);
    this.deferredStops.clear();
    const work = [...this.queue];
    this.queue = [];
    if (this.pending) { clearTimeout(this.pending.timer); work.unshift(this.pending); this.pending = null; }
    for (const item of work) this.reject(item, error, reason);
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
      await this.internal([0x1c, 0, 0], false, false, 'startup', generation);
      await this.stopKeyer(false, 'startup', generation);
      await this.stopInitiators(false, 'startup', generation);
      const result = await this.internal([0x1c, 0], false, false, 'startup', generation);
      if (result[6] !== 0) throw new Error('Radio has not confirmed receive state');
      // Output subscriptions belong to the splitter. One client turning off
      // its waterfall must not stop the stream for all other clients.
      await this.internal([0x27, 0x10, 1], false, false, 'startup', generation);
      await this.internal([0x27, 0x11, 1], false, false, 'startup', generation);
      if (generation !== this.generation || this.closed) return;
      this.releaseUnconfirmed = false;
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

  assertSession(generation) {
    if (generation !== this.generation || !this.session.connected || this.closed) throw new Error('Radio session changed during cleanup');
  }

  internal(payload, allowNG = false, priority = false, purpose = 'internal', generation = this.generation) {
    return new Promise((resolve, reject) => {
      this.assertSession(generation);
      const bytes = frame(this.options.address, payload);
      const policy = classify(bytes);
      if (!policy.read) this.invalidateReads('mutation_admission');
      const item = { bytes, policy, internal: true, purpose, allowNG, resolve, reject, generation: this.generation, cacheEpoch: this.cacheEpoch };
      if (this.telemetry?.active && ['telemetryPoll', 'periodicPoll'].includes(purpose) && this.telemetry.key(bytes)) {
        item.telemetryBackground = true; this.telemetry.register(item);
      }
      if (priority) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    });
  }

  negative(client, bytes, beforeAdmission = true, reason = 'other') {
    if (beforeAdmission) { this.metrics.logical.rejectedBeforeAdmission++; this.metrics.reason('rejected', reason); }
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
      if (bytes[2] !== this.options.address && bytes[2] !== 0) { this.negative(client, bytes, true, 'invalid_radio'); continue; }
      const policy = classify(bytes);
      const urgent = this.owner === client && Boolean(policy.release) && this.allowed(client, policy);
      if (urgent) {
        // A TX stop cannot be refused because ordinary client polling filled
        // the queue. Cancel this producer's queued work, then keep one bounded
        // priority position without preempting the in-flight CI-V reply.
        const keep = [];
        for (const item of this.queue) {
          if (item.client === client) this.reject(item, new Error('Owner requested TX stop'), 'tx_transition');
          else keep.push(item);
        }
        this.queue = keep;
        if (this.queue.length >= this.options.maxQueued) this.reject(this.queue.pop(), new Error('TX stop needs queue capacity'), 'queue_capacity');
        if (policy.release === 'ptt') {
          this.stopRequested = true;
          this.invalidateTx();
        }
      }
      const count = this.queue.reduce((n, item) => n + (item.client === client ? 1 : 0), this.pending?.client === client ? 1 : 0);
      if (!this.allowed(client, policy) || (!urgent && (this.queue.length >= this.options.maxQueued || count >= this.options.maxPerClient))) {
        this.negative(client, bytes, true, !this.allowed(client, policy) ? 'permission' : 'queue_capacity');
        continue;
      }
      if (!policy.read) this.invalidateReads('mutation_admission');
      const cachePolicy = this.cachePolicy(bytes);
      if (cachePolicy) this.countCache(cachePolicy, 'requests');
      this.stats.commands++;
      const item = { client, bytes, policy, generation: this.generation, mediaGeneration: client.mediaGeneration,
        cachePolicy, cacheEpoch: this.cacheEpoch, serial: ++this.requestSerial };
      this.metrics.admit(item);
      if (urgent) this.queue.unshift(item);
      else {
        const background = this.queue.findIndex((queued) => queued.telemetryBackground && queued.purpose === 'telemetryPoll');
        if (background < 0) this.queue.push(item); else this.queue.splice(background, 0, item);
      }
      this.pump();
    }
  }

  reject(item, error, reason = 'other') {
    this.telemetry?.finish(item);
    if (item.internal) item.reject(error);
    else {
      this.metrics.finish(item, 'cancelled', reason);
      if (item.mediaGeneration === item.client.mediaGeneration) this.negative(item.client, item.bytes, false);
    }
  }

  pump() {
    if (this.pending || !this.session.connected || this.closed) return;
    while (this.queue.length) {
      // An awaited cleanup step queues its successor in a microtask. Keep
      // the dispatch reservation between those steps rather than letting an
      // unrelated reader occupy the transaction slot in that gap.
      const reserved = this.releasing ? 'release' : this.synchronizing ? 'startup' : null;
      const index = reserved ? this.queue.findIndex((work) => work.internal && work.purpose === reserved) : 0;
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      if (item.generation !== this.generation || (!item.internal && (!this.allowed(item.client, item.policy) || item.mediaGeneration !== item.client.mediaGeneration))) {
        const reason = item.generation !== this.generation ? 'session_loss' : item.client?.active === false ? 'client_disconnect'
          : item.mediaGeneration !== item.client?.mediaGeneration ? 'media_generation' : 'permission';
        this.reject(item, new Error('Command no longer permitted'), reason);
        continue;
      }
      if (!item.internal && item.bytes[4] === 0x27 && [0x10, 0x11].includes(item.bytes[5])
        && (item.bytes.length === 7 || (item.bytes.length === 8 && [0, 1].includes(item.bytes[6])))) {
        const response = item.policy.read ? [0x27, item.bytes[5], 1] : [0xfb];
        this.server.sendCiv(item.client, Buffer.from([0xfe, 0xfe, item.bytes[3], this.options.address, ...response, 0xfd]));
        this.metrics.local(item); this.metrics.finish(item, 'completed');
        continue;
      }
      if (!item.internal) {
        const telemetryKey = this.telemetry.eligible(item.bytes);
        const sample = telemetryKey ? this.telemetry.lookup(item) : null;
        if (sample) {
          this.metrics.hit(item, sample, sample.ageMs); this.countCache(item.cachePolicy, 'hits', item);
          if (item.serial <= sample.filledThroughSerial) this.countCache(item.cachePolicy, 'coalesced', item);
          const delivered = this.sendReadReply(item, sample.reply);
          this.metrics.finish(item, delivered ? 'completed' : 'cancelled', item.client.active === false ? 'client_disconnect' : 'media_generation');
          continue;
        }
        const cached = telemetryKey ? null : this.cachedReply(item);
        if (cached) {
          const delivered = this.sendReadReply(item, cached);
          this.metrics.finish(item, delivered ? 'completed' : 'cancelled', item.client.active === false ? 'client_disconnect' : 'media_generation');
          continue;
        }
      }
      if (!item.internal) this.telemetry.prepareFallback(item);
      if (!item.policy.read) this.clearReadEntries('mutation_dispatch');
      if (!item.internal && item.cachePolicy) this.countCache(item.cachePolicy, 'misses', item);
      if (!item.internal && item.policy.tx) this.advanceTxIncarnation();
      if (!item.internal && item.policy.tx && !this.owner) {
        this.owner = item.client;
        this.server.retireAudio?.(this.owner);
        this.lease = item.policy.tx;
        // Work received after the TX request must not execute after its end.
        const keep = [];
        for (const queued of this.queue) {
          if (!queued.internal && queued.client !== this.owner && !queued.policy.read) this.reject(queued, new Error('Another client owns TX'), 'tx_transition');
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
        if (this.pending === item) { this.metrics.radioTimeouts++; this.reset(new Error('CI-V reply timed out; resetting upstream session')); }
      }, this.options.requestTimeoutMs);
      item.coherenceAtDispatch = this.coherenceEpoch;
      this.telemetry.dispatched(item);
      this.metrics.start(item, item.internal ? item.purpose : item.policy.read ? 'clientRead' : 'clientWrite');
      try { this.session.sendCiv(bytes, { group: 'transaction' }); }
      catch (error) { this.metrics.physicalSendErrors++; this.reset(error); return; }
      if (item.policy.oneWay) {
        // Transceive writes have no ACK by definition. The transport still
        // preserves ordering and TX ownership checks.
        this.pending = null;
        this.session.serial?.invalidate('transaction');
        this.broadcastState(bytes);
        this.metrics.finish(item, 'completed');
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
      if (bytes[2] === 0 || cmd === 0 || cmd === 1) {
        this.invalidateReads('notification');
        this.server.broadcastCiv(bytes); continue;
      }
      if (bytes[2] !== controller) continue;
      if (!this.pending) {
        if (cmd !== 0xfb && cmd !== 0xfa) this.invalidateReads('notification');
        continue;
      }
      const item = this.pending;
      const ack = cmd === 0xfb || cmd === 0xfa;
      if (ack && bytes.length !== 6) continue;
      if (!ack) {
        if (cmd !== item.bytes[4]) { this.invalidateReads('notification'); continue; }
        const prefix = item.policy.prefix;
        const minData = item.policy.read ? (cmd === 3 ? 5 : cmd === 4 ? 2 : prefix.length + 1) : 0;
        if (bytes.length < 6 + minData) continue;
        if (prefix.length && !bytes.subarray(5, 5 + prefix.length).equals(prefix)) { this.invalidateReads('notification'); continue; }
      }
      // Read commands require their actual data; an ACK cannot be their
      // answer. NG does terminate a rejected read.
      if (item.policy.read && cmd === 0xfb) continue;
      clearTimeout(item.timer);
      this.pending = null;
      this.session.serial?.invalidate('transaction');
      this.telemetry.finish(item);
      const telemetryBefore = { epoch: this.cacheEpoch, coherence: this.coherenceEpoch };
      this.metrics.reply(item);
      if (cmd === 0xfa) this.invalidateReads('negative_reply');
      if (cmd === 0x1c && bytes[5] === 0 && bytes.length >= 8) {
        if (this.observedTx !== Boolean(bytes[6])) this.invalidateReads('observed_tx');
        this.observedTx = Boolean(bytes[6]);
      }
      if (!item.policy.read) this.clearReadEntries('mutation_outcome');
      if (cmd !== 0xfa && cmd !== 0xfb) { this.telemetry.observe(item, bytes, telemetryBefore); this.rememberReply(item, bytes); }
      if (item.internal) {
        if (cmd === 0xfa && !item.allowNG) item.reject(new Error('Radio rejected safety/query command'));
        else item.resolve(bytes);
      } else {
        const deferStop = cmd === 0xfb && item.policy.release && this.owner === item.client
          && (item.policy.release === 'ptt' || [...this.activeTriggers].every((kind) => kind === item.policy.release));
        if (!deferStop) {
          const delivered = this.sendReadReply(item, bytes);
          this.metrics.finish(item, delivered ? 'completed' : 'cancelled', item.client.active === false ? 'client_disconnect' : 'media_generation', cmd === 0xfa);
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
            if (item.policy.release === 'ptt' || !this.activeTriggers.size) {
              if (deferStop) this.deferStopReply(item, bytes);
              else this.release();
            }
          }
        } else if (item.policy.tx && this.owner === item.client) {
          if (!this.activeTriggers.has(item.policy.tx)) this.txObligations.delete(item.policy.tx);
          if (!this.activeTriggers.size) this.release();
        }
      }
      this.pump();
    }
  }

  deferStopReply(item, bytes) {
    this.deferredStops.add(item);
    void this.release().then((success) => {
      if (!this.deferredStops.delete(item)) return;
      const current = success && item.generation === this.generation && !this.closed && this.session.connected
        && item.client.active !== false && item.mediaGeneration === item.client.mediaGeneration;
      const delivered = current && this.sendReadReply(item, bytes);
      this.metrics.finish(item, delivered ? 'completed' : 'cancelled',
        item.client.active === false ? 'client_disconnect' : item.mediaGeneration !== item.client.mediaGeneration ? 'media_generation' : 'session_loss');
    });
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
    for (const item of this.deferredStops) {
      if (item.client !== client) continue;
      this.deferredStops.delete(item);
      this.metrics.finish(item, 'cancelled', 'client_disconnect');
    }
    this.parsers.delete(client);
    const keep = [];
    for (const item of this.queue) {
      if (item.client === client) this.reject(item, new Error('Client disconnected'), 'client_disconnect');
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
          if (!item.internal && (!item.policy.read || item.client === this.owner)) this.reject(item, new Error('TX lease ending'), 'tx_transition');
          else keep.push(item);
        }
        this.queue = keep;
        if (!this.session.connected) return false;
        await this.internal([0x1c, 0, 0], false, true, 'release', generation);
        if (generation !== this.generation || !this.session.connected) return false;
        await this.stopKeyer(true, 'release', generation);
        if (generation !== this.generation || !this.session.connected) return false;
        await this.stopInitiators(true, 'release', generation);
        if (generation !== this.generation || !this.session.connected) return false;
        const result = await this.internal([0x1c, 0], false, true, 'release', generation);
        if (result[6] !== 0) throw new Error('Radio has not confirmed TX release');
        if (generation !== this.generation || !this.session.connected) return false;
        this.owner = null;
        this.lease = null;
        this.txObligations.clear();
        this.activeTriggers.clear();
        this.cwDeadline = 0;
        this.observedTx = false;
        this.releaseUnconfirmed = false;
        this.releasing = false;
        this.stopRequested = false;
        this.emit('status', { state: 'ready' });
        this.pump();
        return true;
      } catch (error) {
        if (generation === this.generation && this.session.connected) this.reset(error);
        return false;
      }
    })();
    return this.releasePromise;
  }

  updateLease() {
    this.advanceTxIncarnation();
    // Independent initiators can coexist for one client. A persistent PTT
    // or VOX trigger must not disappear when the client enables/stops an
    // automatic source (or when VOX is toggled during explicit PTT).
    this.lease = ['ptt', 'vox', 'voice', 'tuner', 'cw'].find((kind) => this.activeTriggers.has(kind)) || null;
  }

  advanceTxIncarnation() {
    ++this.txIncarnation;
    this.receivePolls = 0;
    this.receivePollSince = null;
  }

  async stopKeyer(priority = false, purpose = 'internal', generation = this.generation) {
    // The physical MK2 rejects 17 FF outside CW/CW-R. Do not manufacture
    // an avoidable NG or change the operator's mode just for cleanup.
    const mode = await this.internal([0x04], false, priority, purpose, generation);
    if (mode[5] === 3 || mode[5] === 7) await this.internal([0x17, 0xff], false, priority, purpose, generation);
  }

  async stopInitiators(priority = false, purpose = 'internal', generation = this.generation) {
    if (this.txObligations.has('voice')) await this.internal([0x28, 0, 0], false, priority, purpose, generation);
    if (this.txObligations.has('tuner')) await this.internal([0x1c, 1, 0], false, priority, purpose, generation);
    if (this.txObligations.has('vox')) await this.internal([0x16, 0x46, 0], false, priority, purpose, generation);
  }

  poll() {
    if (!this.ready || this.releasing || !this.session.connected || this.closed) return;
    if (this.polling) return;
    this.polling = true;
    const generation = this.generation;
    const owner = this.owner, incarnation = this.txIncarnation;
    const current = () => generation === this.generation && owner === this.owner
      && incarnation === this.txIncarnation && this.ready && !this.releasing
      && !this.stopRequested && this.session.connected && !this.closed;
    const started = () => Number.isFinite(this.lastTxRequest)
      && performance.now() - this.lastTxRequest > this.options.autoStartGraceMs;
    this.internal([0x1c, 0], false, true, 'periodicPoll').then(async (bytes) => {
      // receive() may dispatch a queued start before this continuation runs.
      // Even the same owner restarting a trigger makes this sample obsolete.
      if (!current()) return;
      if (bytes[6]) { this.receivePolls = 0; this.receivePollSince = null; }
      else {
        if (!this.receivePolls) this.receivePollSince = this.options.now();
        this.receivePolls = (this.receivePolls || 0) + 1;
      }
      const stable = this.receivePolls >= 3 && (!this.telemetry.active || this.options.now() - this.receivePollSince >= 500);
      if (!owner || !stable || !started()) return;
      if (this.lease === 'cw' && performance.now() >= this.cwDeadline) this.release();
      if (this.lease === 'tuner' && this.activeTriggers.has('tuner')) {
        const tuner = await this.internal([0x1c, 1], false, true, 'periodicPoll');
        if (current() && started() && this.lease === 'tuner'
          && this.activeTriggers.has('tuner') && tuner[6] !== 2) this.release();
      }
      // Voice memories may repeat after arbitrarily long silence. Their
      // owner must send the explicit stop command (or disconnect); a quiet
      // PTT status is not evidence that the playback loop has ended.
    }).catch(() => {}).finally(() => { this.polling = false; });
  }

  async close() {
    clearInterval(this.timer);
    const activeTx = Boolean(this.owner || this.observedTx || this.releaseUnconfirmed || this.releasing || this.stopRequested || this.txObligations.size);
    let releaseConfirmed = !activeTx;
    if (this.session.connected && activeTx) releaseConfirmed = await this.release();
    this.closed = true;
    this.lost();
    this.parsers.clear();
    for (const [emitter, event, listener] of this.listeners) emitter.off(event, listener);
    return { releaseConfirmed };
  }
}

module.exports = { Broker, FrameParser, classify };
