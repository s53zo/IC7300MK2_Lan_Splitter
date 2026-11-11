'use strict';

// The terminal interface owns only its local AppController. No shell commands,
// remote administration endpoints, packet contents or credentials are rendered.
const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const VIEWS = ['Dashboard', 'Clients', 'Cache', 'Settings', 'Diagnostics'];
const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
const safe = (value) => Array.from(String(value ?? ''), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
}).join('');
const number = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : 'Unavailable';
const ms = (value) => Number.isFinite(value) ? `${number(value)} ms` : 'Unavailable';
function duration(value) {
    if (!Number.isFinite(value)) return 'Unavailable';
    const seconds = Math.max(0, Math.floor(value / 1000));
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}
function spark(values, width = 30) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return 'No samples yet';
    const samples = [];
    const size = Math.ceil(finite.length / width);
    for (let i = 0; i < finite.length; i += size) {
        const bucket = finite.slice(i, i + size);
        samples.push(bucket.reduce((sum, value) => sum + value, 0) / bucket.length);
    }
    const maximum = Math.max(1, ...samples);
    return samples.map((value) => ' .:-=+*#%@'[Math.min(9, Math.floor(Math.max(0, value) / maximum * 9))]).join('');
}
function schemaType(field) { return field.type === 'boolean' || field.type === 'checkbox' ? 'boolean' : field.type; }
function displayValue(field, value, hasPassword) {
    if (field.key === 'ICOM_PASSWORD' || field.type === 'password') return value ? '********' : hasPassword ? '(saved; leave blank to keep)' : '(not saved)';
    if (schemaType(field) === 'boolean') return value === true || value === '1' || value === 1 ? 'On' : 'Off';
    if (schemaType(field) === 'optional-number' && String(value ?? '').trim() === '') return '(family default)';
    return safe(value) || '(not set)';
}
function statusOf(state) { return state.status || {}; }
function cacheOf(state) { return statusOf(state).cache || state.cache || {}; }
function querySetting(cache, key) {
    const setting = cache.querySettings?.find((row) => row.key === key.toLowerCase());
    return setting ? setting.effectiveMs === 0 ? 'off' : String(setting.effectiveMs) : '—';
}
function metricsOf(state) { return statusOf(state).metrics || state.metrics || {}; }
function contentLines(app) {
    const s = app.state || {}, status = statusOf(s), cache = cacheOf(s), metrics = metricsOf(s);
    if (app.view === 0) {
        const clients = s.clients || [], rates = s.rates || {}, latency = s.latency || {};
        const connected = status.radio?.connected && status.broker?.ready;
        const pingStale = latency.pingUpdatedAt != null && app.now() - latency.pingUpdatedAt > 10000;
        const physical = metrics.physicalTotal;
        return [
            s.firstRun ? 'WELCOME — Set up your radio in Settings (press 4).' : `Radio: ${s.connecting ? 'Connecting...' : connected ? 'Connected' : s.running ? 'Connecting / reconnecting' : 'Stopped'}`,
            `Radio state: ${['RX', 'TX'].includes(s.dashboard?.rxTx) ? s.dashboard.rxTx : 'Unavailable'}    TX control: ${safe(s.dashboard?.txControl) || 'Unavailable'}`,
            `Clients: ${clients.length}    Upstream sessions: ${number(status.connectedUpstreamSessions, 0)}`,
            `Uptime: ${duration(s.uptimeMs)}    Queue: ${number(status.broker?.queueDepth, 0)} requests`,
            '', 'LIVE PERFORMANCE',
            `Radio ping RTT: ${ms(latency.pingMs)}${pingStale ? ' (stale)' : ''}`,
            `Radio command response: ${ms(latency.responseMs)}    Queue wait: ${ms(latency.queueMs)}`,
            'Ping, command response and queue wait are separate gateway measurements.',
            '', `Client requests: ${number(rates.requestsPerSecond)} /s    Radio transactions: ${number(rates.radioPerSecond)} /s`,
            `Cache hits: ${number(cache.hits, 0)} / ${number(cache.requests, 0)} eligible requests (${number(cache.requests ? 100 * cache.hits / cache.requests : null)}%)`,
            `Client requests answered locally: ${number(cache.hits, 0)}    Physical radio transactions: ${number(physical, 0)}`,
            '', 'SESSION HISTORY — last 15 minutes; resets when this interface closes',
            `Requests/s  ${spark((s.history || []).map((sample) => sample.requestsPerSecond))}`,
            `Radio/s     ${spark((s.history || []).map((sample) => sample.radioPerSecond))}`,
            `Cache hit % ${spark((s.history || []).map((sample) => sample.hitPercent))}`,
            '', `Audio transport: lost ${number(metrics.transport?.audio?.lost, 0)}, late/stale ${number(metrics.transport?.audio?.stale, 0)}`,
            'Transport health does not measure audible playback or end-to-end audio delay.',
        ];
    }
    if (app.view === 1) {
        const clients = s.clients || [];
        return ['CONNECTED CLIENTS', '', ...(clients.length ? clients.flatMap((client, index) => [
            `${index + 1}. ${safe(client.name) || 'Unnamed client'} — ${safe(client.address) || 'Unknown address'}${client.txOwner ? ' [TX OWNER]' : ''}`,
            `   Connected ${duration(client.connectedMs)} | CI-V ${client.civReady ? 'ready' : 'waiting'} | Audio ${client.audioReady ? 'ready' : 'waiting'}`,
            ...['control', 'civ', 'audio'].map((role) => {
                const stream = client.streams?.[role];
                return `   ${role}: ${stream?.ready ? 'ready' : 'waiting'}, last activity ${ms(stream?.lastActivityMs)} ago, lost ${number(stream?.counters?.lost, 0)}, replayed ${number(stream?.counters?.replayed, 0)}`;
            }), '',
        ]) : ['No clients connected.'])];
    }
    if (app.view === 2) {
        const ttl = cache.ttlMs || {};
        const rows = Object.entries(cache.byQuery || {}).sort(([a], [b]) => a.localeCompare(b));
        const telemetry = status.telemetry;
        const sampling = telemetry ? ['', `Shared telemetry: ${telemetry.enabled ? 'On' : telemetry.requested ? 'Paused by global cache disable' : 'Off'}`,
            'Background reads still count as radio traffic; local answers are not net savings.',
            ...telemetry.querySettings.map((q) => `${q.key.toUpperCase()} refresh ${q.intervalMs}ms | max age ${q.maxAgeMs}ms | age ${ms(q.sampleAgeMs)} | reads ${q.rfPolls} local ${q.localAnswers} fallback ${q.fallbacks}`)] : [];
        return ['CACHE — current interface session', '',
            `Enabled: ${cache.enabled === true ? 'Yes' : cache.enabled === false ? 'No' : 'Unavailable'}    Entries: ${number(cache.entries, 0)}`,
            `Eligible requests ${number(cache.requests, 0)} | Hits ${number(cache.hits, 0)} | Misses ${number(cache.misses, 0)}`,
            `Hit percentage: ${number(cache.requests ? 100 * cache.hits / cache.requests : null)}% of eligible client requests`,
            `Coalesced: ${number(cache.coalesced, 0)} (included in hits, not additional savings)`,
            `Client requests answered locally: ${number(cache.hits, 0)} | Physical radio transactions: ${number(metrics.physicalTotal, 0)}`,
            `Family defaults: meters/ADC ${ms(ttl.meters)}, RX/TX/tuner ${ms(ttl.state)}, settings ${ms(ttl.settings)}, tuning ${ms(ttl.tuning)}`,
            ...sampling,
            '', 'QUERY        REQUESTS      HITS      MISSES      COALESCED    TTL ms',
            ...rows.map(([query, count]) => `${safe(query).padEnd(12)} ${number(count.requests, 0).padStart(8)} ${number(count.hits, 0).padStart(9)} ${number(count.misses, 0).padStart(11)} ${number(count.coalesced, 0).padStart(12)} ${querySetting(cache, query).padStart(9)}`),
            ...(!rows.length ? ['No eligible client queries yet.'] : []),
        ];
    }
    if (app.view === 3) {
        const fields = app.fields, settings = s.settings || {};
        const rows = fields.map((field, index) => `${index === app.selection ? '>' : ' '} ${safe(field.label || field.key)}: ${displayValue(field, app.draft[field.key], settings.hasPassword)}`);
        rows.push(`${app.selection === fields.length ? '>' : ' '} [ Save settings ]`, `${app.selection === fields.length + 1 ? '>' : ' '} [ Restore defaults ]`);
        return ['SETTINGS — saved separately from the active connection',
            s.firstRun ? 'First launch: enter radio address, username and password, then save and press F6.' : 'Edit with Enter. Save keeps the active connection running. F8 applies after confirmation.',
            `Password storage: ${safe(settings.credentialProtection) || 'See platform documentation'}`, '', ...rows];
    }
    return ['DIAGNOSTICS — no passwords or packet contents', '',
        `Current error: ${safe(s.lastError || s.error) || 'None'}`,
        `Radio reply timeouts: ${number(metrics.radioTimeouts, 0)} | Send failures: ${number(metrics.physicalSendErrors, 0)}`,
        '', 'Press E to export a diagnostic report to the local settings directory.', '',
        ...(s.events || []).slice(-100).map((event) => `${safe(event.time)} [${safe(event.level || 'info')}] ${safe(event.message)}`),
        ...(!(s.events || []).length ? ['No recent events.'] : [])];
}
function renderScreen(app, columns = 100, rows = 30) {
    const width = Math.max(20, columns), height = Math.max(8, rows);
    const lines = [];
    lines.push('IC-7300MK2 LAN SPLITTER — local service');
    lines.push(VIEWS.map((view, index) => `${index === app.view ? '[' : ' '}${index + 1} ${view}${index === app.view ? ']' : ' '}`).join(' '));
    const s = app.state || {};
    lines.push(s.pendingChanges ? 'PENDING CHANGES — F8 reconnects after confirmation; current settings remain active.' : 'Settings saved locally • history kept only for this session');
    const content = contentLines(app);
    const room = Math.max(1, height - 8);
    let offset = Math.min(app.scroll, Math.max(0, content.length - room));
    if (app.view === 3) {
        const target = app.selection + 4;
        if (target < offset) offset = target;
        if (target >= offset + room) offset = target - room + 1;
        app.scroll = Math.max(0, offset);
    }
    lines.push(...content.slice(offset, offset + room));
    while (lines.length < height - 5) lines.push('');
    if (app.editing) {
        const f = app.fields[app.selection];
        const text = f?.key === 'ICOM_PASSWORD' || f?.type === 'password' ? '*'.repeat(app.editing.value.length) : safe(app.editing.value);
        lines.push(`EDIT ${safe(f?.label || f?.key)}: ${text}`);
        lines.push('Enter accepts this field • Esc cancels • Ctrl+U clears');
    } else if (app.dialog) {
        lines.push(app.dialog.text); lines.push('Y / Enter confirms • N / Esc cancels');
    } else {
        const field = app.view === 3 ? app.fields[app.selection] : null;
        lines.push(field ? safe(`${field.group || 'Settings'}: ${field.description || ''}`) : 'Tab / 1–5 views • Up/Down scroll • Settings: Enter edit, S save, D defaults');
        lines.push(safe(app.message) || 'F6 Start • F7 Stop • F8 Reconnect • F10 / Q Quit • Diagnostics: E export');
    }
    lines.push('Closing this interface stops its splitter and disconnects clients.');
    return '\x1b[H\x1b[2J' + lines.slice(0, height).map((line) => safe(line).slice(0, width)).join('\r\n');
}

