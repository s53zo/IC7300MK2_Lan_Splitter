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
        console.log('Usage: node scripts/hardware-smoke.js --run --radio-available [--dummy-load --tx] [--check-tuning] [--observe-seconds N] [--handover-cycles N]');
        console.log('Requires normal ICOM_* runtime settings. Confirm availability before running.');
        console.log('Default: two native clients, read frequency/mode, RX PCM and scope.');
        console.log('--check-tuning temporarily changes frequency by 10 Hz and restores it.');
        console.log('--observe-seconds 1..120 checks continued RX; use 35 to check token renewal.');
        console.log('--handover-cycles 1..10 repeats the brief ownership test when --tx is used.');
        console.log('--tx additionally tests brief PTT ownership; requires a connected suitable dummy load.');
        return;
    }
    if (!process.argv.includes('--radio-available')) throw new Error('Confirm that no other remote session needs the radio using --radio-available');
    const tx = process.argv.includes('--tx');
    const cycleIndex = process.argv.indexOf('--handover-cycles');
    const handoverCycles = cycleIndex < 0 ? 1 : Number(process.argv[cycleIndex + 1]);
    if (!Number.isInteger(handoverCycles) || handoverCycles < 1 || handoverCycles > 10) {
        throw new Error('--handover-cycles must be an integer from 1 to 10');
    }
    const observeIndex = process.argv.indexOf('--observe-seconds');
    const observeSeconds = observeIndex < 0 ? 0 : Number(process.argv[observeIndex + 1]);
    if (observeIndex >= 0 && (!Number.isInteger(observeSeconds) || observeSeconds < 1 || observeSeconds > 120)) {
        throw new Error('--observe-seconds must be an integer from 1 to 120');
    }
    if (tx && !process.argv.includes('--dummy-load')) throw new Error('TX requires confirmed dummy-load readiness using --dummy-load');
    const options = config();
    options.server = { ...options.server, bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0 };
    options.radio.reconnectAttempts = 0;
    const service = new Splitter(options);
    const clients = [];
    const began = new Date().toISOString();
    let radioAddress;
    let tuningCheck = 'not requested';
    let tokenRenewed = false;
    const upstreamStates = [], controlStatuses = [];
    service.on('status', ({ state }) => { upstreamStates.push(state); if (upstreamStates.length > 10) upstreamStates.shift(); });
    const controlPayload = service.session.controlPayload.bind(service.session);
    service.session.controlPayload = (packet) => {
        if (packet.length === 80) {
            controlStatuses.push({ replyType: packet[20], requestType: packet[21],
                sequence: packet.readUInt16BE(22), status: packet.readUInt32LE(48),
                disconnect: packet[64], tokenMatches: Boolean(service.session.authId
                    && packet.subarray(26, 32).equals(service.session.authId)) });
            if (controlStatuses.length > 8) controlStatuses.shift();
        }
        return controlPayload(packet);
    };
    const command = (cmd, data = []) => Buffer.from([0xfe, 0xfe, radioAddress, 0xe0, cmd, ...data, 0xfd]);
    const read = async (peer, cmd, data = [], match = (f) => f[4] === cmd) => {
        const start = peer.frames.length;
        const rejectsBefore = service.broker.stats.rejected;
        peer.sendCiv(command(cmd, data));
        await until(() => peer.frames.slice(start).some((f) => match(f) || f[4] === 0xfa), 'command reply');
        const reply = peer.frames.slice(start).find((f) => match(f) || f[4] === 0xfa);
        if (reply[4] === 0xfa) {
            // A generic NG carries no request ID. These fields describe the
            // current request window, not definitive origin/correlation.
            const diagnostic = { sourceHint: service.broker.stats.rejected > rejectsBefore ? 'local rejection occurred' : 'no local rejection observed',
                requestedCommand: [cmd, ...data].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
                ready: service.broker.ready, observedTx: service.broker.observedTx,
                owner: Boolean(service.broker.owner), lease: service.broker.lease,
                releasing: service.broker.releasing, stopRequested: service.broker.stopRequested,
                upstreamConnected: service.session.connected, clientConnected: peer.connected,
                ownerIsThisClient: Boolean(service.broker.owner?.streams.control.port === peer.control.localPort),
                queued: service.broker.queue.length, upstreamStates, controlStatuses };
            throw new Error(`CI-V probe rejection: ${JSON.stringify(diagnostic)}`);
        }
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
        if (process.argv.includes('--check-tuning')) {
            const original = Buffer.from(frequency.subarray(5, -1));
            const decimal = [...original].reverse().map((byte) => byte.toString(16).padStart(2, '0')).join('');
            assert.match(decimal, /^\d{10}$/, 'radio frequency must contain valid BCD');
            const hz = Number(decimal);
            const targetHz = hz < 74000000 ? hz + 10 : hz - 10;
            const target = Buffer.from(String(targetHz).padStart(10, '0').match(/../g).reverse().map((byte) => parseInt(byte, 16)));
            let attempted = false;
            try {
                attempted = true;
                await read(clients[0], 5, [...target], (f) => f[4] === 0xfb);
                const changed = await read(clients[1], 3);
                assert.deepEqual(changed.subarray(5, -1), target, 'second client observes first client tuning');
                tuningCheck = '10 Hz change observed by second client and original restored';
            } finally {
                if (attempted && service.session.connected) {
                    // The operator may have moved the front-panel dial. Restore
                    // only if the radio still has the exact value we wrote.
                    const current = await read(clients[1], 3);
                    if (current.subarray(5, -1).equals(target)) {
                        await read(clients[0], 5, [...original], (f) => f[4] === 0xfb);
                        const restored = await read(clients[1], 3);
                        assert.deepEqual(restored.subarray(5, -1), original, 'original frequency restored');
                    } else {
                        tuningCheck = 'external tuning preserved; automatic restoration skipped';
                    }
                }
            }
        }
        if (observeSeconds) {
            const audioBefore = clients.map((p) => p.audioBytes);
            const authBefore = service.session.lastAuth;
            await sleep(observeSeconds * 1000);
            assert.ok(service.broker.ready && service.session.connected, 'radio remains connected');
            assert.ok(clients.every((p, i) => p.connected && p.audioBytes > audioBefore[i]), 'both clients continue receiving audio');
            tokenRenewed = service.session.lastAuth > authBefore;
            if (observeSeconds >= 35) assert.ok(tokenRenewed, 'upstream token renewed during observation');
        }
        if (tx) {
            for (let cycle = 0; cycle < handoverCycles; cycle++) {
                if (cycle) await clients[0].open();
                // No mode, tuning, power or modulation-route changes. PTT is
                // intentionally brief; this does not measure RF or audio quality.
                await read(clients[0], 0x1c, [0, 1], (f) => f[4] === 0xfb);
                const keyed = await read(clients[0], 0x1c, [0]);
                assert.equal(keyed[6], 1, 'radio confirms first owner TX state');
                const before = clients[1].frames.length;
                clients[1].sendCiv(command(0x1c, [0, 1]));
                await until(() => clients[1].frames.slice(before).some((f) => f[4] === 0xfa), 'competing TX rejected');
                await sleep(200);
                // Disconnect the owner and verify the broker releases before handover.
                await clients[0].close();
                await until(() => !service.broker.owner && !service.broker.releasing, 'owner disconnect confirmed RX');
                const state = await read(clients[1], 0x1c, [0]);
                assert.equal(state[6], 0);
                // Exercise the formerly rejected client as the next owner. Neither
                // its old PTT request nor buffered work may be replayed implicitly.
                await read(clients[1], 0x1c, [0, 1], (f) => f[4] === 0xfb);
                const nextOwner = await read(clients[1], 0x1c, [0]);
                assert.equal(nextOwner[6], 1, 'radio confirms second owner TX state');
                await sleep(100);
                await read(clients[1], 0x1c, [0, 0], (f) => f[4] === 0xfb);
                await until(() => !service.broker.owner && !service.broker.releasing, 'second owner confirmed RX');
                const finalState = await read(clients[1], 0x1c, [0]);
                assert.equal(finalState[6], 0, 'radio ends in receive');
            }
        }
        console.log(JSON.stringify({ result: 'pass', began, finished: new Date().toISOString(),
            platform: process.platform, node: process.version, clients: 2,
            codec: '4 / 48000 Hz mono PCM16', radioAddress: radioAddress.toString(16),
            identity: 'IC-7300MK2', frequencyRead: true, modeRead: true,
            tuningCheck, observationSeconds: observeSeconds, upstreamTokenRenewed: tokenRenewed,
            handoverCycles: tx ? handoverCycles : 0,
            audioBytes: clients.map((p) => p.audioBytes),
            scopeFrames: clients.map((p) => p.frames.filter((f) => f[4] === 0x27 && f.length >= 490).length),
            pttHandoverTest: tx ? 'both owners confirmed TX; final receive confirmed' : 'not requested',
            pttOwnershipTest: tx ? 'passed via protocol replies; RF not measured' : 'not requested',
            limits: 'Firmware, RF power/quality, audible playback and long-duration reliability require independent observations.' }, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ result: 'fail', error: error.message,
            brokerReady: service.broker.ready, upstreamStates, controlStatuses }));
        throw error;
    } finally {
        // Service shutdown owns TX cleanup even when any assertion failed.
        await service.close();
        await Promise.allSettled(clients.map((peer) => peer.close()));
    }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
