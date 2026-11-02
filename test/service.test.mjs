import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../src/service.mjs';
import { createServer } from '../src/server.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { repositoryFixture, mockInference, settled } from './helpers.mjs';
import { join } from 'node:path';

async function request(app, path, headers = {}, method = 'GET') {
  let status, result;
  const req = { url: path, method, headers: { host: new URL(app.url).host, ...headers }, resume() {} };
  const res = { headersSent: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(body) { result = JSON.parse(body); } };
  await app.server.listeners('request')[0](req, res);
  return { status, result };
}

test('background service authenticates health and metrics without exposing its token', async () => {
  const f = await repositoryFixture();
  const token = 'service-secret-example-'.repeat(3);
  const app = await startService(f.config, { token, port: 0 });
  try {
    assert.equal((await request(app, '/health')).status, 401);
    const auth = { authorization: 'Bearer ' + token };
    assert.equal((await request(app, '/health', auth)).status, 200);
    const metrics = await request(app, '/metrics', auth);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.result.maxConcurrent, 2);
    assert.ok(!JSON.stringify(metrics).includes(token));
    assert.equal((await request(app, '/health', { ...auth, origin: 'https://example.invalid' })).status, 403);
    assert.equal((await request(app, '/health', { ...auth, host: 'attacker.invalid' })).status, 403);
    assert.equal((await request(app, '/unknown', auth)).status, 404);
    assert.equal((await request(app, '/mcp', auth)).status, 404);
    assert.equal((await request(app, '/mcp', auth, 'POST')).status, 415);
    assert.equal((await request(app, '/mcp', { ...auth, 'content-length': '1000001', 'content-type': 'application/json' }, 'POST')).status, 413);
  } finally { await app.close(); await app.close(); await f.remove(); }
});

test('MCP disconnect leaves shared background automation running and allows reconnect', async t => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  mockInference(t, () => ({ content: 'Background run completed.' }));
  const app = createServer(f.config, { runtime });
  const client = new Client({ name: 'background-client', version: '1' });
  const pair = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(pair[0]), client.connect(pair[1])]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'get_runtime_metrics'));
    await client.close();
    assert.equal(runtime.closing, false);
    const rule = await runtime.automations.create({ name: 'Disconnected job', repository: f.repository,
      goal: 'Run in background', trigger: { type: 'event', eventType: 'repo.changed' } });
    runtime.automations.enable(rule.id);
    const event = runtime.automations.event({ id: 'delivery-1', type: 'repo.changed' });
    const run = runtime.automations.store.run(event.runs[0].id);
    assert.equal((await settled(runtime, run.taskId)).status, 'needs_review');
    const nextApp = createServer(f.config, { runtime });
    const nextClient = new Client({ name: 'reconnected-client', version: '1' });
    const nextPair = InMemoryTransport.createLinkedPair();
    await Promise.all([nextApp.server.connect(nextPair[0]), nextClient.connect(nextPair[1])]);
    const report = await nextClient.callTool({ name: 'get_runtime_metrics', arguments: {} });
    assert.equal(JSON.parse(report.content[0].text).statuses.needs_review, 1);
    await nextClient.close();
    assert.equal(runtime.closing, false);
  } finally { await client.close(); await runtime.close(); await f.remove(); }
});

test('shared service clients still require human approval to resume interrupted tasks', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime({ ...f.config, requireApproval: true });
  const app = createServer(runtime.config, { runtime });
  const client = new Client({ name: 'approval-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let approve = false;
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { approve } }));
  const pair = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(pair[0]), client.connect(pair[1])]);
    const task = runtime.store.create(f.repository, 'Continue approved work');
    runtime.store.update(task.id, { status: 'interrupted', stages: [{ agent: 'byok' }], stageIndex: 0, stageResults: [] });
    const args = { name: 'resume_task', arguments: { taskId: task.id } };
    await client.callTool(args);
    assert.equal(runtime.store.get(task.id).status, 'interrupted');
    approve = true;
    const accepted = await client.callTool(args);
    assert.ok(!accepted.isError, JSON.stringify(accepted));
    assert.equal((await settled(runtime, task.id)).status, 'awaiting_approval');
    assert.equal(runtime.store.get(task.id).recoveryCount, 1);
  } finally { await client.close(); await runtime.close(); await f.remove(); }
});

test('service refuses weak credentials and invalid ports before starting', async () => {
  await assert.rejects(startService({}, { token: 'short' }), /TOKEN/);
  await assert.rejects(startService({}, { token: 'x'.repeat(32), port: 99999 }), /port/);
});

test('failed service startup releases its runtime lock for a later retry', async () => {
  const f = await repositoryFixture();
  const token = 'x'.repeat(32);
  const app = await startService(f.config, { token, port: 0 });
  const config = { ...f.config, stateDir: join(f.directory, 'second-state') };
  try {
    await assert.rejects(startService(config, { token, port: app.server.address().port }), /EADDRINUSE/);
    const retry = await startService(config, { token, port: 0 });
    assert.equal(retry.runtime.closing, false);
    await retry.close();
  } finally { await app.close(); await f.remove(); }
});
