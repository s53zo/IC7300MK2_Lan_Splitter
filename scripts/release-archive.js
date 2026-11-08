'use strict';

// Small deterministic USTAR/ZIP writers for release contents, using no build deps.
const fs = require('node:fs/promises');
const path = require('node:path');
const { deflateRawSync, gzipSync } = require('node:zlib');

async function entries(directory) {
    const root = path.resolve(directory);
    const result = [];
    async function walk(file, name) {
        if (name.includes('\\') || name.includes('\0')) throw new Error('Non-portable archive path');
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Only regular files/directories may be archived');
        const directory = stat.isDirectory();
        result.push({ name: name + (directory ? '/' : ''), mode: directory || (stat.mode & 0o111) ? 0o755 : 0o644,
            directory, data: directory ? Buffer.alloc(0) : await fs.readFile(file) });
        if (directory) {
            const children = (await fs.readdir(file)).sort();
            for (const child of children) await walk(path.join(file, child), `${name}/${child}`);
        }
    }
    await walk(root, path.basename(root));
    return result;
}

function octal(header, offset, size, value) {
    const text = value.toString(8);
    if (text.length >= size) throw new Error('USTAR numeric field overflow');
    header.write(text.padStart(size - 1, '0') + '\0', offset, size, 'ascii');
}
function tar(files, epoch) {
    const parts = [];
    for (const entry of files) {
        const header = Buffer.alloc(512);
        let name = entry.name, prefix = '';
        if (Buffer.byteLength(name) > 100) {
            const split = [...name.matchAll(/\//g)].map((m) => m.index)
                .find((i) => Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100);
            if (split === undefined) throw new Error('Archive path exceeds USTAR limits');
            prefix = name.slice(0, split); name = name.slice(split + 1);
        }
        header.write(name, 0, 100, 'utf8');
        octal(header, 100, 8, entry.mode); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
        octal(header, 124, 12, entry.data.length); octal(header, 136, 12, epoch);
        header.fill(32, 148, 156); header[156] = entry.directory ? 53 : 48;
        header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
        header.write(prefix, 345, 155, 'utf8');
        const checksum = header.reduce((sum, value) => sum + value, 0);
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        parts.push(header, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
    }
    parts.push(Buffer.alloc(1024));
    const compressed = gzipSync(Buffer.concat(parts), { level: 9 });
    compressed[9] = 255; // Normalize gzip's OS identifier across build runners.
    return compressed;
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
    for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
    return i >>> 0;
});
function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
function zip(files, epoch) {
    const date = new Date(Math.max(Date.UTC(1980, 0, 1), Math.min(Date.UTC(2107, 11, 31, 23, 59, 58), epoch * 1000)));
    const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    const local = [], central = [];
    let offset = 0;
    for (const entry of files) {
        const name = Buffer.from(entry.name, 'utf8'), packed = deflateRawSync(entry.data, { level: 9 });
        if (name.length > 65535 || packed.length > 0xffffffff || entry.data.length > 0xffffffff) throw new Error('ZIP64 is not supported');
        const crc = crc32(entry.data), header = Buffer.alloc(30), directory = Buffer.alloc(46);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(8, 8); header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(entry.data.length, 22);
        header.writeUInt16LE(name.length, 26);
        directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4);
        header.copy(directory, 6, 4, 30);
        const mode = (entry.directory ? 0o040000 : 0o100000) | entry.mode;
        directory.writeUInt32LE(((mode << 16) | (entry.directory ? 16 : 0)) >>> 0, 38);
        directory.writeUInt32LE(offset, 42);
        local.push(header, name, packed); central.push(directory, name);
        offset += header.length + name.length + packed.length;
        if (offset > 0xffffffff) throw new Error('ZIP64 is not supported');
    }
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    if (files.length > 65535 || centralSize > 0xffffffff) throw new Error('ZIP64 is not supported');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

async function packageArchive(directory, outputPath, epochSeconds) {
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) throw new Error('Archive epoch must be nonnegative integer seconds');
    const files = await entries(directory);
    const output = outputPath.endsWith('.zip') ? zip(files, epochSeconds)
        : outputPath.endsWith('.tar.gz') ? tar(files, epochSeconds) : null;
    if (!output) throw new Error('Archive extension must be .zip or .tar.gz');
    await fs.writeFile(outputPath, output);
}
module.exports = { packageArchive };
