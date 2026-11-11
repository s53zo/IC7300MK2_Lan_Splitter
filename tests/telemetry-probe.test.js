'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GapTracker, numericMetadata, managementSummary, difference, parseOptions, runProbe } = require('../scripts/telemetry-probe');

test('packet gap metadata counts interarrivals and also detects a terminal outage', () => {
    const audio = new GapTracker([40, 100, 500], 0);
    audio.observe(10, 960); audio.observe(20, 960); audio.observe(120, 960); audio.observe(720, 960);
    const first = audio.takeBin(800);
    assert.deepEqual(first, { packets: 4, bytes: 3840, maxInterarrivalMs: 600, silenceAtEndMs: 80 });
    assert.equal(audio.takeBin(1000).packets, 0);
    const summary = audio.summary(2000);
    assert.equal(summary.maxInterarrivalMs, 600); assert.equal(summary.tailSilenceMs, 1280);
    assert.equal(summary.longestObservedGapMs, 1280); assert.equal(summary.firstPacketDelayMs, 10);
    assert.deepEqual(summary.gapsAtLeastMs, { 40: 2, 100: 2, 500: 1 });
    const missing = new GapTracker([1000], 500);
    assert.equal(missing.summary(2500).longestObservedGapMs, 2000);
});

test('management reports retain counters and ages, never secrets, readings or packet buffers', () => {
    const value = numericMetadata({ count: 2, password: 'private', reply: Buffer.from('secret'), reading: 44,
        values: [1, 2], arrays: [0xfe, 0xfe], nested: { sampleAgeMs: 25, polls: 8 },
        samples: [{ key: '1502', value: 42, ageMs: 12, valid: true }] });
    assert.deepEqual(value, { count: 2, nested: { sampleAgeMs: 25, polls: 8 }, samples: { 1502: { ageMs: 12, valid: true } } });
    const summary = managementSummary({ settings: { values: { ICOM_PASSWORD: 'private' } }, password: 'private', status: {
        radio: { state: 'connected', connected: true }, broker: { ready: true, clientId: 'private' },
        metrics: { physical: { periodicPoll: 4 }, transport: { audio: { lost: 2 } } },
        cache: { requests: 5, hits: 2, byQuery: { 1502: { requests: 5 } }, reply: Buffer.from('secret') },
    } });
    assert.equal(JSON.stringify(summary).includes('private'), false);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
    assert.equal(summary.metrics.physical.periodicPoll, 4);
    assert.deepEqual(difference({ physical: { periodicPoll: 9 } }, { physical: { periodicPoll: 4 } }), { physical: { periodicPoll: 5 } });
});

test('probe argument limits keep sample metadata bounded and use only an IPv4 splitter host', () => {
    const options = parseOptions(['--host', '10.0.1.82', '--seconds', '60', '--label', 'rx-after', '--settle-seconds', '0']);
    assert.equal(options.seconds, 60); assert.equal(options.webPort, 50004);
    for (const args of [['--seconds', '0'], ['--seconds', '3601'], ['--seconds', '1.5'], ['--host', 'https://bad'],
        ['--settle-seconds', '31'], ['--label', 'bad\nlabel'], ['--web-port', '65536'], ['--unknown', 'x'], ['--seconds']]) assert.throws(() => parseOptions(args));
});

test('receive-only observer records synthetic media without issuing any client radio commands', { skip: process.platform === 'win32' }, async (t) => {
    const { IcomPeer } = require('./fixtures/icom-radio');
    const { Splitter } = require('../src/splitter');
    const { statusSnapshot } = require('../src/cli');
    const { SettingsStore } = require('../src/app/store');
    const { defaults } = require('../src/app/settings');
    const { ensureTls } = require('../src/web/tls');
    const { createWebServer } = require('../src/web/server');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-probe-test-')), directory = path.join(root, 'profile');
    let radio, service, web, timer;
    t.after(async () => { clearInterval(timer); await web?.close(); await service?.close(); await radio?.close(); await fs.rm(root, { recursive: true, force: true }); });
    radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    service = new Splitter({ radio: radio.config({ username: 'beer', password: 'testpass' }),
        server: { bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0 } });
    await service.start();
    const native = service.address(), upstream = radio.config();
    const values = { ...defaults(), ICOM_RADIO_HOST: '127.0.0.1', ICOM_BIND_ADDRESS: '127.0.0.1', ICOM_USERNAME: 'beer',
        ICOM_LISTEN_CONTROL_PORT: String(native.controlPort), ICOM_LISTEN_CIV_PORT: String(native.civPort), ICOM_LISTEN_AUDIO_PORT: String(native.audioPort),
        ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort), ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort) };
    await new SettingsStore(directory).save(values, 'testpass');
    const tls = await ensureTls({ directory, host: '127.0.0.1', env: {} });
    const controller = { directory, values, password: 'testpass', redact: (x) => x,
        getState: () => ({ running: true, pendingChanges: false, settings: { values }, activeSettings: { values }, status: statusSnapshot(service) }) };
    web = createWebServer({ controller, host: '127.0.0.1', port: 0, tls }); await web.start();
    timer = setInterval(() => { radio.rxAudio(Buffer.alloc(960)); radio.scope(); }, 20);
    const output = path.join(root, 'report.json');
    const report = await runProbe(parseOptions(['--host', '127.0.0.1', '--web-port', String(web.address().port),
        '--state-dir', directory, '--seconds', '1', '--settle-seconds', '0', '--label', 'fixture', '--output', output]));
    assert.ok(report.audio.packets > 5); assert.ok(report.scope.packets > 5);
    assert.equal(report.disconnects, 0); assert.equal(report.txRequested, false); assert.equal(report.mediaRecorded, false);
    assert.equal(report.serviceAfter.metrics.physical.clientRead, 0);
    assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
    const text = await fs.readFile(output, 'utf8'); assert.equal(text.includes('testpass'), false); assert.equal(text.includes('fefeb6'), false);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});
