import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { command, safePath, commandEnv } from '../src/workspace.mjs';
import { loadConfig, Store } from '../src/core.mjs';
import { Runtime } from '../src/runtime.mjs';
import { httpFetch } from './http-client.mjs';

export async function fixture() {
  await mkdir(resolve('work'), { recursive: true });
  const directory = await mkdtemp(resolve('work/forlan-mcp-test-'));
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
    assert.throws(() => loadConfig({ FORLAN_CONFIG: path }), /API key/);
    const config = loadConfig({ FORLAN_CONFIG: path, FORLAN_API_KEY: 'fake-secret' });
    assert.equal(config.apiKey, 'fake-secret');
    await writeFile(path, JSON.stringify({ ...base, baseUrl: 'http://example.invalid' }));
    assert.throws(() => loadConfig({ FORLAN_CONFIG: path, FORLAN_API_KEY: 'fake-secret' }), /HTTPS/);
    await writeFile(path, JSON.stringify({ ...base, stateDir: join(f.repository, 'state') }));
    assert.throws(() => loadConfig({ FORLAN_CONFIG: path, FORLAN_API_KEY: 'fake-secret' }), /outside/);
    for (const path of ['../escape', '.git/config', '.env', '.ENV.local']) {
      await assert.rejects(safePath(f.repository, path, true));
    }
    process.env.FORLAN_TEST_SECRET = 'never-in-children';
    assert.equal(commandEnv().FORLAN_TEST_SECRET, undefined);
    delete process.env.FORLAN_TEST_SECRET;
  } finally { await f.remove(); }
});

test('SQLite preserves task state and event cursors across reopen', async () => {
  const f = await fixture();
  try {
    let store = new Store(join(f.directory, 'state'));
    const task = store.create(f.repository, 'Goal');
    store.update(task.id, { status: 'running' });
    store.event(task.id, 'tool', { name: 'read_file' });
    const first = store.events(task.id).at(-1);
    store.close();
    store = new Store(join(f.directory, 'state'));
    store.recover();
    assert.equal(store.get(task.id).status, 'interrupted');
    assert.equal(store.events(task.id, first.sequence)[0].detail.to, 'interrupted');
    assert.throws(() => store.get('missing'), /Unknown/);
    store.close();
  } finally { await f.remove(); }
});

export async function mockProvider(handler) {
  if (process.env.FORLAN_TEST_IN_PROCESS === '1') return (await import('./inprocess-provider.mjs')).inProcessProvider(handler);
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
    const fixtureTransport = await provider.childTransport?.();
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [...(fixtureTransport?.args ?? []), resolve('src/server.mjs')],
      env: { ...commandEnv(), ...fixtureTransport?.env, FORLAN_CONFIG: configPath, FORLAN_API_KEY: 'integration-fake-key' },
      stderr: 'pipe'
    });
    let diagnostics = '';
    transport.stderr?.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
    try { await client.connect(transport); }
    catch (error) { throw new Error(error.message + '\n' + diagnostics); }
  };
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('integration-fake-key'));
    return JSON.parse(result.content[0].text);
  };
  try {
    await connect();
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['start_task', 'review_checkpoint', 'get_task_diff', 'export_task_patch', 'get_usage_guide']) {
      assert.ok(names.includes(name), 'Missing workflow tool ' + name);
    }
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
    const config = loadConfig({ FORLAN_CONFIG: path, TEST_CODEX_KEY: 'fake-codex-key' });
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

test('project plans reject cycles and conflicting dependency versions', async () => {
  const { validatePlan, combineChanges, parsePlan } = await import('../src/plans.mjs');
  const config = { agents: { coder: { kind: 'byok' } } };
  const a = { key: 'a', goal: 'Build feature', agent: 'coder', dependsOn: [] };
  const b = { key: 'b', goal: 'Verify feature', agent: 'coder', dependsOn: ['a'] };
  assert.deepEqual(validatePlan({ nodes: [a, b] }, config).nodes, [a, b]);
  assert.throws(() => validatePlan({ nodes: [a, { ...b, key: 'a' }] }, config), /unique/);
  assert.throws(() => validatePlan({ nodes: [{ ...a, dependsOn: ['b'] }, b] }, config), /cycle/);
  assert.throws(() => validatePlan({ nodes: [{ ...a, dependsOn: ['missing'] }] }, config), /dependency/);
  assert.throws(() => validatePlan({ nodes: [{ ...a, agent: 'missing' }] }, config), /agent/);
  const parsed = parsePlan('{"nodes":[' + JSON.stringify(a) + ']}', config);
  assert.equal(parsed.nodes[0].key, 'a');
  assert.equal(combineChanges([{ 'a.txt': 'one' }, { 'a.txt': 'one', 'b.txt': null }])['b.txt'], null);
  assert.throws(() => combineChanges([{ 'a.txt': 'one' }, { 'a.txt': 'two' }]), /conflict/);
});

