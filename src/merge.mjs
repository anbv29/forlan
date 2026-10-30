import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command, safePath } from './workspace.mjs';
import { contained } from './core.mjs';

async function baseContent(task, path, signal) {
  await safePath(task.workspace, path, true);
  if (!/^[a-f0-9]{40,64}$/.test(task.base)) throw new Error('Invalid merge base.');
  const listing = await command('git', ['ls-tree', '-z', task.base, '--', path], task.workspace, signal);
  if (listing.code !== 0) throw new Error('Cannot inspect merge base.');
  if (!listing.stdout) return null;
  if (!/^100(644|755) blob /.test(listing.stdout)) throw new Error('Merge base requires a regular text file.');
  const blob = await command('git', ['cat-file', '-p', task.base + ':' + path], task.workspace, signal);
  if (blob.code !== 0 || Buffer.byteLength(blob.stdout) > 100000 || blob.stdout.includes('\0')) {
    throw new Error('Merge base exceeds text-file limits.');
  }
  return blob.stdout;
}

async function mergeText(config, task, path, base, ours, theirs, signal) {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  if ([base, ours, theirs].some(value => value === null)) throw new Error('Unresolved add/delete conflict.');
  const root = join(config.stateDir, 'merges');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'merge-'));
  try {
    await Promise.all([['ours', ours], ['base', base], ['theirs', theirs]]
      .map(([name, content]) => writeFile(join(directory, name), content, { mode: 0o600 })));
    const result = await command('git', ['merge-file', '--stdout', '--diff3',
      '-L', path, '-L', 'base', '-L', path, join(directory, 'ours'),
      join(directory, 'base'), join(directory, 'theirs')], task.workspace, signal);
    if (result.code !== 0) throw new Error('Unresolved overlapping edits.');
    if (Buffer.byteLength(result.stdout) > 100000) throw new Error('Merged file exceeds 100 KB.');
    return result.stdout;
  } finally {
    if (!contained(root, directory)) throw new Error('Invalid merge cleanup path.');
    await rm(directory, { recursive: true, force: true });
  }
}

export async function mergeSnapshots(config, task, snapshots, signal, options = {}) {
  const files = Object.create(null);
  const bases = new Map();
  const resolvedFiles = new Set();
  const conflicts = [];
  for (const snapshot of snapshots) {
    for (const [path, content] of Object.entries(snapshot)) {
      signal?.throwIfAborted();
      if (!Object.hasOwn(files, path)) { files[path] = content; continue; }
      if (files[path] === content) continue;
      if (!bases.has(path)) bases.set(path, await baseContent(task, path, signal));
      try {
        files[path] = await mergeText(config, task, path, bases.get(path), files[path], content, signal);
        resolvedFiles.add(path);
      } catch (error) {
        signal?.throwIfAborted();
        conflicts.push({ path, reason: error.message, base: bases.get(path), ours: files[path], theirs: content });
      }
    }
  }
  if (conflicts.length && !options.collectConflicts) {
    const error = new Error('Dependency conflict in ' + conflicts.map(c => c.path).join(', ') + '; overlapping edits require review.');
    error.conflicts = conflicts.map(({ path, reason }) => ({ path, reason }));
    throw error;
  }
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) bytes += Buffer.byteLength(path) + Buffer.byteLength(content ?? '');
  if (bytes > 1000000 || Object.keys(files).length > 500) throw new Error('Combined changes exceed snapshot limits.');
  return { files, resolvedFiles: [...resolvedFiles], conflicts };
}
