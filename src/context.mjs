import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { listWorkspace, readWorkspace } from './workspace.mjs';

export class ContextStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_search USING fts5(
      repository UNINDEXED, source UNINDEXED, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS context_indexes (repository TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, repository TEXT, data TEXT NOT NULL);`);
  }

  async repository(config, path) {
    const repository = await realpath(path);
    if (!config.repositories.includes(repository)) throw new Error('Repository is not configured.');
    return repository;
  }

  async index(config, path, signal) {
    const repository = await this.repository(config, path);
    const paths = await listWorkspace(repository, signal);
    const chunks = [];
    const skipped = [];
    let bytes = 0;
    for (const path of paths) {
      signal?.throwIfAborted();
      let content;
      try { content = await readWorkspace(repository, path); }
      catch (error) { skipped.push({ path, reason: error.message }); continue; }
      content = JSON.parse(this.store.serialize(content));
      bytes += Buffer.byteLength(content);
      if (bytes > 10000000) throw new Error('Repository index exceeds 10 MB; use a smaller repository.');
      const lines = content.split('\n');
      for (let start = 0; start < lines.length; start += 60) {
        chunks.push([repository, path + ':' + (start + 1), lines.slice(start, start + 60).join('\n')]);
      }
    }
    const status = { indexedAt: new Date().toISOString(), files: paths.length - skipped.length,
      chunks: chunks.length, bytes, skipped, limit: 2000,
      fingerprint: createHash('sha256').update(JSON.stringify(chunks)).digest('hex') };
    this.store.transaction(() => {
      this.db.prepare("DELETE FROM context_search WHERE repository = ? AND source NOT LIKE 'memory:%'").run(repository);
      const insert = this.db.prepare('INSERT INTO context_search(repository, source, body) VALUES (?, ?, ?)');
      for (const chunk of chunks) insert.run(...chunk);
      this.db.prepare('INSERT OR REPLACE INTO context_indexes VALUES (?, ?)').run(repository, this.store.serialize(status));
    });
    return status;
  }

  search(repository, query, limit = 8) {
    const terms = String(query).match(/[\p{L}\p{N}_]{2,}/gu)?.slice(0, 20) ?? [];
    if (!terms.length) return [];
    const match = terms.map(term => '"' + term + '"').join(' OR ');
    return this.db.prepare(`SELECT source, snippet(context_search, 2, '', '', ' … ', 40) AS excerpt
      FROM context_search WHERE context_search MATCH ? AND repository = ?
      ORDER BY rank LIMIT ?`).all(match, repository, Math.max(1, Math.min(20, limit)));
  }

  status(repository) {
    const row = this.db.prepare('SELECT data FROM context_indexes WHERE repository = ?').get(repository);
    return row ? JSON.parse(row.data) : null;
  }

  remember(repository, title, body) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
      typeof body !== 'string' || !body.trim() || body.length > 20000) throw new Error('Invalid memory title or body.');
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM memories WHERE repository = ?').get(repository).count;
    if (count >= 1000) throw new Error('Repository memory limit reached.');
    const memory = JSON.parse(this.store.serialize({ id: randomUUID(), title, body,
      createdAt: new Date().toISOString() }));
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO memories VALUES (?, ?, ?)').run(memory.id, repository, JSON.stringify(memory));
      this.db.prepare('INSERT INTO context_search(repository, source, body) VALUES (?, ?, ?)')
        .run(repository, 'memory:' + memory.id, memory.title + '\n' + memory.body);
    });
    return memory;
  }

  forget(repository, id) {
    return this.store.transaction(() => {
      const result = this.db.prepare('DELETE FROM memories WHERE repository = ? AND id = ?').run(repository, id);
      this.db.prepare('DELETE FROM context_search WHERE repository = ? AND source = ?').run(repository, 'memory:' + id);
      return { deleted: result.changes === 1 };
    });
  }
}

