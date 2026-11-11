'use strict';

// Offline audit probes only. No sockets, credentials or radio operations.
// Run from any directory: node docs/audits/2026-11-11/reproductions/C-transport-probes.js
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const { IcomStream } = require(path.join(root, 'src/icom-lan/stream'));
const { IcomSession } = require(path.join(root, 'src/icom-lan/session'));
const { NativeServer } = require(path.join(root, 'src/server'));
const P = require(path.join(root, 'src/icom-lan/protocol'));

function memoryStream() {
  let time = 0;
  const stream = new IcomStream({ role: 'audio', now: () => time });
  stream.localId = 1; stream.remoteId = 2; stream.ready = true;
  stream.lastRx = stream.lastIdle = stream.lastPing = 0;
  stream.raw = () => {};
  return { stream, time: (value) => { time = value; } };
}

// A lost half-sequence space is treated as duplicates, even when valid pings
// have kept the association alive. Recovery of the network is not recovery of
// media until the sequence wraps far enough, or another component reconnects.
{
  const { stream, time } = memoryStream();
  let delivered = 0, failures = 0;
  stream.on('payload', () => { delivered++; });
  stream.on('failure', () => { failures++; });
  const data = (seq) => stream.receive(P.packet(26, P.TYPE.IDLE, 2, 1, seq));
  data(1);
  for (let seq = 40000; seq < 41000; seq++) {
    time(seq * 10);
    const ping = P.packet(21, P.TYPE.PING, 2, 1, seq);
    stream.receive(ping);
    data(seq);
    stream.tick();
  }
  assert.equal(delivered, 1);
  assert.equal(failures, 0);
  assert.equal(stream.reorder.size, 0);
  assert.equal(stream.counters.duplicates, 1000);
  console.log(JSON.stringify({ probe: 'long-media-blackhole', deliveredAfterRecovery: delivered - 1,
    futurePacketsRejected: stream.counters.duplicates, reconnectsRequested: failures }));
}

// Upstream raw TX audio has no cap on outstanding UDP sends. Model a socket
// that accepts sends but delays completion; retain only lengths in this probe.
// This establishes the missing application bound, not real OS backlog size.
{
  const session = new IcomSession({ host: '127.0.0.1', username: 'fixture', password: 'fixture' });
  const { stream } = memoryStream();
  let pendingBytes = 0, accepted = 0;
  stream.socket = { send(packet, _done) { pendingBytes += packet.length; accepted++; } };
  delete stream.raw;
  stream.raw = IcomStream.prototype.raw;
  session.audio = stream; session.connected = true; session.playback.keyed = true;
  const pcm = Buffer.alloc(1364);
  for (let n = 0; n < 10000; n++) session.sendAudio(pcm);
  assert.equal(accepted, 10000);
  assert.equal(stream.replay.size, 256);
  assert.equal(pendingBytes, 13880000);
  console.log(JSON.stringify({ probe: 'held-upstream-send-completions', accepted,
    simulatedOutstandingBytes: pendingBytes, boundedReplayPackets: stream.replay.size }));
}

// The downstream implementation does enforce its per-peer pending-send cap.
// Keep one peer's completions pending while the other completes immediately.
{
  const server = new NativeServer({ username: 'fixture', password: 'fixture', maxPendingBytes: 4096 });
  const healthy = [], held = [];
  server.sockets.audio = { send(packet, port, _host, done) {
    if (port === 10001) held.push({ size: packet.length, done });
    else { healthy.push(packet.length); done?.(); }
  } };
  for (const [index, port] of [10001, 10002].entries()) {
    const client = { id: String(index), active: true, authenticated: true, granted: true,
      address: '127.0.0.1', audioPort: port, rxEnable: true, streams: {}, audioSeq: 0 };
    server.clients.set(client.id, client);
    server.receive('audio', P.packet(16, P.TYPE.THERE, 100 + index), { address: '127.0.0.1', port });
    const peer = client.streams.audio;
    server.receive('audio', P.packet(16, P.TYPE.READY, peer.remoteId, peer.localId), { address: '127.0.0.1', port });
  }
  healthy.length = 0;
  for (let n = 0; n < 1000; n++) server.broadcastAudio(Buffer.alloc(1364));
  const [slow, fast] = [...server.clients.values()].map((client) => client.streams.audio);
  assert.ok(slow.pendingBytes <= 4096);
  assert.ok(slow.dropped > 0);
  assert.equal(fast.pendingBytes, 0);
  assert.equal(healthy.length, 1000);
  console.log(JSON.stringify({ probe: 'downstream-slow-send-isolation', slowPendingBytes: slow.pendingBytes,
    slowDroppedPackets: slow.dropped, healthyDeliveredPackets: healthy.length }));
  for (const item of held) item.done?.();
}

// Ordinary sequence wrap is correct in the ordered transport.
{
  const { stream } = memoryStream();
  const received = [];
  stream.on('payload', (packet) => received.push(packet.readUInt16LE(6)));
  for (const seq of [65534, 0, 65535, 1]) stream.receive(P.packet(26, P.TYPE.IDLE, 2, 1, seq));
  assert.deepEqual(received, [65534, 65535, 0, 1]);
  console.log(JSON.stringify({ probe: 'wrap-and-reorder', received }));
}
