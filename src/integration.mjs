import { mergeSnapshots } from './merge.mjs';
import { captureChanges, applyChanges } from './plans.mjs';
import { diffWorkspace, checksWorkspace } from './workspace.mjs';
import { safeError } from './core.mjs';

export function beginIntegration(projects, id) {
  const r = projects.runtime;
  const project = r.store.get(id);
  if (r.closing || r.active.has(id) || project.kind !== 'project' ||
    project.status !== 'needs_review' || project.phase !== 'execution') throw new Error('Project is not ready for integration.');
  if (r.active.size >= r.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
  if (project.nodes.some(n => r.store.get(n.taskId).status !== 'needs_review')) throw new Error('All child tasks must be complete.');
  const queued = r.store.update(id, { status: 'queued', phase: 'integration' });
  r.launch(queued);
  return queued;
}

export async function integrateProject(projects, project, signal) {
  const r = projects.runtime;
  try {
    r.store.update(project.id, { status: 'running' });
    const existing = await diffWorkspace(project, signal);
    if (existing.diff || existing.untracked.length) throw new Error('Project worktree has existing edits; inspect them before integrating.');
    const dependedOn = new Set(project.nodes.flatMap(node => node.dependsOn));
    const leaves = project.nodes.filter(node => !dependedOn.has(node.key));
    const snapshots = [];
    for (const node of leaves) {
      const task = r.store.get(node.taskId);
      if (task.status !== 'needs_review' || task.base !== project.base) throw new Error('Child worktree is not ready.');
      snapshots.push(await captureChanges(task, signal));
    }
    const { files, resolvedFiles } = await mergeSnapshots(r.config, project, snapshots, signal);
    signal.throwIfAborted();
    await applyChanges(project.workspace, files, signal);
    const checks = await checksWorkspace(r.config, project.workspace, signal);
    signal.throwIfAborted();
    r.store.update(project.id, r.clean({ phase: 'integrated', checks, autoMergedFiles: resolvedFiles, integratedFiles: Object.keys(files),
      status: checks.configured && !checks.passed ? 'checks_failed' : 'needs_review' }));
    r.store.event(project.id, 'integration_completed', { files: Object.keys(files).length });
  } catch (error) {
    r.store.update(project.id, { status: signal.aborted ? 'cancelled' :
      (error.message?.startsWith('Dependency conflict') ? 'integration_conflict' : 'failed'),
      error: safeError(error, r.config), mergeConflicts: error.conflicts ?? [] });
  }
}
