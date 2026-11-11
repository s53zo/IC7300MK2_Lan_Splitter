'use strict';

// Explicit IC-7300MK2 read shapes. Keep menu identifiers narrow: adjacent
// network menu entries can contain credentials and must never enter this cache.
const shapes = new Map();
const bcd = (data) => [...data].every((v) => (v & 15) <= 9 && (v >> 4) <= 9);
const decimal = (data) => [...data].reduce((n, v) => n * 100 + (v >> 4) * 10 + (v & 15), 0);
const range = (min, max) => (data) => bcd(data) && decimal(data) >= min && decimal(data) <= max;
const mode = (v) => [0, 1, 2, 3, 4, 5, 7, 8].includes(v);
const add = (key, category, size, validate, prefix) => shapes.set(key, { category, size, validate, prefix });
add('03', 'tuning', 5, bcd);
add('04', 'tuning', 2, (d) => mode(d[0]) && d[1] >= 1 && d[1] <= 3);
add('0f', 'tuning', 1, range(0, 1));
add('10', 'settings', 1, range(0, 8));
add('11', 'settings', 1, (d) => d[0] === 0 || d[0] === 0x20);
// The bare RX antenna getter returns a fixed 00 subcommand before its value.
add('12', 'settings', 2, (d) => d[0] === 0 && d[1] <= 1, Buffer.from([0]));
for (const selector of ['00', '01']) {
  add(`25${selector}`, 'tuning', 5, bcd);
  add(`26${selector}`, 'tuning', 3, (d) => mode(d[0]) && d[1] <= 1 && d[2] >= 1 && d[2] <= 3);
}
for (const sub of ['02', '07', '11', '12', '13', '14', '15', '16']) {
  add(`15${sub}`, 'meters', sub === '07' ? 1 : 2, range(0, sub === '07' ? 1 : 255));
}
add('1c00', 'state', 1, range(0, 1));
add('1c01', 'state', 1, range(0, 2));
for (const sub of ['01', '02', '03', '06', '07', '08', '09', '0a', '0b', '0c', '0e', '0f', '12', '15', '16', '17']) {
  add(`14${sub}`, 'settings', 2, range(0, 255));
}
for (const sub of ['02', '12', '22', '40', '41', '42', '43', '44', '45', '48', '4f', '50', '56', '57', '58', '65']) {
  const max = sub === '12' ? 3 : ['02', '57', '58'].includes(sub) ? 2 : 1;
  add(`16${sub}`, 'settings', 1, range(sub === '12' ? 1 : 0, max));
}
add('1a03', 'settings', 1, range(0, 49)); // Filter width index, mode-dependent.
add('1a04', 'settings', 1, range(0, 13)); // AGC time constant.
for (const id of ['79', '80', '81', '82', '83', '84', '85']) {
  const level = ['81', '82', '83'].includes(id);
  add(`1a0500${id}`, 'settings', level ? 2 : 1, range(0, level ? 255 : ['84', '85'].includes(id) ? 5 : 1));
}
add('271400', 'settings', 1, range(0, 3)); // Scope mode.
add('271500', 'settings', 5, (d) => bcd(d) && [2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000].includes([...d].reverse().reduce((n, v) => n * 100 + (v >> 4) * 10 + (v & 15), 0)));
add('271600', 'settings', 1, range(1, 4)); // Fixed edge.
add('271700', 'settings', 1, range(0, 1)); // Hold.
add('271900', 'settings', 3, (d) => range(0, 2000)(d.subarray(0, 2)) && [0, 0x50].includes(d[1]) && d[2] <= 1);
add('271a00', 'settings', 1, range(0, 2)); // Sweep speed.

