'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config } = require('../src/config');
const defaults = { ICOM_RADIO_HOST: '192.0.2.1', ICOM_USERNAME: 'fixture', ICOM_PASSWORD: 'fixture-password' };

test('configuration defaults to loopback and native ports, never implicit hardware host', () => {
    assert.throws(() => config({}), /HOST/);
    const c = config(defaults);
    assert.equal(c.server.bindAddress, '127.0.0.1');
    assert.equal(c.radio.controlPort, 50001);
    assert.equal(c.server.audioPort, 50003);
    assert.equal(c.broker.requestTimeoutMs, 2000);
});

test('invalid config errors do not expose credentials or supplied file paths', () => {
    const rejected = [
        { ICOM_PASSWORD: 'short' }, { ICOM_USERNAME: '\n' },
        { ICOM_RADIO_CONTROL_PORT: '0' }, { ICOM_RADIO_CONTROL_PORT: '50002' },
        { ICOM_LISTEN_AUDIO_PORT: '1.5' }, { ICOM_BIND_ADDRESS: '::' },
        { ICOM_COMMAND_TIMEOUT_MS: 'NaN' },
        { ICOM_PASSWORD_FILE: '/private/unknown-file' },
    ];
    for (const override of rejected) {
        assert.throws(() => config({ ...defaults, ...override }), (error) => {
            assert.ok(!error.message.includes(defaults.ICOM_PASSWORD));
            assert.ok(!error.message.includes('/private/unknown-file'));
            return true;
        });
    }
    assert.throws(() => config({ ...defaults, ICOM_RADIO_HOST: '127.0.0.1' }), /relay loop/);
});

test('password file accepts a single terminal newline without trimming password spaces', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icom-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'credential');
    fs.writeFileSync(file, ' fixture-secret \n', { mode: 0o600 });
    const c = config({ ...defaults, ICOM_PASSWORD: undefined, ICOM_PASSWORD_FILE: file });
    assert.equal(c.radio.password, ' fixture-secret ');
});

test('CLI help is available without credentials; invalid input exits cleanly', () => {
    const help = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8', env: {} });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /ICOM_PASSWORD_FILE/);
    const bad = spawnSync(process.execPath, ['src/cli.js'], { encoding: 'utf8', env: {} });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ICOM_RADIO_HOST/);
});
