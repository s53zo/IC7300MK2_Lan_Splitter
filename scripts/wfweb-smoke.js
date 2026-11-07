#!/usr/bin/env node
'use strict';

// Opt-in interoperability probe. Uses only a synthetic radio and fixture
// credentials. Never starts a hardware radio session or requests transmission.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { Splitter } = require('../src/splitter');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await sleep(20);
    }
}

async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
}

async function main() {
    if (!process.argv.includes('--run')) {
        console.log('Usage: node scripts/wfweb-smoke.js --run [--binary /path/to/wfweb]');
        console.log('Opt-in synthetic-radio test of an existing, unmodified wfweb executable.');
        return;
    }
    const binaryArg = process.argv.indexOf('--binary');
    if (binaryArg >= 0 && !process.argv[binaryArg + 1]) throw new Error('--binary needs a path');
    const binary = path.resolve(binaryArg >= 0 ? process.argv[binaryArg + 1] : '../wfweb/wfweb');
    await fs.access(binary, fs.constants.X_OK);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-splitter-wfweb-'));
    const settings = path.join(directory, 'wfweb.ini');
    const logfile = path.join(directory, 'wfweb.log');
    const radio = await new IcomPeer().start();
    const service = new Splitter({ radio: radio.config(), server: {
        bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0,
    } });
    const commands = [];
    const replies = [];
    const faults = [];
    service.server.on('command', (_client, bytes) => commands.push(Buffer.from(bytes)));
    const sendCiv = service.server.sendCiv.bind(service.server);
    service.server.sendCiv = (client, bytes) => {
        replies.push(Buffer.from(bytes));
        return sendCiv(client, bytes);
    };
    service.on('fault', (error) => faults.push(error.message));
    let child;
    let output = '';
    let deadline;
    try {
        await service.start();
        await until(() => service.broker.ready, 'splitter readiness', 3000);
        // A Radios array keeps wfweb's first-run defaults from overwriting
        // these settings. Native server and rigctld listeners are disabled.
        await fs.writeFile(settings, [
            '[General]', 'AudioSystem=0', 'Manufacturer=0', 'RigCtldEnabled=false',
            '[Radios]', 'size=1', '1\\RigCIVuInt=182', '1\\PTTType=0',
            '1\\SerialPortRadio=none', '1\\RigName=IC-7300MK2',
            '1\\SerialPortBaud=115200', '1\\AudioInput=default',
            '1\\AudioOutput=default', '1\\WaterfallFormat=0',
            '[Server]', 'ServerEnabled=false',
            '[LAN]', 'EnableLAN=true', 'AudioRXSampleRate=48000',
            'AudioRXCodec=4', 'AudioTXCodec=4', '',
        ].join('\n'));
        const address = service.address();
        child = spawn(binary, [
            '--settings', settings, '--no-web', '--no-rigctld',
            '--lan', '127.0.0.1', '--lan-control', String(address.controlPort),
            '--lan-serial', String(address.civPort), '--lan-audio', String(address.audioPort),
            '--lan-user', 'beer', '--lan-pass', 'beer', '--civ', '0xB6',
            '--logfile', logfile, '--debug',
        ], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(directory, 'config'),
            XDG_DATA_HOME: path.join(directory, 'data'),
            XDG_CACHE_HOME: path.join(directory, 'cache'),
            QT_QPA_PLATFORM: 'offscreen',
        } });
        const record = (chunk) => { output = (output + chunk.toString()).slice(-128 * 1024); };
        child.stdout.on('data', record);
        child.stderr.on('data', record);
        let spawnError;
        child.on('error', (error) => { spawnError = error; });
        deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
        const clients = () => [...service.server.clients.values()];
        await until(() => {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('wfweb exited before media opened');
            return clients().some((c) => c.authenticated && c.granted
                && c.streams.civ?.ready && c.streams.audio?.ready);
        }, 'unmodified wfweb authentication and both media handshakes');
        await until(() => commands.some((p) => [3, 0x19, 0x25, 0x26].includes(p[4])), 'wfweb frequency, mode, or identity query');
        await until(() => replies.some((p) => p[4] === 0x25 && p.length === 12
            && p[5] === 0 && p.subarray(6, -1).equals(radio.frequency))
            && replies.some((p) => p[4] === 0x26 && p.length === 10 && p[5] === 0
                && p[6] === radio.mode && p[7] === Number(radio.dataMode) && p[8] === radio.filter),
        'native frequency and mode data replies matching the simulated radio');
        const client = clients().find((c) => c.authenticated && c.granted);
        const generation = service.session.generation;
        const stableSince = performance.now();
        const delivered = { audioPackets: 0, scopePackets: 0 };
        // Observe existing output; do not change bytes or transport behavior.
        for (const role of ['civ', 'audio']) {
            const stream = client.streams[role];
            const raw = stream.raw.bind(stream);
            stream.raw = (packet) => {
                if (packet.readUInt16LE(4) === 0) {
                    if (role === 'audio' && packet.length > 24) delivered.audioPackets++;
                    if (role === 'civ' && packet.length > 500 && packet[25] === 0x27) delivered.scopePackets++;
                }
                return raw(packet);
            };
        }
        for (let i = 0; i < 300; i++) {
            radio.rxAudio(Buffer.alloc(1920));
            if (i % 5 === 0) radio.scope();
            await sleep(20);
            assert.equal(service.session.generation, generation, 'upstream must not reset during client polling');
            assert.equal(service.broker.ready, true, 'broker must remain ready during client polling');
            assert.equal(client.active, true, 'wfweb association must remain active');
        }
        await until(() => delivered.audioPackets > 0 && delivered.scopePackets > 0, 'audio and complete scope forwarding');
        assert.equal(faults.length, 0, 'splitter transport faults');
        assert.equal(radio.txAudio.length, 0, 'probe must not send TX audio');
        assert.equal(radio.ptt, false, 'probe must remain in receive');
        console.log(JSON.stringify({
            result: 'pass', binary, platform: process.platform, architecture: process.arch,
            upstream: 'synthetic IC-7300MK2', client: 'unmodified wfweb executable',
            codec: '4 / 48000 Hz mono LPCM16',
            authenticated: true, mediaHandshakes: ['civ', 'audio'],
            downstreamCivCommands: commands.length,
            responsesForwarded: replies.length,
            semanticQueryReplies: ['selected VFO frequency', 'selected VFO mode/data/filter'],
            stablePollingMs: Math.round(performance.now() - stableSince),
            commandPrefixes: [...new Set(commands.map((p) => p.subarray(4, Math.min(p.length - 1, 7)).toString('hex')))],
            forwardedToClient: delivered,
            limits: 'Audio/scope packet forwarding observed; playback, rendering, RF, and TX interoperability are not validated.',
        }, null, 2));
    } catch (error) {
        let log = '';
        try { log = (await fs.readFile(logfile, 'utf8')).slice(-24000); } catch { /* child may not have opened a log */ }
        console.error('wfweb synthetic interoperability probe failed:', error.message);
        console.error(JSON.stringify({ brokerReady: service.broker.ready, sessionState: service.session.state,
            commandPrefixes: radio.commands.map((p) => p.subarray(4, Math.min(p.length - 1, 8)).toString('hex')).slice(-40),
            replyPrefixes: replies.map((p) => p.subarray(4, Math.min(p.length - 1, 9)).toString('hex')).slice(-40),
            faults,
        }, null, 2));
        console.error((output + '\n' + log).split('\n').filter((line) => /WRN|ERR|Critical|failed|timed out/i.test(line)).slice(-12).join('\n'));
        throw error;
    } finally {
        clearTimeout(deadline);
        await stop(child);
        await service.close();
        await radio.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
