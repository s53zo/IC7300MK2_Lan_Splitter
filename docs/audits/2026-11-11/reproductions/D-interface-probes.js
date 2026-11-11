'use strict';
// Audit-only, isolated probes. Uses synthetic documentation-range addresses,
// throwaway files and a fixture subprocess; never opens a radio association.
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../..');
const { AppController } = require(path.join(root, 'src/app/controller'));
const { TerminalApp } = require(path.join(root, 'src/app/tui'));
const { SettingsStore, FileCredentialStore } = require(path.join(root, 'src/app/store'));
const { defaults } = require(path.join(root, 'src/app/settings'));
const { BrokerMetrics } = require(path.join(root, 'src/metrics'));
const valid = () => ({ ...defaults(), ICOM_RADIO_HOST: '192.0.2.20', ICOM_USERNAME: 'before-user', ICOM_PASSWORD: 'beforepass' });

class FixtureService extends EventEmitter {
    constructor(fail) {
        super(); this.fail = fail;
        this.session = { connected: false, state: 'stopped' };
        this.server = { clients: new Map(), stats: { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 } };
        this.cache = { enabled: true, requests: 0, hits: 0, misses: 0, coalesced: 0, invalidations: 0, entries: 0, byQuery: {}, ttlMs: {} };
        this.metrics = new BrokerMetrics(() => 0);
        this.broker = { ready: false, queue: [], generation: 0, owner: null, observedTx: false,
            cacheSnapshot: () => structuredClone(this.cache), metricsSnapshot: () => this.metrics.snapshot(),
            release: async () => true };
    }
    async start() {
        if (this.fail) throw new Error('Fixture startup failure');
        this.session.connected = true; this.session.state = 'connected'; this.broker.ready = true;
    }
    async close() { this.session.connected = false; this.session.state = 'stopped'; this.broker.ready = false; }
}

async function controllerProbe(directory) {
    let fail = true;
    const services = [];
    const controller = new AppController({ directory, lock: async () => async () => {},
        createSplitter: () => { const service = new FixtureService(fail); services.push(service); return service; } });
    try {
        await controller.initialize({ autoStart: false }); await controller.saveSettings(valid());
        const tui = new TerminalApp({ controller });
        await tui.performAction('start', false);
        assert.equal(tui.state.running, false); assert.ok(tui.state.lastError); assert.equal(tui.message, 'Started.');
        console.log('D-01: failed Start => running=false, lastError set, TUI message="Started."');
        fail = false; await controller.start();
        services.at(-1).server.stats = { preAuthExpired: 4, preAuthEvictions: 3, resourceRejects: 2 };
        services.at(-1).cache.requests = 9;
        assert.equal(controller.getState().status.admission.resourceRejects, 2);
        await controller.reconnect();
        assert.equal(controller.getState().status.cache.requests, 9);
        assert.deepEqual(controller.getState().status.admission, { preAuthExpired: 0, preAuthEvictions: 0, resourceRejects: 0 });
        console.log('D-02: Reconnect retains 9 cache requests, discards admission totals 4/3/2 => 0/0/0');
        fail = true; await tui.performAction('reconnect', false);
        assert.equal(tui.state.running, false); assert.ok(tui.state.lastError); assert.equal(tui.message, 'Reconnected.');
        console.log('D-01: failed Reconnect => running=false, lastError set, TUI message="Reconnected."');
    } finally { await controller.close({ confirmedTx: true }); }
}

async function crashChild(directory) {
    const fileStore = new FileCredentialStore(directory);
    const credentials = { read: () => fileStore.read(), write: async (password) => {
        await fileStore.write(password); process.stdout.write('fixture-credential-written\n');
        await new Promise(() => { setInterval(() => {}, 1000); });
    } };
    await new SettingsStore(directory, credentials).save({ ...valid(), ICOM_USERNAME: 'after-user', ICOM_PASSWORD: '' }, 'afterpass');
}

async function interruptedSaveProbe(directory) {
    const initial = new SettingsStore(directory);
    await initial.save(valid(), 'beforepass');
    const child = spawn(process.execPath, [__filename, '--crash-child', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = ''; child.stderr.on('data', (data) => { childError += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    const ended = once(child, 'exit');
    await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (data) => { output += data; if (output.includes('fixture-credential-written')) resolve(); });
        child.once('exit', () => reject(new Error('Fixture child exited before latch: ' + childError)));
    });
    child.kill('SIGKILL'); await ended; clearTimeout(timeout);
    const loaded = await initial.load();
    assert.equal(loaded.values.ICOM_USERNAME, 'before-user'); assert.equal(loaded.password, 'afterpass');
    console.log('D-R1: fixture process killed after credential write => old username + new password persist');
}

async function restoredPageProbe() {
    const source = await fs.readFile(path.join(root, 'src/web/bridge.js'), 'utf8');
    const listeners = {}; let stateRequests = 0, interval;
    const response = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
    vm.runInNewContext(source, { window,
        document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null },
        location: { replace() {}, origin: 'https://fixture.invalid' },
        fetch: async (url) => url === '/api/session' ? response({ authenticated: true, csrf: 'fixture-csrf' })
            : (stateRequests++, response({ running: true })),
        setInterval: (callback) => { interval = callback; return 1; }, clearInterval() {}, setTimeout() {},
        MutationObserver: class { observe() {} }, URL, Blob });
    window.splitter.subscribe(() => {}); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stateRequests, 1);
    listeners.pagehide({ persisted: true });
    listeners.pageshow?.({ persisted: true });
    await interval(); const result = await window.splitter.request('state');
    assert.equal(stateRequests, 1); assert.equal(result.ok, false);
    console.log('D-R2: simulated BFCache pagehide/pageshow => no resumed polling; requests demand sign-in');
}

async function main() {
    if (process.argv[2] === '--crash-child') { await crashChild(process.argv[3]); return; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-audit-D-'));
    try {
        await controllerProbe(path.join(directory, 'controller'));
        await interruptedSaveProbe(path.join(directory, 'interrupted-save'));
        await restoredPageProbe();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
