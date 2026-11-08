'use strict';
// Explicit opt-in native packaged-app verification. Every network endpoint is
// a loopback synthetic fixture; normal application launches never load this.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const dgram = require('node:dgram');
const { IcomPeer } = require('../tests/fixtures/icom-radio');
const { client, frame, sleep } = require('../tests/fixtures/harness');
async function ports() {
    const sockets = [];
    try {
        for (let i = 0; i < 3; i++) {
            const socket = dgram.createSocket('udp4'); sockets.push(socket);
            await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
        }
        return sockets.map((s) => s.address().port);
    } finally { await Promise.all(sockets.map((s) => new Promise((resolve) => s.close(resolve)))); }
}
async function until(predicate, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(20); }
}
async function run({ window, controller, outputDirectory, directory, credentialStore, getCloseState }) {
    const js = (code) => window.webContents.executeJavaScript(code, true);
    const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const nav = (name) => js(`document.querySelector('[data-view="${name}"]').click()`);
    const capture = async (name) => { await sleep(180); const image = await window.webContents.capturePage(); await fs.writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG()); };
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    const peers = [];
    try {
        await fs.mkdir(outputDirectory, { recursive: true });
        await until(() => js('window.uiReady === true'), 'renderer ready');
        assert.equal(controller.getState().firstRun, true);
        await nav('settings'); await capture('01-first-run');
        const fields = controller.getFields();
        assert.equal(await js('document.querySelectorAll("#settings-form input, #settings-form select").length'), fields.length);
        await js("document.getElementById('ICOM_RADIO_HOST').value='999.0.0.1'"); await click('save-settings');
        await until(() => js("!document.getElementById('message').hidden && document.getElementById('message').classList.contains('error')"), 'validation error');
        assert.equal(controller.getState().running, false); await capture('02-settings-error');
        const [control, civ, audio] = await ports(), upstream = radio.config();
        const values = { ICOM_RADIO_HOST: '127.0.0.1', ICOM_BIND_ADDRESS: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass',
            ICOM_LISTEN_CONTROL_PORT: String(control), ICOM_LISTEN_CIV_PORT: String(civ), ICOM_LISTEN_AUDIO_PORT: String(audio),
            ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort), ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort) };
        await js(`for (const [key,value] of Object.entries(${JSON.stringify(values)})) document.getElementById(key).value=value;`);
        await click('test-connection');
        await until(() => controller.getState().status?.broker?.ready, 'radio readiness');
        assert.equal(await credentialStore.read(), 'testpass', 'native credential storage round trip');
        const disk = await fs.readFile(path.join(directory, 'credentials.bin'));
        assert.equal(disk.includes(Buffer.from('testpass')), false, 'password encrypted on disk');
        await until(() => js("document.getElementById('ICOM_PASSWORD').value === ''"), 'password cleared from form');
        peers.push(await client({ host: '127.0.0.1', controlPort: control, civPort: civ, audioPort: audio }, { password: 'testpass' }));
        peers.push(await client({ host: '127.0.0.1', controlPort: control, civPort: civ, audioPort: audio }, { password: 'testpass' }));
        peers[0].sendCiv(frame(3, [], 0xe1)); peers[1].sendCiv(frame(4, [], 0xe2));
        await until(() => peers[0].receivedCiv.some((f) => f[4] === 3 && f[2] === 0xe1)
            && peers[1].receivedCiv.some((f) => f[4] === 4 && f[2] === 0xe2), 'private addressed query replies');
        assert.equal(peers[0].receivedCiv.some((f) => f[4] === 4), false); assert.equal(peers[1].receivedCiv.some((f) => f[4] === 3), false);
        const pcm = Buffer.alloc(1364, 0x31), scope = Buffer.alloc(475, 0x45);
        radio.rxAudio(pcm); radio.scope(scope);
        await until(() => peers.every((p) => p.receivedAudio.length && p.receivedCiv.some((f) => f[4] === 0x27 && f[5] === 0)), 'audio/scope fanout');
        for (const peer of peers) { assert.deepEqual(peer.receivedAudio[0], pcm); assert.deepEqual(peer.receivedCiv.find((f) => f[4] === 0x27 && f[5] === 0).subarray(21, -1), scope); }
        peers[0].sendCiv(frame(0x15, [2], 0xe1)); peers[1].sendCiv(frame(0x15, [2], 0xe2));
        await until(() => controller.getState().status?.cache?.hits > 0, 'cache hit');
        await until(() => Number.isFinite(controller.getState().latency?.pingMs), 'measured native ping', 20000);
        await sleep(1200); controller.sample();
        await until(() => js("document.getElementById('start-button').hidden && !document.getElementById('stop-button').disabled"), 'connected controls');
        assert.equal(controller.getState().status.nativeClients.authenticated, 2); assert.equal(controller.getState().status.connectedUpstreamSessions, 1);
        assert.deepEqual(radio.connections, { control: 1, civ: 1, audio: 1 });
        for (const screen of ['dashboard', 'clients', 'cache', 'settings', 'diagnostics']) { await nav(screen); await capture(`03-${screen}`); }
        await nav('settings');
        const [pendingControl] = await ports();
        await js(`document.getElementById('ICOM_CACHE_METERS_MS').value='125'; document.getElementById('ICOM_LISTEN_CONTROL_PORT').value=${JSON.stringify(String(pendingControl))}`); await click('save-settings');
        await until(() => controller.getState().pendingChanges, 'pending settings');
        assert.equal(controller.service.broker.options.cacheMetersMs, 100, 'saved change must not alter running connection');
        assert.equal(controller.service.address().controlPort, control, 'pending port must not alter active listener');
        await until(() => js(`document.getElementById('footer-address').textContent.includes(${JSON.stringify('control port ')} + ${control})`), 'active connection label remains unchanged');
        await click('apply-settings'); await until(() => js("document.getElementById('confirm-dialog').open"), 'reconnect confirmation');
        await click('confirm-cancel'); assert.equal(controller.service.broker.options.cacheMetersMs, 100); assert.equal(radio.connections.control, 1);
        await capture('04-pending-settings');
        await nav('dashboard'); window.setSize(640, 720); await capture('05-narrow-dashboard');
        assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, 'narrow dashboard must not overflow horizontally');
        await nav('settings'); await capture('06-narrow-settings');
        assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, 'narrow settings must not overflow horizontally');
        window.setSize(1120, 800); await nav('dashboard');
        peers[0].sendCiv(frame(0x1c, [0, 1], 0xe1));
        await until(() => controller.getState().txActive && radio.ptt, 'synthetic TX ownership');
        window.close(); await until(() => js("document.getElementById('confirm-dialog').open"), 'TX close confirmation');
        await capture('07-transmission-confirmation'); await click('confirm-cancel');
        assert.equal(controller.getState().running, true); assert.equal(radio.ptt, true);
        window.close(); await until(() => js("document.getElementById('confirm-dialog').open"), 'TX close confirmation retry');
        await click('confirm-accept'); await until(() => getCloseState().allowClose && !controller.getState().running, 'confirmed shutdown');
        assert.equal(radio.ptt, false, 'confirmed close releases synthetic TX');
        await Promise.allSettled(peers.map((p) => p.close())); peers.length = 0;
        // Reopen the persisted configuration through a fresh owner. This uses
        // the same credential backend and proves automatic connection on load.
        const { AppController } = require('../src/app/controller');
        const reopened = new AppController({ directory, credentialStore });
        try {
            await reopened.initialize(); await until(() => reopened.getState().status?.broker?.ready, 'automatic reconnect from saved settings');
            assert.equal(reopened.getState().firstRun, false); assert.equal(reopened.service.broker.options.cacheMetersMs, 125);
            assert.equal(reopened.getState().history.length <= 2, true, 'history resets on reopen');
        } finally { await reopened.close({ confirmedTx: true }); }
        const report = require('./security').diagnosticReport(controller.getState());
        assert.equal(JSON.stringify(report).includes('testpass'), false);
        const result = { result: 'pass', platform: process.platform, architecture: process.arch, packaged: require('electron').app.isPackaged,
            firstRun: true, allSettingsFields: fields.length, nativeCredentialRoundTrip: true, nativeCredentialEncryptedOnDisk: true,
            clients: 2, upstreamSessions: 1, privateReplies: true, exactAudioAndScope: true, cacheHits: true, measuredPing: true,
            saveWithoutApplying: true, reconnectCancellation: true, txCloseCancellation: true, txCloseConfirmedRelease: true,
            automaticConnectionOnReopen: true, historyReset: true, narrowLayout: true, redactedDiagnostics: true,
            physicalRadioUsed: false, screenshots: (await fs.readdir(outputDirectory)).filter((name) => name.endsWith('.png')) };
        await fs.writeFile(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
    } finally { await Promise.allSettled(peers.map((p) => p.close())); await radio.close(); }
}
async function writeFailure({ window, controller, outputDirectory, error, events }) {
    await fs.mkdir(outputDirectory, { recursive: true });
    let renderer;
    try {
        renderer = await window.webContents.executeJavaScript(`({readyState:document.readyState,uiReady:window.uiReady===true,bridgeAvailable:typeof window.splitter?.request==='function',title:document.title,url:location.href,message:document.getElementById('message')?.textContent,bodyText:document.body?.innerText.slice(0,12000)})`);
    } catch (failure) { renderer = { error: failure.message }; }
    const clean = (value) => JSON.parse(JSON.stringify(controller.redact(value)).split('testpass').join('[fixture password redacted]'));
    const report = clean({ result: 'fail', platform: process.platform, architecture: process.arch, message: error.message,
        renderer, events: events.slice(-50), status: controller.getState().status });
    await fs.writeFile(path.join(outputDirectory, 'failure.json'), JSON.stringify(report, null, 2) + '\n');
    try { await fs.writeFile(path.join(outputDirectory, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch { /* A crashed renderer cannot produce an image. */ }
    console.error(JSON.stringify({ desktopSmokeFailure: report }));
}
module.exports = { run, writeFailure };
