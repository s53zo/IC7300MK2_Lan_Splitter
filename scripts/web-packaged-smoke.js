#!/usr/bin/env node
'use strict';

// Linux standalone integration smoke. Every endpoint, credential and radio is
// an isolated fixture. No physical radio, transmit request or TX audio is used.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, X509Certificate } = require('node:crypto');
const { checkServerIdentity } = require('node:tls');
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { client, frame, sleep } = require('../tests/fixtures/harness');

const PASSWORD = 'testpass';
const ASSETS = {
    '/index.html': 'text/html', '/renderer.js': 'text/javascript', '/styles.css': 'text/css',
    '/bridge.js': 'text/javascript', '/login.html': 'text/html', '/login.js': 'text/javascript', '/login.css': 'text/css',
};

async function availablePorts() {
    const sockets = [];
    const listener = net.createServer();
    try {
        for (let i = 0; i < 3; i++) {
            const socket = dgram.createSocket('udp4'); sockets.push(socket);
            await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
        }
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        return { udp: sockets.map((socket) => socket.address().port), web: listener.address().port };
    } finally {
        await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
        if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    }
}

function launch(executable, directory, configuration, env) {
    const child = spawn(executable, ['--web', '--config-dir', configuration], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, stdout: '', stderr: '', exited: false, code: null, signal: null, error: null, forced: false };
    child.stdout.on('data', (chunk) => { state.stdout = (state.stdout + chunk.toString()).slice(-65536); });
    child.stderr.on('data', (chunk) => { state.stderr = (state.stderr + chunk.toString()).slice(-65536); });
    child.on('error', (error) => { state.error = error; });
    state.closed = new Promise((resolve) => child.once('close', (code, signal) => {
        state.exited = true; state.code = code; state.signal = signal; resolve();
    }));
    return state;
}

async function waitFor(predicate, label, state, timeoutMs = 45000, intervalMs = 25) {
    const deadline = performance.now() + timeoutMs;
    while (!await predicate()) {
        if (state?.error) throw state.error;
        if (state?.exited) throw new Error(`Packaged web service exited before ${label} (code ${state.code}, signal ${state.signal}): ${state.stderr.trim().slice(-2000)}`);
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

async function stop(state, verify = false) {
    if (!state) return;
    if (!state.exited) {
        state.child.kill('SIGTERM');
        const timer = setTimeout(() => { state.forced = true; state.child.kill('SIGKILL'); }, 15000);
        try { await state.closed; } finally { clearTimeout(timer); }
    }
    if (verify) {
        assert.equal(state.forced, false, 'normal shutdown must not need SIGKILL');
        assert.equal(state.code, 0, 'SIGTERM must complete graceful shutdown');
        assert.equal(state.signal, null, 'the signal handler must finish normally');
        assert.equal((state.stdout + state.stderr).includes(PASSWORD), false, 'diagnostics must exclude fixture credentials');
    }
}

function management(port, certificate) {
    const pin = new X509Certificate(certificate).fingerprint256;
    let validated = 0;
    async function request(pathname, { method = 'GET', body, cookie, csrf } = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const call = https.request({ hostname: '127.0.0.1', port, path: pathname, method, agent: false,
                ca: certificate, rejectUnauthorized: true,
                checkServerIdentity(hostname, peer) {
                    if (new X509Certificate(peer.raw).fingerprint256 !== pin) return new Error('Fixture certificate pin mismatch');
                    const error = checkServerIdentity(hostname, peer);
                    if (!error) validated++;
                    return error;
                },
                headers: { Host: `127.0.0.1:${port}`, ...(method === 'POST' ? { Origin: `https://127.0.0.1:${port}` } : {}),
                    ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
                    ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
            }, (response) => {
                const chunks = []; let length = 0;
                response.on('data', (chunk) => {
                    length += chunk.length;
                    if (length > 1024 * 1024) { call.destroy(new Error('Fixture response exceeded its bound')); return; }
                    chunks.push(chunk);
                });
                response.on('error', reject);
                response.on('end', () => {
                    const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'); let json;
                    try { json = JSON.parse(text); } catch { json = null; }
                    resolve({ status: response.statusCode, headers: response.headers, bytes, text, json });
                });
            });
            call.setTimeout(10000, () => call.destroy(new Error('Fixture HTTPS request timed out')));
            call.on('error', reject); if (payload !== undefined) call.write(payload); call.end();
        });
    }
    async function login() {
        const reply = await request('/api/login', { method: 'POST', body: { username: 'beer', password: PASSWORD } });
        assert.equal(reply.status, 200, 'saved fixture credentials must sign in');
        assert.equal(reply.json?.value?.authenticated, true);
        const cookie = reply.headers['set-cookie']?.[0];
        for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie?.includes(flag), `session cookie requires ${flag}`);
        assert.match(reply.json.value.csrfToken, /^[a-f0-9]{64}$/);
        return { cookie: cookie.split(';')[0], csrf: reply.json.value.csrfToken };
    }
    async function api(auth, action, payload) {
        const reply = await request('/api/request', { method: 'POST', body: { action, ...(payload === undefined ? {} : { payload }) }, ...auth });
        assert.equal(reply.status, 200, `management action ${action} must succeed`);
        assert.equal(reply.json?.ok, true, `management action ${action} must return a value`);
        assert.equal(reply.text.includes(PASSWORD), false, 'management responses must exclude fixture credentials');
        return reply.json.value;
    }
    return { request, login, api, pin, validated: () => validated };
}

