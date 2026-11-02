import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function probeLoopback() {
  const server = createServer((_req, res) => { res.end('forlan-probe'); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const response = await fetch('http://127.0.0.1:' + server.address().port, { signal: AbortSignal.timeout(2000) });
    if (!response.ok || await response.text() !== 'forlan-probe') throw new Error('Unexpected loopback probe response.');
    return { available: true };
  } catch (error) {
    const code = error.cause?.code ?? error.code;
    if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(code)) throw error;
    return { available: false, reason: code };
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

export async function selectTestMode({ mode = 'auto', ci = false, probe = probeLoopback } = {}) {
  if (!['auto', 'network', 'in-process'].includes(mode)) throw new Error('Unknown test mode.');
  if (mode === 'in-process') return { mode, reason: 'explicitly requested' };
  const capability = await probe();
  if (capability.available) return { mode: 'network', reason: 'loopback probe passed' };
  if (mode === 'network' || ci) throw new Error('Socket tests require loopback access (' + capability.reason + '). ' +
    'Run on an unrestricted machine; use npm run test:portable for fixture and stdio checks here.');
  return { mode: 'in-process', reason: 'loopback denied: ' + capability.reason };
}

export async function runTests(args = process.argv.slice(2)) {
  const modes = args.filter(arg => ['--network', '--in-process'].includes(arg));
  if (modes.length > 1) throw new Error('Choose only one test mode.');
  const mode = modes[0] === '--network' ? 'network' : modes[0] === '--in-process' ||
    process.env.BYOK_TEST_IN_PROCESS === '1' ? 'in-process' : 'auto';
  const selected = await selectTestMode({ mode, ci: !!process.env.CI });
  console.error('Test mode: ' + selected.mode + ' (' + selected.reason + ').');
  if (selected.mode === 'in-process') console.error('Socket-only checks will be explicitly skipped. Network CI must run test:network.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort()
    .map(name => join(root, 'test', name));
  const forwarded = args.filter(arg => !['--network', '--in-process'].includes(arg));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=30000', ...forwarded, ...files], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, BYOK_TEST_IN_PROCESS: selected.mode === 'in-process' ? '1' : '0' }
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