const defaultTtls = { meters: 100, state: 100, settings: 250, tuning: 50 };
const labels = {
  '03': 'Selected frequency', '04': 'Mode and filter', '0f': 'Split state',
  '10': 'Tuning step', '11': 'Attenuator', '12': 'RX antenna',
  '1502': 'S-meter', '1507': 'ADC overflow', '1511': 'Power meter', '1512': 'SWR meter', '1513': 'ALC meter',
  '1c00': 'RX/TX state', '1c01': 'Tuner state',
  '1402': 'RF gain', '140a': 'RF power setting', '1602': 'Preamp selection',
  '1640': 'Noise reduction on/off', '1641': 'Auto notch on/off',
  '271400': 'Scope mode', '271500': 'Scope span', '271600': 'Scope fixed edge',
  '271700': 'Scope hold', '271900': 'Scope reference level', '271a00': 'Scope sweep speed',
};
function queryCatalog() {
  return [...shapes].map(([key, shape]) => ({ key, label: labels[key] || `CI-V query ${key.toUpperCase()}`,
    category: shape.category, defaultTtlMs: defaultTtls[shape.category] })).sort((a, b) => a.key.localeCompare(b.key));
}
function validateQueryTtls(map = {}) {
  if (!map || typeof map !== 'object' || Array.isArray(map)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(map))) throw new Error('Per-command cache overrides must be an object');
  const normalized = {}, seen = new Set();
  for (const original of Reflect.ownKeys(map)) {
    if (typeof original !== 'string' || !/^(?:[0-9a-fA-F]{2}){1,5}$/.test(original)) throw new Error('Invalid CI-V cache query key');
    const key = original.toLowerCase();
    if (!shapes.has(key)) throw new Error('Unsupported CI-V cache query key');
    if (seen.has(key)) throw new Error('Duplicate CI-V cache query key');
    seen.add(key);
    const value = map[original];
    if (value === '' || value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > 1000) throw new Error(`Cache time for CI-V ${key.toUpperCase()} must be an integer from 0 to 1000 ms`);
    normalized[key] = value;
  }
  return normalized;
}
function familyTtl(category, options) {
  return options[`cache${category[0].toUpperCase()}${category.slice(1)}Ms`] ?? defaultTtls[category];
}
function cacheQuerySettings(options = {}) {
  const overrides = validateQueryTtls(options.cacheQueryTtls);
  return queryCatalog().map(({ key, label, category }) => {
    const overrideMs = Object.hasOwn(overrides, key) ? overrides[key] : null;
    const selected = overrideMs ?? familyTtl(category, options);
    const effectiveMs = options.cacheEnabled === false ? 0 : Number.isSafeInteger(selected) && selected >= 0 && selected <= 1000 ? selected : 0;
    return { key, label, category, overrideMs, effectiveMs };
  });
}

function body(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6 || bytes[0] !== 0xfe || bytes[1] !== 0xfe || bytes.at(-1) !== 0xfd) return null;
  if (bytes.subarray(2, -1).some((v) => v === 0xfe || v === 0xfd)) return null;
  return bytes.subarray(4, -1);
}

function policyFor(bytes, ttlOptions = {}) {
  const data = body(bytes);
  if (!data || bytes[2] === 0 || bytes[3] === 0) return null;
  const key = data.toString('hex'), shape = shapes.get(key);
  if (!shape) return null;
  if (ttlOptions.cacheEnabled === false) return null;
  const override = ttlOptions.cacheQueryTtls?.[key] ?? ttlOptions.cacheQueryTtls?.[key.toUpperCase()];
  const ttlMs = override === undefined || override === '' ? familyTtl(shape.category, ttlOptions) : override;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 1000) return null;
  return { key, category: shape.category, ttlMs, prefix: Buffer.from(shape.prefix ?? data.subarray(1)) };
}

function validReply(query, reply) {
  const policy = policyFor(query), data = body(reply);
  if (!policy || !data || reply[2] === 0 || reply[3] !== query[2]) return false;
  const request = body(query), shape = shapes.get(policy.key);
  if (data.length !== request.length + shape.size || !data.subarray(0, request.length).equals(request)) return false;
  return shape.validate(data.subarray(request.length));
}

module.exports = { policyFor, validReply, queryCatalog, validateQueryTtls, cacheQuerySettings };
