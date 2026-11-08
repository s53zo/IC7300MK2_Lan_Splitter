'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateRequest, diagnosticReport } = require('./security');

class DesktopCredentials {
    constructor(directory, safeStorage) { this.file = path.join(directory, 'credentials.bin'); this.safeStorage = safeStorage; }
    async available() {
        if (!await this.safeStorage.isAsyncEncryptionAvailable()) throw new Error('Secure password storage is unavailable. Unlock your system login keychain and try again.');
        if (process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('A secure desktop credential store is required.');
    }
    async read() {
        let bytes;
        try {
            const stat = await fs.lstat(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error('Credential file is not private');
            bytes = await fs.readFile(this.file);
        } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
        await this.available();
        const decrypted = await this.safeStorage.decryptStringAsync(bytes);
        if (decrypted.shouldReEncrypt) await this.write(decrypted.result);
        return decrypted.result;
    }
    async write(password) {
        await this.available();
        await require('../src/app/store').atomicWrite(this.file, await this.safeStorage.encryptStringAsync(password));
    }
    describe() { return process.platform === 'darwin' ? 'Protected by macOS Keychain-backed encryption' : 'Protected by your Windows login (DPAPI)'; }
}
async function main() {
    const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu } = require('electron');
    const { defaultDirectory } = require('../src/app/store');
    const smokeArg = process.argv.find((arg) => arg.startsWith('--ui-smoke='));
    const smokeDirectory = smokeArg ? path.resolve(smokeArg.slice('--ui-smoke='.length)) : null;
    // Set Chromium paths synchronously before Electron starts its child sandboxes.
    const startupFs = require('node:fs');
    const userDirectory = smokeDirectory ? startupFs.mkdtempSync(path.join(os.tmpdir(), 'icom-ui-smoke-')) : defaultDirectory();
    startupFs.mkdirSync(userDirectory, { recursive: true, mode: 0o700 });
    app.setPath('userData', userDirectory);
    app.setPath('sessionData', userDirectory);
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    let window, controller, allowClose = false, closing = false;
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    await app.whenReady();
    const { AppController } = require('../src/app/controller');
    const settings = require('../src/app/settings');
    const directory = app.getPath('userData');
    controller = new AppController({ directory, credentialStore: new DesktopCredentials(directory, safeStorage) });
    const indexFile = path.join(__dirname, 'index.html');
    window = new BrowserWindow({ width: 1120, height: 800, minWidth: 600, minHeight: 480,
        title: 'IC-7300MK2 LAN Splitter', backgroundColor: '#f4f5f3', show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
            nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
        { label: 'File', submenu: [{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => window.close() }] },
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    ]));
    async function stopAndClose(confirmedTx = false) {
        if (closing) return { busy: true };
        closing = true;
        try {
            const result = await controller.close({ confirmedTx });
            if (result?.requiresConfirmation) { window.webContents.send('splitter:confirm-close'); return result; }
            if (result?.releaseConfirmed === false) await dialog.showMessageBox(window, { type: 'warning', title: 'Receive state could not be confirmed', message: 'The splitter stopped, but the radio did not confirm receive state.', detail: 'Check the radio before leaving it unattended. The connection may have been lost during transmission release.', buttons: ['Close application'] });
            allowClose = true;
            if (!smokeDirectory) { window.destroy(); app.quit(); }
            return { closed: true };
        } finally { closing = false; }
    }
    window.on('close', (event) => { if (!allowClose) { event.preventDefault(); void stopAndClose().catch(() => window.webContents.send('splitter:snapshot', controller.getState())); } });
    app.on('before-quit', (event) => { if (!allowClose) { event.preventDefault(); window.close(); } });
    app.on('window-all-closed', () => { if (allowClose) app.quit(); });
    ipcMain.handle('splitter:request', async (event, action, payload) => {
        try {
            validateRequest(event, window, indexFile, action, payload);
            switch (action) {
            case 'state': return { ok: true, value: controller.getState() };
            case 'settings': return { ok: true, value: { ...controller.getSettings(), configDirectory: directory, interfaces: controller.getNetworkInterfaces() } };
            case 'fields': return { ok: true, value: settings.FIELDS };
            case 'defaults': return { ok: true, value: Object.fromEntries(settings.FIELDS.map((field) => [field.key, field.default ?? ''])) };
            case 'save': await controller.saveSettings(payload); return { ok: true, value: controller.getState() };
            case 'start': await controller.start(); return { ok: true, value: controller.getState() };
            case 'stop': return { ok: true, value: await controller.stop({ confirmedTx: payload?.confirmedTx === true }) };
            case 'reconnect': return { ok: true, value: await controller.reconnect({ confirmedTx: payload?.confirmedTx === true }) };
            case 'close': return { ok: true, value: await stopAndClose(payload?.confirmedTx === true) };
            case 'password-file': {
                const chosen = await dialog.showOpenDialog(window, { title: 'Import radio password file', properties: ['openFile'] });
                return { ok: true, value: chosen.canceled ? null : chosen.filePaths[0] };
            }
            case 'export': {
                const chosen = await dialog.showSaveDialog(window, { title: 'Export diagnostic report', defaultPath: `icom-splitter-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Diagnostic report', extensions: ['json'] }] });
                if (!chosen.canceled && chosen.filePath) await fs.writeFile(chosen.filePath, JSON.stringify(diagnosticReport(controller.getState()), null, 2) + '\n', { mode: 0o600 });
                return { ok: true, value: !chosen.canceled };
            }
            }
        } catch (error) {
            // Controller errors are redacted before reaching the renderer.
            return { ok: false, error: action === 'save' || action === 'start' || action === 'reconnect' || action === 'stop' ? controller.redact(error.message) : 'The requested action could not be completed. Please check Diagnostics.' };
        }
    });
    controller.on('snapshot', (state) => { if (window && !window.isDestroyed()) window.webContents.send('splitter:snapshot', state); });
    await window.loadFile(indexFile);
    window.show();
    try { await controller.initialize(); } catch { /* State contains an actionable error; keep the window open. */ }
    window.webContents.send('splitter:snapshot', controller.getState());
    if (smokeDirectory) {
        try { await require('./smoke').run({ app, window, controller, outputDirectory: smokeDirectory, directory, credentialStore: controller.options?.credentialStore || new DesktopCredentials(directory, safeStorage), getCloseState: () => ({ allowClose }) });
            allowClose = true; await controller.close({ confirmedTx: true }); window.destroy(); app.exit(0);
        } catch (error) { console.error(`Desktop smoke failed: ${error.message}`); allowClose = true; await controller.close({ confirmedTx: true }).catch(() => {}); app.exit(1); }
    }
}
if (require.main === module || (process.versions.electron && process.type === 'browser')) main().catch(() => { console.error('The desktop application could not start.'); process.exitCode = 1; });
module.exports = { DesktopCredentials };
