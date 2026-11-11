'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseOptions, bcdValue, modeValue, Commander, executeTest, TEST_MODE, TEST_POWER } = require('../scripts/telemetry-tx-test');
const response = (payload) => Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, ...payload, 0xfd]);
class VirtualClient extends EventEmitter {
    constructor(options = {}) {
        super(); this.options = options; this.connected = true; this.mode = Buffer.from([1, 1, 2]); this.power = Buffer.from([1, 0]);
        this.frequency = Buffer.from([0, 0x40, 7, 0x14, 0]); this.ptt = false; this.writes = 0; this.keyed = 0; this.commands = [];
    }
    sendCiv(frame) {
        const p = frame.subarray(4, -1), cmd = p[0], data = p.subarray(1); this.commands.push(Buffer.from(p)); let out = [0xfb];
        if (cmd === 0x19) out = [cmd, 0, 0xb6];
        else if (cmd === 3) out = [cmd, ...this.frequency];
        else if (cmd === 0x26) {
            if (data.length === 1) out = [cmd, 0, ...this.mode];
            else { this.writes++; this.mode = Buffer.from(data.subarray(1)); }
        } else if (cmd === 0x14) {
            if (data.length === 1) out = [cmd, 0x0a, ...this.power];
            else { this.writes++; if (!this.options.ignorePower) this.power = Buffer.from(data.subarray(1)); }
        } else if (cmd === 0x1c) {
            if (data.length === 1) out = [cmd, 0, this.ptt ? 1 : 0];
            else { this.writes++; if (data[1]) { assert.ok(this.watchdogArmed, 'watchdog armed before keying'); this.keyed++; this.ptt = true; }
                else if (!this.options.ignoreOff) { this.ptt = false; this.released = true; } }
        }
        queueMicrotask(() => this.emit('civ', response(out)));
    }
}
function harness(options) {
    const client = new VirtualClient(options); let time = 0, canceled = false, armed = 0;
    const management = { state: async () => ({ pendingChanges: false, txActive: client.ptt,
        dashboard: { rxTx: client.ptt ? 'TX' : 'RX' }, status: { radio: { connected: true, state: 'connected' }, broker: { ready: true },
            metrics: { physical: { clientWrite: client.writes }, physicalTotal: client.commands.length }, cache: { requests: 0, hits: 0, misses: 0 } } }) };
    return { client, management, now: () => time,
        wait: async (ms) => { time += ms; client.emit('rx-audio', Buffer.alloc(960)); client.emit('civ', response([0x27, 0, ...Buffer.alloc(490)])); },
        arm: async () => { client.watchdogArmed = true; armed++; return { cancel: () => { assert.equal(client.ptt, false); canceled = true; }, fired: () => false }; },
        seconds: 1, armed: () => armed, canceled: () => canceled };
}
test('TX test requires explicit run/dummy flags and bounds duration and nominal power', () => {
    assert.equal(parseOptions([]).run, false);
    assert.throws(() => parseOptions(['--run']), /dummy/);
    assert.throws(() => parseOptions(['--run', '--dummy-load']), /Explicit/);
    assert.equal(parseOptions(['--run', '--dummy-load', '--watts', '10', '--seconds', '20']).seconds, 20);
    for (const args of [['--watts', '11'], ['--seconds', '0'], ['--seconds', '30'], ['--seconds', '1.5'], ['--host', 'example.com']]) assert.throws(() => parseOptions(args));
    assert.throws(() => parseOptions(['--output', '/var/lib/icom-splitter/credentials']), /overwrite/);
});
test('relative power and selected-mode replies validate before use', () => {
    assert.equal(bcdValue(TEST_POWER), 25); assert.equal(bcdValue(Buffer.from([2, 0x55])), 255);
    for (const value of [Buffer.from([0, 0xff]), Buffer.from([3, 0]), Buffer.from([0])]) assert.throws(() => bcdValue(value));
    assert.deepEqual(modeValue(response([0x26, 0, 5, 0, 1])), TEST_MODE);
    assert.throws(() => modeValue(response([0x26, 0, 9, 0, 1])));
    assert.throws(() => modeValue(response([0x26, 0, 5, 2, 1])));
});
test('synthetic TX sequence arms watchdog, verifies low power and restores receive and original values', async () => {
    const h = harness(), mode = Buffer.from(h.client.mode), power = Buffer.from(h.client.power);
    const result = await executeTest(h);
    assert.equal(result.result, 'pass'); assert.equal(h.armed(), 1); assert.equal(h.canceled(), true);
    assert.equal(h.client.keyed, 1); assert.equal(h.client.ptt, false);
    assert.deepEqual(h.client.mode, mode); assert.deepEqual(h.client.power, power);
    assert.deepEqual(result.restoration, { receiveConfirmed: true, mode: 'restored', power: 'restored', frequencyUnchanged: true });
    assert.equal(result.actualWattsExternallyMeasured, false); assert.equal(result.txAudioSent, false); assert.equal(result.mediaRecorded, false);
    assert.equal(result.rxAudioResumed, true); assert.ok(result.observedTxDurationSeconds < 60);
    const encoded = JSON.stringify(result); assert.equal(encoded.includes(h.client.frequency.toString('hex')), false);
});
test('unverified low power never keys or arms the RF watchdog', async () => {
    const h = harness({ ignorePower: true }); const result = await executeTest(h);
    assert.equal(result.result, 'fail'); assert.equal(h.client.keyed, 0); assert.equal(h.armed(), 0);
    assert.equal(h.client.power.toString('hex'), '0100');
});
test('failure to confirm receive leaves watchdog armed and avoids restoration while still keyed', async () => {
    const h = harness({ ignoreOff: true }); const result = await executeTest(h);
    assert.equal(result.result, 'fail'); assert.equal(result.watchdogLeftArmed, true); assert.equal(h.canceled(), false);
    assert.equal(result.restoration.receiveConfirmed, false); assert.equal(result.restoration.mode, 'not restored; receive unconfirmed'); assert.deepEqual(h.client.mode, TEST_MODE); assert.deepEqual(h.client.power, TEST_POWER);
});
test('readonly preflight refuses active or pending transmit ownership', async () => {
    const h = harness(); h.management.state = async () => ({ txActive: true, dashboard: { rxTx: 'RX' }, status: { radio: { connected: true }, broker: { ready: true } } });
    const result = await executeTest(h); assert.equal(result.result, 'fail'); assert.equal(h.client.commands.length, 0); assert.equal(h.armed(), 0);
});
test('command matcher rejects NG and ignores unrelated scope/transceive frames', async () => {
    const c = new EventEmitter(); c.sendCiv = () => {};
    const commander = new Commander(c); const pending = commander.request(0x14, [0x0a]);
    c.emit('civ', Buffer.from([0xfe, 0xfe, 0, 0xb6, 0, 1, 0xfd]));
    c.emit('civ', response([0xfa])); await assert.rejects(pending, /rejected/); commander.close();
});