test('dependency snapshots transfer text edits and additions', async () => {
  const { captureChanges, applyChanges } = await import('../src/plans.mjs');
  const { createWorktree, git } = await import('../src/workspace.mjs');
  const f = await fixture();
  try {
    const config = { repositories: [f.repository], stateDir: join(f.directory, 'state') };
    const base = await git(['rev-parse', 'HEAD'], f.repository);
    const from = await createWorktree(config, { id: 'snapshot-from', repository: f.repository, baseRef: base });
    const to = await createWorktree(config, { id: 'snapshot-to', repository: f.repository, baseRef: base });
    await writeFile(join(from.workspace, 'answer.txt'), 'updated');
    await writeFile(join(from.workspace, 'new.txt'), 'new');
    const files = await captureChanges({ ...from, base });
    await applyChanges(to.workspace, files);
    assert.equal(await readFile(join(to.workspace, 'answer.txt'), 'utf8'), 'updated');
    assert.equal(await readFile(join(to.workspace, 'new.txt'), 'utf8'), 'new');
    await (await import('node:fs/promises')).unlink(join(from.workspace, 'answer.txt'));
    const removed = await captureChanges({ ...from, base });
    assert.equal(removed['answer.txt'], null);
    await applyChanges(to.workspace, removed);
    await assert.rejects(readFile(join(to.workspace, 'answer.txt')));
    assert.equal(await readFile(join(to.workspace, 'new.txt'), 'utf8'), 'new');
  } finally { await f.remove(); }
});

