'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AppController } = require('../src/app/controller');
const { defaults } = require('../src/app/settings');
const { acquireLock } = require('../src/app/lock');
class Service extends EventEmitter {
    constructor(options) {
        super(); this.options = options; this.session = { state: 'stopped', connected: false };
        this.server = { clients: new Map(), stats: {} }; this.starts = this.closes = this.releases = 0;
        this.cache = { requests: 0, hits: 0, misses: 0, coalesced: 0, invalidations: 0, entries: 0, byQuery: {}, ttlMs: { meters: 100, state: 100, settings: 250, tuning: 50 } };
        this.metrics = { physicalTotal: 0, physical: { clientRead: 0 }, eligible: { admitted: 0, active: 0 }, logical: { admitted: 0, active: 0 }, timings: {}, transport: {} };
        this.broker = { ready: false, queue: [], pending: null, owner: null, observedTx: false, releasing: false, generation: 1,
            cacheSnapshot: () => structuredClone(this.cache), metricsSnapshot: () => structuredClone(this.metrics),
            release: async () => { this.releases++; this.releaseFenced = !this.broker.ready; this.broker.owner = null; this.broker.observedTx = false; this.broker.pending = null; this.broker.queue = []; this.broker.releaseUnconfirmed = false; return true; },
        };
    }
    async start() { this.starts++; this.session.connected = true; this.session.state = 'connected'; this.broker.ready = true; this.emit('ready'); }
    async close() { this.closes++; this.broker.ready = false; this.session.connected = false; this.session.state = 'stopped'; }
}
const valid = () => ({ ...defaults(), ICOM_RADIO_HOST: '192.0.2.20', ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'testpass' });
async function setup(t, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-controller-')); const services = [];
    const controller = new AppController({ directory: dir, lock: async () => async () => {}, sampleMs: 100000,
        createSplitter: (config) => { const service = new Service(config); services.push(service); return service; }, ...options });
    t.after(async () => { await controller.close({ confirmedTx: true }); await fs.rm(dir, { recursive: true, force: true }); });
    await controller.initialize(); return { controller, services, dir };
}
test('first run, save, automatic startup, pending configuration and defaults preserve lifecycle', async (t) => {
    const { controller: c, services, dir } = await setup(t);
    assert.equal(c.getState().firstRun, true); assert.equal(services.length, 0);
    await c.saveSettings(valid()); assert.equal(c.getState().firstRun, false); assert.equal(services.length, 0);
    await c.start(); assert.equal(c.getState().running, true);
    const original = services[0].options.broker.cacheMetersMs;
    await c.saveSettings({ ICOM_CACHE_METERS_MS: '200' });
    assert.equal(c.getState().pendingChanges, true); assert.equal(services[0].options.broker.cacheMetersMs, original);
    assert.equal(services[0].closes, 0); assert.equal(c.restoreDefaults().values.ICOM_CACHE_METERS_MS, '100');
    await assert.rejects(c.saveSettings({ ICOM_CACHE_METERS_MS: '-1' })); assert.equal(c.getSettings().values.ICOM_CACHE_METERS_MS, '200');
    await c.reconnect(); assert.equal(services.length, 2); assert.equal(services[0].closes, 1);
    assert.equal(services[1].options.broker.cacheMetersMs, 200); assert.equal(c.getState().pendingChanges, false);
    assert.equal(c.getSettings().hasPassword, true); assert.equal(c.getSettings().values.ICOM_PASSWORD, '');
    await c.close();
    let reopens = 0;
    const reopened = new AppController({ directory: dir, lock: async () => async () => {}, createSplitter: (config) => { reopens++; return new Service(config); } });
    await reopened.initialize(); assert.equal(reopens, 1); assert.equal(reopened.getState().running, true); assert.equal(reopened.getState().history.length, 1);
    assert.equal(reopened.getState().status.cache.requests, 0); await reopened.close();
});
test('TX close/reconnect confirmation includes ownership, observation, pending and queued initiators', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start(); const service = services[0];
    for (const set of [() => { service.broker.owner = {}; }, () => { service.broker.observedTx = true; },
        () => { service.broker.pending = { policy: { tx: 'ptt' } }; }, () => { service.broker.queue = [{ policy: { tx: 'cw' } }]; }]) {
        service.broker.owner = null; service.broker.observedTx = false; service.broker.pending = null; service.broker.queue = []; set();
        assert.equal((await c.close()).requiresConfirmation, true); assert.equal(c.closed, false);
        assert.equal((await c.reconnect()).requiresConfirmation, true); assert.equal(service.closes, 0); assert.equal(service.broker.ready, true);
    }
    const closed = await c.close({ confirmedTx: true });
    assert.equal(closed.releaseConfirmed, undefined); assert.equal(service.releases, 1); assert.equal(service.releaseFenced, true);
    assert.equal(c.getState().running, false); assert.equal(service.closes, 1);
});
test('failed receive confirmation is reported without claiming safe release or restarting', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start(); const service = services[0];
    service.broker.observedTx = true;
    service.broker.release = async () => { service.broker.generation++; service.broker.observedTx = false; service.session.connected = false; };
    const result = await c.reconnect({ confirmedTx: true });
    assert.equal(result.releaseConfirmed, false); assert.equal(services.length, 1);
    assert.match(c.getState().lastError, /could not be confirmed/);
});
test('close cancels a queued start before it can open an upstream session', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid());
    const starting = c.start(); const closing = c.close(); await Promise.all([starting, closing]);
    assert.equal(services.length, 0); assert.equal(c.closed, true);
});
test('diagnostic and state exports redact credentials and sanitize client labels', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start();
    services[0].server.clients.set('c', { id: 'c', active: true, authenticated: true, name: '\u001b[31mtestpass', address: '192.0.2.55', streams: {} });
    c.event('error', 'testpass');
    const state = JSON.stringify(c.getState()), report = JSON.stringify(c.diagnosticReport());
    assert.equal(state.includes('testpass'), false); assert.equal(state.includes('\\u001b'), false);
    assert.equal(report.includes('testpass'), false); assert.equal(report.includes('fixture'), false); assert.equal(report.includes('192.0.2.55'), false);
});
test('session counters reconcile across reconnects and graph retention and events stay bounded', async (t) => {
    let clock = 0;
    const { controller: c, services } = await setup(t, { now: () => clock, sampleMs: 1000 });
    await c.saveSettings(valid()); await c.start();
    services[0].cache.requests = 10; services[0].cache.hits = 4; services[0].cache.misses = 6;
    services[0].metrics.physicalTotal = 6; clock = 1000; c.sample();
    assert.equal(c.getState().rates.requestsPerSecond, 10); assert.equal(c.getState().rates.radioPerSecond, 6);
    await c.reconnect(); services[1].cache.requests = 3; services[1].cache.hits = 1; services[1].cache.misses = 2;
    clock = 2000; c.sample(); assert.equal(c.getState().status.cache.requests, 13); assert.equal(c.getState().status.cache.hits, 5);
    for (let i = 0; i < 1000; i++) { clock += 1000; c.sample(); c.event('info', 'bounded'); }
    assert.ok(c.getState().history.length <= 900); assert.ok(c.getState().events.length <= 100);
    assert.ok(c.getState().history.every((point) => clock - point.time < 900000));
});
test('admission history survives stop/start and repeated reconnects while client gauges stay live', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start();
    const initialWindow = c.statisticsStartedAt;
    Object.assign(services[0].server.stats, { preAuthExpired: 4, preAuthEvictions: 3, resourceRejects: 2 });
    services[0].server.clients.set('old', { active: true, authenticated: true });
    assert.equal(c.getState().status.nativeClients.active, 1);
    await c.stop();
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 4, preAuthEvictions: 3, resourceRejects: 2 });
    assert.equal(c.getState().status.nativeClients.active, 0);
    assert.equal(c.getState().status.connectedUpstreamSessions, 0);
    await c.start();
    for (let i = 1; i <= 2; i++) {
        Object.assign(services[i].server.stats, { preAuthExpired: 1, preAuthEvictions: 2, resourceRejects: 3 });
        await c.reconnect();
        assert.deepEqual(c.getState().status.admission, { preAuthExpired: 4 + i, preAuthEvictions: 3 + 2 * i, resourceRejects: 2 + 3 * i });
        assert.equal(c.getState().status.nativeClients.active, 0);
        assert.equal(c.getState().status.broker.queueDepth, 0);
        assert.equal(c.getState().status.connectedUpstreamSessions, 1);
    }
    assert.equal(c.statisticsStartedAt, initialWindow);
    services[3].broker.resetStatistics = () => {};
    c.resetStatistics();
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 });
    await c.reconnect(); await c.stop(); await c.start();
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 });
});
test('failed startup retains admission events once, including a reset during later shutdown', async (t) => {
    const created = [];
    const { controller: c } = await setup(t, { createSplitter: (options) => {
        const service = new Service(options); created.push(service);
        if (created.length === 1) service.start = async () => {
            Object.assign(service.server.stats, { preAuthExpired: 2, preAuthEvictions: 3, resourceRejects: 4 });
            throw new Error('Fixture listener failure');
        };
        return service;
    } });
    await c.saveSettings(valid()); await c.start();
    assert.equal(c.getState().running, false);
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 2, preAuthEvictions: 3, resourceRejects: 4 });
    await c.stop(); await c.start();
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 2, preAuthEvictions: 3, resourceRejects: 4 });
    const service = created[1]; service.broker.resetStatistics = () => {};
    Object.assign(service.server.stats, { preAuthExpired: 1, preAuthEvictions: 1, resourceRejects: 1 });
    let finishClose;
    const close = service.close.bind(service);
    service.close = async () => { await new Promise((resolve) => { finishClose = resolve; }); await close(); };
    const stopping = c.stop();
    c.resetStatistics(); finishClose(); await stopping;
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 });
    await c.start();
    assert.deepEqual(c.getState().status.admission, { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 });
});
test('retired transport counters accumulate while retained send gauges follow only the current service', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start();
    services[0].metrics.transport.audio = { malformed: 2, sendDrops: 3, sendErrors: 4, outstandingBytes: 120, outstandingSends: 2 };
    assert.equal(c.getState().status.metrics.transport.audio.outstandingBytes, 120);
    await c.stop();
    assert.deepEqual(c.getState().status.metrics.transport.audio, { malformed: 2, sendDrops: 3, sendErrors: 4, outstandingBytes: 0, outstandingSends: 0 });
    await c.start();
    assert.equal(c.getState().status.metrics.transport.audio.outstandingSends, 0);
    services[1].metrics.transport.audio = { malformed: 1, sendDrops: 2, sendErrors: 3, outstandingBytes: 60, outstandingSends: 1 };
    assert.deepEqual(c.getState().status.metrics.transport.audio, { malformed: 3, sendDrops: 5, sendErrors: 7, outstandingBytes: 60, outstandingSends: 1 });
    await c.reconnect();
    assert.deepEqual(c.getState().status.metrics.transport.audio, { malformed: 3, sendDrops: 5, sendErrors: 7, outstandingBytes: 0, outstandingSends: 0 });
});
test('local lock excludes same and different app profiles targeting one radio, then releases', async () => {
    const key = `test-radio:${process.pid}:${Math.random()}`;
    const release = await acquireLock(key); await assert.rejects(acquireLock(key), /Another local splitter/);
    await release(); const again = await acquireLock(key); await again();
});

