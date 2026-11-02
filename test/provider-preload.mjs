import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = process.env.BYOK_TEST_PROVIDER_DIR;
const endpoint = process.env.BYOK_TEST_PROVIDER_URL;
if (!directory || !isAbsolute(directory) || !endpoint) throw new Error('Inference fixture configuration is missing.');

globalThis.fetch = async (url, options) => {
  if (String(url) !== endpoint + '/chat/completions') throw new Error('Unexpected URL in the stdio inference fixture.');
  const id = randomUUID();
  const request = join(directory, id + '.request.json');
  const response = join(directory, id + '.response.json');
  const signal = options.signal;
  const cleanup = async path => {
    try { await unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  try {
    signal?.throwIfAborted();
    await writeFile(request + '.tmp', JSON.stringify({
      headers: Object.fromEntries(new Headers(options.headers)), body: JSON.parse(options.body)
    }));
    await rename(request + '.tmp', request);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const result = JSON.parse(await readFile(response, 'utf8'));
        return new Response(result.body, { status: result.status, headers: result.headers });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The stdio inference fixture did not respond within 10 seconds.');
  } finally {
    await Promise.all([request, request + '.tmp', response].map(cleanup));
  }
};
