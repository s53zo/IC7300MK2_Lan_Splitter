'use strict';

const { EventEmitter } = require('node:events');
const { IcomSession } = require('./icom-lan/session');
const { NativeServer } = require('./server');
const { Broker } = require('./broker');

// The service owns exactly one upstream session regardless of client count.
class Splitter extends EventEmitter {
    constructor(options) {
        super();
        if (!options?.radio) throw new Error('Radio configuration is required');
        this.options = options;
        this.session = new IcomSession({ reconnectAttempts: Infinity, ...options.radio });
        this.server = new NativeServer({ ...options.server,
            username: options.radio.username, password: options.radio.password });
        this.session.on('connected', () => {
            const address = this.session.advertisedAddress;
            if (address > 0 && address < 0xe0) this.server.options.radioAddress = address;
        });
        this.broker = new Broker(this.session, this.server, options.broker);
        this.session.on('status', (status) => this.emit('status', status));
        this.broker.on('diagnostic', (status) => this.emit('diagnostic', status));
        this.broker.on('ready', () => this.emit('ready'));
        this.server.on('failure', (error) => this.emit('fault', error));
    }

    start() {
        if (this.stopping) return Promise.reject(new Error('Service is stopping'));
        if (this.starting) return this.starting;
        this.starting = this.open().catch(async (error) => { await this.close(); throw error; });
        return this.starting;
    }

    async open() {
        this.binding = this.server.start();
        await this.binding;
        this.assertRunning();
        await this.session.open();
        this.assertRunning();
        this.broker.start();
        if (!this.broker.ready) {
            await new Promise((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(timer);
                    this.broker.off('ready', ready);
                    this.cancelReady = null;
                };
                const ready = () => { cleanup(); resolve(); };
                const timer = setTimeout(() => {
                    cleanup(); reject(new Error('Radio did not confirm receive state'));
                }, this.options.radio.timeoutMs || 15000);
                this.cancelReady = () => { cleanup(); reject(new Error('Service is stopping')); };
                this.broker.once('ready', ready);
            });
        }
        this.assertRunning();
        this.started = true;
    }

    assertRunning() { if (this.stopping) throw new Error('Service is stopping'); }
    address() { return this.server.address(); }

    close() {
        if (this.closing) return this.closing;
        this.stopping = true;
        this.started = false;
        this.cancelReady?.();
        this.closing = (async () => {
            // Binding cannot be cancelled portably. Finish it before closing
            // its sockets; open() checks cancellation before radio login.
            await this.binding?.catch(() => {});
            try { await this.broker.close(); }
            finally {
                await this.session.close();
                await this.server.close();
            }
        })();
        return this.closing;
    }
}

module.exports = { Splitter };
