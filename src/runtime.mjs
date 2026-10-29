import { integrateProject } from './integration.mjs';
import { Projects } from './projects.mjs';
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, redact } from './core.mjs';
import { diffWorkspace, checksWorkspace } from './workspace.mjs';
import { stagePlan } from './agents.mjs';
import { executePipeline, decideCheckpoint } from './workflow.mjs';

function acquireLock(directory) {
  const path = join(directory, 'server.lock');
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid server lock; inspect it manually.');
    try { process.kill(pid, 0); throw new Error('Another server owns this state directory.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = openSync(path, 'wx', 0o600);
  return { fd, path };
}

export class Runtime {
  constructor(config) {
    this.config = config;
    this.store = new Store(config.stateDir, config.secrets ?? [config.apiKey]);
    try { this.lock = acquireLock(config.stateDir); }
    catch (error) { this.store.close(); throw error; }
    // A lock file never contains provider credentials.
    writeSync(this.lock.fd, String(process.pid));
    this.store.recover();
    this.active = new Map();
    this.closing = false;
    this.projects = new Projects(this);
  }

  clean(value) {
    return JSON.parse(redact(JSON.stringify(value), this.config.secrets ?? [this.config.apiKey]));
  }

  async start(repository, goal, agents) {
    if (this.closing) throw new Error('Server is shutting down.');
    const root = await realpath(repository);
    if (!this.config.repositories.includes(root)) throw new Error('Repository is not configured.');
    if (this.active.size >= this.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 20000) throw new Error('Goal must contain 1–20000 characters.');
    const stages = stagePlan(this.config, agents);
    const created = this.store.create(root, redact(goal, this.config.secrets ?? [this.config.apiKey]));
    const task = this.store.update(created.id, { stages, stageIndex: 0, stageResults: [] });
    this.launch(task);
    return task;
  }

  launch(task) {
    const controller = new AbortController();
    const entry = { controller };
    this.active.set(task.id, entry);
    entry.promise = this.execute(task, controller.signal).finally(() => {
      this.active.delete(task.id);
      this.projects.pump();
    });
  }

  async execute(task, signal) {
    if (task.kind === 'project' && task.phase === 'integration') return integrateProject(this.projects, task, signal);
    return task.kind === 'project' ? this.projects.generate(task, signal) : executePipeline(this, task, signal); }

  decide(id, stageIndex, approved) { return decideCheckpoint(this, id, stageIndex, approved); }

  cancel(id) {
    const task = this.store.get(id);
    if (task.kind === 'project') {
      this.projects.cancel(id);
      return { id, status: 'cancelled', cancellationRequested: true };
    }
    const active = this.active.get(id);
    if (!active) {
      if (['awaiting_approval', 'waiting_dependency'].includes(task.status)) {
        this.store.update(id, { status: 'cancelled', checkpoint: null });
        this.projects.pump();
        return { id, status: 'cancelled', cancellationRequested: true };
      }
      return { id, status: task.status, cancellationRequested: false };
    }
    active.controller.abort();
    return { id, status: task.status, cancellationRequested: true };
  }

  async diff(id) {
    const task = this.store.get(id);
    if (this.active.has(id)) throw new Error('Wait for the task to stop before reviewing its diff.');
    if (!task.workspace) throw new Error('Task has no worktree.');
    return this.clean(await diffWorkspace(task));
  }

  async checks(id) {
    const task = this.store.get(id);
    if (!task.workspace) throw new Error('Task has no worktree.');
    if (this.active.has(id)) throw new Error('Task already has an active operation.');
    if (this.closing) throw new Error('Server is shutting down.');
    if (this.active.size >= this.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
    const controller = new AbortController();
    const entry = { controller };
    this.active.set(id, entry);
    entry.promise = checksWorkspace(this.config, task.workspace, controller.signal)
      .then(result => {
        const checks = this.clean(result);
        const status = ['needs_review', 'checks_failed'].includes(task.status)
          ? (checks.configured && !checks.passed ? 'checks_failed' : 'needs_review') : task.status;
        this.store.update(id, { checks, status });
        return checks;
      }).finally(() => { this.active.delete(id); this.projects.pump(); });
    return entry.promise;
  }

  async close() {
    this.closing = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
    closeSync(this.lock.fd);
    unlinkSync(this.lock.path);
    this.store.close();
  }
}
