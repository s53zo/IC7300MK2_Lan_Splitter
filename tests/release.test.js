'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { bundle, DOCUMENTATION_FILES, stageDocumentation } = require('../scripts/release-build');
const { buildConfiguration } = require('../scripts/desktop-build');
const { metadata } = require('../scripts/release-meta');

test('release tags must match package version and previews identify the exact commit', () => {
    const sha = 'a'.repeat(40);
    assert.deepEqual(metadata('workflow_dispatch', 'refs/heads/main', sha, '0.1.0'), {
        label: '0.1.0-preview.aaaaaaaaaaaa', tag: 'preview-aaaaaaaaaaaa', prerelease: true, commit: sha,
    });
    assert.equal(metadata('push', 'refs/tags/v0.1.0', sha, '0.1.0').prerelease, false);
    assert.equal(metadata('push', 'refs/tags/v0.1.0-rc.1', sha, '0.1.0-rc.1').prerelease, true);
    assert.deepEqual(metadata('push', 'refs/tags/v0.8', sha, '0.8.0'), { label: '0.8.0', tag: 'v0.8', prerelease: false, commit: sha });
    assert.throws(() => metadata('push', 'refs/tags/v0.8', sha, '0.8.1'), /tag/);
    assert.throws(() => metadata('push', 'refs/tags/v0.8', sha, '0.8.0-rc.0'), /tag/);
    for (const ref of ['refs/heads/main', 'refs/tags/v0.2.0', 'refs/tags/0.1.0']) {
        assert.throws(() => metadata('push', ref, sha, '0.1.0'), /tag/);
    }
    assert.throws(() => metadata('pull_request', '', sha, '0.1.0'), /event/);
});

test('linked CLI runs away from source files and retains help and config errors', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-bundle-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'entry.cjs'); fs.writeFileSync(file, bundle());
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ICOM_')));
    assert.match(execFileSync(process.execPath, [file, '--help'], { cwd: dir, env, encoding: 'utf8' }), /ICOM_PASSWORD_FILE/);
    assert.throws(() => execFileSync(process.execPath, [file], { cwd: dir, env, stdio: 'pipe' }),
        (error) => error.status === 1 && /ICOM_RADIO_HOST/.test(error.stderr.toString()));
    assert.equal(bundle(), bundle(), 'source linking must be deterministic');
});

test('linker fails closed on new external or dynamic dependencies', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-link-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.mkdirSync(path.join(dir, 'src'));
    for (const source of ["require('unexpected-package')", 'require(variable)', "require('../outside')"]) {
        fs.writeFileSync(path.join(dir, 'src/cli.js'), source);
        assert.throws(() => bundle(dir), /External module|Dynamic require|escapes src/);
    }
});

test('standalone and desktop staging retain the complete installation document paths', (t) => {
    const root = path.resolve(__dirname, '..');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-install-docs-'));
    t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
    const required = [
        'docs/interfaces.md', 'docs/linux-web-service.md', 'docs/operations.md', 'docs/releases.md',
        'docs/services/Start-Splitter.ps1', 'docs/services/icom-lan-splitter-web.service',
        'docs/services/icom-lan-splitter.service', 'docs/services/local.icom-lan-splitter.plist',
    ];
    assert.deepEqual(DOCUMENTATION_FILES, required);
    stageDocumentation(root, stage);
    for (const file of required) assert.deepEqual(fs.readFileSync(path.join(stage, file)), fs.readFileSync(path.join(root, file)));
    for (const file of required.filter((name) => name.endsWith('.md'))) {
        const source = fs.readFileSync(path.join(stage, file), 'utf8');
        for (const [, target] of source.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
            if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
            const [relative, fragment] = target.split('#');
            const destination = relative ? path.resolve(path.dirname(path.join(stage, file)), decodeURIComponent(relative)) : path.join(stage, file);
            assert.ok(destination.startsWith(stage + path.sep), `${file} escapes the package: ${target}`);
            assert.ok(fs.statSync(destination).isFile(), `${file} has a missing package link: ${target}`);
            if (fragment) {
                const headings = [...fs.readFileSync(destination, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
                    .map(([, heading]) => heading.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));
                assert.ok(headings.includes(decodeURIComponent(fragment)), `${file} has a missing heading: ${target}`);
            }
        }
    }
    for (const arch of ['x64', 'arm64']) {
        const config = buildConfiguration({ label: '0.8.1', metadataDirectory: '/metadata', electronVersion: '45.2.3', arch });
        for (const file of required) {
            assert.ok(config.files.includes(file), `desktop app omits ${file}`);
            assert.ok(config.extraResources.some((resource) => resource.from === file && resource.to === file),
                `desktop resources do not preserve ${file}`);
        }
        assert.equal(config.publish, null);
        assert.equal(config.win.signAndEditExecutable, false);
        assert.equal(config.mac.identity, '-');
        assert.equal(config.mac.notarize, false);
        assert.ok(config.extraResources.some((resource) => resource.to === 'LICENSE-ELECTRON.txt'));
        assert.ok(config.extraResources.some((resource) => resource.to === 'LICENSES-CHROMIUM.html'));
    }
});

test('service templates select explicit standalone modes and document source alternatives', () => {
    const service = (name) => fs.readFileSync(path.resolve(__dirname, '../docs/services', name), 'utf8');
    assert.match(service('icom-lan-splitter.service'), /^ExecStart=\/opt\/icom-splitter\/icom-lan-splitter --headless$/m);
    assert.match(service('icom-lan-splitter.service'), /^# ExecStart=\/usr\/bin\/node .*\/src\/cli\.js --headless$/m);
    assert.match(service('icom-lan-splitter-web.service'), /^ExecStart=\/opt\/icom-splitter\/current\/icom-lan-splitter --web$/m);
    assert.match(service('icom-lan-splitter-web.service'), /^# ExecStart=\/usr\/bin\/node .*\/src\/cli\.js --web$/m);
    assert.match(service('Start-Splitter.ps1'), /^& '\.\\icom-lan-splitter\.exe' '--headless'$/m);
    assert.match(service('Start-Splitter.ps1'), /^# & .*node\.exe' '\.\\src\\cli\.js' '--headless'$/m);
    const plist = service('local.icom-lan-splitter.plist');
    assert.match(plist, /<string>\/Users\/YOUR_USER\/icom-splitter\/icom-lan-splitter<\/string>\s*<string>--headless<\/string>/);
    assert.ok([...plist.matchAll(/<!--[\s\S]*?-->/g)].every(([comment]) => !comment.slice(4, -3).includes('--')),
        'XML comments must not contain double hyphens');
});
