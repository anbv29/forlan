import { isAbsolute } from 'node:path';

export function normalizeAgents(raw = {}, env = process.env) {
  const agents = Object.create(null);
  const entries = Object.entries(raw.agents ?? { byok: { kind: 'byok' } });
  if (!entries.length || entries.length > 20) throw new Error('Configure 1–20 agent profiles.');
  for (const [name, p] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || !p ||
      !['byok', 'codex', 'claude'].includes(p.kind)) throw new Error('Invalid agent profile.');
    if (p.kind !== 'byok' && (!Array.isArray(p.command) || !p.command.length ||
      p.command.some(a => typeof a !== 'string' || !a) || !isAbsolute(p.command[0]) ||
      /\.(cmd|bat|ps1)$/i.test(p.command[0]))) throw new Error('Use an absolute native executable or node plus a JS entry point.');
    if (p.readOnly !== undefined && typeof p.readOnly !== 'boolean') throw new Error('readOnly must be boolean.');
    if (p.model !== undefined && (typeof p.model !== 'string' || !p.model.trim())) throw new Error('Invalid agent model.');
    if (p.instruction !== undefined && (typeof p.instruction !== 'string' || p.instruction.length > 10000)) throw new Error('Invalid agent instruction.');
    if (p.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv)) throw new Error('Invalid key environment name.');
    if (p.apiKeyEnv && !env[p.apiKeyEnv]) throw new Error('Agent key environment variable is missing.');
    agents[name] = { kind: p.kind, command: p.command, model: p.model,
      instruction: p.instruction ?? '', readOnly: p.readOnly ?? false, apiKey: p.apiKeyEnv ? env[p.apiKeyEnv] : undefined };
  }
  const defaultAgent = raw.defaultAgent ?? entries[0][0];
  if (!Object.hasOwn(agents, defaultAgent)) throw new Error('Unknown defaultAgent.');
  const agentTimeoutMs = raw.agentTimeoutMs ?? 600000;
  if (!Number.isInteger(agentTimeoutMs) || agentTimeoutMs < 1000 || agentTimeoutMs > 1800000) throw new Error('agentTimeoutMs must be 1000–1800000.');
  if (raw.requireApproval !== undefined && typeof raw.requireApproval !== 'boolean') throw new Error('requireApproval must be boolean.');
  return { agents, defaultAgent, agentTimeoutMs, requireApproval: raw.requireApproval ?? true };
}

