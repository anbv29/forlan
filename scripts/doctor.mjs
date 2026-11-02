import { join } from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/core.mjs';
import { command } from '../src/workspace.mjs';
import { projectRoot } from './setup.mjs';

export async function diagnose(config) {
  const checks = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version }];
  for (const repository of config.repositories) {
    const result = await command('git', ['rev-parse', '--show-toplevel', '--verify', 'HEAD'], repository);
    // Git can print the root and HEAD together, so check the root separately.
    let rootMatches = false;
    if (result.code === 0) {
      try { rootMatches = await realpath(result.stdout.split(/\r?\n/)[0]) === repository; } catch {}
    }
    checks.push({ name: 'repository', repository, ok: result.code === 0 && rootMatches,
      detail: result.code === 0 ? (rootMatches ? 'Committed Git root' : 'Configure the repository root') : result.output.trim() });
  }
  for (const [name, profile] of Object.entries(config.agents)) {
    if (profile.kind === 'byok') continue;
    try {
      await access(profile.command[0], constants.X_OK);
      const result = await command(profile.command[0], [...profile.command.slice(1), '--version'], projectRoot, undefined, 15000);
      checks.push({ name: 'agent:' + name, ok: result.code === 0, detail: result.output.trim() });
    } catch (error) { checks.push({ name: 'agent:' + name, ok: false, detail: error.message }); }
  }
  return { ok: checks.every(check => check.ok), checks,
    warnings: [...(!config.checks.length ? ['No verification commands configured. Task completion does not mean tests passed.'] : []),
      'CLI availability is checked without inference. Provider authentication and live model access are not tested.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig({ ...process.env, FORLAN_CONFIG: process.env.FORLAN_CONFIG ?? join(projectRoot, 'config.local.json') });
    const report = await diagnose(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
