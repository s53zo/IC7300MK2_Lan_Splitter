'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { AppController } = require('../app/controller');
const { SettingsStore, defaultDirectory, atomicWrite, privateRead } = require('../app/store');
const { FIELDS, validate } = require('../app/settings');
const { ensureTls } = require('./tls');
const { loadAssets } = require('./assets');
function webOptions(env, values = {}) {
    const host = env.ICOM_WEB_BIND_ADDRESS || env.ICOM_BIND_ADDRESS || values.ICOM_BIND_ADDRESS || '0.0.0.0';
    if (net.isIP(host) !== 4) throw new Error('The web listen address must be an IPv4 address.');
    let port;
    if (env.ICOM_WEB_PORT !== undefined) {
        if (!/^\d+$/.test(String(env.ICOM_WEB_PORT))) throw new Error('The HTTPS management port must be an integer from 1 to 65535.');
        port = Number(env.ICOM_WEB_PORT);
    } else {
        const ports = ['CONTROL', 'CIV', 'AUDIO'].map((role, i) => Number(values[`ICOM_LISTEN_${role}_PORT`] || env[`ICOM_LISTEN_${role}_PORT`] || 50001 + i));
        port = Math.max(...ports) + 1;
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Choose ICOM_WEB_PORT from 1 to 65535; the default management port is outside that range.');
    return { host, port };
}
async function bootstrapEnvironment(store, env, save) {
    let saved;
    try { saved = await store.load(); }
    catch { return { imported: false, invalidSaved: true }; }
    if (saved) return { imported: false, existing: true };
    const input = {};
    for (const field of FIELDS) if (env[field.key] !== undefined) input[field.key] = env[field.key];
    let result;
    try { result = validate(input); }
    catch { return { imported: false, existing: false }; }
    if (save) await save(result.values, result.password);
    else await store.save(result.values, result.password);
    return { imported: true, existing: false };
}
async function setupToken(directory) {
    const file = path.join(directory, 'web-setup-token');
    const existing = await privateRead(file);
    if (existing !== null) {
        const token = existing.trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('The private web setup token could not be loaded.');
        return { token, file };
    }
    const token = randomBytes(32).toString('base64url');
    await atomicWrite(file, token + '\n'); return { token, file };
}
async function runWeb({ env = process.env, directory: requestedDirectory, platform = process.platform, createController = (options) => new AppController(options),
    createServer, tlsFactory = ensureTls, assetLoader = loadAssets, installSignals = true, signals = process } = {}) {
    if (platform !== 'linux') throw new Error('The service-owned web interface is available on Linux only.');
    const directory = path.resolve(requestedDirectory || env.ICOM_CONFIG_DIR || defaultDirectory('linux', env));
    const controller = createController({ directory });
    let bootstrap, server, closing, startPromise, token;
    const listeners = [];
    function close() {
        if (closing) return closing;
        closing = (async () => {
            for (const signal of listeners) signals.removeListener(signal, onSignal);
            let result;
            try { result = await controller.close({ confirmedTx: true }); }
            finally { await server?.close(); }
            return result;
        })();
        return closing;
    }
    function onSignal() {
        void close().then((result) => {
            if (result?.releaseConfirmed === false) {
                process.stderr.write('The radio did not confirm receive state before service shutdown. Check the radio directly.\n');
                process.exitCode = 1;
            }
        }).catch(() => { process.stderr.write('The web service could not complete shutdown.\n'); process.exitCode = 1; });
    }
    try {
        // Load persistent credentials and acquire the local application lock
        // without waiting for a radio that may be unreachable. Only then expose
        // the authenticated management interface and start the radio session.
        await controller.initialize({ autoStart: false });
        bootstrap = await bootstrapEnvironment(controller.store || new SettingsStore(directory), env,
            (values, password) => controller.saveSettings({ ...values, ICOM_PASSWORD: password }));
        const options = webOptions(env, controller.getSettings().values);
        const tls = await tlsFactory({ directory, env, host: options.host });
        const credentials = () => {
            const username = controller.values?.ICOM_USERNAME || '';
            const password = controller.password || '';
            return username && password ? { username, password, setupRequired: false }
                : { username: 'setup', password: token.token, setupRequired: true };
        };
        if (!(controller.values?.ICOM_USERNAME && controller.password)) token = await setupToken(directory);
        else await fs.rm(path.join(directory, 'web-setup-token'), { force: true });
        const factory = createServer || require('./server').createWebServer;
        server = factory({ controller, host: options.host, port: options.port, tls: { cert: tls.cert, key: tls.key },
            assets: assetLoader(), getCredentials: credentials });
        await server.start();
        if (installSignals) for (const signal of ['SIGINT', 'SIGTERM']) { signals.on(signal, onSignal); listeners.push(signal); }
        // A browser tab is not a process owner. Closing or logging out never
        // calls controller.close(); only process termination does that.
        if (!controller.getState().firstRun) {
            startPromise = controller.start().catch(() => {
                // Controller records a generic, redacted operational error.
                // The HTTPS service stays available for correcting settings.
            });
        }
        return { controller, server, close, startPromise, directory, bootstrap, address: () => server.address(),
            tls: { selfSigned: tls.selfSigned, generated: tls.generated, certificateFile: tls.certificateFile,
                expiresAt: tls.expiresAt, fingerprint256: tls.fingerprint256 },
            setupRequired: Boolean(token), setupTokenFile: token?.file || null };
    } catch (error) {
        await close().catch(() => {});
        throw error;
    }
}
module.exports = { runWeb, webOptions, bootstrapEnvironment };
