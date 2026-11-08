'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop installers require native Windows/macOS runners');
    const { build, Platform, Arch } = require('electron-builder');
    const root = path.resolve(__dirname, '..');
    const label = process.env.RELEASE_LABEL || require('../package.json').version;
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,100}$/.test(label)) throw new Error('Invalid release label');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const meta = path.join(root, '.release', 'desktop-metadata'); fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, 'BUILD.json'), JSON.stringify({ label, commit, electron: require('electron/package.json').version,
        target: `${process.platform}-${process.arch}`, source: `https://github.com/s53zo/IC7300MK2_Lan_Splitter/tree/${commit}`,
        signing: process.platform === 'darwin' ? 'ad-hoc only; not notarized' : 'unsigned',
    }, null, 2) + '\n');
    const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });
    const config = {
        appId: 'si.s53zo.icom-lan-splitter', productName: 'Icom LAN Splitter', executableName: 'icom-lan-splitter',
        electronVersion: require('electron/package.json').version, npmRebuild: false, asar: true,
        directories: { output: '.release/desktop', buildResources: 'build' },
        files: ['src/**', 'desktop/**', 'package.json', 'LICENSE', 'NOTICE.md', 'docs/releases.md', 'docs/interfaces.md', 'docs/operations.md', 'third_party/**', '!**/*.test.js', 'tests/fixtures/**'],
        extraMetadata: { main: 'desktop/main.js', version: label },
        extraResources: [{ from: meta, to: 'release' }, { from: 'LICENSE', to: 'LICENSE' }, { from: 'NOTICE.md', to: 'NOTICE.md' },
            { from: 'third_party', to: 'third_party' }, { from: 'docs/interfaces.md', to: 'INSTALLATION.md' },
            { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE-ELECTRON.txt' },
            { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES-CHROMIUM.html' }],
        extraFiles: [],
        publish: null,
        win: { target: ['nsis'], icon: 'build/icon.ico', signAndEditExecutable: false,
            artifactName: `icom-lan-splitter-${label}-win32-x64-Setup.exe` },
        nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
            createStartMenuShortcut: true, createDesktopShortcut: true, runAfterFinish: false, shortcutName: 'Icom LAN Splitter',
            deleteAppDataOnUninstall: false },
        mac: { target: ['dmg'], executableName: 'Icom LAN Splitter', minimumSystemVersion: '13.5', icon: 'build/icon.icns', category: 'public.app-category.utilities',
            identity: '-', hardenedRuntime: false, notarize: false,
            extendInfo: { NSLocalNetworkUsageDescription: 'Connect to your Icom radio and share it with clients on your local network.' },
            artifactName: `icom-lan-splitter-${label}-darwin-${process.arch}.dmg` },
        dmg: { title: 'Icom LAN Splitter', sign: false, window: { width: 540, height: 380 },
            contents: [{ x: 130, y: 150, type: 'file' }, { x: 410, y: 150, type: 'link', path: '/Applications' }] },
    };
    const artifacts = await build({ targets: (process.platform === 'win32' ? Platform.WINDOWS : Platform.MAC).createTarget(
        process.platform === 'win32' ? 'nsis' : 'dmg', process.arch === 'arm64' ? Arch.arm64 : Arch.x64), config, publish: 'never' });
    const installer = artifacts.find((file) => file.endsWith(process.platform === 'win32' ? '.exe' : '.dmg'));
    if (!installer) throw new Error('Installer was not generated');
    const destination = path.join(dist, path.basename(installer)); fs.copyFileSync(installer, destination);
    fs.writeFileSync(path.join(root, '.release', 'desktop-build.json'), JSON.stringify({ installer: destination, label, commit }, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `installer=${destination}\n`);
    console.log(`Installer: ${destination}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
