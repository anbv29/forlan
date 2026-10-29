import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { loadConfig, safeError } from './core.mjs';
import { Runtime } from './runtime.mjs';

export function createServer(config) {
  const runtime = new Runtime(config);
  const server = new McpServer({ name: 'byok-agent-mcp', version: '0.1.0' });
  const id = { taskId: z.string().uuid() };
  const register = (name, description, inputSchema, handler, readOnlyHint = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint,
        idempotentHint: readOnlyHint, openWorldHint: true }
    }, async args => {
      try {
        const result = runtime.clean(await handler(args));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: safeError(error, config) }] };
      }
    });
  };

  register('get_configuration', 'Inspect configured repositories, model and checks. Never returns API keys.',
    {}, () => ({ repositories: config.repositories, model: config.model,
      checks: config.checks, maxSteps: config.maxSteps, maxConcurrent: config.maxConcurrent }), true);

  register('start_task', 'Start a BYOK coding task in a new Git worktree. Returns immediately. ' +
    'Sends repository files to the configured inference endpoint. Changes require human review.',
    { repository: z.string().min(1), goal: z.string().trim().min(1).max(20000) },
    ({ repository, goal }) => runtime.start(repository, goal));

  register('list_tasks', 'List the latest 100 persisted tasks.',
    {}, () => runtime.store.list(), true);

  register('get_task_status', 'Read a task, its branch, summary, error and verification results.',
    id, ({ taskId }) => runtime.store.get(taskId), true);

  register('get_task_events', 'Read at most 100 events after a sequence cursor. Poll using the last sequence.',
    { ...id, after: z.number().int().nonnegative().default(0) },
    ({ taskId, after }) => ({ events: runtime.store.events(taskId, after) }), true);

  register('get_task_diff', 'Review tracked changes and untracked file names after a task stops. ' +
    'New untracked file contents can be read with read_task_file.',
    id, ({ taskId }) => runtime.diff(taskId), true);

  register('read_task_file', 'Read a relative UTF-8 file from a stopped task worktree, at most 100 KB.',
    { ...id, path: z.string().min(1).max(1000) }, async ({ taskId, path }) => {
      const task = runtime.store.get(taskId);
      if (!task.workspace || runtime.active.has(taskId)) throw new Error('Task must have a stopped worktree.');
      const { readWorkspace } = await import('./workspace.mjs');
      return { path, content: await readWorkspace(task.workspace, path) };
    }, true);

  register('run_checks', 'Execute the owner-configured check commands in a stopped worktree. ' +
    'These commands execute repository code with the current OS account.',
    id, ({ taskId }) => runtime.checks(taskId));

  register('cancel_task', 'Request cancellation of an active task or check operation. Poll status afterward.',
    id, ({ taskId }) => runtime.cancel(taskId));

  let closePromise;
  const close = () => closePromise ??= runtime.close();
  server.onclose = () => { void close(); };
  return { server, runtime, close };
}

export async function main() {
  let app;
  try {
    app = createServer(loadConfig());
    const transport = new StdioServerTransport();
    const shutdown = async () => {
      await app.close();
      await app.server.close();
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    await app.server.connect(transport);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Server startup failed.');
    if (app) await app.close();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
