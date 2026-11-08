'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateRequest, diagnosticReport } = require('../desktop/security');
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
