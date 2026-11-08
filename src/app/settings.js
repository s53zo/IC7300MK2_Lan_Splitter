'use strict';
const fs = require('node:fs');
const { config } = require('../config');
const FIELDS = [
    ['ICOM_RADIO_HOST', 'Radio address', 'Radio', 'text', '', 'IPv4 address of your radio.'],
    ['ICOM_USERNAME', 'Radio username', 'Radio', 'text', '', 'The username configured on your radio.'],
    ['ICOM_PASSWORD', 'Radio password', 'Radio', 'password', '', 'Leave blank to keep the saved password.'],
    ['ICOM_PASSWORD_FILE', 'Import password file', 'Radio', 'file', '', 'Optional: import a password from a text file; the path is not saved.'],
    ['ICOM_BIND_ADDRESS', 'Listen address', 'Network', 'text', '0.0.0.0', '0.0.0.0 accepts clients on local network interfaces; 127.0.0.1 permits this computer only.'],
    ['ICOM_LISTEN_CONTROL_PORT', 'Client control port', 'Network', 'number', '50001', 'UDP port clients use for login.', 1, 65535],
    ['ICOM_LISTEN_CIV_PORT', 'Client CI-V port', 'Network', 'number', '50002', 'UDP port clients use for radio commands.', 1, 65535],
    ['ICOM_LISTEN_AUDIO_PORT', 'Client audio port', 'Network', 'number', '50003', 'UDP port clients use for audio.', 1, 65535],
    ['ICOM_RADIO_CONTROL_PORT', 'Radio control port', 'Network', 'number', '50001', 'Radio login UDP port.', 1, 65535],
    ['ICOM_RADIO_CIV_PORT', 'Radio CI-V port', 'Network', 'number', '50002', 'Radio command UDP port.', 1, 65535],
    ['ICOM_RADIO_AUDIO_PORT', 'Radio audio port', 'Network', 'number', '50003', 'Radio audio UDP port.', 1, 65535],
    ['ICOM_CACHE_ENABLED', 'Enable request cache', 'Cache', 'boolean', '1', 'Serve eligible recent display queries locally. Safety polling always stays fresh.'],
    ['ICOM_CACHE_METERS_MS', 'Meter / ADC cache (ms)', 'Cache', 'number', '100', '0 disables this family; maximum 1000 ms.', 0, 1000],
    ['ICOM_CACHE_STATE_MS', 'RX/TX / tuner cache (ms)', 'Cache', 'number', '100', 'Client display cache only; 0 disables this family.', 0, 1000],
    ['ICOM_CACHE_SETTINGS_MS', 'Settings cache (ms)', 'Cache', 'number', '250', '0 disables this family; maximum 1000 ms.', 0, 1000],
    ['ICOM_CACHE_TUNING_MS', 'Frequency / mode cache (ms)', 'Cache', 'number', '50', '0 disables this family; maximum 1000 ms.', 0, 1000],
    ['ICOM_MEMORY_BUDGET_MB', 'Client memory budget (MiB)', 'Advanced', 'number', '128', 'Reserved client buffer budget, not an arbitrary license limit.', 8, 65536],
    ['ICOM_PREAUTH_MEMORY_MB', 'Pending login budget (MiB)', 'Advanced', 'number', '8', 'Separate bounded memory budget for clients not yet authenticated.', 1, 65536],
    ['ICOM_PREAUTH_TIMEOUT_MS', 'Login deadline (ms)', 'Advanced', 'number', '10000', 'Absolute deadline to complete client authentication.', 100, 300000],
    ['ICOM_CLIENT_TIMEOUT_MS', 'Client heartbeat timeout (ms)', 'Advanced', 'number', '15000', 'Disconnect an unresponsive client after this interval.', 100, 300000],
    ['ICOM_RADIO_TIMEOUT_MS', 'Radio heartbeat timeout (ms)', 'Advanced', 'number', '15000', 'Detect loss of the radio connection after this interval.', 100, 300000],
    ['ICOM_COMMAND_TIMEOUT_MS', 'Command reply timeout (ms)', 'Advanced', 'number', '2000', 'Reset an ambiguous radio session if a command reply fails to arrive.', 100, 30000],
].map(([key, label, group, type, fallback, description, min, max]) => ({ key, label, group, type, default: fallback, description, ...(min === undefined ? {} : { min, max }) }));
const defaults = () => Object.fromEntries(FIELDS.map((field) => [field.key, field.default]));
function normalize(input = {}, existing = defaults()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object');
    const values = defaults();
    for (const field of FIELDS) if (Object.hasOwn(existing, field.key)) values[field.key] = existing[field.key];
    for (const field of FIELDS) {
        if (!Object.hasOwn(input, field.key)) continue;
        const value = input[field.key];
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${field.label} has an invalid value`);
        values[field.key] = typeof value === 'boolean' ? value ? '1' : '0' : String(value);
    }
    return values;
}
function validate(input, password = '', existing) {
    const values = normalize(input, existing);
    if (values.ICOM_PASSWORD && values.ICOM_PASSWORD_FILE) throw new Error('Choose a password or a password file, not both');
    if (values.ICOM_PASSWORD_FILE) {
        try {
            const stat = fs.statSync(values.ICOM_PASSWORD_FILE);
            if (!stat.isFile() || stat.size > 64) throw new Error('Invalid password file');
            password = fs.readFileSync(values.ICOM_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
        }
        catch { throw new Error('Cannot read the selected password file'); }
    } else if (values.ICOM_PASSWORD) password = values.ICOM_PASSWORD;
    let options;
    try { options = config({ ...values, ICOM_PASSWORD: password, ICOM_PASSWORD_FILE: undefined }); }
    catch (error) {
        let message = error.message;
        for (const field of [...FIELDS].sort((a, b) => b.key.length - a.key.length)) message = message.split(field.key).join(field.label);
        throw new Error(message, { cause: error });
    }
    values.ICOM_PASSWORD = ''; values.ICOM_PASSWORD_FILE = '';
    return { values, password, options };
}
module.exports = { FIELDS, defaults, normalize, validate };
