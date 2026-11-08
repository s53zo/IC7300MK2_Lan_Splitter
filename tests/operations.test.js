'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { IcomPeer } = require('./fixtures/icom-radio');
const { setup, until, sleep, client, frame } = require('./fixtures/harness');
const { IcomSession } = require('../src/icom-lan/session');

async function availablePorts() {
    const sockets = [];
    try {
        for (let n = 0; n < 3; n++) {
            const socket = dgram.createSocket('udp4');
            sockets.push(socket);
            await new Promise((resolve, reject) => {
                socket.once('error', reject);
                socket.bind(0, '127.0.0.1', resolve);
            });
        }
        return sockets.map((socket) => socket.address().port);
    } finally {
        await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    }
}

test('service.start resolves only after the radio is confirmed in receive state', async (t) => {
    const { radio, service } = await setup(t);
    assert.equal(service.broker.ready, true);
    assert.equal(radio.ptt, false);
    const release = radio.commands.findIndex((f) => f[4] === 0x1c && f[5] === 0 && f[6] === 0);
    const confirm = radio.commands.findIndex((f, index) => index > release && f[4] === 0x1c && f[5] === 0 && f.length === 7);
    assert.ok(release >= 0 && confirm > release, 'PTT release precedes independent TX-state query');
});

test('closing upstream during handshake rejects open and closes every bound socket', async (t) => {
    const radio = await new IcomPeer({ silent: true }).start();
    const session = new IcomSession(radio.config());
    t.after(async () => { await session.close(); await radio.close(); });
    const opening = session.open();
    const rejected = assert.rejects(opening, /closed/i);
    await until(() => session.streams?.length === 3 && session.streams.every((stream) => stream.socket), 'upstream sockets bound');
    const streams = [...session.streams];
    await session.close();
    await rejected;
    assert.equal(session.connected, false);
    assert.equal(session.streams.length, 0);
    for (const stream of streams) {
        assert.equal(stream.socket, null);
        assert.ok(!stream.timer || stream.timer._destroyed, 'handshake timer destroyed');
    }
    await sleep(30);
    assert.equal(session.state, 'disconnected');
});

