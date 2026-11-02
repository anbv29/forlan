#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Forlan, local coding-agent orchestration through MCP.

Usage: forlan [--config PATH] COMMAND [OPTIONS]

  start     Run the stdio MCP server (default)
  service   Run the authenticated background HTTP worker
  setup     Create configuration, optionally register with Codex
  doctor    Check repositories and installed coding agents
  smoke     Check the real stdio MCP connection without inference

First run: forlan setup --repository C:\\path\\to\\repository
Then: forlan doctor
Use forlan setup --register to register the server with Codex.
API credentials belong in environment variables, never command arguments.
`;

const args = process.argv.slice(2);
if (args[0] === '--config') {
  args.shift();
  if (!args[0] || args[0].startsWith('--')) { console.error('Provide a path after --config.'); process.exit(1); }
  process.env.BYOK_CONFIG = resolve(args.shift());
}
const name = args.shift() ?? 'start';
if (['--help', '-h', 'help'].includes(name)) process.stdout.write(help);
else if (name === '--version') console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
else {
  const entries = { start: './server.mjs', service: './service.mjs', setup: '../scripts/setup.mjs',
    doctor: '../scripts/doctor.mjs', smoke: '../scripts/smoke.mjs' };
  if (!Object.hasOwn(entries, name)) {
    console.error('Unknown command: ' + name + '\nRun forlan --help for usage.');
    process.exitCode = 1;
  } else {
    if (name === 'setup' && process.env.BYOK_CONFIG && !args.includes('--config')) args.unshift('--config', process.env.BYOK_CONFIG);
    const child = spawn(process.execPath, [fileURLToPath(new URL(entries[name], import.meta.url)), ...args],
      { stdio: 'inherit', windowsHide: true });
    const stop = () => child.kill();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.exitCode = code ?? 1;
    });
  }
}