async function verifyAssets(web) {
    const hashes = {};
    for (const [pathname, contentType] of Object.entries(ASSETS)) {
        const response = await web.request(pathname);
        assert.equal(response.status, 200, `embedded asset ${pathname} must be served`);
        assert.ok(response.headers['content-type']?.startsWith(contentType), `${pathname} has its expected content type`);
        assert.ok(response.bytes.length > 64, `${pathname} must contain the embedded asset`);
        hashes[pathname] = createHash('sha256').update(response.bytes).digest('hex');
        if (pathname === '/index.html') {
            assert.match(response.text, /<script defer src="bridge\.js"><\/script>/);
            assert.match(response.text, /<script defer src="renderer\.js"><\/script>/);
            assert.match(response.text, /connect-src 'self'/);
        }
    }
    assert.equal(createHash('sha256').update((await web.request('/')).bytes).digest('hex'), hashes['/index.html']);
    assert.equal(createHash('sha256').update((await web.request('/login')).bytes).digest('hex'), hashes['/login.html']);
    return hashes;
}

async function verifyNative(radio, address, service, peers, marker) {
    peers.push(await client(address, { password: PASSWORD, timeoutMs: 5000 }));
    peers.push(await client(address, { password: PASSWORD, timeoutMs: 5000 }));
    peers[0].sendCiv(frame(3, [], 0xe1)); peers[1].sendCiv(frame(4, [], 0xe2));
    await waitFor(() => peers[0].receivedCiv.some((bytes) => bytes[4] === 3)
        && peers[1].receivedCiv.some((bytes) => bytes[4] === 4), 'private native replies', service);
    const frequency = peers[0].receivedCiv.find((bytes) => bytes[4] === 3);
    const mode = peers[1].receivedCiv.find((bytes) => bytes[4] === 4);
    assert.equal(frequency[2], 0xe1); assert.deepEqual(frequency.subarray(5, -1), radio.frequency);
    assert.equal(mode[2], 0xe2); assert.deepEqual(mode.subarray(5, -1), Buffer.from([radio.mode, radio.filter]));
    assert.equal(peers[0].receivedCiv.some((bytes) => bytes[4] === 4), false, 'mode reply stays private');
    assert.equal(peers[1].receivedCiv.some((bytes) => bytes[4] === 3), false, 'frequency reply stays private');
    const pcm = Buffer.alloc(1364, marker), scope = Buffer.alloc(475, marker + 1);
    radio.rxAudio(pcm); radio.scope(scope);
    await waitFor(() => peers.every((peer) => peer.receivedAudio.length
        && peer.receivedCiv.some((bytes) => bytes[4] === 0x27 && bytes[5] === 0)), 'exact native audio/scope fanout', service);
    for (const peer of peers) {
        assert.deepEqual(peer.receivedAudio[0], pcm);
        const received = peer.receivedCiv.find((bytes) => bytes[4] === 0x27 && bytes[5] === 0);
        assert.equal(received.length, 497); assert.deepEqual(received.subarray(21, -1), scope);
    }
}

