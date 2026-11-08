'use strict';
// Ordinary sandboxed browser verification of Linux headless management. The
// browser has no preload/Node bridge and talks only to an isolated HTTPS fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
async function launch() {
    const executable = require('electron');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('ICOM_')));
    const child = spawn(executable, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try { await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Browser smoke failed (${code})`))); }); }
    finally { clearTimeout(timer); }
}
async function run() {
    const assert = require('node:assert/strict');
    const dgram = require('node:dgram');
    const { X509Certificate } = require('node:crypto');
    const { app, BrowserWindow, session } = require('electron');
    const startupFs = require('node:fs');
    const directory = startupFs.mkdtempSync(path.join(os.tmpdir(), 'icom-web-ui-'));
    const browserDirectory = path.join(directory, 'browser'); startupFs.mkdirSync(browserDirectory);
    app.setPath('userData', browserDirectory); app.setPath('sessionData', browserDirectory);
    const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
    const output = outputArg ? path.resolve(outputArg.slice('--output='.length)) : path.resolve('.release/web-screenshots');
    app.on('window-all-closed', () => {}); // Closing an ordinary browser must not end the fixture service.
    await app.whenReady();
    const { AppController } = require('../src/app/controller');
    const { createWebServer } = require('../src/web/server');
    const { loadAssets } = require('../src/web/assets');
    const { ensureTls } = require('../src/web/tls');
    const { IcomPeer } = require('../tests/fixtures/icom-radio');
    const { client, frame, sleep } = require('../tests/fixtures/harness');
    const controller = new AppController({ directory: path.join(directory, 'settings') });
    const setupToken = 'browser-smoke-bootstrap-access-code';
    const peers = [], consoleErrors = [];
    let web, window, secondWindow;
    const until = async (predicate, label, timeout = 15000) => {
        const end = Date.now() + timeout;
        while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(20); }
    };
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    try {
        await fs.mkdir(output, { recursive: true }); await controller.initialize();
        const tls = await ensureTls({ directory: path.join(directory, 'https'), host: '127.0.0.1', env: {} });
        web = createWebServer({ controller, host: '127.0.0.1', port: 0, tls, assets: loadAssets(),
            getCredentials: () => controller.firstRun ? { username: 'setup', password: setupToken, setupRequired: true }
                : { username: controller.values.ICOM_USERNAME, password: controller.password, setupRequired: false } });
        await web.start(); const origin = `https://127.0.0.1:${web.address().port}`;
        const fingerprint = new X509Certificate(tls.cert).fingerprint256;
        session.defaultSession.setCertificateVerifyProc((request, callback) => {
            try {
                const expected = request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
                callback(expected ? 0 : -3);
            } catch { callback(-3); }
        });
        app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
            if (new URL(url).origin === origin && new X509Certificate(certificate.data).fingerprint256 === fingerprint) { event.preventDefault(); callback(true); }
            else callback(false);
        });
        const createWindow = () => {
            const view = new BrowserWindow({ width: 1120, height: 800, minWidth: 600, minHeight: 480, show: true,
                webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } });
            view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            view.webContents.on('console-message', (event) => { if (event.level === 'error') consoleErrors.push(event.message); });
            return view;
        };
        window = createWindow();
        const js = (code) => window.webContents.executeJavaScript(code, true);
        const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
        const nav = (name) => js(`document.querySelector('[data-view="${name}"]').click()`);
        const capture = async (name) => { await sleep(100); await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
        await window.loadURL(origin + '/login');
        await until(() => js("!document.getElementById('sign-in').disabled && !document.getElementById('setup-fields').hidden"), 'bootstrap sign-in');
        assert.equal(await js('typeof require'), 'undefined'); await capture('01-setup-login');
        window.setSize(640, 720); await capture('01a-narrow-login'); assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true); window.setSize(1120, 800);
        await js(`document.getElementById('setup-token').value=${JSON.stringify(setupToken)}`); await click('sign-in');
        await until(() => js('window.uiReady === true'), 'authenticated first-run interface');
        assert.equal(controller.firstRun, true);
        assert.equal(await js('document.cookie'), '', 'session cookie must be HttpOnly');
        assert.equal(await js('localStorage.length + sessionStorage.length'), 0, 'browser must not persist credentials/tokens');
        const cookies = await window.webContents.session.cookies.get({ url: origin });
        const cookie = cookies.find((entry) => entry.name === '__Host-icom_splitter');
        assert.ok(cookie?.secure && cookie?.httpOnly && cookie?.sameSite === 'strict' && cookie?.path === '/', 'strict secure cookie attributes');
        const sockets = [];
        try {
            for (let i = 0; i < 3; i++) { const socket = dgram.createSocket('udp4'); sockets.push(socket); await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)); }
            const [control, civ, audio] = sockets.map((socket) => socket.address().port), upstream = radio.config();
            await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); sockets.length = 0;
            const values = { ICOM_RADIO_HOST: '127.0.0.1', ICOM_BIND_ADDRESS: '127.0.0.1', ICOM_USERNAME: 'beer',
                ICOM_LISTEN_CONTROL_PORT: String(control), ICOM_LISTEN_CIV_PORT: String(civ), ICOM_LISTEN_AUDIO_PORT: String(audio),
                ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort), ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort) };
            const fields = controller.getFields();
            assert.equal(await js('document.querySelectorAll("#settings-form input, #settings-form select").length'), fields.length);
            await nav('settings'); await capture('02-first-run');
            const importedFile = path.join(directory, 'fixture-password.txt'); await fs.writeFile(importedFile, 'testpass\n', { mode: 0o600 });
            // CDP selects an isolated fixture file as a user picker would. Only
            // the test suppresses the native dialog; production uses input.click.
            window.webContents.debugger.attach('1.3');
            await js("window.__smokeOriginalInputClick=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return window.__smokeOriginalInputClick.call(this)};window.__smokeImport=window.splitter.request('password-file');true");
            const doc = await window.webContents.debugger.sendCommand('DOM.getDocument');
            const fileInput = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
            await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [importedFile] });
            assert.equal((await js('window.__smokeImport')).ok, true);
            assert.equal(await js("document.getElementById('ICOM_PASSWORD').value"), 'testpass');
            assert.equal(await js("document.getElementById('ICOM_PASSWORD_FILE').value"), '', 'local file path must not be sent to server');
            await js('HTMLInputElement.prototype.click=window.__smokeOriginalInputClick;delete window.__smokeOriginalInputClick;delete window.__smokeImport'); window.webContents.debugger.detach();
            await js(`for (const [key,value] of Object.entries(${JSON.stringify(values)})) document.getElementById(key).value=value;`); await click('test-connection');
            await until(() => controller.getState().status.broker.ready, 'synthetic radio connection');
            peers.push(await client({ host: '127.0.0.1', controlPort: control, civPort: civ, audioPort: audio }, { password: 'testpass' }));
            peers.push(await client({ host: '127.0.0.1', controlPort: control, civPort: civ, audioPort: audio }, { password: 'testpass' }));
            peers[0].sendCiv(frame(3, [], 0xe1)); peers[1].sendCiv(frame(4, [], 0xe2));
            await until(() => peers[0].receivedCiv.some((bytes) => bytes[2] === 0xe1 && bytes[4] === 3)
                && peers[1].receivedCiv.some((bytes) => bytes[2] === 0xe2 && bytes[4] === 4), 'private native replies');
            assert.equal(peers[0].receivedCiv.some((bytes) => bytes[4] === 4), false); assert.equal(peers[1].receivedCiv.some((bytes) => bytes[4] === 3), false);
            const pcm = Buffer.alloc(1364, 0x31), scope = Buffer.alloc(475, 0x45); radio.rxAudio(pcm); radio.scope(scope);
            await until(() => peers.every((peer) => peer.receivedAudio.length && peer.receivedCiv.some((bytes) => bytes[4] === 0x27 && bytes[5] === 0)), 'exact audio/scope fanout');
            for (const peer of peers) { assert.deepEqual(peer.receivedAudio[0], pcm); assert.deepEqual(peer.receivedCiv.find((bytes) => bytes[4] === 0x27 && bytes[5] === 0).subarray(21, -1), scope); }
            peers[0].sendCiv(frame(0x15, [2], 0xe1)); peers[1].sendCiv(frame(0x15, [2], 0xe2));
            await until(() => controller.getState().status.cache.hits > 0 && Number.isFinite(controller.getState().latency.pingMs), 'cache/ping telemetry', 20000);
            await until(() => js("document.getElementById('client-count').textContent==='2' && document.getElementById('ping-ms').textContent.endsWith(' ms') && document.getElementById('response-ms').textContent.endsWith(' ms')"), 'polled client count and measured latency');
            assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
            for (const screen of ['dashboard', 'clients', 'cache', 'settings', 'diagnostics']) { await nav(screen); await capture(`03-${screen}`); }
            await nav('settings'); await js("document.getElementById('per-command-settings').open=true; document.getElementById('ICOM_CACHE_QUERY_1502_MS').value='200'"); await click('save-settings');
            await until(() => controller.getSettings().values.ICOM_CACHE_QUERY_1502_MS === '200', 'saved per-query setting');
            const policy = () => controller.getState().status.cache.querySettings.find((entry) => entry.key === '1502');
            assert.equal(policy().effectiveMs, 100, 'browser save must preserve active settings');
            await until(() => js("!document.getElementById('apply-settings').disabled"), 'saved settings ready');
            await click('apply-settings'); await until(() => js("document.getElementById('confirm-dialog').open"), 'reconnect confirmation'); await click('confirm-cancel');
            assert.equal(policy().effectiveMs, 100); assert.equal(radio.connections.control, 1);
            await js("document.getElementById('ICOM_CACHE_QUERY_1502_MS').scrollIntoView({block:'center'})"); await capture('04-per-query-pending');
            await nav('dashboard'); window.setSize(640, 720); await capture('05-narrow-browser');
            assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true); window.setSize(1120, 800);
            const downloaded = path.join(output, 'diagnostics.json');
            window.webContents.session.on('will-download', (_event, item) => item.setSavePath(downloaded));
            await nav('diagnostics'); await click('export-report'); await until(async () => { try { return (await fs.stat(downloaded)).size > 0; } catch { return false; } }, 'browser diagnostic download');
            assert.equal((await fs.readFile(downloaded, 'utf8')).includes('testpass'), false);
            peers[0].sendCiv(frame(0x1c, [0, 1], 0xe1)); await until(() => controller.getState().txActive && radio.ptt, 'synthetic TX');
            await nav('dashboard'); await click('stop-button'); await until(() => js("document.getElementById('confirm-dialog').open"), 'TX stop confirmation'); await capture('06-tx-stop-confirmation');
            await click('confirm-cancel'); assert.equal(radio.ptt, true); assert.equal(controller.getState().running, true);
            await click('stop-button'); await until(() => js("document.getElementById('confirm-dialog').open"), 'TX stop retry'); await click('confirm-accept');
            await until(() => !controller.getState().running, 'confirmed radio stop'); assert.equal(radio.ptt, false);
            assert.ok(web.server.listening, 'Stop must leave browser management available');
            await Promise.allSettled(peers.map((peer) => peer.close())); peers.length = 0;
            await click('start-button'); await until(() => controller.getState().status.broker.ready && policy().effectiveMs === 200, 'restart applies saved per-query value');
            const meterReads = async () => {
                const peer = await client({ host: '127.0.0.1', controlPort: control, civPort: civ, audioPort: audio }, { password: 'testpass' });
                try {
                    const commands = () => radio.commands.filter((bytes) => bytes[4] === 0x15 && bytes[5] === 2).length, before = commands();
                    for (let i = 0; i < 2; i++) { peer.receivedCiv.length = 0; peer.sendCiv(frame(0x15, [2], 0xe3));
                        await until(() => peer.receivedCiv.some((bytes) => bytes[2] === 0xe3 && bytes[4] === 0x15 && bytes[5] === 2), 'meter probe reply'); }
                    return commands() - before;
                } finally { await peer.close(); }
            };
            for (const [value, effective] of [['0', 0], ['', 100], ['200', 200]]) {
                await nav('settings'); await js(`document.getElementById('ICOM_CACHE_QUERY_1502_MS').value=${JSON.stringify(value)}`); await click('save-settings');
                await until(() => controller.getSettings().values.ICOM_CACHE_QUERY_1502_MS === value, 'browser saves query lifetime');
                await until(() => js("!document.getElementById('apply-settings').disabled"), 'browser query save finished');
                await click('apply-settings'); await until(() => js("document.getElementById('confirm-dialog').open"), 'browser query reconnect gate'); await click('confirm-accept');
                await until(() => controller.getState().status.broker.ready && policy().effectiveMs === effective, 'browser query active lifetime');
                assert.equal(await meterReads(), effective === 0 ? 2 : 1, 'browser override must affect actual radio transactions');
            }
            assert.equal((await js("window.splitter.request('close')")).ok, false, 'browser may not close headless service');
            window.destroy(); window = null; await sleep(1500);
            assert.equal(controller.getState().running, true, 'closing browser must keep splitter running'); assert.ok(web.server.listening);
            secondWindow = createWindow(); await secondWindow.loadURL(origin + '/login');
            await until(() => secondWindow.webContents.executeJavaScript('window.uiReady === true'), 'cookie-authenticated browser reopen');
            await secondWindow.webContents.executeJavaScript("document.getElementById('web-signout').click()", true);
            await until(() => secondWindow.webContents.executeJavaScript("location.pathname==='/login' && !!document.getElementById('login-form')"), 'sign-out');
            assert.equal(controller.getState().running, true, 'sign-out must leave splitter running');
            await until(() => secondWindow.webContents.executeJavaScript("!document.getElementById('sign-in').disabled && !document.getElementById('credentials-fields').hidden"), 'radio-credential sign-in page');
            await secondWindow.webContents.executeJavaScript("document.getElementById('username').value='beer';document.getElementById('password').value='wrongpass';document.getElementById('sign-in').click()", true);
            await until(() => secondWindow.webContents.executeJavaScript("!document.getElementById('login-error').hidden && !document.getElementById('sign-in').disabled"), 'invalid radio login error');
            assert.equal(await secondWindow.webContents.executeJavaScript("document.getElementById('password').value"), '');
            await fs.writeFile(path.join(output, '07-radio-login-error.png'), (await secondWindow.webContents.capturePage()).toPNG());
            await secondWindow.webContents.executeJavaScript("document.getElementById('password').value='testpass';document.getElementById('sign-in').click()", true);
            await until(() => secondWindow.webContents.executeJavaScript('window.uiReady===true'), 'radio credential sign-in');
            const result = { result: 'pass', interface: 'ordinary HTTPS browser without Node/preload', platform: process.platform, architecture: process.arch,
                setupLogin: true, radioCredentialLogin: true, rejectedWrongPassword: true, browserLocalPasswordImport: true, secureHttpOnlySameSiteCookie: true, noBrowserCredentialStorage: true, allSettingsFields: fields.length,
                clients: 2, privateReplies: true, exactAudioAndScope: true, oneUpstreamSession: true, measuredPingAndCache: true,
                savedVersusActiveSettings: true, perQuery200msAfterRestart: true, perQueryZeroDisablesActualReads: true, perQueryBlankInheritsActualReads: true, reconnectCancellation: true, redactedDiagnosticDownload: true,
                txStopConfirmationCancellationAndRelease: true, browserCloseKeepsService: true, signOutKeepsService: true, narrowLayout: true,
                physicalRadioUsed: false, screenshots: (await fs.readdir(output)).filter((name) => name.endsWith('.png')) };
            await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
        } finally { await Promise.allSettled(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
    } catch (error) {
        let browserState;
        const failedWindow = window && !window.isDestroyed() ? window : secondWindow;
        try { browserState = await failedWindow?.webContents.executeJavaScript("({url:location.href,ready:window.uiReady,message:document.getElementById('web-status')?.textContent,body:document.body.innerText.slice(0,3000)})"); } catch { /* A failed navigation may have no live document. */ }
        const report = controller.redact({ result: 'fail', message: error.message, errors: consoleErrors.slice(-30), browser: browserState, status: controller.getState().status });
        await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify(report, null, 2) + '\n');
        if (window && !window.isDestroyed()) { try { await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch { /* TLS failure can leave no rendered frame. */ } }
        throw error;
    } finally { window?.destroy(); secondWindow?.destroy(); await Promise.allSettled(peers.map((peer) => peer.close())); await web?.close(); await controller.close({ confirmedTx: true }); await radio.close(); }
}
if (process.versions.electron && process.type === 'browser') run().then(() => require('electron').app.exit(0), (error) => { console.error(error.message); require('electron').app.exit(1); });
else launch().catch((error) => { console.error(error.message); process.exitCode = 1; });
