'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function bridge(fetch) {
    const listeners = {}, intervals = [], redirected = [];
    const document = { readyState: 'loading', addEventListener: (name, callback) => { listeners[name] = callback; },
        getElementById: () => null, querySelector: () => null };
    const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
    const context = { window, document, location: { origin: 'https://splitter.example', replace: (url) => redirected.push(url) }, fetch,
        setTimeout: () => {}, clearInterval: () => {}, setInterval: (callback) => { intervals.push(callback); return 1; },
        console, URL, Blob, MutationObserver: class { observe() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/web/bridge.js'), 'utf8'), context);
    return { api: window.splitter, listeners, intervals, redirected, context };
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
