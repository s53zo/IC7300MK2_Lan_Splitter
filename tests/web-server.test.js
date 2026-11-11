'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWebServer } = require('../src/web/server');
const { FIELDS, defaults } = require('../src/app/settings');
const dgram = require('node:dgram');
const { AppController } = require('../src/app/controller');
const { IcomPeer } = require('./fixtures/icom-radio');
const { client, frame, until } = require('./fixtures/harness');
class Controller {
    constructor() { this.values = { ...defaults(), ICOM_USERNAME: 'fixture' }; this.password = 'testpass'; this.closed = 0; this.saves = 0; this.running = true; this.tx = false; this.directory = '/private/config'; }
    getState() { return { running: this.running, txActive: this.tx, status: { connectedUpstreamSessions: 1, nativeClients: { authenticated: 2 } }, settings: this.getSettings() }; }
    getSettings() { return { values: { ...this.values, ICOM_PASSWORD: '' }, hasPassword: true }; }
    getFields() { return FIELDS; }
    getNetworkInterfaces() { return [{ name: 'loopback', address: '127.0.0.1' }]; }
    async saveSettings(input) { const values = input.values || input; this.saves++; if (values.ICOM_PASSWORD) this.password = values.ICOM_PASSWORD; this.values = { ...this.values, ...values, ICOM_PASSWORD: '' }; return this.getState(); }
    async start() { this.running = true; return this.getState(); }
    async stop(options) { if (this.tx && !options.confirmedTx) return { requiresConfirmation: true }; this.tx = false; this.running = false; return this.getState(); }
    async reconnect(options) { const result = await this.stop(options); if (result.requiresConfirmation) return result; return this.start(); }
    close() { this.closed++; }
    diagnosticReport() { return { connection: 'ready', password: this.password }; }
    redact(value) { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.split(this.password).join('[redacted]') : item)); }
}
async function setup(t, options = {}) {
    const controller = options.controller || new Controller();
    const server = createWebServer({ controller, host: '127.0.0.1', port: 0, allowInsecureLoopback: true,
        assets: { '/index.html': { body: '<h1>Local management</h1>', contentType: 'text/html' }, '/styles.css': { body: 'body{}', contentType: 'text/css' } }, ...options });
    await server.start(); t.after(() => server.close()); return { server, controller };
}
function request(server, pathname, { method = 'GET', body, raw, headers = {}, origin = true, cookie, csrf, contentLength = true } = {}) {
    const address = server.address(), host = `127.0.0.1:${address.port}`, protocol = server.secure ? https : http;
    const data = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const allHeaders = { Host: host, ...(method === 'POST' && origin ? { Origin: `${server.secure ? 'https' : 'http'}://${host}` } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', ...(contentLength ? { 'Content-Length': Buffer.byteLength(data) } : {}) }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers };
    return new Promise((resolve, reject) => {
        const call = protocol.request({ host: '127.0.0.1', port: address.port, path: pathname, method, headers: allHeaders, rejectUnauthorized: false }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8'); let json;
                try { json = JSON.parse(text); } catch { json = null; }
                resolve({ status: response.statusCode, headers: response.headers, text, json });
            });
        });
        call.on('error', reject); if (data !== undefined) call.write(data); call.end();
    });
}
async function login(server, credentials = { username: 'fixture', password: 'testpass' }) {
    const reply = await request(server, '/api/login', { method: 'POST', body: credentials });
    assert.equal(reply.status, 200, reply.text);
    return { cookie: reply.headers['set-cookie'][0].split(';')[0], csrf: reply.json.value.csrfToken, reply };
}
const api = (server, auth, action, payload) => request(server, '/api/request', { method: 'POST', body: { action, ...(payload === undefined ? {} : { payload }) }, ...auth });

test('management requires TLS except explicit loopback tests and protects every controller action', async (t) => {
    assert.throws(() => createWebServer({ controller: new Controller(), host: '0.0.0.0', allowInsecureLoopback: true }), /HTTPS/);
    assert.throws(() => createWebServer({ controller: new Controller(), host: '127.0.0.1' }), /HTTPS/);
    const { server, controller } = await setup(t);
    const session = await request(server, '/api/session'); assert.deepEqual(session.json.value, { authenticated: false, setupRequired: false });
    for (const action of ['state', 'settings', 'fields', 'save', 'stop', 'export']) assert.equal((await api(server, {}, action)).status, 403);
    const bad = await request(server, '/api/login', { method: 'POST', body: { username: 'fixture', password: 'wrongpass' } }); assert.equal(bad.status, 403);
    const auth = await login(server);
    const cookie = auth.reply.headers['set-cookie'][0];
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
    assert.match(auth.csrf, /^[a-f0-9]{64}$/);
    const state = await api(server, auth, 'state'); assert.equal(state.status, 200); assert.equal(state.json.value.status.connectedUpstreamSessions, 1);
    assert.equal((await request(server, '/api/session', auth)).json.value.authenticated, true);
    const report = await api(server, auth, 'export'); assert.equal(report.text.includes('testpass'), false);
    assert.equal((await api(server, auth, 'close')).status, 400); assert.equal(controller.closed, 0);
    await server.close(); assert.equal(controller.closed, 0, 'closing HTTP must leave the radio controller alive'); assert.equal(controller.running, true);
});

