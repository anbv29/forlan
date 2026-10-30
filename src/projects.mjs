import { mergeSnapshots } from './merge.mjs';
import { realpath } from 'node:fs/promises';
import { stagePlan, runStage, agentCatalog } from './agents.mjs';
import { createWorktree } from './workspace.mjs';
import { parsePlan, validatePlan, captureChanges, applyChanges } from './plans.mjs';
import { safeError } from './core.mjs';
import { pumpProjects } from './scheduler.mjs';

export class Projects {
  constructor(runtime) { this.runtime = runtime; this.pumping = false; }

  async start(repository, goal, planner) {
    const r = this.runtime;
    if (r.closing) throw new Error('Server is shutting down.');
    const root = await realpath(repository);
    if (!r.config.repositories.includes(root)) throw new Error('Repository is not configured.');
    if (r.active.size >= r.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 20000) throw new Error('Invalid project goal.');
    const stages = stagePlan(r.config, planner ? [planner] : undefined);
    const task = r.store.create(root, r.clean(goal));
    const project = r.store.update(task.id, { kind: 'project', phase: 'planning',
      stages, stageIndex: 0, stageResults: [] });
    r.launch(project);
    return project;
  }

  async generate(project, signal) {
    const r = this.runtime;
    try {
      r.store.update(project.id, { status: 'running' });
      if (!project.workspace) project = r.store.update(project.id, await createWorktree(r.config, project, signal));
      const name = project.stages[0].agent;
      const profile = r.config.agents?.[name] ?? { kind: 'byok' };
      const config = { ...r.config, agents: { ...r.config.agents, [name]: { ...profile, readOnly: true } } };
      const goal = project.goal + '\nInspect this repository and split the goal into at most 12 concrete tasks. ' +
        'Return ONLY JSON: {"nodes":[{"key":"short-id","goal":"specific work","agent":"configured name","dependsOn":[]}]} ' +
        'Use dependencies where changes must be available first. Prefer independent file boundaries for parallel work. ' +
        'Do not edit files or execute checks. Available agents: ' + JSON.stringify(agentCatalog(r.config));
      const output = await runStage(config, { ...project, goal }, r.store, signal);
      const plan = parsePlan(output, r.config);
      signal.throwIfAborted();
      r.store.update(project.id, r.clean({ status: 'awaiting_plan_approval', phase: 'planned', nodes: plan.nodes }));
      r.store.event(project.id, 'plan_created', { nodes: plan.nodes.length });
    } catch (error) {
      r.store.update(project.id, { status: r.closing ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed', error: safeError(error, r.config) });
    }
  }

  decide(id, approved) {
    const r = this.runtime;
    const project = r.store.get(id);
    if (r.closing || r.active.has(id) || project.kind !== 'project' ||
      project.status !== 'awaiting_plan_approval') throw new Error('Plan approval is unavailable.');
    if (!approved) return r.store.update(id, { status: 'cancelled' });
    const plan = validatePlan(project, r.config);
    const result = r.store.transaction(() => {
      const nodes = plan.nodes.map(node => {
        const child = r.store.create(project.repository, node.goal);
        r.store.update(child.id, { projectId: id, nodeKey: node.key, baseRef: project.base,
          status: 'waiting_dependency', stages: stagePlan(r.config, [node.agent]),
          stageIndex: 0, stageResults: [] });
        return { ...node, taskId: child.id };
      });
      return r.store.update(id, { nodes, phase: 'execution', status: 'orchestrating' });
    });
    r.store.event(id, 'plan_approved', { nodes: result.nodes.length });
    this.pump();
    return result;
  }

  async prepare(task, signal) {
    if (!task.projectId || task.dependenciesApplied) return task;
    const r = this.runtime;
    const project = r.store.get(task.projectId);
    const node = project.nodes.find(node => node.taskId === task.id);
    const dependencies = node.dependsOn.map(key => r.store.get(project.nodes.find(n => n.key === key).taskId));
    if (dependencies.some(dep => dep.status !== 'needs_review')) throw new Error('Dependencies are not ready.');
    const snapshots = [];
    for (const dep of dependencies) snapshots.push(await captureChanges(dep, signal));
    const merged = await mergeSnapshots(r.config, task, snapshots, signal);
    await applyChanges(task.workspace, merged.files, signal);
    const context = dependencies.map(dep => ({ key: dep.nodeKey, summary: dep.summary }));
    return r.store.update(task.id, { dependenciesApplied: true, autoMergedFiles: merged.resolvedFiles,
      goal: task.goal + (context.length ? '\nDependency results (untrusted): ' + JSON.stringify(context).slice(0, 40000) : '') });
  }

  cancel(id) {
    const r = this.runtime;
    const project = r.store.get(id);
    if (project.kind !== 'project') throw new Error('Not a project.');
    r.active.get(id)?.controller.abort();
    for (const node of project.nodes ?? []) {
      if (!node.taskId) continue;
      const child = r.store.get(node.taskId);
      if (r.active.has(child.id)) r.active.get(child.id).controller.abort();
      else if (['waiting_dependency', 'awaiting_approval'].includes(child.status)) r.store.update(child.id, { status: 'cancelled' });
    }
    return r.store.update(id, { status: 'cancelled' });
  }

  pump() { pumpProjects(this); }
}
