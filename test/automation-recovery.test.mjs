import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.mjs';
import { resumeTask } from '../src/recovery.mjs';
import { repositoryFixture, settled } from './helpers.mjs';

async function interruptedRun(runtime, repository) {
  const rule = await runtime.automations.create({ repository, name: 'Recover automation',
    goal: 'Continue fixed work', trigger: { type: 'event', eventType: 'repo.changed' } });
  runtime.automations.enable(rule.id);
  const receipt = runtime.automations.store.reserve(rule.id, 'original-run');
  const task = runtime.store.create(repository, rule.goal);
  runtime.store.update(task.id, { status: 'interrupted', automationId: rule.id, automationRunId: receipt.id,
    stages: [{ agent: 'byok' }], stageIndex: 0, stageResults: [] });
  runtime.automations.store.updateRun(receipt.id, { taskId: task.id, status: 'interrupted', finishedAt: 'previous' });
  return { rule, receipt, task };
}

test('recovering an automation restores its overlap reservation until the task settles', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime({ ...f.config, requireApproval: true });
  try {
    const { rule, receipt, task } = await interruptedRun(runtime, f.repository);
    const resumed = await resumeTask(runtime, task.id);
    assert.equal(resumed.status, 'queued');
    const activeReceipt = runtime.automations.store.run(receipt.id);
    assert.equal(activeReceipt.status, 'started');
    assert.equal(activeReceipt.finishedAt, null);
    assert.equal(activeReceipt.taskId, task.id);
    assert.equal((await settled(runtime, task.id)).status, 'awaiting_approval');
    const event = runtime.automations.event({ id: 'during-recovery', type: 'repo.changed' });
    assert.equal(event.runs.length, 1);
    assert.equal(event.runs[0].status, 'skipped');
    assert.equal(runtime.store.list().length, 1);
    assert.equal(runtime.automations.get(rule.id).runs.length, 2);
    runtime.cancel(task.id);
    runtime.automations.tick();
    assert.equal(runtime.automations.store.run(receipt.id).status, 'cancelled');
    assert.equal(runtime.store.get(task.id).status, 'cancelled');
  } finally { await runtime.close(); await f.remove(); }
});

test('automation recovery refuses overlap with an already queued occurrence', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const { rule, receipt, task } = await interruptedRun(runtime, f.repository);
    const pending = runtime.automations.store.reserve(rule.id, 'new-occurrence');
    await assert.rejects(resumeTask(runtime, task.id), /still pending/);
    assert.equal(runtime.active.size, 0);
    assert.equal(runtime.store.get(task.id).status, 'interrupted');
    assert.equal(runtime.automations.store.run(receipt.id).status, 'interrupted');
    assert.equal(runtime.automations.store.run(pending.id).status, 'queued');
    assert.equal(runtime.store.events(task.id).filter(event => event.kind === 'recovery_requested').length, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('automation recovery validates the durable receipt before changing task state', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const { receipt, task } = await interruptedRun(runtime, f.repository);
    runtime.automations.store.updateRun(receipt.id, { taskId: 'different-task' });
    await assert.rejects(resumeTask(runtime, task.id), /receipt changed/);
    assert.equal(runtime.store.get(task.id).status, 'interrupted');
    assert.equal(runtime.store.get(task.id).recoveryCount, undefined);
    assert.equal(runtime.active.size, 0);
    assert.equal(runtime.automations.store.run(receipt.id).status, 'interrupted');
    assert.equal(runtime.store.list().length, 1);
    assert.equal(runtime.store.events(task.id).filter(event => event.kind === 'recovery_requested').length, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('removed agents leave interrupted automation receipts untouched', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime({ ...f.config, agents: { byok: { kind: 'byok' } } });
  try {
    const { receipt, task } = await interruptedRun(runtime, f.repository);
    runtime.config.agents = { replacement: { kind: 'byok' } };
    await assert.rejects(resumeTask(runtime, task.id), /configured agents/);
    assert.equal(runtime.automations.store.run(receipt.id).status, 'interrupted');
    assert.equal(runtime.store.get(task.id).status, 'interrupted');
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await f.remove(); }
});
