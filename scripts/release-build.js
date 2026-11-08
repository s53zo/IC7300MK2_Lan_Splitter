#!/usr/bin/env node
'use strict';
// This small static CommonJS linker accepts only repository modules and Node
// built-ins. Fail closed on dynamic/external requires rather than shipping a
// binary that silently depends on files beside it.
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const NODE_VERSION = '26.13.0';
const LICENSE_SHA256 = '8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c';
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
function bundle(root = ROOT) {
    const modules = new Map();
    function visit(id) {
        if (modules.has(id)) return;
        const filename = path.join(root, id);
        const source = fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
        const dependencies = {};
        modules.set(id, { source, dependencies });
        const calls = [...source.matchAll(/\brequire\s*\(([^)]*)\)/g)];
        for (const call of calls) {
            const literal = /^\s*(['"])([^'"]+)\1\s*$/.exec(call[1]);
            if (!literal) throw new Error(`Dynamic require in ${id}`);
            const name = literal[2];
            if (name.startsWith('node:') && isBuiltin(name)) continue;
            if (!name.startsWith('.')) throw new Error(`External module ${name} in ${id}`);
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(id), name)) + '.js';
            if (!resolved.startsWith('src/')) throw new Error('Module escapes src');
            dependencies[name] = resolved; visit(resolved);
        }
    }
    visit('src/cli.js');
    const definitions = [...modules].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) =>
        `${JSON.stringify(id)}: [function(require,module,exports) {\n${value.source}\n}, ${JSON.stringify(value.dependencies)}]`).join(',\n');
    return `'use strict';\nconst nativeRequire = require;\nconst definitions = {${definitions}};\nconst loaded = {};\nfunction load(id) {\n if (loaded[id]) return loaded[id].exports;\n const [factory, deps] = definitions[id];\n const mod = loaded[id] = { exports: {} };\n const localRequire = (name) => Object.hasOwn(deps,name) ? load(deps[name]) : nativeRequire(name);\n factory(localRequire,mod,mod.exports);\n return mod.exports;\n}\nload('src/cli.js').main({ interactiveDefault: process.platform === 'linux' }).catch((error) => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });\n`;
}
async function main() {
    if (process.versions.node !== NODE_VERSION) throw new Error(`Build requires Node ${NODE_VERSION}`);
    const target = `${process.platform}-${process.arch}`;
    if (!['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target)) throw new Error(`Unsupported target ${target}`);
    const version = require('../package.json').version;
    const label = process.env.RELEASE_LABEL || version;
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,100}$/.test(label)) throw new Error('Invalid release label');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const epoch = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
    const work = path.join(ROOT, '.release');
    const name = `icom-lan-splitter-${label}-${target}`;
    const stage = path.join(work, 'stage', name);
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    const entry = path.join(work, 'entry.cjs'); fs.writeFileSync(entry, bundle());
    const executable = path.join(stage, `icom-lan-splitter${process.platform === 'win32' ? '.exe' : ''}`);
    const config = path.join(work, 'sea.json');
    const assets = process.platform === 'linux' ? Object.fromEntries(Object.entries(require('../src/web/assets').SEA_FILES)
        .map(([name, source]) => [`web/${name}`, path.join(ROOT, source)])) : {};
    fs.writeFileSync(config, JSON.stringify({ main: entry, output: executable, disableExperimentalSEAWarning: true,
        useCodeCache: false, useSnapshot: false, execArgvExtension: 'none', assets }));
    run(process.execPath, ['--build-sea', config]); fs.chmodSync(executable, 0o755);
    if (process.platform === 'darwin') {
        run('codesign', ['--sign', '-', '--force', executable]);
        run('codesign', ['--verify', '--strict', executable]);
    }
    for (const file of ['LICENSE', 'NOTICE.md', 'docs/releases.md', 'docs/interfaces.md', 'docs/operations.md', 'third_party/icom-lan/GPL-3.0.txt']) {
        const dest = path.join(stage, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), dest);
    }
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`);
    if (!response.ok) throw new Error('Cannot fetch pinned Node license');
    const license = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(license).digest('hex') !== LICENSE_SHA256) throw new Error('Node license checksum mismatch');
    fs.writeFileSync(path.join(stage, 'NODE-LICENSE'), license);
    fs.writeFileSync(path.join(stage, 'BUILD.json'), JSON.stringify({ version, label, commit, node: NODE_VERSION, target,
        source: `https://github.com/s53zo/IC7300MK2_Lan_Splitter/tree/${commit}`,
        runtimeSource: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.gz`,
        signing: process.platform === 'darwin' ? 'ad-hoc only; not notarized' : 'unsigned',
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, 'README.txt'), `IC-7300MK2 LAN Splitter ${label} (${target})\n\nLinux: launch in a terminal for the keyboard interface, or use --tui.
Use --headless for the environment-configured service.
Run ${path.basename(executable)} --help for options. No Node.js installation is required.\nSee docs/releases.md for platform and launch instructions; docs/operations.md\ncontains environment configuration. Never put passwords in command arguments.\nThis is an unsigned development release (macOS: ad-hoc signed, not notarized).\nCorresponding source commit: ${commit}\n`);
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
    const archive = path.join(ROOT, 'dist', `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
    await require('./release-archive').packageArchive(stage, archive, epoch);
    const unpacked = path.join(work, 'unpacked'); fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked);
    run('tar', ['-xf', archive, '-C', unpacked]);
    const extractedExecutable = path.join(unpacked, name, path.basename(executable));
    fs.writeFileSync(path.join(work, 'build.json'), JSON.stringify({ executable: extractedExecutable, archive, target }, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `executable=${extractedExecutable}\narchive=${archive}\n`);
    console.log(JSON.stringify({ executable: extractedExecutable, archive, target }));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { bundle, NODE_VERSION };
