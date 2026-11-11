'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomStream } = require('../src/icom-lan/stream');
const { IcomSession } = require('../src/icom-lan/session');
const P = require('../src/icom-lan/protocol');
const { IcomPeer, envelope } = require('./fixtures/icom-radio');
const { until } = require('./fixtures/harness');

function memoryStream(options = {}) {
    let time = 0;
    const stream = new IcomStream({ role: 'audio', now: () => time, ...options });
    Object.assign(stream, { localId: 1, remoteId: 2, ready: true, lastRx: 0, lastIdle: 0, lastPing: 0 });
    const submitted = [];
    stream.socket = { send(packet, done) { submitted.push({ packet: Buffer.from(packet), done }); }, close(done) { done(); } };
    const pcm = Buffer.alloc(32, 0x35);
    const send = () => stream.tracked(P.audio(1, 2, 0, pcm), { group: 'audio', append: true });
    const receive = (seq) => {
        const packet = P.audio(2, 1, seq, pcm);
        packet.writeUInt16LE(seq, 6);
        stream.receive(packet);
    };
    const heartbeat = () => stream.receive(P.packet(21, P.TYPE.PING, 2, 1));
    return { stream, submitted, send, receive, heartbeat, at: (value) => { time = value; } };
}

test('upstream media submissions and retransmits are bounded without a delayed application queue', async () => {
    const x = memoryStream({ maxPendingBytes: 120, maxPendingPackets: 2 });
    const first = x.send(); x.send();
    x.stream.receive(envelope(16, P.TYPE.RETRANSMIT, 2, 1, first));
    assert.equal(x.submitted.length, 2, 'replay must use the same media cap');
    assert.equal(x.stream.counters.sendDrops, 1);
    for (let i = 0; i < 1000; i++) x.send();
    assert.equal(x.submitted.length, 2);
    assert.equal(x.stream.outstandingBytes, 112);
    assert.equal(x.stream.outstandingSends, 2);
    assert.equal(x.stream.counters.sendDrops, 1001);
    assert.ok(x.stream.replay.size <= x.stream.maxPackets);
    x.heartbeat();
    assert.equal(x.submitted.length, 3, 'audio heartbeat keeps its own reserved allowance');
    assert.equal(x.stream.outstandingBytes, 133);
    x.stream.invalidate('audio');
    x.submitted[0].done(); x.submitted[1].done(); x.submitted[2].done();
    assert.equal(x.stream.outstandingBytes, 0);
    assert.equal(x.submitted.length, 3, 'lease invalidation and completions must not flush old media');
    x.stream.receive(envelope(16, P.TYPE.RETRANSMIT, 2, 1, first));
    assert.equal(x.submitted.at(-1).packet.length, 16, 'invalidated audio can only replay an idle');
    assert.equal(x.stream.counters.sendCompleted, 3);
    await x.stream.close();
});

test('audio saturation cannot stop independent CI-V cleanup and signal submissions stay bounded', async () => {
    const audio = memoryStream({ maxPendingBytes: 56, maxPendingPackets: 1 });
    audio.send();
    for (let i = 0; i < 1000; i++) audio.heartbeat();
    assert.ok(audio.stream.outstandingBytes <= 56 + 4096);
    assert.ok(audio.stream.outstandingSends <= 1 + 64);
    const serial = memoryStream({ role: 'CI-V', maxPendingBytes: 1, maxPendingPackets: 1 });
    serial.stream.tracked(P.serial(1, 2, 0, Buffer.from('fefeb6e01c0000fd', 'hex')), { group: 'ptt' });
    assert.equal(serial.submitted.length, 1);
    assert.equal(serial.submitted[0].packet.subarray(21).toString('hex'), 'fefeb6e01c0000fd');
    await Promise.all([audio.stream.close(), serial.stream.close()]);
});