function assertReceiveOnly(radio) {
    assert.equal(radio.ptt, false, 'fixture radio must remain in receive');
    assert.equal(radio.txAudio.length, 0, 'no transmit audio may reach the fixture');
    assert.equal(radio.commands.some((bytes) => bytes[4] === 0x1c && bytes[5] === 0 && bytes[6] === 1), false,
        'no PTT-on command may reach the fixture');
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help')) {
        console.log('Usage: node scripts/web-packaged-smoke.js --executable PATH'); return;
    }
    if (args.length !== 2 || args[0] !== '--executable') throw new Error('Use --executable PATH');
    if (process.platform !== 'linux') throw new Error('Packaged web smoke requires Linux');
    const supplied = path.resolve(args[1]); await fs.access(supplied, fs.constants.X_OK);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-web-packaged-'));
    const configuration = path.join(directory, 'settings'), executable = path.join(directory, 'icom-lan-splitter');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ICOM_')
        && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
    const peers = [], children = [];
    let radio, service;
    try {
        // The actual executable runs beside no source/assets and from a private
        // working directory. A successful asset request must use SEA embedding.
        await fs.copyFile(supplied, executable); await fs.chmod(executable, 0o700);
        const digest = createHash('sha256'); for await (const chunk of createReadStream(executable)) digest.update(chunk);
        const executableSha256 = digest.digest('hex');
        radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
        const upstream = radio.config(), ports = await availablePorts();
        const [controlPort, civPort, audioPort] = ports.udp;
        const address = { host: '127.0.0.1', controlPort, civPort, audioPort };
        const passwordFile = path.join(directory, 'fixture-password');
        await fs.writeFile(passwordFile, PASSWORD + '\n', { mode: 0o600 });
        const listenerEnv = { ...env, ICOM_WEB_BIND_ADDRESS: '127.0.0.1', ICOM_WEB_PORT: String(ports.web) };
        const bootstrapEnv = { ...listenerEnv, ICOM_RADIO_HOST: '127.0.0.1', ICOM_BIND_ADDRESS: '127.0.0.1',
            ICOM_USERNAME: 'beer', ICOM_PASSWORD_FILE: passwordFile,
            ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort),
            ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort), ICOM_LISTEN_CONTROL_PORT: String(controlPort),
            ICOM_LISTEN_CIV_PORT: String(civPort), ICOM_LISTEN_AUDIO_PORT: String(audioPort) };
        service = launch(executable, directory, configuration, bootstrapEnv); children.push(service);
        await waitFor(() => service.stdout.includes(`Linux web service ready: HTTPS port ${ports.web}`), 'HTTPS startup', service);
        const certificateFile = path.join(configuration, 'tls/certificate.pem'), keyFile = path.join(configuration, 'tls/private-key.pem');
        const certificate = await fs.readFile(certificateFile), privateKey = await fs.readFile(keyFile);
        const web = management(ports.web, certificate);
        const session = await web.request('/api/session');
        assert.deepEqual(session.json?.value, { authenticated: false, setupRequired: false });
        const assetHashes = await verifyAssets(web), auth = await web.login();
        await waitFor(async () => (await web.api(auth, 'state')).status.broker.ready, 'API radio readiness', service, 45000, 500);
        await verifyNative(radio, address, service, peers, 0x31);
        let state = await web.api(auth, 'state');
        assert.equal(state.status.nativeClients.authenticated, 2); assert.equal(state.status.connectedUpstreamSessions, 1);
        assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
        const saved = await web.api(auth, 'save', { ICOM_CACHE_QUERY_1502_MS: '200' });
        assert.equal(saved.settings.values.ICOM_CACHE_QUERY_1502_MS, '200');
        assert.equal(saved.pendingChanges, true, 'saving must leave the current radio connection running');
        const settingsFile = path.join(configuration, 'settings.json');
        const settingsBytes = await fs.readFile(settingsFile), credentialBytes = await fs.readFile(path.join(configuration, 'credentials'));
        assert.equal(settingsBytes.includes(Buffer.from(PASSWORD)), false, 'settings JSON must exclude the password');
        assert.equal(credentialBytes.toString(), PASSWORD);
        for (const file of [settingsFile, path.join(configuration, 'credentials'), certificateFile, keyFile, passwordFile]) {
            assert.equal((await fs.stat(file)).mode & 0o077, 0, 'fixture state files must be owner-only');
        }
        const logout = await web.request('/api/logout', { method: 'POST', body: {}, ...auth });
        assert.equal(logout.status, 200); assert.equal(logout.json?.value?.authenticated, false);
        assert.equal((await web.request('/api/request', { method: 'POST', body: { action: 'state' }, ...auth })).status, 403,
            'logout must revoke its browser session');
        assert.equal(service.exited, false, 'browser logout must leave the process running');
        peers[0].receivedCiv.length = 0; peers[0].sendCiv(frame(3, [], 0xe1));
        await waitFor(() => peers[0].receivedCiv.some((bytes) => bytes[4] === 3), 'native operation after browser logout', service);
        const secondAuth = await web.login(); state = await web.api(secondAuth, 'state');
        assert.equal(state.running, true); assert.equal(state.status.nativeClients.authenticated, 2);
        assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 }, 'logout must not reconnect the radio');
        assertReceiveOnly(radio);
        await Promise.all(peers.splice(0).map((peer) => peer.close()));
        await stop(service, true); await fs.rm(passwordFile);
        // Bootstrap credentials/settings no longer exist in the child
        // environment or import file. Restart must use the persisted profile.
        service = launch(executable, directory, configuration, listenerEnv); children.push(service);
        await waitFor(() => service.stdout.includes(`Linux web service ready: HTTPS port ${ports.web}`), 'restarted HTTPS startup', service);
        assert.deepEqual(await fs.readFile(certificateFile), certificate, 'restart must reuse the generated certificate');
        assert.equal((await fs.readFile(keyFile)).equals(privateKey), true, 'restart must reuse its private key');
        assert.deepEqual(await fs.readFile(settingsFile), settingsBytes, 'restart must preserve saved settings');
        assert.equal((await fs.readFile(path.join(configuration, 'credentials'))).equals(credentialBytes), true, 'restart must preserve credentials');
        const restarted = management(ports.web, certificate);
        assert.equal((await restarted.request('/api/session', secondAuth)).json?.value?.authenticated, false, 'browser sessions must not survive process restart');
        const restartedAuth = await restarted.login();
        await waitFor(async () => (await restarted.api(restartedAuth, 'state')).status.broker.ready, 'restarted radio readiness', service, 45000, 500);
        state = await restarted.api(restartedAuth, 'state');
        assert.equal(state.firstRun, false); assert.equal(state.pendingChanges, false);
        assert.equal(state.settings.values.ICOM_RADIO_HOST, '127.0.0.1');
        assert.equal(state.activeSettings.values.ICOM_CACHE_QUERY_1502_MS, '200');
        assert.equal(state.status.cache.querySettings.find((entry) => entry.key === '1502').effectiveMs, 200);
        assert.deepEqual(await verifyAssets(restarted), assetHashes, 'all embedded assets must survive restart unchanged');
        await verifyNative(radio, address, service, peers, 0x41);
        state = await restarted.api(restartedAuth, 'state');
        assert.equal(state.status.nativeClients.authenticated, 2); assert.equal(state.status.connectedUpstreamSessions, 1);
        assert.deepEqual(radio.connections, { control: 2, civ: 2, audio: 2 }, 'exactly one upstream session per child lifetime');
        assertReceiveOnly(radio);
        assert.ok(web.validated() > 0 && restarted.validated() > 0, 'requests must validate the certificate pin and hostname');
        await Promise.all(peers.splice(0).map((peer) => peer.close())); await stop(service, true);
        assertReceiveOnly(radio);
        console.log(JSON.stringify({ result: 'pass', mode: 'linux-standalone-web', architecture: process.arch,
            executableSha256, physicalRadioUsed: false, txRequested: false, clientsPerLifetime: 2, upstreamSessionsPerLifetime: 1,
            embeddedAssets: assetHashes, tls: 'CA, hostname and fingerprint verified; same certificate/key after restart',
            savedProfile: 'reloaded without bootstrap environment or password file', logoutKeepsServiceRunning: true,
            privateReplies: 'verified', audioAndScope: 'exact payloads verified before and after restart', gracefulSigterm: 'both child lifetimes' }));
    } finally {
        await Promise.allSettled(peers.map((peer) => peer.close()));
        await Promise.all(children.map((child) => stop(child)));
        if (radio) await radio.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(`Packaged web smoke failed: ${String(error.message).split(PASSWORD).join('[fixture password]')}`);
    process.exitCode = 1;
});
