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
        if (!['number', 'optional-number'].includes(field.type)) continue;
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
    const dir = await directory(t); let password = '', recovery = '';
    const adapter = { read: async () => password, write: async (value) => { password = value; }, describe: () => 'Test OS vault',
        forRecovery: () => ({ read: async () => recovery, write: async (value) => { recovery = value; }, remove: async () => { recovery = ''; } }) };
    const store = new SettingsStore(dir, adapter); const result = validate(valid());
    await store.save(result.values, result.password); assert.equal(store.describe(), 'Test OS vault');
    assert.equal((await store.load()).password, 'testpass');
    await assert.rejects(fs.stat(path.join(dir, 'credentials')), { code: 'ENOENT' });
    await fs.writeFile(store.file, '{broken'); await assert.rejects(store.load(), /could not be read/);
    await fs.writeFile(store.file, JSON.stringify({ version: 99, values: {} })); await assert.rejects(store.load(), /unsupported/);
});

test('custom credential adapters without protected recovery fail before changing credentials', async (t) => {
    const dir = await directory(t); let writes = 0;
    const store = new SettingsStore(dir, { read: async () => 'savedpass', write: async () => { writes++; } });
    await assert.rejects(store.save({}, 'newpass'), /does not support interrupted settings recovery/);
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readdir(dir), []);
});

test('settings saves and reads serialize the whole credential/settings transaction', async (t) => {
    const dir = await directory(t), store = new SettingsStore(dir);
    const saves = [store.save({ ICOM_USERNAME: 'first' }, 'firstpass'), store.save({ ICOM_USERNAME: 'second' }, 'secondpass')];
    const read = store.load();
    await Promise.all(saves);
    assert.deepEqual(await read, { values: { ICOM_USERNAME: 'second' }, password: 'secondpass' });
    assert.deepEqual((await fs.readdir(dir)).sort(), ['credentials', 'settings.json']);
});

test('saving corrected settings replaces invalid configuration without copying its text into recovery', async (t) => {
    const dir = await directory(t), store = new SettingsStore(dir);
    await fs.writeFile(store.file, '{invalid settings', { mode: 0o600 });
    await store.save({ ICOM_USERNAME: 'corrected' }, 'correctedpass');
    assert.deepEqual(await store.load(), { values: { ICOM_USERNAME: 'corrected' }, password: 'correctedpass' });
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


test('per-command cache fields persist overrides and blank values restore family inheritance', async (t) => {
    const { queryCatalog } = require('../src/read-cache');
    const fields = FIELDS.filter((field) => field.cacheQuery);
    assert.equal(fields.length, queryCatalog().length);
    assert.ok(fields.every((field) => field.type === 'optional-number' && field.default === '' && field.min === 0 && field.max === 1000));
    const result = validate({ ...valid(), ICOM_CACHE_QUERY_1502_MS: '0200', ICOM_CACHE_QUERY_1507_MS: '0' });
    assert.deepEqual(result.options.broker.cacheQueryTtls, { '1502': 200, '1507': 0 });
    assert.equal(result.values.ICOM_CACHE_QUERY_1502_MS, '200');
    const dir = await directory(t), store = new SettingsStore(dir);
    await store.save(result.values, result.password);
    const loaded = await store.load(), restored = validate(loaded.values, loaded.password);
    assert.deepEqual(restored.options.broker.cacheQueryTtls, { '1502': 200, '1507': 0 });
    const inherited = validate({ ICOM_CACHE_QUERY_1502_MS: '' }, loaded.password, loaded.values);
    assert.deepEqual(inherited.options.broker.cacheQueryTtls, { '1507': 0 });
    assert.equal(inherited.options.broker.cacheMetersMs, 100);
    assert.equal(inherited.values.ICOM_CACHE_QUERY_1502_MS, '');
});
