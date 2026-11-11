'use strict';

// Isolated loopback-only regression probe. No production hosts or credentials.
// Run: node --test docs/audits/2026-11-11/reproductions/F-transport-reconnect.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until } = require('../../../../tests/fixtures/harness');

test('transport history survives automatic upstream recovery until explicit statistics reset', async (t) => {
    const { radio, service, connect } = await setup(t);
    const peer = await connect();
    const packet = radio.rxAudio(Buffer.alloc(16, 0x31));
    await until(() => peer.receivedAudio.length === 1, 'initial PCM');
    radio.sendRaw('audio', packet);
    await until(() => service.broker.metricsSnapshot().transport.audio.duplicates > 0, 'duplicate accounting');
    const before = service.broker.metricsSnapshot();
    const generation = service.session.generation;
    radio.release();
    await until(() => service.session.generation > generation && service.broker.ready, 'automatic recovery');
    radio.rxAudio(Buffer.alloc(16, 0x32));
    await until(() => peer.receivedAudio.length === 2, 'PCM after recovery');
    const after = service.broker.metricsSnapshot();
    console.log(JSON.stringify({ beforeDuplicates: before.transport.audio.duplicates,
        afterDuplicates: after.transport.audio.duplicates, beforePhysical: before.physicalTotal,
        afterPhysical: after.physicalTotal, recoveredAudioPackets: peer.receivedAudio.length }));
    assert.equal(after.transport.audio.duplicates, before.transport.audio.duplicates,
        'historical transport counters must not reset when fresh stream objects replace the association');
});
