import { createWorktree, checksWorkspace } from './workspace.mjs';
import { runStage, stagePlan } from './agents.mjs';
import { safeError } from './core.mjs';

export async function executePipeline(runtime, task, signal) {
  const { store, config } = runtime;
  try {
    store.update(task.id, { status: 'running' });
    if (!task.workspace) task = store.update(task.id, await createWorktree(config, task, signal));
    task = store.update(task.id, { stages: task.stages ?? stagePlan(config),
      stageIndex: task.stageIndex ?? 0, stageResults: task.stageResults ?? [] });
    while (task.stageIndex < task.stages.length) {
      signal.throwIfAborted();
      if (config.requireApproval && task.approvedStage !== task.stageIndex) {
        store.update(task.id, { status: 'awaiting_approval',
          checkpoint: { stageIndex: task.stageIndex, agent: task.stages[task.stageIndex].agent } });
        store.event(task.id, 'approval_requested', { stageIndex: task.stageIndex });
        return;
      }
      const summary = await runStage(config, task, store, signal);
      signal.throwIfAborted();
      const result = runtime.clean({ agent: task.stages[task.stageIndex].agent,
        summary, completedAt: new Date().toISOString() });
      task = store.update(task.id, { stageResults: [...task.stageResults, result],
        summary: result.summary, stageIndex: task.stageIndex + 1, checkpoint: null });
    }
    const checks = await checksWorkspace(config, task.workspace, signal);
    signal.throwIfAborted();
    store.update(task.id, runtime.clean({ checks,
      status: checks.configured && !checks.passed ? 'checks_failed' : 'needs_review' }));
  } catch (error) {
    store.update(task.id, { status: signal.aborted ? 'cancelled' : 'failed',
      error: safeError(error, config) });
  }
}

export function decideCheckpoint(runtime, id, expectedStage, approved) {
  if (runtime.closing) throw new Error('Server is shutting down.');
  const task = runtime.store.get(id);
  if (runtime.active.has(id)) throw new Error('Task still has an active operation.');
  if (task.status !== 'awaiting_approval' || task.stageIndex !== expectedStage) throw new Error('Checkpoint is stale or unavailable.');
  if (!approved) {
    runtime.store.event(id, 'approval_rejected', { stageIndex: expectedStage });
    return runtime.store.update(id, { status: 'cancelled', checkpoint: null });
  }
  if (runtime.active.size >= runtime.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
  runtime.store.event(id, 'approval_granted', { stageIndex: expectedStage });
  const updated = runtime.store.update(id, { status: 'queued', approvedStage: expectedStage, checkpoint: null });
  runtime.launch(updated);
  return updated;
}