test('lease transitions retire retained media and pending completions never dispatch an old backlog', async () => {
    const x = memoryStream({ maxPendingBytes: 56, maxPendingPackets: 1 });
    const session = new IcomSession({ host: '127.0.0.1', username: 'beer', password: 'beer' });
    session.audio = x.stream;
    session.connected = true;
    session.playback.setKeyed(true);
    session.sendAudio(Buffer.alloc(32, 0x11));
    const previous = x.submitted[0].packet.readUInt16LE(6);
    session.sendAudio(Buffer.alloc(32, 0x12));
    session.playback.setKeyed(false);
    session.sendAudio(Buffer.alloc(32, 0x13));
    assert.equal(x.submitted.length, 1);
    session.playback.setKeyed(true);
    session.sendAudio(Buffer.alloc(32, 0x21));
    assert.equal(x.submitted.length, 1, 'old submitted bytes still consume capacity across the lease boundary');
    x.submitted[0].done();
    assert.equal(x.submitted.length, 1, 'a completion cannot flush old or dropped PCM');
    session.sendAudio(Buffer.alloc(32, 0x22));
    assert.equal(x.submitted.at(-1).packet[24], 0x22);
    x.stream.receive(envelope(16, P.TYPE.RETRANSMIT, 2, 1, previous));
    assert.equal(x.submitted.at(-1).packet.length, 16);
    await x.stream.close();
});

test('transport limits reject settings that would silently disable the bounds', () => {
    for (const key of ['maxPendingBytes', 'maxPendingPackets', 'payloadStallPackets', 'payloadStallMs']) {
        for (const value of [NaN, Infinity, 0, -1]) assert.throws(() => new IcomStream({ [key]: value }), /Invalid Icom LAN/);
    }
    assert.throws(() => new IcomStream({ maxPendingPackets: 1.5 }), /Invalid Icom LAN/);
});

test('send errors release capacity and late callbacks cannot fail a retired association or resurrect reset totals', async () => {
    const x = memoryStream({ maxPendingBytes: 56, maxPendingPackets: 1 });
    const failures = [];
    x.stream.on('failure', (error) => failures.push(error));
    x.send();
    x.submitted[0].done(new Error('synthetic send error'));
    assert.equal(x.stream.counters.sendErrors, 1);
    assert.equal(x.stream.counters.sendCompleted, 1);
    assert.equal(x.stream.outstandingBytes, 0);
    assert.equal(failures.length, 1);

    const y = memoryStream();
    let lateFailures = 0;
    y.stream.on('failure', () => lateFailures++);
    y.send();
    y.stream.resetStatistics();
    assert.equal(y.stream.outstandingBytes, 56, 'reset must preserve the actual pending gauge');
    y.submitted[0].done(new Error('pre-reset completion'));
    assert.equal(y.stream.outstandingBytes, 0);
    assert.equal(y.stream.counters.sendErrors, 0);
    assert.equal(y.stream.counters.sendCompleted, 0);
    assert.equal(lateFailures, 1, 'a live error remains a transport failure after statistics reset');
    await y.stream.close();
    for (const item of y.submitted) item.done(new Error('late callback'));
    assert.equal(y.stream.outstandingBytes, 0);
    assert.equal(y.stream.outstandingSends, 0);
    assert.equal(lateFailures, 1);
    assert.equal(y.stream.counters.sendErrors, 0);
    await x.stream.close();
});

test('synchronous send failures do not leak outstanding accounting', async () => {
    const x = memoryStream();
    x.stream.socket.send = () => { throw new Error('synthetic closed socket'); };
    let failures = 0;
    x.stream.on('failure', () => failures++);
    assert.doesNotThrow(x.send);
    assert.equal(x.stream.outstandingBytes, 0);
    assert.equal(x.stream.outstandingSends, 0);
    assert.equal(x.stream.counters.sendErrors, 1);
    assert.equal(failures, 1);
    await x.stream.close();
});

