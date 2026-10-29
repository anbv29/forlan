import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { contained } from './core.mjs';

export function commandEnv() {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  return Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

export function command(executable, args, cwd, signal, timeout = 120000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, signal, shell: false,
      windowsHide: true, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let overflow = false;
    const timer = setTimeout(() => child.kill(), timeout);
    const collect = data => {
      output += data.toString();
      if (output.length > 200000) { overflow = true; output = output.slice(0, 200000); child.kill(); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, killedSignal) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, output, truncated: overflow, signal: killedSignal });
    });
  });
}

export async function git(args, cwd, signal) {
  const result = await command('git', ['-c', 'core.hooksPath=', ...args], cwd, signal);
  if (result.code !== 0) throw new Error('Git failed: ' + result.output.slice(0, 2000));
  return result.output.trimEnd();
}

export async function createWorktree(config, task, signal) {
  const root = await realpath(task.repository);
  if (!config.repositories.includes(root)) throw new Error('Repository is not configured.');
  const top = await realpath((await git(['rev-parse', '--show-toplevel'], root, signal)).trim());
  if (root !== top) throw new Error('Configure the repository root, not a subdirectory.');
  const base = (await git(['rev-parse', 'HEAD'], root, signal)).trim();
  const workspace = join(config.stateDir, 'worktrees', task.id);
  await mkdir(dirname(workspace), { recursive: true });
  const branch = 'byok/' + task.id;
  await git(['worktree', 'add', '-b', branch, workspace, base], root, signal);
  return { workspace: await realpath(workspace), branch, base };
}

export async function safePath(workspace, path, writing = false) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('Use a relative file path.');
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(p => p === '..' || p.toLowerCase() === '.git' || /^\.env($|\.)/i.test(p))) throw new Error('Restricted path.');
  const target = resolve(workspace, path);
  if (!contained(workspace, target) || target === workspace) throw new Error('Path outside workspace.');
  let current = workspace;
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index] || parts[index] === '.') continue;
    current = join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not accessible.');
      if (info.isFile() && info.nlink > 1) throw new Error('Hard links are not accessible.');
      if (!contained(workspace, await realpath(current))) throw new Error('Path escapes workspace.');
    } catch (error) {
      if (writing && error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function readWorkspace(workspace, path) {
  const target = await safePath(workspace, path);
  const info = await lstat(target);
  if (!info.isFile() || info.size > 100000) throw new Error('Read requires a file below 100 KB.');
  const data = await readFile(target);
  if (data.includes(0)) throw new Error('Binary files are not supported.');
  return data.toString('utf8');
}

export async function writeWorkspace(workspace, path, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 100000) throw new Error('Content exceeds 100 KB.');
  const target = await safePath(workspace, path, true);
  await mkdir(dirname(target), { recursive: true });
  await safePath(workspace, path, true);
  await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
  return { written: path };
}

export async function listWorkspace(workspace, signal) {
  const paths = await git(['ls-files', '--cached', '--others', '--exclude-standard'], workspace, signal);
  return paths.split('\n').filter(p => !/(^|\/)\.env($|\.)/i.test(p)).slice(0, 2000);
}

export async function diffWorkspace(task, signal) {
  const tracked = await git(['diff', '--no-ext-diff', '--no-textconv', task.base, '--', '.'], task.workspace, signal);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], task.workspace, signal);
  return { diff: tracked.slice(0, 150000), truncated: tracked.length > 150000,
    untracked: untracked ? untracked.split('\n') : [] };
}

export async function checksWorkspace(config, workspace, signal) {
  const results = [];
  for (const [executable, ...args] of config.checks) {
    signal?.throwIfAborted();
    results.push({ command: [executable, ...args], ...await command(executable, args, workspace, signal) });
  }
  return { configured: results.length > 0, passed: results.length > 0 && results.every(r => r.code === 0), results };
}
