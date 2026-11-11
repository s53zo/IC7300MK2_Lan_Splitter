'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function bridge(fetch) {
    const listeners = {}, intervals = [], redirected = [], cleared = [];
    const document = { readyState: 'loading', addEventListener: (name, callback) => { listeners[name] = callback; },
        getElementById: () => null, querySelector: () => null };
    const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
    const context = { window, document, location: { origin: 'https://splitter.example', replace: (url) => redirected.push(url) }, fetch,
        setTimeout: () => {}, clearInterval: (timer) => cleared.push(timer), setInterval: (callback) => { intervals.push(callback); return intervals.length; },
        console, URL, Blob, MutationObserver: class { observe() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/web/bridge.js'), 'utf8'), context);
    return { api: window.splitter, listeners, intervals, redirected, cleared, context };
}
const response = (value, status = 200) => ({ status, json: async () => value });

test('browser requests wait for authenticated session and send in-memory CSRF without storing credentials', async () => {
    const calls = []; let release;
    const session = new Promise((resolve) => { release = resolve; });
    const b = bridge(async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/session') return session;
        return response({ ok: true, value: ['field'] });
    });
    const pending = b.api.request('fields');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/session');
    release(response({ ok: true, value: { authenticated: true, csrfToken: 'token-only-in-memory' } }));
    assert.equal((await pending).ok, true);
    assert.equal(calls[1].options.headers['X-CSRF-Token'], 'token-only-in-memory');
    assert.equal(calls[1].options.credentials, 'same-origin');
    assert.equal(calls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'fields' });
    assert.equal(b.context.window.csrfToken, undefined);
    assert.equal('localStorage' in b.context, false); assert.equal('sessionStorage' in b.context, false);
});

test('BFCache restore revalidates the session and resumes one polling timer with fresh CSRF', async () => {
    const calls = []; let sessions = 0, releaseSession;
    const b = bridge(async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/session') {
            if (++sessions === 2) return new Promise((resolve) => { releaseSession = resolve; });
            return response({ ok: true, value: { authenticated: true, csrf: 'old-csrf' } });
        }
        return response({ ok: true, value: { sequence: calls.length } });
    });
    const snapshots = []; b.api.subscribe((value) => snapshots.push(value));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 1);
    b.listeners.pagehide({ persisted: true });
    b.listeners.pageshow({ persisted: true });
    const action = b.api.request('fields');
    assert.equal(calls.filter((call) => call.url === '/api/request').length, 1, 'actions wait for restored authentication');
    releaseSession(response({ ok: true, value: { authenticated: true, csrf: 'fresh-csrf' } }));
    assert.equal((await action).ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 2);
    assert.equal(b.intervals.length, 2, 'one replacement interval is created');
    assert.ok(b.cleared.includes(1));
    assert.ok(calls.filter((call) => call.url === '/api/request').slice(1).every((call) => call.options.headers['X-CSRF-Token'] === 'fresh-csrf'));
    await b.intervals[1](); assert.equal(snapshots.length, 3);
    b.listeners.pageshow({ persisted: false }); assert.equal(sessions, 2, 'ordinary pageshow does not duplicate session checks');
    assert.deepEqual(b.redirected, []);
});

