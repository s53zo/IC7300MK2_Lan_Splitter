'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SettingsStore } = require('../src/app/store');
const projectRoot = path.resolve(__dirname, '..');

// Exercise the production desktop adapter with an isolated encryption fixture.
// This proves adapter use and encrypted recovery files, not OS keychain behavior.
function adapterFor(directory, kind, root) {
    const path = require('node:path');
    if (kind === 'file') return new (require(path.join(root, 'src/app/store')).FileCredentialStore)(directory);
    const crypto = require('node:crypto'), key = Buffer.alloc(32, 0x73);
    const native = {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (value) => {
            const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
            const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
            return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
        },
        decryptStringAsync: async (bytes) => {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
            decipher.setAuthTag(bytes.subarray(12, 28));
            return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
        },
    };
    return new (require(path.join(root, 'desktop/main')).DesktopCredentials)(directory, native);
}

async function crashWorker() {
    const fs = require('node:fs/promises'), path = require('node:path');
    const [directory, kind, phase, root, operation] = process.argv.slice(1);
    const { SettingsStore } = require(path.join(root, 'src/app/store'));
    const credentials = adapterFor(directory, kind, root);
    const rename = fs.rename, remove = fs.rm;
    async function boundary(name) {
        if (name !== phase) return;
        process.send({ phase: name });
        await new Promise(() => { setInterval(() => {}, 1000); });
    }
    fs.rename = async (from, to) => {
        const result = await rename(from, to);
        if (to === credentials.file + '.recovery') await boundary('backup-written');
        if (to === path.join(directory, 'settings.transaction.json')) await boundary('journal-prepared');
        if (to === credentials.file) await boundary('credential-replaced');
        if (to === path.join(directory, 'settings.json')) await boundary('profile-committed');
        return result;
    };
    fs.rm = async (file, options) => {
        const result = await remove(file, options);
        if (file === path.join(directory, 'settings.transaction.json')) await boundary('journal-cleared');
        return result;
    };
    const store = new SettingsStore(directory, credentials);
    if (operation === 'load') await store.load();
    else await store.save({ ICOM_USERNAME: 'new-user' }, 'new-radio-password');
    throw new Error('Fixture did not reach requested transaction boundary');
}

async function killAt(t, directory, kind, phase, operation = 'save') {
    const code = `const adapterFor = ${adapterFor.toString()}; (${crashWorker.toString()})().catch(error => { console.error(error.message); process.exit(1); });`;
    const child = spawn(process.execPath, ['-e', code, directory, kind, phase, projectRoot, operation], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Crash fixture timed out at ${phase}: ${stderr}`)); }, 5000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Crash fixture exited before ${phase} (${code}): ${stderr}`)); });
        child.once('message', (message) => { clearTimeout(timer); assert.equal(message.phase, phase); resolve(); });
    });
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGKILL');
    assert.deepEqual(await exit, { code: null, signal: 'SIGKILL' });
}

async function directory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-settings-crash-'));
    t.after(() => fs.rm(directory, { force: true, recursive: true }));
    return directory;
}
async function seed(directory, kind, legacy = false) {
    const credentials = adapterFor(directory, kind, projectRoot), store = new SettingsStore(directory, credentials);
    if (legacy) {
        // Deployed v1 Linux profiles have no transaction generation field.
        await fs.writeFile(store.file, JSON.stringify({ version: 1, values: { ICOM_USERNAME: 'old-user' } }), { mode: 0o600 });
        await credentials.write('old-radio-password');
    } else await store.save({ ICOM_USERNAME: 'old-user' }, 'old-radio-password');
    return store;
}
async function assertPrivateRecovery(directory, kind) {
    for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name), bytes = await fs.readFile(file);
        if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600, name);
        if (name.endsWith('.json') || kind === 'desktop') {
            assert.equal(bytes.includes(Buffer.from('old-radio-password')), false, name);
            assert.equal(bytes.includes(Buffer.from('new-radio-password')), false, name);
        }
    }
}

test('killed saves recover coherent old or new profiles through file and encrypted desktop adapters', async (t) => {
    for (const kind of ['file', 'desktop']) for (const legacy of [true, false]) {
        for (const phase of ['backup-written', 'journal-prepared', 'credential-replaced', 'profile-committed', 'journal-cleared']) {
            await t.test(`${kind}, ${legacy ? 'legacy v1' : 'generation profile'}, ${phase}`, async (t) => {
                const dir = await directory(t); await seed(dir, kind, legacy);
                await killAt(t, dir, kind, phase); await assertPrivateRecovery(dir, kind);
                const store = new SettingsStore(dir, adapterFor(dir, kind, projectRoot));
                const committed = ['profile-committed', 'journal-cleared'].includes(phase);
                assert.deepEqual(await store.load(), { values: { ICOM_USERNAME: committed ? 'new-user' : 'old-user' }, password: committed ? 'new-radio-password' : 'old-radio-password' });
                assert.deepEqual((await fs.readdir(dir)).sort(), [kind === 'file' ? 'credentials' : 'credentials.bin', 'settings.json']);
                await store.save({ ICOM_USERNAME: 'after-recovery' }, 'after-recovery-password');
                assert.equal((await store.load()).password, 'after-recovery-password');
            });
        }
    }
});

test('recovery remains repeatable when rollback itself is killed after replacing the credential', async (t) => {
    for (const kind of ['file', 'desktop']) await t.test(kind, async (t) => {
        const dir = await directory(t); await seed(dir, kind, true);
        await killAt(t, dir, kind, 'credential-replaced');
        await killAt(t, dir, kind, 'credential-replaced', 'load');
        await assertPrivateRecovery(dir, kind);
        const store = new SettingsStore(dir, adapterFor(dir, kind, projectRoot));
        assert.deepEqual(await store.load(), { values: { ICOM_USERNAME: 'old-user' }, password: 'old-radio-password' });
    });
});

test('interrupted first save recovers first-run state or the complete newly committed profile', async (t) => {
    for (const kind of ['file', 'desktop']) for (const phase of ['journal-prepared', 'credential-replaced', 'profile-committed']) {
        await t.test(`${kind}, ${phase}`, async (t) => {
            const dir = await directory(t); await killAt(t, dir, kind, phase);
            const store = new SettingsStore(dir, adapterFor(dir, kind, projectRoot));
            const loaded = await store.load();
            assert.deepEqual(loaded, phase === 'profile-committed' ? { values: { ICOM_USERNAME: 'new-user' }, password: 'new-radio-password' } : null);
            if (loaded === null) assert.equal(await store.credentials.read(), '');
        });
    }
});
