'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { runWeb, webOptions } = require('../src/web/main');
const { ensureTls } = require('../src/web/tls');
const { loadAssets, adaptIndex, SEA_FILES } = require('../src/web/assets');
const { AppController } = require('../src/app/controller');
const { SettingsStore, atomicWrite } = require('../src/app/store');
const { defaults } = require('../src/app/settings');
const valid = { ICOM_RADIO_HOST: '192.0.2.25', ICOM_BIND_ADDRESS: '192.0.2.82', ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'testpass',
    ICOM_CACHE_METERS_MS: '125', ICOM_CACHE_QUERY_1502_MS: '200' };
async function directory(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-web-main-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
function harness(directory, { held = false } = {}) {
    const steps = [], services = []; let lastServer;
    class Service extends EventEmitter {
        constructor(options) {
            super(); this.options = options;
            this.session = { connected: false, state: 'disconnected' }; this.server = { clients: new Map(), stats: {} };
            this.broker = { ready: false, queue: [], generation: 1, cacheSnapshot: () => ({ requests: 0, hits: 0, misses: 0, byQuery: {} }), metricsSnapshot: () => null };
        }
        async start() {
            steps.push('radio-start');
            if (held) return new Promise((_resolve, reject) => { this.reject = reject; });
            this.session.connected = true; this.session.state = 'connected'; this.broker.ready = true;
        }
        async close() { steps.push('radio-close'); this.reject?.(new Error('Cancelled')); this.session.connected = false; this.broker.ready = false; }
    }
    return { steps, services, server: () => lastServer,
        options: { platform: 'linux', env: { ICOM_CONFIG_DIR: directory, ...valid }, installSignals: false,
            createController: (options) => new AppController({ ...options, lock: async () => async () => {}, createSplitter: (config) => { const s = new Service(config); services.push(s); return s; } }),
            createServer: (options) => { lastServer = { options, start: async () => { steps.push('https-start'); }, address: () => ({ address: options.host, port: options.port }), close: async () => { steps.push('https-close'); } }; return lastServer; },
            tlsFactory: async () => ({ cert: 'fixture-cert', key: 'fixture-key', selfSigned: true, generated: false }), assetLoader: () => ({}) },
    };
}

test('web mode imports valid legacy environment once, preserves password-file and query settings, then starts HTTPS first', async (t) => {
    const dir = await directory(t); const h = harness(dir);
    const file = path.join(dir, 'import-password'); await atomicWrite(file, 'testpass\n');
    h.options.env = { ...h.options.env, ICOM_PASSWORD: undefined, ICOM_PASSWORD_FILE: file, UNKNOWN_SECRET: 'do-not-save' };
    const host = await runWeb(h.options); t.after(() => host.close()); await host.startPromise;
    assert.equal(host.bootstrap.imported, true); assert.deepEqual(h.steps.slice(0, 2), ['https-start', 'radio-start']);
    assert.equal(h.services[0].options.broker.cacheMetersMs, 125); assert.equal(h.services[0].options.broker.cacheQueryTtls['1502'], 200);
    assert.equal(h.services[0].options.radio.password, 'testpass');
    const stored = await new SettingsStore(dir).load(); assert.equal(stored.values.ICOM_PASSWORD_FILE, undefined);
    const json = await fs.readFile(path.join(dir, 'settings.json'), 'utf8'); assert.equal(json.includes('testpass'), false); assert.equal(json.includes('do-not-save'), false);
    assert.deepEqual(h.server().options.getCredentials(), { username: 'fixture', password: 'testpass', setupRequired: false });
    assert.equal(host.address().port, 50004);
});

test('persisted configuration wins over old environment during restart', async (t) => {
    const dir = await directory(t); await new SettingsStore(dir).save({ ...defaults(), ...valid, ICOM_PASSWORD: '', ICOM_RADIO_HOST: '192.0.2.99', ICOM_CACHE_QUERY_1502_MS: '350' }, 'savedpass');
    const h = harness(dir), host = await runWeb(h.options); t.after(() => host.close()); await host.startPromise;
    assert.equal(host.bootstrap.imported, false); assert.equal(h.services[0].options.radio.host, '192.0.2.99');
    assert.equal(h.services[0].options.radio.password, 'savedpass'); assert.equal(h.services[0].options.broker.cacheQueryTtls['1502'], 350);
});

test('an unreachable radio does not block HTTPS startup or correcting saved settings', async (t) => {
    const dir = await directory(t), h = harness(dir, { held: true });
    const host = await Promise.race([runWeb(h.options), new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Web startup blocked on radio')), 2000); timer.unref(); })]);
    t.after(() => host.close());
    assert.equal(h.steps[0], 'https-start');
    await host.controller.saveSettings({ ICOM_RADIO_HOST: '192.0.2.26' });
    assert.equal(host.controller.getSettings().values.ICOM_RADIO_HOST, '192.0.2.26');
    await host.close(); await host.startPromise;
    assert.ok(h.steps.includes('https-close'));
});

test('invalid first configuration uses a private reusable setup token and switches to real credentials after save', async (t) => {
    const dir = await directory(t), h = harness(dir); h.options.env = { ICOM_CONFIG_DIR: dir, ICOM_RADIO_HOST: 'invalid', UNKNOWN_SECRET: 'do-not-save' };
    const host = await runWeb(h.options); t.after(() => host.close());
    assert.equal(host.setupRequired, true); assert.equal(host.controller.getState().firstRun, true); assert.equal(h.services.length, 0);
    const credentials = h.server().options.getCredentials(); assert.equal(credentials.username, 'setup'); assert.equal(credentials.setupRequired, true); assert.match(credentials.password, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(host.setupTokenFile)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(host.controller.getState()).includes(credentials.password), false);
    await host.close();
    const reopened = await runWeb(h.options); t.after(() => reopened.close());
    assert.equal(h.server().options.getCredentials().password, credentials.password, 'setup token must survive service restart');
    await reopened.controller.saveSettings(valid);
    assert.deepEqual(h.server().options.getCredentials(), { username: 'fixture', password: 'testpass', setupRequired: false });
});

test('management port and host validation handles derived limits and Linux-only mode', async (t) => {
    assert.deepEqual(webOptions({}, {}), { host: '0.0.0.0', port: 50004 });
    assert.equal(webOptions({ ICOM_WEB_PORT: '9443', ICOM_WEB_BIND_ADDRESS: '127.0.0.1' }).port, 9443);
    for (const value of ['', 'bad', '-1', '65536', '1.2']) assert.throws(() => webOptions({ ICOM_WEB_PORT: value }));
    assert.throws(() => webOptions({}, { ICOM_LISTEN_AUDIO_PORT: '65535' })); assert.throws(() => webOptions({ ICOM_WEB_BIND_ADDRESS: 'bad' }));
    const dir = await directory(t), h = harness(dir); await assert.rejects(runWeb({ ...h.options, platform: 'darwin' }), /Linux only/);
});

test('assets load from source or embedded SEA without exporting arbitrary filesystem paths', () => {
    const source = loadAssets(); assert.ok(source['/'].body.includes('src="bridge.js"')); assert.ok(source['/'].body.includes("connect-src 'self'"));
    assert.equal(source['/'].body.includes("connect-src 'none'"), false); assert.equal(source['/missing'], undefined);
    const sea = { isSea: () => true, getAsset: (key) => key === 'web/index.html' ? Buffer.from('<script defer src="renderer.js"></script>') : Buffer.from(key) };
    const embedded = loadAssets({ sea }); assert.equal(Object.keys(SEA_FILES).length, 7); assert.equal(embedded['/renderer.js'].body.toString(), 'web/renderer.js');
    assert.throws(() => adaptIndex('unexpected template'), /could not be prepared/);
});

let hasOpenSsl = process.platform !== 'win32';
if (hasOpenSsl) try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenSsl = false; }
test('automatic TLS is owner-only, reused, renewed near expiry and repaired after interrupted rotation', { skip: !hasOpenSsl }, async (t) => {
    const dir = await directory(t), first = await ensureTls({ directory: dir, host: '127.0.0.1', env: {} });
    assert.equal(first.generated, true); assert.equal(first.selfSigned, true); assert.equal((await fs.stat(first.keyFile)).mode & 0o777, 0o600); assert.equal((await fs.stat(first.certificateFile)).mode & 0o777, 0o600);
    const reused = await ensureTls({ directory: dir, host: '127.0.0.1', env: {} }); assert.equal(reused.generated, false); assert.equal(reused.fingerprint256, first.fingerprint256);
    const nearExpiry = Date.parse(first.expiresAt) - 86400000;
    const renewed = await ensureTls({ directory: dir, host: '127.0.0.1', env: {}, now: () => nearExpiry }); assert.equal(renewed.generated, true);
    await atomicWrite(first.certificateFile, 'interrupted automatic rotation');
    const repaired = await ensureTls({ directory: dir, host: '127.0.0.1', env: {} }); assert.equal(repaired.generated, true);
    await fs.chmod(first.keyFile, 0o644); await assert.rejects(ensureTls({ directory: dir, env: {} }), /permissions/);
});

test('custom HTTPS requires a valid certificate/key pair and never falls back to HTTP', { skip: !hasOpenSsl }, async (t) => {
    const dir = await directory(t), generated = await ensureTls({ directory: dir, host: '127.0.0.1', env: {} });
    await assert.rejects(ensureTls({ directory: dir, env: { ICOM_WEB_TLS_CERT: generated.certificateFile } }), /both/);
    const custom = await ensureTls({ directory: dir, env: { ICOM_WEB_TLS_CERT: generated.certificateFile, ICOM_WEB_TLS_KEY: generated.keyFile } }); assert.equal(custom.selfSigned, false); assert.equal(custom.generated, false);
    const other = await directory(t), second = await ensureTls({ directory: other, env: {} });
    await assert.rejects(ensureTls({ directory: dir, env: { ICOM_WEB_TLS_CERT: generated.certificateFile, ICOM_WEB_TLS_KEY: second.keyFile } }), /could not be validated/);
});

test('actual HTTPS serves the adapted interface and management listener closure does not own the radio lifecycle', { skip: !hasOpenSsl }, async (t) => {
    const https = require('node:https');
    const { createWebServer } = require('../src/web/server');
    const dir = await directory(t), h = harness(dir);
    const host = await runWeb({ ...h.options, env: { ...h.options.env, ICOM_WEB_BIND_ADDRESS: '127.0.0.1' },
        tlsFactory: ensureTls, assetLoader: loadAssets, createServer: (options) => createWebServer({ ...options, port: 0 }) });
    t.after(() => host.close()); await host.startPromise;
    const port = host.address().port, origin = `https://127.0.0.1:${port}`;
    const request = (pathname, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port, path: pathname, method, rejectUnauthorized: false,
            headers: { ...headers, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) } }, (res) => {
            const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
    const page = await request('/'); assert.equal(page.status, 200); assert.match(page.text, /src="bridge.js"/); assert.match(page.text, /connect-src 'self'/);
    const session = await request('/api/session'); assert.equal(JSON.parse(session.text).value.authenticated, false);
    const login = await request('/api/login', { method: 'POST', body: { username: 'fixture', password: 'testpass' } }); assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0], csrf = JSON.parse(login.text).value.csrfToken;
    const state = await request('/api/request', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: { action: 'state' } });
    assert.equal(state.status, 200); assert.equal(JSON.parse(state.text).value.running, true);
    const closing = await request('/api/request', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: { action: 'close' } });
    assert.notEqual(closing.status, 200, 'browser close is not a service action'); assert.equal(host.controller.getState().running, true);
    await host.server.close(); assert.equal(host.controller.getState().running, true, 'closing management listener must not stop the splitter');
});

test('explicit web config directory takes precedence over the service environment directory', async (t) => {
    const parent = await directory(t), selected = path.join(parent, 'selected'), h = harness(path.join(parent, 'environment'));
    const host = await runWeb({ ...h.options, directory: selected }); t.after(() => host.close());
    await host.startPromise;
    assert.equal(host.directory, selected);
    assert.equal((await new SettingsStore(selected).load()).values.ICOM_RADIO_HOST, valid.ICOM_RADIO_HOST);
    await assert.rejects(fs.access(path.join(parent, 'environment', 'settings.json')));
});

test('desktop CLI rejects Linux-only web mode before reading configuration', { skip: process.platform === 'linux' }, () => {
    assert.throws(() => execFileSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'), '--web'], { stdio: 'pipe' }),
        (error) => error.status === 1 && /only on Linux/.test(error.stderr.toString()));
});