class TerminalApp {
    constructor(options = {}) {
        this.input = options.input || process.stdin; this.output = options.output || process.stdout;
        this.signals = options.signals || process; this.now = options.now || Date.now;
        this.controller = options.controller;
        this.options = options; this.fields = []; this.state = {}; this.draft = {};
        this.view = 0; this.selection = 0; this.scroll = 0; this.message = ''; this.editing = null; this.dialog = null;
        this.dirty = false; this.finished = false; this.started = false; this.closing = false;
        this.done = new Promise((resolve) => { this.resolve = resolve; });
        this.onSnapshot = (state) => { this.state = state; if (!this.dirty && !this.editing) this.loadDraft(); this.draw(); };
        this.onKey = (text, key) => { void this.handleKey(text, key).catch(() => { this.message = 'The action could not be completed. See Diagnostics.'; this.draw(); }); };
        this.onResize = () => this.draw();
        this.onInterrupt = () => { void this.requestAction('close'); };
        this.onTerminate = () => { void this.forceClose(); };
        this.onInputEnd = () => { void this.forceClose(); };
    }
    loadDraft() {
        this.draft = { ...(this.controller.getSettings?.().values || this.state.settings?.values || {}) };
        this.draft.ICOM_PASSWORD = '';
    }
    async start() {
        if (this.started) return this;
        if (!this.input.isTTY || !this.output.isTTY) throw new Error('The terminal interface needs an interactive terminal. Use --headless for environment-configured service mode.');
        if (!this.controller) {
            const { AppController } = require('./controller');
            this.controller = new AppController({ directory: this.options.directory });
        }
        this.started = true; this.originalRaw = Boolean(this.input.isRaw); this.originalPaused = this.input.readableFlowing !== true;
        readline.emitKeypressEvents(this.input);
        this.input.setRawMode?.(true); this.input.resume?.();
        this.output.write(ENTER);
        this.input.on('keypress', this.onKey); this.input.once('end', this.onInputEnd);
        this.output.on('resize', this.onResize);
        this.signals.on('SIGINT', this.onInterrupt); this.signals.on('SIGTERM', this.onTerminate); this.signals.on('SIGHUP', this.onTerminate);
        this.controller.on('snapshot', this.onSnapshot);
        this.fields = this.controller.getFields?.() || [];
        this.state = this.controller.getState?.() || {};
        this.draw();
        try {
            await this.controller.initialize();
            this.fields = this.controller.getFields?.() || this.fields;
            this.state = this.controller.getState(); this.loadDraft();
            if (this.state.firstRun) this.view = 3;
            this.draw(); return this;
        } catch (error) {
            try { await this.controller.close({ confirmedTx: true }); } finally { this.cleanup(); }
            throw error;
        }
    }
    draw() {
        if (!this.started || this.finished) return;
        try { this.output.write(renderScreen(this, this.output.columns || 100, this.output.rows || 30)); }
        catch { void this.forceClose(); }
    }
    showView(index) { this.view = (index + VIEWS.length) % VIEWS.length; this.scroll = 0; this.message = ''; this.draw(); }
    async requestAction(action, confirmedTx = false) {
        if (this.finished || this.closing) return;
        if (action === 'reconnect' && !confirmedTx) {
            this.dialog = { text: 'Reconnect with saved settings? All clients will disconnect briefly.', action: () => this.performAction('reconnect', false) };
            this.draw(); return;
        }
        await this.performAction(action, confirmedTx);
    }
    async performAction(action, confirmedTx) {
        if (this.finished || this.closing) return;
        this.message = action === 'start' ? 'Connecting...' : action === 'close' ? 'Stopping the splitter...' : 'Working...';
        this.draw();
        try {
            const result = await this.controller[action]({ confirmedTx });
            if (result?.requiresConfirmation) {
                this.dialog = { text: `Transmission is active or pending. ${action === 'close' ? 'Stop transmission and close?' : action === 'stop' ? 'Stop transmission and disconnect?' : 'Stop transmission and reconnect?'}`,
                    action: () => this.performAction(action, true) };
                this.message = ''; this.draw(); return;
            }
            if (result?.releaseConfirmed === false) {
                this.state = result.state || this.controller.getState();
                this.message = 'Radio receive state could not be confirmed. Check the radio before transmitting again.';
                if (action === 'close') { this.exitError = new Error(this.message); this.cleanup(); return; }
                this.draw(); return;
            }
            if (action === 'close') { this.cleanup(); return; }
            this.state = this.controller.getState();
            if (action === 'start' || action === 'reconnect') {
                if (!this.state.running && !this.state.connecting) {
                    const error = this.state.lastError || this.state.error || 'Could not connect. Review the settings and Diagnostics.';
                    this.message = this.controller.redact?.(error) || error;
                } else if (this.state.connecting || !this.state.status?.radio?.connected || !this.state.status?.broker?.ready) {
                    this.message = 'Splitter running; connecting to radio. See Diagnostics for connection progress.';
                } else this.message = action === 'start' ? 'Started.' : 'Reconnected.';
            } else this.message = 'Stopped.';
        } catch {
            this.state = this.controller.getState();
            this.message = this.state.lastError || this.state.error || 'The action failed. See Diagnostics for details.';
        }
        this.draw();
    }
    async save() {
        try {
            await this.controller.saveSettings({ ...this.draft });
            this.dirty = false; this.state = this.controller.getState(); this.loadDraft();
            this.message = this.state.pendingChanges ? 'Settings saved. F8 applies them after confirmation.' : 'Settings saved. F6 starts the splitter.';
        } catch (error) {
            this.state = this.controller.getState();
            let message = this.controller.redact?.(error.message) || this.state.lastError || this.state.error
                || 'Settings were not saved. Check the selected values.';
            // A newly entered password may not be in the saved-secret set.
            if (this.draft.ICOM_PASSWORD) message = String(message).split(this.draft.ICOM_PASSWORD).join('[redacted]');
            this.message = safe(message);
        }
        this.draw();
    }
    async defaults() {
        const settings = await this.controller.restoreDefaults();
        this.draft = { ...(settings?.values || settings || {}) }; this.draft.ICOM_PASSWORD = '';
        this.dirty = true; this.message = 'Defaults loaded into the form. Save to keep them; the connection is unchanged.'; this.draw();
    }
    async exportReport() {
        const directory = this.options.directory || this.controller.directory;
        if (!directory) { this.message = 'The local settings directory is unavailable.'; this.draw(); return; }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const name = `diagnostics-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`;
        const dest = path.join(directory, name);
        await fs.writeFile(dest, JSON.stringify(this.controller.diagnosticReport(), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        this.message = `Report saved: ${dest}`; this.draw();
    }
    async handleKey(text, key = {}) {
        if (this.finished) return;
        if (this.dialog) {
            if (['y', 'return', 'enter'].includes(key.name) || text?.toLowerCase() === 'y') {
                const action = this.dialog.action; this.dialog = null; await action();
            } else if (['n', 'escape'].includes(key.name) || text?.toLowerCase() === 'n') {
                this.dialog = null; this.message = 'Canceled. Current connection is unchanged.'; this.draw();
            }
            return;
        }
        if (this.editing) {
            if (key.name === 'escape') { this.editing = null; this.draw(); return; }
            if (key.name === 'return' || key.name === 'enter') {
                const field = this.fields[this.selection]; this.draft[field.key] = this.editing.value;
                this.editing = null; this.dirty = true; this.draw(); return;
            }
            if (key.ctrl && key.name === 'u') this.editing.value = '';
            else if (key.name === 'backspace' || key.name === 'delete') this.editing.value = this.editing.value.slice(0, -1);
            else if (key.ctrl && key.name === 'c') { this.editing = null; await this.requestAction('close'); return; }
            else if (text && !key.ctrl && !key.meta && safe(text) === text && this.editing.value.length + text.length <= 512) this.editing.value += text;
            this.draw(); return;
        }
        if ((key.ctrl && key.name === 'c') || key.name === 'f10' || key.name === 'q') { await this.requestAction('close'); return; }
        if (key.name === 'f6') { await this.requestAction('start'); return; }
        if (key.name === 'f7') { await this.requestAction('stop'); return; }
        if (key.name === 'f8') { await this.requestAction('reconnect'); return; }
        if (key.name === 'tab') { this.showView(this.view + (key.shift ? -1 : 1)); return; }
        if (/^[1-5]$/.test(text || '')) { this.showView(Number(text) - 1); return; }
        if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown') {
            const delta = (key.name === 'up' || key.name === 'pageup' ? -1 : 1) * (key.name.startsWith('page') ? 8 : 1);
            if (this.view === 3) this.selection = Math.max(0, Math.min(this.fields.length + 1, this.selection + delta));
            else this.scroll = Math.max(0, this.scroll + delta);
            this.draw(); return;
        }
        if (this.view === 3) {
            if (key.name === 's') { await this.save(); return; }
            if (key.name === 'd') { await this.defaults(); return; }
            if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
                if (this.selection === this.fields.length) { await this.save(); return; }
                if (this.selection === this.fields.length + 1) { await this.defaults(); return; }
                const field = this.fields[this.selection]; if (!field) return;
                if (schemaType(field) === 'boolean') {
                    const current = this.draft[field.key]; this.draft[field.key] = current === '1' || current === true || current === 1 ? '0' : '1'; this.dirty = true;
                } else this.editing = { value: field.key === 'ICOM_PASSWORD' ? '' : String(this.draft[field.key] ?? '') };
                this.draw(); return;
            }
        }
        if (this.view === 4 && key.name === 'e') await this.exportReport();
    }
    async forceClose() {
        if (this.closing || this.finished) return;
        this.closing = true;
        // A lost terminal cannot answer an interactive question. Always use the
        // existing release-and-shutdown path rather than abandoning the radio.
        try {
            const result = await this.controller.close({ confirmedTx: true });
            if (result?.releaseConfirmed === false) this.exitError = new Error('Radio receive state could not be confirmed. Check the radio before transmitting again.');
        }
        catch { this.exitError = new Error('Splitter shutdown could not be confirmed.'); }
        finally { this.cleanup(); }
    }
    cleanup() {
        if (this.finished) return;
        this.finished = true;
        this.controller?.removeListener('snapshot', this.onSnapshot);
        this.input.removeListener('keypress', this.onKey); this.input.removeListener('end', this.onInputEnd);
        this.output.removeListener('resize', this.onResize);
        this.signals.removeListener('SIGINT', this.onInterrupt); this.signals.removeListener('SIGTERM', this.onTerminate); this.signals.removeListener('SIGHUP', this.onTerminate);
        this.input.setRawMode?.(this.originalRaw);
        if (this.originalPaused) this.input.pause?.();
        if (this.draft) this.draft.ICOM_PASSWORD = '';
        try { this.output.write(LEAVE); } catch { /* Terminal has already closed. */ }
        this.resolve();
    }
    async run() { await this.start(); await this.done; if (this.exitError) throw this.exitError; }
}
async function runTui(options = {}) { const app = new TerminalApp(options); await app.run(); }
module.exports = { TerminalApp, runTui, renderScreen, safe };
