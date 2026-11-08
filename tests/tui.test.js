'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TerminalApp, renderScreen, safe } = require('../src/app/tui');

class Input extends PassThrough {
    constructor() { super(); this.isTTY = true; this.isRaw = false; this.rawChanges = []; }
    setRawMode(value) { this.isRaw = value; this.rawChanges.push(value); }
}
class Output extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.columns = 100; this.rows = 30; this.text = ''; }
    write(text) { this.text += text; }
}
class Controller extends EventEmitter {
    constructor() {
        super(); this.calls = []; this.saved = null; this.tx = false;
        this.fields = [
            { key: 'ICOM_RADIO_HOST', label: 'Radio address', type: 'text', default: '', description: 'IPv4 address of the radio' },
            { key: 'ICOM_USERNAME', label: 'Username', type: 'text', default: '' },
            { key: 'ICOM_PASSWORD', label: 'Password', type: 'password', default: '' },
            { key: 'ICOM_CACHE_ENABLED', label: 'Cache enabled', type: 'boolean', default: '1' },
        ];
        this.values = { ICOM_RADIO_HOST: '', ICOM_USERNAME: '', ICOM_PASSWORD: '', ICOM_CACHE_ENABLED: '1' };
        this.state = { firstRun: true, running: false, status: { radio: { connected: false }, cache: { enabled: true, hits: 2, requests: 10, misses: 8, coalesced: 1, byQuery: {} }, metrics: {} }, clients: [], history: [], events: [], latency: {}, settings: this.getSettings() };
    }
    getFields() { return this.fields; }
    getSettings() { return { values: { ...this.values, ICOM_PASSWORD: '' }, hasPassword: true, credentialProtection: 'owner-only file' }; }
    getState() { return { ...this.state, settings: this.getSettings() }; }
    async initialize() { this.calls.push('initialize'); }
    async saveSettings(values) { this.saved = values; this.values = { ...values, ICOM_PASSWORD: '' }; this.state.pendingChanges = this.state.running; }
    async restoreDefaults() { return { values: { ICOM_RADIO_HOST: '', ICOM_USERNAME: '', ICOM_PASSWORD: '', ICOM_CACHE_ENABLED: '1' } }; }
    async start(options) { this.calls.push(['start', options]); this.state.running = true; this.state.firstRun = false; return this.getState(); }
    async stop(options) { this.calls.push(['stop', options]); if (this.tx && !options.confirmedTx) return { requiresConfirmation: true }; this.state.running = false; return this.getState(); }
    async reconnect(options) { this.calls.push(['reconnect', options]); if (this.tx && !options.confirmedTx) return { requiresConfirmation: true }; this.state.pendingChanges = false; return this.getState(); }
    async close(options) { this.calls.push(['close', options]); if (this.tx && !options.confirmedTx) return { requiresConfirmation: true }; this.closed = true; return this.getState(); }
    diagnosticReport() { return { events: ['safe'], configuration: { ICOM_PASSWORD: '[redacted]' } }; }
}
async function setup(t, overrides = {}) {
    const controller = new Controller(), input = new Input(), output = new Output(), signals = new EventEmitter();
    const app = new TerminalApp({ controller, input, output, signals, ...overrides });
    t.after(async () => { await app.forceClose(); });
    await app.start(); return { app, controller, input, output, signals };
}
const key = (app, name, text = '', more = {}) => app.handleKey(text, { name, ...more });

test('terminal first-run settings support every schema field and keep password hidden', async (t) => {
    const { app, controller, output } = await setup(t);
    assert.equal(app.view, 3);
    for (const [index, value] of ['127.0.0.1', 'operator', 'secretpass'].entries()) {
        app.selection = index; await key(app, 'return'); await app.handleKey(value, { name: value }); await key(app, 'return');
    }
    assert.equal(output.text.includes('secretpass'), false);
    app.selection = 3; await key(app, 'return'); assert.equal(app.draft.ICOM_CACHE_ENABLED, '0');
    await key(app, 's');
    assert.equal(controller.saved.ICOM_PASSWORD, 'secretpass'); assert.equal(controller.saved.ICOM_RADIO_HOST, '127.0.0.1');
    assert.equal(app.draft.ICOM_PASSWORD, '');
    assert.match(output.text, /saved; leave blank to keep/);
});