test('session reset preserves live pending gauges and suppresses retired counters while socket close is pending', async () => {
    const x = memoryStream();
    const session = new IcomSession({ host: '127.0.0.1', username: 'beer', password: 'beer' });
    session.audio = x.stream;
    session.streams = [x.stream];
    session.transportStreams.set(x.stream, 'audio');
    x.send();
    x.stream.counters.duplicates = 3;
    session.resetTransportStatistics();
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    assert.equal(session.transportSnapshot().audio.outstandingBytes, 56);
    x.submitted[0].done();
    assert.equal(session.transportSnapshot().audio.sendCompleted, 0);
    assert.equal(session.transportSnapshot().audio.outstandingBytes, 0);
    x.stream.counters.duplicates = 5;
    let finishClose;
    x.stream.socket.close = (done) => { finishClose = done; };
    const disposing = session.dispose();
    assert.equal(session.transportSnapshot().audio.duplicates, 5);
    session.resetTransportStatistics();
    for (const item of x.submitted) item.done(new Error('late pre-reset completion'));
    finishClose();
    await disposing;
    await session.dispose();
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    assert.equal(session.transportSnapshot().audio.sendErrors, 0);
    assert.equal(session.transportSnapshot().audio.sendCompleted, 0);
    assert.equal(session.transportSnapshot().audio.outstandingSends, 0);
});

test('sustained unusable upstream audio progress renews the association without moving its watermark', async () => {
    const x = memoryStream({ recoverPayloadStall: true });
    let failures = 0;
    const delivered = [];
    x.stream.on('failure', () => failures++);
    x.stream.on('payload', (packet) => delivered.push(packet.readUInt16LE(6)));
    x.receive(1);
    for (let i = 0; i <= 210; i++) {
        x.at(400000 + i * 10); x.heartbeat(); x.receive(40000 + i); x.stream.tick();
    }
    assert.equal(failures, 1);
    assert.equal(x.stream.counters.payloadStalls, 1);
    assert.equal(x.stream.lastDelivered, 1);
    assert.deepEqual(delivered, [1]);
    await x.stream.close();
});

test('ordinary wrap, duplicate replay, silence, control, and downstream audio do not request recovery', async () => {
    for (const options of [{ recoverPayloadStall: true }, { recoverPayloadStall: false }, { role: 'control', recoverPayloadStall: true }]) {
        const x = memoryStream(options);
        let failures = 0;
        x.stream.on('failure', () => failures++);
        const delivered = [];
        x.stream.on('payload', (packet) => delivered.push(packet.readUInt16LE(6)));
        for (const seq of [65534, 0, 65535, 1]) x.receive(seq);
        if (options.role !== 'control') assert.deepEqual(delivered, [65534, 65535, 0, 1]);
        for (let i = 0; i < 40; i++) {
            x.at(i * 500); x.heartbeat(); x.receive(1); x.stream.tick();
        }
        for (let i = 40; i < 80; i++) { x.at(i * 500); x.heartbeat(); x.stream.tick(); }
        assert.equal(failures, 0, 'genuine silence and repeated duplicate sequence are harmless');
        if (!options.recoverPayloadStall || options.role === 'control') {
            for (let i = 0; i < 40; i++) { x.at(40000 + i * 100); x.heartbeat(); x.receive(40000 + i); }
            assert.equal(failures, 0, 'recovery must be restricted to opted-in upstream audio');
        }
        await x.stream.close();
    }
});

test('a brief rejected window is retired by resumed audio and malformed payloads cannot trigger recovery', async () => {
    const x = memoryStream({ recoverPayloadStall: true });
    let failures = 0;
    x.stream.on('failure', () => failures++);
    x.receive(1);
    for (let i = 0; i < 100; i++) { x.at(i * 10); x.heartbeat(); x.receive(40000 + i); }
    x.receive(2);
    for (let i = 0; i < 100; i++) { x.at(1000 + i * 10); x.heartbeat(); x.receive(41000 + i); }
    for (let i = 0; i < 40; i++) {
        x.at(3000 + i * 100); x.heartbeat(); x.stream.receive(P.packet(26, P.TYPE.IDLE, 2, 1, 42000 + i));
    }
    assert.equal(failures, 0);
    assert.equal(x.stream.lastDelivered, 2);
    await x.stream.close();
});

