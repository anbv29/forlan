import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { command, safePath, commandEnv } from '../src/workspace.mjs';
import { loadConfig, Store } from '../src/core.mjs';
import { Runtime } from '../src/runtime.mjs';

export async function fixture() {
  await mkdir(resolve('work'), { recursive: true });
  const directory = await mkdtemp(resolve('work/byok-mcp-test-'));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  await writeFile(join(repository, 'answer.txt'), 'before');
  const run = async args => {
    const result = await command('git', args, repository);
    assert.equal(result.code, 0, result.output);
  };
  await run(['init', '--separate-git-dir', join(directory, 'git-metadata')]);
  await run(['add', '.']);
  await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  return { directory, repository, remove: () => rm(directory, { recursive: true, force: true }) };
}

test('configuration enforces HTTPS, explicit roots and environment-only keys', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'config.json');
    const base = { repositories: [f.repository], model: 'test-model',
      baseUrl: 'https://example.invalid/v1', stateDir: join(f.directory, 'state') };
    await writeFile(path, JSON.stringify(base));
    assert.throws(() => loadConfig({ BYOK_CONFIG: path }), /API key/);
    const config = loadConfig({ BYOK_CONFIG: path, BYOK_API_KEY: 'fake-secret' });
    assert.equal(config.apiKey, 'fake-secret');
    await writeFile(path, JSON.stringify({ ...base, baseUrl: 'http://example.invalid' }));
    assert.throws(() => loadConfig({ BYOK_CONFIG: path, BYOK_API_KEY: 'fake-secret' }), /HTTPS/);
    await writeFile(path, JSON.stringify({ ...base, stateDir: join(f.repository, 'state') }));
    assert.throws(() => loadConfig({ BYOK_CONFIG: path, BYOK_API_KEY: 'fake-secret' }), /outside/);
    for (const path of ['../escape', '.git/config', '.env', '.ENV.local']) {
      await assert.rejects(safePath(f.repository, path, true));
    }
    process.env.BYOK_TEST_SECRET = 'never-in-children';
    assert.equal(commandEnv().BYOK_TEST_SECRET, undefined);
    delete process.env.BYOK_TEST_SECRET;
  } finally { await f.remove(); }
});

test('SQLite preserves task state and event cursors across reopen', async () => {
  const f = await fixture();
  try {
    let store = new Store(join(f.directory, 'state'));
    const task = store.create(f.repository, 'Goal');
    store.update(task.id, { status: 'running' });
    store.event(task.id, 'tool', { name: 'read_file' });
    const first = store.events(task.id)[0];
    store.close();
    store = new Store(join(f.directory, 'state'));
    store.recover();
    assert.equal(store.get(task.id).status, 'interrupted');
    assert.deepEqual(store.events(task.id, first.sequence), []);
    assert.throws(() => store.get('missing'), /Unknown/);
    store.close();
  } finally { await f.remove(); }
});

export async function mockProvider(handler) {
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    try { await handler(req, res, JSON.parse(input)); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export function reply(res, message) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }));
}

export async function waitTask(runtime, id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = runtime.store.get(id);
    if (!['queued', 'running'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Task did not finish.');
}

test('runtime cancellation aborts inference and persists cancellation', async () => {
  const f = await fixture();
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const provider = await mockProvider(() => { called(); });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 3, maxConcurrent: 1 });
  try {
    const task = await runtime.start(f.repository, 'Wait');
    await started;
    await assert.rejects(runtime.start(f.repository, 'Another'), /limit/);
    assert.equal(runtime.cancel(task.id).cancellationRequested, true);
    assert.equal((await waitTask(runtime, task.id)).status, 'cancelled');
    await assert.rejects(runtime.start(f.directory, 'Outside'), /configured/);
  } finally {
    await runtime.close();
    await provider.close();
    await f.remove();
  }
});

