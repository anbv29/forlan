import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { command } from '../src/workspace.mjs';

export async function repositoryFixture() {
  await mkdir(resolve('work'), { recursive: true });
  const directory = await mkdtemp(resolve('work/feature-test-'));
  await mkdir(join(directory, 'repository'));
  const repository = await realpath(join(directory, 'repository'));
  const git = async args => {
    const result = await command('git', args, repository);
    assert.equal(result.code, 0, result.output);
  };
  await git(['init', '--separate-git-dir', join(directory, 'metadata')]);
  await writeFile(join(repository, 'answer.txt'), 'Original answer\n');
  await git(['add', 'answer.txt']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test fixture']);
  return { directory, repository, git,
    config: { repositories: [repository], stateDir: join(directory, 'state'), checks: [],
      baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', maxSteps: 5, maxConcurrent: 2, automationTickMs: 0 },
    remove: () => rm(directory, { recursive: true, force: true }) };
}

export async function settled(runtime, id) {
  for (let i = 0; i < 500; i++) {
    if (!runtime.active.has(id)) return runtime.store.get(id);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Task did not settle.');
}

export function mockInference(t, handler) {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const message = await handler(JSON.parse(options.body), options.signal);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
}
