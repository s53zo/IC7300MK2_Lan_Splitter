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

test('same timed client trace halves physical reads without changing reply order', async (t) => {
    async function replay(cacheEnabled) {
        const x = await setup(t, { cacheEnabled });
        const trace = [meter, [0x10], meter, [0x11], meter, [0x12], meter, meter];
        for (const [i, payload] of trace.entries()) { x.at(i * 7); x.send(i % 2 ? x.b : x.a, payload); await tick(); }
        return { commands: x.radio.commands.length, replies: x.server.sent.map(({ id, bytes }) => [id, bytes.toString('hex')]), metrics: x.broker.metricsSnapshot() };
    }
    const on = await replay(true), off = await replay(false);
    assert.equal(on.commands, 4); assert.equal(off.commands, 8);
    assert.deepEqual(on.replies, off.replies);
    assert.equal(on.metrics.logical.completed, 8);
    assert.equal(on.metrics.physical.clientRead, 4); assert.equal(on.metrics.physical.clientWrite, 0);
});

test('completed and cancelled eligible requests conserve admission before and after dispatch', async (t) => {
    const x = await setup(t);
    x.send(x.a, meter); await tick();
    x.radio.auto = false;
    x.send(x.a, [0x19, 0]); x.send(x.b, meter);
    x.b.active = false; x.server.emit('disconnect', x.b);
    x.radio.respond();
    x.at(100); x.send(x.a, meter); x.a.active = false; x.server.emit('disconnect', x.a); x.radio.respond();
    const m = x.broker.metricsSnapshot(), c = x.broker.cacheSnapshot();
    assert.equal(m.logical.active, 0); assert.equal(m.eligible.completed, 1);
    assert.equal(m.eligible.cancelledBeforeDispatch, 1); assert.equal(m.eligible.cancelledAfterDispatch, 1);
    assert.equal(m.logical.admitted, m.logical.completed + m.logical.cancelled);
    assert.equal(c.requests, c.hits + c.misses + m.eligible.queued + m.eligible.cancelledBeforeDispatch);
    assert.equal(x.server.sent.filter(({ bytes }) => bytes[4] === 0x15).length, 1);
});

test('fresh coalesced reply can exceed client deadline solely through queue wait', async (t) => {
    const x = await setup(t); x.radio.auto = false;
    x.send(x.a, [0x19, 0], 0xe1);
    x.at(1); x.send(x.a, meter, 0xe1);
    x.at(2); x.send(x.b, meter, 0xe2);
    x.at(400); x.radio.respond();
    x.at(405); x.radio.respond();
    const m = x.broker.metricsSnapshot();
    assert.deepEqual(x.server.sent.map(({ id, bytes }) => [id, bytes[2], bytes[4]]), [['a', 0xe1, 0x19], ['a', 0xe1, 0x15], ['b', 0xe2, 0x15]]);
    assert.equal(x.radio.commands.length, 2);
    assert.equal(m.timings.queueWait.maxMs, 403); assert.equal(m.timings.cacheAge.maxMs, 0);
    assert.equal(m.timings.successfulReply.atLeast350Ms, 3);
    assert.equal(m.cacheHits.queuedClientFill, 1);
});

test('physical accounting separates startup, fresh periodic polling, clients and release', async (t) => {
    const x = await setup(t);
    assert.equal(x.broker.metricsSnapshot().physical.startup, 5);
    x.broker.poll(); await tick();
    const polled = x.broker.metricsSnapshot();
    assert.equal(polled.physical.periodicPoll, 1);
    x.send(x.a, [0x1c, 0]); await tick();
    assert.equal(x.broker.metricsSnapshot().physical.clientRead, 0);
    assert.equal(x.broker.cacheSnapshot().hits, 1);
    x.send(x.a, meter); await tick(); x.send(x.a, [0x14, 1, 0, 0x50]); await tick();
    await x.broker.release();
    const m = x.broker.metricsSnapshot();
    assert.equal(m.physical.clientRead, 1); assert.equal(m.physical.clientWrite, 1);
    assert.equal(m.physical.release, 3);
    assert.equal(m.physicalTotal, x.radio.commands.length + 5);
});

test('miss and invalidation reasons remain bounded and never include reply values', async (t) => {
    const x = await setup(t);
    x.send(x.a, meter); await tick(); x.at(100); x.send(x.a, meter); await tick();
    x.radio.auto = false; x.at(200); x.send(x.a, meter);
    x.radio.emit('civ', answer([0x15, 2, 0xff, 0xff]));
    x.send(x.a, [0x19, 0]); x.radio.respond();
    x.radio.emit('civ', Buffer.from([0xfe, 0xfe, 0, 0xb6, 1, 1, 1, 0xfd]));
    const m = x.broker.metricsSnapshot();
    assert.ok(m.reasons.misses.absent >= 1); assert.equal(m.reasons.misses.expired, 2);
    assert.equal(m.reasons.storeSkips.invalid_reply, 1); assert.ok(m.reasons.storeSkips.unknown_query >= 1);
    assert.ok(m.reasons.invalidations.notification >= 1);
    const serialized = JSON.stringify(m);
    assert.equal(serialized.includes('ffff'), false);
    assert.equal(serialized.includes('fefe'), false);
    assert.deepEqual(Object.keys(m.byQuery).sort(), ['04', '1502', '1c00']);
});


test('query-disabled telemetry does not misreport a disabled family or suppress fresh safety reads', async (t) => {
    const x = await setup(t, { cacheQueryTtls: { '1c00': 0 } });
    const before = x.broker.metricsSnapshot();
    x.broker.poll(); await tick();
    const after = x.broker.metricsSnapshot();
    assert.equal(after.physical.periodicPoll - before.physical.periodicPoll, 1);
    assert.equal(after.reasons.storeSkips.query_disabled - before.reasons.storeSkips.query_disabled, 1);
    assert.equal(after.reasons.storeSkips.family_disabled, 0);
    assert.equal(x.broker.cacheSnapshot().querySettings.find((row) => row.key === '1c00').effectiveMs, 0);
});
