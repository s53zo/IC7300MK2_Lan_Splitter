'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SEA_FILES = Object.freeze({
    'index.html': 'desktop/index.html', 'renderer.js': 'desktop/renderer.js', 'styles.css': 'desktop/styles.css',
    'bridge.js': 'src/web/bridge.js', 'login.html': 'src/web/login.html', 'login.js': 'src/web/login.js', 'login.css': 'src/web/login.css',
});
function adaptIndex(html) {
    if (!html.includes('<script defer src="renderer.js"></script>')) throw new Error('The management interface could not be prepared.');
    return html.replace("connect-src 'none'", "connect-src 'self'")
        .replace('<script defer src="renderer.js"></script>', '<script defer src="bridge.js"></script>\n<script defer src="renderer.js"></script>');
}
function loadAssets({ root = path.resolve(__dirname, '../..'), sea } = {}) {
    if (!sea) { try { sea = require('node:sea'); } catch { sea = { isSea: () => false }; } }
    const assets = {};
    for (const [name, source] of Object.entries(SEA_FILES)) {
        const data = sea.isSea() ? Buffer.from(sea.getAsset(`web/${name}`)) : fs.readFileSync(path.join(root, source));
        const body = name === 'index.html' ? adaptIndex(data.toString('utf8')) : data;
        const contentType = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        assets[`/${name}`] = { body, contentType };
    }
    assets['/'] = assets['/index.html']; assets['/login'] = assets['/login.html'];
    return assets;
}
module.exports = { SEA_FILES, adaptIndex, loadAssets };
