import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.mjs';
import { repositoryFixture, settled } from './helpers.mjs';

test('runtime shutdown is safe when client closure and process shutdown arrive together', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const first = runtime.close();
    const second = runtime.close();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await runtime.close();
    await assert.rejects(access(join(f.config.stateDir, 'server.lock')), /ENOENT/);
    const reopened = new Runtime(f.config);
    assert.equal(reopened.closing, false);
    await reopened.close();
  } finally { await runtime.close(); await f.remove(); }
});

test('failed CLI runs explain the error without exposing configured credentials', async () => {
  const f = await repositoryFixture();
  const executable = join(f.directory, 'failed-agent.mjs');
  await writeFile(executable, 'console.error("Authentication rejected fixture-secret-key"); process.exit(1);');
  const runtime = new Runtime({ ...f.config, secrets: ['fixture-secret-key'], defaultAgent: 'codex',
    agents: { codex: { kind: 'codex', command: [process.execPath, executable] } } });
  try {
    const task = await runtime.start(f.repository, 'Run this fixture');
    const result = await settled(runtime, task.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Authentication rejected/);
    assert.match(result.error, /REDACTED/);
    assert.ok(!JSON.stringify(result).includes('fixture-secret-key'));
    assert.ok(!JSON.stringify(runtime.store.events(task.id)).includes('fixture-secret-key'));
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('CLI subprocess fixtures exercise real edit and read-only review stage handoff', async () => {
  const f = await repositoryFixture();
  const executable = join(f.directory, 'agent.mjs');
  await writeFile(executable, `
import { readFileSync, writeFileSync } from 'node:fs';
let brief = '';
for await (const chunk of process.stdin) brief += chunk;
const readonly = process.argv.includes('read-only');
if (readonly) {
  if (readFileSync('answer.txt', 'utf8') !== 'Verified change') process.exit(2);
  if (!brief.includes('Implementation finished')) process.exit(3);
} else writeFileSync('answer.txt', 'Verified change');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
  text: readonly ? 'Review finished' : 'Implementation finished' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 15, output_tokens: 5 } }));
`);
  const runtime = new Runtime({ ...f.config, defaultAgent: 'coder', requireApproval: true,
    agents: { coder: { kind: 'codex', command: [process.execPath, executable] },
      reviewer: { kind: 'codex', command: [process.execPath, executable], readOnly: true } },
    checks: [[process.execPath, '-e', "if(require('fs').readFileSync('answer.txt','utf8')!=='Verified change') process.exit(1)"]] });
  try {
    const task = await runtime.start(f.repository, 'Implement and review', ['coder', 'reviewer']);
    assert.equal((await settled(runtime, task.id)).status, 'awaiting_approval');
    runtime.decide(task.id, 0, true);
    assert.equal((await settled(runtime, task.id)).status, 'awaiting_approval');
    runtime.decide(task.id, 1, true);
    const reviewed = await settled(runtime, task.id);
    assert.equal(reviewed.status, 'needs_review', reviewed.error);
    assert.equal(reviewed.checks.passed, true);
    assert.deepEqual(reviewed.stageResults.map(stage => stage.summary), ['Implementation finished', 'Review finished']);
    const usage = runtime.store.events(task.id).filter(event => event.kind === 'usage');
    assert.equal(usage.length, 2);
    assert.equal(usage[0].detail.input_tokens, 15);
    assert.equal(runtime.store.events(task.id).filter(event => event.kind === 'stage_completed').length, 2);
    assert.equal(reviewed.stageIndex, 2);
    assert.equal(runtime.active.size, 0);
  } finally { await runtime.close(); await f.remove(); }
});

test('a second worker cannot steal an active state directory', async () => {
  const f = await repositoryFixture();
  const runtime = new Runtime(f.config);
  try {
    const task = runtime.store.create(f.repository, 'Preserve this history');
    assert.throws(() => new Runtime(f.config), /Another server/);
    assert.equal(runtime.store.get(task.id).goal, 'Preserve this history');
    assert.equal(runtime.closing, false);
    assert.equal(runtime.store.list().length, 1);
  } finally { await runtime.close(); await f.remove(); }
});
