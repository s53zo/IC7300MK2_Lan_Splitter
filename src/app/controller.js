'use strict';
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { Splitter } = require('../splitter');
const { statusSnapshot } = require('../cli');
const { FIELDS, defaults, normalize, validate } = require('./settings');
const { SettingsStore, defaultDirectory } = require('./store');
const { acquireLock } = require('./lock');
const copy = (value) => JSON.parse(JSON.stringify(value));
const clean = (value, max = 80) => [...String(value || '')].filter((char) => { const code = char.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); }).join('').slice(0, max);
const CACHE_COUNTS = ['requests', 'hits', 'misses', 'coalesced', 'invalidations'];
function sumObjects(a = {}, b = {}, gauges = []) {
    const out = { ...a, ...b };
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (gauges.includes(key)) { out[key] = b[key] || 0; continue; }
        if (typeof (a[key] ?? b[key]) === 'number') out[key] = (a[key] || 0) + (b[key] || 0);
        else if (a[key] && b[key] && typeof a[key] === 'object' && !Array.isArray(a[key])) out[key] = sumObjects(a[key], b[key]);
    }
    return out;
}
function combineCache(a, b) {
    const out = { ...(b || a || { enabled: true, entries: 0, ttlMs: {} }) };
    for (const key of CACHE_COUNTS) out[key] = (a?.[key] || 0) + (b?.[key] || 0);
    out.byQuery = sumObjects(a?.byQuery, b?.byQuery);
    if (!b) out.entries = 0;
    return out;
}
function combineMetrics(a, b) {
    if (!a && !b) return null;
    const out = { ...(b || a) };
    for (const key of ['physicalTotal', 'physicalSendErrors', 'radioTimeouts', 'oneWayDispatches', 'responses', 'evictions', 'suppressedQueuedReads']) out[key] = (a?.[key] || 0) + (b?.[key] || 0);
    for (const key of ['physical', 'reasons', 'invalidationEntries', 'cacheHits', 'byQuery', 'transport']) out[key] = sumObjects(a?.[key], b?.[key]);
    for (const key of ['logical', 'eligible']) out[key] = sumObjects(a?.[key], b?.[key], ['active', 'queued', 'inFlight']);
    out.timings = {};
    for (const name of new Set([...Object.keys(a?.timings || {}), ...Object.keys(b?.timings || {})])) {
        const x = a?.timings?.[name], y = b?.timings?.[name];
        out.timings[name] = { ...(y || x), count: (x?.count || 0) + (y?.count || 0), sumMs: (x?.sumMs || 0) + (y?.sumMs || 0),
            maxMs: Math.max(x?.maxMs || 0, y?.maxMs || 0), atLeast350Ms: (x?.atLeast350Ms || 0) + (y?.atLeast350Ms || 0),
            buckets: (y?.buckets || x.buckets).map((_, i) => (x?.buckets?.[i] || 0) + (y?.buckets?.[i] || 0)) };
    }
    return out;
}
class AppController extends EventEmitter {
    constructor({ directory = defaultDirectory(), credentialStore, createSplitter = (options) => new Splitter(options), now = () => Date.now(),
        sampleMs = 1000, lock = acquireLock } = {}) {
        super();
        this.directory = path.resolve(directory);
        this.store = new SettingsStore(this.directory, credentialStore);
        this.createSplitter = createSplitter; this.now = now; this.acquireLock = lock;
        this.sampleMs = sampleMs; this.createdAt = now();
        this.values = defaults(); this.password = ''; this.secrets = new Set();
        this.activeValues = null; this.activePassword = null;
        this.firstRun = true; this.lastError = null; this.connecting = false; this.closed = false;
        this.service = null; this.history = []; this.events = []; this.totals = { cache: null, metrics: null };
        this.rates = { requestsPerSecond: 0, radioPerSecond: 0, hitsPerSecond: 0 };
        this.latency = { pingMs: null, pingUpdatedAt: null, pingStale: true, responseMs: null, queueMs: null };
        this.revision = 0; this.operations = Promise.resolve(); this.saves = Promise.resolve();
    }
    getFields() { return copy(FIELDS); }
    getSettings() { return { values: { ...this.values, ICOM_PASSWORD: '', ICOM_PASSWORD_FILE: '' }, hasPassword: Boolean(this.password), credentialProtection: this.store.describe() }; }
    restoreDefaults() { return { ...this.getSettings(), values: defaults() }; }
    getNetworkInterfaces() {
        return Object.entries(os.networkInterfaces()).flatMap(([name, rows]) => rows.filter((row) => row.family === 'IPv4').map((row) => ({ name, address: row.address, internal: row.internal })));
    }
    pendingChanges() { return Boolean(this.activeValues && (JSON.stringify(this.values) !== JSON.stringify(this.activeValues) || this.password !== this.activePassword)); }
    redact(value) {
        const encoded = JSON.stringify(value, (_key, item) => {
            if (typeof item !== 'string') return item;
            for (const secret of this.secrets) if (secret) item = item.split(secret).join('[redacted]');
            return item;
        });
        return JSON.parse(encoded);
    }
    event(level, message) {
        this.events.push({ time: this.now(), level, message });
        if (this.events.length > 100) this.events.shift();
    }
    async initialize() {
        if (this.initializing) return this.initializing;
        this.initializing = (async () => {
            this.releaseApp = await this.acquireLock(`app:${this.directory}`);
            try {
                const saved = await this.store.load();
                if (saved) {
                    this.password = saved.password; this.secrets.add(this.password);
                    this.values = normalize(saved.values);
                    validate(this.values, this.password); this.firstRun = false;
                }
            } catch {
                this.lastError = 'Saved configuration could not be loaded securely. Review the settings and save again.';
                this.event('error', this.lastError);
            }
            this.timer = setInterval(() => this.sample(), this.sampleMs); this.timer.unref?.();
            this.sample();
            if (!this.firstRun) await this.start();
            return this.getState();
        })();
        return this.initializing;
    }
    enqueue(action) {
        const result = this.operations.then(action, action);
        this.operations = result.catch(() => {});
        return result;
    }
    async saveSettings(input) {
        const saved = this.saves.then(async () => {
            if (this.closed) throw new Error('Application is closed');
            const values = input?.values || input;
            const candidate = values?.ICOM_PASSWORD;
            if (typeof candidate === 'string' && candidate) this.secrets.add(candidate);
            let result;
            try {
                result = validate(values, this.password, this.values);
                this.secrets.add(result.password); // Includes a newly imported password before backend calls.
                await this.store.save(result.values, result.password);
            } catch (error) {
                // Credential backends can echo the new secret. Keep the readable
                // error, but deliberately discard its original cause and stack.
                // eslint-disable-next-line preserve-caught-error
                throw new Error(this.redact(String(error?.message || 'Settings could not be saved.')));
            }
            this.values = result.values; this.password = result.password;
            this.firstRun = false; this.lastError = null;
            this.event('info', this.service ? 'Settings saved. Reconnect to apply changes.' : 'Settings saved.');
            this.sample(); return this.getState();
        });
        this.saves = saved.catch(() => {});
        return saved;
    }
    txActive() {
        const broker = this.service?.broker;
        return Boolean(broker && (broker.owner || broker.observedTx || broker.releasing || broker.pending?.policy?.tx
            || broker.queue?.some((item) => item.policy?.tx)));
    }
    start() {
        const revision = this.revision;
        return this.enqueue(() => this.startNow(revision));
    }
    async startNow(revision = this.revision) {
        await this.saves;
        if (this.closed || revision !== this.revision) return this.getState();
        if (this.service) return this.getState();
        let options, selected;
        try { selected = validate(this.values, this.password); options = selected.options; }
        catch (error) { this.lastError = error.message; this.sample(); throw error; }
        this.lastError = null; this.connecting = true; this.sample();
        try {
            this.releaseRadio = await this.acquireLock(`radio:${options.radio.host}:${options.radio.controlPort}`);
            if (this.closed || revision !== this.revision) { await this.releaseRadio(); this.releaseRadio = null; return this.getState(); }
            const service = this.service = this.createSplitter(options);
            this.activeValues = { ...selected.values }; this.activePassword = selected.password;
            service.on('status', ({ state }) => {
                const messages = { connecting: 'Connecting to radio.', authenticating: 'Authenticating with radio.', negotiating: 'Negotiating radio connection.', 'opening-streams': 'Opening radio streams.', connected: 'Radio transport connected.', disconnected: 'Radio connection lost; waiting for recovery.' };
                if (messages[state]) this.event('info', messages[state]);
                this.sample();
            });
            service.on('ready', () => { this.event('info', 'Radio ready. Clients can connect.'); this.sample(); });
            service.on('diagnostic', () => { this.event('warning', 'A radio operation required recovery. Inspect connection health.'); });
            service.on('fault', () => {
                this.lastError = 'A local network listener failed. Stop and review the network settings.';
                this.event('error', this.lastError); this.sample();
                void this.stop({ confirmedTx: true });
            });
            await service.start();
            if (revision !== this.revision) return this.getState();
            this.event('info', 'Splitter started.');
        } catch (error) {
            if (revision === this.revision) {
                this.lastError = error.message.startsWith('Another local splitter') ? error.message
                    : 'Could not connect. Check the radio address, credentials and local network availability.';
                this.event('error', this.lastError);
            }
            if (this.service) {
                await this.service.close().catch(() => {});
                const raw = statusSnapshot(this.service);
                this.totals.cache = combineCache(this.totals.cache, raw.cache);
                this.totals.metrics = combineMetrics(this.totals.metrics, raw.metrics);
            }
            this.service = null; this.activeValues = null; this.activePassword = null;
            await this.releaseRadio?.(); this.releaseRadio = null;
        } finally { this.connecting = false; this.sample(); }
        return this.getState();
    }
    // Gate and fence synchronously, before an await can allow another native
    // packet to turn an RX close into an unconfirmed TX interruption.
    beginStop(confirmedTx) {
        const service = this.service;
        if (service && this.stopRequest?.service === service) { ++this.revision; return this.stopRequest; }
        const activeTx = this.txActive();
        if (activeTx && !confirmedTx) return { requiresConfirmation: true, action: 'stop' };
        ++this.revision;
        if (!service) return { service: null, closing: Promise.resolve(), activeTx: false };
        service.broker.ready = false;
        const generation = service.broker.generation;
        let closing;
        if (activeTx && service.session.connected) {
            closing = (async () => {
                await service.broker.release();
                const confirmed = generation === service.broker.generation && service.session.connected
                    && !service.broker.owner && !service.broker.observedTx && !service.broker.releasing;
                await service.close(); return confirmed;
            })();
        } else closing = service.close().then(() => !activeTx);
        this.stopRequest = { service, closing, activeTx };
        return this.stopRequest;
    }
    stop(options = {}) {
        const request = this.beginStop(Boolean(options.confirmedTx));
        if (request.requiresConfirmation) return Promise.resolve(request);
        return this.enqueue(() => this.finishStop(request));
    }
    async finishStop(request) {
        let releaseConfirmed;
        try { releaseConfirmed = await request.closing; }
        catch { releaseConfirmed = false; }
        if (request.service && this.service === request.service) {
            const raw = statusSnapshot(request.service);
            this.totals.cache = combineCache(this.totals.cache, raw.cache);
            this.totals.metrics = combineMetrics(this.totals.metrics, raw.metrics);
            this.service = null; this.activeValues = null; this.activePassword = null;
            await this.releaseRadio?.(); this.releaseRadio = null;
        }
        if (this.stopRequest === request) this.stopRequest = null;
        this.connecting = false;
        if (request.activeTx && !releaseConfirmed) {
            this.lastError = 'Radio receive state could not be confirmed before stopping. Check the radio directly.';
            this.event('warning', this.lastError);
        } else this.event('info', 'Splitter stopped.');
        this.sample();
        return request.activeTx && !releaseConfirmed ? { releaseConfirmed: false, state: this.getState() } : this.getState();
    }
    reconnect(options = {}) {
        const request = this.beginStop(Boolean(options.confirmedTx));
        if (request.requiresConfirmation) return Promise.resolve({ ...request, action: 'reconnect' });
        const revision = this.revision;
        return this.enqueue(async () => {
            const result = await this.finishStop(request);
            if (result.releaseConfirmed === false) return result;
            return this.startNow(revision);
        });
    }
    close(options = {}) {
        if (this.closed) return this.closing || Promise.resolve(this.getState());
        const request = this.beginStop(Boolean(options.confirmedTx));
        if (request.requiresConfirmation) return Promise.resolve({ ...request, action: 'close' });
        this.closed = true;
        this.closing = this.enqueue(async () => {
            const result = await this.finishStop(request);
            clearInterval(this.timer);
            await this.saves;
            await this.releaseApp?.(); this.releaseApp = null;
            return result;
        });
        return this.closing;
    }
    rawState() {
        const raw = this.service ? statusSnapshot(this.service) : {
            radio: { state: 'stopped', connected: false }, broker: { ready: false, queueDepth: 0, pending: false, txOwned: false },
            nativeClients: { active: 0, authenticated: 0, preAuth: 0, granted: 0, civReady: 0, audioReady: 0 }, connectedUpstreamSessions: 0,
            admission: { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 }, cache: null, metrics: null,
        };
        raw.cache = combineCache(this.totals.cache, raw.cache); raw.metrics = combineMetrics(this.totals.metrics, raw.metrics);
        return raw;
    }
    clientRows() {
        const owner = this.service?.broker.owner;
        return [...(this.service?.server.clients.values() || [])].filter((client) => client.active).map((client) => {
            const streams = Object.fromEntries(Object.entries(client.streams || {}).map(([role, peer]) => [role, {
                ready: Boolean(peer.ready), lastActivityMs: Math.max(0, peer.now() - peer.lastRx), counters: { ...peer.counters },
                ping: peer.pingSnapshot?.() || null,
            }]));
            const first = client.streams?.control;
            return { id: clean(client.id), name: clean(client.name || 'Native client'), address: clean(client.address),
                connectedMs: first ? Math.max(0, first.now() - first.startedAt) : null,
                authenticated: Boolean(client.authenticated), civReady: Boolean(client.serialOpen && client.streams?.civ?.ready),
                audioReady: Boolean(client.rxEnable && client.streams?.audio?.ready), txOwner: client === owner, streams };
        });
    }
    sample() {
        const time = this.now(), raw = this.rawState();
        const point = { time, requests: raw.cache.requests, hits: raw.cache.hits, physical: raw.metrics?.physicalTotal || 0,
            timings: raw.metrics?.timings || {} };
        // Lifecycle/status events may burst within a millisecond. Publish their
        // fresh state immediately, but retain a stable interval baseline so
        // those events neither erase counter deltas nor invent burst rates.
        if (this.previous && time - this.previous.time >= this.sampleMs) {
            const seconds = (time - this.previous.time) / 1000;
            this.rates = { requestsPerSecond: Math.max(0, point.requests - this.previous.requests) / seconds,
                radioPerSecond: Math.max(0, point.physical - this.previous.physical) / seconds,
                hitsPerSecond: Math.max(0, point.hits - this.previous.hits) / seconds };
            for (const [key, name] of [['responseMs', 'radioRtt'], ['queueMs', 'queueWait']]) {
                const current = point.timings[name], previous = this.previous.timings[name];
                const count = (current?.count || 0) - (previous?.count || 0);
                if (count > 0) {
                    this.latency[key] = Math.max(0, current.sumMs - (previous?.sumMs || 0)) / count;
                    this[`${key}Updated`] = time;
                } else if (!this.service || time - (this[`${key}Updated`] || 0) > 10000) this.latency[key] = null;
            }
            this.previous = point;
        } else if (!this.previous) this.previous = point;
        const stream = this.service?.session.control;
        const ping = stream?.pingSnapshot?.();
        this.latency.pingMs = ping && !ping.stale ? ping.lastMs : null;
        this.latency.pingStale = !ping || ping.stale;
        this.latency.pingUpdatedAt = ping?.measuredAt === null || ping?.measuredAt === undefined ? null
            : time - Math.max(0, stream.now() - ping.measuredAt);
        if (this.service && (!this.history.length || time - this.history.at(-1).time >= this.sampleMs)) {
            this.history.push({ time, ...this.rates, hitPercent: raw.cache.requests ? raw.cache.hits / raw.cache.requests * 100 : 0,
                pingMs: this.latency.pingMs, responseMs: this.latency.responseMs, queueMs: this.latency.queueMs });
        }
        this.history = this.history.filter((item) => time - item.time < 900000).slice(-900);
        this.emit('snapshot', this.getState());
    }
    getState() {
        const status = this.rawState();
        const state = { firstRun: this.firstRun, running: Boolean(this.service), connecting: this.connecting,
            pendingChanges: this.pendingChanges(), lastError: this.lastError, txActive: this.txActive(),
            status, clients: this.clientRows(), history: this.history, events: this.events, rates: this.rates, latency: this.latency,
            settings: this.getSettings(),
            activeSettings: this.activeValues ? { values: { ...this.activeValues, ICOM_PASSWORD: '', ICOM_PASSWORD_FILE: '' } } : null,
            uptimeMs: this.now() - this.createdAt,
            dashboard: { connection: status.radio.state, rxTx: status.radio.connected && status.broker.ready
                ? this.service.broker.observedTx ? 'TX' : 'RX' : 'Unavailable',
                txControl: this.txActive() ? 'Owned or pending' : 'Available',
                clientCount: status.nativeClients.authenticated, hitPercent: status.cache.requests ? status.cache.hits / status.cache.requests * 100 : 0,
                ...this.rates, ...this.latency },
        };
        return this.redact(state);
    }
    diagnosticReport() {
        const state = this.getState();
        const values = { ...state.settings.values }; delete values.ICOM_PASSWORD; delete values.ICOM_PASSWORD_FILE; delete values.ICOM_USERNAME;
        return this.redact({ format: 1, generatedAt: new Date(this.now()).toISOString(), platform: process.platform, architecture: process.arch,
            connection: state.status, settings: values, pendingChanges: state.pendingChanges,
            clients: state.clients.map(({ authenticated, civReady, audioReady, txOwner, connectedMs, streams }) => ({ authenticated, civReady, audioReady, txOwner, connectedMs, streams })),
            events: state.events, latency: state.latency, rates: state.rates,
            notes: ['Statistics cover this application session; graphs retain at most 15 minutes.', 'Ping is native LAN round-trip time; response and queue delays are separate gateway measurements.', 'Audio transport counters do not measure audible playback quality.'] });
    }
}
module.exports = { AppController };
