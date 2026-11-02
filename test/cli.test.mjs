import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command } from '../src/workspace.mjs';
import { repositoryFixture } from './helpers.mjs';

const cli = resolve('src/cli.mjs');
const run = args => command(process.execPath, [cli, ...args], resolve('.'), undefined, 20000);

test('CLI exposes its version and useful help and rejects unknown commands', async () => {
  const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), metadata.version);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /setup.*configuration/);
  assert.match(help.stdout, /doctor/);
  assert.match(help.stdout, /smoke/);
  const unknown = await run(['does-not-exist']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /Unknown command/);
});

test('CLI configuration flag routes setup doctor and a real stdio smoke connection', async () => {
  const f = await repositoryFixture();
  try {
    const config = join(f.directory, 'config.json');
    const entry = join(f.directory, 'codex.mjs');
    await writeFile(entry, 'console.log("fixture CLI version")');
    const setup = await run(['--config', config, 'setup', '--repository', f.repository,
      '--state-dir', f.config.stateDir, '--codex-entry', entry]);
    assert.equal(setup.code, 0, setup.output);
    const settings = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(settings.repositories[0], f.repository);
    assert.equal(settings.requireApproval, true);
    const doctor = await run(['--config', config, 'doctor']);
    assert.equal(doctor.code, 0, doctor.output);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
    const smoke = await run(['--config', config, 'smoke']);
    assert.equal(smoke.code, 0, smoke.output);
    const connection = JSON.parse(smoke.stdout);
    assert.equal(connection.connected, true);
    assert.equal(connection.inferenceUsed, false);
    assert.ok(connection.toolCount >= 33);
    assert.ok(connection.resources.includes('byok://guide'));
    assert.ok(connection.prompts.includes('implement-change'));
  } finally { await f.remove(); }
});
