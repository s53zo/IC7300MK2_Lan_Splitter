'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FIELDS, defaults, validate } = require('../src/app/settings');
const { SettingsStore, FileCredentialStore } = require('../src/app/store');
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-app-store-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const valid = () => ({ ...defaults(), ICOM_RADIO_HOST: '192.0.2.1', ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'testpass' });
test('every public CLI setting is in the editable schema with validation and units', async () => {
    const cli = await fs.readFile(path.join(__dirname, '../src/config.js'), 'utf8');
    const keys = [...new Set([...cli.matchAll(/env\.(ICOM_[A-Z_]+)/g)].map((m) => m[1]))];
    for (const key of [...keys, ...['ICOM_RADIO', 'ICOM_LISTEN'].flatMap((prefix) => ['CONTROL', 'CIV', 'AUDIO'].map((role) => `${prefix}_${role}_PORT`))]) {
        assert.ok(FIELDS.some((field) => field.key === key), key);
    }
    for (const field of FIELDS) {
        assert.ok(field.label && field.description && field.group);
        if (field.type !== 'number') continue;
        for (const invalid of [field.min - 1, field.max + 1, 'bad', '1.5']) {
            assert.throws(() => validate({ ...valid(), [field.key]: invalid }), undefined, field.key);
        }
    }
    const result = validate({ ...valid(), ICOM_CACHE_ENABLED: false, ICOM_CACHE_STATE_MS: 0 });
    assert.equal(result.options.broker.cacheEnabled, false); assert.equal(result.options.broker.cacheStateMs, 0);
    assert.equal(result.values.ICOM_PASSWORD, '');
});
test('password import is transient and settings contain no password or import path', async (t) => {
    const dir = await directory(t), imported = path.join(dir, 'import.txt');
    await fs.writeFile(imported, 'testpass\n');
    const result = validate({ ...valid(), ICOM_PASSWORD: '', ICOM_PASSWORD_FILE: imported });
    const store = new SettingsStore(dir);
    await store.save(result.values, result.password);
    const text = await fs.readFile(store.file, 'utf8');
    assert.equal(text.includes('testpass'), false); assert.equal(text.includes(imported), false);
    assert.equal(result.values.ICOM_PASSWORD_FILE, '');
    assert.equal((await store.load()).password, 'testpass');
    if (process.platform !== 'win32') {
        assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.join(dir, 'credentials'))).mode & 0o777, 0o600);
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    }
});
test('credential adapter is used instead of plaintext fallback and malformed settings are rejected', async (t) => {
    const dir = await directory(t); let password = '';
    const adapter = { read: async () => password, write: async (value) => { password = value; }, describe: () => 'Test OS vault' };
    const store = new SettingsStore(dir, adapter); const result = validate(valid());
    await store.save(result.values, result.password); assert.equal(store.describe(), 'Test OS vault');
    assert.equal((await store.load()).password, 'testpass');
    await assert.rejects(fs.stat(path.join(dir, 'credentials')), { code: 'ENOENT' });
    await fs.writeFile(store.file, '{broken'); await assert.rejects(store.load(), /could not be read/);
    await fs.writeFile(store.file, JSON.stringify({ version: 99, values: {} })); await assert.rejects(store.load(), /unsupported/);
});
test('filesystem fallback rejects loose permissions and credential symlinks', async (t) => {
    if (process.platform === 'win32') return;
    const dir = await directory(t), store = new FileCredentialStore(dir);
    await store.write('testpass'); await fs.chmod(store.file, 0o644);
    await assert.rejects(store.read(), /permissions/);
    await fs.unlink(store.file); await fs.writeFile(path.join(dir, 'other'), 'testpass', { mode: 0o600 });
    await fs.symlink(path.join(dir, 'other'), store.file);
    await assert.rejects(store.read(), /Invalid private/);
});

test('failed settings write restores the previous credential and import size is bounded', async (t) => {
    const dir = await directory(t), store = new SettingsStore(dir); const selected = validate(valid());
    await store.save(selected.values, selected.password);
    await fs.unlink(store.file); await fs.mkdir(store.file);
    await assert.rejects(store.save(selected.values, 'otherpass'));
    assert.equal(await store.credentials.read(), 'testpass');
    const oversized = path.join(dir, 'too-large'); await fs.writeFile(oversized, 'a'.repeat(1000));
    assert.throws(() => validate({ ...valid(), ICOM_PASSWORD: '', ICOM_PASSWORD_FILE: oversized }), /Cannot read/);
});
