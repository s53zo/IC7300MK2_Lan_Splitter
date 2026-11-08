'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { policyFor, validReply } = require('../src/read-cache');
const query = (hex, controller = 0xe0) => Buffer.concat([Buffer.from([0xfe, 0xfe, 0xb6, controller]), Buffer.from(hex, 'hex'), Buffer.from([0xfd])]);
const reply = (hex, controller = 0xe0) => Buffer.concat([Buffer.from([0xfe, 0xfe, controller, 0xb6]), Buffer.from(hex, 'hex'), Buffer.from([0xfd])]);

test('documented bare settings getters retain exact reply shapes and exclude setters', () => {
  for (const hex of ['10', '11', '12']) {
    assert.equal(policyFor(query(hex))?.ttlMs, 250, hex);
    assert.equal(policyFor(query(hex))?.category, 'settings', hex);
  }
  assert.deepEqual(policyFor(query('12'))?.prefix, Buffer.from([0]));
  for (const [q, r] of [['10', '1000'], ['10', '1008'], ['11', '1100'], ['11', '1120'], ['12', '120000'], ['12', '120001']]) {
    assert.equal(validReply(query(q), reply(r)), true, r);
    assert.equal(validReply(query(q), reply(`${r}00`)), false, `extra ${r}`);
    assert.equal(validReply(query(q), reply(r.slice(0, -2))), false, `truncated ${r}`);
  }
  for (const [q, r] of [['10', '1009'], ['10', '100a'], ['11', '1101'], ['11', '1121'], ['12', '1201'], ['12', '120100'], ['12', '120002']]) assert.equal(validReply(query(q), reply(r)), false, r);
  for (const hex of ['1000', '1008', '1100', '1120', '1200', '120000', '120001']) assert.equal(policyFor(query(hex)), null, hex);
});

test('scope reference levels use half-decibel steps within signed twenty-decibel bounds', () => {
  for (const value of ['000000', '005000', '025001', '195000', '200000', '200001']) assert.equal(validReply(query('271900'), reply(`271900${value}`)), true, value);
  for (const value of ['001000', '009000', '025100', '205000', '210000', '000002', '00fa00']) assert.equal(validReply(query('271900'), reply(`271900${value}`)), false, value);
});

test('independent radio fixture returns bare getter values and preserves setter state', () => {
  const { IcomPeer } = require('./fixtures/icom-radio');
  const radio = new IcomPeer();
  const responses = [];
  radio.replyCiv = (bytes) => responses.push(Buffer.from(bytes).toString('hex'));
  for (const [command, expected] of [
    ['10', '1000'], ['1008', 'fb'], ['10', '1008'], ['1009', 'fa'],
    ['11', '1100'], ['1120', 'fb'], ['11', '1120'], ['1101', 'fa'],
    ['12', '120000'], ['120001', 'fb'], ['12', '120001'],
    ['1200', 'fa'], ['120100', 'fa'], ['120002', 'fa'],
    ['120000', 'fb'], ['12', '120000']
  ]) {
    radio.civ(query(command));
    assert.equal(responses.at(-1), expected, command);
  }
});

test('exact read policy separates fast readings, tuning and operator settings', () => {
  for (const hex of ['1502', '1507', '1511', '1512', '1513', '1514', '1515', '1516']) assert.equal(policyFor(query(hex)).ttlMs, 100);
  for (const hex of ['1c00', '1c01']) assert.equal(policyFor(query(hex)).category, 'state');
  for (const hex of ['03', '04', '0f', '2500', '2501', '2600', '2601']) assert.equal(policyFor(query(hex)).ttlMs, 50);
  for (const hex of ['1401', '1417', '1602', '1656', '1665', '1a03', '1a04', '1a050079', '1a050080', '1a050081', '1a050082', '1a050083', '1a050084', '1a050085', '271400', '271500', '271600', '271700', '271900', '271a00']) assert.equal(policyFor(query(hex)).ttlMs, 250, hex);
  assert.deepEqual(policyFor(query('1a050083', 0xe1)), { key: '1a050083', category: 'settings', ttlMs: 250, prefix: Buffer.from('050083', 'hex') });
  assert.equal(policyFor(query('1502'), { cacheMetersMs: 17 }).ttlMs, 17);
  assert.equal(policyFor(query('03'), { cacheTuningMs: 0 }), null);
});

test('writes, unknown commands, virtual scope and sensitive menu reads are excluded', () => {
  for (const hex of ['05', '07', '17', '1646', '1647', '1501', '14010012', '1c0001', '1a050014', '1a050089', '1a050100', '1a05', '2710', '2711', '2700', '2714', '271401', '27140001', 'ff']) assert.equal(policyFor(query(hex)), null, hex);
  for (const value of [null, [], Buffer.alloc(0), query('03').subarray(1), Buffer.concat([query('03'), query('03')])]) assert.equal(policyFor(value), null);
});

test('successful replies require exact opcode, selector, length and canonical values', () => {
  const cases = [
    ['03', '030040071400'], ['04', '040101'], ['0f', '0f01'],
    ['2501', '25010040071400'], ['2600', '2600010102'],
    ['1502', '15020255'], ['1507', '150701'], ['1c00', '1c0001'], ['1c01', '1c0102'],
    ['1401', '14010127'], ['1612', '161203'], ['1656', '165631'],
    ['1a03', '1a0340'], ['1a04', '1a0413'], ['1a050083', '1a0500830255'],
    ['1a050084', '1a05008405'], ['271400', '27140003'], ['271500', '2715000000010000'],
    ['271600', '27160004'], ['271700', '27170001'], ['271900', '271900200001'], ['271a00', '271a0002']
  ];
  for (const [q, r] of cases) {
    assert.equal(validReply(query(q), reply(r)), true, r);
    assert.equal(validReply(query(q), reply(r.slice(0, -2))), false, `truncated ${r}`);
    assert.equal(validReply(query(q), reply(`${r}00`)), false, `extra ${r}`);
    assert.equal(validReply(query(q), reply('fb')), false);
    assert.equal(validReply(query(q), reply('fa')), false);
    assert.equal(validReply(query(q), reply(r, 0)), false);
    assert.equal(validReply(query(q), reply(r, 0xe1)), true);
  }
  for (const [q, r] of [['1502', '15020256'], ['1507', '150702'], ['1c00', '1c0002'], ['1c01', '1c0103'], ['04', '040601'], ['04', '040100'], ['2600', '2601010101'], ['1401', '140100fa'], ['271900', '271900001002'], ['271500', '2715000000020000']]) assert.equal(validReply(query(q), reply(r)), false, r);
});