test('keyboard views, field cancel, defaults and selected save action work without shell commands', async (t) => {
    const { app, controller } = await setup(t);
    await key(app, 'tab'); assert.equal(app.view, 4);
    await key(app, 'tab', '', { shift: true }); assert.equal(app.view, 3);
    await app.handleKey('1', { name: '1' }); assert.equal(app.view, 0);
    await app.handleKey('4', { name: '4' }); app.selection = 0;
    await key(app, 'return'); await app.handleKey('not-saved', {}); await key(app, 'escape');
    assert.equal(app.draft.ICOM_RADIO_HOST, '');
    app.draft.ICOM_RADIO_HOST = 'changed'; await key(app, 'd'); assert.equal(app.draft.ICOM_RADIO_HOST, '');
    assert.equal(controller.saved, null, 'restoring defaults changes the form only');
    app.selection = controller.fields.length; await key(app, 'return'); assert.ok(controller.saved);
    await key(app, 'f6'); assert.equal(controller.state.running, true);
    await key(app, 'f7'); assert.equal(controller.state.running, false);
});

test('reconnect always confirms and cancel preserves the existing connection', async (t) => {
    const { app, controller } = await setup(t); controller.state.running = true; controller.state.pendingChanges = true;
    await key(app, 'f8'); assert.match(app.dialog.text, /Reconnect/);
    await key(app, 'escape'); assert.equal(controller.calls.some((c) => Array.isArray(c) && c[0] === 'reconnect'), false);
    assert.equal(controller.state.running, true); assert.equal(controller.state.pendingChanges, true);
    await key(app, 'f8'); await key(app, 'y', 'y');
    assert.equal(controller.state.pendingChanges, false);
});

test('TX quit confirmation cancel leaves service running and confirm awaits safe close', async (t) => {
    const { app, controller, input, output } = await setup(t); controller.tx = true;
    await key(app, 'q'); assert.equal(app.finished, false); assert.match(app.dialog.text, /Transmission is active or pending/);
    await key(app, 'n', 'n'); assert.equal(controller.closed, undefined); assert.equal(app.finished, false);
    await key(app, 'q'); await key(app, 'return');
    assert.equal(controller.closed, true); assert.equal(app.finished, true); assert.equal(input.isRaw, false);
    assert.ok(output.text.includes('\x1b[?25h\x1b[?1049l'));
    assert.equal(controller.calls.filter((c) => Array.isArray(c) && c[0] === 'close').at(-1)[1].confirmedTx, true);
});

test('RX quit and terminal-loss signals release service and restore original terminal state', async (t) => {
    const { app, controller, input, signals } = await setup(t);
    input.isRaw = true; app.originalRaw = true;
    await app.forceClose(); assert.equal(controller.closed, true); assert.equal(input.isRaw, true);
    assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(input.listenerCount('keypress'), 0); assert.equal(controller.listenerCount('snapshot'), 0);
    const other = await setup(t); await key(other.app, 'q'); assert.equal(other.app.dialog, null); assert.equal(other.app.finished, true);
});

test('initialization failure and shutdown rejection still restore terminal state', async (t) => {
    const controller = new Controller(), input = new Input(), output = new Output(), signals = new EventEmitter();
    controller.initialize = async () => { throw new Error('fixture startup failure'); };
    const app = new TerminalApp({ controller, input, output, signals });
    await assert.rejects(app.start(), /fixture startup/); assert.equal(input.isRaw, false); assert.equal(signals.listenerCount('SIGINT'), 0);
    const other = await setup(t); other.controller.close = async () => { throw new Error('fixture close failure'); };
    await other.app.forceClose(); assert.equal(other.app.finished, true); assert.equal(other.input.isRaw, false);
    assert.equal(other.app.exitError.message, 'Splitter shutdown could not be confirmed.');
});

