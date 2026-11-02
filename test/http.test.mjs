import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startService } from '../src/service.mjs';
import { repositoryFixture, settled } from './helpers.mjs';
import { httpFetch } from './http-client.mjs';

const options = { timeout: 20000 };

test('HTTP MCP initializes discovers tools and reconnects without losing paused work', options, async () => {
  const f = await repositoryFixture();
  const token = 'http-fixture-token-'.repeat(3);
  const app = await startService({ ...f.config, requireApproval: true }, { token, port: 0 });
  const fetch = httpFetch(app.server);
  const transport = new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
    fetch,
    requestInit: { headers: { Authorization: 'Bearer ' + token } }
  });
  const client = new Client({ name: 'http-test', version: '1' });
  let reconnected;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 33);
    assert.ok(transport.sessionId);
    const initialSession = transport.sessionId;
    assert.ok((await client.listPrompts()).prompts.some(prompt => prompt.name === 'implement-change'));
    assert.ok(tools.tools.some(tool => tool.name === 'start_task'));
    assert.ok((await client.listResources()).resources.some(resource => resource.uri === 'forlan://guide'));
    const result = await client.callTool({ name: 'start_task', arguments: { repository: f.repository, goal: 'Wait for approval' } });
    assert.ok(!result.isError, JSON.stringify(result));
    const task = JSON.parse(result.content[0].text);
    assert.equal((await settled(app.runtime, task.id)).status, 'awaiting_approval');
    await transport.terminateSession();
    await client.close();
    assert.equal(app.runtime.closing, false);
    assert.equal(app.runtime.store.get(task.id).stageIndex, 0);
    reconnected = new Client({ name: 'http-reconnected', version: '1' });
    const nextTransport = new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      fetch,
      requestInit: { headers: { Authorization: 'Bearer ' + token } }
    });
    await reconnected.connect(nextTransport);
    const status = await reconnected.callTool({ name: 'get_task_status', arguments: { taskId: task.id } });
    assert.equal(JSON.parse(status.content[0].text).status, 'awaiting_approval');
    assert.equal(JSON.parse(status.content[0].text).id, task.id);
    assert.ok(nextTransport.sessionId);
    assert.notEqual(nextTransport.sessionId, initialSession);
    const configuration = await reconnected.callTool({ name: 'get_configuration', arguments: {} });
    assert.ok(!JSON.stringify(configuration).includes(token));
    await nextTransport.terminateSession();
  } finally { await reconnected?.close(); await client.close(); await app.close(); await f.remove(); }
});

test('HTTP MCP delivers human approval forms and honors rejection before model execution', options, async () => {
  const f = await repositoryFixture();
  const token = 'http-approval-token-'.repeat(3);
  const app = await startService({ ...f.config, requireApproval: true }, { token, port: 0 });
  const fetch = httpFetch(app.server);
  const client = new Client({ name: 'http-approval', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    forms++;
    return { action: 'accept', content: { approve: false } };
  });
  const transport = new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
    fetch,
    requestInit: { headers: { Authorization: 'Bearer ' + token } }
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'start_task', arguments: { repository: f.repository, goal: 'Reject this task' } });
    const task = JSON.parse(result.content[0].text);
    assert.equal((await settled(app.runtime, task.id)).status, 'awaiting_approval');
    const rejected = await client.callTool({ name: 'review_checkpoint', arguments: { taskId: task.id, stageIndex: 0 } });
    assert.ok(!rejected.isError, JSON.stringify(rejected));
    assert.equal(JSON.parse(rejected.content[0].text).status, 'cancelled');
    assert.equal(forms, 1);
    assert.equal(app.runtime.active.size, 0);
    assert.equal(app.runtime.store.get(task.id).stageIndex, 0);
    assert.equal(app.runtime.store.events(task.id).filter(event => event.kind === 'stage_started').length, 0);
    await transport.terminateSession();
  } finally { await client.close(); await app.close(); await f.remove(); }
});

test('HTTP service rejects unauthenticated browser-origin malformed and oversized requests', options, async () => {
  const f = await repositoryFixture();
  const token = 'http-boundary-token-'.repeat(3);
  const app = await startService(f.config, { token, port: 0 });
  const fetch = httpFetch(app.server);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const send = (path, init = {}) => fetch(app.url + path, { ...init, signal: AbortSignal.timeout(5000) });
  try {
    assert.equal((await send('/health')).status, 401);
    assert.equal((await send('/health', { headers })).status, 200);
    assert.equal((await send('/health', { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await send('/mcp', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await send('/mcp', { method: 'POST', headers, body: 'x'.repeat(1000001) })).status, 413);
    const metrics = await send('/metrics', { headers });
    assert.equal(metrics.status, 200);
    assert.ok(!(await metrics.text()).includes(token));
    const unknown = await send('/mcp', { headers: { ...headers, 'mcp-session-id': 'unknown' } });
    assert.equal(unknown.status, 404);
    assert.equal(app.runtime.active.size, 0);
  } finally { await app.close(); await f.remove(); }
});
