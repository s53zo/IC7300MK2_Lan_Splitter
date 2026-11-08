#!/usr/bin/env node
'use strict';

const { config } = require('./config');

const HELP = `Usage: icom-lan-splitter [--help]

Required environment:
  ICOM_RADIO_HOST       Radio IPv4 address
  ICOM_USERNAME         Radio username (also accepted by splitter)
  ICOM_PASSWORD_FILE    File containing radio password (recommended)
  ICOM_PASSWORD         Alternative runtime environment password

Optional:
  ICOM_BIND_ADDRESS    Listener interface; default 127.0.0.1
  ICOM_LISTEN_CONTROL_PORT / ICOM_LISTEN_CIV_PORT / ICOM_LISTEN_AUDIO_PORT
  ICOM_RADIO_CONTROL_PORT / ICOM_RADIO_CIV_PORT / ICOM_RADIO_AUDIO_PORT
                       Defaults: 50001 / 50002 / 50003 (UDP)
  ICOM_MEMORY_BUDGET_MB   Client buffer reservation budget; default 128 MiB
  ICOM_CLIENT_TIMEOUT_MS  Downstream heartbeat timeout; default 15000
  ICOM_RADIO_TIMEOUT_MS   Upstream heartbeat timeout; default 15000
  ICOM_COMMAND_TIMEOUT_MS CI-V transaction timeout; default 2000
  ICOM_CACHE_ENABLED      Client read cache/coalescing: 0 or 1; default 1
  ICOM_CACHE_METERS_MS    Meter/ADC overflow TTL; default 100
  ICOM_CACHE_STATE_MS     RX/TX and tuner TTL; default 100
  ICOM_CACHE_SETTINGS_MS  Public operator settings TTL; default 250
  ICOM_CACHE_TUNING_MS    Frequency/mode/VFO TTL; default 50
                         TTLs are integer milliseconds 0–1000; 0 disables family

Use a LAN interface address to accept other computers. No web UI or TCP API.
Do not put passwords in command arguments or committed configuration files.
Stop with Ctrl+C or SIGTERM; normal shutdown attempts confirmed TX release.
`;

function statusSnapshot(service) {
    return {
        type: 'status',
        radio: { state: service.session.state, connected: Boolean(service.session.connected) },
        broker: {
            ready: Boolean(service.broker.ready), queueDepth: service.broker.queue.length,
            pending: Boolean(service.broker.pending), txOwned: Boolean(service.broker.owner),
        },
        cache: service.broker.cacheSnapshot(),
    };
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { process.stdout.write(HELP); return; }
    if (process.argv.length > 2) throw new Error('Unknown argument; use --help');
    const options = config();
    const { Splitter } = require('./splitter');
    const service = new Splitter(options);
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        process.stdout.write('Stopping; releasing radio transmission if connected.\n');
        await service.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (process.platform !== 'win32') process.on('SIGUSR2', () => process.stdout.write(`${JSON.stringify(statusSnapshot(service))}\n`));
    service.on('status', ({ state }) => process.stdout.write(`Radio: ${state}\n`));
    service.on('fault', () => { process.stderr.write('UDP listener failed; stopping.\n'); process.exitCode = 1; void stop(); });
    try {
        await service.start();
        if (!stopping) process.stdout.write(`Ready: ${options.server.bindAddress} UDP ${[service.address().controlPort, service.address().civPort, service.address().audioPort].join('/')}\n`);
    } catch (error) {
        await service.close();
        // Errors from sockets may include endpoints; never include packet dumps
        // or configuration objects in diagnostics.
        throw error;
    }
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main, HELP, statusSnapshot };