test('planned parallel tasks feed a dependent task and integrate into one review worktree', async () => {
  const { beginIntegration } = await import('../src/integration.mjs');
  const f = await fixture();
  const nodes = [
    { key: 'join', goal: 'JOIN', agent: 'byok', dependsOn: ['left', 'right'] },
    { key: 'left', goal: 'LEFT', agent: 'byok', dependsOn: [] },
    { key: 'right', goal: 'RIGHT', agent: 'byok', dependsOn: [] }
  ];
  const roots = new Set();
  let release;
  const bothRoots = new Promise(resolve => { release = resolve; });
  let peak = 0;
  let runtime;
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const provider = await mockProvider(async (_req, res, body) => {
    const goal = body.messages[1].content;
    const outputs = body.messages.filter(m => m.role === 'tool');
    if (goal.includes('split the goal')) {
      assert.ok(!body.tools.some(t => t.function.name === 'write_file'));
      reply(res, { content: JSON.stringify({ nodes }) });
      return;
    }
    if (goal.startsWith('LEFT') || goal.startsWith('RIGHT')) {
      const key = goal.startsWith('LEFT') ? 'left' : 'right';
      if (!outputs.length) {
        roots.add(key);
        peak = Math.max(peak, runtime.active.size);
        if (roots.size === 2) release();
        await Promise.race([bothRoots, new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('Independent tasks did not overlap.')), 5000))]);
        reply(res, { tool_calls: [call(key, 'write_file', { path: key + '.txt', content: key })] });
      } else reply(res, { content: key + ' complete' });
      return;
    }
    assert.ok(goal.startsWith('JOIN'));
    assert.ok(goal.includes('left complete') && goal.includes('right complete'));
    if (!outputs.length) reply(res, { tool_calls: [
      call('read-left', 'read_file', { path: 'left.txt' }),
      call('read-right', 'read_file', { path: 'right.txt' })
    ] });
    else if (outputs.length === 2) {
      assert.equal(JSON.parse(outputs[0].content), 'left');
      assert.equal(JSON.parse(outputs[1].content), 'right');
      reply(res, { tool_calls: [call('join', 'write_file', { path: 'combined.txt', content: 'left+right' })] });
    } else reply(res, { content: 'Combined both dependencies.' });
  });
  runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 4, maxConcurrent: 2 });
  const settle = async id => {
    for (let i = 0; i < 1000; i++) {
      const task = runtime.store.get(id);
      if (!['queued', 'running', 'orchestrating'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Project did not settle.');
  };
  try {
    const project = await runtime.projects.start(f.repository, 'Build a small feature');
    assert.equal((await waitTask(runtime, project.id)).status, 'awaiting_plan_approval');
    assert.equal(roots.size, 0);
    runtime.projects.decide(project.id, true);
    const finished = await settle(project.id);
    assert.equal(finished.status, 'needs_review', JSON.stringify(finished));
    assert.equal(peak, 2);
    assert.equal(finished.results.length, 3);
    const joined = runtime.store.get(finished.nodes.find(n => n.key === 'join').taskId);
    assert.equal(await readFile(join(joined.workspace, 'combined.txt'), 'utf8'), 'left+right');
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
    await assert.rejects(readFile(join(f.repository, 'combined.txt')));
    beginIntegration(runtime.projects, project.id);
    const integrated = await settle(project.id);
    assert.equal(integrated.phase, 'integrated', JSON.stringify(integrated));
    assert.equal(integrated.status, 'needs_review');
    assert.equal(await readFile(join(integrated.workspace, 'combined.txt'), 'utf8'), 'left+right');
    assert.deepEqual(integrated.integratedFiles.sort(), ['combined.txt', 'left.txt', 'right.txt']);
  } finally {
    await runtime.close();
    await provider.close();
    await f.remove();
  }
});

test('MCP project planning and integration require human approval forms', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createServer: makeServer } = await import('../src/server.mjs');
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res, body) => {
    calls++;
    reply(res, { content: body.messages[1].content.includes('split the goal') ?
      '{"nodes":[{"key":"code","goal":"Implement","agent":"byok","dependsOn":[]}]}' : 'Done.' });
  });
  const app = makeServer({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 2, maxConcurrent: 2, requireApproval: true });
  const client = new Client({ name: 'project-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let approved = false;
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    forms++;
    return { action: 'accept', content: { approve: approved } };
  });
  const invoke = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const [left, right] = InMemoryTransport.createLinkedPair();
  const settle = async id => {
    for (let i = 0; i < 600; i++) {
      const task = app.runtime.store.get(id);
      if (!['queued', 'running', 'orchestrating'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Project stalled.');
  };
  try {
    await Promise.all([app.server.connect(left), client.connect(right)]);
    const rejected = await invoke('plan_project', { repository: f.repository, goal: 'Reject plan' });
    await settle(rejected.id);
    assert.equal((await invoke('review_project_plan', { taskId: rejected.id })).status, 'cancelled');
    assert.equal(calls, 1);
    const project = await invoke('plan_project', { repository: f.repository, goal: 'Approve plan' });
    await settle(project.id);
    approved = true;
    await invoke('review_project_plan', { taskId: project.id });
    const child = app.runtime.store.get(project.id).nodes[0].taskId;
    assert.equal((await waitTask(app.runtime, child)).status, 'awaiting_approval');
    assert.equal(calls, 2);
    await invoke('review_checkpoint', { taskId: child, stageIndex: 0 });
    await settle(project.id);
    await invoke('integrate_project', { taskId: project.id });
    assert.equal((await settle(project.id)).phase, 'integrated');
    assert.equal(calls, 3);
    assert.equal(forms, 4);
  } finally { await client.close(); await app.close(); await provider.close(); await f.remove(); }
});

test('project integration reports conflicting edits without choosing a winner', async () => {
  const { beginIntegration } = await import('../src/integration.mjs');
  const f = await fixture();
  const nodes = ['first', 'second'].map(key => ({ key, goal: key, agent: 'byok', dependsOn: [] }));
  const provider = await mockProvider((_req, res, body) => {
    const goal = body.messages[1].content;
    if (goal.includes('split the goal')) reply(res, { content: JSON.stringify({ nodes }) });
    else if (!body.messages.some(m => m.role === 'tool')) reply(res, { tool_calls: [{
      id: 'edit', type: 'function', function: { name: 'write_file',
        arguments: JSON.stringify({ path: 'answer.txt', content: goal.startsWith('first') ? 'first' : 'second' }) }
    }] });
    else reply(res, { content: 'Changed answer.' });
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 2, maxConcurrent: 2 });
  const settle = async id => {
    for (let i = 0; i < 600; i++) {
      const p = runtime.store.get(id);
      if (!['queued', 'running', 'orchestrating'].includes(p.status)) return p;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Project stalled.');
  };
  try {
    const p = await runtime.projects.start(f.repository, 'Conflicting work');
    await settle(p.id);
    runtime.projects.decide(p.id, true);
    assert.equal((await settle(p.id)).status, 'needs_review');
    beginIntegration(runtime.projects, p.id);
    const final = await settle(p.id);
    assert.equal(final.status, 'integration_conflict');
    assert.match(final.error, /answer.txt/);
    assert.equal(await readFile(join(final.workspace, 'answer.txt'), 'utf8'), 'before');
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

function seedProject(runtime, repository, nodes) {
  const project = runtime.store.create(repository, 'Synthetic scheduler project');
  const children = nodes.map(node => {
    const task = runtime.store.create(repository, node.key);
    runtime.store.update(task.id, { projectId: project.id, status: node.status,
      stages: [{ agent: 'byok' }], stageIndex: 0, stageResults: [] });
    return { key: node.key, goal: node.key, agent: 'byok', dependsOn: node.dependsOn, taskId: task.id };
  });
  return runtime.store.update(project.id, { kind: 'project', phase: 'execution',
    status: 'orchestrating', nodes: children });
}

test('failed dependencies block reverse-ordered descendants and cancellation stops queued nodes', async () => {
  const f = await fixture();
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    checks: [], maxSteps: 1, maxConcurrent: 2 });
  try {
    const project = seedProject(runtime, f.repository, [
      { key: 'leaf', dependsOn: ['middle'], status: 'waiting_dependency' },
      { key: 'middle', dependsOn: ['root'], status: 'waiting_dependency' },
      { key: 'root', dependsOn: [], status: 'failed' }
    ]);
    runtime.projects.pump();
    const result = runtime.store.get(project.id);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.results.map(n => n.status), ['blocked', 'blocked', 'failed']);
    assert.equal(runtime.store.events(project.id).filter(e => e.kind === 'node_blocked').length, 2);
    assert.equal(runtime.active.size, 0);
    const pending = seedProject(runtime, f.repository, [
      { key: 'waiting', dependsOn: [], status: 'waiting_dependency' },
      { key: 'approval', dependsOn: [], status: 'awaiting_approval' }
    ]);
    runtime.cancel(pending.id);
    assert.equal(runtime.store.get(pending.id).status, 'cancelled');
    for (const node of pending.nodes) assert.equal(runtime.store.get(node.taskId).status, 'cancelled');
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('restarting projects requires explicit resume and never reruns interrupted children', async () => {
  const { resumeProject } = await import('../src/scheduler.mjs');
  const f = await fixture();
  const config = { repositories: [f.repository], stateDir: join(f.directory, 'state'),
    checks: [], maxSteps: 1, maxConcurrent: 2 };
  let runtime = new Runtime(config);
  try {
    const paused = seedProject(runtime, f.repository, [
      { key: 'approval', dependsOn: [], status: 'awaiting_approval' }
    ]);
    await runtime.close();
    runtime = new Runtime(config);
    assert.equal(runtime.store.get(paused.id).status, 'paused_project');
    assert.equal(runtime.store.get(paused.nodes[0].taskId).status, 'awaiting_approval');
    assert.equal(runtime.active.size, 0);
    assert.equal(resumeProject(runtime.projects, paused.id).status, 'orchestrating');
    assert.equal(runtime.active.size, 0);
    runtime.cancel(paused.id);
    const interrupted = seedProject(runtime, f.repository, [
      { key: 'interrupted', dependsOn: [], status: 'running' }
    ]);
    await runtime.close();
    runtime = new Runtime(config);
    assert.equal(runtime.store.get(interrupted.nodes[0].taskId).status, 'interrupted');
    assert.throws(() => resumeProject(runtime.projects, interrupted.id), /interrupted/);
    assert.equal(runtime.store.get(interrupted.id).status, 'paused_project');
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('invalid generated plans fail without launching children and storage rolls back atomically', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res) => {
    calls++;
    reply(res, { content: '{"nodes":[{"key":"cycle","goal":"Invalid","agent":"byok","dependsOn":["cycle"]}]}' });
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 2 });
  try {
    assert.throws(() => runtime.store.transaction(() => {
      runtime.store.create(f.repository, 'Rollback');
      throw new Error('Abort transaction');
    }), /Abort transaction/);
    assert.equal(runtime.store.list().length, 0);
    const project = await runtime.projects.start(f.repository, 'Invalid decomposition');
    const result = await waitTask(runtime, project.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /dependency/);
    assert.equal(result.kind, 'project');
    assert.ok(result.workspace);
    assert.equal(runtime.store.list().length, 1);
    assert.equal(calls, 1);
    assert.equal(runtime.active.size, 0);
  } finally {
    await runtime.close();
    await provider.close();
    await f.remove();
  }
});

test('three-way integration combines independent edits and refuses overlapping decisions', async () => {
  const { mergeSnapshots } = await import('../src/merge.mjs');
  const { git, createWorktree } = await import('../src/workspace.mjs');
  const f = await fixture();
  try {
    const base = 'alpha\none\ntwo\nthree\nfour\nfive\nomega\n';
    await writeFile(join(f.repository, 'answer.txt'), base);
    await git(['add', '.'], f.repository);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'multiline base'], f.repository);
    const config = { repositories: [f.repository], stateDir: join(f.directory, 'state') };
    const task = await createWorktree(config, { id: 'merge-test', repository: f.repository });
    const left = base.replace('alpha', 'LEFT');
    const right = base.replace('omega', 'RIGHT');
    const merged = await mergeSnapshots(config, task, [{ 'answer.txt': left }, { 'answer.txt': right }]);
    assert.equal(merged.files['answer.txt'], base.replace('alpha', 'LEFT').replace('omega', 'RIGHT'));
    assert.deepEqual(merged.resolvedFiles, ['answer.txt']);
    await assert.rejects(mergeSnapshots(config, task,
      [{ 'answer.txt': left }, { 'answer.txt': base.replace('alpha', 'OTHER') }]), /Dependency conflict/);
    const deletion = await mergeSnapshots(config, task, [{ 'answer.txt': null }, { 'answer.txt': base }]);
    assert.equal(deletion.files['answer.txt'], null);
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), base);
  } finally { await f.remove(); }
});

test('automation schedules handle intervals timezone dates and daylight-saving repetitions', async () => {
  const { normalizeTrigger, nextOccurrence, occurrenceDate } = await import('../src/schedules.mjs');
  const now = Date.parse('2026-10-30T00:00:00Z');
  const interval = normalizeTrigger({ type: 'interval', everySeconds: 60 }, now);
  assert.equal(nextOccurrence(interval, now), '2026-10-30T00:01:00.000Z');
  assert.equal(nextOccurrence(interval, now + 185000), '2026-10-30T00:04:00.000Z');
  const daily = normalizeTrigger({ type: 'daily', time: '09:00', timeZone: 'Asia/Kolkata' }, now);
  assert.equal(nextOccurrence(daily, now), '2026-10-30T03:30:00.000Z');
  assert.equal(occurrenceDate(daily, now), '2026-10-30');
  const fallBack = normalizeTrigger({ type: 'daily', time: '01:30', timeZone: 'America/New_York' }, now);
  assert.equal(nextOccurrence(fallBack, Date.parse('2026-11-01T05:31:00Z'), '2026-11-01'), '2026-11-02T06:30:00.000Z');
  assert.throws(() => normalizeTrigger({ type: 'interval', everySeconds: 1 }, now), /Interval/);
  assert.throws(() => normalizeTrigger({ type: 'once', at: '2026-10-29T00:00:00Z' }, now), /future/);
  assert.throws(() => normalizeTrigger({ type: 'once', at: '2026-10-31 09:00' }, now), /timezone/);
  assert.throws(() => normalizeTrigger({ type: 'event', eventType: '../command' }, now), /event type/);
  assert.throws(() => normalizeTrigger({ type: 'daily', time: '25:00', timeZone: 'UTC' }, now));
  assert.throws(() => normalizeTrigger({ type: 'daily', time: '09:00', timeZone: 'not-a-zone' }, now));
  const once = normalizeTrigger({ type: 'once', at: '2026-10-31T09:00:00+05:30' }, now);
  assert.equal(nextOccurrence(once, now), '2026-10-31T03:30:00.000Z');
  assert.equal(nextOccurrence(once, Date.parse(once.at)), null);
  assert.equal(nextOccurrence({ type: 'event' }, now), null);
  const spring = normalizeTrigger({ type: 'daily', time: '02:30', timeZone: 'America/New_York' }, now);
  assert.equal(nextOccurrence(spring, Date.parse('2027-03-14T00:00:00Z')), '2027-03-15T06:30:00.000Z');
  const midnight = normalizeTrigger({ type: 'daily', time: '00:00', timeZone: 'UTC' }, now);
  assert.equal(nextOccurrence(midnight, now), '2026-10-31T00:00:00.000Z');
  const anchored = normalizeTrigger({ type: 'interval', everySeconds: 3600,
    startAt: '2026-10-31T10:00:00Z' }, now);
  assert.equal(nextOccurrence(anchored, now), '2026-10-31T10:00:00.000Z');
  assert.deepEqual(normalizeTrigger({ type: 'event', eventType: 'github.push' }), { type: 'event', eventType: 'github.push' });
  assert.throws(() => normalizeTrigger({ type: 'interval', everySeconds: 60.5 }, now));
  assert.throws(() => normalizeTrigger({ type: 'unknown' }, now));
  assert.throws(() => normalizeTrigger(null, now));
});

test('automation storage reserves occurrences once and retains receipts across restart', async () => {
  const { AutomationStore } = await import('../src/automation-store.mjs');
  const f = await fixture();
  let store = new Store(join(f.directory, 'automation-state'), ['fake-private-key']);
  try {
    let db = new AutomationStore(store);
    const rule = db.create({ name: 'test', goal: 'fake-private-key', repository: f.repository });
    assert.equal(rule.enabled, false);
    assert.ok(!rule.goal.includes('fake-private-key'));
    const first = db.reserve(rule.id, 'occurrence-1', { payload: { secret: 'fake-private-key' } });
    assert.equal(db.reserve(rule.id, 'occurrence-1').id, first.id);
    assert.equal(db.queuedCount(), 1);
    db.recordEvent('event-1', 'digest');
    db.disable(rule.id);
    assert.equal(db.run(first.id).status, 'cancelled');
    assert.equal(db.queuedCount(), 0);
    store.close();
    store = new Store(join(f.directory, 'automation-state'));
    db = new AutomationStore(store);
    assert.equal(db.eventDigest('event-1'), 'digest');
    assert.equal(db.reserve(rule.id, 'occurrence-1').id, first.id);
    assert.equal(db.runs(rule.id).length, 1);
    assert.ok(!JSON.stringify(db.runs(rule.id)).includes('fake-private-key'));
  } finally { store.close(); await f.remove(); }
});

test('scheduled and named-event automations create fixed-goal tasks once', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res, body) => {
    calls++;
    assert.ok(body.messages[1].content.includes('fixed-goal'));
    assert.ok(!body.messages[1].content.includes('override-instructions'));
    reply(res, { content: 'Automation completed.' });
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 0 });
  let now = Date.parse('2026-10-30T00:00:00Z');
  const engine = runtime.automations;
  engine.clock = () => now;
  try {
    const rule = await engine.create({ name: 'scheduled', repository: f.repository, goal: 'fixed-goal',
      trigger: { type: 'interval', everySeconds: 60 } });
    engine.tick();
    assert.equal(engine.get(rule.id).runs.length, 0);
    engine.enable(rule.id);
    now += 60000;
    engine.tick();
    const first = engine.get(rule.id).runs[0];
    const firstTask = engine.store.run(first.id).taskId;
    assert.equal((await waitTask(runtime, firstTask)).status, 'needs_review');
    engine.tick();
    assert.equal(engine.get(rule.id).runs.length, 1);
    assert.equal(calls, 1);
    engine.disable(rule.id);
    const eventRule = await engine.create({ name: 'event', repository: f.repository, goal: 'fixed-goal',
      trigger: { type: 'event', eventType: 'build.changed' } });
    engine.enable(eventRule.id);
    const event = { id: 'delivery-1', type: 'build.changed', payload: { instruction: 'override-instructions' } };
    const receipt = engine.event(event);
    const eventTask = engine.store.run(receipt.runs[0].id).taskId;
    assert.equal((await waitTask(runtime, eventTask)).status, 'needs_review');
    assert.equal(engine.event(event).duplicate, true);
    assert.throws(() => engine.event({ ...event, payload: { different: true } }), /different content/);
    assert.equal(calls, 2);
    engine.disable(eventRule.id);
    assert.equal(engine.event({ ...event, id: 'delivery-2' }).runs.length, 0);
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('local event endpoint authenticates deduplicates and bounds requests', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res) => { calls++; reply(res, { content: 'Webhook completed.' }); });
  const token = 'test-webhook-token-'.repeat(3);
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1,
    automationTickMs: 0, automationWebhook: { port: 0, token } });
  try {
    const engine = runtime.automations;
    await engine.listener.ready;
    const fetch = httpFetch(engine.listener.server);
    const url = 'http://127.0.0.1:' + engine.listener.status().port + '/events';
    const rule = await engine.create({ name: 'webhook', repository: f.repository, goal: 'Fixed task',
      trigger: { type: 'event', eventType: 'webhook.changed' } });
    engine.enable(rule.id);
    const event = { id: 'http-event-1', type: 'webhook.changed', payload: {} };
    const send = (headers, body = event) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await send({})).status, 401);
    assert.equal((await send({ Authorization: 'Bearer wrong' })).status, 401);
    const headers = { Authorization: 'Bearer ' + token };
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await send(headers, { ...event, payload: { large: 'x'.repeat(70000) } })).status, 413);
    assert.equal((await send(headers)).status, 202);
    const taskId = engine.get(rule.id).runs[0].taskId;
    assert.equal((await waitTask(runtime, taskId)).status, 'needs_review');
    const duplicate = await send(headers);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal((await send(headers, { ...event, payload: { changed: true } })).status, 400);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(engine.health()).includes(token));
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('MCP automation enablement requires human approval and honors task checkpoints', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createServer: makeServer } = await import('../src/server.mjs');
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res) => { calls++; reply(res, { content: 'Approved automation task.' }); });
  const app = makeServer({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1,
    requireApproval: true, automationTickMs: 0 });
  const client = new Client({ name: 'automation-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let approve = false;
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => { forms++; return { action: 'accept', content: { approve } }; });
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(left), client.connect(right)]);
    const draft = await invoke('create_automation', { name: 'Approved rule', repository: f.repository,
      goal: 'Fixed instructions', trigger: { type: 'event', eventType: 'manual.changed' } });
    assert.equal(draft.enabled, false);
    assert.equal((await invoke('review_automation', { automationId: draft.id })).enabled, false);
    assert.equal((await invoke('trigger_event', { eventId: 'before-approval', type: 'manual.changed' })).runs.length, 0);
    approve = true;
    assert.equal((await invoke('review_automation', { automationId: draft.id })).enabled, true);
    await invoke('trigger_event', { eventId: 'after-approval', type: 'manual.changed' });
    const run = (await invoke('get_automation', { automationId: draft.id })).runs[0];
    assert.equal((await waitTask(app.runtime, run.taskId)).status, 'awaiting_approval');
    assert.equal(calls, 0);
    await invoke('review_checkpoint', { taskId: run.taskId, stageIndex: 0 });
    assert.equal((await waitTask(app.runtime, run.taskId)).status, 'needs_review');
    assert.equal(calls, 1);
    assert.equal(forms, 3);
    assert.equal((await invoke('list_automations')).automations.length, 1);
    assert.equal((await invoke('disable_automation', { automationId: draft.id })).enabled, false);
  } finally { await client.close(); await app.close(); await provider.close(); await f.remove(); }
});