test('BFCache restore of an expired session redirects without resuming requests or controlling the radio', async () => {
    const actions = []; let sessions = 0;
    const b = bridge(async (url, options) => {
        if (url === '/api/session') return response({ ok: true, value: { authenticated: ++sessions === 1, csrf: 'csrf' } });
        actions.push(JSON.parse(options.body).action); return response({ ok: true, value: {} });
    });
    b.api.subscribe(() => {}); await new Promise((resolve) => setImmediate(resolve));
    b.listeners.pagehide({ persisted: true }); b.listeners.pageshow({ persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(b.redirected, ['/login']); assert.ok(b.cleared.includes(2), 'expired authentication clears the restore retry timer');
    assert.equal((await b.api.request('start')).ok, false);
    assert.deepEqual(actions, ['state']);
});

test('a transient restored-session failure retries authentication before polling resumes', async () => {
    const tokens = []; let sessions = 0;
    const b = bridge(async (url, options) => {
        if (url === '/api/session') {
            if (++sessions === 2) throw new Error('Temporary network failure');
            return response({ ok: true, value: { authenticated: true, csrf: sessions === 1 ? 'old-csrf' : 'restored-csrf' } });
        }
        tokens.push(options.headers['X-CSRF-Token']); return response({ ok: true, value: { running: true } });
    });
    const snapshots = []; b.api.subscribe((value) => snapshots.push(value));
    await new Promise((resolve) => setImmediate(resolve));
    b.listeners.pagehide({ persisted: true }); b.listeners.pageshow({ persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessions, 2); assert.equal(snapshots.length, 1, 'failed authentication check cannot send state requests');
    assert.equal(b.intervals.length, 2, 'a bounded interval remains available to retry');
    await b.intervals[1]();
    assert.equal(sessions, 3); assert.equal(snapshots.length, 2);
    assert.deepEqual(tokens, ['old-csrf', 'restored-csrf']); assert.deepEqual(b.redirected, []);
});

test('in-flight pre-navigation state cannot overwrite the restored page', async () => {
    let requests = 0, releaseOld;
    const b = bridge(async (url) => {
        if (url === '/api/session') return response({ ok: true, value: { authenticated: true, csrf: 'csrf' } });
        if (++requests === 1) return new Promise((resolve) => { releaseOld = resolve; });
        return response({ ok: true, value: { sequence: 'fresh' } });
    });
    const snapshots = []; b.api.subscribe((value) => snapshots.push(value));
    await new Promise((resolve) => setImmediate(resolve));
    b.listeners.pagehide({ persisted: true }); b.listeners.pageshow({ persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    releaseOld(response({ ok: true, value: { sequence: 'stale' } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 0);
    await b.intervals.at(-1)(); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].sequence, 'fresh');
});

test('browser close never sends a radio/service shutdown request', async () => {
    const calls = [];
    const b = bridge(async (url) => { calls.push(url); return response({ ok: true, value: { authenticated: true, csrf: 'csrf' } }); });
    assert.equal((await b.api.request('close')).ok, false);
    b.api.onCloseConfirmation(() => { throw new Error('Browser must not register native close control'); });
    b.listeners.pagehide();
    assert.deepEqual(calls, ['/api/session']);
});

test('unauthenticated sessions and expired cookies redirect to same-origin sign-in', async () => {
    const b = bridge(async () => response({ ok: true, value: { authenticated: false, setupRequired: true } }));
    assert.equal((await b.api.request('state')).ok, false); assert.deepEqual(b.redirected, ['/login']);
    let first = true;
    const expired = bridge(async () => { if (first) { first = false; return response({ ok: true, value: { authenticated: true, csrf: 'csrf' } }); }
        return response({ ok: false, error: 'Session expired' }, 401); });
    assert.equal((await expired.api.request('state')).ok, false); assert.deepEqual(expired.redirected, ['/login']);
});

test('state polling remains one request at a time and stops when the browser closes', async () => {
    let resolveState, stateCalls = 0;
    const b = bridge(async (url) => {
        if (url === '/api/session') return response({ ok: true, value: { authenticated: true, csrf: 'csrf' } });
        stateCalls++; return new Promise((resolve) => { resolveState = resolve; });
    });
    const snapshots = []; b.api.subscribe((value) => snapshots.push(value));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stateCalls, 1);
    await b.intervals[0](); assert.equal(stateCalls, 1, 'pending poll must not overlap');
    resolveState(response({ ok: true, value: { running: true } })); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 1); b.listeners.pagehide(); await b.intervals[0](); assert.equal(stateCalls, 1);
});

test('403 only redirects after a session check proves authentication has expired', async () => {
    for (const authenticated of [false, true]) {
        let checks = 0;
        const b = bridge(async (url) => url === '/api/session'
            ? response({ ok: true, value: { authenticated: ++checks === 1 || authenticated, csrf: 'csrf' } })
            : response({ ok: false, error: 'Refresh management and try again' }, 403));
        const result = await b.api.request('state'); assert.equal(result.ok, false); assert.equal(checks, 2);
        assert.deepEqual(b.redirected, authenticated ? [] : ['/login']);
    }
});

test('browser password import reads bounded local contents without uploading a server filepath', async () => {
    for (const size of [9, 65]) {
        const calls = [], password = { value: 'unchanged' }, source = { value: '' }; let reads = 0, removed = false;
        const b = bridge(async (url) => { calls.push(url); return response({ ok: true, value: { authenticated: true, csrf: 'csrf' } }); });
        b.context.document.getElementById = (id) => id === 'ICOM_PASSWORD' ? password : id === 'ICOM_PASSWORD_FILE' ? source : null;
        b.context.document.body = { append() {} };
        b.context.document.createElement = () => {
            const events = {};
            return { files: [{ size, text: async () => { reads++; return 'testpass\n'; } }], addEventListener: (name, callback) => { events[name] = callback; },
                remove: () => { removed = true; }, click: () => { void events.change(); } };
        };
        const result = await b.api.request('password-file');
        assert.equal(result.ok, size <= 64); assert.equal(password.value, size <= 64 ? 'testpass' : 'unchanged');
        assert.equal(source.value, ''); assert.equal(reads, size <= 64 ? 1 : 0); assert.equal(removed, true);
        assert.deepEqual(calls, ['/api/session']);
    }
});
