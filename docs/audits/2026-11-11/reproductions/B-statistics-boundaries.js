'use strict';

// Audit-only probes. They bind loopback sockets against the repository's
// synthetic radio, never connect to a physical radio, and do not alter source.
// Run: node --test docs/audits/2026-11-11/reproductions/B-statistics-boundaries.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../../..');
const { setup, until } = require(path.join(root, 'tests/fixtures/harness'));
const { IcomPeer } = require(path.join(root, 'tests/fixtures/icom-radio'));
const { Splitter } = require(path.join(root, 'src/splitter'));
const { AppController } = require(path.join(root, 'src/app/controller'));
const { Broker } = require(path.join(root, 'src/broker'));
const P = require(path.join(root, 'src/icom-lan/protocol'));

test('B-01: automatic reconnect discards prior upstream transport history', async (t) => {
  const { service } = await setup(t, { radio: { reconnectAttempts: 3, reconnectMs: 10 } });
  const originalAudio = service.session.audio;
  originalAudio.receive(Buffer.alloc(1)); // Real malformed-packet counter path.
  const before = service.broker.metricsSnapshot();
  assert.equal(before.transport.audio.malformed, 1);
  await service.session.fail(new Error('Isolated audit reconnection probe'));
  await until(() => service.broker.ready && service.session.audio !== originalAudio, 'isolated automatic reconnect');
  const after = service.broker.metricsSnapshot();
  assert.equal(after.transport.audio.malformed, 0, 'reproduces lost historical transport count');
  assert.ok(after.physicalTotal >= before.physicalTotal, 'physical totals retain the earlier statistics window');
  console.log(JSON.stringify({ probe: 'B-01', transportMalformedBefore: before.transport.audio.malformed,
    transportMalformedAfter: after.transport.audio.malformed, physicalTotalsPreserved: after.physicalTotal >= before.physicalTotal }));
});

test('B-01 sibling: explicit app reconnect discards admission-event history', async (t) => {
  let now = 0;
  const radio = await new IcomPeer().start();
  const controller = new AppController({ directory: path.join(require('node:os').tmpdir(), `icom-audit-B-${process.pid}`),
    lock: async () => async () => {}, now: () => now,
    createSplitter: () => new Splitter({ radio: radio.config(),
      server: { bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0,
        now: () => now, preAuthTimeoutMs: 100 }, broker: { pollMs: 100000 } }) });
  t.after(async () => { await controller.close({ confirmedTx: true }); await radio.close(); });
  // In-memory test configuration only; factory above always uses loopback.
  controller.values.ICOM_RADIO_HOST = '127.0.0.1';
  controller.values.ICOM_USERNAME = 'fixture';
  controller.values.ICOM_RADIO_CONTROL_PORT = '40001';
  controller.values.ICOM_RADIO_CIV_PORT = '40002';
  controller.values.ICOM_RADIO_AUDIO_PORT = '40003';
  controller.password = 'fixture-password';
  await controller.start();
  assert.ok(controller.service?.broker.ready);
  controller.service.server.receive('control', P.packet(16, P.TYPE.THERE, 0x11223344), { address: '127.0.0.1', port: 49123 });
  now = 100;
  controller.service.server.tick();
  const before = controller.getState();
  assert.equal(before.status.admission.preAuthExpired, 1);
  await controller.reconnect();
  const after = controller.getState();
  assert.equal(after.status.admission.preAuthExpired, 0, 'reproduces lost historical admission count');
  assert.equal(after.statisticsStartedAt, before.statisticsStartedAt, 'statistics window did not reset');
  console.log(JSON.stringify({ probe: 'B-01-admission', expiredBefore: before.status.admission.preAuthExpired,
    expiredAfter: after.status.admission.preAuthExpired, statisticsWindowUnchanged: after.statisticsStartedAt === before.statisticsStartedAt }));
});

test('B-02: telemetry cold fallback increments misses without a miss reason', async (t) => {
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false;
  radio.serial = radio.audio = { invalidate() {} };
  radio.playback = { setKeyed() {} };
  radio.sendCiv = () => {};
  server.sendCiv = server.broadcastCiv = server.broadcastAudio = () => {};
  const broker = new Broker(radio, server, { telemetryEnabled: true, now: () => 0, requestTimeoutMs: 10000 });
  clearInterval(broker.timer);
  radio.connected = true;
  broker.ready = true;
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); });
  const client = { id: 'fixture', active: true, mediaGeneration: 1 };
  server.emit('command', client, Buffer.from('fefeb6e01502fd', 'hex'));
  const cache = broker.cacheSnapshot(), metrics = broker.metricsSnapshot();
  assert.equal(cache.misses, 1);
  assert.equal(broker.telemetrySnapshot().querySettings.find((row) => row.key === '1502').fallbacks, 1);
  assert.equal(Object.values(metrics.reasons.misses).reduce((sum, n) => sum + n, 0), 0);
  console.log(JSON.stringify({ probe: 'B-02', cacheMisses: cache.misses, missReasons: metrics.reasons.misses }));
});
