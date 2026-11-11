#!/usr/bin/env node
'use strict';
// Explicit operator-only hardware load test. This client connects to the
// splitter, never directly to the radio. No media payloads are retained.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const { IcomSession } = require('../src/icom-lan/session');
const { FrameParser } = require('../src/broker');
const { SettingsStore } = require('../src/app/store');
const { GapTracker, managementSummary, difference } = require('./telemetry-probe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEST_MODE = Buffer.from([5, 0, 1]); // FM carrier, DATA off, filter 1.
const TEST_POWER = Buffer.from([0, 0x25]); // BCD25/255: nominal9.8% of100W.
const MODE_NAMES = { 0: 'LSB', 1: 'USB', 2: 'AM', 3: 'CW', 4: 'RTTY', 5: 'FM', 7: 'CW-R', 8: 'RTTY-R' };
function parseOptions(argv) {
    const o = { run: false, dummyLoad: false, watts: 10, seconds: 20, host: '10.0.1.82', webPort: 50004, stateDir: '/var/lib/icom-splitter' };
    const names = { '--watts': 'watts', '--seconds': 'seconds', '--host': 'host', '--web-port': 'webPort', '--state-dir': 'stateDir', '--output': 'output' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--run') { o.run = true; continue; }
        if (argv[i] === '--dummy-load') { o.dummyLoad = true; continue; }
        const key = names[argv[i]], value = argv[++i];
        if (!key || value === undefined) throw new Error('Invalid TX test arguments');
        if (['watts', 'seconds', 'webPort'].includes(key)) {
            if (!/^\d+$/.test(value)) throw new Error('Invalid TX test number'); o[key] = Number(value);
        } else o[key] = value;
    }
    if (o.watts !== 10 || !Number.isSafeInteger(o.seconds) || o.seconds < 1 || o.seconds > 25
        || net.isIP(o.host) !== 4 || !Number.isSafeInteger(o.webPort) || o.webPort < 1 || o.webPort > 65535) throw new Error('TX test requires10W and1–25seconds');
    o.stateDir = path.resolve(o.stateDir);
    if (o.output) {
        o.output = path.resolve(o.output);
        if (o.output === o.stateDir || o.output.startsWith(o.stateDir + path.sep)) throw new Error('Report must not overwrite private configuration');
    }
    if (o.run && !o.dummyLoad) throw new Error('Explicit dummy-load confirmation is required');
    if (o.run && (!argv.includes('--watts') || !argv.includes('--seconds'))) throw new Error('Explicit nominal watts and duration are required');
    return o;
}
function bcdValue(bytes) {
    if (bytes.length !== 2 || [...bytes].some((v) => (v & 15) > 9 || (v >> 4) > 9)) throw new Error('Invalid power setting reply');
    const value = bytes.reduce((n, v) => n * 100 + (v >> 4) * 10 + (v & 15), 0);
    if (value > 255) throw new Error('Power setting outside supported range'); return value;
}
function modeValue(frame) {
    if (frame.length !== 10 || frame[4] !== 0x26 || frame[5] !== 0 || !Object.hasOwn(MODE_NAMES, frame[6])
        || frame[7] > 1 || frame[8] < 1 || frame[8] > 3) throw new Error('Invalid selected-mode reply');
    return Buffer.from(frame.subarray(6, 9));
}
function managementClient(o, username, password, ca) {
    const origin = `https://${o.host}:${o.webPort}`; let cookie = '', csrf = '';
    function request(endpoint, data) {
        return new Promise((resolve, reject) => {
            const bytes = Buffer.from(JSON.stringify(data));
            const q = https.request(origin + endpoint, { method: 'POST', ca, headers: { Origin: origin, 'Content-Type': 'application/json',
                'Content-Length': bytes.length, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } }, (r) => {
                const chunks = []; let length = 0;
                r.on('data', (b) => { length += b.length; if (length > 2 * 1024 * 1024) q.destroy(new Error('Management limit')); else chunks.push(b); });
                r.on('end', () => { try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (r.statusCode !== 200 || !body.ok) throw new Error('Denied'); resolve({ value: body.value, headers: r.headers }); } catch { reject(new Error('Management request failed')); } });
                r.on('error', () => reject(new Error('Management response failed')));
            });
            q.on('error', () => reject(new Error('Management connection failed'))); q.setTimeout(5000, () => q.destroy(new Error('Management timeout'))); q.end(bytes);
        });
    }
    return { login: async () => { const r = await request('/api/login', { username, password }); cookie = r.headers['set-cookie']?.[0]?.split(';')[0]; csrf = r.value.csrfToken || r.value.csrf; if (!cookie || !csrf) throw new Error('Login failed'); },
        state: async () => (await request('/api/request', { action: 'state' })).value,
        logout: async () => { if (cookie) await request('/api/logout', {}); cookie = csrf = ''; } };
}
class Commander {
    constructor(client, address = 0xb6, onFrame = () => {}) {
        this.client = client; this.address = address; this.pending = null; this.parser = new FrameParser();
        this.receive = (bytes) => { for (const f of this.parser.push(bytes)) {
            onFrame(f);
            if (f[2] !== 0xe0 || f[3] !== this.address || !this.pending) continue;
            if (f[4] === 0xfa) this.finish(new Error('Radio rejected test command'));
            else if (this.pending.match(f)) this.finish(null, Buffer.from(f));
        } };
        client.on('civ', this.receive);
    }
    bytes(cmd, data = []) { return Buffer.from([0xfe, 0xfe, this.address, 0xe0, cmd, ...data, 0xfd]); }
    request(cmd, data = [], ack = false) {
        if (this.pending) return Promise.reject(new Error('Test transaction already pending'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.finish(new Error('Test command timed out')), 2000);
            this.pending = { resolve, reject, timer, match: ack ? (f) => f.length === 6 && f[4] === 0xfb
                : (f) => f[4] === cmd && (data.length === 0 || f.subarray(5, 5 + data.length).equals(Buffer.from(data))) };
            try { this.client.sendCiv(this.bytes(cmd, data)); } catch { this.finish(new Error('Test command could not be sent')); }
        });
    }
    finish(error, reply) { if (!this.pending) return; const p = this.pending; this.pending = null; clearTimeout(p.timer); if (error) p.reject(error); else p.resolve(reply); }
    emergencyOff() { try { this.client.sendCiv(this.bytes(0x1c, [0, 0])); } catch { /* Disconnect/watchdog remains armed. */ } }
    close() { this.finish(new Error('Test command canceled')); this.client.removeListener('civ', this.receive); }
}
async function armWatchdog() {
    if (process.platform !== 'linux') throw new Error('Live watchdog is available only on the Linux service host');
    // Confirm passwordless service-control permission before any RF request.
    execFileSync('sudo', ['-n', 'systemctl', 'show', 'icom-lan-splitter.service', '--property=MainPID', '--value'], { stdio: 'pipe', timeout: 5000 });
    const child = spawn('/bin/sh', ['-c', 'sleep "$1"; exec sudo -n systemctl stop "$2"', 'icom-tx-watchdog', '30', 'icom-lan-splitter.service'],
        { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    let fired = false; child.once('exit', (code, signal) => { if (!signal) fired = true; }); child.unref();
    return { cancel() { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }, fired: () => fired };
}
function nativeCounters(client) { return Object.fromEntries(['control', 'serial', 'audio'].map((role) => [role,
    Object.fromEntries(['malformed', 'stale', 'duplicates', 'lost', 'replayed'].map((key) => [key, client[role]?.counters?.[key] || 0]))])); }
function mediaSummary(trackers, end) { return { audio: trackers.audio.summary(end), scope: trackers.scope.summary(end) }; }
function createMedia(now) { return { audio: new GapTracker([40, 100, 500], now), scope: new GapTracker([1000], now) }; }
async function executeTest({ client, management, seconds = 20, arm = armWatchdog, signalState = { aborted: false }, now = () => performance.now(), wait = sleep }) {
    const report = { format: 1, result: 'fail', nominalWatts: 10, powerSettingRaw255: 25, actualWattsExternallyMeasured: false,
        mediaRecorded: false, frequencyChangedByTest: false, testMode: 'FM', requestedTxSeconds: seconds,
        watchdogSeconds: 30, txAudioSent: false, interpretation: 'Steady TX and RX windows are separate; receive audio may legitimately mute during TX. Protocol power control is relative, not an external wattmeter.' };
    let phase, commander, originalMode, originalPower, originalFrequency, watchdog, pttAttempted = false, rxConfirmed = false;
    const changes = { mode: false, power: false }; report.restoration = { receiveConfirmed: false, mode: 'not changed', power: 'not changed', frequencyUnchanged: null };
    const audio = (bytes) => { if (phase) phase.audio.observe(now(), bytes.length); };
    client.on('rx-audio', audio);
    commander = new Commander(client, 0xb6, (f) => { if (phase && f[4] === 0x27 && f[5] === 0) phase.scope.observe(now(), f.length); });
    const ensureActive = () => { if (signalState.aborted) throw new Error('Test interrupted'); };
    const until = async (predicate, label, limit = 5000) => { const start = now(); while (!await predicate()) { ensureActive(); if (now() - start >= limit) throw new Error(label); await wait(50); } };
    const stateRx = (s) => s.status?.broker?.ready && s.status?.radio?.connected && !s.txActive && s.dashboard?.rxTx === 'RX';
    const collect = async (duration, label, expectedTx) => {
        const began = now(); phase = createMedia(began); const before = managementSummary(await management.state()), nativeBefore = nativeCounters(client); const bins = [];
        for (let i = 1; i <= duration; i++) { while (now() < began + i * 1000) { ensureActive(); await wait(Math.min(100, began + i * 1000 - now())); }
            const at = now(); const state = await management.state();
            if (!state.status?.broker?.ready || !state.status?.radio?.connected || !client.connected) throw new Error('Radio or observer session lost during measurement');
            if (state.dashboard?.rxTx !== (expectedTx ? 'TX' : 'RX')) throw new Error('Radio left the requested measurement state');
            bins.push({ second: i, audio: phase.audio.takeBin(at), scope: phase.scope.takeBin(at), txObserved: state.dashboard?.rxTx === 'TX' });
        }
        const ended = now(), after = managementSummary(await management.state());
        const out = { label, seconds: (ended - began) / 1000, ...mediaSummary(phase, ended), before, after, counterDelta: difference(after, before), nativeTransportDelta: difference(nativeCounters(client), nativeBefore), bins };
        phase = null; return out;
    };
    try {
        const initial = await management.state();
        if (!stateRx(initial) || initial.pendingChanges) throw new Error('Fresh receive state and applied configuration are required');
        const writes = initial.status.metrics?.physical?.clientWrite;
        const identity = await commander.request(0x19, [0]); if (identity.length !== 8 || identity[6] !== 0xb6) throw new Error('Radio model was not confirmed');
        originalMode = modeValue(await commander.request(0x26, [0]));
        const powerReply = await commander.request(0x14, [0x0a]); originalPower = Buffer.from(powerReply.subarray(6, -1)); bcdValue(originalPower);
        originalFrequency = Buffer.from((await commander.request(3)).subarray(5, -1)); if (originalFrequency.length !== 5) throw new Error('Frequency reply invalid');
        report.originalMode = MODE_NAMES[originalMode[0]]; report.originalPowerSettingRaw255 = bcdValue(originalPower);
        report.rxBefore = await collect(2, 'RX before TX', false);
        ensureActive(); if (!stateRx(await management.state())) throw new Error('Radio is no longer receiving');
        changes.power = true; report.restoration.power = 'pending'; await commander.request(0x14, [0x0a, ...TEST_POWER], true);
        const actualPower = Buffer.from((await commander.request(0x14, [0x0a])).subarray(6, -1));
        if (!actualPower.equals(TEST_POWER)) throw new Error('Nominal low power could not be verified');
        changes.mode = true; report.restoration.mode = 'pending'; await commander.request(0x26, [0, ...TEST_MODE], true);
        if (!modeValue(await commander.request(0x26, [0])).equals(TEST_MODE)) throw new Error('Carrier mode could not be verified');
        if (!Buffer.from((await commander.request(0x14, [0x0a])).subarray(6, -1)).equals(TEST_POWER)) throw new Error('Power changed during setup');
        const ready = await management.state();
        if (!stateRx(ready)) throw new Error('Receive state changed during setup');
        if (Number.isFinite(writes) && ready.status.metrics.physical.clientWrite !== writes + 2) throw new Error('Another operator changed radio controls during setup');
        ensureActive(); watchdog = await arm();
        const keyedAt = now(); pttAttempted = true; signalState.emergencyOff = () => commander.emergencyOff();
        await commander.request(0x1c, [0, 1], true);
        await until(async () => { const s = await management.state(); return s.txActive && s.dashboard?.rxTx === 'TX'; }, 'Radio did not confirm TX', 3000);
        report.steadyTx = await collect(seconds, 'Steady TX; RX audio muting is expected', true);
        await commander.request(0x1c, [0, 0], true);
        await until(async () => stateRx(await management.state()), 'Radio did not confirm receive after TX', 5000);
        rxConfirmed = true; report.restoration.receiveConfirmed = true; report.observedTxDurationSeconds = (now() - keyedAt) / 1000;
        watchdog.cancel(); report.watchdogCanceledAfterRx = true;
        if (report.observedTxDurationSeconds >= 60) throw new Error('TX duration bound exceeded');
        report.result = 'pass';
    } catch {
        report.failure = 'Test did not complete; inspect restoration and service state before further transmission.';
    } finally {
        phase = null;
        if (pttAttempted && !rxConfirmed) {
            commander.emergencyOff();
            try {
                const end = now() + 7000;
                while (now() < end) { const s = await management.state(); if (stateRx(s)) { rxConfirmed = true; break; } await wait(100); }
            } catch { /* Independent watchdog must remain armed. */ }
            report.restoration.receiveConfirmed = rxConfirmed;
            if (rxConfirmed && watchdog) { watchdog.cancel(); report.watchdogCanceledAfterRx = true; }
        }
        if (!pttAttempted || rxConfirmed) {
            // Restore only values still matching this test. Preserve observed
            // operator changes rather than overwriting them on cleanup.
            if (changes.mode && originalMode) {
                try { const current = modeValue(await commander.request(0x26, [0]));
                    if (current.equals(TEST_MODE)) { await commander.request(0x26, [0, ...originalMode], true); report.restoration.mode = modeValue(await commander.request(0x26, [0])).equals(originalMode) ? 'restored' : 'verification failed'; }
                    else report.restoration.mode = 'external change preserved';
                } catch { report.restoration.mode = 'could not restore'; }
            }
            if (changes.power && originalPower) {
                try { const current = Buffer.from((await commander.request(0x14, [0x0a])).subarray(6, -1));
                    if (current.equals(TEST_POWER)) { await commander.request(0x14, [0x0a, ...originalPower], true); report.restoration.power = Buffer.from((await commander.request(0x14, [0x0a])).subarray(6, -1)).equals(originalPower) ? 'restored' : 'verification failed'; }
                    else report.restoration.power = 'external change preserved';
                } catch { report.restoration.power = 'could not restore'; }
            }
            if (originalFrequency) { try { report.restoration.frequencyUnchanged = Buffer.from((await commander.request(3)).subarray(5, -1)).equals(originalFrequency); } catch { report.restoration.frequencyUnchanged = null; } }
            if (rxConfirmed) { try { report.rxAfter = await collect(3, 'RX after release/restoration', false); report.rxAudioResumed = report.rxAfter.audio.packets > 0; } catch { report.rxAudioResumed = false; } }
        }
        if (pttAttempted && !rxConfirmed) {
            if (changes.mode) report.restoration.mode = 'not restored; receive unconfirmed';
            if (changes.power) report.restoration.power = 'not restored; receive unconfirmed';
        }
        if (watchdog) report.watchdogFired = watchdog.fired();
        if (pttAttempted && !rxConfirmed) report.watchdogLeftArmed = true;
        client.removeListener('rx-audio', audio); commander.close(); signalState.emergencyOff = null;
        if ((report.rxBefore?.audio.packets > 0 && report.rxAudioResumed === false) || (!report.restoration.receiveConfirmed && pttAttempted) || ['could not restore', 'verification failed'].some((v) => [report.restoration.mode, report.restoration.power].includes(v))) report.result = 'fail';
    }
    return report;
}
async function run(o) {
    if (!o.run || !o.dummyLoad) throw new Error('Explicit hardware test flags are required');
    const saved = await new SettingsStore(o.stateDir).load(); if (!saved) throw new Error('Private service settings are required');
    const ca = await fs.readFile(path.join(o.stateDir, 'tls/certificate.pem'));
    const management = managementClient(o, saved.values.ICOM_USERNAME, saved.password, ca);
    const output = o.output ? await fs.open(o.output, 'wx', 0o600) : null;
    let client; const signalState = { aborted: false };
    const signal = () => { signalState.aborted = true; signalState.emergencyOff?.(); };
    try {
        await management.login(); const state = await management.state(); const values = state.activeSettings?.values || state.settings?.values;
        const host = values?.ICOM_BIND_ADDRESS && values.ICOM_BIND_ADDRESS !== '0.0.0.0' ? values.ICOM_BIND_ADDRESS : o.host;
        if (!values || host === values.ICOM_RADIO_HOST) throw new Error('Test must connect to the splitter, not the radio');
        client = new IcomSession({ host, username: values.ICOM_USERNAME, password: saved.password, controlPort: Number(values.ICOM_LISTEN_CONTROL_PORT),
            civPort: Number(values.ICOM_LISTEN_CIV_PORT), audioPort: Number(values.ICOM_LISTEN_AUDIO_PORT), reconnectAttempts: 0, timeoutMs: 5000 });
        client.sendAudio = () => { throw new Error('TX audio is disabled in this test'); };
        await client.open(); process.on('SIGINT', signal); process.on('SIGTERM', signal);
        const report = await executeTest({ client, management, seconds: o.seconds, signalState });
        if (output) await output.writeFile(JSON.stringify(report, null, 2) + '\n');
        return report;
    } finally {
        process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
        await client?.close().catch(() => {}); await management.logout().catch(() => {}); await output?.close();
    }
}
async function main() {
    if (!process.argv.includes('--run') || process.argv.includes('--help')) {
        console.log('Usage: node scripts/telemetry-tx-test.js --run --dummy-load --watts 10 --seconds 20 [--host SPLITTER_IP] [--output /tmp/tx-metadata.json]');
        console.log('Operator-only: confirmed dummy load, nominal10W FM carrier, independent30s service-stop watchdog. No RF runs without --run.'); return;
    }
    const report = await run(parseOptions(process.argv.slice(2))); console.log(JSON.stringify(report)); if (report.result !== 'pass') process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('TX test failed. Verify receive state, radio settings and service operation before retrying. No credentials or media were recorded.'); process.exitCode = 1; });
module.exports = { parseOptions, bcdValue, modeValue, Commander, executeTest, TEST_MODE, TEST_POWER };
