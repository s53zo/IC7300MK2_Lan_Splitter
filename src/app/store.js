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
    describe() { return 'Saved in an owner-only file (0600), protected by filesystem permissions; not encrypted.'; }
}
class SettingsStore {
    constructor(directory, credentialStore) {
        this.directory = directory;
        this.file = path.join(directory, 'settings.json');
        this.credentials = credentialStore || new FileCredentialStore(directory);
    }
    async load() {
        await prepareDirectory(this.directory);
        const text = await privateRead(this.file);
        if (!text) return null;
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('Saved settings could not be read. Review and save them again.'); }
        if (data.version !== 1 || !data.values || typeof data.values !== 'object') throw new Error('Saved settings use an unsupported format');
        return { values: data.values, password: await this.credentials.read() || '' };
    }
    async save(values, password) {
        // Store only explicitly selected fields; no secret or import path goes
        // into settings.json. Credential adapters may use an OS vault instead.
        const safe = { ...values }; delete safe.ICOM_PASSWORD; delete safe.ICOM_PASSWORD_FILE;
        const previous = await this.credentials.read() || '';
        await this.credentials.write(password);
        try { await atomicWrite(this.file, JSON.stringify({ version: 1, values: safe }, null, 2) + '\n'); }
        catch (error) {
            try { await this.credentials.write(previous); }
            catch { throw new Error('Settings could not be saved and password storage could not be restored. Re-enter the password before reconnecting.'); }
            throw error;
        }
    }
    describe() { return this.credentials.describe?.() || 'Password storage is managed by this application.'; }
}
module.exports = { SettingsStore, FileCredentialStore, defaultDirectory, atomicWrite, privateRead };
