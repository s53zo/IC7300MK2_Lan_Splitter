'use strict';
// Install/copy the real distributable into an isolated directory and test that
// application, never the unpackaged development app or a physical radio.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
async function main() {
    const manifest = JSON.parse(fs.readFileSync('.release/desktop-build.json', 'utf8'));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-installed-'));
    const output = path.resolve('.release', 'screenshots', `${process.platform}-${process.arch}`);
    fs.mkdirSync(output, { recursive: true });
    let binary;
    if (process.platform === 'win32') {
        const install = path.join(temp, 'app');
        execFileSync(manifest.installer, ['/S', `/D=${install}`], { timeout: 120000, stdio: 'inherit' });
        binary = path.join(install, 'icom-lan-splitter.exe');
        if (!fs.existsSync(binary)) throw new Error('Installer did not install the application');
        const shortcuts = fs.readdirSync(path.join(os.homedir(), 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs'));
        if (!shortcuts.some((name) => name.includes('Icom LAN Splitter'))) throw new Error('Start menu shortcut missing');
    } else if (process.platform === 'darwin') {
        const mount = path.join(temp, 'mounted'); fs.mkdirSync(mount);
        execFileSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, manifest.installer], { timeout: 60000, stdio: 'inherit' });
        try {
            const name = fs.readdirSync(mount).find((file) => file.endsWith('.app'));
            if (!name || !fs.lstatSync(path.join(mount, 'Applications')).isSymbolicLink()) throw new Error('DMG needs application and Applications shortcut');
            const copied = path.join(temp, name);
            execFileSync('ditto', [path.join(mount, name), copied]);
            const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleExecutable', path.join(copied, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
            binary = path.join(copied, 'Contents/MacOS', executable);
            execFileSync('codesign', ['--verify', '--deep', '--strict', copied], { stdio: 'inherit' });
        } finally { execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' }); }
    } else throw new Error('Native installer smoke runs on Windows/macOS');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ICOM_') && key !== 'ELECTRON_RUN_AS_NODE'));
    const child = spawn(binary, [`--ui-smoke=${output}`], { env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
        await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Installed application smoke failed (${code})`))); });
        const report = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
        if (report.result !== 'pass') throw new Error('Missing successful smoke report');
        console.log(JSON.stringify({ installer: path.basename(manifest.installer), installedApplication: true, ...report }));
    } finally { clearTimeout(timer); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
