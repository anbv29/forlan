import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResolutions } from '../src/conflict-review.mjs';
import { conflictDetails } from '../src/conflict-review.mjs';
import { Runtime } from '../src/runtime.mjs';
import { createWorktree } from '../src/workspace.mjs';
import { beginIntegration } from '../src/integration.mjs';
import { beginResolution } from '../src/resolution.mjs';
import { repositoryFixture, settled, mockInference } from './helpers.mjs';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

async function conflictFixture(runtime, repository, deletion = false) {
  const project = runtime.store.create(repository, 'Combine answers');
  const worktree = await createWorktree(runtime.config, project);
  const nodes = [];
  for (const side of ['left', 'right']) {
    const child = runtime.store.create(repository, side);
    const branch = await createWorktree(runtime.config, child);
    if (deletion && side === 'left') await unlink(join(branch.workspace, 'answer.txt'));
    else await writeFile(join(branch.workspace, 'answer.txt'), side);
    runtime.store.update(child.id, { ...branch, status: 'needs_review' });
    nodes.push({ key: side, taskId: child.id, dependsOn: [] });
  }
  runtime.store.update(project.id, { ...worktree, nodes, kind: 'project', phase: 'execution', status: 'needs_review' });
  beginIntegration(runtime.projects, project.id);
  assert.equal((await settled(runtime, project.id)).status, 'integration_conflict');
  return runtime.store.get(project.id);
}

test('failed agent candidates preserve the clean project and can be retried', async t => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  mockInference(t, () => ({ content: 'Pretend conflicts are resolved' }));
  try {
    const project = await conflictFixture(runtime, f.repository);
    beginResolution(runtime.projects, project.id);
    const failed = await settled(runtime, project.id);
    assert.equal(failed.status, 'integration_conflict');
    assert.match(failed.error, /markers/);
    assert.equal(failed.workspace, project.workspace);
    assert.notEqual(failed.failedResolutionCandidate.workspace, project.workspace);
    assert.match(await readFile(join(failed.failedResolutionCandidate.workspace, 'answer.txt'), 'utf8'), /FORLAN_OURS/);
    assert.equal(await readFile(join(project.workspace, 'answer.txt'), 'utf8'), 'Original answer\n');
    assert.ok((await conflictDetails(runtime, project.id)).conflicts.length);
    beginResolution(runtime.projects, project.id);
    assert.equal((await settled(runtime, project.id)).status, 'integration_conflict');
  } finally { await runtime.close(); await f.remove(); }
});

test('approved delete conflict creates a checked isolated candidate without inference', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const project = await conflictFixture(runtime, f.repository, true);
    const details = await conflictDetails(runtime, project.id);
    assert.equal(details.conflicts[0].ours, null);
    const task = runtime.store.update(project.id, { phase: 'resolution', status: 'queued',
      resolutionDecisions: { 'answer.txt': null }, resolutionRevision: details.revision });
    runtime.launch(task);
    const resolved = await settled(runtime, task.id);
    assert.equal(resolved.status, 'needs_review', resolved.error);
    assert.equal(resolved.conflictResolution.agent, 'human');
    await assert.rejects(readFile(join(resolved.workspace, 'answer.txt')), /ENOENT/);
    assert.equal(await readFile(join(project.workspace, 'answer.txt'), 'utf8'), 'Original answer\n');
    assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'Original answer\n');
  } finally { await runtime.close(); await f.remove(); }
});

test('a stale conflict decision cannot change the original review worktree', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const project = await conflictFixture(runtime, f.repository);
    const details = await conflictDetails(runtime, project.id);
    await writeFile(join(runtime.store.get(project.nodes[0].taskId).workspace, 'answer.txt'), 'new intent');
    const changed = await conflictDetails(runtime, project.id);
    assert.notEqual(changed.revision, details.revision);
    const task = runtime.store.update(project.id, { phase: 'resolution', status: 'queued',
      resolutionDecisions: { 'answer.txt': 'outdated merge' }, resolutionRevision: details.revision });
    runtime.launch(task);
    const stopped = await settled(runtime, task.id);
    assert.equal(stopped.status, 'integration_conflict');
    assert.match(stopped.error, /changed after approval/);
    assert.equal(stopped.failedResolutionCandidate, null);
    assert.equal(await readFile(join(project.workspace, 'answer.txt'), 'utf8'), 'Original answer\n');
  } finally { await runtime.close(); await f.remove(); }
});

test('conflict decisions cover every path including deletion and competing additions', () => {
  const conflicts = [{ path: 'removed.txt', base: 'base', ours: null, theirs: 'edited' },
    { path: 'new.txt', base: null, ours: 'one', theirs: 'two' }];
  assert.deepEqual(validateResolutions(conflicts, { 'removed.txt': null, 'new.txt': 'both' }),
    { 'removed.txt': null, 'new.txt': 'both' });
  assert.throws(() => validateResolutions(conflicts, { 'removed.txt': null }), /exactly/);
  assert.throws(() => validateResolutions(conflicts,
    { 'removed.txt': null, 'new.txt': 'both', 'unrelated.txt': 'no' }), /exactly/);
});

test('conflict decisions reject unresolved markers and oversized content', () => {
  const conflicts = [{ path: 'answer.txt' }];
  for (const value of ['<<<<<<< branch\nanswer', '=======\nanswer', '>>>>>>> other',
    '||||||| base', 'x'.repeat(100001), 42]) {
    assert.throws(() => validateResolutions(conflicts, { 'answer.txt': value }), /Invalid/);
  }
  assert.throws(() => validateResolutions(conflicts, []), /exactly/);
});
