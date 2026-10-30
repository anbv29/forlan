import { webhookConfig } from './event-listener.mjs';
import { normalizeAgents } from './agent-config.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function contained(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

export function loadConfig(env = process.env) {
  if (!env.BYOK_CONFIG || !isAbsolute(env.BYOK_CONFIG)) throw new Error('Set BYOK_CONFIG to an absolute configuration path.');
  const raw = JSON.parse(readFileSync(env.BYOK_CONFIG, 'utf8'));
  const profiles = normalizeAgents(raw, env);
  const automationWebhook = webhookConfig(raw.automationWebhook, env);
  const needsByok = Object.values(profiles.agents).some(p => p.kind === 'byok');
  if (!Array.isArray(raw.repositories) || !raw.repositories.length) throw new Error('Configure repositories.');
  if (needsByok && (typeof raw.model !== 'string' || !raw.model.trim())) throw new Error('Configure a model.');
  const endpoint = new URL(raw.baseUrl ?? (needsByok ? '' : 'http://127.0.0.1'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) throw new Error('Use HTTPS or loopback HTTP.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid baseUrl.');
  const repositories = raw.repositories.map(path => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Repository paths must be absolute.');
    return realpathSync(path);
  });
  const apiKeyEnv = raw.apiKeyEnv ?? 'BYOK_API_KEY';
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('Invalid apiKeyEnv.');
  const apiKey = env[apiKeyEnv];
  if (needsByok && !local && !apiKey && Object.values(profiles.agents).some(p => p.kind === 'byok' && !p.apiKey)) throw new Error('Set the configured API key environment variable.');
  const checks = raw.checks ?? [];
  if (!Array.isArray(checks) || checks.some(c => !Array.isArray(c) || !c.length || c.some(a => typeof a !== 'string' || !a))) throw new Error('checks must contain command argument arrays.');
  const stateDir = resolve(raw.stateDir ?? join(homedir(), '.byok-agent-mcp'));
  if (repositories.some(root => contained(root, stateDir))) throw new Error('stateDir must be outside repositories.');
  const maxSteps = raw.maxSteps ?? 20;
  const maxConcurrent = raw.maxConcurrent ?? 2;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be 1–100.');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('maxConcurrent must be 1–8.');
  return { repositories, model: raw.model, baseUrl: endpoint.href.replace(/\/$/, ''),
    apiKey, apiKeyEnv, stateDir, checks, maxSteps, maxConcurrent, automationWebhook, ...profiles,
    secrets: [apiKey, automationWebhook?.token, ...Object.values(profiles.agents).map(p => p.apiKey)].filter(Boolean) };
}

export class Store {
  constructor(stateDir, secrets = []) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.secrets = secrets;
    this.db = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, task TEXT, data TEXT);`);
  }

  create(repository, goal) {
    const task = { id: randomUUID(), repository, goal, status: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO tasks VALUES (?, ?)').run(task.id, this.serialize(task));
    return task;
  }

  get(id) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown task.');
    return JSON.parse(row.data);
  }

  update(id, fields) {
    const task = { ...this.get(id), ...fields, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE tasks SET data = ? WHERE id = ?').run(this.serialize(task), id);
    return task;
  }

  list() {
    return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC LIMIT 100').all().map(r => JSON.parse(r.data));
  }

  event(id, kind, detail) {
    this.db.prepare('INSERT INTO events(task, data) VALUES (?, ?)').run(id,
      this.serialize({ kind, detail, at: new Date().toISOString() }));
  }

  events(id, after = 0) {
    this.get(id);
    return this.db.prepare('SELECT seq, data FROM events WHERE task = ? AND seq > ? ORDER BY seq LIMIT 100')
      .all(id, after).map(row => ({ sequence: row.seq, ...JSON.parse(row.data) }));
  }

  projects() {
    return this.db.prepare("SELECT data FROM tasks WHERE json_extract(data, '$.kind') = 'project'")
      .all().map(row => JSON.parse(row.data));
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  recover() {
    const rows = this.db.prepare('SELECT data FROM tasks').all();
    for (const row of rows) {
      const task = JSON.parse(row.data);
      if (task.kind === 'project' && task.status === 'orchestrating') this.update(task.id, { status: 'paused_project' });
      else if (['queued', 'running'].includes(task.status)) this.update(task.id, { status: 'interrupted' });
    }
  }

  serialize(value) { return redact(JSON.stringify(value), this.secrets); }

  close() { this.db.close(); }
}

export function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result;
}

export function safeError(error, config) {
  return redact(error instanceof Error ? error.message : 'Operation failed.', config.secrets ?? [config.apiKey]);
}