test('CLI SIGTERM releases active TX, confirms receive, and exits without leaked handles', {
    skip: process.platform === 'win32' ? 'Windows SIGTERM forcibly terminates; use console Ctrl+C for graceful shutdown' : false,
}, async (t) => {
    // Synthetic 8-character password with a literal encoded vector; no radio
    // credentials or hardware endpoints are used by this child process.
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    const [controlPort, civPort, audioPort] = await availablePorts();
    const radioConfig = radio.config();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ICOM_')));
    Object.assign(env, { ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass',
        ICOM_BIND_ADDRESS: '127.0.0.1', ICOM_RADIO_CONTROL_PORT: String(radioConfig.controlPort),
        ICOM_RADIO_CIV_PORT: String(radioConfig.civPort), ICOM_RADIO_AUDIO_PORT: String(radioConfig.audioPort),
        ICOM_LISTEN_CONTROL_PORT: String(controlPort), ICOM_LISTEN_CIV_PORT: String(civPort),
        ICOM_LISTEN_AUDIO_PORT: String(audioPort), ICOM_COMMAND_TIMEOUT_MS: '500' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exited = false, exitCode;
    child.stdout.on('data', (bytes) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
    const exit = new Promise((resolve) => child.once('exit', (code) => { exited = true; exitCode = code; resolve(); }));
    let peer;
    t.after(async () => {
        if (!exited) { child.kill('SIGKILL'); await exit; }
        if (peer) await peer.close();
        await radio.close();
    });
    await until(() => stdout.includes('Ready:') || exited, 'CLI readiness');
    assert.equal(exited, false, stderr);
    peer = await client({ controlPort, civPort, audioPort }, { password: 'testpass' });
    peer.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt, 'CLI relays TX');
    const before = radio.commands.length;
    child.kill('SIGTERM');
    await until(() => exited, 'CLI shutdown', 3000);
    await exit;
    assert.equal(exitCode, 0, stderr);
    assert.equal(radio.ptt, false);
    assert.ok(radio.commands.slice(before).some((f) => f[4] === 0x1c && f[5] === 0 && f.length === 7), 'shutdown queries TX state');
    assert.match(stdout, /Stopping/);
    assert.equal(stdout.includes('testpass') || stderr.includes('testpass'), false, 'password absent from logs');
});

test('immediate service close cannot reopen listeners or a radio session after binding completes', async (t) => {
    const { Splitter } = require('../src/splitter');
    const radio = await new IcomPeer({ silent: true }).start();
    const service = new Splitter({ radio: radio.config(), server: {
        bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0,
    } });
    t.after(async () => { await service.close(); await radio.close(); });
    const opening = assert.rejects(service.start(), /stopping|closed/);
    await service.close();
    await opening;
    await sleep(50);
    assert.equal(service.server.started, false);
    assert.equal(service.session.stopped, true);
    assert.equal(service.session.connected, false);
    assert.deepEqual(service.server.sockets, {});
    assert.equal(radio.connections.control, 0, 'cancelled startup never logs into radio');
});

test('hardware probe requires explicit availability before reading config or opening sockets', () => {
    const { spawnSync } = require('node:child_process');
    const help = spawnSync(process.execPath, ['scripts/hardware-smoke.js'], { encoding: 'utf8', env: {} });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /radio-available/);
    const guarded = spawnSync(process.execPath, ['scripts/hardware-smoke.js', '--run'], { encoding: 'utf8', env: {} });
    assert.equal(guarded.status, 1);
    assert.match(guarded.stderr, /no other remote session/);
    const tx = spawnSync(process.execPath, ['scripts/hardware-smoke.js', '--run', '--radio-available', '--tx'], { encoding: 'utf8', env: {} });
    assert.equal(tx.status, 1);
    assert.match(tx.stderr, /dummy-load/);
    for (const args of [['--observe-seconds', '121'], ['--handover-cycles', '0']]) {
        const bad = spawnSync(process.execPath, ['scripts/hardware-smoke.js', '--run', '--radio-available', ...args], { encoding: 'utf8', env: {} });
        assert.equal(bad.status, 1);
        assert.ok(bad.stderr.includes(args[0]));
    }
});

for (const tx of [false, true]) {
    test(`opt-in hardware probe completes ${tx ? 'dummy-load PTT' : 'receive/control'} procedure against synthetic radio`, async (t) => {
        // Both modes target independently encoded localhost UDP fixtures.
        // --dummy-load here is synthetic test input, never hardware readiness.
        const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
        const address = radio.config();
        const [listenControl, listenCiv, listenAudio] = await availablePorts();
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ICOM_')));
        Object.assign(env, { ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass',
            ICOM_RADIO_CONTROL_PORT: String(address.controlPort), ICOM_RADIO_CIV_PORT: String(address.civPort),
            ICOM_RADIO_AUDIO_PORT: String(address.audioPort),
            ICOM_LISTEN_CONTROL_PORT: String(listenControl), ICOM_LISTEN_CIV_PORT: String(listenCiv),
            ICOM_LISTEN_AUDIO_PORT: String(listenAudio) });
        const args = ['scripts/hardware-smoke.js', '--run', '--radio-available'];
        args.push('--check-tuning');
        if (tx) args.push('--tx', '--dummy-load', '--handover-cycles', '2');
        else args.push('--observe-seconds', '1');
        const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', exited = false, exitCode;
        child.stdout.on('data', (bytes) => { stdout += bytes.toString(); });
        child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
        const exit = new Promise((resolve) => child.once('exit', (code) => { exited = true; exitCode = code; resolve(); }));
        const media = setInterval(() => {
            if (radio.associations.audio) radio.rxAudio(Buffer.alloc(1920));
            if (radio.associations.civ) radio.scope();
        }, 20);
        t.after(async () => {
            clearInterval(media);
            if (!exited) { child.kill('SIGKILL'); await exit; }
            await radio.close();
        });
        await until(() => exited, 'hardware probe against synthetic radio', 10000);
        assert.equal(exitCode, 0, stderr);
        const result = JSON.parse(stdout);
        assert.equal(result.result, 'pass');
        assert.equal(result.clients, 2);
        assert.match(result.tuningCheck, /original restored/);
        assert.equal(result.observationSeconds, tx ? 0 : 1);
        assert.ok(result.audioBytes.every((n) => n > 0));
        assert.ok(result.scopeFrames.every((n) => n > 0));
        assert.equal(radio.connections.control, 1);
        assert.equal(radio.ptt, false, 'probe exits with simulated radio in receive');
        assert.equal(radio.commands.some((f) => f[4] === 0x1c && f[5] === 0 && f[6] === 1), tx);
        assert.equal(result.pttOwnershipTest.startsWith('passed'), tx);
        assert.equal(result.pttHandoverTest.startsWith('both owners confirmed'), tx);
        assert.equal(result.handoverCycles, tx ? 2 : 0);
        assert.equal(stdout.includes('testpass') || stderr.includes('testpass'), false);
    });
}
