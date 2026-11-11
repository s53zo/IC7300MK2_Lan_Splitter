'use strict';
// Isolated loopback-only reproduction; no physical radio or saved profile is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const { IcomPeer } = require(path.join(root, 'tests/fixtures/icom-radio'));
const { until, client, frame } = require(path.join(root, 'tests/fixtures/harness'));
async function ports() {
  const sockets = [];
  try {
    for (let n = 0; n < 3; n++) {
      const socket = dgram.createSocket('udp4'); sockets.push(socket);
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    }
    return sockets.map((socket) => socket.address().port);
  } finally { await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve)))); }
}
async function main() {
  if (process.platform === 'win32') throw new Error('This signal reproduction requires POSIX SIGTERM.');
  const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
  let peer, child, exited = false, stdout = '', stderr = '';
  try {
    const [controlPort, civPort, audioPort] = await ports(), upstream = radio.config();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ICOM_')));
    Object.assign(env, { ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass', ICOM_BIND_ADDRESS: '127.0.0.1',
      ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort), ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort),
      ICOM_LISTEN_CONTROL_PORT: String(controlPort), ICOM_LISTEN_CIV_PORT: String(civPort), ICOM_LISTEN_AUDIO_PORT: String(audioPort), ICOM_COMMAND_TIMEOUT_MS: '200' });
    child = spawn(process.execPath, [path.join(root, 'src/cli.js'), '--headless'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    let exitCode;
    child.once('close', (code) => { exited = true; exitCode = code; });
    await until(() => stdout.includes('Ready:') || exited, 'isolated CLI ready', 5000);
    assert.equal(exited, false, 'CLI must start normally');
    peer = await client({ host: '127.0.0.1', controlPort, civPort, audioPort }, { password: 'testpass' });
    peer.sendCiv(frame(0x1c, [0, 1])); await until(() => radio.ptt, 'synthetic PTT active');
    const original = radio.civ.bind(radio); let rejectedStops = 0;
    radio.civ = (bytes, association) => {
      if (bytes[4] === 0x1c && bytes[5] === 0 && bytes[6] === 0 && bytes.length === 8) {
        rejectedStops++; radio.replyCiv([0xfa], association); return;
      }
      original(bytes, association);
    };
    child.kill('SIGTERM'); await until(() => exited, 'CLI exited after failed cleanup', 5000);
    const summary = { platform: process.platform, node: process.versions.node, rejectedStops, exitCode,
      simulatedRadioStillTransmitting: radio.ptt, stderrEmpty: stderr === '', explicitReceiveUnconfirmedWarning: /receive state|check the radio directly|did not confirm|release (?:failed|unconfirmed)/i.test(stdout + stderr), statusLines: stdout.trim().split('\n').filter((line) => /^(?:Radio:|Stopping;)/.test(line)) };
    assert.ok(rejectedStops > 0); assert.equal(radio.ptt, true); assert.equal(exitCode, 0); assert.equal(stderr, ''); assert.equal(summary.explicitReceiveUnconfirmedWarning, false);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (child && !exited) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
    await peer?.close(); await radio.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
