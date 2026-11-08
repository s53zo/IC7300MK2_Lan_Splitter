'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AppController } = require('../src/app/controller');
const { defaults } = require('../src/app/settings');
const { IcomPeer } = require('./fixtures/icom-radio');
const { client, frame, until } = require('./fixtures/harness');
async function availablePorts() {
    const sockets = [];
    try {
        for (let i = 0; i < 3; i++) {
            const socket = dgram.createSocket('udp4'); sockets.push(socket);
            await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
        }
        return sockets.map((socket) => socket.address().port);
    } finally { await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
}
test('local controller preserves one native session, private cached reads, media fanout and confirmed TX closure', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-app-native-'));
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    const c = new AppController({ directory }); const peers = [];
    t.after(async () => { await Promise.allSettled(peers.map((peer) => peer.close())); await c.close({ confirmedTx: true }); await radio.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await c.initialize(); const [controlPort, civPort, audioPort] = await availablePorts(); const upstream = radio.config();
    await c.saveSettings({ ...defaults(), ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass', ICOM_BIND_ADDRESS: '127.0.0.1',
        ICOM_RADIO_CONTROL_PORT: upstream.controlPort, ICOM_RADIO_CIV_PORT: upstream.civPort, ICOM_RADIO_AUDIO_PORT: upstream.audioPort,
        ICOM_LISTEN_CONTROL_PORT: controlPort, ICOM_LISTEN_CIV_PORT: civPort, ICOM_LISTEN_AUDIO_PORT: audioPort });
    await c.start(); assert.equal(c.getState().running, true);
    const address = { host: '127.0.0.1', controlPort, civPort, audioPort };
    peers.push(await client(address, { password: 'testpass' })); peers.push(await client(address, { password: 'testpass' }));
    peers[0].sendCiv(frame(0x15, [2], 0xe1)); peers[1].sendCiv(frame(0x15, [2], 0xe2));
    await until(() => peers.every((peer) => peer.receivedCiv.some((f) => f[4] === 0x15)), 'two cache getter replies');
    assert.equal(peers[0].receivedCiv.find((f) => f[4] === 0x15)[2], 0xe1);
    assert.equal(peers[1].receivedCiv.find((f) => f[4] === 0x15)[2], 0xe2);
    assert.equal(c.getState().status.cache.requests, 2); assert.equal(c.getState().status.cache.hits, 1);
    assert.equal(c.getState().clients.length, 2); assert.equal(c.getState().status.connectedUpstreamSessions, 1);
    assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
    const pcm = Buffer.alloc(1364, 0x31); radio.rxAudio(pcm); radio.scope();
    await until(() => peers.every((peer) => peer.receivedAudio.length && peer.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0)), 'native shared media');
    assert.deepEqual(peers[0].receivedAudio[0], pcm); assert.deepEqual(peers[1].receivedAudio[0], pcm);
    peers[0].sendCiv(frame(0x1c, [0, 1])); await until(() => radio.ptt, 'synthetic TX');
    assert.equal((await c.close()).requiresConfirmation, true); assert.equal(radio.ptt, true); assert.equal(c.getState().clients.length, 2);
    const stopped = await c.close({ confirmedTx: true }); assert.notEqual(stopped.releaseConfirmed, false);
    assert.equal(radio.ptt, false); assert.equal(c.getState().running, false);
});

test('closing a real pending native startup cancels retries and releases the endpoint lock promptly', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-app-pending-'));
    const radio = await new IcomPeer({ silent: true }).start(); const c = new AppController({ directory });
    t.after(async () => { await c.close({ confirmedTx: true }); await radio.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await c.initialize(); const [controlPort, civPort, audioPort] = await availablePorts(); const upstream = radio.config();
    await c.saveSettings({ ...defaults(), ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass', ICOM_BIND_ADDRESS: '127.0.0.1',
        ICOM_RADIO_CONTROL_PORT: upstream.controlPort, ICOM_RADIO_CIV_PORT: upstream.civPort, ICOM_RADIO_AUDIO_PORT: upstream.audioPort,
        ICOM_LISTEN_CONTROL_PORT: controlPort, ICOM_LISTEN_CIV_PORT: civPort, ICOM_LISTEN_AUDIO_PORT: audioPort });
    const starting = c.start(); await until(() => c.service?.server.started && c.service?.session.control, 'pending startup');
    const result = await Promise.race([c.close(), new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Startup close hung')), 2000); timer.unref(); })]);
    await starting; assert.equal(result.running, false); assert.equal(c.closed, true); assert.equal(c.service, null);
});
