import { z } from 'zod';

export function monitoring(runtime) {
  const db = runtime.store.db;
  const statuses = Object.fromEntries(db.prepare(`SELECT json_extract(data, '$.status') AS status,
    COUNT(*) AS count FROM tasks GROUP BY status`).all().map(row => [row.status, row.count]));
  const usage = db.prepare(`SELECT task, data FROM events
    WHERE json_extract(data, '$.kind') = 'usage' ORDER BY seq`).all();
  const totals = { inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, costReports: 0, usageReports: usage.length };
  const tasks = new Map();
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  for (const row of usage) {
    const detail = JSON.parse(row.data).detail;
    const task = tasks.get(row.task) ?? { taskId: row.task, inputTokens: 0, outputTokens: 0,
      reportedCostUsd: 0, costReports: 0 };
    const input = number(detail.prompt_tokens ?? detail.input_tokens);
    const output = number(detail.completion_tokens ?? detail.output_tokens);
    const cost = number(detail.cost_usd);
    const hasCost = typeof detail.cost_usd === 'number' && Number.isFinite(detail.cost_usd) && detail.cost_usd >= 0;
    task.inputTokens += input;
    task.outputTokens += output;
    task.reportedCostUsd += cost;
    task.costReports += Number(hasCost);
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.reportedCostUsd += cost;
    totals.costReports += Number(hasCost);
    tasks.set(row.task, task);
  }
  const recentFailures = db.prepare(`SELECT data FROM tasks
    WHERE json_extract(data, '$.status') IN ('failed', 'checks_failed', 'integration_conflict', 'interrupted')
    ORDER BY rowid DESC LIMIT 20`).all().map(row => {
    const task = JSON.parse(row.data);
    return { taskId: task.id, status: task.status, error: task.error, updatedAt: task.updatedAt };
  });
  return runtime.clean({ at: new Date().toISOString(), uptimeSeconds: process.uptime(),
    active: [...runtime.active.keys()], maxConcurrent: runtime.config.maxConcurrent, statuses,
    process: { pid: process.pid, ...process.memoryUsage() },
    usage: { ...totals, costCoverage: 'Only explicitly reported USD amounts are summed. Missing reports are unknown, not free.',
      tasks: [...tasks.values()] }, recentFailures, automations: runtime.automations.health() });
}

export function registerMonitoringTools(register, runtime) {
  register('get_runtime_metrics', 'Inspect task counts, active work, process memory, failures, reported tokens and costs. ' +
    'Missing usage or cost reports are unknown. This does not query provider billing.',
    {}, () => monitoring(runtime), true);
  register('get_activity', 'Read the durable status and execution event feed across all tasks.',
    { after: z.number().int().nonnegative().default(0) }, ({ after }) => ({
      events: runtime.store.db.prepare('SELECT seq, task, data FROM events WHERE seq > ? ORDER BY seq LIMIT 100')
        .all(after).map(row => ({ sequence: row.seq, taskId: row.task, ...JSON.parse(row.data) }))
    }), true);
}
