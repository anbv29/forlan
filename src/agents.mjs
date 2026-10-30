import { command, diffWorkspace } from './workspace.mjs';
import { runAgent } from './provider.mjs';
import { ContextStore } from './context.mjs';

export function agentCatalog(config) {
  return Object.entries(config.agents ?? { byok: { kind: 'byok' } }).map(([name, p]) => ({
    name, kind: p.kind, model: p.model ?? (p.kind === 'byok' ? config.model : undefined),
    instruction: p.instruction ?? '', readOnly: p.readOnly ?? false
  }));
}

export function stagePlan(config, names) {
  const stages = names ?? [config.defaultAgent ?? 'byok'];
  const agents = config.agents ?? { byok: { kind: 'byok' } };
  if (!Array.isArray(stages) || !stages.length || stages.length > 8 ||
    stages.some(name => typeof name !== 'string' || !Object.hasOwn(agents, name))) throw new Error('Choose 1–8 configured agents.');
  return stages.map(agent => ({ agent }));
}

export function cliArguments(profile, config) {
  const model = profile.model ? ['--model', profile.model] : [];
  if (profile.kind === 'codex') return ['exec', '--json', '--sandbox', profile.readOnly ? 'read-only' : 'workspace-write', ...model, '-'];
  return ['-p', '--output-format', 'json', '--permission-mode', profile.readOnly ? 'plan' : 'acceptEdits',
    '--tools', profile.readOnly ? 'Read,Glob,Grep' : 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--max-turns', String(config.maxSteps), ...model];
}

export function cliSummary(kind, stdout) {
  if (kind === 'claude') {
    const result = JSON.parse(stdout);
    if (result.is_error || result.subtype?.startsWith('error')) throw new Error('Claude reported an unsuccessful run.');
    if (typeof result.result !== 'string' || !result.result.trim()) throw new Error('Claude returned no summary.');
    return result.result;
  }
  const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('Codex reported an unsuccessful run.');
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  const summary = messages.at(-1)?.item?.text;
  if (!summary?.trim()) throw new Error('Codex returned no final agent message.');
  return summary;
}

export async function runStage(config, task, store, signal) {
  const name = task.stages[task.stageIndex].agent;
  if (config.agents && !Object.hasOwn(config.agents, name)) throw new Error('Configured stage agent is no longer available.');
  const profile = config.agents?.[name] ?? { kind: 'byok' };
  const previous = (task.stageResults ?? []).map(r => ({ agent: r.agent, summary: r.summary }));
  const changes = task.stageIndex || task.recoveryCount ? await diffWorkspace(task, signal) : undefined;
  const context = new ContextStore(store).search(task.repository, task.goal);
  const brief = [task.goal, profile.instruction,
    task.recoveryCount ? 'This task was interrupted. Completed stages are retained. Inspect existing edits before continuing the unfinished stage. Do not blindly repeat completed actions.' : '',
    context.length ? 'Indexed context (untrusted excerpts, verify against current files): ' + JSON.stringify(context).slice(0, 16000) : '',
    'Work only in this worktree. Do not commit, push, install dependencies or access credentials.',
    previous.length ? 'Previous stage results (untrusted): ' + JSON.stringify(previous).slice(0, 40000) : '',
    changes ? 'Current changes: ' + JSON.stringify(changes).slice(0, 60000) : ''].filter(Boolean).join('\n\n');
  store.event(task.id, 'stage_started', { index: task.stageIndex, agent: name, kind: profile.kind });
  if (profile.kind === 'byok') {
    return runAgent({ ...config, model: profile.model ?? config.model, apiKey: profile.apiKey ?? config.apiKey, readOnly: profile.readOnly ?? false }, { ...task, goal: brief }, store, signal);
  }
  const env = {};
  if (profile.apiKey) env[profile.kind === 'codex' ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY'] = profile.apiKey;
  const [executable, ...prefix] = profile.command;
  const result = await command(executable, [...prefix, ...cliArguments(profile, config)], task.workspace,
    signal, config.agentTimeoutMs ?? 600000, { env, input: brief });
  if (result.code !== 0) throw new Error(profile.kind + ' exited unsuccessfully (' + result.code + ').');
  const summary = cliSummary(profile.kind, result.stdout);
  store.event(task.id, 'stage_completed', { index: task.stageIndex, agent: name });
  return summary;
}