test('MCP stdio runs a BYOK task, checks edits, reviews new files and reloads history', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const f = await fixture();
  const calls = [];
  const toolCall = (id, name, args) => ({ id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } });
  const provider = await mockProvider((req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer integration-fake-key');
    assert.equal(body.model, 'fixture-model');
    calls.push(body);
    if (calls.length === 1) reply(res, { tool_calls: [toolCall('read', 'read_file', { path: 'answer.txt' })] });
    else if (calls.length === 2) {
      assert.equal(JSON.parse(body.messages.at(-1).content), 'before');
      reply(res, { tool_calls: [
        toolCall('edit', 'write_file', { path: 'answer.txt', content: 'after' }),
        toolCall('new', 'write_file', { path: 'NOTES.md', content: 'New file for review.' })
      ] });
    } else reply(res, { content: 'Updated the answer and added review notes.' });
  });
  const configPath = join(f.directory, 'config.json');
  const stateDir = join(f.directory, 'state');
  await writeFile(configPath, JSON.stringify({
    repositories: [f.repository], stateDir, baseUrl: provider.baseUrl,
    model: 'fixture-model', requireApproval: false, maxSteps: 5, maxConcurrent: 1,
    checks: [[process.execPath, '-e',
      "if(require('node:fs').readFileSync('answer.txt','utf8')!=='after')process.exit(1)"]]
  }));
  let client;
  const connect = async () => {
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve('src/server.mjs')],
      env: { ...commandEnv(), BYOK_CONFIG: configPath, BYOK_API_KEY: 'integration-fake-key' },
      stderr: 'pipe'
    });
    await client.connect(transport);
  };
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('integration-fake-key'));
    return JSON.parse(result.content[0].text);
  };
  try {
    await connect();
    assert.equal((await client.listTools()).tools.length, 14);
    assert.equal((await invoke('get_configuration')).model, 'fixture-model');
    const task = await invoke('start_task', { repository: f.repository, goal: 'Update answer and add notes.' });
    let final;
    for (let i = 0; i < 300; i++) {
      final = await invoke('get_task_status', { taskId: task.id });
      if (!['queued', 'running'].includes(final.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(final.status, 'needs_review', JSON.stringify(final));
    assert.equal(final.checks.passed, true);
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
    assert.equal(await readFile(join(final.workspace, 'answer.txt'), 'utf8'), 'after');
    const diff = await invoke('get_task_diff', { taskId: task.id });
    assert.match(diff.diff, /\+after/);
    assert.deepEqual(diff.untracked, ['NOTES.md']);
    assert.equal((await invoke('read_task_file', { taskId: task.id, path: 'NOTES.md' })).content,
      'New file for review.');
    const rejected = await client.callTool({ name: 'read_task_file',
      arguments: { taskId: task.id, path: '../config.json' } });
    assert.equal(rejected.isError, true);
    assert.equal((await invoke('run_checks', { taskId: task.id })).passed, true);
    assert.equal((await invoke('cancel_task', { taskId: task.id })).cancellationRequested, false);
    assert.ok((await invoke('get_task_events', { taskId: task.id })).events.length >= 3);
    await client.close();
    await connect();
    assert.equal((await invoke('get_task_status', { taskId: task.id })).status, 'needs_review');
    assert.equal((await invoke('list_tasks'))[0].id, task.id);
  } finally {
    await client?.close();
    await provider.close();
    await f.remove();
  }
});

test('failed verification is persisted and provider errors omit response bodies', async () => {
  const f = await fixture();
  let mode = 'complete';
  const provider = await mockProvider((_req, res) => {
    if (mode === 'error') { res.writeHead(401); res.end('private-provider-body'); }
    else reply(res, { content: 'No changes required.' });
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [[process.execPath, '-e', 'process.exit(7)']],
    maxSteps: 2, maxConcurrent: 1 });
  try {
    const first = await runtime.start(f.repository, 'Check');
    assert.equal((await waitTask(runtime, first.id)).status, 'checks_failed');
    mode = 'error';
    const second = await runtime.start(f.repository, 'Provider error');
    const failed = await waitTask(runtime, second.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /HTTP 401/);
    assert.ok(!JSON.stringify(failed).includes('private-provider-body'));
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('persistent events and task records redact configured credentials', async () => {
  const f = await fixture();
  const store = new Store(join(f.directory, 'redacted-state'), ['private-test-key']);
  try {
    const task = store.create(f.repository, 'private-test-key');
    store.event(task.id, 'usage', { provider: 'private-test-key' });
    store.update(task.id, { summary: 'contains private-test-key' });
    assert.ok(!JSON.stringify(store.get(task.id)).includes('private-test-key'));
    assert.ok(!JSON.stringify(store.events(task.id)).includes('private-test-key'));
    assert.match(store.get(task.id).summary, /REDACTED/);
    await assert.rejects(safePath(f.repository, 'answer.txt:secret', true));
  } finally {
    store.close();
    await f.remove();
  }
});

test('subprocess deadlines stop execution and report a failed check', async () => {
  const result = await command(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    process.cwd(), undefined, 100);
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => command(process.execPath, ['--version'], process.cwd(), controller.signal));
});

test('model-step limit stops repeated tool calls and preserves a reviewable worktree', async () => {
  const f = await fixture();
  const provider = await mockProvider((_req, res) => reply(res, { tool_calls: [{
    id: 'repeat', type: 'function', function: { name: 'list_files', arguments: '{}' }
  }] }));
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1 });
  try {
    assert.throws(() => new Runtime(runtime.config), /Another server/);
    const task = await runtime.start(f.repository, 'Repeat');
    const result = await waitTask(runtime, task.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /step limit/);
    assert.ok(result.workspace);
    assert.equal((await runtime.diff(task.id)).diff, '');
  } finally {
    await runtime.close();
    await provider.close();
    await f.remove();
  }
});

test('agent pipeline hands off changes and preserves checkpoints across restart', async () => {
  const { normalizeAgents } = await import('../src/agent-config.mjs');
  const f = await fixture();
  const fake = join(f.directory, 'agent.cjs');
  await writeFile(fake, [
    "const fs = require('node:fs'); let input='';",
    "process.stdin.on('data', x => input += x);",
    "process.stdin.on('end', () => {",
    "const codex = process.argv.includes('exec');",
    "if(codex) { fs.writeFileSync('answer.txt','implemented');",
    "console.error('stderr is not a JSON event');",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implementation complete.'}})); }",
    "else { if(!input.includes('Implementation complete.') || !input.includes('+implemented')) process.exit(3);",
    "console.log(JSON.stringify({result:'Review saw implementation.',is_error:false})); }",
    "});"
  ].join('\n'));
  const config = { repositories: [f.repository], stateDir: join(f.directory, 'state'),
    checks: [], maxSteps: 2, maxConcurrent: 1,
    ...normalizeAgents({ agents: {
      implement: { kind: 'codex', command: [process.execPath, fake] },
      review: { kind: 'claude', command: [process.execPath, fake] }
    }, defaultAgent: 'implement' }) };
  let runtime = new Runtime(config);
  try {
    const task = await runtime.start(f.repository, 'Implement then review', ['implement', 'review']);
    const pending = await waitTask(runtime, task.id);
    assert.equal(pending.status, 'awaiting_approval');
    assert.equal(pending.stageIndex, 0);
    assert.equal(await readFile(join(pending.workspace, 'answer.txt'), 'utf8'), 'before');
    runtime.decide(task.id, 0, true);
    const boundary = await waitTask(runtime, task.id);
    assert.equal(boundary.status, 'awaiting_approval');
    assert.equal(boundary.stageIndex, 1);
    assert.match(boundary.stageResults[0].summary, /Implementation complete/);
    assert.throws(() => runtime.decide(task.id, 0, true), /stale/);
    await runtime.close();
    runtime = new Runtime(config);
    assert.equal(runtime.store.get(task.id).status, 'awaiting_approval');
    runtime.decide(task.id, 1, true);
    const final = await waitTask(runtime, task.id);
    assert.equal(final.status, 'needs_review');
    assert.equal(final.stageResults.length, 2);
    assert.equal(final.summary, 'Review saw implementation.');
    assert.equal(final.checks.passed, false);
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
    const rejected = await runtime.start(f.repository, 'Reject this', ['implement']);
    await waitTask(runtime, rejected.id);
    runtime.decide(rejected.id, 0, false);
    assert.equal(runtime.store.get(rejected.id).status, 'cancelled');
    assert.throws(() => runtime.decide(rejected.id, 0, true), /stale/);
    assert.equal(runtime.store.get(rejected.id).stageResults.length, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('MCP checkpoint review requires a user elicitation response', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createServer: makeServer } = await import('../src/server.mjs');
  const f = await fixture();
  let modelCalls = 0;
  const provider = await mockProvider((_req, res) => {
    modelCalls++;
    reply(res, { content: 'Approved task finished.' });
  });
  const app = makeServer({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 2,
    maxConcurrent: 1, requireApproval: true });
  const client = new Client({ name: 'human-client', version: '1' },
    { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  let decision = true;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts++;
    assert.match(request.params.message, /Run stage 1/);
    return { action: 'accept', content: { approve: decision } };
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(left), client.connect(right)]);
    const task = await app.runtime.start(f.repository, 'Wait for user');
    await waitTask(app.runtime, task.id);
    assert.equal(modelCalls, 0);
    const approved = await client.callTool({ name: 'review_checkpoint',
      arguments: { taskId: task.id, stageIndex: 0 } });
    assert.ok(!approved.isError, JSON.stringify(approved));
    assert.equal(prompts, 1);
    assert.equal((await waitTask(app.runtime, task.id)).status, 'needs_review');
    assert.equal(modelCalls, 1);
    decision = false;
    const rejected = await app.runtime.start(f.repository, 'User rejects');
    await waitTask(app.runtime, rejected.id);
    await client.callTool({ name: 'review_checkpoint', arguments: { taskId: rejected.id, stageIndex: 0 } });
    assert.equal(app.runtime.store.get(rejected.id).status, 'cancelled');
    assert.equal(modelCalls, 1);
    const stale = await client.callTool({ name: 'review_checkpoint', arguments: { taskId: rejected.id, stageIndex: 0 } });
    assert.equal(stale.isError, true);
    assert.equal(prompts, 2);
  } finally {
    await client.close();
    await app.close();
    await provider.close();
    await f.remove();
  }
});

test('read-only BYOK stage rejects writes even if a provider requests them', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res, body) => {
    calls++;
    assert.deepEqual(body.tools.map(t => t.function.name), ['list_files', 'read_file']);
    if (calls === 1) reply(res, { tool_calls: [{
      id: 'forbidden', type: 'function',
      function: { name: 'write_file', arguments: '{"path":"answer.txt","content":"forbidden"}' }
    }] });
    else {
      assert.match(body.messages.at(-1).content, /read-only/);
      reply(res, { content: 'Reviewed without writing.' });
    }
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 2, maxConcurrent: 1,
    defaultAgent: 'reviewer', agents: { reviewer: { kind: 'byok', readOnly: true } } });
  try {
    const task = await runtime.start(f.repository, 'Review only');
    const result = await waitTask(runtime, task.id);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.summary, 'Reviewed without writing.');
    assert.equal(await readFile(join(result.workspace, 'answer.txt'), 'utf8'), 'before');
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('CLI profiles validate executable paths and apply read-only flags', async () => {
  const { normalizeAgents } = await import('../src/agent-config.mjs');
  const { cliArguments, cliSummary, agentCatalog, stagePlan } = await import('../src/agents.mjs');
  assert.throws(() => normalizeAgents({ agents: { bad: { kind: 'codex', command: ['codex.cmd'] } } }));
  assert.throws(() => normalizeAgents({ requireApproval: 'yes' }), /boolean/);
  assert.throws(() => normalizeAgents({ agents: { bad: { kind: 'byok', readOnly: 'yes' } } }), /boolean/);
  const config = normalizeAgents({ agents: {
    coder: { kind: 'codex', command: [process.execPath], apiKeyEnv: 'FAKE_KEY', readOnly: true },
    reviewer: { kind: 'claude', command: [process.execPath], readOnly: true }
  } }, { FAKE_KEY: 'fake-profile-secret' });
  assert.equal(config.requireApproval, true);
  assert.ok(!JSON.stringify(agentCatalog(config)).includes('fake-profile-secret'));
  assert.deepEqual(stagePlan(config, ['coder', 'reviewer']), [{ agent: 'coder' }, { agent: 'reviewer' }]);
  assert.throws(() => stagePlan(config, ['missing']));
  assert.ok(cliArguments(config.agents.coder, { maxSteps: 3 }).includes('read-only'));
  const claude = cliArguments(config.agents.reviewer, { maxSteps: 3 });
  assert.ok(claude.includes('plan'));
  assert.ok(!claude.includes('Read,Edit,Write,Glob,Grep'));
  assert.throws(() => cliSummary('codex', '{"type":"turn.failed"}'), /unsuccessful/);
  assert.throws(() => cliSummary('claude', '{"is_error":true,"result":"failed"}'), /unsuccessful/);
  assert.throws(() => cliSummary('codex', 'not json'));
});

test('CLI-only configuration does not require BYOK inference settings', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'cli-config.json');
    await writeFile(path, JSON.stringify({ repositories: [f.repository],
      stateDir: join(f.directory, 'state'), agents: {
        coder: { kind: 'codex', command: [process.execPath], apiKeyEnv: 'TEST_CODEX_KEY' }
      } }));
    const config = loadConfig({ BYOK_CONFIG: path, TEST_CODEX_KEY: 'fake-codex-key' });
    assert.equal(config.defaultAgent, 'coder');
    assert.deepEqual(config.secrets, ['fake-codex-key']);
    assert.equal(config.agents.coder.apiKey, 'fake-codex-key');
  } finally { await f.remove(); }
});

test('a paused task cannot silently switch to a removed agent profile', async () => {
  const f = await fixture();
  const config = { repositories: [f.repository], stateDir: join(f.directory, 'state'),
    checks: [], maxSteps: 1, maxConcurrent: 1, requireApproval: true,
    defaultAgent: 'coder', agents: { coder: { kind: 'byok' } } };
  const runtime = new Runtime(config);
  try {
    const task = await runtime.start(f.repository, 'Pause before executing');
    assert.equal((await waitTask(runtime, task.id)).status, 'awaiting_approval');
    delete config.agents.coder;
    assert.throws(() => runtime.decide(task.id, 0, true), /configured agents/);
    assert.equal(runtime.store.get(task.id).stageIndex, 0);
    assert.equal(runtime.cancel(task.id).status, 'cancelled');
  } finally {
    await runtime.close();
    await f.remove();
  }
});
