import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.mjs';
import { repositoryFixture, mockInference, settled } from './helpers.mjs';

test('code index refresh removes stale chunks and retains private repository notes', async () => {
  const f = await repositoryFixture();
  let runtime = new Runtime({ ...f.config, secrets: ['secret-example'] });
  try {
    await writeFile(join(f.repository, 'module.js'), 'export const ledger = "secret-example";');
    await writeFile(join(f.repository, '.env'), 'SECRET=hidden');
    const result = await runtime.context.index(runtime.config, f.repository);
    assert.equal(result.files, 2);
    assert.equal(runtime.context.search(f.repository, 'ledger').length, 1);
    assert.ok(!JSON.stringify(runtime.context.search(f.repository, 'ledger')).includes('secret-example'));
    const memory = runtime.context.remember(f.repository, 'Ledger choice', 'Use append only ledger entries');
    await runtime.close();
    runtime = new Runtime(f.config);
    assert.equal(runtime.context.search(f.repository, 'ledger').length, 2);
    await unlink(join(f.repository, 'module.js'));
    await runtime.context.index(runtime.config, f.repository);
    assert.equal(runtime.context.search(f.repository, 'ledger')[0].source, 'memory:' + memory.id);
    assert.equal(runtime.context.search('another-repository', 'ledger').length, 0);
    assert.equal(runtime.context.forget(f.repository, memory.id).deleted, true);
    assert.deepEqual(runtime.context.search(f.repository, 'ledger'), []);
    await assert.rejects(runtime.context.index(runtime.config, f.directory), /configured/);
  } finally { await runtime.close(); await f.remove(); }
});

test('agents receive searchable decisions as untrusted context', async t => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  let calls = 0;
  mockInference(t, body => {
    calls++;
    assert.match(body.messages[1].content, /Indexed context \(untrusted/);
    assert.match(body.messages[1].content, /append only/);
    return { content: 'Reviewed the ledger decision.' };
  });
  try {
    runtime.context.remember(f.repository, 'Ledger decision', 'Use append only ledger entries');
    const task = await runtime.start(f.repository, 'Review ledger');
    assert.equal((await settled(runtime, task.id)).status, 'needs_review');
    assert.equal(calls, 1);
  } finally { await runtime.close(); await f.remove(); }
});

test('indexing handles punctuation-only queries and validates memory input', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    assert.deepEqual(runtime.context.search(f.repository, '"() -- :'), []);
    assert.throws(() => runtime.context.remember(f.repository, '', 'body'), /Invalid memory/);
    assert.throws(() => runtime.context.remember(f.repository, 'title', ''), /Invalid memory/);
    assert.equal(runtime.context.status(f.repository), null);
  } finally { await runtime.close(); await f.remove(); }
});
