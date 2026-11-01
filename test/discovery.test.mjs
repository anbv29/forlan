import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { exportPatch } from '../src/patch.mjs';
import { cliArguments } from '../src/agents.mjs';
import { command } from '../src/workspace.mjs';
import { diagnose } from '../scripts/doctor.mjs';
import { repositoryFixture } from './helpers.mjs';

test('export patch applies tracked edits, deletions and new text files without staging', async () => {
  const f = await repositoryFixture();
  try {
    await writeFile(join(f.repository, 'delete.txt'), 'delete this\n');
    await f.git(['add', 'delete.txt']);
    await f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'patch fixture']);
    const base = (await command('git', ['rev-parse', 'HEAD'], f.repository)).stdout.trim();
    await writeFile(join(f.repository, 'answer.txt'), 'Updated answer\n');
    await unlink(join(f.repository, 'delete.txt'));
    await mkdir(join(f.repository, 'nested'));
    await writeFile(join(f.repository, 'nested', 'new file.txt'), 'First\nLast');
    await writeFile(join(f.repository, 'empty.txt'), '');
    const exported = await exportPatch({ id: 'fixture', workspace: f.repository, base });
    assert.equal(exported.bytes, Buffer.byteLength(exported.patch));
    assert.equal((await command('git', ['diff', '--cached'], f.repository)).stdout, '');
    const patchPath = join(f.directory, 'change.patch');
    await writeFile(patchPath, exported.patch);
    await f.git(['checkout', '--', 'answer.txt', 'delete.txt']);
    await unlink(join(f.repository, 'nested', 'new file.txt'));
    await unlink(join(f.repository, 'empty.txt'));
    await f.git(['apply', '--check', patchPath]);
    await f.git(['apply', patchPath]);
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'Updated answer\n');
    assert.equal(await readFile(join(f.repository, 'nested', 'new file.txt'), 'utf8'), 'First\nLast');
    assert.equal(await readFile(join(f.repository, 'empty.txt'), 'utf8'), '');
    await assert.rejects(readFile(join(f.repository, 'delete.txt')), /ENOENT/);
    await writeFile(join(f.repository, '.env'), 'SECRET=hidden');
    await assert.rejects(exportPatch({ workspace: f.repository, base }), /Restricted/);
  } finally { await f.remove(); }
});

test('MCP clients discover the guide and workflow prompt and reject invalid exports', async () => {
  const f = await repositoryFixture();
  const app = createServer(f.config);
  const client = new Client({ name: 'discovery-test', version: '1' });
  const pair = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(pair[0]), client.connect(pair[1])]);
    assert.ok((await client.listResources()).resources.some(r => r.uri === 'byok://guide'));
    assert.match((await client.readResource({ uri: 'byok://guide' })).contents[0].text, /review_checkpoint/);
    const prompt = await client.getPrompt({ name: 'implement-change', arguments: { repository: f.repository, goal: 'Fix bug' } });
    assert.match(prompt.messages[0].content.text, /Fix bug/);
    const task = app.runtime.store.create(f.repository, 'No worktree');
    const result = await client.callTool({ name: 'export_task_patch', arguments: { taskId: task.id } });
    assert.equal(result.isError, true);
  } finally { await client.close(); await app.close(); await f.remove(); }
});

test('doctor verifies committed roots without running models and warns about missing checks', async () => {
  const f = await repositoryFixture();
  try {
    const report = await diagnose({ ...f.config, agents: {} });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.match(report.warnings[0], /No verification/);
    const invalid = await diagnose({ ...f.config, repositories: [f.directory], agents: {} });
    assert.equal(invalid.ok, false);
    assert.ok(cliArguments({ kind: 'codex' }, {}).includes('mcp_servers.byok-agent.enabled=false'));
  } finally { await f.remove(); }
});

test('patch export rejects a tracked restricted file even after it is renamed', async () => {
  const f = await repositoryFixture();
  try {
    const restricted = join(f.repository, '.env');
    await writeFile(restricted, 'TEST_ONLY=not-a-real-secret\n');
    await f.git(['add', '.env']);
    await f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'restricted fixture']);
    const result = await command('git', ['rev-parse', 'HEAD'], f.repository);
    assert.equal(result.code, 0);
    const base = result.stdout.trim();
    await rename(restricted, join(f.repository, 'renamed.txt'));
    await assert.rejects(exportPatch({ workspace: f.repository, base }), /Restricted/);
  } finally {
    await f.remove();
  }
});

test('patch export refuses binary and oversized new files instead of returning partial patches', async () => {
  const f = await repositoryFixture();
  try {
    const result = await command('git', ['rev-parse', 'HEAD'], f.repository);
    assert.equal(result.code, 0);
    const base = result.stdout.trim();
    const file = join(f.repository, 'new.dat');
    await writeFile(file, Buffer.from([1, 0, 2]));
    await assert.rejects(exportPatch({ workspace: f.repository, base }), /Binary/);
    await writeFile(file, 'x'.repeat(100001));
    await assert.rejects(exportPatch({ workspace: f.repository, base }), /100 KB/);
    await unlink(file);
    const clean = await exportPatch({ workspace: f.repository, base });
    assert.equal(clean.patch, '');
    assert.equal(clean.bytes, 0);
  } finally {
    await f.remove();
  }
});
