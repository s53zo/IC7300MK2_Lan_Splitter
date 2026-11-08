'use strict';

// Bounded, value-free telemetry. Never pass packet bytes or error messages here.
const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 350, 500, 1000, 2000];
class Histogram {
    constructor() { this.count = 0; this.sumMs = 0; this.maxMs = 0; this.atLeast350Ms = 0; this.buckets = Array(BOUNDS.length + 1).fill(0); }
    add(value) {
        if (!Number.isFinite(value)) return;
        value = Math.max(0, value);
        this.count++; this.sumMs += value; this.maxMs = Math.max(this.maxMs, value);
        if (value >= 350) this.atLeast350Ms++;
        const at = BOUNDS.findIndex((bound) => value <= bound);
        this.buckets[at < 0 ? BOUNDS.length : at]++;
    }
    snapshot() {
        return { count: this.count, sumMs: this.sumMs, maxMs: this.maxMs,
            atLeast350Ms: this.atLeast350Ms, upperBoundsMs: [...BOUNDS, null], buckets: [...this.buckets] };
    }
}
const REASONS = {
    misses: ['absent', 'expired', 'admission_epoch', 'entry_epoch', 'generation', 'other'],
    storeSkips: ['disabled', 'family_disabled', 'query_disabled', 'unstable', 'admission_epoch', 'invalid_reply', 'unknown_query', 'other'],
    invalidations: ['mutation_admission', 'mutation_dispatch', 'mutation_outcome', 'notification', 'lifecycle', 'tx_transition', 'negative_reply', 'observed_tx', 'other'],
    rejected: ['invalid_radio', 'permission', 'queue_capacity', 'other'],
    cancelled: ['client_disconnect', 'media_generation', 'permission', 'session_loss', 'tx_transition', 'queue_capacity', 'other'],
};
const PHYSICAL = ['clientRead', 'clientWrite', 'periodicPoll', 'startup', 'release', 'internal'];
const zeroes = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
class BrokerMetrics {
    constructor(now) {
        this.now = now;
        this.startedAt = now();
        this.physical = zeroes(PHYSICAL);
        this.physicalSendErrors = 0;
        this.radioTimeouts = 0;
        this.oneWayDispatches = 0;
        this.logical = { admitted: 0, completed: 0, negative: 0, cancelled: 0, cancelledBeforeDispatch: 0, cancelledAfterDispatch: 0, rejectedBeforeAdmission: 0 };
        this.eligible = { admitted: 0, completed: 0, negative: 0, cancelled: 0, cancelledBeforeDispatch: 0, cancelledAfterDispatch: 0 };
        this.responses = 0;
        this.reasons = Object.fromEntries(Object.entries(REASONS).map(([key, values]) => [key, zeroes(values)]));
        this.invalidationEntries = { removed: 0, empty: 0 };
        this.cacheHits = { completedCache: 0, queuedClientFill: 0, queuedInternalFill: 0 };
        this.evictions = 0;
        this.suppressedQueuedReads = 0;
        this.byQuery = new Map();
        this.histograms = Object.fromEntries(['queueWait', 'radioRtt', 'endToEnd', 'successfulReply', 'cancelledWait', 'cacheAge'].map((name) => [name, new Histogram()]));
    }
    reason(scope, reason, policy) {
        const counters = this.reasons[scope];
        const key = Object.hasOwn(counters, reason) ? reason : 'other';
        counters[key]++;
        if (!policy || !/^(?:[0-9a-f]{2}){1,5}$/.test(policy.key)) return;
        if (!this.byQuery.has(policy.key)) {
            if (this.byQuery.size >= 128) return;
            this.byQuery.set(policy.key, { misses: zeroes(REASONS.misses), storeSkips: zeroes(REASONS.storeSkips) });
        }
        const query = this.byQuery.get(policy.key);
        if (query[scope]) query[scope][key]++;
    }
    admit(item) {
        item.admittedAt = this.now();
        this.logical.admitted++;
        if (item.cachePolicy) this.eligible.admitted++;
    }
    start(item, purpose) {
        item.dispatchedAt = this.now();
        const key = Object.hasOwn(this.physical, purpose) ? purpose : 'internal';
        this.physical[key]++;
        if (item.policy?.oneWay) this.oneWayDispatches++;
        if (!item.internal) this.histograms.queueWait.add(item.dispatchedAt - item.admittedAt);
    }
    reply(item) {
        this.responses++;
        if (item.dispatchedAt !== undefined) this.histograms.radioRtt.add(this.now() - item.dispatchedAt);
    }
    local(item) { this.histograms.queueWait.add(this.now() - item.admittedAt); }
    hit(item, entry, age) {
        this.histograms.queueWait.add(this.now() - item.admittedAt);
        this.histograms.cacheAge.add(age);
        const queued = item.serial <= entry.filledThroughSerial;
        this.cacheHits[queued ? entry.fillOrigin === 'client' ? 'queuedClientFill' : 'queuedInternalFill' : 'completedCache']++;
    }
    finish(item, outcome, reason, negative = false) {
        if (item.internal || item.metricsFinished) return;
        item.metricsFinished = true;
        for (const counters of item.cachePolicy ? [this.logical, this.eligible] : [this.logical]) {
            if (outcome === 'cancelled') {
                counters.cancelled++;
                counters[item.dispatchedAt === undefined ? 'cancelledBeforeDispatch' : 'cancelledAfterDispatch']++;
            } else { counters.completed++; if (negative) counters.negative++; }
        }
        if (outcome === 'cancelled') this.reason('cancelled', reason);
        const elapsed = this.now() - item.admittedAt;
        if (outcome === 'cancelled') this.histograms.cancelledWait.add(elapsed);
        else { this.histograms.endToEnd.add(elapsed); if (!negative) this.histograms.successfulReply.add(elapsed); }
    }
    snapshot() {
        return { elapsedMs: Math.max(0, this.now() - this.startedAt), physical: { ...this.physical }, physicalTotal: Object.values(this.physical).reduce((a, b) => a + b, 0),
            physicalSendErrors: this.physicalSendErrors, radioTimeouts: this.radioTimeouts, oneWayDispatches: this.oneWayDispatches, responses: this.responses,
            logical: { ...this.logical, active: this.logical.admitted - this.logical.completed - this.logical.cancelled },
            eligible: { ...this.eligible, active: this.eligible.admitted - this.eligible.completed - this.eligible.cancelled },
            reasons: Object.fromEntries(Object.entries(this.reasons).map(([key, value]) => [key, { ...value }])),
            invalidationEntries: { ...this.invalidationEntries }, cacheHits: { ...this.cacheHits }, evictions: this.evictions, suppressedQueuedReads: this.suppressedQueuedReads,
            timings: Object.fromEntries(Object.entries(this.histograms).map(([key, value]) => [key, value.snapshot()])),
            byQuery: Object.fromEntries([...this.byQuery].map(([key, value]) => [key,
                Object.fromEntries(Object.entries(value).map(([scope, counts]) => [scope, { ...counts }]))])) };
    }
}
module.exports = { Histogram, BrokerMetrics };
