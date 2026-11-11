'use strict';
const { policyFor, validReply } = require('./read-cache');
const DEFINITIONS = Object.freeze([
  { key: '1c00', intervalMs: 100, maxAgeMs: 300, safety: true },
  { key: '1502', intervalMs: 100, maxAgeMs: 300 },
  { key: '1507', intervalMs: 500, maxAgeMs: 1000 },
  { key: '1511', intervalMs: 100, maxAgeMs: 300, txOnly: true },
  { key: '1512', intervalMs: 100, maxAgeMs: 300, txOnly: true },
  { key: '1513', intervalMs: 100, maxAgeMs: 300, txOnly: true },
]);
const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));
class SharedTelemetry {
  constructor(broker) {
    this.broker = broker; this.samples = new Map(); this.jobs = new Map(); this.nextDue = new Map();
    this.stats = new Map(DEFINITIONS.map(({ key }) => [key, { rfPolls: 0, localAnswers: 0, zeroReplies: 0, fallbacks: 0, samples: 0, backpressureSkips: 0 }]));
    this.invalidations = 0;
  }
  resetStatistics() {
    for (const counters of this.stats.values()) for (const key of Object.keys(counters)) counters[key] = 0;
    this.invalidations = 0;
  }
  get active() { return this.broker.options.telemetryEnabled && this.broker.options.cacheEnabled; }
  healthy() {
    const b = this.broker;
    return this.active && b.ready && b.session.connected && !b.closed && !b.synchronizing && !b.releasing && !b.stopRequested;
  }
  key(bytes) { const key = bytes.subarray(4, -1).toString('hex'); return BY_KEY.has(key) ? key : null; }
  eligible(bytes) { return this.active && this.key(bytes) && policyFor(bytes, this.broker.options) ? this.key(bytes) : null; }
  enabledKey(key) {
    const b = this.broker;
    return Boolean(policyFor(Buffer.from([0xfe, 0xfe, b.options.address, 0xe0, ...Buffer.from(key, 'hex'), 0xfd]), b.options));
  }
  entry(key, epoch = this.broker.cacheEpoch) {
    const sample = this.samples.get(key), b = this.broker;
    if (!sample || sample.generation !== b.generation || sample.epoch !== epoch || epoch !== b.cacheEpoch
      || b.options.now() - sample.filledAt >= BY_KEY.get(key).maxAgeMs) return null;
    return sample;
  }
  actualTx() { const state = this.entry('1c00'); return state ? state.reply[6] === 1 : null; }
  invalidate() {
    if (!this.active) return;
    this.samples.clear(); this.invalidations++;
    // Old queued refreshes cannot populate the new coherence epoch. In-flight
    // work must still consume its reply before any following transaction.
    const keep = [];
    for (const item of this.broker.queue) {
      if (item.telemetryBackground && (item.purpose === 'telemetryPoll' || !this.broker.ready
        || this.broker.releasing || this.broker.stopRequested || this.broker.closed)) this.broker.reject(item, new Error('Telemetry refresh invalidated'));
      else keep.push(item);
    }
    this.broker.queue = keep;
  }
  register(item) {
    if (!this.active) return;
    const key = this.key(item.bytes);
    if (!key) return;
    item.telemetryKey = key;
    this.jobs.set(key, item);
  }
  finish(item) {
    if (!item.telemetryKey || this.jobs.get(item.telemetryKey) !== item) return;
    this.jobs.delete(item.telemetryKey);
    const now = this.broker.options.now();
    if (item.dispatchedAt !== undefined && now >= (this.nextDue.get(item.telemetryKey) ?? Infinity)) {
      this.nextDue.set(item.telemetryKey, now + BY_KEY.get(item.telemetryKey).intervalMs);
    }
  }
  dispatched(item) {
    if (!item.telemetryKey) return;
    const definition = BY_KEY.get(item.telemetryKey), now = this.broker.options.now();
    this.nextDue.set(item.telemetryKey, now + definition.intervalMs);
    if (item.telemetryBackground) this.stats.get(item.telemetryKey).rfPolls++;
    else this.stats.get(item.telemetryKey).fallbacks++;
  }
  prepareFallback(item) {
    const key = this.eligible(item.bytes);
    if (!key) return;
    // A read at the FIFO head must not wait for a refresh behind a later write.
    // Reuse the established transaction path at this position and cancel only
    // the queued duplicate; an in-flight job already prevents pump dispatch.
    const keep = [];
    for (const queued of this.broker.queue) {
      if (queued.telemetryBackground && queued.telemetryKey === key) this.broker.reject(queued, new Error('Telemetry refresh replaced by FIFO read'));
      else keep.push(queued);
    }
    this.broker.queue = keep;
    item.telemetryFallback = true; this.register(item);
  }
  observe(item, reply, before) {
    const b = this.broker, key = this.key(item.bytes);
    if (!key || !this.healthy() || item.generation !== b.generation || item.cacheEpoch !== before.epoch
      || item.coherenceAtDispatch !== before.coherence || !validReply(item.bytes, reply)) return;
    // The fresh RX/TX reply may itself have invalidated the previous state.
    // Stamp the resulting epoch, but only if it was coherent before handling.
    this.samples.set(key, { reply: Buffer.from(reply), generation: b.generation, epoch: b.cacheEpoch,
      filledAt: b.options.now(), filledThroughSerial: b.requestSerial, fillOrigin: item.internal ? item.purpose : 'client' });
    this.stats.get(key).samples++;
  }
  lookup(item) {
    const key = this.eligible(item.bytes);
    if (!key || !this.healthy() || item.cacheEpoch !== this.broker.cacheEpoch) return null;
    const definition = BY_KEY.get(key);
    let sample, reply, zero = false;
    if (definition.txOnly) {
      const state = this.entry('1c00', item.cacheEpoch);
      if (!state) return null;
      if (state.reply[6] === 0) {
        // The MK2 CI-V specification returns zero for Po/SWR/ALC while RX.
        // Never manufacture that reply from an expired/unknown RX state.
        sample = state; zero = true;
        reply = Buffer.from([0xfe, 0xfe, 0xe0, this.broker.options.address, 0x15, item.bytes[5], 0, 0, 0xfd]);
      }
    }
    if (!sample) { sample = this.entry(key, item.cacheEpoch); if (!sample) return null; reply = Buffer.from(sample.reply); }
    if (!item.suppressCacheStatistics) {
      const counters = this.stats.get(key); counters.localAnswers++; if (zero) counters.zeroReplies++;
    }
    return { ...sample, reply, ageMs: this.broker.options.now() - sample.filledAt, zero };
  }
  tick() {
    if (!this.healthy()) return;
    const now = this.broker.options.now();
    for (const definition of DEFINITIONS) {
      const { key, safety, txOnly } = definition;
      if (!safety && !this.enabledKey(key)) continue;
      if (txOnly && this.actualTx() !== true) continue;
      if (now < (this.nextDue.get(key) ?? -Infinity)) continue;
      if (this.jobs.has(key)) { this.stats.get(key).backpressureSkips++; continue; }
      if (safety) this.broker.poll();
      else this.broker.internal([...Buffer.from(key, 'hex')], false, false, 'telemetryPoll').catch(() => {});
    }
  }
  snapshot() {
    const b = this.broker;
    return { enabled: this.active, requested: b.options.telemetryEnabled, invalidations: this.invalidations,
      querySettings: DEFINITIONS.map((definition) => {
        const sample = this.samples.get(definition.key), fresh = Boolean(this.entry(definition.key)), sharing = this.active && this.enabledKey(definition.key);
        return { key: definition.key, intervalMs: definition.intervalMs, maxAgeMs: definition.maxAgeMs,
          txOnly: Boolean(definition.txOnly), polling: this.healthy() && (definition.safety || sharing) && (!definition.txOnly || this.actualTx() === true),
          sharing, fresh, sampleAgeMs: sample ? Math.max(0, b.options.now() - sample.filledAt) : null,
          inFlightOrQueued: this.jobs.has(definition.key), ...this.stats.get(definition.key) };
      }) };
  }
}
module.exports = { SharedTelemetry, DEFINITIONS };