test('a rejected burst followed by idle time cannot turn one later stale packet into a sustained stall', async () => {
    const x = memoryStream({ recoverPayloadStall: true });
    let failures = 0;
    x.stream.on('failure', () => failures++);
    x.receive(1);
    for (let i = 0; i < 100; i++) { x.at(i * 10); x.heartbeat(); x.receive(40000 + i); }
    for (let i = 2; i < 40; i++) { x.at(i * 500); x.heartbeat(); x.stream.tick(); }
    x.at(20000); x.heartbeat(); x.receive(40100);
    assert.equal(failures, 0);
    assert.equal(x.stream.lastDelivered, 1);
    await x.stream.close();
});

test('real UDP reconnects preserve retired transport totals and resets cannot double count or resurrect them', async (t) => {
    const radio = await new IcomPeer().start();
    const session = new IcomSession(radio.config({ reconnectAttempts: 5, reconnectMs: 10 }));
    t.after(async () => { await session.close(); await radio.close(); });
    const received = [];
    session.on('rx-audio', (pcm) => received.push(Buffer.from(pcm)));
    await session.open();
    for (let round = 1; round <= 2; round++) {
        const packet = radio.rxAudio(Buffer.alloc(16, round));
        await until(() => received.length === round, 'PCM before recovery');
        radio.sendRaw('audio', packet);
        radio.sendRaw('audio', Buffer.alloc(4));
        await until(() => session.transportSnapshot().audio.duplicates === round && session.transportSnapshot().audio.malformed === round,
            'transport counters before recovery');
        const generation = session.generation;
        radio.release();
        await until(() => session.connected && session.generation > generation, 'automatic recovery');
        assert.equal(session.transportSnapshot().audio.duplicates, round);
        assert.equal(session.transportSnapshot().audio.malformed, round);
    }
    const oldStream = session.audio;
    const generation = session.generation;
    radio.release();
    await until(() => session.generation > generation, 'recovery boundary');
    session.resetTransportStatistics();
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    await until(() => session.connected && session.audio !== oldStream, 'recovery after reset');
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    assert.equal(session.transportSnapshot().audio.malformed, 0);
    const packet = radio.rxAudio(Buffer.alloc(16, 3));
    await until(() => received.length === 3, 'PCM after reset');
    radio.sendRaw('audio', packet);
    await until(() => session.transportSnapshot().audio.duplicates === 1, 'new statistics window');
    session.resetTransportStatistics();
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    await session.close(); await session.dispose();
    assert.equal(session.transportSnapshot().audio.duplicates, 0);
    assert.equal(session.transportSnapshot().audio.outstandingBytes, 0);
});

test('real UDP audio half-space recovery establishes fresh IDs and rejects the old association', async (t) => {
    const radio = await new IcomPeer().start();
    const session = new IcomSession(radio.config({ reconnectAttempts: 5, reconnectMs: 10, payloadStallMs: 50, payloadStallPackets: 4 }));
    t.after(async () => { await session.close(); await radio.close(); });
    const received = [];
    session.on('rx-audio', (pcm) => received.push(Buffer.from(pcm)));
    await session.open();
    radio.rxAudio(Buffer.alloc(16, 1));
    await until(() => received.length === 1, 'initial audio');
    const previous = session.audio;
    const oldPacket = P.audio(previous.remoteId, previous.localId, 2, Buffer.alloc(16, 0x7f));
    radio.associations.audio.seq = 40000;
    for (let i = 0; i < 12 && session.audio === previous && !previous.failed; i++) {
        radio.sendRaw('audio', envelope(21, P.TYPE.PING, previous.remoteId, previous.localId));
        radio.rxAudio(Buffer.alloc(16, 2));
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await until(() => session.connected && session.audio !== previous, 'fresh audio association');
    assert.notEqual(session.audio.localId, previous.localId);
    assert.equal(session.transportSnapshot().audio.payloadStalls, 1);
    radio.sendRaw('audio', oldPacket);
    await until(() => session.transportSnapshot().audio.stale >= 1, 'old audio association rejection');
    radio.rxAudio(Buffer.alloc(16, 3));
    await until(() => received.length === 2, 'audio after half-space recovery');
    assert.equal(received.at(-1)[0], 3);
    assert.equal(previous.lastDelivered, 1);
});
