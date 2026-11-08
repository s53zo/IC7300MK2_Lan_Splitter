#!/usr/bin/env node
'use strict';

// Packaged CLI integration test. All UDP endpoints are loopback synthetic
// fixtures; no physical radio, user credentials, PTT or TX audio are used.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { client, frame, sleep } = require('../tests/fixtures/harness');

async function availablePorts() {
    const sockets = [];
    try {
        for (let i = 0; i < 3; i++) {
            const socket = dgram.createSocket('udp4');
            sockets.push(socket);
            await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
        }
        return sockets.map((socket) => socket.address().port);
    } finally { await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
}

function launch(executable, args, options) {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const state = { child, stdout: '', stderr: '', exited: false, code: null, error: null };
    child.stdout.on('data', (chunk) => { state.stdout = (state.stdout + chunk.toString()).slice(-32768); });
    child.stderr.on('data', (chunk) => { state.stderr = (state.stderr + chunk.toString()).slice(-32768); });
    child.on('error', (error) => { state.error = error; });
    state.closed = new Promise((resolve) => child.once('close', (code) => { state.exited = true; state.code = code; resolve(); }));
    return state;
}

async function waitFor(predicate, label, state, timeoutMs = 15000) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        if (state?.error) throw state.error;
        if (state?.exited) throw new Error(`Packaged CLI exited before ${label} (code ${state.code})`);
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await sleep(10);
    }
}

async function stop(state) {
    if (!state || state.exited) return;
    state.child.kill('SIGTERM');
    const timer = setTimeout(() => state.child.kill('SIGKILL'), 5000);
    try { await state.closed; } finally { clearTimeout(timer); }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/release-smoke.js --executable PATH');
        console.log('Development only: node scripts/release-smoke.js --source');
        return;
    }
    const source = args.length === 1 && args[0] === '--source';
    if (!source && (args.length !== 2 || args[0] !== '--executable')) throw new Error('Use --executable PATH or --source');
    const executable = source ? process.execPath : path.resolve(args[1]);
    const prefix = source ? [path.resolve(__dirname, '../src/cli.js')] : [];
    await fs.access(executable, fs.constants.X_OK);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-release-smoke-'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ICOM_')
        && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
    let help, service, radio;
    const peers = [];
    try {
        // Run away from the repository: bundled code must not resolve source
        // files or dependencies from the current working directory.
        help = launch(executable, [...prefix, '--help'], { cwd: directory, env });
        await waitFor(() => help.exited, '--help exit', null);
        if (help.error) throw help.error;
        assert.equal(help.code, 0, '--help exit status');
        assert.match(help.stdout, /Usage: icom-lan-splitter/);
        assert.match(help.stdout, /ICOM_PASSWORD_FILE/);
        radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
        const upstream = radio.config();
        const [controlPort, civPort, audioPort] = await availablePorts();
        const passwordFile = path.join(directory, 'fixture-password');
        await fs.writeFile(passwordFile, 'testpass\n', { mode: 0o600 });
        const serviceEnv = { ...env, ICOM_RADIO_HOST: '127.0.0.1', ICOM_BIND_ADDRESS: '127.0.0.1',
            ICOM_USERNAME: 'beer', ICOM_PASSWORD_FILE: passwordFile,
            ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort),
            ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort), ICOM_LISTEN_CONTROL_PORT: String(controlPort),
            ICOM_LISTEN_CIV_PORT: String(civPort), ICOM_LISTEN_AUDIO_PORT: String(audioPort) };
        service = launch(executable, prefix, { cwd: directory, env: serviceEnv });
        await waitFor(() => service.stdout.includes('Ready: 127.0.0.1 UDP'), 'CLI readiness', service);
        const address = { host: '127.0.0.1', controlPort, civPort, audioPort };
        peers.push(await client(address, { password: 'testpass' }));
        peers.push(await client(address, { password: 'testpass' }));
        assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 }, 'exactly one upstream session');
        peers[0].sendCiv(frame(3, [], 0xe1));
        peers[1].sendCiv(frame(4, [], 0xe2));
        await waitFor(() => peers[0].receivedCiv.some((f) => f[4] === 3)
            && peers[1].receivedCiv.some((f) => f[4] === 4), 'private query replies', service);
        const frequency = peers[0].receivedCiv.find((f) => f[4] === 3);
        const mode = peers[1].receivedCiv.find((f) => f[4] === 4);
        assert.equal(frequency[2], 0xe1); assert.deepEqual(frequency.subarray(5, -1), radio.frequency);
        assert.equal(mode[2], 0xe2); assert.deepEqual(mode.subarray(5, -1), Buffer.from([radio.mode, radio.filter]));
        assert.equal(peers[0].receivedCiv.some((f) => f[4] === 4), false, 'mode reply remains private');
        assert.equal(peers[1].receivedCiv.some((f) => f[4] === 3), false, 'frequency reply remains private');
        const pcm = Buffer.alloc(1364, 0x31), samples = Buffer.alloc(475, 0x45);
        radio.rxAudio(pcm); radio.scope(samples);
        await waitFor(() => peers.every((peer) => peer.receivedAudio.length > 0
            && peer.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0)), 'shared audio and scope', service);
        for (const peer of peers) {
            assert.deepEqual(peer.receivedAudio[0], pcm);
            const scope = peer.receivedCiv.find((f) => f[4] === 0x27 && f[5] === 0);
            assert.equal(scope.length, 497); assert.deepEqual(scope.subarray(21, -1), samples);
        }
        assert.equal(radio.ptt, false); assert.equal(radio.txAudio.length, 0);
        assert.equal(radio.commands.some((f) => f[4] === 0x1c && f[5] === 0 && f[6] === 1), false);
        assert.equal((service.stdout + service.stderr).includes('testpass'), false, 'fixture password must not appear in diagnostics');
        console.log(JSON.stringify({ result: 'pass', mode: source ? 'source' : 'standalone',
            platform: process.platform, architecture: process.arch, clients: peers.length,
            upstreamSessions: 1, passwordFile: 'verified', privateReplies: 'verified',
            audioAndScope: 'exact payloads verified', physicalRadioUsed: false, txRequested: false }));
    } finally {
        await Promise.allSettled(peers.map((peer) => peer.close()));
        await stop(service); await stop(help);
        if (radio) await radio.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(`Release smoke test failed: ${error.message}`); process.exitCode = 1; });
