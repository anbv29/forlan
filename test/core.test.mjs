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
