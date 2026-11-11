'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const ACTIONS = new Set(['state', 'settings', 'fields', 'save', 'start', 'stop', 'reconnect', 'close', 'defaults', 'export', 'password-file', 'reset-statistics']);
function sameLocalFile(frameUrl, indexFile, platform = process.platform) {
    try {
        const url = new URL(frameUrl);
        // Never accept network origins, UNC hosts, query strings or fragments.
        // Chromium and Node can serialize Windows drive/path casing differently;
        // compare decoded absolute filesystem paths rather than URL spellings.
        if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return false;
        const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
        const actual = paths.resolve(fileURLToPath(url, { windows }));
        const expected = paths.resolve(indexFile);
        return windows ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    } catch { return false; }
}
function validateRequest(event, window, indexFile, action, payload) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !sameLocalFile(event.senderFrame.url, indexFile)) throw new Error('Untrusted interface request');
    if (!ACTIONS.has(action)) throw new Error('Unknown interface action');
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.getPrototypeOf(payload) !== Object.prototype || JSON.stringify(payload).length > 32768)) throw new Error('Invalid interface request');
}
function diagnosticReport(state) {
    // Settings and credential state never enter exported reports. Metrics are
    // bounded broker snapshots; human events are redacted by AppController.
    return { format: 1, createdAt: new Date().toISOString(), running: Boolean(state.running),
        connecting: Boolean(state.connecting), txActive: Boolean(state.txActive),
        statisticsStartedAt: state.statisticsStartedAt, status: state.status, rates: state.rates, latency: state.latency,
        history: state.history, events: state.events };
}
module.exports = { validateRequest, diagnosticReport, sameLocalFile };
