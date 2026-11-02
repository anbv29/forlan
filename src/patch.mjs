import { git, readWorkspace, safePath, command } from './workspace.mjs';

// Use the guarded file reader so exported additions cannot pick up restricted paths.
export async function exportPatch(task) {
  const changed = await git(['diff', '--no-renames', '--name-only', '-z', task.base, '--', '.'], task.workspace);
  for (const path of changed.split('\0').filter(Boolean)) await safePath(task.workspace, path, true);
  const tracked = await command('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', task.base, '--', '.'], task.workspace);
  if (tracked.code !== 0 || tracked.truncated) throw new Error('Tracked patch could not be exported completely.');
  const files = await git(['ls-files', '-z', '--others', '--exclude-standard'], task.workspace);
  const additions = [];
  for (const path of files.split('\0').filter(Boolean)) {
    await readWorkspace(task.workspace, path);
    const addition = await command('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path], task.workspace);
    if (![0, 1].includes(addition.code) || addition.truncated) throw new Error('New file patch could not be exported completely.');
    additions.push(addition.stdout);
  }
  const patch = tracked.stdout + additions.join('');
  if (Buffer.byteLength(patch) > 150000) throw new Error('Patch exceeds 150 KB; export it with Git from the task worktree.');
  return { taskId: task.id, base: task.base, patch, bytes: Buffer.byteLength(patch),
    apply: 'Review and save as UTF-8, then run git apply --check followed by git apply in the target checkout.' };
}
