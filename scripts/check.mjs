import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter(file => file.endsWith('.mjs'))) {
    const path = join(directory, file);
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(result.stderr || result.error?.message);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log('JavaScript syntax checks passed.');
