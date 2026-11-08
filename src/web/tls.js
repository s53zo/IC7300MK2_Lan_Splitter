'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { X509Certificate, createPrivateKey, createPublicKey, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { atomicWrite, privateRead } = require('../app/store');
const execute = promisify(execFile);
function certificateInfo(cert, key) {
    try {
        const parsed = new X509Certificate(cert);
        const actual = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' });
        const expected = parsed.publicKey.export({ type: 'spki', format: 'der' });
        if (!actual.equals(expected)) throw new Error('Key mismatch');
        return { parsed, expires: Date.parse(parsed.validTo), begins: Date.parse(parsed.validFrom) };
    } catch { throw new Error('The HTTPS certificate and private key could not be validated.'); }
}
function localNames(host) {
    const hostname = os.hostname();
    const dns = ['localhost'];
    if (/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(hostname)) dns.push(hostname);
    const ips = ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((row) => row.family === 'IPv4').map((row) => row.address)];
    if (net.isIP(host) === 4 && host !== '0.0.0.0') ips.push(host);
    return [...new Set(dns)].map((name) => `DNS:${name}`).concat([...new Set(ips)].map((ip) => `IP:${ip}`));
}
async function customRead(file, secret) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('HTTPS files must be regular bounded files.');
    if (secret && process.platform !== 'win32' && (stat.mode & 0o007)) throw new Error('The HTTPS private key must not be readable by other users.');
    return fs.readFile(file);
}
async function ensureTls({ directory, env = process.env, host = '0.0.0.0', now = () => Date.now(), run = execute } = {}) {
    if (!directory) throw new Error('A private configuration directory is required for HTTPS.');
    const hasCert = Boolean(env.ICOM_WEB_TLS_CERT), hasKey = Boolean(env.ICOM_WEB_TLS_KEY);
    if (hasCert !== hasKey) throw new Error('Set both ICOM_WEB_TLS_CERT and ICOM_WEB_TLS_KEY, or neither.');
    if (hasCert) {
        let cert, key;
        try { [cert, key] = await Promise.all([customRead(env.ICOM_WEB_TLS_CERT, false), customRead(env.ICOM_WEB_TLS_KEY, true)]); }
        catch { throw new Error('The configured HTTPS certificate or private key could not be read securely.'); }
        const info = certificateInfo(cert, key);
        if (now() < info.begins || now() >= info.expires) throw new Error('The configured HTTPS certificate is not currently valid.');
        return { cert, key, selfSigned: false, generated: false, certificateFile: path.resolve(env.ICOM_WEB_TLS_CERT), keyFile: path.resolve(env.ICOM_WEB_TLS_KEY), expiresAt: new Date(info.expires).toISOString(), fingerprint256: info.parsed.fingerprint256 };
    }
    const tlsDirectory = path.join(directory, 'tls');
    await fs.mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(tlsDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('The HTTPS storage directory is not privately owned.');
    await fs.chmod(tlsDirectory, 0o700);
    const certificateFile = path.join(tlsDirectory, 'certificate.pem'), keyFile = path.join(tlsDirectory, 'private-key.pem');
    let cert = await privateRead(certificateFile), key = await privateRead(keyFile), generated = false;
    let info = null;
    if (cert && key) { try { info = certificateInfo(cert, key); } catch { /* Repair interrupted automatic rotation. */ } }
    const names = localNames(host);
    const boundHostMissing = info && net.isIP(host) === 4 && host !== '0.0.0.0' && !info.parsed.checkIP(host);
    if (!info || now() < info.begins || info.expires - now() <= 30 * 86400000 || boundHostMissing) {
        const temporary = path.join(tlsDirectory, `.generate-${randomBytes(8).toString('hex')}`);
        const certTemporary = temporary + '.crt', keyTemporary = temporary + '.key';
        try {
            await run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '365',
                '-keyout', keyTemporary, '-out', certTemporary, '-subj', '/CN=Icom LAN Splitter', '-addext', `subjectAltName=${names.join(',')}`], { timeout: 30000, maxBuffer: 65536 });
            [cert, key] = await Promise.all([fs.readFile(certTemporary), fs.readFile(keyTemporary)]);
            info = certificateInfo(cert, key);
            await atomicWrite(keyFile, key); await atomicWrite(certificateFile, cert);
            generated = true;
        } catch { throw new Error('Could not prepare HTTPS. Install OpenSSL or configure a valid HTTPS certificate and private key.'); }
        finally { await Promise.all([fs.rm(certTemporary, { force: true }), fs.rm(keyTemporary, { force: true })]); }
    }
    return { cert: Buffer.from(cert), key: Buffer.from(key), selfSigned: true, generated, certificateFile, keyFile,
        expiresAt: new Date(info.expires).toISOString(), fingerprint256: info.parsed.fingerprint256 };
}
module.exports = { ensureTls };
