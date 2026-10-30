import { planSummary } from './plans.mjs';
import { safeError } from './core.mjs';

const failures = new Set(['failed', 'checks_failed', 'cancelled', 'interrupted', 'blocked']);

export function pumpProjects(projects) {
  const r = projects.runtime;
  if (projects.pumping || r.closing) return;
  projects.pumping = true;
  try {
    for (const project of r.store.projects().filter(p => p.status === 'orchestrating')) {
      const tasks = new Map(project.nodes.map(node => [node.key, r.store.get(node.taskId)]));
      let changed;
      do {
        changed = false;
        for (const node of project.nodes) {
          const task = tasks.get(node.key);
          if (task.status !== 'waiting_dependency' || !node.dependsOn.some(key => failures.has(tasks.get(key).status))) continue;
          tasks.set(node.key, r.store.update(task.id, { status: 'blocked', error: 'A dependency did not complete successfully.' }));
          r.store.event(project.id, 'node_blocked', { key: node.key });
          changed = true;
        }
      } while (changed);
      for (const node of project.nodes) {
        const task = tasks.get(node.key);
        if (task.status !== 'waiting_dependency') continue;
        const dependencies = node.dependsOn.map(key => tasks.get(key));
        if (dependencies.some(dep => dep.status !== 'needs_review') || r.active.size >= r.config.maxConcurrent) continue;
        const queued = r.store.update(task.id, { status: 'queued' });
        tasks.set(node.key, queued);
        r.launch(queued);
      }
      const children = project.nodes.map(node => r.store.get(node.taskId));
      const settled = children.every(task => task.status === 'needs_review' || failures.has(task.status));
      const status = settled ? (children.every(task => task.status === 'needs_review') ? 'needs_review' : 'blocked') : 'orchestrating';
      r.store.update(project.id, { status, results: planSummary(project, children) });
    }
  } catch (error) {
    // Keep scheduler faults visible without an unhandled rejection from task cleanup.
    for (const project of r.store.projects().filter(p => p.status === 'orchestrating')) {
      r.store.update(project.id, { status: 'blocked', error: safeError(error, r.config) });
    }
  } finally { projects.pumping = false; }
}

export function resumeProject(projects, id) {
  const r = projects.runtime;
  const project = r.store.get(id);
  if (r.closing || project.kind !== 'project' || !['paused_project', 'blocked'].includes(project.status)) throw new Error('Project cannot be resumed.');
  const children = project.nodes.map(node => r.store.get(node.taskId));
  if (children.some(task => task.status === 'interrupted')) throw new Error('Recover interrupted children with resume_task first.');
  if (children.some(task => ['failed', 'checks_failed', 'cancelled'].includes(task.status))) throw new Error('A dependency failed or was cancelled.');
  for (const task of children.filter(task => task.status === 'blocked')) {
    r.store.update(task.id, { status: 'waiting_dependency', error: null });
  }
  r.store.update(id, { status: 'orchestrating' });
  projects.pump();
  return r.store.get(id);
}
