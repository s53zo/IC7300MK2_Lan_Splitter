'use strict';
const api = window.splitter;
const byId = (id) => document.getElementById(id);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const count = (value) => Math.max(0, number(value)).toLocaleString(undefined, { maximumFractionDigits: 0 });
const decimal = (value) => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
const milliseconds = (value) => Number.isFinite(value) ? `${decimal(value)} ms` : '—';
function duration(value) {
    if (!Number.isFinite(value)) return '—';
    const seconds = Math.max(0, Math.floor(value / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function text(id, value) { byId(id).textContent = value; }
function element(tag, value, className) {
    const node = document.createElement(tag); if (value !== undefined) node.textContent = value;
    if (className) node.className = className; return node;
}
let state = {}, fields = [], settings = {}, initialized = false;
let busy = false, dialogResolve, priorFocus;
const pendingActions = new Set();
const descriptions = {
    dashboard: ['Dashboard', 'One radio connection. All your clients.'],
    clients: ['Clients', 'See who is sharing your radio connection.'],
    cache: ['Cache', 'See client answers, sample freshness and physical radio traffic.'],
    settings: ['Settings', 'Saved on this computer. Ready next time you open the app.'],
    diagnostics: ['Diagnostics', 'Useful details when something needs attention.'],
};
function view(name) {
    if (!descriptions[name]) return;
    for (const section of document.querySelectorAll('.view')) { const active = section.id === `view-${name}`; section.hidden = !active; section.classList.toggle('active', active); }
    for (const nav of document.querySelectorAll('[data-view]')) { nav.classList.toggle('active', nav.dataset.view === name); nav.setAttribute('aria-current', nav.dataset.view === name ? 'page' : 'false'); }
    text('page-title', descriptions[name][0]); text('page-subtitle', descriptions[name][1]);
}
function message(value, error = false) {
    const box = byId('message'); box.hidden = !value; box.textContent = value || ''; box.classList.toggle('error', error);
}
async function request(action, payload) {
    const result = await api.request(action, payload);
    if (!result?.ok) throw new Error(result?.error || 'The action could not be completed.');
    return result.value;
}
function confirmAction({ title, description, accept, cancel = 'Cancel' }) {
    if (dialogResolve) dialogResolve(false);
    text('confirm-title', title); text('confirm-description', description); text('confirm-accept', accept); text('confirm-cancel', cancel);
    priorFocus = document.activeElement;
    byId('confirm-dialog').showModal(); byId('confirm-cancel').focus();
    return new Promise((resolve) => { dialogResolve = resolve; });
}
function finishConfirmation(accepted) {
    byId('confirm-dialog').close(); const resolve = dialogResolve; dialogResolve = null;
    priorFocus?.focus(); resolve?.(accepted);
}
byId('confirm-cancel').addEventListener('click', () => finishConfirmation(false));
byId('confirm-accept').addEventListener('click', () => finishConfirmation(true));
byId('confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); finishConfirmation(false); });
function transmissionPrompt(action) {
    const closing = action === 'close';
    return confirmAction({ title: 'Transmission is active', description: `Stop transmission and ${closing ? 'close the splitter' : action === 'reconnect' ? 'reconnect' : 'stop the splitter'}? All clients will disconnect.`,
        accept: closing ? 'Stop & close' : action === 'reconnect' ? 'Stop & reconnect' : 'Stop transmission', cancel: 'Keep running' });
}
async function action(name, confirmedTx = false) {
    if (pendingActions.has(name)) return;
    pendingActions.add(name); renderControls();
    try {
        message('');
        const result = await request(name, { confirmedTx });
        if (result?.requiresConfirmation) {
            pendingActions.delete(name); renderControls();
            if (await transmissionPrompt(name)) await action(name, true);
            return;
        }
        if (result?.releaseConfirmed === false) message('The splitter stopped, but receive state could not be confirmed. Check the radio before leaving it unattended.', true);
        else if (name !== 'close') render(await request('state'));
    } catch (error) { message(error.message, true); }
    finally { pendingActions.delete(name); renderControls(); }
}
async function reconnect() {
    const tx = state.txActive;
    const accepted = tx ? await transmissionPrompt('reconnect') : await confirmAction({ title: 'Reconnect the splitter?', description: 'Clients will briefly disconnect while the saved settings are applied.', accept: 'Reconnect', cancel: 'Keep connection' });
    if (accepted) await action('reconnect', Boolean(tx));
}
api.onCloseConfirmation(async () => { if (await transmissionPrompt('close')) await action('close', true); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => view(button.dataset.view));
byId('start-button').addEventListener('click', () => action('start'));
byId('stop-button').addEventListener('click', () => action('stop'));
byId('reconnect-button').addEventListener('click', reconnect);
byId('apply-settings').addEventListener('click', reconnect);
byId('configure-query-cache').addEventListener('click', () => {
    view('settings'); byId('per-command-settings').open = true; byId('per-command-settings').scrollIntoView({ block: 'start' });
});
byId('reset-statistics').addEventListener('click', async () => {
    if (!await confirmAction({ title: 'Reset statistics?', description: 'Clear counters, timing summaries and graphs? Connections, settings, cached values and polling stay unchanged.', accept: 'Reset statistics' })) return;
    const button = byId('reset-statistics'); button.disabled = true;
    try { render(await request('reset-statistics')); message('Statistics reset.'); }
    catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
});
byId('export-report').addEventListener('click', async () => { try { if (await request('export')) message('Diagnostic report saved.'); } catch (error) { message(error.message, true); } });
function renderControls() {
    const active = state.running || state.connecting;
    byId('start-button').hidden = Boolean(active);
    byId('start-button').disabled = busy || pendingActions.has('start') || state.firstRun;
    byId('stop-button').disabled = busy || pendingActions.has('stop') || !active;
    byId('reconnect-button').disabled = busy || pendingActions.has('reconnect') || !active;
    byId('apply-settings').disabled = busy || pendingActions.has('reconnect');
    byId('save-settings').disabled = busy;
    byId('test-connection').disabled = busy || pendingActions.has('start') || pendingActions.has('reconnect');
}
function render(next) {
    if (!next) return;
    text('statistics-window', next.statisticsStartedAt ? `Statistics since ${new Date(next.statisticsStartedAt).toLocaleString()}` : 'Statistics since application start');
    state = next;
    const status = state.status || {}, broker = status.broker || {}, cache = status.cache || {}, metrics = status.metrics || {};
    const radio = status.radio || {}, counts = status.nativeClients || {}, rates = state.rates || {}, timing = state.latency || {};
    const connected = Boolean(radio.connected), ready = Boolean(broker.ready);
    const rxTx = state.dashboard?.rxTx || 'Unavailable';
    const label = state.connecting ? 'Connecting' : connected && ready ? rxTx === 'TX' ? 'Transmitting' : state.txActive ? 'TX control reserved' : 'Connected' : state.running ? 'Reconnecting' : 'Stopped';
    text('state-badge', label); byId('state-badge').className = `badge${connected && ready ? rxTx === 'TX' ? ' tx' : ' live' : ''}`;
    text('rail-status', label); byId('rail-dot').classList.toggle('live', connected && ready);
    text('connection-title', connected && ready ? 'Your radio is connected' : state.connecting ? 'Connecting to your radio…' : state.firstRun ? 'Let’s connect your radio' : state.running ? 'Restoring the connection…' : 'Ready when you are');
    const values = state.activeSettings?.values || state.settings?.values || settings.values || {};
    text('connection-detail', state.firstRun ? 'Open Settings and enter your radio details. It only takes a moment.' : `${values.ICOM_RADIO_HOST || 'Radio'} · ${connected && ready ? 'One radio connection, shared with every client.' : state.running ? 'The splitter will retry automatically.' : 'Open the app to connect automatically using your saved settings.'}`);
    text('client-count', count(counts.authenticated)); text('nav-clients', count(counts.authenticated));
    text('client-detail', `${count(counts.audioReady)} receiving audio · ${count(counts.civReady)} ready for commands`);
    text('cache-percent', number(cache.requests) ? `${decimal(number(cache.hits) / number(cache.requests) * 100)}%` : '—');
    text('cache-detail', `${count(cache.hits)} client requests answered locally since reset`);
    text('radio-rate', decimal(rates.radioPerSecond));
    text('uptime', duration(state.uptimeMs));
    text('ping-ms', timing.pingStale ? '—' : milliseconds(timing.pingMs));
    byId('ping-ms').title = timing.pingStale ? 'The last ping measurement is stale.' : 'Measured native Icom LAN round-trip time';
    text('response-ms', milliseconds(timing.responseMs)); text('queue-ms', milliseconds(timing.queueMs));
    text('rx-indicator', rxTx === 'Unavailable' ? '—' : rxTx); byId('rx-indicator').classList.toggle('tx', rxTx === 'TX');
    text('health-title', rxTx === 'TX' ? 'Radio is transmitting' : rxTx === 'RX' ? state.txActive ? 'Radio is receiving · TX control is reserved' : 'Radio is receiving' : 'Radio state is unavailable');
    const audio = metrics.transport?.audio || {};
    text('health-detail', connected ? `${count(status.connectedUpstreamSessions)} radio connection · ${count(audio.lost)} radio audio packets reported lost · queue ${count(broker.queueDepth)}` : 'Connection and audio transport health will appear here.');
    text('timeout-count', `${count(metrics.radioTimeouts)} radio timeouts`);
    const addresses = values.ICOM_BIND_ADDRESS === '0.0.0.0'
        ? (settings.interfaces || []).filter((row) => !row.internal).map((row) => row.address).join(', ') || 'this computer’s LAN address'
        : values.ICOM_BIND_ADDRESS || 'this computer';
    text('footer-address', connected ? `Clients connect to ${addresses} · control port ${values.ICOM_LISTEN_CONTROL_PORT || '50001'}` : 'Local splitter · not connected');
    byId('pending-banner').hidden = !state.pendingChanges;
    text('eligible-count', count(cache.requests)); text('avoided-count', count(cache.hits)); text('miss-count', count(cache.misses)); text('coalesced-count', count(cache.coalesced));
    text('cache-enabled', cache.enabled === false ? 'Disabled' : 'Enabled');
    text('query-lifetime-heading', state.running ? 'Lifetime / sample age limit' : 'Last lifetime / sample age limit');
    renderTelemetry(status.telemetry);
    renderClients(state.clients || []); renderQueries(cache.byQuery || {}, cache.querySettings || []); renderTtls(cache.ttlMs || {}); renderHistory(state.history || []); renderEvents(state.events || []);
    if (state.lastError) message(state.lastError, true);
    text('setup-eyebrow', state.firstRun ? 'FIRST-TIME SETUP' : 'RADIO & NETWORK');
    text('setup-title', state.firstRun ? 'Welcome. Let’s connect your radio.' : 'Connection settings');
    if (!initialized && state.firstRun) view('settings');
    renderControls();
}
function renderClients(clients) {
    byId('client-rows').replaceChildren(); byId('clients-empty').hidden = clients.length > 0;
    text('clients-summary', `${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`);
    for (const client of clients) {
        const row = element('tr');
        row.append(element('td', client.name || 'Native LAN client'), element('td', client.address || '—', 'mono'), element('td', duration(client.connectedMs)),
            element('td', [client.audioReady ? 'Audio' : '', client.civReady ? 'Commands' : ''].filter(Boolean).join(' + ') || 'Connecting'));
        const tagCell = element('td'); tagCell.append(element('span', client.txOwner ? 'TX owner' : 'Shared control', `client-tag${client.txOwner ? ' tx' : ''}`)); row.append(tagCell); byId('client-rows').append(row);
    }
}
function renderQueries(queries, querySettings) {
    const root = byId('query-rows'); root.replaceChildren();
    const policies = new Map(querySettings.map((query) => [query.key.toLowerCase(), query]));
    for (const [key, query] of Object.entries(queries).sort((a, b) => number(b[1].hits) - number(a[1].hits))) {
        const policy = policies.get(key.toLowerCase()), row = element('tr');
        const parameter = element('td');
        parameter.append(element('span', policy?.label || 'Radio query', 'query-label'), element('small', key.toUpperCase(), 'mono query-code'));
        const lifetime = element('td', policy ? `${policy.effectiveMs} ms` : '—');
        lifetime.dataset.queryTtl = key.toLowerCase();
        if (policy) {
            lifetime.title = policy.effectiveMs === 0 ? 'Local sharing is disabled for this query.' : policy.source === 'telemetry'
                ? `Shared telemetry: ${milliseconds(policy.intervalMs ?? policy.pollMs)} refresh target; ${milliseconds(policy.effectiveMs)} maximum sample age. The saved legacy cache lifetime applies when telemetry is off.`
                : policy.overrideMs === null ? 'Uses the active family default.' : 'Uses a per-command override.';
            if (policy.source === 'telemetry') lifetime.append(element('small', `Shared · ${milliseconds(policy.intervalMs ?? policy.pollMs)}${['1511', '1512', '1513'].includes(key.toLowerCase()) ? ' TX' : ''} refresh`, 'query-mode'));
        }
        row.append(parameter, lifetime, element('td', count(query.requests)), element('td', count(query.hits)), element('td', query.requests ? `${decimal(query.hits / query.requests * 100)}%` : '—'), element('td', count(query.coalesced))); root.append(row);
    }
    if (!root.children.length) { const row = element('tr'); const cell = element('td', 'Query statistics will appear when clients start polling.'); cell.colSpan = 6; row.append(cell); root.append(row); }
}
function renderTelemetry(telemetry) {
    const root = byId('telemetry-rows'); root.replaceChildren();
    const rows = Array.isArray(telemetry?.querySettings) ? telemetry.querySettings : [];
    const active = telemetry?.enabled === true;
    const available = telemetry && typeof telemetry.enabled === 'boolean';
    text('telemetry-status', !available ? 'Unavailable' : active ? 'Enabled' : telemetry.requested ? 'Paused — cache disabled' : 'Off');
    byId('telemetry-status').className = `badge${active ? ' live' : ''}`;
    text('telemetry-description', !available ? 'Sampling information appears when the splitter starts.' : active
        ? 'S-meter and fresh RX/TX state target 100 ms; ADC overflow targets 500 ms. Power, SWR and ALC target 100 ms only during confirmed TX. Slower radio replies skip ticks instead of building a polling backlog.'
        : telemetry.requested ? 'The global cache switch has disabled shared sampling. Normal fresh safety polling continues.'
            : 'Shared sampling is off. Queries use the normal cache lifetimes; fresh safety polling continues. Enable Shared telemetry polling in Settings to use the fixed sampling schedule.');
    const total = (key) => available ? count(rows.reduce((sum, row) => sum + number(row[key]), 0)) : '—';
    text('telemetry-polls', total('rfPolls')); text('telemetry-answers', total('localAnswers')); text('telemetry-fallbacks', total('fallbacks'));
    const labels = { '1502': 'S-meter', '1507': 'ADC overflow', '1c00': 'RX/TX state', '1511': 'Power meter', '1512': 'SWR meter', '1513': 'ALC meter' };
    const rx = rows.find((row) => row.key === '1c00');
    for (const sample of rows) {
        const key = String(sample.key || '').toLowerCase(), row = element('tr'), parameter = element('td');
        parameter.append(element('span', labels[key] || 'Radio query', 'query-label'), element('small', key.toUpperCase(), 'mono query-code'));
        let mode = !active ? 'Paused' : sample.polling ? sample.sharing ? 'Polling + shared' : 'Safety only' : !sample.sharing ? 'Not shared' : sample.txOnly ? 'Waiting for TX state' : 'Paused';
        const stale = Number.isFinite(sample.sampleAgeMs) && sample.fresh === false;
        let age = Number.isFinite(sample.sampleAgeMs) ? `${milliseconds(sample.sampleAgeMs)}${stale ? ' (stale)' : ''}` : '—';
        if (active && sample.sharing && sample.polling && sample.fresh === false) mode = stale ? 'Polling · stale sample' : 'Polling · awaiting sample';
        if (active && sample.sharing && sample.txOnly && !sample.polling && state.dashboard?.rxTx === 'RX' && rx?.fresh === true && Number.isFinite(rx.sampleAgeMs)) {
            mode = 'RX: zero replies'; age = `RX state ${milliseconds(rx.sampleAgeMs)}`;
        }
        const status = element('td', mode); status.title = `${count(sample.zeroReplies)} documented RX zero replies; ${count(sample.backpressureSkips)} ticks skipped while a read was outstanding.`;
        const schedule = element('td');
        schedule.append(element('span', `${milliseconds(sample.intervalMs)}${sample.txOnly ? ' TX' : ''} refresh`, 'telemetry-target'),
            element('small', sample.sharing ? `${milliseconds(sample.maxAgeMs)} max age` : 'Not shared', 'telemetry-limit'));
        row.append(parameter, schedule, element('td', age), status, element('td', count(sample.rfPolls)), element('td', count(sample.localAnswers)));
        root.append(row);
    }
    if (!rows.length) { const row = element('tr'), cell = element('td', 'No sampling status is available yet.'); cell.colSpan = 6; row.append(cell); root.append(row); }
}
function renderTtls(ttls) {
    const root = byId('ttl-cards'); root.replaceChildren();
    for (const [key, label] of [['meters', 'Meters & ADC'], ['state', 'RX/TX & tuner'], ['settings', 'Operator settings'], ['tuning', 'Tuning & VFO']]) {
        const card = element('div', undefined, 'ttl-item'); card.append(element('span', label), element('strong', Number.isFinite(ttls[key]) ? `${ttls[key]} ms` : '—')); root.append(card);
    }
}
function renderHistory(history) {
    const samples = history.slice(-900), max = Math.max(1, ...samples.flatMap((s) => [number(s.requestsPerSecond), number(s.radioPerSecond)]));
    const points = (key) => samples.map((s, i) => `${samples.length < 2 ? 0 : i / (samples.length - 1) * 640},${175 - number(s[key]) / max * 155}`).join(' ');
    byId('requests-line').setAttribute('points', points('requestsPerSecond')); byId('radio-line').setAttribute('points', points('radioPerSecond'));
    text('graph-caption', samples.length ? `Peak ${decimal(max)} / s · ${samples.length} samples. Radio traffic includes scheduled sampling, fresh safety polls and uncached commands. History clears when you close the app.` : 'The graph will begin when the splitter connects.');
}
function renderEvents(events) {
    const root = byId('event-list'); root.replaceChildren(); byId('events-empty').hidden = events.length > 0;
    for (const event of events.slice(-100).reverse()) {
        const row = element('li', undefined, `event-item${event.level === 'error' ? ' error' : ''}`);
        const time = element('time', new Date(event.time).toLocaleTimeString()); row.append(time, element('span', event.message || 'Connection event')); root.append(row);
    }
}
function renderFields() {
    const basic = new Set(['ICOM_RADIO_HOST', 'ICOM_USERNAME', 'ICOM_PASSWORD', 'ICOM_BIND_ADDRESS']);
    const groups = new Map(); byId('basic-fields').replaceChildren(); byId('advanced-fields').replaceChildren(); byId('per-command-fields').replaceChildren();
    for (const field of fields) {
        const wrapper = element('div', undefined, `field${field.type === 'file' ? ' wide' : ''}`);
        const command = /^ICOM_CACHE_QUERY_([0-9A-F]+)_MS$/.exec(field.key);
        const commandLabel = command ? field.label.replace(/\s*\([0-9a-f]+\)$/i, '').replace(/^CI-V query [0-9a-f]+$/i, 'Radio query') : field.label;
        const label = element('label', field.key === 'ICOM_BIND_ADDRESS' ? 'Accept clients on' : command ? `${commandLabel} (ms)` : field.label);
        label.htmlFor = field.key;
        if (command) label.append(element('span', command[1], 'command-badge mono'));
        wrapper.append(label);
        let input;
        if (field.key === 'ICOM_BIND_ADDRESS') {
            input = element('select'); input.append(new Option('All network adapters', '0.0.0.0'), new Option('This computer only', '127.0.0.1'));
            const added = new Set(['0.0.0.0', '127.0.0.1']);
            for (const row of settings.interfaces || []) {
                if (added.has(row.address)) continue;
                added.add(row.address); input.append(new Option(`${row.name} (${row.address})`, row.address));
            }
            const saved = settings.values?.[field.key];
            if (saved && !added.has(saved)) input.append(new Option(`Saved address (${saved})`, saved));
        }
        else if (field.type === 'boolean') { input = element('select'); input.append(new Option('Enabled', '1'), new Option('Disabled', '0')); }
        else { input = element('input'); input.type = field.key === 'ICOM_PASSWORD' ? 'password' : ['integer', 'number', 'optional-number'].includes(field.type) ? 'number' : 'text'; }
        input.id = field.key; input.name = field.key; input.autocomplete = field.key === 'ICOM_PASSWORD' ? 'new-password' : 'off';
        if (field.min !== undefined && input.type === 'number') input.min = field.min;
        if (field.max !== undefined && input.type === 'number') input.max = field.max;
        input.value = settings.values?.[field.key] ?? field.default ?? '';
        if (field.key === 'ICOM_PASSWORD') input.placeholder = settings.hasPassword ? 'Saved password — leave blank to keep' : 'Radio password';
        if (field.key === 'ICOM_RADIO_HOST') input.placeholder = 'For example, 192.168.1.50';
        if (field.type === 'optional-number') { input.placeholder = 'Use family default'; input.step = '1'; }
        if (field.type === 'file') {
            input.readOnly = true; input.placeholder = 'Optional: import an existing password file';
            const line = element('div', undefined, 'field-inline'), browse = element('button', 'Choose file…', 'button button-secondary'); browse.type = 'button';
            browse.addEventListener('click', async () => { try { const file = await request('password-file'); if (file) input.value = file; } catch (error) { message(error.message, true); } });
            const clear = element('button', 'Clear', 'button button-quiet'); clear.type = 'button'; clear.addEventListener('click', () => { input.value = ''; });
            line.append(input, browse, clear); wrapper.append(line);
        } else wrapper.append(input);
        wrapper.append(element('small', field.key === 'ICOM_BIND_ADDRESS' ? 'Choose the network adapter your radio clients will use to reach this computer.' : field.description || ''));
        if (basic.has(field.key)) byId('basic-fields').append(wrapper);
        else if (command || field.group === 'Per-command cache') byId('per-command-fields').append(wrapper);
        else {
            const groupName = field.group || 'Advanced';
            if (!groups.has(groupName)) { const group = element('div', undefined, 'field-group'); group.append(element('h3', groupName)); groups.set(groupName, group); byId('advanced-fields').append(group); }
            groups.get(groupName).append(wrapper);
        }
    }
    text('config-directory', settings.configDirectory ? `Configuration folder: ${settings.configDirectory}` : '');
    text('credential-note', settings.credentialProtection || 'Your password is saved locally and excluded from diagnostic reports.');
}
async function save(connect = false) {
    if (busy) return;
    const values = Object.fromEntries(fields.map((field) => [field.key, byId(field.key).value]));
    busy = true; renderControls();
    try {
        const result = await request('save', values); settings = await request('settings'); renderFields();
        render(result); message(state.running ? 'Settings saved. Your current connection is unchanged.' : 'Settings saved on this computer.'); text('settings-status', 'Saved');
        busy = false; renderControls();
        if (connect) {
            if (state.running || state.connecting) await reconnect();
            else { await action('start'); if (state.running) view('dashboard'); }
        }
    } catch (error) { message(error.message, true); text('settings-status', 'Please check your settings'); }
    finally { busy = false; renderControls(); }
}
byId('settings-form').addEventListener('submit', (event) => { event.preventDefault(); void save(); });
byId('test-connection').addEventListener('click', () => save(true));
byId('restore-defaults').addEventListener('click', async () => {
    if (!await confirmAction({ title: 'Restore default settings?', description: 'This resets the form only. Your saved settings and current connection stay unchanged until you save.', accept: 'Reset form' })) return;
    settings = { ...settings, values: await request('defaults') }; renderFields(); text('settings-status', 'Defaults shown — not saved');
});
api.subscribe(render);
(async () => {
    try {
        [fields, settings] = await Promise.all([request('fields'), request('settings')]);
        renderFields(); render(await request('state')); initialized = true; window.uiReady = true;
    } catch (error) { message(error.message, true); }
})();
