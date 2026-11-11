'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
function defaultDirectory(platform = process.platform, env = process.env) {
    if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'IC7300MK2 LAN Splitter');
    if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'IC7300MK2 LAN Splitter');
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'icom-lan-splitter');
}
async function prepareDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Configuration directory must be a regular directory');
    if (process.platform !== 'win32') {
        if (stat.uid !== process.getuid()) throw new Error('Configuration directory belongs to another user');
        await fs.chmod(directory, 0o700);
    }
}
async function atomicWrite(file, data) {
    await prepareDirectory(path.dirname(file));
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}
async function privateRead(file) {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid private configuration file');
        if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error('Configuration file permissions must allow only its owner');
        return await fs.readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
class FileCredentialStore {
    constructor(directory) { this.file = path.join(directory, 'credentials'); }
    async read() { return await privateRead(this.file) || ''; }
    async write(password) { await atomicWrite(this.file, password); }
    forRecovery() { const store = new FileCredentialStore(path.dirname(this.file)); store.file = `${this.file}.recovery`; return store; }
    async remove() { await fs.rm(this.file, { force: true }); }
    describe() { return 'Saved in an owner-only file (0600), protected by filesystem permissions; not encrypted.'; }
}
function settingsDocument(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Saved settings could not be read. Review and save them again.'); }
    if (data.version !== 1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) throw new Error('Saved settings use an unsupported format');
    return data;
}
function safeValues(values) {
    const safe = { ...values }; delete safe.ICOM_PASSWORD; delete safe.ICOM_PASSWORD_FILE;
    return safe;
}
const encode = (value) => JSON.stringify(value, null, 2) + '\n';
class SettingsStore {
    constructor(directory, credentialStore) {
        this.directory = directory;
        this.file = path.join(directory, 'settings.json');
        this.journal = path.join(directory, 'settings.transaction.json');
        this.credentials = credentialStore || new FileCredentialStore(directory);
        this.recovery = this.credentials.forRecovery?.();
        this.operations = Promise.resolve();
    }
    enqueue(operation) {
        const pending = this.operations.then(operation);
        this.operations = pending.catch(() => {});
        return pending;
    }
    async recover() {
        const text = await privateRead(this.journal);
        if (!text) { await this.recovery?.remove(); return; }
        if (!this.recovery) throw new Error('Password storage does not support interrupted settings recovery.');
        let transaction;
        try {
            transaction = JSON.parse(text);
            if (transaction.version !== 1 || !/^[a-f0-9]{32}$/.test(transaction.generation)
                || (transaction.previous !== null && !settingsDocument(encode(transaction.previous)))) throw new Error();
        } catch { throw new Error('Interrupted settings recovery could not be read securely.'); }
        const current = await privateRead(this.file);
        let document;
        try { document = current ? settingsDocument(current) : null; } catch { document = null; }
        if (document?.generation !== transaction.generation) {
            let backup;
            try {
                backup = JSON.parse(await this.recovery.read());
                if (backup.generation !== transaction.generation || typeof backup.password !== 'string') throw new Error();
            } catch { throw new Error('Interrupted settings password recovery is unavailable. Re-enter the password before reconnecting.'); }
            // The backup travels only through the original protected credential
            // adapter. The journal contains settings and a random ID, no secret
            // or password hash. Repeating rollback after another crash is safe.
            await this.credentials.write(backup.password);
            if (transaction.previous === null) {
                if (current !== null) await fs.rm(this.file, { force: true });
            } else if (JSON.stringify(document) !== JSON.stringify(transaction.previous)) {
                await atomicWrite(this.file, encode(transaction.previous));
            }
        }
        // settings.json's generation is the commit marker. Never restore the
        // old credential after that atomic rename has committed the new pair.
        await fs.rm(this.journal, { force: true });
        await this.recovery.remove();
    }
    load() {
        return this.enqueue(async () => {
            await prepareDirectory(this.directory);
            await this.recover();
            const text = await privateRead(this.file);
            if (!text) return null;
            const data = settingsDocument(text);
            return { values: data.values, password: await this.credentials.read() || '' };
        });
    }
    save(values, password) {
        return this.enqueue(async () => {
            await prepareDirectory(this.directory);
            await this.recover();
            if (!this.recovery) throw new Error('Password storage does not support interrupted settings recovery.');
            const text = await privateRead(this.file);
            let previous = null;
            // A deliberately corrected profile may replace unreadable settings.
            // Do not copy arbitrary old text, secrets or import paths to a journal.
            try {
                if (text) {
                    const saved = settingsDocument(text);
                    previous = { version: 1, ...(/^[a-f0-9]{32}$/.test(saved.generation) ? { generation: saved.generation } : {}), values: safeValues(saved.values) };
                }
            } catch { /* No valid old profile to restore. */ }
            const generation = randomBytes(16).toString('hex');
            await this.recovery.write(JSON.stringify({ generation, password: await this.credentials.read() || '' }));
            try { await atomicWrite(this.journal, encode({ version: 1, generation, previous })); }
            catch (error) { await this.recovery.remove(); throw error; }
            try {
                await this.credentials.write(password);
                await atomicWrite(this.file, encode({ version: 1, generation, values: safeValues(values) }));
            } catch (error) {
                try { await this.recover(); }
                catch { throw new Error('Settings could not be saved and password storage could not be restored. Re-enter the password before reconnecting.'); }
                throw error;
            }
            await this.recover();
        });
    }
    describe() { return this.credentials.describe?.() || 'Password storage is managed by this application.'; }
}
module.exports = { SettingsStore, FileCredentialStore, defaultDirectory, atomicWrite, privateRead };
