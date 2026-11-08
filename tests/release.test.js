'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { bundle } = require('../scripts/release-build');
const { metadata } = require('../scripts/release-meta');

test('release tags must match package version and previews identify the exact commit', () => {
    const sha = 'a'.repeat(40);
    assert.deepEqual(metadata('workflow_dispatch', 'refs/heads/main', sha, '0.1.0'), {
        label: '0.1.0-preview.aaaaaaaaaaaa', tag: 'preview-aaaaaaaaaaaa', prerelease: true, commit: sha,
    });
    assert.equal(metadata('push', 'refs/tags/v0.1.0', sha, '0.1.0').prerelease, false);
    assert.equal(metadata('push', 'refs/tags/v0.1.0-rc.1', sha, '0.1.0-rc.1').prerelease, true);
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
