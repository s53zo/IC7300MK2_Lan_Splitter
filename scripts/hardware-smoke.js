#!/usr/bin/env node
'use strict';

// Opt-in hardware probe. Credentials come exclusively from runtime config.
const assert = require('node:assert/strict');
const { Splitter } = require('../src/splitter');
const { IcomSession } = require('../src/icom-lan/session');
const { config } = require('../src/config');
const { FrameParser } = require('../src/broker');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, ms = 10000) {
    const deadline = performance.now() + ms;
    while (!predicate()) {
        if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await sleep(10);
    }
}

async function run() {
    if (!process.argv.includes('--run')) {
        console.log('Usage: node scripts/hardware-smoke.js --run --radio-available [--dummy-load --tx]');
        console.log('Requires normal ICOM_* runtime settings. Confirm availability before running.');
        console.log('Default: two native clients, read frequency/mode, RX PCM and scope.');
        console.log('--tx additionally tests brief PTT ownership; requires a connected suitable dummy load.');
        return;
    }
    if (!process.argv.includes('--radio-available')) throw new Error('Confirm that no other remote session needs the radio using --radio-available');
    const tx = process.argv.includes('--tx');
    if (tx && !process.argv.includes('--dummy-load')) throw new Error('TX requires confirmed dummy-load readiness using --dummy-load');
    const options = config();
    options.server = { ...options.server, bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0 };
    options.radio.reconnectAttempts = 0;
    const service = new Splitter(options);
    const clients = [];
    const began = new Date().toISOString();
    let radioAddress;
    const command = (cmd, data = []) => Buffer.from([0xfe, 0xfe, radioAddress, 0xe0, cmd, ...data, 0xfd]);
    const read = async (peer, cmd, data = [], match = (f) => f[4] === cmd) => {
        const start = peer.frames.length;
        peer.sendCiv(command(cmd, data));
        await until(() => peer.frames.slice(start).some((f) => match(f) || f[4] === 0xfa), 'command reply');
        const reply = peer.frames.slice(start).find((f) => match(f) || f[4] === 0xfa);
        assert.notEqual(reply[4], 0xfa, 'radio rejected probe command');
        return reply;
    };
    try {
        await service.start();
        radioAddress = service.broker.options.address;
        for (let i = 0; i < 2; i++) {
            const peer = new IcomSession({ host: '127.0.0.1', ...service.address(),
                username: options.radio.username, password: options.radio.password,
                reconnectAttempts: 0, timeoutMs: 10000 });
            clients.push(peer);
            peer.frames = [];
            peer.audioBytes = 0;
            const parser = new FrameParser();
            peer.on('civ', (bytes) => peer.frames.push(...parser.push(bytes)));
            peer.on('rx-audio', (bytes) => { peer.audioBytes += bytes.length; });
            await peer.open();
        }
        const identity = await read(clients[0], 0x19, [0]);
        assert.equal(identity[6], 0xb6, 'hardware must identify as IC-7300MK2');
        const frequency = await read(clients[0], 3);
        const mode = await read(clients[1], 4);
        assert.equal(frequency.length, 11);
        assert.ok(mode.length >= 7);
        await until(() => clients.every((p) => p.audioBytes > 0
            && p.frames.some((f) => f[4] === 0x27 && f.length >= 490)), 'two-client audio and full scope');
        if (tx) {
            // No mode, tuning, power or modulation-route changes. PTT is
            // intentionally brief; this does not measure RF or audio quality.
            await read(clients[0], 0x1c, [0, 1], (f) => f[4] === 0xfb);
            const before = clients[1].frames.length;
            clients[1].sendCiv(command(0x1c, [0, 1]));
            await until(() => clients[1].frames.slice(before).some((f) => f[4] === 0xfa), 'competing TX rejected');
            await sleep(200);
            // Disconnect the owner and verify the broker releases before handover.
            await clients[0].close();
            await until(() => !service.broker.owner && !service.broker.releasing, 'owner disconnect confirmed RX');
            const state = await read(clients[1], 0x1c, [0]);
            assert.equal(state[6], 0);
        }
        console.log(JSON.stringify({ result: 'pass', began, finished: new Date().toISOString(),
            platform: process.platform, node: process.version, clients: 2,
            codec: '4 / 48000 Hz mono PCM16', radioAddress: radioAddress.toString(16),
            identity: 'IC-7300MK2', frequencyRead: true, modeRead: true,
            audioBytes: clients.map((p) => p.audioBytes),
            scopeFrames: clients.map((p) => p.frames.filter((f) => f[4] === 0x27 && f.length >= 490).length),
            pttOwnershipTest: tx ? 'passed via protocol replies; RF not measured' : 'not requested',
            limits: 'Firmware, RF power/quality, audible playback and long-duration reliability require independent observations.' }, null, 2));
    } finally {
        // Service shutdown owns TX cleanup even when any assertion failed.
        await service.close();
        await Promise.allSettled(clients.map((peer) => peer.close()));
    }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
