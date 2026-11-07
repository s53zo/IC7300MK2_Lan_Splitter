'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let failed = false;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); failed = true; }
    }
  }
}
for (const dir of ['src', 'tests', 'scripts']) walk(dir);
process.exitCode = failed ? 1 : 0;
