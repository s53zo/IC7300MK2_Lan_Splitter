'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomStream } = require('../src/icom-lan/stream');
const P = require('../src/icom-lan/protocol');

function setup(options = {}) {
    let time = 0;
    const stream = new IcomStream({ role: 'audio', now: () => time, ...options });
    Object.assign(stream, { localId: 1, remoteId: 2, ready: true, lastRx: 0, lastPing: 0, lastIdle: 0 });
    const packets = [];
    stream.raw = (p) => packets.push(Buffer.from(p));
    function echo(p, overrides = {}) {
        const reply = P.packet(21, P.TYPE.PING, overrides.sender ?? 2, overrides.receiver ?? 1,
            overrides.seq ?? p.readUInt16LE(6));
        reply[16] = overrides.kind ?? 1;
        reply.writeUInt32LE(overrides.stamp ?? p.readUInt32LE(17), 17);
        stream.receive(reply);
    }
    return { stream, packets, at: (value) => { time = value; }, echo };
}

test('native heartbeat reports measured RTT without extra packets or payload changes', () => {
    const x = setup();
    assert.deepEqual(x.stream.pingSnapshot(), { lastMs: null, averageMs: null, samples: 0, measuredAt: null, stale: true });
    x.at(500.25); x.stream.tick();
    assert.equal(x.packets.length, 1);
    const request = x.packets[0];
    assert.equal(request.length, 21); assert.equal(request[16], 0);
    assert.equal(request.readUInt16LE(6), 0); assert.equal(request.readUInt32LE(17), 500);
    x.at(512.75); x.echo(request);
    assert.deepEqual(x.stream.pingSnapshot(), { lastMs: 12.5, averageMs: 12.5, samples: 1, measuredAt: 512.75, stale: false });
    assert.equal(x.packets.length, 1, 'observing replies must not send traffic');
    x.at(1000.25); x.stream.tick(); x.at(1020.75); x.echo(x.packets[1]);
    assert.equal(x.stream.pingSnapshot().averageMs, 16.5);
});

test('unmatched, stale, wrong-association and duplicate echoes cannot fabricate ping samples', () => {
    const x = setup(); x.at(500); x.stream.tick(); const request = x.packets[0];
    x.at(510);
    for (const overrides of [{ seq: 99 }, { stamp: 999 }, { sender: 99 }, { receiver: 99 }, { kind: 2 }]) x.echo(request, overrides);
    assert.equal(x.stream.pingSnapshot().samples, 0);
    x.echo(request); x.echo(request);
    assert.equal(x.stream.pingSnapshot().samples, 1);
    assert.equal(x.stream.pingSnapshot().lastMs, 10);
    x.at(1000); x.stream.tick(); const old = x.packets.at(-1);
    x.at(6000); x.echo(old);
    assert.equal(x.stream.pingSnapshot().samples, 1, 'expired request is not a latency sample');
    assert.equal(x.stream.pingSnapshot().stale, true);
});

test('incoming native requests preserve their echoed stamp and do not count as RTT replies', () => {
    const x = setup();
    const request = P.packet(21, P.TYPE.PING, 2, 1, 52); request.writeUInt32LE(0x12345678, 17);
    x.stream.receive(request);
    assert.equal(x.packets.length, 1);
    assert.equal(x.packets[0].subarray(16).toString('hex'), '0178563412');
    assert.equal(x.stream.pingSnapshot().samples, 0);
});

test('ping history and unmatched requests stay bounded; stale state is explicit', () => {
    const x = setup({ timeoutMs: 1000000 });
    for (let i = 0; i < 70; i++) {
        x.at((i + 1) * 500); x.stream.tick(); x.at((i + 1) * 500 + i); x.echo(x.packets.at(-1));
    }
    assert.equal(x.stream.pingReplies.length, 64);
    assert.equal(x.stream.pingSnapshot().samples, 70);
    assert.equal(x.stream.pingSnapshot().averageMs, (6 + 69) / 2);
    const measuredAt = x.stream.pingSnapshot().measuredAt;
    x.at(measuredAt + 1999); assert.equal(x.stream.pingSnapshot().stale, false);
    x.at(measuredAt + 2000); assert.equal(x.stream.pingSnapshot().stale, true);
    for (let i = 80; i < 1080; i++) { x.at(i * 500); x.stream.lastRx = i * 500; x.stream.tick(); }
    assert.ok(x.stream.pendingPings.size <= 10);
    x.at(600000); x.stream.pingSnapshot(); assert.equal(x.stream.pendingPings.size, 0);
});

test('sequence and wire timestamp wrap still use the precise monotonic send time', () => {
    const x = setup({ timeoutMs: 1e10 }); x.stream.pingSeq = 65535;
    const now = 2 ** 32 + 500.25; x.at(now); x.stream.lastRx = now; x.stream.tick();
    assert.equal(x.packets[0].readUInt16LE(6), 65535); assert.equal(x.packets[0].readUInt32LE(17), 500);
    x.at(now + 7.5); x.echo(x.packets[0]); assert.equal(x.stream.pingSnapshot().lastMs, 7.5);
    x.at(now + 500); x.stream.tick(); assert.equal(x.packets[1].readUInt16LE(6), 0);
});

test('failure, close and a fresh start retire measurements and outstanding echoes', async () => {
    const x = setup(); x.at(500); x.stream.tick(); const old = x.packets[0]; x.at(510); x.echo(old);
    x.stream.fail('synthetic failure');
    assert.deepEqual(x.stream.pingSnapshot(), { lastMs: null, averageMs: null, samples: 0, measuredAt: null, stale: true });
    await x.stream.close(); assert.equal(x.stream.pendingPings.size, 0);
    const y = setup(); y.at(500); y.stream.tick(); y.at(510); y.echo(y.packets[0]);
    y.stream.start(); assert.equal(y.stream.pingSnapshot().samples, 0);
    await y.stream.close(); assert.equal(y.stream.pendingPings.size, 0);
});
