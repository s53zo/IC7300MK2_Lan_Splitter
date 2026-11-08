'use strict';
const { pathToFileURL } = require('node:url');
const ACTIONS = new Set(['state', 'settings', 'fields', 'save', 'start', 'stop', 'reconnect', 'close', 'defaults', 'export', 'password-file']);
function validateRequest(event, window, indexFile, action, payload) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || event.senderFrame.url !== pathToFileURL(indexFile).href) throw new Error('Untrusted interface request');
    if (!ACTIONS.has(action)) throw new Error('Unknown interface action');
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.getPrototypeOf(payload) !== Object.prototype || JSON.stringify(payload).length > 32768)) throw new Error('Invalid interface request');
}
function diagnosticReport(state) {
    // Settings and credential state never enter exported reports. Metrics are
    // bounded broker snapshots; human events are redacted by AppController.
    return { format: 1, createdAt: new Date().toISOString(), running: Boolean(state.running),
        connecting: Boolean(state.connecting), txActive: Boolean(state.txActive),
        status: state.status, rates: state.rates, latency: state.latency,
        history: state.history, events: state.events };
}
module.exports = { validateRequest, diagnosticReport };
