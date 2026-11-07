'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until, sleep, frame } = require('./fixtures/harness');

// These are real UDP sockets and unmodified PiRO IcomSession clients talking
// to an independently encoded synthetic radio. No physical RF is involved.
test('two unchanged native clients on one IP share one radio session; replies remain private', async (t) => {
    const { radio, service, connect } = await setup(t);
    const first = await connect();
    const second = await connect();
    assert.equal(service.server.clients.size, 2);
    assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
    assert.notEqual(first.control.localPort, second.control.localPort);
    assert.notEqual(first.serial.remoteId, second.serial.remoteId);
    const before = radio.commands.length;
    first.sendCiv(frame(5, [0, 0, 0x10, 0x14, 0]));
    second.sendCiv(frame(5, [0, 0, 0x20, 0x14, 0]));
    await until(() => first.receivedCiv.some((f) => f[4] === 0xfb)
        && second.receivedCiv.some((f) => f[4] === 0xfb), 'separate ACKs');
    assert.equal(first.receivedCiv.filter((f) => f[4] === 0xfb).length, 1);
    assert.equal(second.receivedCiv.filter((f) => f[4] === 0xfb).length, 1);
    const writes = radio.commands.slice(before).filter((f) => f[4] === 5);
    assert.deepEqual(writes.map((f) => f.subarray(5, -1)), [
        Buffer.from([0, 0, 0x10, 0x14, 0]), Buffer.from([0, 0, 0x20, 0x14, 0]),
    ]);
    first.sendCiv(frame(3));
    second.sendCiv(frame(4));
    await until(() => first.receivedCiv.some((f) => f[4] === 3)
        && second.receivedCiv.some((f) => f[4] === 4), 'query replies');
    assert.equal(first.receivedCiv.some((f) => f[4] === 4), false);
    assert.equal(second.receivedCiv.some((f) => f[4] === 3), false);
});

test('all clients receive identical PCM and complete 475-point scope; one disconnect leaves others alive', async (t) => {
    const { radio, connect } = await setup(t);
    const peers = await Promise.all([connect(), connect(), connect()]);
    const pcm = Buffer.alloc(1364);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 255;
    radio.rxAudio(pcm);
    radio.scope(Buffer.alloc(475, 123));
    await until(() => peers.every((p) => p.receivedAudio.length && p.receivedCiv.some((f) => f[4] === 0x27)), 'audio and scope fanout');
    for (const peer of peers) {
        assert.deepEqual(peer.receivedAudio[0], pcm);
        const scope = peer.receivedCiv.find((f) => f[4] === 0x27);
        assert.equal(scope.length, 497);
        assert.deepEqual(scope.subarray(21, -1), Buffer.alloc(475, 123));
    }
    await peers[0].close();
    peers[1].sendCiv(frame(3));
    await until(() => peers[1].receivedCiv.some((f) => f[4] === 3), 'surviving client query');
    assert.equal(radio.connections.control, 1);
});

test('TX lease rejects competing keying, writes and audio; owner disconnect confirms RX before handover', async (t) => {
    const { radio, connect } = await setup(t);
    const owner = await connect();
    const other = await connect();
    owner.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt && owner.receivedCiv.some((f) => f[4] === 0xfb), 'owner TX');
    const before = radio.commands.length;
    const ownerAudio = Buffer.alloc(1364, 0x11);
    const otherAudio = Buffer.alloc(1364, 0x22);
    owner.playback.setKeyed(true);
    other.playback.setKeyed(true);
    owner.sendAudio(ownerAudio);
    other.sendAudio(otherAudio);
    other.sendCiv(frame(0x1c, [0, 1]));
    other.sendCiv(frame(5, [0, 0, 0x30, 0x14, 0]));
    await until(() => other.receivedCiv.filter((f) => f[4] === 0xfa).length >= 2, 'competing changes rejected');
    await until(() => radio.txAudio.length > 0, 'owner PCM reaches radio');
    assert.equal(radio.txAudio.some((p) => p.bytes.equals(otherAudio)), false);
    assert.equal(radio.commands.slice(before).some((f) => f[4] === 5), false);
    await owner.close();
    await until(() => !radio.ptt, 'PTT release after disconnect');
    other.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt, 'next owner TX');
    assert.equal(radio.commands.slice(before).some((f) => f[4] === 5), false, 'discarded change is never replayed');
    other.sendCiv(frame(0x1c, [0, 0]));
    await until(() => !radio.ptt, 'explicit release');
});

test('upstream audio retransmit recovers loss and suppresses duplicate packets', async (t) => {
    const { radio, connect } = await setup(t, { radio: { reorderMs: 150 } });
    const peer = await connect();
    const packets = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
    radio.rxAudio(packets[0]);
    await until(() => peer.receivedAudio.length === 1, 'first PCM');
    const dropped = radio.rxAudio(packets[1], { drop: true });
    radio.rxAudio(packets[2]);
    await until(() => peer.receivedAudio.length === 3, 'missing PCM retransmission');
    radio.sendRaw('audio', dropped);
    await sleep(50);
    assert.deepEqual(peer.receivedAudio, packets);
});

