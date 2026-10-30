import { createServer as httpServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.mjs';
import { Runtime } from './runtime.mjs';
import { loadConfig } from './core.mjs';
import { monitoring } from './monitoring.mjs';

export async function startService(config, { token, port = 8788 } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set BYOK_SERVICE_TOKEN to at least 32 characters.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid service port.');
  config = { ...config, secrets: [...(config.secrets ?? [config.apiKey]).filter(Boolean), token] };
  const runtime = new Runtime(config);
  const sessions = new Map();
  const respond = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = httpServer(async (req, res) => {
    try {
      const host = '127.0.0.1:' + server.address().port;
      if (req.headers.origin || req.headers.referer || req.headers.host !== host) {
        req.resume(); respond(res, 403, { error: 'Invalid origin or host.' }); return;
      }
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        req.resume(); respond(res, 401, { error: 'Unauthorized.' }); return;
      }
      if (req.url === '/health' && req.method === 'GET') {
        respond(res, 200, { active: runtime.active.size, automations: runtime.automations.health() }); return;
      }
      if (req.url === '/metrics' && req.method === 'GET') {
        respond(res, 200, monitoring(runtime)); return;
      }
      if (req.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method)) {
        req.resume(); respond(res, 404, { error: 'Not found.' }); return;
      }
      let body;
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          req.resume(); respond(res, 415, { error: 'Use application/json.' }); return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1000000) { respond(res, 413, { error: 'Request exceeds 1 MB.' }); return; }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      const id = req.headers['mcp-session-id'];
      let session = sessions.get(id);
      if (!session && !id && req.method === 'POST' && isInitializeRequest(body)) {
        if (sessions.size >= 8) { respond(res, 429, { error: 'Session limit reached.' }); return; }
        const app = createServer(config, { runtime });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => sessions.set(id, { app, transport }) });
        await app.server.connect(transport);
        const closed = transport.onclose;
        transport.onclose = () => { sessions.delete(transport.sessionId); closed?.(); };
        session = { app, transport };
      }
      if (!session) { respond(res, 404, { error: 'Initialize a new MCP session.' }); return; }
      await session.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) respond(res, 400, { error: 'Invalid service request.' });
      else res.end();
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { await runtime.close(); throw error; }
  let closing;
  const close = () => closing ??= (async () => {
    await Promise.allSettled([...sessions.values()].map(s => s.app.server.close()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await runtime.close();
  })();
  return { runtime, server, url: 'http://127.0.0.1:' + server.address().port, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await startService(loadConfig(), { token: process.env.BYOK_SERVICE_TOKEN,
      port: Number(process.env.BYOK_SERVICE_PORT ?? 8788) });
    console.error('BYOK background service listening at ' + app.url);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
