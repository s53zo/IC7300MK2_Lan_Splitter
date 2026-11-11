#!/usr/bin/env node
'use strict';

// Receive-only native splitter client plus read-only management snapshots.
// Never connects directly to the radio, sends CI-V commands or records media.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { IcomSession } = require('../src/icom-lan/session');
const { FrameParser } = require('../src/broker');
const { SettingsStore } = require('../src/app/store');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rounded = (value) => Math.round(value * 1000) / 1000;
const COUNTERS = ['malformed', 'stale', 'duplicates', 'lost', 'replayed'];

class GapTracker {
    constructor(thresholds, startedAt) {
        this.thresholds = thresholds;
        this.startedAt = startedAt;
        this.firstAt = null; this.lastAt = null;
        this.packets = 0; this.bytes = 0; this.maxGapMs = 0;
        this.gaps = Object.fromEntries(thresholds.map((value) => [String(value), 0]));
        this.binPackets = 0; this.binBytes = 0; this.binMaxGapMs = 0;
    }
    observe(at, bytes) {
        if (!Number.isFinite(at) || at < this.startedAt || !Number.isSafeInteger(bytes) || bytes < 0) return;
        if (this.lastAt !== null) {
            const gap = Math.max(0, at - this.lastAt);
            this.maxGapMs = Math.max(this.maxGapMs, gap);
            this.binMaxGapMs = Math.max(this.binMaxGapMs, gap);
            for (const threshold of this.thresholds) if (gap >= threshold) this.gaps[String(threshold)]++;
        }
        if (this.firstAt === null) this.firstAt = at;
        this.lastAt = at; this.packets++; this.bytes += bytes; this.binPackets++; this.binBytes += bytes;
    }
    takeBin(at) {
        const bin = { packets: this.binPackets, bytes: this.binBytes, maxInterarrivalMs: rounded(this.binMaxGapMs),
            silenceAtEndMs: rounded(Math.max(0, at - (this.lastAt ?? this.startedAt))) };
        this.binPackets = this.binBytes = this.binMaxGapMs = 0;
        return bin;
    }
    summary(at) {
        const duration = Math.max(0, at - this.startedAt);
        const initial = this.firstAt === null ? duration : this.firstAt - this.startedAt;
        const tail = Math.max(0, at - (this.lastAt ?? this.startedAt));
        return { packets: this.packets, bytes: this.bytes, packetsPerSecond: duration ? rounded(this.packets * 1000 / duration) : 0,
            firstPacketDelayMs: rounded(initial), maxInterarrivalMs: rounded(this.maxGapMs), tailSilenceMs: rounded(tail),
            longestObservedGapMs: rounded(Math.max(initial, tail, this.maxGapMs)), gapsAtLeastMs: { ...this.gaps } };
    }
}

