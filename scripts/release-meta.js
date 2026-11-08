'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
function metadata(event, ref, commit, version) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid commit');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version');
    if (event === 'push') {
        const shortTag = /^\d+\.\d+\.0$/.test(version) ? `refs/tags/v${version.slice(0, -2)}` : null;
        if (ref !== `refs/tags/v${version}` && ref !== shortTag) throw new Error('Release tag must match package.json version (patch zero may be omitted)');
        return { label: version, tag: ref.slice('refs/tags/'.length), prerelease: version.includes('-'), commit };
    }
    if (event !== 'workflow_dispatch') throw new Error('Unsupported release event');
    const short = commit.slice(0, 12);
    return { label: `${version}-preview.${short}`, tag: `preview-${short}`, prerelease: true, commit };
}
function main() {
    const version = require('../package.json').version;
    const lock = require('../package-lock.json');
    if (lock.version !== version || lock.packages[''].version !== version) throw new Error('package-lock version mismatch');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (process.env.GITHUB_SHA !== commit) throw new Error('Checkout does not match workflow commit');
    const meta = metadata(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, commit, version);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
        Object.entries(meta).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(meta));
}
if (require.main === module) main();
module.exports = { metadata };