test('webhook configuration requires a strong environment token and a valid port', async () => {
  const { webhookConfig } = await import('../src/event-listener.mjs');
  assert.equal(webhookConfig(undefined, {}), undefined);
  assert.throws(() => webhookConfig({ port: 0 }, {}), /token/);
  assert.throws(() => webhookConfig({ port: 70000 }, {}), /port/);
  assert.throws(() => webhookConfig({ port: 0, tokenEnv: 'INVALID-NAME' }, {}), /token/);
  assert.throws(() => webhookConfig({ port: 0 }, { AUTOMATION_EVENT_TOKEN: 'short' }), /token/);
  const token = 'valid-private-token-'.repeat(3);
  const config = webhookConfig({ port: 0 }, { AUTOMATION_EVENT_TOKEN: token });
  assert.equal(config.port, 0);
  assert.equal(config.token, token);
});

async function seedConflictProject(runtime, repository) {
  const { createWorktree } = await import('../src/workspace.mjs');
  const project = runtime.store.create(repository, 'Resolve combined feature changes');
  const workspace = await createWorktree(runtime.config, { ...project, repository });
  const nodes = [];
  for (const side of ['left', 'right']) {
    const child = runtime.store.create(repository, side);
    const childWorkspace = await createWorktree(runtime.config, { ...child, repository });
    await writeFile(join(childWorkspace.workspace, 'answer.txt'), side);
    runtime.store.update(child.id, { ...childWorkspace, status: 'needs_review' });
    nodes.push({ key: side, taskId: child.id, dependsOn: [] });
  }
  return runtime.store.update(project.id, { ...workspace, kind: 'project', phase: 'execution',
    status: 'needs_review', nodes });
}