test('sequence wrap preserves PCM order across the upstream and downstream associations', async (t) => {
    const { radio, connect } = await setup(t);
    const peer = await connect();
    radio.associations.audio.seq = 65534;
    const packets = [Buffer.alloc(16, 4), Buffer.alloc(16, 5), Buffer.alloc(16, 6)];
    for (const packet of packets) radio.rxAudio(packet);
    await until(() => peer.receivedAudio.length === 3, 'PCM across wrap');
    assert.deepEqual(peer.receivedAudio, packets);
});

test('late command reply resets the upstream session and does not confirm the next client write', async (t) => {
    const { radio, service, connect } = await setup(t, { broker: { requestTimeoutMs: 100 } });
    const first = await connect();
    const second = await connect();
    radio.options.delayNextReply = 400;
    first.sendCiv(frame(5, [0, 0, 0x10, 0x14, 0]));
    second.sendCiv(frame(5, [0, 0, 0x20, 0x14, 0]));
    await until(() => radio.connections.control >= 2, 'fresh upstream after timeout');
    await until(() => service.broker.ready, 'reconnected broker');
    await sleep(450);
    assert.equal(second.receivedCiv.some((f) => f[4] === 0xfb), false, 'late ACK never confirms queued write');
    assert.equal(radio.commands.filter((f) => f[4] === 5 && f[7] === 0x20).length, 0, 'queued write not replayed');
});

test('invalid credentials never establish media and do not disturb an authenticated client', async (t) => {
    const { radio, service, connect } = await setup(t);
    const peer = await connect();
    const { client } = require('./fixtures/harness');
    await assert.rejects(client(service.address(), { password: 'wrong-password' }), /credential|reject|auth|timed out/i);
    peer.sendCiv(frame(3));
    await until(() => peer.receivedCiv.some((f) => f[4] === 3), 'valid client after rejected login');
    assert.equal(radio.connections.control, 1);
});

test('silent TX-owner process loss expires its heartbeat and releases PTT', async (t) => {
    const { radio, connect } = await setup(t, { server: { timeoutMs: 350 } });
    const owner = await connect();
    owner.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt, 'owner TX before process loss');
    // Simulate a killed process: close sockets without sending disconnect.
    owner.stopped = true;
    clearInterval(owner.timer);
    owner.capture.stop();
    owner.playback.stop();
    for (const stream of owner.streams) {
        clearInterval(stream.timer);
        const socket = stream.socket;
        stream.socket = null;
        if (socket) await new Promise((resolve) => socket.close(resolve));
    }
    await until(() => !radio.ptt, 'heartbeat loss PTT release', 2000);
});

test('upstream media release clears ownership and pending TX; a fresh session starts in RX', async (t) => {
    const { radio, service, connect } = await setup(t);
    const owner = await connect();
    owner.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt, 'TX before upstream release');
    owner.playback.setKeyed(true);
    const pcm = Buffer.alloc(1364, 0x33);
    owner.sendAudio(pcm);
    await until(() => radio.txAudio.length > 0, 'TX PCM before release');
    const previousConnections = radio.connections.control;
    radio.release();
    await until(() => radio.connections.control > previousConnections, 'upstream reconnect');
    await until(() => service.broker.ready && !radio.ptt, 'fresh receive state');
    const before = radio.txAudio.length;
    // The old downstream sender still has keyed=true locally; its media must
    // not acquire ownership implicitly in the new upstream generation.
    owner.sendAudio(pcm);
    await sleep(50);
    assert.equal(radio.txAudio.length, before);
});

test('selected and unselected VFO frequency/mode queries relay native wfweb-style commands', async (t) => {
    const { radio, connect } = await setup(t);
    const peer = await connect();
    peer.sendCiv(frame(0x25, [0, 0, 0, 0x10, 0x14, 0]));
    peer.sendCiv(frame(0x25, [1, 0, 0, 0, 0x07, 0]));
    peer.sendCiv(frame(0x26, [0, 1, 1, 2]));
    peer.sendCiv(frame(0x26, [1, 3, 0, 1]));
    await until(() => peer.receivedCiv.filter((f) => f[4] === 0xfb).length === 4, 'VFO writes');
    for (const command of [0x25, 0x26]) {
        for (const vfo of [0, 1]) peer.sendCiv(frame(command, [vfo]));
    }
    await until(() => peer.receivedCiv.filter((f) => f[2] === 0xe0 && [0x25, 0x26].includes(f[4])).length === 4, 'VFO reads');
    const payloads = peer.receivedCiv.filter((f) => f[2] === 0xe0 && [0x25, 0x26].includes(f[4])).map((f) => [...f.subarray(4, -1)]);
    assert.deepEqual(payloads, [
        [0x25, 0, 0, 0, 0x10, 0x14, 0], [0x25, 1, 0, 0, 0, 0x07, 0],
        [0x26, 0, 1, 1, 2], [0x26, 1, 3, 0, 1],
    ]);
    assert.equal(radio.connections.control, 1);
});
