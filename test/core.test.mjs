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
    assert.equal((await client.listTools()).tools.length, 11);
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
