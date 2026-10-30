import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function webhookConfig(raw, env = process.env) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) {
    throw new Error('automationWebhook requires a port from 0 to 65535.');
  }
  const tokenEnv = raw.tokenEnv ?? 'AUTOMATION_EVENT_TOKEN';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv) || typeof env[tokenEnv] !== 'string' || env[tokenEnv].length < 32) {
    throw new Error('Set a webhook token environment variable containing at least 32 characters.');
  }
  return { port: raw.port, token: env[tokenEnv] };
}

export class EventListener {
  constructor(engine, config) {
    this.engine = engine;
    this.config = config;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.maxConnections = 16;
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 5000;
    this.server.keepAliveTimeout = 1000;
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    this.ready = new Promise(resolve => {
      this.server.once('error', () => { this.error = 'Event listener could not bind the configured port.'; resolve(); });
      this.server.listen(config.port, '127.0.0.1', resolve);
    });
  }

  status() {
    const address = this.server.address();
    return { enabled: true, host: '127.0.0.1', port: address?.port ?? null, error: this.error ?? null };
  }

  respond(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }

  authorized(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.config.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async handle(req, res) {
    try {
      const port = this.server.address()?.port;
      if (req.headers.origin || req.headers.referer ||
        !['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) {
        req.resume(); this.respond(res, 403, { error: 'Invalid request origin or host.' }); return;
      }
      if (req.method !== 'POST' || req.url !== '/events') {
        req.resume(); this.respond(res, 404, { error: 'Not found.' }); return;
      }
      if (!this.authorized(req.headers.authorization)) {
        req.resume(); this.respond(res, 401, { error: 'Unauthorized.' }); return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        req.resume(); this.respond(res, 415, { error: 'Use application/json.' }); return;
      }
      if (Number(req.headers['content-length'] ?? 0) > 65536) {
        req.resume(); this.respond(res, 413, { error: 'Event body exceeds 64 KB.' }); return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) {
          this.respond(res, 413, { error: 'Event body exceeds 64 KB.' }); return;
        }
        chunks.push(chunk);
      }
      const result = this.engine.event(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      this.respond(res, 202, result);
    } catch {
      if (!res.headersSent) this.respond(res, 400, { error: 'Invalid event request.' });
      else res.end();
    }
  }

  async close() {
    await this.ready;
    if (!this.server.listening) return;
    await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
  }
}