test('mutations require same origin, JSON content type, host and port and session CSRF', async (t) => {
    const { server } = await setup(t); const auth = await login(server); const port = server.address().port;
    for (const options of [
        { origin: false }, { headers: { Origin: 'null' } }, { headers: { Origin: 'https://evil.example' } },
        { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { csrf: 'bad' },
        { headers: { Host: `evil.example:${port}` } }, { headers: { Host: '127.0.0.1:1' } },
    ]) assert.equal((await api(server, { ...auth, ...options }, 'stop')).status, 403);
    assert.equal((await request(server, '/api/login', { method: 'POST', origin: false, body: { username: 'fixture', password: 'testpass' } })).status, 403);
    assert.equal((await request(server, '/api/request', { method: 'POST', body: { action: 'state' }, ...auth, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request(server, '/api/request', { method: 'POST', raw: '{bad', ...auth })).status, 400);
    assert.equal((await request(server, '/api/request', { method: 'POST', raw: '[]', ...auth })).status, 400);
    assert.equal((await request(server, '/api/request', { method: 'POST', raw: 'x'.repeat(32769), ...auth })).status, 413);
    assert.equal((await request(server, '/api/request', { method: 'POST', raw: 'x'.repeat(32769), contentLength: false, ...auth })).status, 413);
    assert.equal((await request(server, '/api/request', { method: 'OPTIONS', ...auth })).status, 405);
});

test('static routes are explicit, traversal is rejected and security headers prevent cross-origin access', async (t) => {
    const { server } = await setup(t);
    const page = await request(server, '/'); assert.equal(page.status, 200); assert.match(page.text, /Local management/);
    assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY'); assert.ok(page.headers['content-security-policy'].includes("frame-ancestors 'none'"));
    assert.equal(page.headers['content-security-policy'].includes('unsafe-inline'), false); assert.equal(page.headers['access-control-allow-origin'], undefined);
    for (const value of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%5cetc/passwd', '/%00', '/src/config.js', '/api/password-file', '/unknown']) {
        assert.equal((await request(server, value)).status, 404, value);
    }
});

test('web settings reject unknown fields and server file paths but retain pending saves and TX confirmations', async (t) => {
    const { server, controller } = await setup(t); const auth = await login(server);
    for (const payload of [{ ICOM_PASSWORD_FILE: '/etc/shadow' }, { ICOM_PASSWORD_FILE: 0 }, { ICOM_PASSWORD_FILE: false }, { values: { ICOM_PASSWORD_FILE: '/private/secret' } }, { arbitrary: 'value' },
        { values: {}, more: true }, { ICOM_RADIO_HOST: null }]) assert.equal((await api(server, auth, 'save', payload)).status, 400);
    assert.equal(controller.saves, 0);
    const saved = await api(server, auth, 'save', { ICOM_CACHE_QUERY_1502_MS: '200' }); assert.equal(saved.status, 200);
    assert.equal(controller.running, true, 'save does not reconnect');
    controller.tx = true; assert.equal((await api(server, auth, 'stop')).json.value.requiresConfirmation, true); assert.equal(controller.running, true);
    assert.equal((await api(server, auth, 'stop', { confirmedTx: true })).status, 200); assert.equal(controller.running, false);
    assert.equal((await api(server, auth, 'start')).status, 200); assert.equal(controller.running, true);
    assert.equal((await api(server, auth, 'stop', { confirmedTx: 'true' })).status, 400);
    assert.equal((await api(server, auth, 'settings')).json.value.interfaces[0].address, '127.0.0.1');
});

test('credential changes retain the acting session and revoke other sessions, and logout destroys its session', async (t) => {
    const { server } = await setup(t); const one = await login(server), two = await login(server);
    assert.equal((await api(server, one, 'save', { ICOM_PASSWORD: 'newpass1' })).status, 200);
    assert.equal((await api(server, one, 'state')).status, 200); assert.equal((await api(server, two, 'state')).status, 403);
    const loggedOut = await request(server, '/api/logout', { method: 'POST', body: {}, ...one }); assert.equal(loggedOut.status, 200);
    assert.ok(loggedOut.headers['set-cookie'][0].includes('Max-Age=0')); assert.equal((await api(server, one, 'state')).status, 403);
    assert.equal((await request(server, '/api/login', { method: 'POST', body: { username: 'fixture', password: 'testpass' } })).status, 403);
});

test('bootstrap uses the provided setup token and transitions safely to radio credentials', async (t) => {
    const controller = new Controller(); controller.values.ICOM_USERNAME = ''; controller.password = '';
    const { server } = await setup(t, { controller, getCredentials: () => controller.password ? { username: controller.values.ICOM_USERNAME, password: controller.password }
        : { username: 'setup', password: 'bootstrap-test-token', setupRequired: true } });
    assert.equal((await request(server, '/api/session')).json.value.setupRequired, true);
    const auth = await login(server, { username: 'setup', password: 'bootstrap-test-token' });
    assert.equal(auth.reply.text.includes('bootstrap-test-token'), false);
    assert.equal((await api(server, auth, 'save', { ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'testpass' })).status, 200);
    assert.equal((await request(server, '/api/session', auth)).json.value.setupRequired, false);
    assert.equal((await api(server, auth, 'state')).status, 200);
});

test('login throttling, idle expiry, absolute expiry and session limits stay bounded', async (t) => {
    let clock = 0; const { server } = await setup(t, { now: () => clock });
    for (let i = 0; i < 5; i++) assert.equal((await request(server, '/api/login', { method: 'POST', body: { username: 'fixture', password: 'wrongpass' } })).status, 403);
    assert.equal((await request(server, '/api/login', { method: 'POST', body: { username: 'fixture', password: 'testpass' } })).status, 429);
    clock += 60001; const expired = await login(server); clock += 30 * 60 * 1000;
    assert.equal((await request(server, '/api/session', expired)).json.value.authenticated, false);
    const absolute = await login(server); for (let i = 0; i < 49; i++) { clock += 29 * 60 * 1000; assert.equal((await request(server, '/api/session', absolute)).json.value.authenticated, true); }
    clock += 29 * 60 * 1000; assert.equal((await request(server, '/api/session', absolute)).json.value.authenticated, false);
    for (let i = 0; i < 16; i++) { clock += 60001; await login(server); }
    clock += 60001;
    assert.equal((await request(server, '/api/login', { method: 'POST', body: { username: 'fixture', password: 'testpass' } })).status, 429);
    assert.equal(server.sessions.size, 16); assert.ok(server.loginRates.size <= 128);
});

test('HTTPS serves the same protected API with a real TLS connection', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-web-tls-test-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' }); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('OpenSSL is unavailable on this runner'); return; } throw error; }
    const { server } = await setup(t, { tls: { key: await fs.readFile(key), cert: await fs.readFile(cert) }, allowInsecureLoopback: false });
    assert.equal(server.secure, true); const auth = await login(server); assert.equal((await api(server, auth, 'state')).status, 200);
});

test('a pending Start does not block corrected settings or Stop and repeated actions stay bounded', async (t) => {
    const { server, controller } = await setup(t); const auth = await login(server); let completeStart;
    controller.start = () => new Promise((resolve) => { completeStart = resolve; });
    const starting = api(server, auth, 'start');
    while (!completeStart) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await api(server, auth, 'start')).status, 429);
    const second = await login(server); assert.equal((await api(server, second, 'start')).status, 429, 'another session cannot fill the pending action queue');
    assert.equal((await api(server, auth, 'save', { ICOM_RADIO_HOST: '192.0.2.88' })).status, 200);
    assert.equal((await api(server, auth, 'stop')).status, 200); assert.equal(controller.running, false);
    completeStart(controller.getState()); assert.equal((await starting).status, 200);
});

