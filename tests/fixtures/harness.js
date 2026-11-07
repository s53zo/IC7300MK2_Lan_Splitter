'use strict';

const assert = require('node:assert/strict');
const { IcomPeer } = require('./icom-radio');
const { IcomSession } = require('../../src/icom-lan/session');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = 'condition', timeoutMs = 3000) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${message}`);
        await sleep(5);
    }
}
function frame(command, data = [], controller = 0xe0) {
    return Buffer.from([0xfe, 0xfe, 0xb6, controller, command, ...data, 0xfd]);
}
function frames(bytes) {
    const out = [];
    let start = 0;
    for (let end = 0; end < bytes.length; end++) {
        if (bytes[end] === 0xfd) {
            const candidate = bytes.subarray(start, end + 1);
            if (candidate[0] === 0xfe && candidate[1] === 0xfe) out.push(Buffer.from(candidate));
            start = end + 1;
        }
    }
    return out;
}
async function client(address, overrides = {}) {
    const session = new IcomSession({ host: '127.0.0.1', ...address,
        username: 'beer', password: 'beer', timeoutMs: 2000,
        reconnectAttempts: 0, ...overrides });
    session.receivedCiv = [];
    session.receivedAudio = [];
    session.on('civ', (bytes) => session.receivedCiv.push(...frames(bytes)));
    session.on('rx-audio', (bytes) => session.receivedAudio.push(Buffer.from(bytes)));
    try { await session.open(); }
    catch (error) { await session.close(); throw error; }
    return session;
}
async function setup(t, overrides = {}) {
    const { Splitter } = require('../../src/splitter');
    const radio = await new IcomPeer(overrides.radioFixture).start();
    const service = new Splitter({
        radio: radio.config({ reconnectAttempts: 5, reconnectMs: 30, ...overrides.radio }),
        server: { bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0,
            timeoutMs: 2000, ...overrides.server },
        broker: { requestTimeoutMs: 500, pollMs: 50, ...overrides.broker },
    });
    const clients = [];
    t.after(async () => {
        await Promise.allSettled(clients.map((peer) => peer.close()));
        await service.close();
        await radio.close();
    });
    await service.start();
    await until(() => service.broker.ready, 'broker readiness');
    async function connect(options) {
        const peer = await client(service.address(), options);
        clients.push(peer);
        return peer;
    }
    return { radio, service, clients, connect };
}
module.exports = { sleep, until, frame, frames, client, setup };
