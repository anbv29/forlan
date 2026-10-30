import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './workspace.mjs';
import { stagePlan } from './agents.mjs';

export async function resumeTask(runtime, id) {
  const task = runtime.store.get(id);
  if (runtime.closing || runtime.active.has(id) || task.status !== 'interrupted' ||
    (task.kind === 'project' && !['planning', 'integration', 'resolution'].includes(task.phase))) {
    throw new Error('Only a stopped interrupted task or project operation can be resumed.');
  }
  if (runtime.active.size >= runtime.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
  const repository = await realpath(task.repository);
  if (!runtime.config.repositories.includes(repository)) throw new Error('Repository is no longer configured.');
  stagePlan(runtime.config, task.stages.map(stage => stage.agent));
  if (task.workspace) {
    const workspace = await realpath(task.workspace);
    const expected = await realpath(join(runtime.config.stateDir, 'worktrees', task.id));
    if (workspace !== expected) throw new Error('Recovery worktree path changed.');
    const head = await git(['rev-parse', 'HEAD'], workspace);
    if (head !== task.base) throw new Error('Recovery worktree HEAD changed; inspect it before resuming.');
  }
  const current = runtime.store.get(id);
  if (current.status !== 'interrupted' || runtime.active.has(id) || runtime.closing ||
    runtime.active.size >= runtime.config.maxConcurrent) throw new Error('Recovery state changed; retry.');
  if (task.projectId) {
    const parent = runtime.store.get(task.projectId);
    if (!['paused_project', 'blocked'].includes(parent.status)) throw new Error('Pause the parent project before recovering its child.');
  }
  const queued = runtime.store.update(id, { status: 'queued', error: null,
    approvedStage: null, checkpoint: null, recoveryCount: (task.recoveryCount ?? 0) + 1,
    resumedAt: new Date().toISOString() });
  runtime.store.event(id, 'recovery_requested', { stageIndex: task.stageIndex, preservesWorktree: !!task.workspace });
  runtime.launch(queued);
  return queued;
}

export function registerRecoveryTools(register, server, runtime, z) {
  register('resume_task', 'Ask the human to continue an interrupted task in its existing worktree. ' +
    'Completed stages are retained. The unfinished stage starts a fresh agent call and inspects existing edits; ' +
    'external side effects may repeat. No automatic replay occurs.',
    { taskId: z.string().uuid() }, async ({ taskId }) => {
      const task = runtime.store.get(taskId);
      if (task.status !== 'interrupted') throw new Error('Task is not recoverable.');
      if (!server.server.getClientCapabilities()?.elicitation) throw new Error('MCP form elicitation is required.');
      const response = await server.server.elicitInput({ mode: 'form',
        message: 'Continue interrupted task ' + task.goal + ' at ' + (task.kind === 'project' ? task.phase : 'stage ' + (task.stageIndex + 1)) +
          '? Existing edits and completed stages are preserved. The unfinished stage uses a fresh model call. ' +
          'Review existing changes first; external actions may repeat.',
        requestedSchema: { type: 'object', properties: {
          approve: { type: 'boolean', title: 'Continue interrupted work', default: false }
        }, required: ['approve'] } });
      if (response.action !== 'accept' || response.content?.approve !== true) return { id: taskId, status: task.status };
      return resumeTask(runtime, taskId);
    });
}
