import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CRAFTHELM_ROOT } from './lib/paths.mjs';

const testsRoot = path.join(CRAFTHELM_ROOT, 'tests');
const testFiles = [];

function walkTests(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTests(abs);
    } else if (entry.isFile() && /\.test\.mjs$/.test(entry.name)) {
      testFiles.push(abs);
    }
  }
}

walkTests(testsRoot);
testFiles.sort();

if (testFiles.length === 0) {
  process.stderr.write('No *.test.mjs files found under tests/\n');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: CRAFTHELM_ROOT,
  stdio: 'inherit',
  windowsHide: true,
});

process.exit(typeof res.status === 'number' ? res.status : 1);
