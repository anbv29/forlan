import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { repositoryFixture } from './helpers.mjs';

test('MCP indexes code and manages repository notes through its public tools', async () => {
  const f = await repositoryFixture();
  const app = createServer(f.config);
  const client = new Client({ name: 'context-client', version: '1' });
  const pair = InMemoryTransport.createLinkedPair();
  const invoke = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    await Promise.all([app.server.connect(pair[0]), client.connect(pair[1])]);
    const index = await invoke('index_repository', { repository: f.repository });
    assert.equal(index.files, 1);
    const note = await invoke('remember_context', { repository: f.repository, title: 'Storage', body: 'Use SQLite ledger' });
    const found = await invoke('search_context', { repository: f.repository, query: 'ledger' });
    assert.equal(found.results[0].source, 'memory:' + note.id);
    assert.equal(found.index.fingerprint, index.fingerprint);
    const deleted = await invoke('forget_context', { repository: f.repository, memoryId: note.id });
    assert.equal(deleted.deleted, true);
    const feed = await invoke('get_activity', { after: 0 });
    assert.deepEqual(feed.events, []);
    const outside = await client.callTool({ name: 'search_context', arguments: { repository: f.directory, query: 'ledger' } });
    assert.equal(outside.isError, true);
  } finally { await client.close(); await app.close(); await f.remove(); }
});

test('MCP conflict submissions cannot bypass the human approval form', async () => {
  const f = await repositoryFixture();
  const app = createServer(f.config);
  const client = new Client({ name: 'no-form-client', version: '1' });
  const pair = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([app.server.connect(pair[0]), client.connect(pair[1])]);
    const task = app.runtime.store.create(f.repository, 'Invalid conflict');
    const result = await client.callTool({ name: 'submit_conflict_resolutions', arguments: {
      taskId: task.id, revision: '0'.repeat(64), decisions: { 'answer.txt': 'unapproved' }
    } });
    assert.equal(result.isError, true);
    assert.equal(app.runtime.active.size, 0);
    assert.equal(app.runtime.store.get(task.id).status, 'queued');
  } finally { await client.close(); await app.close(); await f.remove(); }
});
