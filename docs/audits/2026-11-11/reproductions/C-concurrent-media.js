'use strict';

// Bounded synthetic loopback only: concurrent uncached client reads, background
// telemetry, PCM and scope. This does not measure audible playback or RF.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const { IcomPeer } = require(path.join(root, 'tests/fixtures/icom-radio'));
const { client, until, sleep, frame } = require(path.join(root, 'tests/fixtures/harness'));
const { Splitter } = require(path.join(root, 'src/splitter'));

async function main() {
  const radio = await new IcomPeer().start();
  const service = new Splitter({ radio: radio.config(),
    server: { bindAddress: '127.0.0.1', controlPort: 0, civPort: 0, audioPort: 0 },
    broker: { telemetryEnabled: true, cacheEnabled: true, cacheQueryTtls: { '03': 0 }, requestTimeoutMs: 500 } });
  const peers = [], rows = [];
  let mediaTimer, queryTimer;
  let sentAudio = 0, sentScope = 0, queries = 0;
  const pcmA = Buffer.alloc(1364, 1), pcmB = Buffer.alloc(556, 2);
  try {
    await service.start();
    await until(() => service.broker.ready);
    assert.equal(service.broker.telemetry.active, true, 'background telemetry must be active');
    for (let n = 0; n < 8; n++) peers.push(await client(service.address()));
    for (const peer of peers) {
      const row = { audio: 0, scope: 0, replies: 0, maxAudioGapMs: 0, lastAudioAt: null };
      rows.push(row);
      peer.on('rx-audio', () => {
        const now = performance.now();
        if (row.lastAudioAt !== null) row.maxAudioGapMs = Math.max(row.maxAudioGapMs, now - row.lastAudioAt);
        row.lastAudioAt = now; row.audio++;
      });
      peer.on('civ', (bytes) => {
        if (bytes[4] === 0x27 && bytes[5] === 0) row.scope++;
        if (bytes[4] === 3 && bytes[2] === 0xe0) row.replies++;
      });
    }
    const start = performance.now();
    mediaTimer = setInterval(() => {
      radio.rxAudio(pcmA); radio.rxAudio(pcmB); sentAudio += 2;
      if (sentAudio % 10 === 0) { radio.scope(); sentScope++; }
      // Retain counters, not an accumulating payload/log history.
      radio.received.length = 0; radio.commands.length = 0;
      for (const peer of peers) { peer.receivedAudio.length = 0; peer.receivedCiv.length = 0; }
    }, 20);
    queryTimer = setInterval(() => {
      for (const peer of peers) { peer.sendCiv(frame(3)); queries++; }
    }, 25);
    await sleep(3000);
    clearInterval(mediaTimer); clearInterval(queryTimer);
    await until(() => rows.reduce((sum, row) => sum + row.replies, 0) === queries, 'all control replies', 2000);
    await sleep(200);
    for (const row of rows) {
      assert.equal(row.audio, sentAudio);
      assert.equal(row.scope, sentScope);
    }
    assert.equal(radio.connections.control, 1);
    assert.equal(service.broker.stats.timeouts, 0);
    const telemetryPhysicalPolls = service.broker.metricsSnapshot().physical.telemetryPoll;
    assert.ok(telemetryPhysicalPolls > 0, 'background telemetry must perform physical polls');
    console.log(JSON.stringify({ kind: 'synthetic-loopback-concurrent-media', node: process.version,
      platform: `${process.platform}/${process.arch}`, clients: peers.length,
      elapsedMs: Math.round(performance.now() - start), queries,
      replies: rows.reduce((sum, row) => sum + row.replies, 0),
      sentAudio, receivedAudio: rows.map((row) => row.audio),
      sentScope, receivedScope: rows.map((row) => row.scope),
      maxClientAudioArrivalGapMs: +Math.max(...rows.map((row) => row.maxAudioGapMs)).toFixed(2),
      brokerTimeouts: service.broker.stats.timeouts,
      telemetryActive: service.broker.telemetry.active, telemetryPhysicalPolls,
      upstreamAssociations: radio.connections.control,
      transport: service.broker.metricsSnapshot().transport }, null, 2));
  } finally {
    clearInterval(mediaTimer); clearInterval(queryTimer);
    await Promise.allSettled(peers.map((peer) => peer.close()));
    await service.close(); await radio.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
