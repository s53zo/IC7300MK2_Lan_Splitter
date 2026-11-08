#!/usr/bin/env node
'use strict';

// Real packaged terminal UI, real native LAN clients, synthetic loopback radio.
// Fixture PTT is memory-only: no hardware endpoints or RF transmission are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { client, frame, until, sleep } = require('../tests/fixtures/harness');
const { SettingsStore } = require('../src/app/store');
const { defaults } = require('../src/app/settings');

async function ports() {
    const sockets = [];
    try {
        for (let i = 0; i < 3; i++) {
            const socket = dgram.createSocket('udp4'); sockets.push(socket);
            await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
        }
        return sockets.map((socket) => socket.address().port);
    } finally { await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--executable') throw new Error('Usage: node scripts/tui-native-smoke.js --executable PATH');
    if (process.platform === 'win32') throw new Error('The native terminal integration probe needs a POSIX PTY.');
    const executable = path.resolve(args[1]); await fs.access(executable, fs.constants.X_OK);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-tui-native-'));
    const xdg = path.join(directory, 'xdg');
    const noArguments = process.platform === 'linux';
    const configuration = noArguments ? path.join(xdg, 'icom-lan-splitter') : path.join(directory, 'config');
    const peers = [];
    let radio, bridge, closed = false, exitCode, launchError, output = '', stderr = '';
    let bridgeExit;
    async function observe(predicate, label, timeout = 15000) {
        await until(() => {
            if (launchError) throw new Error(`Could not launch PTY bridge: ${launchError.code || 'unknown error'}`);
            if (closed && !predicate()) throw new Error(`Packaged TUI exited before ${label} (code ${exitCode})`);
            return predicate();
        }, label, timeout);
    }
    try {
        radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
        const upstream = radio.config();
        const [controlPort, civPort, audioPort] = await ports();
        const values = { ...defaults(), ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_BIND_ADDRESS: '127.0.0.1',
            ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort),
            ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort), ICOM_LISTEN_CONTROL_PORT: String(controlPort),
            ICOM_LISTEN_CIV_PORT: String(civPort), ICOM_LISTEN_AUDIO_PORT: String(audioPort) };
        await new SettingsStore(configuration).save(values, 'testpass');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ICOM_')
            && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
        Object.assign(env, { XDG_CONFIG_HOME: xdg, TERM: 'xterm-256color' });
        const cliArgs = noArguments ? [] : ['--tui', '--config-dir', configuration];
        bridge = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'tui-bridge.py'), '--', executable, ...cliArgs],
            { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
        bridge.stdout.on('data', (bytes) => { output = (output + bytes.toString()).slice(-1000000); });
        bridge.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-4096); });
        bridge.on('error', (error) => { launchError = error; });
        bridgeExit = new Promise((resolve) => bridge.once('close', (code) => { closed = true; exitCode = code; resolve(); }));
        await observe(() => radio.connections.control === 1 && radio.associations.audio && output.includes('Radio: Connected'), 'saved-settings automatic connection');
        assert.equal(output.includes('First launch: enter radio address'), false, 'saved setup must not request configuration again');
        const address = { host: '127.0.0.1', controlPort, civPort, audioPort };
        peers.push(await client(address, { password: 'testpass' }));
        peers.push(await client(address, { password: 'testpass' }));
        await observe(() => output.includes('Clients: 2'), 'two clients displayed by real terminal UI');
        assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 }, 'one upstream logical session');
        peers[0].sendCiv(frame(3, [], 0xe1)); peers[1].sendCiv(frame(4, [], 0xe2));
        await observe(() => peers[0].receivedCiv.some((f) => f[4] === 3) && peers[1].receivedCiv.some((f) => f[4] === 4), 'private client replies');
        const frequency = peers[0].receivedCiv.find((f) => f[4] === 3), mode = peers[1].receivedCiv.find((f) => f[4] === 4);
        assert.equal(frequency[2], 0xe1); assert.deepEqual(frequency.subarray(5, -1), radio.frequency);
        assert.equal(mode[2], 0xe2); assert.deepEqual(mode.subarray(5, -1), Buffer.from([radio.mode, radio.filter]));
        assert.equal(peers[0].receivedCiv.some((f) => f[4] === 4), false);
        assert.equal(peers[1].receivedCiv.some((f) => f[4] === 3), false);
        const countMeter = () => radio.commands.filter((f) => f[4] === 0x15 && f[5] === 2).length;
        const before = countMeter();
        peers[0].sendCiv(frame(0x15, [2], 0xe1)); peers[1].sendCiv(frame(0x15, [2], 0xe2));
        await observe(() => peers.every((peer) => peer.receivedCiv.some((f) => f[4] === 0x15 && f[5] === 2)), 'cached/coalesced meter replies');
        assert.equal(countMeter() - before, 1, 'two addressed meter replies from one physical radio query');
        const pcm = Buffer.alloc(1364, 0x31), samples = Buffer.alloc(475, 0x45);
        radio.rxAudio(pcm); radio.scope(samples);
        await observe(() => peers.every((peer) => peer.receivedAudio.length && peer.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0)), 'exact audio/scope forwarding');
        for (const peer of peers) {
            assert.deepEqual(peer.receivedAudio[0], pcm);
            assert.deepEqual(peer.receivedCiv.find((f) => f[4] === 0x27 && f[5] === 0).subarray(21, -1), samples);
        }
        await observe(() => /Radio ping RTT: [\d,.]+ ms/.test(output), 'measured native ping shown', 10000);
        peers[0].sendCiv(frame(0x1c, [0, 1], 0xe1));
        await observe(() => radio.ptt && peers[0].receivedCiv.some((f) => f[4] === 0xfb), 'synthetic TX owner acquired');
        let offset = output.length;
        bridge.stdin.write('q');
        await observe(() => output.slice(offset).includes('Stop transmission and close?'), 'TX close confirmation');
        offset = output.length; bridge.stdin.write('n');
        await observe(() => output.slice(offset).includes('Canceled. Current connection is unchanged.'), 'TX close canceled');
        assert.equal(closed, false); assert.equal(radio.ptt, true, 'cancel preserves transmitting owner');
        offset = output.length; bridge.stdin.write('q');
        await observe(() => output.slice(offset).includes('Stop transmission and close?'), 'second TX close confirmation');
        bridge.stdin.write('y');
        await observe(() => closed, 'confirmed terminal shutdown', 20000); await bridgeExit;
        assert.equal(exitCode, 0, 'PTY bridge and packaged terminal must exit cleanly');
        assert.equal(radio.ptt, false, 'normal shutdown releases synthetic PTT');
        assert.ok(output.includes('\x1b[?25h\x1b[?1049l'), 'terminal cursor and screen restored');
        assert.equal(stderr, '', 'PTY bridge terminal restoration verified');
        assert.equal((output + stderr).includes('testpass'), false, 'password absent from output');
        console.log(JSON.stringify({ result: 'pass', platform: process.platform, architecture: process.arch,
            packagedTui: true, noArgumentLaunch: noArguments, savedAutomaticConnection: true,
            nativeClients: 2, upstreamSessions: 1, privateReplies: true, meterPhysicalQueries: 1, meterClientReplies: 2,
            exactAudioAndScope: true, measuredPingDisplayed: true,
            syntheticTxConfirmation: true, cancelPreservesTx: true, confirmedCloseReleasesTx: true,
            terminalRestored: true, physicalRadioUsed: false, rfTransmitted: false }));
    } finally {
        await Promise.allSettled(peers.map((peer) => peer.close()));
        if (bridge && !closed) {
            bridge.kill('SIGTERM');
            await Promise.race([bridgeExit, sleep(12000)]);
            if (!closed) { bridge.kill('SIGKILL'); await bridgeExit; }
        }
        if (radio) await radio.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(`Packaged terminal integration failed: ${error.message}`); process.exitCode = 1; });
