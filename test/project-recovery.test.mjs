import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.mjs';
import { createWorktree } from '../src/workspace.mjs';
import { resumeTask } from '../src/recovery.mjs';
import { repositoryFixture, mockInference, settled } from './helpers.mjs';

test('interrupted planning reuses its worktree and still waits for plan approval', async t => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  let calls = 0;
  mockInference(t, () => {
    calls++;
    return { content: JSON.stringify({ nodes: [{ key: 'one', goal: 'Implement', agent: 'byok', dependsOn: [] }] }) };
  });
  try {
    const task = runtime.store.create(f.repository, 'Plan a feature');
    const worktree = await createWorktree(f.config, task);
    runtime.store.update(task.id, { ...worktree, kind: 'project', phase: 'planning', status: 'interrupted',
      stages: [{ agent: 'byok' }], stageIndex: 0, stageResults: [] });
    await resumeTask(runtime, task.id);
    const planned = await settled(runtime, task.id);
    assert.equal(planned.status, 'awaiting_plan_approval', planned.error);
    assert.equal(planned.workspace, worktree.workspace);
    assert.equal(planned.nodes.length, 1);
    assert.equal(planned.nodes[0].taskId, undefined);
    assert.equal(calls, 1);
    assert.equal(runtime.store.list().length, 1);
  } finally { await runtime.close(); await f.remove(); }
});

test('interrupted integration retries in a new candidate and preserves the abandoned attempt', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const task = runtime.store.create(f.repository, 'Integrate feature');
    const worktree = await createWorktree(f.config, task);
    const child = runtime.store.create(f.repository, 'Child feature');
    const childTree = await createWorktree(f.config, child);
    await writeFile(join(childTree.workspace, 'answer.txt'), 'Finished feature');
    runtime.store.update(child.id, { ...childTree, status: 'needs_review' });
    const abandoned = await createWorktree(f.config, { id: 'abandoned-integration', repository: f.repository });
    await writeFile(join(abandoned.workspace, 'answer.txt'), 'Partial old integration');
    runtime.store.update(task.id, { ...worktree, kind: 'project', phase: 'integration', status: 'interrupted',
      integrationCandidate: abandoned, stages: [{ agent: 'byok' }], stageIndex: 0,
      nodes: [{ key: 'one', taskId: child.id, dependsOn: [] }] });
    await resumeTask(runtime, task.id);
    const integrated = await settled(runtime, task.id);
    assert.equal(integrated.status, 'needs_review', integrated.error);
    assert.equal(integrated.phase, 'integrated');
    assert.notEqual(integrated.workspace, abandoned.workspace);
    assert.notEqual(integrated.workspace, worktree.workspace);
    assert.equal(await readFile(join(integrated.workspace, 'answer.txt'), 'utf8'), 'Finished feature');
    assert.equal(await readFile(join(abandoned.workspace, 'answer.txt'), 'utf8'), 'Partial old integration');
    assert.equal(await readFile(join(worktree.workspace, 'answer.txt'), 'utf8'), 'Original answer\n');
    assert.equal(integrated.checks.configured, false);
    assert.equal(integrated.checks.passed, false);
    assert.equal(integrated.recoveryCount, 1);
  } finally { await runtime.close(); await f.remove(); }
});

test('recovery rejects project phases that require queue coordination', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const task = runtime.store.create(f.repository, 'Coordinate children');
    runtime.store.update(task.id, { kind: 'project', phase: 'execution', status: 'interrupted',
      stages: [{ agent: 'byok' }], stageIndex: 0, nodes: [] });
    await assert.rejects(resumeTask(runtime, task.id), /interrupted task or project operation/);
    assert.equal(runtime.active.size, 0);
    assert.equal(runtime.store.get(task.id).status, 'interrupted');
  } finally { await runtime.close(); await f.remove(); }
});
