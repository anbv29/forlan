import { existsSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command } from '../src/workspace.mjs';
import { contained, loadConfig } from '../src/core.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function setup(args = process.argv.slice(2)) {
  const allowed = new Set(['--repository', '--state-dir', '--codex-entry', '--config', '--register']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key)) throw new Error('Unknown option: ' + key);
    if (key === '--register') values[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + key);
      values[key] = args[++i];
    }
  }
  const configPath = resolve(values['--config'] ?? join(projectRoot, 'config.local.json'));
  const codexEntry = resolve(values['--codex-entry'] ?? join(process.env.APPDATA ?? join(homedir(), '.local'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  if (!existsSync(codexEntry)) throw new Error('Codex entry point not found. Pass --codex-entry with the absolute codex.js path.');
  if (!existsSync(configPath)) {
    if (!values['--repository']) throw new Error('Pass --repository with the absolute path to a committed Git repository.');
    const repository = await realpath(resolve(values['--repository']));
    const stateDir = resolve(values['--state-dir'] ?? join(homedir(), '.byok-agent-mcp'));
    const raw = { repositories: [repository], stateDir, requireApproval: true,
      defaultAgent: 'codex', maxConcurrent: 2, maxSteps: 20, agentTimeoutMs: 600000,
      agents: { codex: { kind: 'codex', command: [process.execPath, codexEntry] },
        reviewer: { kind: 'codex', command: [process.execPath, codexEntry], readOnly: true,
          instruction: 'Review the implementation. Report correctness defects, regressions and verification gaps with file references.' } },
      checks: [] };
    if (contained(repository, stateDir)) throw new Error('stateDir must be outside repositories.');
    await writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  loadConfig({ ...process.env, BYOK_CONFIG: configPath });
  const registration = ['mcp', 'add', 'byok-agent', '--env', 'BYOK_CONFIG=' + configPath,
    '--', process.execPath, join(projectRoot, 'src', 'server.mjs')];
  if (values['--register']) {
    const result = await command(process.execPath, [codexEntry, ...registration], projectRoot);
    if (result.code !== 0) throw new Error('Configuration created, but Codex registration failed:\n' + result.output);
    console.log(result.output.trim());
  }
  console.log(JSON.stringify({ config: configPath, registered: !!values['--register'],
    command: 'codex.cmd', args: registration, next: 'npm.cmd run doctor; npm.cmd run smoke' }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await setup(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
