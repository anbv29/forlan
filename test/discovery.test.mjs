import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { exportPatch } from '../src/patch.mjs';
import { cliArguments } from '../src/agents.mjs';
import { command } from '../src/workspace.mjs';
import { diagnose } from '../scripts/doctor.mjs';
import { repositoryFixture } from './helpers.mjs';

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
