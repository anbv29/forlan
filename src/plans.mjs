import { lstat, unlink } from 'node:fs/promises';
import { git, readWorkspace, writeWorkspace, safePath } from './workspace.mjs';

export async function captureChanges(task, signal) {
  const tracked = await git(['diff', '--no-renames', '--name-only', '-z', task.base, '--', '.'], task.workspace, signal);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], task.workspace, signal);
  const paths = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))];
  const files = Object.create(null);
  let bytes = 0;
  if (paths.length > 500) throw new Error('Dependency snapshot exceeds 500 files.');
  for (const path of paths) {
    signal?.throwIfAborted();
    const target = await safePath(task.workspace, path, true);
    try {
      const info = await lstat(target);
      if (!info.isFile()) throw new Error('Dependency snapshots require regular files.');
      files[path] = await readWorkspace(task.workspace, path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files[path] = null;
    }
    bytes += Buffer.byteLength(files[path] ?? '') + Buffer.byteLength(path);
    if (bytes > 1000000) throw new Error('Dependency snapshot exceeds 1 MB.');
  }
  return files;
}

export function combineChanges(snapshots) {
  const combined = Object.create(null);
  for (const files of snapshots) {
    for (const [path, content] of Object.entries(files)) {
      if (Object.hasOwn(combined, path) && combined[path] !== content) {
        throw new Error('Dependency conflict in ' + path + '; manual integration is required.');
      }
      combined[path] = content;
    }
  }
  return combined;
}

export async function applyChanges(workspace, files, signal) {
  for (const path of Object.keys(files)) await safePath(workspace, path, true);
  for (const [path, content] of Object.entries(files)) {
    signal?.throwIfAborted();
    if (content === null) {
      const target = await safePath(workspace, path, true);
      await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else await writeWorkspace(workspace, path, content);
  }
}

export function validatePlan(value, config) {
  if (!value || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 12) {
    throw new Error('A plan requires 1–12 nodes.');
  }
  const profiles = config.agents ?? { byok: { kind: 'byok' } };
  const seen = new Set();
  const nodes = value.nodes.map(node => {
    if (!node || typeof node.key !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(node.key) ||
      seen.has(node.key)) throw new Error('Plan node keys must be unique identifiers.');
    seen.add(node.key);
    if (typeof node.goal !== 'string' || !node.goal.trim() || node.goal.length > 10000) throw new Error('Invalid node goal.');
    if (typeof node.agent !== 'string' || !Object.hasOwn(profiles, node.agent)) throw new Error('Unknown plan agent.');
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some(d => typeof d !== 'string')) throw new Error('Invalid dependencies.');
    return { key: node.key, goal: node.goal, agent: node.agent, dependsOn: [...new Set(node.dependsOn)] };
  });
  for (const node of nodes) {
    if (node.dependsOn.some(key => !seen.has(key) || key === node.key)) throw new Error('Unknown or self dependency.');
  }
  const complete = new Set();
  for (;;) {
    const ready = nodes.filter(n => !complete.has(n.key) && n.dependsOn.every(key => complete.has(key)));
    if (!ready.length) break;
    for (const node of ready) complete.add(node.key);
  }
  if (complete.size !== nodes.length) throw new Error('Plan dependencies contain a cycle.');
  return { nodes };
}

export function parsePlan(text, config) {
  const source = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\x60\x60\x60\s*$/, '');
  return validatePlan(JSON.parse(source), config);
}

export function planSummary(plan, children) {
  return plan.nodes.map(node => {
    const task = children.find(child => child.id === node.taskId);
    return { key: node.key, taskId: node.taskId, dependsOn: node.dependsOn,
      status: task?.status ?? 'not_started', summary: task?.summary };
  });
}
