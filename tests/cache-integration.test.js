'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until, frame } = require('./fixtures/harness');

test('real UDP clients share an outstanding meter read and receive independently addressed answers', async (t) => {
    const { radio, service, connect } = await setup(t, { broker: { pollMs: 10000 } });
    const a = await connect(), b = await connect();
    const original = radio.civ.bind(radio);
    let held, first = true;
    let clientRequests = 0;
    service.server.on('command', (_client, bytes) => {
        if (bytes[4] === 0x15 && bytes[5] === 2) clientRequests++;
    });
    radio.civ = (bytes, association) => {
        if (first && bytes[4] === 0x15 && bytes[5] === 2) {
            first = false;
            held = () => original(bytes, association);
        } else original(bytes, association);
    };
    a.sendCiv(frame(0x15, [2], 0xe1));
    await until(() => held, 'first radio request held');
    b.sendCiv(frame(0x15, [2], 0xe2));
    await until(() => clientRequests === 2, 'both logical client reads admitted');
    held();
    await until(() => a.receivedCiv.some((f) => f[4] === 0x15)
        && b.receivedCiv.some((f) => f[4] === 0x15), 'separate data replies');
    assert.equal(radio.commands.filter((f) => f[4] === 0x15 && f[5] === 2).length, 1);
    assert.equal(a.receivedCiv.find((f) => f[4] === 0x15)[2], 0xe1);
    assert.equal(b.receivedCiv.find((f) => f[4] === 0x15)[2], 0xe2);
    assert.equal(service.broker.cacheSnapshot().coalesced, 1);
});

test('real UDP tuning mutation cannot be hidden by a cached frequency response', async (t) => {
    const { radio, connect } = await setup(t, { broker: { pollMs: 10000 } });
    const a = await connect(), b = await connect();
    a.sendCiv(frame(3));
    await until(() => a.receivedCiv.some((f) => f[4] === 3), 'original frequency');
    const changed = Buffer.from('0000071400', 'hex');
    a.sendCiv(frame(5, [...changed]));
    b.sendCiv(frame(3));
    await until(() => b.receivedCiv.some((f) => f[4] === 3), 'post-write frequency');
    assert.deepEqual(b.receivedCiv.find((f) => f[4] === 3).subarray(5, -1), changed);
    assert.equal(radio.commands.filter((f) => f[4] === 3).length, 2);
});

test('main-scope getters return their selector and reuse only a valid scope reply', async (t) => {
    const { radio, service, connect } = await setup(t, { broker: { pollMs: 10000, now: () => 0 } });
    const a = await connect(), b = await connect();
    a.sendCiv(frame(0x27, [0x15, 0]));
    await until(() => a.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0x15), 'scope span getter');
    b.sendCiv(frame(0x27, [0x15, 0]));
    await until(() => b.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0x15), 'cached scope span');
    assert.deepEqual(b.receivedCiv.find((f) => f[4] === 0x27 && f[5] === 0x15).subarray(4, -1),
        Buffer.from([0x27, 0x15, 0, 0, 0, 5, 0, 0]));
    assert.equal(radio.commands.filter((f) => f[4] === 0x27 && f[5] === 0x15).length, 1);
    assert.equal(service.broker.cacheSnapshot().byQuery['271500'].hits, 1);
});