test('overlapping conflict resolution needs human approval and produces a verified review candidate', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createServer: makeServer } = await import('../src/server.mjs');
  const { beginIntegration } = await import('../src/integration.mjs');
  const f = await fixture();
  let calls = 0;
  const call = (name, args) => ({ id: 'call-' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const provider = await mockProvider((_req, res, body) => {
    calls++;
    assert.ok(body.messages[1].content.includes('Conflict versions'));
    if (calls === 1) reply(res, { tool_calls: [call('write_file', { path: 'unapproved.txt', content: 'not allowed' })] });
    else if (calls === 2) {
      assert.match(body.messages.at(-1).content, /approved conflict set/);
      reply(res, { tool_calls: [call('read_file', { path: 'answer.txt' })] });
    } else if (calls === 3) {
      assert.match(body.messages.at(-1).content, /FORLAN_OURS/);
      reply(res, { tool_calls: [call('write_file', { path: 'answer.txt', content: 'resolved both intents' })] });
    } else reply(res, { content: 'Resolved both task versions; review the combined intent.' });
  });
  const app = makeServer({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', maxSteps: 4, maxConcurrent: 1, automationTickMs: 0,
    checks: [[process.execPath, '-e', "if(require('fs').readFileSync('answer.txt','utf8')!=='resolved both intents')process.exit(1)"]] });
  const client = new Client({ name: 'resolver-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let approve = false;
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { approve } }));
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(left), client.connect(right)]);
    const project = await seedConflictProject(app.runtime, f.repository);
    beginIntegration(app.runtime.projects, project.id);
    assert.equal((await waitTask(app.runtime, project.id)).status, 'integration_conflict');
    const args = { name: 'resolve_project_conflicts', arguments: { taskId: project.id } };
    await client.callTool(args);
    assert.equal(calls, 0);
    approve = true;
    const result = await client.callTool(args);
    assert.ok(!result.isError, JSON.stringify(result));
    const resolved = await waitTask(app.runtime, project.id);
    assert.equal(resolved.status, 'needs_review', JSON.stringify(resolved));
    assert.equal(resolved.checks.passed, true);
    assert.equal(resolved.conflictResolution.status, 'proposed_for_review');
    assert.equal(await readFile(join(resolved.workspace, 'answer.txt'), 'utf8'), 'resolved both intents');
    await assert.rejects(readFile(join(resolved.workspace, 'unapproved.txt')));
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
  } finally { await client.close(); await app.close(); await provider.close(); await f.remove(); }
});