test('settings can be corrected while a connection attempt is pending and cancelled startup counts survive', async (t) => {
    let held;
    const { controller: c } = await setup(t, { createSplitter: (options) => {
        const service = new Service(options); held = service;
        service.start = () => new Promise((_resolve, reject) => { service.cancelStart = reject; });
        service.close = async () => { service.broker.ready = false; service.session.connected = false; service.cancelStart(new Error('Cancelled')); };
        service.metrics.physicalTotal = 3; service.metrics.physical.startup = 3;
        return service;
    } });
    await c.saveSettings(valid()); const starting = c.start();
    while (!held) await new Promise((resolve) => setImmediate(resolve));
    const saved = await Promise.race([c.saveSettings({ ICOM_RADIO_HOST: '192.0.2.21' }), new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Save blocked behind start')), 500); timer.unref(); })]);
    assert.equal(saved.pendingChanges, true); assert.equal(held.options.radio.host, '192.0.2.20');
    assert.equal(c.getSettings().values.ICOM_RADIO_HOST, '192.0.2.21');
    await c.stop(); await starting;
    assert.equal(c.getState().status.metrics.physicalTotal, 3);
    assert.equal(c.getState().status.metrics.physical.startup, 3);
});

test('an owned reconnecting service remains running with stop controls available', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start(); const service = services[0];
    service.broker.ready = false; service.session.connected = false; service.session.state = 'reconnecting'; service.emit('status', { state: 'disconnected' });
    const state = c.getState(); assert.equal(state.running, true); assert.equal(state.status.broker.ready, false);
    assert.equal(state.dashboard.rxTx, 'Unavailable');
    await c.start(); assert.equal(services.length, 1, 'Start must not create a competing session');
    await c.stop(); assert.equal(c.getState().running, false); assert.equal(service.closes, 1);
});

test('app and radio endpoint locks prevent duplicate profiles without locking independent radios', async (t) => {
    const one = await setup(t, { lock: acquireLock });
    const duplicate = new AppController({ directory: one.dir, createSplitter: (options) => new Service(options) });
    await assert.rejects(duplicate.initialize(), /Another local splitter/); await duplicate.close();
    const two = await setup(t, { lock: acquireLock });
    await one.controller.saveSettings(valid()); await one.controller.start();
    await two.controller.saveSettings(valid()); await two.controller.start();
    assert.equal(two.controller.getState().running, false); assert.match(two.controller.getState().lastError, /Another local splitter/);
    assert.equal(one.controller.getState().running, true);
    await two.controller.saveSettings({ ICOM_RADIO_CONTROL_PORT: '50011' }); await two.controller.start();
    assert.equal(two.controller.getState().running, true, 'different radio control endpoint can run independently');
});

test('same-millisecond events retain counter deltas and rates use a full sampling interval', async (t) => {
    let clock = 0;
    const { controller: c, services } = await setup(t, { now: () => clock, sampleMs: 1000 });
    await c.saveSettings(valid()); await c.start(); const service = services[0];
    service.cache.requests = 2; service.cache.hits = 1; service.metrics.physicalTotal = 1;
    service.metrics.timings.radioRtt = { count: 1, sumMs: 4, maxMs: 4, atLeast350Ms: 0, buckets: [1], upperBoundsMs: [null] };
    c.sample(); c.sample();
    assert.equal(c.getState().status.cache.requests, 2, 'events publish fresh counters');
    assert.equal(c.getState().rates.requestsPerSecond, 0, 'events do not produce rates from zero elapsed time');
    clock = 1; service.cache.requests = 3; c.sample();
    clock = 500; service.cache.requests = 4; service.cache.hits = 2; service.metrics.physicalTotal = 2;
    service.metrics.timings.radioRtt = { count: 2, sumMs: 10, maxMs: 6, atLeast350Ms: 0, buckets: [2], upperBoundsMs: [null] };
    c.sample(); assert.equal(c.getState().rates.requestsPerSecond, 0);
    clock = 1000; c.sample();
    assert.equal(c.getState().rates.requestsPerSecond, 4); assert.equal(c.getState().rates.hitsPerSecond, 2);
    assert.equal(c.getState().rates.radioPerSecond, 2); assert.equal(c.getState().latency.responseMs, 5);
    service.cache.requests = 7; service.cache.hits = 3; service.metrics.physicalTotal = 4;
    service.metrics.timings.radioRtt = { count: 4, sumMs: 30, maxMs: 10, atLeast350Ms: 0, buckets: [4], upperBoundsMs: [null] };
    c.sample(); clock = 1001; c.sample();
    assert.equal(c.getState().rates.requestsPerSecond, 4, 'one-millisecond updates retain the last measured interval');
    clock = 2000; c.sample();
    assert.equal(c.getState().rates.requestsPerSecond, 3); assert.equal(c.getState().rates.radioPerSecond, 2);
    assert.equal(c.getState().latency.responseMs, 10); assert.deepEqual(c.getState().history.map((p) => p.time), [0, 1000, 2000]);
});

test('saved connection edits do not relabel the active endpoint before reconnect', async (t) => {
    const { controller: c } = await setup(t); await c.saveSettings(valid()); await c.start();
    await c.saveSettings({ ICOM_RADIO_HOST: '192.0.2.88', ICOM_LISTEN_CONTROL_PORT: '50101', ICOM_PASSWORD: 'otherpass' });
    let state = c.getState(); assert.equal(state.pendingChanges, true);
    assert.equal(state.settings.values.ICOM_RADIO_HOST, '192.0.2.88'); assert.equal(state.activeSettings.values.ICOM_RADIO_HOST, '192.0.2.20');
    assert.equal(state.activeSettings.values.ICOM_LISTEN_CONTROL_PORT, '50001'); assert.equal(state.activeSettings.values.ICOM_PASSWORD, '');
    assert.equal(JSON.stringify(state.activeSettings).includes('testpass'), false);
    await c.reconnect(); state = c.getState(); assert.equal(state.pendingChanges, false);
    assert.equal(state.activeSettings.values.ICOM_RADIO_HOST, '192.0.2.88'); assert.equal(state.activeSettings.values.ICOM_LISTEN_CONTROL_PORT, '50101');
});

test('failed credential writes redact candidate and imported passwords while preserving prior settings', async (t) => {
    let stored = '', recovery = '', fail = false;
    const credentialStore = {
        read: async () => stored,
        write: async (value) => { if (fail && value !== stored) throw new Error(`Credential backend rejected ${value}`); stored = value; },
        forRecovery: () => ({ read: async () => recovery, write: async (value) => { recovery = value; }, remove: async () => { recovery = ''; } }),
        describe: () => 'Test credential backend',
    };
    const { controller: c, dir } = await setup(t, { credentialStore });
    await c.saveSettings(valid()); fail = true;
    let failure;
    try { await c.saveSettings({ ICOM_PASSWORD: 'newsecret', ICOM_RADIO_HOST: '192.0.2.99' }); }
    catch (error) { failure = error; }
    assert.ok(failure); assert.equal(failure.message, 'Credential backend rejected [redacted]');
    assert.equal(failure.cause, undefined); assert.equal(failure.stack.includes('newsecret'), false);
    assert.equal(JSON.stringify(c.getState()).includes('newsecret'), false);
    assert.equal(JSON.stringify(c.diagnosticReport()).includes('newsecret'), false);
    assert.equal(c.getSettings().values.ICOM_RADIO_HOST, '192.0.2.20'); assert.equal(stored, 'testpass');
    const imported = path.join(dir, 'imported-password'); await fs.writeFile(imported, 'imported1\n');
    await assert.rejects(c.saveSettings({ ICOM_PASSWORD_FILE: imported }), (error) => error.message === 'Credential backend rejected [redacted]' && !error.stack.includes('imported1'));
    assert.equal(JSON.stringify(c.getState()).includes('imported1'), false);
    assert.equal(JSON.stringify(c.diagnosticReport()).includes('imported1'), false);
    assert.equal(c.getSettings().values.ICOM_PASSWORD_FILE, ''); assert.equal(stored, 'testpass');
    await assert.rejects(c.saveSettings({ ICOM_RADIO_HOST: 'bad-address' }), /Radio address must be an IPv4 address/);
});

test('actual RX/TX display stays distinct from quiet or pending TX ownership confirmation', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start(); const service = services[0];
    service.broker.owner = {}; service.broker.observedTx = false;
    assert.equal(c.getState().dashboard.rxTx, 'RX', 'a quiet VOX/automatic owner is not observed transmission');
    assert.equal(c.getState().dashboard.txControl, 'Owned or pending'); assert.equal(c.getState().txActive, true);
    assert.equal((await c.close()).requiresConfirmation, true, 'quiet ownership still protects close');
    service.broker.observedTx = true; assert.equal(c.getState().dashboard.rxTx, 'TX');
    service.broker.ready = false; assert.equal(c.getState().dashboard.rxTx, 'Unavailable');
    assert.equal((await c.close()).requiresConfirmation, true, 'unready display must not weaken the gate');
    service.broker.owner = null; service.broker.observedTx = false; service.broker.ready = true;
    service.broker.pending = { policy: { tx: 'ptt' } };
    assert.equal(c.getState().dashboard.rxTx, 'RX'); assert.equal(c.getState().dashboard.txControl, 'Owned or pending');
    assert.equal((await c.close()).requiresConfirmation, true);
    service.broker.pending = null; assert.equal(c.getState().dashboard.txControl, 'Available');
    service.session.connected = false; assert.equal(c.getState().dashboard.rxTx, 'Unavailable');
});

