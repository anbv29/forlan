import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command } from '../src/workspace.mjs';
import { loadConfig } from '../src/core.mjs';
import { repositoryFixture } from './helpers.mjs';

test('setup creates a valid CLI-only config and preserves existing owner settings on rerun', async () => {
  const f = await repositoryFixture();
  try {
    const entry = join(f.directory, 'codex.mjs');
    const configPath = join(f.directory, 'config.json');
    await writeFile(entry, 'console.log("fixture CLI")');
    const args = [resolve('scripts/setup.mjs'), '--config', configPath, '--repository', f.repository,
      '--state-dir', join(f.directory, 'state'), '--codex-entry', entry];
    const result = await command(process.execPath, args, resolve('.'));
    assert.equal(result.code, 0, result.output);
    const config = loadConfig({ BYOK_CONFIG: configPath });
    assert.equal(config.defaultAgent, 'codex');
    assert.equal(config.requireApproval, true);
    assert.equal(config.agents.reviewer.readOnly, true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.registered, false);
    assert.ok(report.args.includes('BYOK_CONFIG=' + configPath));
    const original = await readFile(configPath, 'utf8');
    const second = await command(process.execPath, args, resolve('.'));
    assert.equal(second.code, 0, second.output);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally { await f.remove(); }
});
