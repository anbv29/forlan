import { git, readWorkspace, safePath } from './workspace.mjs';

// Use the guarded file reader so exported additions cannot pick up restricted paths.
export async function exportPatch(task) {
  const changed = await git(['diff', '--no-renames', '--name-only', '-z', task.base, '--', '.'], task.workspace);
  for (const path of changed.split('\0').filter(Boolean)) await safePath(task.workspace, path, true);
  const tracked = await git(['diff', '--no-ext-diff', '--no-textconv', '--binary', task.base, '--', '.'], task.workspace);
  const files = await git(['ls-files', '-z', '--others', '--exclude-standard'], task.workspace);
  const additions = [];
  for (const path of files.split('\0').filter(Boolean)) {
    const content = await readWorkspace(task.workspace, path);
    const lines = content ? content.split('\n') : [];
    const endsWithNewline = content.endsWith('\n');
    if (endsWithNewline) lines.pop();
    const a = JSON.stringify('a/' + path);
    const b = JSON.stringify('b/' + path);
    additions.push(`diff --git ${a} ${b}\nnew file mode 100644\n--- /dev/null\n+++ ${b}\n` +
      (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line + '\n').join('') +
        (endsWithNewline ? '' : '\\ No newline at end of file\n') : ''));
  }
  const patch = (tracked ? tracked + '\n' : '') + additions.join('');
  if (Buffer.byteLength(patch) > 150000) throw new Error('Patch exceeds 150 KB; export it with Git from the task worktree.');
  return { taskId: task.id, base: task.base, patch, bytes: Buffer.byteLength(patch),
    apply: 'Review and save as UTF-8, then run git apply --check followed by git apply in the target checkout.' };
}