test('statistics reset preserves live connections, TX and cache warmth and clears reconnect totals', async (t) => {
    let clock = 1000;
    const { controller: c, services } = await setup(t, { now: () => clock });
    await c.saveSettings(valid()); await c.start();
    const service = services[0];
    service.broker.resetStatistics = () => { service.cache.requests = 0; service.cache.hits = 0; service.metrics.physicalTotal = 0; };
    service.cache.requests = 40; service.cache.hits = 30; service.cache.entries = 2;
    c.totals.cache = { ...service.cache, requests: 100, hits: 80 };
    service.session.control = { counters: { lost: 7 }, pendingPings: new Map([[1, 2]]) };
    service.server.stats.resourceRejects = 9;
    service.broker.observedTx = true;
    c.latency.pingMs = 2; c.latency.responseMs = 5; c.rates.radioPerSecond = 20;
    clock = 2000; const state = c.resetStatistics();
    assert.equal(state.status.cache.requests, 0); assert.equal(state.status.cache.hits, 0);
    assert.equal(state.status.cache.entries, 2); assert.equal(state.txActive, true);
    assert.equal(state.history.length, 0); assert.equal(state.rates.radioPerSecond, 0);
    assert.equal(state.latency.responseMs, null); assert.equal(state.latency.pingMs, 2);
    assert.equal(state.statisticsStartedAt, 2000); assert.equal(state.uptimeMs, 1000);
    assert.equal(service.session.control.counters.lost, 0); assert.equal(service.session.control.pendingPings.get(1), 2);
    assert.equal(service.server.stats.resourceRejects, 0); assert.equal(service.starts, 1); assert.equal(service.closes, 0);
    service.broker.observedTx = false; service.cache.requests = 3;
    await c.reconnect(); assert.equal(c.getState().status.cache.requests, 3);
    services[1].broker.resetStatistics = () => {};
    c.resetStatistics(); assert.equal(c.getState().status.cache.requests, 0);
});

test('unknown observed TX after disconnect remains gated and is reported unconfirmed on close', async (t) => {
    const { controller: c, services } = await setup(t); await c.saveSettings(valid()); await c.start();
    services[0].broker.releaseUnconfirmed = true; services[0].session.connected = false;
    assert.equal(c.getState().txActive, true);
    assert.equal((await c.close()).requiresConfirmation, true);
    services[0].close = async () => ({ releaseConfirmed: false });
    const result = await c.close({ confirmedTx: true });
    assert.equal(result.releaseConfirmed, false);
});
