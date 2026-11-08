'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config } = require('../src/config');
const defaults = { ICOM_RADIO_HOST: '192.0.2.1', ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'fixture-password' };

test('configuration defaults to loopback and native ports, never implicit hardware host', () => {
    assert.throws(() => config({}), /HOST/);
    const c = config(defaults);
    assert.equal(c.server.bindAddress, '127.0.0.1');
    assert.equal(c.radio.controlPort, 50001);
    assert.equal(c.server.audioPort, 50003);
    assert.equal(c.broker.requestTimeoutMs, 2000);
});

test('invalid config errors do not expose credentials or supplied file paths', () => {
    const rejected = [
        { ICOM_PASSWORD: 'short' }, { ICOM_USERNAME: '\n' },
        { ICOM_RADIO_CONTROL_PORT: '0' }, { ICOM_RADIO_CONTROL_PORT: '50002' },
        { ICOM_LISTEN_AUDIO_PORT: '1.5' }, { ICOM_BIND_ADDRESS: '::' },
        { ICOM_COMMAND_TIMEOUT_MS: 'NaN' },
        { ICOM_PASSWORD_FILE: '/private/unknown-file' },
    ];
    for (const override of rejected) {
        assert.throws(() => config({ ...defaults, ...override }), (error) => {
            assert.ok(!error.message.includes(defaults.ICOM_PASSWORD));
            assert.ok(!error.message.includes('/private/unknown-file'));
            return true;
        });
    }
    assert.throws(() => config({ ...defaults, ICOM_RADIO_HOST: '127.0.0.1' }), /relay loop/);
});

test('password file accepts a single terminal newline without trimming password spaces', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'credential');
    fs.writeFileSync(file, ' fixture-secret \n', { mode: 0o600 });
    const c = config({ ...defaults, ICOM_PASSWORD: undefined, ICOM_PASSWORD_FILE: file });
    assert.equal(c.radio.password, ' fixture-secret ');
});

test('CLI help is available without credentials; invalid input exits cleanly', () => {
    const help = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8', env: {} });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /ICOM_PASSWORD_FILE/);
    const bad = spawnSync(process.execPath, ['src/cli.js'], { encoding: 'utf8', env: {} });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ICOM_RADIO_HOST/);
});

test('cache configuration has bounded TTLs and explicit global disable', () => {
    const c = config(defaults).broker;
    assert.deepEqual([c.cacheEnabled, c.cacheMetersMs, c.cacheStateMs, c.cacheSettingsMs, c.cacheTuningMs],
        [true, 100, 100, 250, 50]);
    assert.equal(config({ ...defaults, ICOM_CACHE_ENABLED: '0' }).broker.cacheEnabled, false);
    assert.equal(config({ ...defaults, ICOM_CACHE_ENABLED: '1' }).broker.cacheEnabled, true);
    for (const [env, option] of [
        ['ICOM_CACHE_METERS_MS', 'cacheMetersMs'], ['ICOM_CACHE_STATE_MS', 'cacheStateMs'],
        ['ICOM_CACHE_SETTINGS_MS', 'cacheSettingsMs'], ['ICOM_CACHE_TUNING_MS', 'cacheTuningMs'],
    ]) {
        for (const value of ['0', '1000']) assert.equal(config({ ...defaults, [env]: value }).broker[option], Number(value));
        for (const value of ['-1', '1001', '1.5', 'NaN', '', ' 50']) {
            assert.throws(() => config({ ...defaults, [env]: value }), new RegExp(env));
        }
    }
    for (const value of ['', 'true', 'false', '2', 0, 1]) {
        assert.throws(() => config({ ...defaults, ICOM_CACHE_ENABLED: value }), /ICOM_CACHE_ENABLED/);
    }
});

test('status snapshot exposes only redacted state and cache counters', () => {
    const { statusSnapshot } = require('../src/cli');
    const cache = { enabled: true, entries: 1, epoch: 2, requests: 3, hits: 1, coalesced: 0, misses: 2, byQuery: {} };
    const service = {
        options: { password: 'secret-password' },
        session: { state: 'connected', connected: true, password: 'session-secret', nonce: 'session-nonce' },
        broker: { ready: true, queue: [{ client: 'private-client' }], pending: { nonce: 'pending-nonce' },
            owner: { password: 'owner-secret' }, cacheSnapshot: () => cache },
    };
    assert.deepEqual(statusSnapshot(service), {
        type: 'status', nativeClients: { active: 0, authenticated: 0, preAuth: 0, granted: 0, civReady: 0, audioReady: 0 },
        admission: { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 },
        connectedUpstreamSessions: 1, metrics: null, radio: { state: 'connected', connected: true },
        broker: { ready: true, queueDepth: 1, pending: true, txOwned: true }, cache,
    });
    const serialized = JSON.stringify(statusSnapshot(service));
    for (const secret of ['password', 'nonce', 'private-client', 'secret', 'options']) assert.ok(!serialized.includes(secret));
});

test('pending login resource bounds are explicit and separate from authenticated budget', () => {
    const server = config(defaults).server;
    assert.equal(server.preAuthTimeoutMs, 10000);
    assert.equal(server.preAuthMemoryBudgetBytes, 8 * 1024 * 1024);
    assert.equal(server.memoryBudgetBytes, 128 * 1024 * 1024);
    for (const [key, value] of [['ICOM_PREAUTH_TIMEOUT_MS', '0'], ['ICOM_PREAUTH_TIMEOUT_MS', 'NaN'], ['ICOM_PREAUTH_MEMORY_MB', '0'], ['ICOM_PREAUTH_MEMORY_MB', '1.5']]) {
        assert.throws(() => config({ ...defaults, [key]: value }), new RegExp(key));
    }
});

test('status aggregates native client states without logging their identities', () => {
    const { statusSnapshot } = require('../src/cli');
    const service = { session: { state: 'connected', connected: true }, server: { clients: new Map([
        [1, { active: true, authenticated: true, granted: true, serialOpen: true, rxEnable: true,
            address: 'private-endpoint', name: 'private-name', streams: { civ: { ready: true }, audio: { ready: true } } }],
        [2, { active: true, authenticated: false, granted: false, streams: {} }],
        [3, { active: false, authenticated: true, streams: {} }],
    ]) }, broker: { ready: true, queue: [], pending: null, owner: null,
        cacheSnapshot: () => ({ enabled: true }), metricsSnapshot: () => ({ physicalTotal: 3 }) } };
    const result = statusSnapshot(service);
    assert.deepEqual(result.nativeClients, { active: 2, authenticated: 1, preAuth: 1, granted: 1, civReady: 1, audioReady: 1 });
    assert.equal(result.connectedUpstreamSessions, 1);
    assert.deepEqual(result.metrics, { physicalTotal: 3 });
    assert.ok(!JSON.stringify(result).includes('private-'));
});
