import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../src/core.mjs';
import { resumeTask } from '../src/recovery.mjs';

test('recovery preserves completed stages and requires a fresh stage approval', async () => {
  const directory = await mkdtemp(resolve('work/recovery-'));
  await mkdir(join(directory, 'repo'));
  const repository = await realpath(join(directory, 'repo'));
  const store = new Store(join(directory, 'state'));
  try {
    const created = store.create(repository, 'Continue this task');
    store.update(created.id, { status: 'interrupted', stages: [{ agent: 'byok' }, { agent: 'byok' }],
      stageIndex: 1, stageResults: [{ summary: 'First stage finished' }], approvedStage: 1 });
    const runtime = { store, config: { repositories: [repository], maxConcurrent: 1 },
      active: new Map(), launch(task) { this.launched = task; } };
    const resumed = await resumeTask(runtime, created.id);
    assert.equal(resumed.stageIndex, 1);
    assert.equal(resumed.stageResults[0].summary, 'First stage finished');
    assert.equal(resumed.approvedStage, null);
    assert.equal(resumed.recoveryCount, 1);
    assert.equal(runtime.launched.id, created.id);
    await assert.rejects(resumeTask(runtime, created.id), /interrupted/);
    store.update(created.id, { status: 'cancelled' });
    await assert.rejects(resumeTask(runtime, created.id), /interrupted/);
    assert.equal(store.events(created.id)[0].kind, 'recovery_requested');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recovery rejects repositories removed from configuration', async () => {
  const directory = await mkdtemp(resolve('work/recovery-'));
  const store = new Store(join(directory, 'state'));
  try {
    const created = store.create(directory, 'Wait');
    store.update(created.id, { status: 'interrupted', stages: [{ agent: 'byok' }] });
    const runtime = { store, config: { repositories: [], maxConcurrent: 1 }, active: new Map() };
    await assert.rejects(resumeTask(runtime, created.id), /no longer configured/);
    assert.equal(store.get(created.id).status, 'interrupted');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
