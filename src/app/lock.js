'use strict';
const net = require('node:net');
const { createHash } = require('node:crypto');
// An OS-owned loopback listener is a local mutex, not a management API. The OS
// releases it after process death, so stale files cannot permanently lock users
// out. A hash collision or another service using the port fails closed.
async function acquireLock(key) {
    const port = 10000 + createHash('sha256').update(String(key)).digest().readUInt32BE(0) % 50000;
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
        const failed = () => { server.close(); reject(new Error('Another local splitter instance may already be running. Close it before starting this one.')); };
        server.once('error', failed);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', failed); server.on('error', () => {}); resolve(); });
    });
    server.unref();
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await new Promise((resolve) => server.close(resolve));
    };
}
module.exports = { acquireLock };
