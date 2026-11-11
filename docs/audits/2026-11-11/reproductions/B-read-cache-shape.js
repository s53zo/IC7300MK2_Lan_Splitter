'use strict';

// Audit-only, in-process fault injection; no network or hardware operations.
// Icom IC-7300MK2 CI-V reference guide, page 6, defines 16 56 as 00/01.
// Run: node --test docs/audits/2026-11-11/reproductions/B-read-cache-shape.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../../..');
const { Broker } = require(path.join(root, 'src/broker'));
const { validReply } = require(path.join(root, 'src/read-cache'));

test('B-03: unsupported IF-filter-shape value is accepted and shared from cache', async (t) => {
  const radio = new EventEmitter(), server = new EventEmitter();
  radio.connected = false;
  radio.serial = radio.audio = { invalidate() {} };
  radio.playback = { setKeyed() {} };
  const physical = [], delivered = [];
  radio.sendCiv = (bytes) => physical.push(Buffer.from(bytes));
  server.sendCiv = (client, bytes) => delivered.push({ id: client.id, bytes: Buffer.from(bytes) });
  server.broadcastCiv = server.broadcastAudio = () => {};
  const broker = new Broker(radio, server, { now: () => 0, pollMs: 100000 });
  clearInterval(broker.timer);
  radio.connected = true;
  broker.ready = true;
  t.after(async () => { radio.connected = false; broker.lost(); await broker.close(); });
  const a = { id: 'a', active: true, mediaGeneration: 1 }, b = { id: 'b', active: true, mediaGeneration: 1 };
  const query = Buffer.from('fefeb6e11656fd', 'hex');
  const invalid = Buffer.from('fefee0b6165602fd', 'hex');
  assert.equal(validReply(query, invalid), true, 'reproduces acceptance outside documented 00/01');
  server.emit('command', a, query);
  server.emit('command', b, Buffer.from('fefeb6e21656fd', 'hex'));
  radio.emit('civ', invalid);
  assert.equal(physical.length, 1, 'second client receives unsupported value through cache sharing');
  assert.equal(broker.cacheSnapshot().hits, 1);
  assert.deepEqual(delivered.map(({ id, bytes }) => [id, bytes[2], bytes[6]]), [['a', 0xe1, 2], ['b', 0xe2, 2]]);
  console.log(JSON.stringify({ probe: 'B-03', invalidShapeValue: 2, acceptedByValidator: true,
    physicalReads: physical.length, privateReplies: delivered.length, localCacheHits: broker.cacheSnapshot().hits }));
});
