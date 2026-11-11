'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Histogram, BrokerMetrics } = require('../src/metrics');

test('timing buckets include exact deadline boundaries and remain bounded', () => {
    const histogram = new Histogram();
    for (const value of [0, 1, 349, 350, 351, 2001, -1, NaN, Infinity]) histogram.add(value);
    const result = histogram.snapshot();
    assert.equal(result.count, 7); assert.equal(result.atLeast350Ms, 3);
    assert.equal(result.buckets.reduce((a, b) => a + b, 0), 7);
    assert.equal(result.buckets.length, 12); assert.equal(result.maxMs, 2001);
    result.buckets[0] = 999;
    assert.notEqual(histogram.snapshot().buckets[0], 999);
});

test('physical dispatch kinds and terminal logical outcomes conserve admitted work', () => {
    let now = 0; const metrics = new BrokerMetrics(() => now);
    const one = { cachePolicy: {}, serial: 1 };
    metrics.admit(one); now = 50; metrics.start(one, 'clientRead'); now = 60;
    metrics.reply(one); metrics.finish(one, 'completed'); metrics.finish(one, 'cancelled', 'session_loss');
    const two = { cachePolicy: {} }; now = 70; metrics.admit(two);
    now = 90; metrics.finish(two, 'cancelled', 'client_disconnect');
    const three = { cachePolicy: {} }; metrics.admit(three); now = 100;
    metrics.start(three, 'clientRead'); now = 200; metrics.finish(three, 'cancelled', 'session_loss');
    const internal = { internal: true }; metrics.start(internal, 'periodicPoll'); metrics.reply(internal);
    const result = metrics.snapshot();
    assert.equal(result.physicalTotal, 3); assert.equal(result.physical.clientRead, 2);
    assert.equal(result.physical.periodicPoll, 1); assert.equal(result.responses, 2);
    assert.equal(result.logical.admitted, 3); assert.equal(result.logical.completed, 1);
    assert.equal(result.logical.cancelled, 2); assert.equal(result.logical.active, 0);
    assert.equal(result.eligible.cancelledBeforeDispatch, 1); assert.equal(result.eligible.cancelledAfterDispatch, 1);
    assert.equal(result.timings.successfulReply.maxMs, 60); assert.equal(result.timings.radioRtt.maxMs, 10);
    assert.equal(result.timings.cancelledWait.maxMs, 110);
});

test('query reasons and cache fill origins expose counts without accepting unbounded labels', () => {
    let now = 0; const metrics = new BrokerMetrics(() => now);
    for (let n = 0; n < 300; n++) metrics.reason('misses', 'absent', { key: n.toString(16).padStart(4, '0') });
    metrics.reason('misses', 'sensitive-error-value', { key: 'private-password' });
    const item = { serial: 1 }; metrics.admit(item); now = 10;
    metrics.hit(item, { filledThroughSerial: 1, fillOrigin: 'periodicPoll' }, 5);
    metrics.hit(item, { filledThroughSerial: 1, fillOrigin: 'client' }, 5);
    metrics.hit(item, { filledThroughSerial: 0, fillOrigin: 'client' }, 5);
    const result = metrics.snapshot();
    assert.equal(Object.keys(result.byQuery).length, 128); assert.equal(result.reasons.misses.other, 1);
    assert.deepEqual(result.cacheHits, { completedCache: 1, queuedClientFill: 1, queuedInternalFill: 1 });
    assert.ok(!JSON.stringify(result).includes('sensitive-error-value'));
    assert.ok(!JSON.stringify(result).includes('private-password'));
});


test('background telemetry is counted as paid radio traffic rather than a saved query', () => {
    const metrics = new BrokerMetrics(() => 0);
    metrics.start({ internal: true }, 'telemetryPoll');
    metrics.start({ internal: true }, 'periodicPoll');
    const result = metrics.snapshot();
    assert.equal(result.physical.telemetryPoll, 1);
    assert.equal(result.physical.periodicPoll, 1);
    assert.equal(result.physicalTotal, 2);
    assert.equal(result.logical.admitted, 0);
});
