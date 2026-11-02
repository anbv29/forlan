import { mkdtemp, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from '../src/core.mjs';

export async function providerBridge(handler, baseUrl) {
  const root = resolve('work');
  const directory = await mkdtemp(join(root, 'provider-bridge-'));
  const seen = new Set();
  let closed = false;
  let polling = false;
  const handle = async file => {
    const request = JSON.parse(await readFile(join(directory, file), 'utf8'));
    let status = 200;
    const headers = {};
    let response;
    const res = {
      setHeader(name, value) { headers[name] = value; },
      writeHead(code) { status = code; },
      end(body) { response = { status, headers, body: String(body ?? '') }; }
    };
    try { await handler({ url: '/v1/chat/completions', headers: request.headers }, res, request.body); }
    catch (error) { status = 500; res.end(error.message); }
    if (closed || !response) return;
    const target = join(directory, file.replace('.request.json', '.response.json'));
    await writeFile(target + '.tmp', JSON.stringify(response));
    if (!closed) await rename(target + '.tmp', target);
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      for (const file of await readdir(directory)) {
        if (closed) break;
        if (!file.endsWith('.request.json') || seen.has(file)) continue;
        seen.add(file);
        await handle(file);
      }
    } catch (error) { if (!closed) failure = error; }
    finally { polling = false; }
  };
  let failure;
  const timer = setInterval(() => { void poll(); }, 10);
  timer.unref();
  return {
    args: ['--import', pathToFileURL(resolve('test/provider-preload.mjs')).href],
    env: { BYOK_TEST_PROVIDER_DIR: directory, BYOK_TEST_PROVIDER_URL: baseUrl },
    async close() {
      closed = true;
      clearInterval(timer);
      if (!contained(root, directory)) throw new Error('Invalid fixture cleanup path.');
      await rm(directory, { recursive: true, force: true });
      if (failure) throw failure;
    }
  };
}
