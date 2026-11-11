'use strict';
// Transport doubles adapted from cache-broker.test.js; assertions use delivered
// responses and physical commands as the independent metrics oracle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Broker } = require('../src/broker');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (payload, from = 0xe0) => Buffer.from([0xfe, 0xfe, 0xb6, from, ...payload, 0xfd]);
const answer = (payload) => Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, ...payload, 0xfd]);
class Radio extends EventEmitter {
    constructor() {
        super(); this.connected = false; this.auto = true; this.commands = [];
        this.serial = this.audio = { invalidate() {} }; this.playback = { setKeyed() {} };
    }
    sendCiv(bytes) { this.commands.push(Buffer.from(bytes)); if (this.auto) queueMicrotask(() => this.respond(bytes)); }
    respond(bytes = this.commands.at(-1)) {
        const p = [...bytes.subarray(4, -1)]; let result = [0xfb];
        if (p[0] === 4 && p.length === 1) result = [4, 1, 1];
        if (p[0] === 0x15) result = [...p, 0, 0x42];
        if ([0x10, 0x11].includes(p[0]) && p.length === 1) result = [...p, 0];
        if (p[0] === 0x12 && p.length === 1) result = [0x12, 0, 0];
        if (p[0] === 0x19) result = [...p, 0xb6];
        if (p[0] === 0x1c && p.length === 2) result = [...p, 0];
        this.emit('civ', answer(result));
    }
    fail(error) { this.connected = false; this.emit('disconnected', error); }
}
class Server extends EventEmitter {
    constructor() { super(); this.sent = []; }
    sendCiv(client, bytes) { this.sent.push({ id: client.id, bytes: Buffer.from(bytes) }); }
    broadcastCiv() {}
    broadcastAudio() {}
}
async function setup(t, options = {}) {
    let now = 0;
    const radio = new Radio(), server = new Server();
    const broker = new Broker(radio, server, { pollMs: 100000, now: () => now, ...options });
    t.after(async () => { radio.auto = true; if (broker.pending) radio.respond(); await broker.close(); });
    const ready = once(broker, 'ready'); radio.connected = true; radio.emit('connected'); await ready;
    radio.commands.length = 0; server.sent.length = 0;
    const client = (id) => ({ id, active: true, mediaGeneration: 1 });
    return { radio, server, broker, a: client('a'), b: client('b'), at: (value) => { now = value; },
        send: (c, p, address) => server.emit('command', c, frame(p, address)) };
}
const meter = [0x15, 2];

test('reset retains live work and cached replies while retiring old admission accounting', async (t) => {
    const x = await setup(t);
    x.send(x.a, meter); await tick();
    x.radio.control = { counters: { lost: 5, replayed: 2 } };
    const cache = x.broker.readCache, epoch = x.broker.cacheEpoch;
    x.radio.auto = false;
    x.send(x.a, [0x19, 0]); x.send(x.b, meter);
    const pending = x.broker.pending, queued = x.broker.queue[0];
    const timer = pending.timer, generation = x.broker.generation;
    x.broker.resetStatistics();
    assert.equal(x.broker.pending, pending); assert.equal(pending.timer, timer);
    assert.equal(x.broker.queue[0], queued); assert.equal(x.broker.readCache, cache);
    assert.equal(x.broker.cacheEpoch, epoch); assert.equal(x.broker.generation, generation);
    assert.equal(x.radio.control.counters.lost, 0);
    assert.equal(x.broker.cacheSnapshot().requests, 0);
    x.radio.respond();
    assert.equal(x.server.sent.length, 3);
    assert.equal(x.broker.cacheSnapshot().hits, 0);
    assert.equal(x.broker.metricsSnapshot().logical.completed, 0);
    assert.equal(x.broker.metricsSnapshot().responses, 0);
    x.send(x.a, meter);
    assert.equal(x.broker.cacheSnapshot().requests, 1);
    assert.equal(x.broker.cacheSnapshot().hits, 1);
    assert.equal(x.broker.metricsSnapshot().logical.completed, 1);
});

test('old queued reads still dispatch and count physical work after reset without old logical latency', async (t) => {
    const x = await setup(t); x.radio.auto = false;
    x.send(x.a, [0x19, 0]); x.send(x.b, meter);
    x.broker.resetStatistics();
    x.at(20); x.radio.respond();
    assert.equal(x.broker.metricsSnapshot().physical.clientRead, 1);
    x.at(25); x.radio.respond();
    const metrics = x.broker.metricsSnapshot();
    assert.equal(metrics.responses, 1); assert.equal(metrics.timings.radioRtt.sumMs, 5);
    assert.equal(metrics.timings.queueWait.count, 0);
    assert.equal(metrics.logical.admitted, 0); assert.equal(metrics.logical.completed, 0);
    assert.equal(x.broker.cacheSnapshot().misses, 0);
});

test('reset preserves telemetry samples, jobs, due times and TX ownership', async (t) => {
    const x = await setup(t, { telemetryEnabled: true }); clearInterval(x.broker.timer);
    x.broker.telemetry.tick(); await tick();
    const telemetry = x.broker.telemetry;
    const samples = [...telemetry.samples];
    x.broker.owner = x.a; x.broker.lease = 'vox'; x.broker.activeTriggers.add('vox');
    x.radio.auto = false; x.at(100); telemetry.tick();
    const jobs = [...telemetry.jobs], due = [...telemetry.nextDue];
    x.broker.resetStatistics();
    assert.deepEqual([...telemetry.samples], samples); assert.deepEqual([...telemetry.nextDue], due);
    assert.deepEqual([...telemetry.jobs], jobs);
    assert.equal(x.broker.owner, x.a); assert.equal(x.broker.lease, 'vox'); assert(x.broker.activeTriggers.has('vox'));
    for (const row of telemetry.snapshot().querySettings) {
        assert.equal(row.rfPolls, 0); assert.equal(row.localAnswers, 0); assert.equal(row.samples, 0);
    }
    x.broker.owner = null; x.broker.lease = null; x.broker.activeTriggers.clear();
});
