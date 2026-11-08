'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateRequest, diagnosticReport, sameLocalFile } = require('../desktop/security');
const { DesktopCredentials } = require('../desktop/main');

test('desktop IPC accepts only own top-level local frame and allowlisted actions', () => {
    const file = path.resolve('desktop/index.html'), frame = { url: pathToFileURL(file).href };
    const contents = { mainFrame: frame }, window = { webContents: contents };
    const event = { sender: contents, senderFrame: frame };
    assert.doesNotThrow(() => validateRequest(event, window, file, 'save', { ICOM_RADIO_HOST: '127.0.0.1' }));
    for (const untrusted of [{ ...event, sender: {} }, { ...event, senderFrame: { url: frame.url } }, { ...event, senderFrame: { url: 'https://example.com' } }]) {
        assert.throws(() => validateRequest(untrusted, window, file, 'start'), /Untrusted/);
    }
    assert.throws(() => validateRequest(event, window, file, 'shell'), /Unknown/);
    for (const payload of [[], null, 'bad', { value: 'x'.repeat(40000) }]) assert.throws(() => validateRequest(event, window, file, 'save', payload), /Invalid/);
});


test('desktop local file identity decodes Windows paths without relaxing origin or frame checks', () => {
    const file = 'C:\\Users\\RunnerAdmin\\AppData\\Local\\Programs\\IC-7300MK2 LAN Splitter\\resources\\app.asar\\desktop\\index.html';
    assert.equal(sameLocalFile('file:///c:/users/runneradmin/AppData/Local/Programs/IC-7300MK2%20LAN%20Splitter/resources/app.asar/desktop/index.html', file, 'win32'), true);
    assert.equal(sameLocalFile('file:///C:/Users/RunnerAdmin/AppData/Local/Programs/IC-7300MK2%20LAN%20Splitter/resources/app.asar/desktop/index.html', file, 'win32'), true);
    for (const url of [
        'https://example.com/index.html', 'file://server/share/index.html',
        'file:///C:/Users/RunnerAdmin/AppData/Local/Programs/other/resources/app.asar/desktop/index.html',
        'file:///C:/Users/RunnerAdmin/AppData/Local/Programs/IC-7300MK2%20LAN%20Splitter/resources/app.asar/desktop/index.html?query=1',
        'file:///C:/Users/RunnerAdmin/AppData/Local/Programs/IC-7300MK2%20LAN%20Splitter/resources/app.asar/desktop/index.html#fragment',
        'file:///C:/Users/RunnerAdmin/AppData/Local/Programs/IC-7300MK2%20LAN%20Splitter/resources/app.asar/desktop%2Findex.html',
        'not a URL',
    ]) assert.equal(sameLocalFile(url, file, 'win32'), false, url);
    assert.equal(sameLocalFile('file:///Applications/Splitter.app/Contents/Resources/app.asar/desktop/index.html', '/Applications/Splitter.app/Contents/Resources/app.asar/desktop/index.html', 'darwin'), true);
    assert.equal(sameLocalFile('file:///applications/Splitter.app/Contents/Resources/app.asar/desktop/index.html', '/Applications/Splitter.app/Contents/Resources/app.asar/desktop/index.html', 'darwin'), false);
});

test('diagnostic export omits all settings and credential state', () => {
    const report = diagnosticReport({ running: true, settings: { values: { ICOM_PASSWORD: 'private' } }, password: 'private',
        status: { cache: { hits: 4 } }, rates: { radioPerSecond: 3 }, history: [], events: [] });
    assert.equal(JSON.stringify(report).includes('private'), false); assert.equal(report.status.cache.hits, 4);
});

test('desktop credentials use asynchronous native encryption and never fall back when unavailable', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-desktop-credentials-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const native = { isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (password) => Buffer.from(password.split('').reverse().join('')),
        decryptStringAsync: async (bytes) => ({ result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false }) };
    const store = new DesktopCredentials(directory, native);
    assert.equal(await store.read(), ''); await store.write('test-secret'); assert.equal(await store.read(), 'test-secret');
    assert.equal((await fs.readFile(store.file)).toString(), 'terces-tset');
    native.isAsyncEncryptionAvailable = async () => false;
    await assert.rejects(store.write('new-secret'), /unavailable/); await assert.rejects(store.read(), /unavailable/);
    assert.equal((await fs.readFile(store.file)).toString(), 'terces-tset');
});

test('failed native UI bootstrap records bounded redacted diagnostics and a screenshot', async (t) => {
    const { writeFailure } = require('../desktop/smoke');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-desktop-failure-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const original = console.error; console.error = () => {};
    try {
        await writeFailure({ outputDirectory: directory, error: new Error('Timed out: renderer ready'),
            window: { webContents: { executeJavaScript: async () => ({ readyState: 'complete', bridgeAvailable: true, message: 'testpass sensitive-value', bodyText: 'setup screen' }),
                capturePage: async () => ({ toPNG: () => Buffer.from('png-fixture') }) } },
            controller: { redact: (value) => JSON.parse(JSON.stringify(value).split('sensitive-value').join('[redacted]')), getState: () => ({ status: { radio: { connected: false } } }) },
            events: Array.from({ length: 80 }, (_, i) => ({ kind: 'request-error', action: 'fields', index: i })),
        });
    } finally { console.error = original; }
    const text = await fs.readFile(path.join(directory, 'failure.json'), 'utf8'), report = JSON.parse(text);
    assert.equal(report.renderer.bridgeAvailable, true); assert.equal(report.events.length, 50);
    assert.equal(text.includes('testpass'), false); assert.equal(text.includes('sensitive-value'), false);
    assert.deepEqual(await fs.readFile(path.join(directory, 'failure.png')), Buffer.from('png-fixture'));
});