test('automation coalesces missed schedules prevents overlap and preserves interrupted-run history', async () => {
  const f = await fixture();
  let calls = 0, arrived, release;
  const started = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const provider = await mockProvider(async (_req, res) => {
    calls++; arrived(); await gate; reply(res, { content: 'Scheduled run finished.' });
  });
  const config = { repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 0 };
  let runtime = new Runtime(config);
  let now = Date.parse('2026-10-30T00:00:00Z');
  try {
    runtime.automations.clock = () => now;
    const rule = await runtime.automations.create({ name: 'No overlap', repository: f.repository, goal: 'Fixed task',
      trigger: { type: 'interval', everySeconds: 60 } });
    runtime.automations.enable(rule.id);
    now += 60000;
    runtime.automations.tick();
    await started;
    now += 600000;
    runtime.automations.tick();
    let runs = runtime.automations.get(rule.id).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'skipped');
    assert.equal(calls, 1);
    runtime.automations.disable(rule.id);
    assert.equal(runtime.active.size, 1);
    release();
    const active = runs.find(run => run.taskId);
    assert.equal((await waitTask(runtime, active.taskId)).status, 'needs_review');
    runtime.automations.tick();
    const reserved = runtime.automations.store.reserve(rule.id, 'crash-window');
    const interrupted = runtime.store.create(f.repository, 'Do not rerun');
    runtime.store.update(interrupted.id, { automationId: rule.id });
    runtime.automations.store.updateRun(reserved.id, { status: 'started', taskId: interrupted.id });
    await runtime.close();
    runtime = new Runtime(config);
    runtime.automations.clock = () => now;
    runtime.automations.tick();
    assert.equal(runtime.automations.store.run(reserved.id).status, 'interrupted');
    assert.equal(runtime.store.get(interrupted.id).status, 'interrupted');
    assert.equal(runtime.active.size, 0);
    assert.equal(calls, 1);
    runs = runtime.automations.get(rule.id).runs;
    assert.equal(runs.length, 3);
  } finally { release(); await runtime.close(); await provider.close(); await f.remove(); }
});

