'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const COOKIE = '__Host-icom_splitter';
const MAX_BODY = 32768;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const STATIC_PATHS = new Set(['/', '/index.html', '/styles.css', '/renderer.js', '/bridge.js', '/login', '/login.html', '/login.js', '/login.css', '/favicon.svg']);
const READ_ACTIONS = new Set(['state', 'settings', 'fields', 'interfaces', 'defaults', 'export']);
const ACTIONS = new Set([...READ_ACTIONS, 'save', 'start', 'stop', 'reconnect']);
const randomToken = () => randomBytes(32).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest();
const equals = (left, right) => timingSafeEqual(hash(String(left)), hash(String(right)));
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function hostname(value) {
    if (typeof value !== 'string' || !value || /[\s/@\\?#]/.test(value)) return null;
    try {
        const url = new URL(`https://${value}`);
        if (url.pathname !== '/' || url.username || url.password) return null;
        return url.hostname.toLowerCase().replace(/\.$/, '');
    } catch { return null; }
}
function requestPath(value) {
    if (!value || !value.startsWith('/') || value.startsWith('//')) fail(400, 'Invalid request path');
    let decoded;
    try { decoded = decodeURIComponent(value.split('?')[0]); } catch { fail(400, 'Invalid request path'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) fail(404, 'Not found');
    return decoded;
}
function readJson(request) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) fail(415, 'Use application/json');
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) fail(413, 'Request body is too large');
    return new Promise((resolve, reject) => {
        let length = 0, complete = false;
        const chunks = [];
        request.on('data', (chunk) => {
            if (complete) return;
            length += chunk.length;
            if (length > MAX_BODY) { complete = true; chunks.length = 0; reject(Object.assign(new Error('Request body is too large'), { status: 413 })); return; }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (complete) return;
            complete = true;
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
                resolve(value);
            } catch { reject(Object.assign(new Error('Request body must be a JSON object'), { status: 400 })); }
        });
        request.on('error', () => { if (!complete) { complete = true; reject(Object.assign(new Error('Request could not be read'), { status: 400 })); } });
        request.on('aborted', () => { if (!complete) { complete = true; reject(Object.assign(new Error('Request was interrupted'), { status: 400 })); } });
    });
}
class WebServer {
    constructor({ controller, host = '127.0.0.1', port = 50004, tls, assets = {}, allowedHosts = [], allowInsecureLoopback = false,
        getCredentials, now = () => Date.now() } = {}) {
        if (!controller || typeof controller.getState !== 'function') throw new Error('A local application controller is required');
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid management port');
        if (!net.isIP(host)) throw new Error('Management bind address must be an IP address');
        this.secure = Boolean(tls?.key && tls?.cert);
        if (!this.secure && !(allowInsecureLoopback === true && ['127.0.0.1', '::1'].includes(host))) throw new Error('HTTPS is required for management');
        if (!Array.isArray(allowedHosts)) throw new Error('Allowed management hosts must be an array');
        this.allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase().replace(/\.$/, ''),
            ...Object.values(os.networkInterfaces()).flat().filter((entry) => entry.family === 'IPv4').map((entry) => entry.address)]);
        if (!['0.0.0.0', '::'].includes(host)) this.allowedHosts.add(host.includes(':') ? `[${host}]` : host);
        for (const value of allowedHosts) {
            const name = hostname(value);
            if (!name || value.includes(':') && !value.startsWith('[')) throw new Error('Invalid allowed management hostname');
            this.allowedHosts.add(name);
        }
        this.controller = controller; this.host = host; this.port = port; this.now = now;
        this.getCredentials = getCredentials || (() => ({ username: controller.values?.ICOM_USERNAME || '', password: controller.password || '', setupRequired: false }));
        this.assets = assets;
        this.sessions = new Map(); this.loginRates = new Map(); this.globalLogins = { at: now(), count: 0 };
        this.activeRequests = 0; this.inFlight = new Set();
        const listener = (request, response) => { void this.handle(request, response); };
        this.server = this.secure ? https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, listener)
            : http.createServer({ maxHeaderSize: 8192 }, listener);
        this.server.requestTimeout = 10000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
        this.server.maxConnections = 64; this.server.maxRequestsPerSocket = 100;
        this.server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    }
    async start() {
        if (this.started) return this;
        await new Promise((resolve, reject) => {
            const error = (reason) => { this.server.off('listening', listening); reject(reason); };
            const listening = () => { this.server.off('error', error); resolve(); };
            this.server.once('error', error); this.server.once('listening', listening); this.server.listen(this.port, this.host);
        });
        this.started = true;
        this.timer = setInterval(() => this.prune(), 60000); this.timer.unref();
        return this;
    }
    address() { return this.server.address(); }
    async close() {
        clearInterval(this.timer); this.sessions.clear(); this.loginRates.clear();
        if (!this.started) return;
        this.started = false;
        await new Promise((resolve) => { this.server.close(resolve); this.server.closeAllConnections(); });
    }
    prune() {
        const now = this.now();
        for (const [key, session] of this.sessions) if (now - session.lastSeen >= SESSION_IDLE_MS || now - session.createdAt >= SESSION_ABSOLUTE_MS) this.sessions.delete(key);
        for (const [key, rate] of this.loginRates) if (now - rate.at >= 60000) this.loginRates.delete(key);
    }
    async credentials() {
        const value = await this.getCredentials();
        const username = typeof value?.username === 'string' ? value.username : '';
        const password = typeof value?.password === 'string' ? value.password : '';
        return { username, password, setupRequired: value?.setupRequired === true,
            version: hash(`${username}\0${password}`).toString('hex') };
    }
    origin(request) {
        if (request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) fail(403, 'Unrecognized management host');
        const host = request.headers.host;
        const name = hostname(host);
        if (!name || !this.allowedHosts.has(name)) fail(403, 'Unrecognized management host');
        const url = new URL(`${this.secure ? 'https' : 'http'}://${host}`);
        const expectedPort = Number(url.port || (this.secure ? 443 : 80));
        if (expectedPort !== this.address()?.port) fail(403, 'Unrecognized management port');
        return url.origin;
    }
    sameOrigin(request, expected) {
        if (request.headers.origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Open management from its own address before making changes');
    }
    cookie(request) {
        const values = String(request.headers.cookie || '').split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${COOKIE}=`));
        if (values.length !== 1) return null;
        const token = values[0].slice(COOKIE.length + 1);
        return /^[a-f0-9]{64}$/.test(token) ? token : null;
    }
    session(request, credentials) {
        this.prune();
        const token = this.cookie(request), session = token && this.sessions.get(token);
        if (!session) return null;
        if (!equals(session.version, credentials.version)) { this.sessions.delete(token); return null; }
        session.lastSeen = this.now(); return { token, ...session };
    }
    rateLogin(request) {
        this.prune(); const time = this.now(), key = request.socket.remoteAddress;
        if (time - this.globalLogins.at >= 60000) this.globalLogins = { at: time, count: 0 };
        if (++this.globalLogins.count > 60) fail(429, 'Too many login attempts. Try again later.');
        if (!this.loginRates.has(key)) {
            if (this.loginRates.size >= 128) this.loginRates.delete(this.loginRates.keys().next().value);
            this.loginRates.set(key, { at: time, count: 0 });
        }
        if (++this.loginRates.get(key).count > 5) fail(429, 'Too many login attempts. Try again in a minute.');
    }
    json(response, status, value, headers = {}) {
        if (response.destroyed || response.writableEnded) return;
        const body = Buffer.from(JSON.stringify(value));
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...headers }); response.end(body);
    }
    safe(value, credentials) {
        value = this.controller.redact?.(value) ?? value;
        return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' && credentials.password ? item.split(credentials.password).join('[redacted]') : item));
    }
    validateAction(body) {
        if (Object.keys(body).some((key) => !['action', 'payload'].includes(key)) || !ACTIONS.has(body.action)) fail(400, 'Unsupported management action');
        const payload = body.payload;
        if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) fail(400, 'Invalid action payload');
        if (body.action === 'save') {
            const values = payload?.values || payload;
            if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, 'Settings must be an object');
            if (payload.values && Object.keys(payload).some((key) => key !== 'values')) fail(400, 'Unsupported settings fields');
            const keys = new Set(this.controller.getFields().map((field) => field.key));
            for (const [key, value] of Object.entries(values)) {
                if (!keys.has(key)) fail(400, 'Unsupported settings fields');
                if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Invalid settings value');
                if (typeof value === 'string' && value.length > 4096) fail(400, 'Settings value is too long');
            }
            if (Object.hasOwn(values, 'ICOM_PASSWORD_FILE') && values.ICOM_PASSWORD_FILE !== '') fail(400, 'Import password files through this browser, not a server file path');
        } else if (['start', 'stop', 'reconnect'].includes(body.action)) {
            if (Object.keys(payload || {}).some((key) => key !== 'confirmedTx') || payload?.confirmedTx !== undefined && typeof payload.confirmedTx !== 'boolean') fail(400, 'Invalid action options');
        } else if (Object.keys(payload || {}).length) fail(400, 'This action takes no options');
    }
    async dispatch(action, payload) {
        const controller = this.controller;
        switch (action) {
        case 'state': return controller.getState();
        case 'settings': return { ...controller.getSettings(), configDirectory: controller.directory, interfaces: controller.getNetworkInterfaces() };
        case 'fields': return controller.getFields();
        case 'interfaces': return controller.getNetworkInterfaces();
        case 'defaults': return Object.fromEntries(controller.getFields().map((field) => [field.key, field.default ?? '']));
        case 'save': return controller.saveSettings(payload);
        case 'start': return controller.start();
        case 'stop': return controller.stop({ confirmedTx: payload?.confirmedTx === true });
        case 'reconnect': return controller.reconnect({ confirmedTx: payload?.confirmedTx === true });
        case 'export': return controller.diagnosticReport();
        default: fail(400, 'Unsupported management action');
        }
    }
    async handle(request, response) {
        const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
        for (const [key, value] of Object.entries({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': csp, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' })) response.setHeader(key, value);
        let credentials;
        try {
            if (++this.activeRequests > 64) fail(429, 'Management is busy. Try again shortly.');
            const expectedOrigin = this.origin(request), pathname = requestPath(request.url);
            if (request.method === 'GET' && STATIC_PATHS.has(pathname)) {
                const canonical = pathname === '/' ? '/index.html' : pathname === '/login' ? '/login.html' : pathname;
                const asset = this.assets[canonical] || this.assets[pathname];
                if (!asset || typeof asset.body !== 'string' && !Buffer.isBuffer(asset.body)) fail(404, 'Not found');
                const body = Buffer.isBuffer(asset.body) ? asset.body : Buffer.from(String(asset.body));
                response.writeHead(200, { 'Content-Type': asset.contentType || 'application/octet-stream', 'Content-Length': body.length }); response.end(body); return;
            }
            if (!['/api/session', '/api/login', '/api/logout', '/api/request'].includes(pathname)) fail(404, 'Not found');
            credentials = await this.credentials();
            if (pathname === '/api/session' && request.method === 'GET') {
                const session = this.session(request, credentials);
                this.json(response, 200, { ok: true, value: session ? { authenticated: true, csrfToken: session.csrf, csrf: session.csrf, setupRequired: credentials.setupRequired }
                    : { authenticated: false, setupRequired: credentials.setupRequired } }); return;
            }
            if (request.method !== 'POST') fail(405, 'Use POST for this management action');
            this.sameOrigin(request, expectedOrigin);
            if (pathname === '/api/login') {
                this.rateLogin(request); const body = await readJson(request);
                if (Object.keys(body).some((key) => !['username', 'password'].includes(key)) || typeof body.username !== 'string' || typeof body.password !== 'string'
                    || body.username.length > 64 || body.password.length > 256) fail(400, 'Enter a username and password');
                const usernameMatches = equals(body.username, credentials.username), passwordMatches = equals(body.password, credentials.password);
                if (!credentials.username || !credentials.password || !usernameMatches || !passwordMatches) fail(403, 'Username or password is incorrect');
                const previous = this.cookie(request); if (previous) this.sessions.delete(previous);
                this.prune(); if (this.sessions.size >= 16) fail(429, 'Too many management sessions. Sign out of another browser or try again later.');
                const token = randomToken(), csrf = randomToken(), time = this.now();
                this.sessions.set(token, { csrf, createdAt: time, lastSeen: time, version: credentials.version, windowAt: time, requests: 0, inFlight: new Set() });
                this.json(response, 200, { ok: true, value: { authenticated: true, csrfToken: csrf, csrf, setupRequired: credentials.setupRequired } },
                    { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400` }); return;
            }
            const session = this.session(request, credentials);
            if (!session) fail(403, 'Sign in to manage this splitter');
            if (!request.headers['x-csrf-token'] || !equals(request.headers['x-csrf-token'], session.csrf)) fail(403, 'Refresh management and try again');
            const body = await readJson(request);
            if (pathname === '/api/logout') {
                if (Object.keys(body).length) fail(400, 'This action takes no options');
                this.sessions.delete(session.token);
                this.json(response, 200, { ok: true, value: { authenticated: false } }, { 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` }); return;
            }
            this.validateAction(body);
            const stored = this.sessions.get(session.token), time = this.now();
            if (time - stored.windowAt >= 10000) { stored.windowAt = time; stored.requests = 0; }
            if (++stored.requests > 60) fail(429, 'Too many management requests. Try again shortly.');
            const mutating = !READ_ACTIONS.has(body.action);
            // Stop and corrected settings must remain available while an
            // unreachable radio keeps Start pending. Bound each action instead
            // of serializing every mutation behind that connection attempt.
            if (mutating && (stored.inFlight.has(body.action) || this.inFlight.has(body.action))) fail(429, 'This management change is already in progress');
            if (mutating) { stored.inFlight.add(body.action); this.inFlight.add(body.action); }
            try {
                const value = await this.dispatch(body.action, body.payload);
                if (body.action === 'save') {
                    const updated = await this.credentials();
                    stored.version = updated.version;
                    for (const [key, other] of this.sessions) if (key !== session.token && !equals(other.version, updated.version)) this.sessions.delete(key);
                    credentials = updated;
                }
                this.json(response, 200, { ok: true, value: this.safe(value, credentials) });
            } finally { if (mutating) { stored.inFlight.delete(body.action); this.inFlight.delete(body.action); } }
        } catch (error) {
            const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
            const message = credentials ? this.safe(String(error.message || 'Management action failed'), credentials) : 'Management request could not be completed';
            if (status === 413) { response.setHeader('Connection', 'close'); response.once('finish', () => request.destroy()); }
            this.json(response, status, { ok: false, error: message });
        } finally { --this.activeRequests; }
    }
}
function createWebServer(options) { return new WebServer(options); }
module.exports = { createWebServer };
