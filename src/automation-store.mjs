import { randomUUID } from 'node:crypto';

export class AutomationStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation TEXT NOT NULL, fire_key TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(automation, fire_key));
      CREATE TABLE IF NOT EXISTS automation_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS automation_run_status ON automation_runs(json_extract(data, '$.status'));");
  }

  list() {
    return this.db.prepare('SELECT data FROM automations ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
  }

  get(id) {
    const row = this.db.prepare('SELECT data FROM automations WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown automation.');
    return JSON.parse(row.data);
  }

  create(fields) {
    if (this.list().length >= 100) throw new Error('Maximum of 100 automation definitions reached.');
    const rule = { ...fields, id: randomUUID(), enabled: false, revision: 1 };
    this.db.prepare('INSERT INTO automations VALUES (?, ?)').run(rule.id, this.store.serialize(rule));
    return this.get(rule.id);
  }

  update(id, fields) {
    const rule = { ...this.get(id), ...fields };
    this.db.prepare('UPDATE automations SET data = ? WHERE id = ?').run(this.store.serialize(rule), id);
    return this.get(id);
  }

  reserve(id, key, fields = {}) {
    this.get(id);
    const run = { ...fields, id: randomUUID(), automationId: id, key, status: 'queued' };
    this.db.prepare('INSERT OR IGNORE INTO automation_runs VALUES (?, ?, ?, ?)')
      .run(run.id, id, key, this.store.serialize(run));
    return JSON.parse(this.db.prepare('SELECT data FROM automation_runs WHERE automation = ? AND fire_key = ?')
      .get(id, key).data);
  }

  run(id) {
    const row = this.db.prepare('SELECT data FROM automation_runs WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown automation run.');
    return JSON.parse(row.data);
  }

  updateRun(id, fields) {
    const run = { ...this.run(id), ...fields };
    this.db.prepare('UPDATE automation_runs SET data = ? WHERE id = ?').run(this.store.serialize(run), id);
    return run;
  }

  runs(id) {
    this.get(id);
    return this.db.prepare('SELECT data FROM automation_runs WHERE automation = ? ORDER BY rowid DESC LIMIT 100')
      .all(id).map(row => JSON.parse(row.data));
  }

  pending() {
    return this.db.prepare("SELECT data FROM automation_runs WHERE json_extract(data, '$.status') = 'queued' ORDER BY rowid LIMIT 100")
      .all().map(row => JSON.parse(row.data));
  }

  queuedCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE json_extract(data, '$.status') = 'queued'")
      .get().count;
  }
  active(id) {
    return this.db.prepare(`SELECT data FROM automation_runs WHERE automation = ? AND
      json_extract(data, '$.status') IN ('queued', 'started')`).all(id).map(row => JSON.parse(row.data));
  }

  started() {
    return this.db.prepare("SELECT data FROM automation_runs WHERE json_extract(data, '$.status') = 'started'")
      .all().map(row => JSON.parse(row.data));
  }

  eventDigest(id) {
    return this.db.prepare('SELECT digest FROM automation_events WHERE id = ?').get(id)?.digest;
  }

  recordEvent(id, digest) {
    this.db.prepare('INSERT INTO automation_events VALUES (?, ?)').run(id, digest);
  }

  disable(id) {
    return this.store.transaction(() => {
      for (const run of this.pending().filter(run => run.automationId === id)) {
        this.updateRun(run.id, { status: 'cancelled' });
      }
      return this.update(id, { enabled: false });
    });
  }
}
