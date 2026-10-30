import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Runtime } from '../src/runtime.mjs';
import { monitoring } from '../src/monitoring.mjs';

test('monitoring counts all tasks and keeps unreported cost distinct from free usage', async () => {
  const stateDir = await mkdtemp(resolve('work/metrics-'));
  const runtime = new Runtime({ stateDir, repositories: [], maxConcurrent: 2 });
  try {
    for (let i = 0; i < 105; i++) runtime.store.create('repository', 'Task ' + i);
    const task = runtime.store.list()[0];
    runtime.store.update(task.id, { status: 'failed', error: 'Check failed' });
    runtime.store.event(task.id, 'usage', { prompt_tokens: 25, completion_tokens: 10 });
    runtime.store.event(task.id, 'usage', { input_tokens: 5, output_tokens: 2, cost_usd: 0.01 });
    const metrics = monitoring(runtime);
    assert.equal(metrics.statuses.queued, 104);
    assert.equal(metrics.statuses.failed, 1);
    assert.equal(metrics.usage.inputTokens, 30);
    assert.equal(metrics.usage.outputTokens, 12);
    assert.equal(metrics.usage.reportedCostUsd, 0.01);
    assert.equal(metrics.usage.costReports, 1);
    assert.equal(metrics.usage.usageReports, 2);
    assert.equal(metrics.recentFailures[0].taskId, task.id);
    assert.equal(runtime.store.events(task.id)[0].detail.to, 'failed');
  } finally { await runtime.close(); await rm(stateDir, { recursive: true, force: true }); }
});
