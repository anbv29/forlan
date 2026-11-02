import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { httpFetch } from './http-client.mjs';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fetch = httpFetch(server);
  return { server, fetch, url: 'http://127.0.0.1:' + server.address().port,
    async close() {
      fetch.close?.();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}

test('HTTP test connection preserves parsed request headers URLs and body bytes', async () => {
  const app = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, header: req.headers['x-fixture'], body }));
  });
  try {
    const response = await app.fetch(app.url + '/echo?value=a%20b', { method: 'POST',
      headers: { 'X-Fixture': 'parsed-header' }, body: 'café\nbytes' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: 'POST', url: '/echo?value=a%20b',
      header: 'parsed-header', body: 'café\nbytes' });
  } finally { await app.close(); }
});

test('HTTP streaming cancellation reaches the server connection', { timeout: 5000 }, async () => {
  let closed;
  const app = await listen((_req, res) => {
    closed = once(res, 'close', { signal: AbortSignal.timeout(3000) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: connected\n\n');
  });
  const controller = new AbortController();
  try {
    const response = await app.fetch(app.url + '/stream', { signal: controller.signal });
    assert.match(new TextDecoder().decode((await response.body.getReader().read()).value), /connected/);
    controller.abort();
    await closed;
  } finally { controller.abort(); await app.close(); }
});
