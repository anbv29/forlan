import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, redact, safeError } from './core.mjs';
import { createWorktree, diffWorkspace, checksWorkspace } from './workspace.mjs';
import { runAgent } from './provider.mjs';

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
    this.store = new Store(config.stateDir);
    try { this.lock = acquireLock(config.stateDir); }
    catch (error) { this.store.close(); throw error; }
    // A lock file never contains provider credentials.
    import('node:fs').then(({ writeSync }) => writeSync(this.lock.fd, String(process.pid)));
    this.store.recover();
    this.active = new Map();
    this.closing = false;
  }

  clean(value) {
    return JSON.parse(redact(JSON.stringify(value), [this.config.apiKey]));
  }

  async start(repository, goal) {
    if (this.closing) throw new Error('Server is shutting down.');
    const root = await realpath(repository);
    if (!this.config.repositories.includes(root)) throw new Error('Repository is not configured.');
    if (this.active.size >= this.config.maxConcurrent) throw new Error('Concurrent task limit reached.');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 20000) throw new Error('Goal must contain 1–20000 characters.');
    const task = this.store.create(root, redact(goal, [this.config.apiKey]));
    const controller = new AbortController();
    const entry = { controller };
    this.active.set(task.id, entry);
    entry.promise = this.execute(task, controller.signal).finally(() => this.active.delete(task.id));
    return task;
  }

  async execute(task, signal) {
    try {
      this.store.update(task.id, { status: 'running' });
      const workspace = await createWorktree(this.config, task, signal);
      task = this.store.update(task.id, workspace);
      signal.throwIfAborted();
      const summary = await runAgent(this.config, task, this.store, signal);
      const checks = await checksWorkspace(this.config, task.workspace, signal);
      signal.throwIfAborted();
      this.store.update(task.id, this.clean({ summary, checks,
        status: checks.configured && !checks.passed ? 'checks_failed' : 'needs_review' }));
    } catch (error) {
      this.store.update(task.id, { status: signal.aborted ? 'cancelled' : 'failed',
        error: safeError(error, this.config) });
    }
  }

  cancel(id) {
    const task = this.store.get(id);
    const active = this.active.get(id);
    if (!active) return { id, status: task.status, cancellationRequested: false };
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
    const controller = new AbortController();
    const entry = { controller };
    this.active.set(id, entry);
    entry.promise = checksWorkspace(this.config, task.workspace, controller.signal)
      .then(result => {
        const checks = this.clean(result);
        this.store.update(id, { checks });
        return checks;
      }).finally(() => this.active.delete(id));
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
