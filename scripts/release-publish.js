'use strict';
// Only this aggregate job has contents:write. Never publish or create Git refs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { metadata } = require('./release-meta');
async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !process.env.GH_TOKEN) throw new Error('Missing repository/token');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (process.env.GITHUB_SHA !== commit) throw new Error('Checkout mismatch');
    const meta = metadata(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, commit, require('../package.json').version);
    const directory = path.resolve('dist');
    const expected = ['win32-x64.zip', 'darwin-x64.tar.gz', 'darwin-arm64.tar.gz', 'linux-x64.tar.gz', 'linux-arm64.tar.gz']
        .map((target) => `icom-lan-splitter-${meta.label}-${target}`);
    for (const name of expected) if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error(`Missing ${name}`);
    const source = `icom-lan-splitter-${meta.label}-source.tar.gz`;
    execFileSync('git', ['archive', '--format=tar.gz', `--prefix=icom-lan-splitter-${meta.label}-source/`, `--output=${path.join(directory, source)}`, commit]);
    const names = [...expected, source].sort();
    const hashes = names.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`).join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), hashes);
    const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
    async function api(url, options = {}) {
        const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        if (!response.ok) throw new Error(`GitHub API failed: ${response.status}`);
        return response.json();
    }
    const base = `https://api.github.com/repos/${repo}`;
    const existing = await api(`${base}/releases?per_page=100`);
    if (existing.some((release) => release.tag_name === meta.tag)) throw new Error('Release already exists; refusing to overwrite assets');
    const release = await api(`${base}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        tag_name: meta.tag, target_commitish: commit, name: `IC-7300MK2 LAN Splitter ${meta.label}`, draft: true,
        prerelease: meta.prerelease, make_latest: 'false',
        body: `Standalone executables built from ${commit}.\n\nAll five native targets passed the full suite and extracted-executable synthetic LAN smoke tests.\n\nNo Node.js installation required. Windows is unsigned; macOS is ad-hoc signed and not notarized. See docs/releases.md in each archive for OS requirements and configuration.\n\nThe source archive contains corresponding application source and build scripts. NODE-LICENSE includes embedded runtime notices; BUILD.json identifies the runtime source.\n\nSHA-256 checksums:\n\n\`\`\`text\n${hashes}\`\`\`\n`,
    }) });
    for (const name of [...names, 'SHA256SUMS']) {
        await api(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, { method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(path.join(directory, name)) });
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Draft release: ${release.html_url}\n\n\`\`\`text\n${hashes}\`\`\`\n`);
    console.log(`Draft release: ${release.html_url}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
