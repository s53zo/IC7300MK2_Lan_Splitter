#!/usr/bin/env node
'use strict';

// Synthetic loopback fanout measurement. This does not measure a radio or LAN.
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { client, until, sleep } = require('../tests/fixtures/harness');
const { Splitter } = require('../src/splitter');

async function main() {
    const count = Number(process.argv[2] || 32);
    const durationMs = Number(process.argv[3] || 2000);
    if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isFinite(durationMs) || durationMs < 100) {
        throw new Error('Usage: node scripts/benchmark.js [clients 1..4096] [duration-ms >=100]');
    }
    const radio = await new IcomPeer().start();
    const service = new Splitter({ radio: radio.config(), server: { bindAddress: '127.0.0.1',
        controlPort: 0, civPort: 0, audioPort: 0, memoryBudgetBytes: (count + 2) * 8 * 1024 * 1024 }, broker: { pollMs: 100 } });
    const clients = [];
    let timer;
    try {
        await service.start();
        await until(() => service.broker.ready, 'broker readiness');
        for (let n = 0; n < count; n++) clients.push(await client(service.address()));
        let sentAudio = 0;
        let sentScope = 0;
        let receivedAudio = 0;
        let receivedScope = 0;
        let receivedBytes = 0;
        for (const peer of clients) {
            peer.on('rx-audio', (pcm) => { receivedAudio++; receivedBytes += pcm.length; });
            peer.on('civ', (bytes) => { if (bytes[4] === 0x27) receivedScope++; });
            // Keep the measurement from retaining all delivered payloads.
            peer.receivedCiv.length = 0;
            peer.receivedAudio.length = 0;
        }
        const cpuBefore = process.cpuUsage();
        const startedAt = performance.now();
        const pcmA = Buffer.alloc(1364, 0x12);
        const pcmB = Buffer.alloc(556, 0x34);
        timer = setInterval(() => {
            radio.rxAudio(pcmA); radio.rxAudio(pcmB); sentAudio += 2;
            if (sentAudio % 10 === 0) { radio.scope(); sentScope++; }
            radio.received.length = 0;
            for (const peer of clients) { peer.receivedCiv.length = 0; peer.receivedAudio.length = 0; }
        }, 20);
        await sleep(durationMs);
        clearInterval(timer);
        await sleep(200);
        const elapsedMs = performance.now() - startedAt;
        const cpu = process.cpuUsage(cpuBefore);
        console.log(JSON.stringify({ kind: 'synthetic-loopback', node: process.version,
            platform: `${process.platform}/${process.arch}`, clients: count,
            durationMs: Math.round(elapsedMs), upstreamSessions: radio.connections.control,
            sentAudio, receivedAudio, expectedAudio: sentAudio * count,
            sentScope, receivedScope, expectedScope: sentScope * count,
            audioPayloadMbps: +(receivedBytes * 8 / elapsedMs / 1000).toFixed(3),
            cpuMs: Math.round((cpu.user + cpu.system) / 1000),
            rssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        }, null, 2));
        if (receivedAudio !== sentAudio * count || receivedScope !== sentScope * count) process.exitCode = 1;
    } finally {
        clearInterval(timer);
        await Promise.allSettled(clients.map((peer) => peer.close()));
        await service.close();
        await radio.close();
    }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