// Future telemetry snapshots may contain sample bodies. Keep numeric metadata
// only, explicitly excluding readings, secrets, buffers and numeric arrays.
function numericMetadata(value, depth = 0) {
    if (depth > 10) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined;
    if (Array.isArray(value)) {
        if (!value.every((item) => item && !Array.isArray(item) && /^(?:[0-9a-f]{2}){1,5}$/i.test(item.key || item.query || ''))) return undefined;
        return Object.fromEntries(value.map((item) => [String(item.key || item.query).toLowerCase(), numericMetadata(item, depth + 1)]));
    }
    if (value.type === 'Buffer') return undefined;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (/reply|value|reading|payload|password|credential|cookie|token|cert|raw|buffer/i.test(key)) continue;
        const result = numericMetadata(item, depth + 1);
        if (result !== undefined) output[key] = result;
    }
    return output;
}
function managementSummary(state) {
    const status = state?.status || {};
    const metrics = status.metrics || {};
    const cache = status.cache || {};
    const radioStates = new Set(['stopped', 'disconnected', 'connecting', 'authenticating', 'negotiating', 'opening-streams', 'connected', 'reconnecting', 'failed']);
    return { running: Boolean(state?.running), connecting: Boolean(state?.connecting), pendingChanges: Boolean(state?.pendingChanges),
        radio: { state: radioStates.has(status.radio?.state) ? status.radio.state : 'unknown', connected: Boolean(status.radio?.connected) },
        broker: { ready: Boolean(status.broker?.ready), pending: Boolean(status.broker?.pending), queueDepth: status.broker?.queueDepth ?? null, txOwned: Boolean(status.broker?.txOwned) },
        upstreamSessions: status.connectedUpstreamSessions ?? null, clients: numericMetadata(status.nativeClients || {}),
        cache: numericMetadata({ enabled: cache.enabled, entries: cache.entries, requests: cache.requests, hits: cache.hits,
            coalesced: cache.coalesced, misses: cache.misses, invalidations: cache.invalidations, ttlMs: cache.ttlMs, byQuery: cache.byQuery }),
        telemetry: numericMetadata(status.telemetry || state?.telemetry || cache.telemetry || {}),
        metrics: numericMetadata({ elapsedMs: metrics.elapsedMs, physical: metrics.physical, physicalTotal: metrics.physicalTotal,
            physicalSendErrors: metrics.physicalSendErrors, radioTimeouts: metrics.radioTimeouts, responses: metrics.responses,
            reasons: metrics.reasons, transport: metrics.transport, timings: Object.fromEntries(Object.entries(metrics.timings || {}).map(([key, histogram]) =>
                [key, { count: histogram.count, sumMs: histogram.sumMs, maxMs: histogram.maxMs, atLeast350Ms: histogram.atLeast350Ms }])) }) };
}
function counters(session) {
    return Object.fromEntries(['control', 'serial', 'audio'].map((role) => [role,
        Object.fromEntries(COUNTERS.map((key) => [key, session[role]?.counters?.[key] || 0]))]));
}
function difference(after, before) {
    if (!after || !before) return null;
    const output = {};
    for (const [key, value] of Object.entries(after)) {
        if (typeof value === 'number' && typeof before[key] === 'number') output[key] = value - before[key];
        else if (value && before[key] && typeof value === 'object' && typeof before[key] === 'object' && !Array.isArray(value)) output[key] = difference(value, before[key]);
    }
    return output;
}
function parseOptions(argv) {
    const options = { seconds: 60, settleSeconds: 2, label: 'sample', host: '127.0.0.1', webPort: 50004, stateDir: '/var/lib/icom-splitter' };
    const names = { '--seconds': 'seconds', '--settle-seconds': 'settleSeconds', '--label': 'label', '--host': 'host', '--web-port': 'webPort', '--state-dir': 'stateDir', '--ca-file': 'caFile', '--output': 'output' };
    for (let i = 0; i < argv.length; i += 2) {
        const key = names[argv[i]], value = argv[i + 1];
        if (!key || value === undefined) throw new Error('Invalid telemetry probe arguments');
        if (['seconds', 'settleSeconds', 'webPort'].includes(key)) {
            if (!/^\d+$/.test(value)) throw new Error('Invalid telemetry probe number'); options[key] = Number(value);
        } else options[key] = value;
    }
    if (!Number.isSafeInteger(options.seconds) || options.seconds < 1 || options.seconds > 3600
        || !Number.isSafeInteger(options.settleSeconds) || options.settleSeconds < 0 || options.settleSeconds > 30
        || !Number.isSafeInteger(options.webPort) || options.webPort < 1 || options.webPort > 65535
        || net.isIP(options.host) !== 4 || !/^[a-z0-9._-]{1,64}$/i.test(options.label)) throw new Error('Invalid telemetry probe options');
    options.stateDir = path.resolve(options.stateDir);
    options.caFile = path.resolve(options.caFile || path.join(options.stateDir, 'tls/certificate.pem'));
    if (options.output) options.output = path.resolve(options.output);
    return options;
}
function managementClient(options, username, password, ca) {
    const origin = `https://${options.host}:${options.webPort}`;
    let cookie = '', csrf = '';
    async function request(endpoint, data) {
        return new Promise((resolve, reject) => {
            const bytes = data === undefined ? null : Buffer.from(JSON.stringify(data));
            const req = https.request(origin + endpoint, { method: bytes ? 'POST' : 'GET', ca,
                headers: { Origin: origin, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
                    ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } }, (res) => {
                let length = 0; const chunks = [];
                res.on('data', (chunk) => { length += chunk.length; if (length > 2 * 1024 * 1024) req.destroy(new Error('Management response limit')); else chunks.push(chunk); });
                res.on('error', () => reject(new Error('Management response failed')));
                res.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (res.statusCode !== 200 || !body.ok) { reject(new Error('Management request denied')); return; }
                        resolve({ value: body.value, headers: res.headers });
                    } catch { reject(new Error('Invalid management response')); }
                });
            });
            req.on('error', () => reject(new Error('Management connection failed')));
            req.setTimeout(10000, () => req.destroy(new Error('Management timeout')));
            if (bytes) req.write(bytes); req.end();
        });
    }
    async function login() {
        const result = await request('/api/login', { username, password });
        const sessionCookie = result.headers['set-cookie']?.[0];
        csrf = result.value.csrfToken || result.value.csrf;
        if (!sessionCookie || !csrf) throw new Error('Management login failed');
        cookie = sessionCookie.split(';')[0];
    }
    return { login, state: async () => (await request('/api/request', { action: 'state' })).value,
        logout: async () => { if (cookie) await request('/api/logout', {}); cookie = csrf = ''; } };
}
async function writeReport(file, report, stateDir) {
    const parent = await fs.realpath(path.dirname(file));
    const target = path.join(parent, path.basename(file)), protectedDirectory = await fs.realpath(stateDir);
    if (target === protectedDirectory || target.startsWith(protectedDirectory + path.sep)) throw new Error('Probe output must be outside the protected settings directory');
    const temporary = path.join(parent, `.telemetry-probe-${process.pid}-${Date.now()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
}

async function runProbe(options) {
    const saved = await new SettingsStore(options.stateDir).load();
    if (!saved?.values?.ICOM_USERNAME || !saved.password) throw new Error('Probe needs an existing private service profile');
    const ca = await fs.readFile(options.caFile), management = managementClient(options, saved.values.ICOM_USERNAME, saved.password, ca);
    let client, measuring = false, audio, scope, parser;
    let disconnected = 0, managementFailures = 0;
    const bins = [];
    try {
        await management.login();
        const initial = await management.state();
        if (initial.pendingChanges) throw new Error('Apply or discard pending configuration before measuring');
        const values = initial.activeSettings?.values || initial.settings?.values || saved.values;
        const nativeHost = values.ICOM_BIND_ADDRESS && values.ICOM_BIND_ADDRESS !== '0.0.0.0' ? values.ICOM_BIND_ADDRESS : options.host;
        if (nativeHost === values.ICOM_RADIO_HOST && Number(values.ICOM_LISTEN_CONTROL_PORT || 50001) === Number(values.ICOM_RADIO_CONTROL_PORT || 50001)) throw new Error('Probe cannot connect directly to the radio');
        client = new IcomSession({ host: nativeHost, username: values.ICOM_USERNAME, password: saved.password,
            controlPort: Number(values.ICOM_LISTEN_CONTROL_PORT || 50001), civPort: Number(values.ICOM_LISTEN_CIV_PORT || 50002),
            audioPort: Number(values.ICOM_LISTEN_AUDIO_PORT || 50003), reconnectAttempts: 0 });
        // This observer must stay receive-only even if session code evolves.
        client.sendCiv = () => { throw new Error('CI-V commands are disabled in this receive-only probe'); };
        client.sendAudio = () => { throw new Error('TX audio is disabled in this receive-only probe'); };
        client.on('disconnected', () => { if (measuring) disconnected++; });
        client.on('rx-audio', (bytes) => { if (measuring) audio.observe(performance.now(), bytes.length); });
        client.on('civ', (bytes) => {
            if (!measuring) return;
            for (const frame of parser.push(bytes)) if (frame[4] === 0x27 && frame[5] === 0) scope.observe(performance.now(), frame.length);
        });
        await client.open(); await sleep(options.settleSeconds * 1000);
        const before = managementSummary(await management.state()), nativeBefore = counters(client);
        const startedAt = performance.now(), startedUtc = new Date().toISOString();
        audio = new GapTracker([40, 100, 500], startedAt); scope = new GapTracker([1000], startedAt); parser = new FrameParser(); measuring = true;
        let latest = before, previous = before, currentAvailable = true;
        for (let second = 1; second <= options.seconds; second++) {
            await sleep(Math.max(0, startedAt + second * 1000 - performance.now()));
            let current = null;
            try { current = managementSummary(await management.state()); latest = current; }
            catch { managementFailures++; }
            const at = performance.now();
            bins.push({ second, elapsedMs: rounded(at - startedAt), audio: audio.takeBin(at), scope: scope.takeBin(at),
                nativeConnected: Boolean(client.connected), managementAvailable: Boolean(current), radioConnected: current?.radio.connected ?? null,
                brokerReady: current?.broker.ready ?? null, upstreamSessions: current?.upstreamSessions ?? null,
                radioPhysical: current ? difference(current.metrics?.physical || {}, previous.metrics?.physical || {}) : null });
            if (current) previous = current;
            currentAvailable = Boolean(current);
        }
        const endedAt = performance.now(); measuring = false;
        const report = { format: 1, label: options.label, startedUtc, endedUtc: new Date().toISOString(),
            secondsRequested: options.seconds, secondsObserved: rounded((endedAt - startedAt) / 1000), settleSeconds: options.settleSeconds,
            receiveOnly: true, ciVQueriesSent: 0, txRequested: false, mediaRecorded: false, addsOneNativeClient: true,
            interpretation: 'Packet delivery and transport counters only; this does not validate audible playback or RF output. Audio or scope may legitimately stop during TX or radio configuration changes.',
            audio: audio.summary(endedAt), scope: scope.summary(endedAt), disconnects: disconnected, managementFailures,
            nativeConnectedAtEnd: Boolean(client.connected), managementAvailableAtEnd: currentAvailable,
            nativeTransportBefore: nativeBefore, nativeTransportAfter: counters(client), nativeTransportDelta: difference(counters(client), nativeBefore),
            serviceBefore: before, serviceAfter: currentAvailable ? latest : null,
            serviceCounterDelta: currentAvailable ? difference(latest, before) : null, bins };
        if (options.output) await writeReport(options.output, report, options.stateDir);
        return report;
    } finally {
        measuring = false;
        await client?.close().catch(() => {});
        await management.logout().catch(() => {});
    }
}
async function main() {
    if (process.argv.includes('--help')) {
        console.log('Usage: node scripts/telemetry-probe.js --host SPLITTER_IPV4 --seconds 60 --label baseline [--output /tmp/report.json]');
        console.log('Optional: --state-dir /var/lib/icom-splitter --web-port 50004 --ca-file CERT --settle-seconds 2');
        console.log('Receive-only; uses protected service credentials, verifies HTTPS and records metadata only.'); return;
    }
    const options = parseOptions(process.argv.slice(2)), report = await runProbe(options);
    console.log(JSON.stringify({ label: report.label, secondsObserved: report.secondsObserved, audio: report.audio, scope: report.scope,
        disconnects: report.disconnects, managementFailures: report.managementFailures, nativeTransportDelta: report.nativeTransportDelta,
        radioPhysicalDelta: report.serviceCounterDelta?.metrics?.physical, outputWritten: Boolean(options.output), receiveOnly: true, txRequested: false, mediaRecorded: false }));
}
if (require.main === module) main().catch(() => { console.error('Telemetry probe failed. Check the private profile, pending settings, HTTPS certificate and splitter availability. No settings or radio commands were sent.'); process.exitCode = 1; });
module.exports = { GapTracker, numericMetadata, managementSummary, difference, parseOptions, runProbe };
