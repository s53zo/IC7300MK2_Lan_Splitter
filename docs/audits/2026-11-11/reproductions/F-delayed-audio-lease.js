'use strict';

// Loopback UDP fault injection: delay one valid audio datagram across two
// leases on the same native client association. No radio or RF is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until, frame } = require('../../../../tests/fixtures/harness');

test('an unseen audio datagram from an ended lease cannot reach a later lease', async (t) => {
    const { radio, service, connect } = await setup(t);
    const owner = await connect();
    owner.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt && owner.receivedCiv.some((f) => f[4] === 0xfb), 'first TX');
    owner.playback.setKeyed(true);
    const oldPcm = Buffer.alloc(16, 0x61);
    const originalRaw = owner.audio.raw.bind(owner.audio);
    let delayed;
    owner.audio.raw = (packet) => {
        if (packet.length === 24 + oldPcm.length && packet.subarray(24).equals(oldPcm)) delayed = Buffer.from(packet);
        else originalRaw(packet);
    };
    owner.sendAudio(oldPcm);
    owner.audio.raw = originalRaw;
    assert.ok(delayed);
    owner.sendCiv(frame(0x1c, [0, 0]));
    await until(() => !radio.ptt && !service.broker.owner && !service.broker.releasing, 'first lease cleanup');
    owner.playback.setKeyed(false); // Even invalidating the sender replay history cannot recall the datagram.
    owner.receivedCiv.length = 0;
    owner.sendCiv(frame(0x1c, [0, 1]));
    await until(() => radio.ptt && owner.receivedCiv.some((f) => f[4] === 0xfb), 'second TX');
    const count = radio.txAudio.length;
    originalRaw(delayed);
    await until(() => radio.txAudio.length > count, 'delayed PCM delivery in current code');
    console.log(JSON.stringify({ completedLeasesBeforeReplay: 1, oldPcmDeliveredInNewLease: radio.txAudio.at(-1).bytes.equals(oldPcm),
        activeOwnerIsSameAssociation: service.broker.owner?.id === [...service.server.clients.values()][0]?.id }));
    assert.equal(radio.txAudio.slice(count).some((p) => p.bytes.equals(oldPcm)), false,
        'PCM from the previous lease must not be transmitted by a new lease');
});
