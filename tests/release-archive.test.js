'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gunzipSync, inflateRawSync } = require('node:zlib');
const { packageArchive } = require('../scripts/release-archive');

async function fixture(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'icom-archive-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, 'release');
    await fs.mkdir(path.join(root, 'licenses'), { recursive: true });
    await fs.mkdir(path.join(root, 'empty'));
    await fs.writeFile(path.join(root, 'program'), 'executable data\n', { mode: 0o755 });
    await fs.chmod(path.join(root, 'program'), 0o755);
    await fs.writeFile(path.join(root, 'licenses', 'NOTICE.txt'), 'license\n');
    return { temp, root };
}
function parseTar(bytes) {
    const result = [];
    for (let offset = 0; offset < bytes.length && bytes[offset];) {
        const h = bytes.subarray(offset, offset + 512);
        const str = (start, end) => h.subarray(start, end).toString().replace(/\0.*$/, '');
        const size = parseInt(str(124, 136), 8), prefix = str(345, 500), name = str(0, 100);
        const checksum = parseInt(str(148, 156).trim(), 8);
        assert.equal([...h].reduce((sum, value, i) => sum + (i >= 148 && i < 156 ? 32 : value), 0), checksum);
        result.push({ name: prefix ? `${prefix}/${name}` : name, mode: parseInt(str(100, 108), 8),
            epoch: parseInt(str(136, 148), 8), data: bytes.subarray(offset + 512, offset + 512 + size).toString() });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return result;
}
function parseZip(bytes, executableMode) {
    const result = [];
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
        const packedSize = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
        const extra = bytes.readUInt16LE(offset + 28), start = offset + 30 + length + extra;
        result.push({ name: bytes.subarray(offset + 30, offset + 30 + length).toString(),
            data: inflateRawSync(bytes.subarray(start, start + packedSize)).toString() });
        offset = start + packedSize;
    }
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054b50);
    assert.equal(bytes.readUInt32LE(end + 16), offset);
    const central = [];
    while (bytes.readUInt32LE(offset) === 0x02014b50) {
        const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
        central.push({ name: bytes.subarray(offset + 46, offset + 46 + length).toString(), mode: bytes.readUInt32LE(offset + 38) >>> 16 });
        offset += 46 + length + extra + comment;
    }
    assert.equal(central.length, result.length);
    assert.deepEqual(central.map((e) => e.name), result.map((e) => e.name));
    assert.equal(central.find((e) => e.name === 'release/program').mode & 0o777, executableMode);
    return result;
}

for (const extension of ['tar.gz', 'zip']) {
    test(`${extension} is deterministic, preserves content and extracts with system tar`, async (t) => {
        const { temp, root } = await fixture(t);
        const first = path.join(temp, `first.${extension}`), second = path.join(temp, `second.${extension}`);
        await packageArchive(root, first, 1700000000);
        await fs.utimes(path.join(root, 'program'), new Date(), new Date());
        await packageArchive(root, second, 1700000000);
        const a = await fs.readFile(first), b = await fs.readFile(second);
        assert.deepEqual(a, b);
        const executableMode = (await fs.stat(path.join(root, 'program'))).mode & 0o111 ? 0o755 : 0o644;
        const parsed = extension === 'zip' ? parseZip(a, executableMode) : parseTar(gunzipSync(a));
        assert.deepEqual(parsed.map((e) => e.name), ['release/', 'release/empty/', 'release/licenses/', 'release/licenses/NOTICE.txt', 'release/program']);
        assert.equal(parsed.find((e) => e.name === 'release/program').data, 'executable data\n');
        if (extension === 'tar.gz') {
            assert.ok(parsed.every((e) => e.epoch === 1700000000));
            assert.equal(parsed.find((e) => e.name === 'release/program').mode, executableMode);
            assert.equal(parsed.find((e) => e.name.endsWith('NOTICE.txt')).mode, 0o644);
        }
        const extracted = path.join(temp, 'extracted'); await fs.mkdir(extracted);
        // GNU tar lacks ZIP; bsdtar (macOS/Windows) handles both. unzip is an independent fallback.
        let command = spawnSync('tar', ['-xf', first, '-C', extracted], { encoding: 'utf8' });
        if (command.status !== 0 && extension === 'zip') command = spawnSync('unzip', ['-q', first, '-d', extracted], { encoding: 'utf8' });
        if (command.error?.code === 'ENOENT') t.diagnostic('No independent archive extractor available; structural validation passed');
        else {
            assert.equal(command.status, 0, command.stderr);
            assert.equal(await fs.readFile(path.join(extracted, 'release', 'program'), 'utf8'), 'executable data\n');
            assert.equal(await fs.readFile(path.join(extracted, 'release', 'licenses', 'NOTICE.txt'), 'utf8'), 'license\n');
            assert.ok((await fs.stat(path.join(extracted, 'release', 'empty'))).isDirectory());
            if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(extracted, 'release', 'program'))).mode & 0o777, 0o755);
        }
    });
}

test('archive input rejects symlinks, unsupported output and invalid epoch', async (t) => {
    const { temp, root } = await fixture(t);
    await assert.rejects(packageArchive(root, path.join(temp, 'bad.rar'), 1700000000), /extension/);
    await assert.rejects(packageArchive(root, path.join(temp, 'bad.zip'), -1), /epoch/);
    if (process.platform === 'win32') return; // Windows symlink creation needs privileges.
    await fs.symlink('program', path.join(root, 'link'));
    await assert.rejects(packageArchive(root, path.join(temp, 'bad.zip'), 1700000000), /regular/);
});

test('USTAR splits long portable paths into prefix and filename fields', async (t) => {
    const { temp, root } = await fixture(t);
    const relative = `${'subdirectory'.repeat(7)}/NOTICE.txt`;
    await fs.mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), 'long path\n');
    const output = path.join(temp, 'long.tar.gz');
    await packageArchive(root, output, 1700000000);
    const parsed = parseTar(gunzipSync(await fs.readFile(output)));
    assert.equal(parsed.find((entry) => entry.name === `release/${relative}`).data, 'long path\n');
});