test('dashboard marks missing/stale measurements honestly and sanitizes terminal control sequences', async (t) => {
    const { app } = await setup(t, { now: () => 20000 }); app.view = 0;
    app.state.latency = { pingMs: 4.2, pingUpdatedAt: 1, responseMs: null, queueMs: null };
    const screen = renderScreen(app, 120, 40);
    assert.match(screen, /4.2 ms \(stale\)/); assert.match(screen, /command response: Unavailable/);
    app.view = 1; app.state.clients = [{ name: '\x1b[31mATTACK\nname', address: '127.0.0.1', streams: {} }];
    const clients = renderScreen(app, 120, 30);
    assert.equal(clients.includes('\x1b[31m'), false); assert.equal(safe('\x1b\n\x07'), '   ');
    assert.ok(renderScreen(app, 25, 10).split('\r\n').every((line) => (line.startsWith('\x1b[H\x1b[2J') ? line.slice(7) : line).length <= 25));
});

test('diagnostic export is explicit, restricted and excludes an unsaved form password', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-tui-report-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { app, controller } = await setup(t, { directory }); app.view = 4; app.draft.ICOM_PASSWORD = 'formsecret';
    await key(app, 'e'); const files = await fs.readdir(directory); assert.equal(files.length, 1);
    const report = await fs.readFile(path.join(directory, files[0]), 'utf8');
    assert.equal(report.includes('formsecret'), false); assert.deepEqual(JSON.parse(report), controller.diagnosticReport());
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
});

test('non-interactive launch refuses a raw terminal interface before initializing radio', async () => {
    const controller = new Controller(); const input = new Input(); input.isTTY = false;
    const app = new TerminalApp({ controller, input, output: new Output(), signals: new EventEmitter() });
    await assert.rejects(app.start(), /interactive terminal/); assert.deepEqual(controller.calls, []);
});

test('failed TX release never produces a success message or silently successful close', async (t) => {
    const { app, controller } = await setup(t);
    controller.close = async () => ({ releaseConfirmed: false, state: controller.getState() });
    await key(app, 'q');
    assert.equal(app.finished, true);
    assert.match(app.exitError.message, /receive state could not be confirmed/);
    const other = await setup(t);
    other.controller.stop = async () => ({ releaseConfirmed: false, state: other.controller.getState() });
    await key(other.app, 'f7'); assert.match(other.app.message, /receive state could not be confirmed/);
    assert.equal(other.app.finished, false);
});

test('failed save redacts a newly entered password before displaying an error', async (t) => {
    const { app, controller, output } = await setup(t);
    app.draft.ICOM_PASSWORD = 'new-secret';
    controller.redact = (message) => message;
    controller.saveSettings = async () => { throw new Error('Cannot save new-secret'); };
    await key(app, 's');
    assert.match(app.message, /\[redacted\]/); assert.equal(output.text.includes('new-secret'), false);
});

test('observed radio RX/TX stays distinct from quiet or pending TX ownership', async (t) => {
    const { app } = await setup(t); app.view = 0;
    app.state.status.radio.connected = true;
    app.state.txActive = true;
    app.state.dashboard = { rxTx: 'RX', txControl: 'Owned or pending' };
    let screen = renderScreen(app, 120, 40);
    assert.match(screen, /Radio state: RX\s+TX control: Owned or pending/);
    assert.equal(screen.includes('TRANSMITTING'), false, 'quiet ownership is not observed transmission');
    app.state.txActive = false;
    app.state.dashboard = { rxTx: 'TX', txControl: 'Available' };
    screen = renderScreen(app, 120, 40);
    assert.match(screen, /Radio state: TX\s+TX control: Available/);
    delete app.state.dashboard;
    screen = renderScreen(app, 120, 40);
    assert.match(screen, /Radio state: Unavailable/);
    assert.equal(screen.includes('Radio state: RX'), false, 'connection alone cannot manufacture observed RX');
});
