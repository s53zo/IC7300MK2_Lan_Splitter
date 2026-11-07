'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');

function integer(value, name, fallback, min = 1, max = 65535) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} is out of range`);
    return n;
}

function config(env = process.env) {
    const host = env.ICOM_RADIO_HOST;
    const bindAddress = env.ICOM_BIND_ADDRESS || '127.0.0.1';
    if (!host || net.isIP(host) !== 4) throw new Error('ICOM_RADIO_HOST must be an IPv4 address');
    if (net.isIP(bindAddress) !== 4) throw new Error('ICOM_BIND_ADDRESS must be an IPv4 address');
    if (env.ICOM_PASSWORD && env.ICOM_PASSWORD_FILE) throw new Error('Choose ICOM_PASSWORD or ICOM_PASSWORD_FILE');
    let password = env.ICOM_PASSWORD;
    if (env.ICOM_PASSWORD_FILE) {
        try { password = fs.readFileSync(env.ICOM_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, ''); }
        catch { throw new Error('Cannot read ICOM_PASSWORD_FILE'); }
    }
    if (!password) throw new Error('Set ICOM_PASSWORD_FILE or ICOM_PASSWORD');
    const username = env.ICOM_USERNAME;
    if (!username || !/^[\x20-\x7e]{1,16}$/.test(username)) throw new Error('ICOM_USERNAME must be 1-16 printable ASCII characters');
    if (!/^[\x20-\x7e]{8,16}$/.test(password)) throw new Error('Radio password must be 8-16 printable ASCII characters');
    const ports = (prefix) => ({
        controlPort: integer(env[`${prefix}_CONTROL_PORT`], `${prefix}_CONTROL_PORT`, 50001),
        civPort: integer(env[`${prefix}_CIV_PORT`], `${prefix}_CIV_PORT`, 50002),
        audioPort: integer(env[`${prefix}_AUDIO_PORT`], `${prefix}_AUDIO_PORT`, 50003),
    });
    const radioPorts = ports('ICOM_RADIO');
    const serverPorts = ports('ICOM_LISTEN');
    for (const set of [radioPorts, serverPorts]) {
        if (new Set(Object.values(set)).size !== 3) throw new Error('Control, CI-V and audio ports must be distinct');
    }
    const localAddresses = new Set(['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().map((a) => a.address)]);
    if (localAddresses.has(host) && (bindAddress === '0.0.0.0' || bindAddress === host)
        && Object.values(radioPorts).some((port) => Object.values(serverPorts).includes(port))) {
        throw new Error('Radio endpoint overlaps the splitter listener; refusing a relay loop');
    }
    return {
        radio: { host, username, password, ...radioPorts,
            timeoutMs: integer(env.ICOM_RADIO_TIMEOUT_MS, 'ICOM_RADIO_TIMEOUT_MS', 15000, 100, 300000) },
        server: { bindAddress, ...serverPorts,
            memoryBudgetBytes: integer(env.ICOM_MEMORY_BUDGET_MB, 'ICOM_MEMORY_BUDGET_MB', 128, 8, 65536) * 1024 * 1024,
            timeoutMs: integer(env.ICOM_CLIENT_TIMEOUT_MS, 'ICOM_CLIENT_TIMEOUT_MS', 15000, 100, 300000) },
        broker: { requestTimeoutMs: integer(env.ICOM_COMMAND_TIMEOUT_MS, 'ICOM_COMMAND_TIMEOUT_MS', 2000, 100, 30000) },
    };
}
module.exports = { config };
