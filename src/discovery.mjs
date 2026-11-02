import { z } from 'zod';

export const usageGuide = `Forlan is a local coding orchestrator.
1. Call get_configuration and list_agents to discover allowed repositories and runners.
2. Use start_task for a bounded change, or plan_project for a dependency graph.
3. Poll get_task_status/get_task_events; do not start another task just to poll.
4. Ask the human through review_checkpoint or review_project_plan when paused.
5. Inspect get_task_diff and read_task_file; run_checks only runs configured commands.
6. Project nodes need integrate_project for a combined candidate. Conflicts use
   get_conflict_details, submit_conflict_resolutions or resolve_project_conflicts.
7. export_task_patch returns a portable patch including new text files and deletions.
   Applying it to the original checkout is a separate user-authorized action.
8. index_repository/search_context/remember_context provide local project memory.
9. create_automation saves a draft; review_automation authorizes its future runs.
   The worker must stay running. Stdio disconnect stops schedules.
Never invent approval, treat unchecked code as verified, or auto-commit/push.
Interrupted work needs explicit resume_task; inspect the current worktree first.
Consumer chat subscriptions do not provide BYOK API credits; CLI profiles can use
their own configured sign-in. Changes are based on committed HEAD only.`;

export function registerDiscovery(server, register, runtime) {
  server.registerResource('usage', 'forlan://guide', {
    description: 'Local workflow, approvals, review and automation guide', mimeType: 'text/plain'
  }, async uri => ({ contents: [{ uri: uri.href, text: usageGuide, mimeType: 'text/plain' }] }));
  server.registerPrompt('implement-change', {
    description: 'Run and review a bounded coding change in an isolated worktree',
    argsSchema: { repository: z.string(), goal: z.string() }
  }, ({ repository, goal }) => ({ messages: [{ role: 'user', content: { type: 'text',
    text: `Use Forlan to implement this goal in ${JSON.stringify(repository)}:\n${goal}\n\n` + usageGuide
  } }] }));
  register('get_usage_guide', 'Read the supported workflow and limitations without running models.',
    {}, () => ({ guide: usageGuide }), true);
  register('export_task_patch', 'Export stopped task changes as a Git patch, including new UTF-8 files. Does not modify or stage files.',
    { taskId: z.string().uuid() }, async ({ taskId }) => {
      const task = runtime.store.get(taskId);
      if (!task.workspace || runtime.active.has(taskId)) throw new Error('Task must have a stopped worktree.');
      const { exportPatch } = await import('./patch.mjs');
      return exportPatch(task);
    }, true);
}