async function availablePorts() {
    const sockets = [];
    try {
        for (let i = 0; i < 3; i++) { const socket = dgram.createSocket('udp4'); sockets.push(socket); await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)); }
        return sockets.map((socket) => socket.address().port);
    } finally { await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
}
test('web management shares one actual synthetic radio service with native clients and preserves pending settings and TX safety', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-web-native-'));
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    const controller = new AppController({ directory }); const peers = [];
    t.after(async () => { await Promise.allSettled(peers.map((peer) => peer.close())); await controller.close({ confirmedTx: true }); await radio.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await controller.initialize(); const upstream = radio.config(), [controlPort, civPort, audioPort] = await availablePorts();
    await controller.saveSettings({ ...defaults(), ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass', ICOM_BIND_ADDRESS: '127.0.0.1',
        ICOM_RADIO_CONTROL_PORT: upstream.controlPort, ICOM_RADIO_CIV_PORT: upstream.civPort, ICOM_RADIO_AUDIO_PORT: upstream.audioPort,
        ICOM_LISTEN_CONTROL_PORT: controlPort, ICOM_LISTEN_CIV_PORT: civPort, ICOM_LISTEN_AUDIO_PORT: audioPort });
    await controller.start(); const { server } = await setup(t, { controller }); const auth = await login(server, { username: 'beer', password: 'testpass' });
    const address = { host: '127.0.0.1', controlPort, civPort, audioPort };
    assert.equal(controller.getState().status.broker.ready, true, 'synthetic radio must be ready before client handshakes');
    // Parallel TLS/native tests can delay Windows CI beyond the fixture's 2s
    // default. Keep protocol assertions intact with a bounded handshake budget.
    peers.push(await client(address, { password: 'testpass', timeoutMs: 5000 })); peers.push(await client(address, { password: 'testpass', timeoutMs: 5000 }));
    peers[0].sendCiv(frame(0x15, [2], 0xe1)); peers[1].sendCiv(frame(0x15, [2], 0xe2));
    await until(() => peers.every((peer) => peer.receivedCiv.some((f) => f[4] === 0x15)), 'private radio replies');
    assert.equal(peers[0].receivedCiv.find((f) => f[4] === 0x15)[2], 0xe1); assert.equal(peers[1].receivedCiv.find((f) => f[4] === 0x15)[2], 0xe2);
    const pcm = Buffer.alloc(1364, 0x31); radio.rxAudio(pcm); radio.scope();
    await until(() => peers.every((peer) => peer.receivedAudio.length && peer.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0)), 'shared native media');
    assert.deepEqual(peers[0].receivedAudio[0], pcm); assert.deepEqual(peers[1].receivedAudio[0], pcm);
    const snapshot = (await api(server, auth, 'state')).json.value;
    assert.equal(snapshot.status.nativeClients.authenticated, 2); assert.equal(snapshot.status.connectedUpstreamSessions, 1);
    assert.equal(snapshot.status.cache.requests, 2); assert.equal(snapshot.status.cache.hits, 1);
    assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
    const saved = (await api(server, auth, 'save', { ICOM_CACHE_QUERY_1502_MS: '300' })).json.value;
    assert.equal(saved.pendingChanges, true); assert.equal(saved.status.cache.querySettings.find((entry) => entry.key === '1502').effectiveMs, 100);
    const reconnected = (await api(server, auth, 'reconnect')).json.value;
    assert.equal(reconnected.pendingChanges, false); assert.equal(reconnected.status.cache.querySettings.find((entry) => entry.key === '1502').effectiveMs, 300);
    assert.equal(reconnected.status.connectedUpstreamSessions, 1); assert.equal(radio.connections.control, 2, 'only an explicit reconnect opens the next upstream session');
    peers.push(await client(address, { password: 'testpass', timeoutMs: 5000 })); peers.at(-1).sendCiv(frame(0x1c, [0, 1])); await until(() => radio.ptt, 'synthetic TX');
    assert.equal((await api(server, auth, 'stop')).json.value.requiresConfirmation, true); assert.equal(radio.ptt, true);
    const stopped = (await api(server, auth, 'stop', { confirmedTx: true })).json.value;
    assert.notEqual(stopped.releaseConfirmed, false); assert.equal(radio.ptt, false); assert.equal(controller.closed, false);
    assert.equal((await api(server, auth, 'state')).status, 200, 'radio stop leaves management reachable');
    assert.equal((await api(server, auth, 'export')).text.includes('testpass'), false);
});

test('statistics reset requires authentication and CSRF and does not stop the connection', async (t) => {
    const { server, controller } = await setup(t); let resets = 0;
    controller.resetStatistics = () => { resets++; return controller.getState(); };
    assert.equal((await api(server, {}, 'reset-statistics')).status, 403);
    const auth = await login(server);
    assert.equal((await api(server, { cookie: auth.cookie }, 'reset-statistics')).status, 403);
    assert.equal((await api(server, auth, 'reset-statistics', { unexpected: true })).status, 400);
    assert.equal(resets, 0);
    const result = await api(server, auth, 'reset-statistics');
    assert.equal(result.status, 200); assert.equal(resets, 1);
    assert.equal(result.json.value.running, true); assert.equal(controller.closed, 0);
});