test('resolver cannot claim success while conflict markers remain', async () => {
  const { beginIntegration } = await import('../src/integration.mjs');
  const { beginResolution } = await import('../src/resolution.mjs');
  const f = await fixture();
  const provider = await mockProvider((_req, res) => reply(res, { content: 'Claimed resolution without editing.' }));
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 0 });
  try {
    const project = await seedConflictProject(runtime, f.repository);
    beginIntegration(runtime.projects, project.id);
    assert.equal((await waitTask(runtime, project.id)).status, 'integration_conflict');
    beginResolution(runtime.projects, project.id);
    const failed = await waitTask(runtime, project.id);
    assert.equal(failed.status, 'integration_conflict');
    assert.match(failed.error, /conflict markers/);
    assert.match(await readFile(join(failed.failedResolutionCandidate.workspace, 'answer.txt'), 'utf8'), /FORLAN_OURS/);
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'before');
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('internal task events trigger approved rules without self-triggering automation loops', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res, body) => {
    calls++;
    if (calls === 2) assert.match(body.messages[1].content, /Event payload \(untrusted data/);
    reply(res, { content: 'Task ready.' });
  });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 0 });
  try {
    const rule = await runtime.automations.create({ name: 'Follow-up', repository: f.repository,
      goal: 'Review the task result', includeEventPayload: true,
      trigger: { type: 'event', eventType: 'task.ready_for_review' } });
    runtime.automations.enable(rule.id);
    const source = await runtime.start(f.repository, 'Source task');
    await waitTask(runtime, source.id);
    let run;
    for (let i = 0; i < 100; i++) {
      run = runtime.automations.get(rule.id).runs[0];
      if (run?.taskId) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(run?.taskId);
    assert.equal((await waitTask(runtime, run.taskId)).status, 'needs_review');
    runtime.automations.tick();
    assert.equal(runtime.automations.get(rule.id).runs.length, 1);
    assert.equal(calls, 2);
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('background automation polling fires an approved one-off schedule once', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = await mockProvider((_req, res) => { calls++; reply(res, { content: 'One-off completed.' }); });
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    baseUrl: provider.baseUrl, model: 'mock', checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 20 });
  let now = Date.parse('2026-10-30T00:00:00Z');
  try {
    runtime.automations.clock = () => now;
    const rule = await runtime.automations.create({ name: 'Once', repository: f.repository, goal: 'Run once',
      trigger: { type: 'once', at: '2026-10-30T00:01:00Z' } });
    runtime.automations.enable(rule.id);
    now += 60000;
    let run;
    for (let i = 0; i < 200; i++) {
      run = runtime.automations.get(rule.id).runs[0];
      if (run?.taskId) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(run?.taskId);
    assert.equal((await waitTask(runtime, run.taskId)).status, 'needs_review');
    now += 600000;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls, 1);
    assert.equal(runtime.automations.get(rule.id).runs.length, 1);
    assert.equal(runtime.automations.store.get(rule.id).nextAt, null);
    assert.equal(runtime.automations.health().error, null);
  } finally { await runtime.close(); await provider.close(); await f.remove(); }
});

test('automation boundaries reject unconfigured targets malformed events and oversized payloads', async () => {
  const f = await fixture();
  const runtime = new Runtime({ repositories: [f.repository], stateDir: join(f.directory, 'state'),
    checks: [], maxSteps: 1, maxConcurrent: 1, automationTickMs: 0 });
  const base = { name: 'Boundary', repository: f.repository, goal: 'Fixed',
    trigger: { type: 'event', eventType: 'valid.event' } };
  try {
    await assert.rejects(runtime.automations.create({ ...base, repository: f.directory }), /configured/);
    await assert.rejects(runtime.automations.create({ ...base, agents: ['unknown'] }), /configured/);
    await assert.rejects(runtime.automations.create({ ...base, includeEventPayload: 'yes' }), /boolean/);
    assert.throws(() => runtime.automations.event({ id: '../bad', type: 'valid.event' }), /event id/);
    assert.throws(() => runtime.automations.event({ id: 'large', type: 'valid.event',
      payload: { text: 'x'.repeat(9000) } }), /8 KB/);
    assert.equal(runtime.automations.list().length, 0);
    assert.equal(runtime.automations.health().queuedRuns, 0);
  } finally { await runtime.close(); await f.remove(); }
});
