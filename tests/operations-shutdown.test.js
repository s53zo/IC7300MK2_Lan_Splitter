'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { IcomPeer } = require('./fixtures/icom-radio');
const { until, client, frame } = require('./fixtures/harness');
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
for (const failure of ['negative', 'timeout', 'none']) {
  test(`headless shutdown reports cleanup ${failure} and releases resources`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const radio = await new IcomPeer({ passwordVector: Buffer.from('223f5c31223f583b0000000000000000', 'hex') }).start();
    let peer, child, exited = false, stdout = '', stderr = '', exitCode, rejected = 0;
    try {
      const [controlPort, civPort, audioPort] = await ports(), upstream = radio.config();
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ICOM_')));
      Object.assign(env, { ICOM_RADIO_HOST: '127.0.0.1', ICOM_USERNAME: 'beer', ICOM_PASSWORD: 'testpass', ICOM_BIND_ADDRESS: '127.0.0.1',
        ICOM_RADIO_CONTROL_PORT: String(upstream.controlPort), ICOM_RADIO_CIV_PORT: String(upstream.civPort), ICOM_RADIO_AUDIO_PORT: String(upstream.audioPort),
        ICOM_LISTEN_CONTROL_PORT: String(controlPort), ICOM_LISTEN_CIV_PORT: String(civPort), ICOM_LISTEN_AUDIO_PORT: String(audioPort), ICOM_COMMAND_TIMEOUT_MS: '200' });
      child = spawn(process.execPath, [path.join(__dirname, '../src/cli.js'), '--headless'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-32768); });
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-32768); });
      child.once('exit', (code) => { exited = true; exitCode = code; });
      await until(() => stdout.includes('Ready:') || exited, 'child CLI ready', 10000);
      assert.equal(exited, false);
      peer = await client({ host: '127.0.0.1', controlPort, civPort, audioPort }, { password: 'testpass' });
      peer.sendCiv(frame(0x1c, [0, 1])); await until(() => radio.ptt, 'fixture TX');
      const original = radio.civ.bind(radio);
      radio.civ = (bytes, association) => {
        if (failure !== 'none' && bytes[4] === 0x1c && bytes[5] === 0 && bytes[6] === 0 && bytes.length === 8) {
          rejected++;
          if (failure === 'negative') radio.replyCiv([0xfa], association);
          return;
        }
        original(bytes, association);
      };
      child.kill('SIGTERM'); await until(() => exited, 'child exit after release', 10000);
      assert.equal(exitCode, failure === 'none' ? 0 : 1);
      assert.equal(radio.ptt, failure !== 'none');
      if (failure === 'none') assert.equal(stderr.includes('Receive state could not be confirmed'), false);
      else {
        assert.ok(rejected > 0); assert.match(stderr, /Receive state could not be confirmed/);
        assert.equal(stderr.includes('testpass'), false);
      }
      // The child must have closed all three listeners, not just set an exit code.
      for (const port of [controlPort, civPort, audioPort]) {
        const socket = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '127.0.0.1', resolve); });
        await new Promise((resolve) => socket.close(resolve));
      }
    } finally {
      if (child && !exited) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
      await peer?.close(); await radio.close();
    }
  });
}
