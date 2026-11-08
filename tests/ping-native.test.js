'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until } = require('./fixtures/harness');

test('real native loopback associations expose measured ping for radio and client without new sessions', async (t) => {
    const x = await setup(t);
    await x.connect();
    const downstream = [...x.service.server.clients.values()][0];
    const upstream = x.service.session.control;
    const peer = downstream.streams.control;
    assert.equal(upstream.pingSnapshot().lastMs, null);
    await until(() => upstream.pingSnapshot().samples >= 1 && peer.pingSnapshot().samples >= 1, 'native echoed heartbeat measurements');
    for (const stream of [upstream, peer]) {
        const ping = stream.pingSnapshot();
        assert.ok(Number.isFinite(ping.lastMs) && ping.lastMs >= 0);
        assert.ok(Number.isFinite(ping.averageMs)); assert.equal(ping.stale, false);
    }
    assert.deepEqual(x.radio.connections, { control: 1, civ: 1, audio: 1 });
    const sentPings = x.radio.received.filter(({ role, packet }) => role === 'control' && packet.readUInt16LE(4) === 7 && packet[16] === 0);
    assert.ok(sentPings.length >= 1);
    const elapsed = upstream.now() - upstream.startedAt;
    assert.ok(sentPings.length <= Math.floor(elapsed / 500) + 1, 'measurement must use only scheduled heartbeats');
});
