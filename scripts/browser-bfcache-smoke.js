'use strict';
// Local-only lifecycle verification with a fresh Chrome profile. Uses the real
// browser bridge, management session/CSRF implementation and no radio hardware.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { createWebServer } = require('../src/web/server');
const { loadAssets } = require('../src/web/assets');
const { ensureTls } = require('../src/web/tls');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (value) return value; await pause(30); }
    throw new Error(`Timed out: ${label}`);
}
class Protocol {
    constructor(socket) {
        this.socket = socket; this.next = 0; this.pending = new Map(); this.events = [];
        socket.addEventListener('message', ({ data }) => {
            const message = JSON.parse(data);
            if (!message.id) { this.events.push(message); return; }
            const pending = this.pending.get(message.id); if (!pending) return;
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
        });
    }
    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
            this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    }
    restored() { return this.events.filter((event) => event.method === 'Runtime.bindingCalled').map((event) => JSON.parse(event.params.payload)).filter((event) => event.persisted); }
}
async function main() {
    const output = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'icom-bfcache-smoke-'));
    const profile = path.join(output, 'chrome-profile');
    const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
    const actions = []; let sequence = 0, relaxedHeaders = false, child, protocol, browser;
    const away = http.createServer((_request, response) => { response.end('<!doctype html><title>Away fixture</title><p>Separate local origin</p>'); });
    const assets = loadAssets();
    // A small subscription surface isolates the bridge lifecycle from layout.
    assets['/index.html'].body = '<!doctype html><title>BFCache bridge fixture</title><output id="sequence">0</output><script defer src="bridge.js"></script><script defer src="renderer.js"></script>';
    assets['/renderer.js'].body = `window.fixtureIdentity = crypto.randomUUID();
        window.addEventListener('pageshow', event => window.recordRestore(JSON.stringify({persisted:event.persisted, identity:window.fixtureIdentity})));
        window.splitter.subscribe(state => document.getElementById('sequence').textContent = String(state.sequence));`;
    const controller = { getState: () => ({ running: true, firstRun: false, sequence: ++sequence }) };
    const tls = await ensureTls({ directory: path.join(output, 'tls'), host: '127.0.0.1', env: {} });
    const web = createWebServer({ controller, host: '127.0.0.1', port: 0, tls, assets, getCredentials: () => ({ username: 'fixture', password: 'fixture-browser-password' }) });
    const dispatch = web.dispatch.bind(web);
    web.dispatch = async (action, payload) => { actions.push(action); return dispatch(action, payload); };
    const handle = web.handle.bind(web);
    web.handle = async (request, response) => {
        const setHeader = response.setHeader.bind(response);
        response.setHeader = (name, value) => setHeader(name, relaxedHeaders && name.toLowerCase() === 'cache-control' ? 'no-cache' : value);
        return handle(request, response);
    };
    try {
        await web.start(); await new Promise((resolve) => away.listen(0, '127.0.0.1', resolve));
        const origin = `https://127.0.0.1:${web.address().port}`, awayOrigin = `http://127.0.0.1:${away.address().port}`;
        child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
        let launchError; child.on('error', (error) => { launchError = error; });
        const port = await until(async () => { if (launchError) throw launchError; try { return (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return false; } }, 'isolated Chrome startup');
        const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin + '/login')}`, { method: 'PUT' })).json();
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        protocol = new Protocol(socket);
        await protocol.send('Page.enable'); await protocol.send('Runtime.enable'); await protocol.send('Runtime.addBinding', { name: 'recordRestore' });
        browser = await protocol.send('Browser.getVersion');
        await until(() => protocol.evaluate("location.pathname === '/login' && document.readyState === 'complete'"), 'fixture login page');
        assert.equal(await protocol.evaluate(`fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture',password:'fixture-browser-password'})}).then(response=>response.json()).then(result=>result.ok)`), true);
        async function openDashboard() {
            await protocol.send('Page.navigate', { url: origin + '/' });
            await until(() => protocol.evaluate("location.pathname === '/' && Number(document.getElementById('sequence')?.textContent) > 0"), 'live fixture dashboard');
        }
        async function leave() {
            const history = await protocol.send('Page.getNavigationHistory'), entry = history.entries[history.currentIndex];
            await protocol.send('Page.navigate', { url: awayOrigin + '/' });
            await until(() => protocol.evaluate(`location.origin === ${JSON.stringify(awayOrigin)}`), 'separate-origin navigation');
            return entry.id;
        }
        await openDashboard();
        const stockIdentity = await protocol.evaluate('window.fixtureIdentity'), stockEntry = await leave();
        await protocol.send('Page.navigateToHistoryEntry', { entryId: stockEntry });
        await until(() => protocol.evaluate("location.pathname === '/' && Number(document.getElementById('sequence')?.textContent) > 0"), 'stock-header history navigation');
        const stockRestored = await protocol.evaluate(`window.fixtureIdentity === ${JSON.stringify(stockIdentity)}`);
        const stockReasons = protocol.events.filter((event) => event.method === 'Page.backForwardCacheNotUsed').map((event) => event.params.notRestoredExplanations);

        // Chrome can evict no-store pages that fetch no-store APIs. Relax only
        // this fixture's headers to independently prove real persisted restores.
        relaxedHeaders = true; await openDashboard();
        const identity = await protocol.evaluate('window.fixtureIdentity'), before = Number(await protocol.evaluate("document.getElementById('sequence').textContent"));
        const checksBefore = web.sessions.size, entry = await leave();
        await protocol.send('Page.navigateToHistoryEntry', { entryId: entry });
        await until(() => protocol.restored().some((event) => event.identity === identity), 'real pageshow.persisted restore');
        await until(async () => Number(await protocol.evaluate("document.getElementById('sequence')?.textContent")) > before, 'polling after persisted restore');
        assert.equal(await protocol.evaluate('window.fixtureIdentity'), identity, 'same cached JS heap must resume');
        assert.equal(web.sessions.size, checksBefore);
        const firstLive = sequence; await pause(1150); assert.ok(sequence > firstLive, 'polling continues after immediate restore refresh');
        const expiredIdentity = await protocol.evaluate('window.fixtureIdentity'), expiredEntry = await leave();
        web.sessions.clear();
        await protocol.send('Page.navigateToHistoryEntry', { entryId: expiredEntry });
        await until(() => protocol.restored().filter((event) => event.identity === expiredIdentity).length >= 2, 'expired session persisted restore');
        await until(() => protocol.evaluate("location.pathname === '/login'"), 'expired session login redirect');
        assert.deepEqual([...new Set(actions)], ['state'], 'navigation/close must never control the radio');
        const liveBeforeClose = sequence;
        await protocol.send('Page.close'); await pause(1150);
        assert.equal(sequence, liveBeforeClose, 'closed browser polling stops'); assert.equal(web.server.listening, true, 'management service remains available');
        const result = { result: 'pass', browser: browser.product, platform: process.platform, stockProductionHeaders: { restored: stockRestored, reasons: stockReasons },
            controlledFixtureHeaders: 'Cache-Control: no-cache, test only; production headers unchanged', persistedPageshowObserved: true, sameHeapRestored: true,
            resumedPolling: true, expiredPersistedSessionRedirect: true, browserCloseKeepsService: true, actions: [...new Set(actions)], physicalRadioUsed: false };
        await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify({ ...result, output }));
    } catch (error) {
        await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ result: 'fail', message: error.message, browser: browser?.product,
            restorations: protocol?.restored(), cacheFailures: protocol?.events.filter((event) => event.method === 'Page.backForwardCacheNotUsed') }, null, 2));
        console.error(`BFCache fixture failed; evidence: ${output}`); throw error;
    } finally {
        if (protocol) { try { await protocol.send('Browser.close'); } catch { /* The page may already be closed. */ } protocol.socket.close(); }
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await web.close(); await new Promise((resolve) => away.close(resolve));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await fs.rm(path.join(output, 'tls'), { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
