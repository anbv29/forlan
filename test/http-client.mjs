import { Agent, request as httpRequest } from 'node:http';
import { Duplex, Readable } from 'node:stream';

function connectionPair() {
  let client, server;
  const endpoint = peer => new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, _encoding, done) {
      const target = peer();
      if (target.destroyed) { done(new Error('HTTP fixture connection is closed.')); return; }
      target.push(Buffer.from(chunk));
      done();
    },
    final(done) { if (!peer().destroyed) peer().push(null); done(); },
    destroy(error, done) { if (!peer().destroyed) peer().destroy(); done(error); }
  });
  client = endpoint(() => server);
  server = endpoint(() => client);
  for (const socket of [client, server]) {
    socket.remoteAddress = '127.0.0.1';
    socket.remoteFamily = 'IPv4';
    socket.setTimeout = (_timeout, callback) => { if (callback) socket.once('timeout', callback); return socket; };
    socket.setNoDelay = socket.setKeepAlive = socket.ref = socket.unref = () => socket;
  }
  return { client, server };
}

export function httpFetch(server) {
  if (process.env.BYOK_TEST_IN_PROCESS !== '1') return globalThis.fetch.bind(globalThis);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => {
    const pair = connectionPair();
    server.emit('connection', pair.server);
    return pair.client;
  };
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== server.address()?.port) {
      throw new Error('HTTP fixture requests must target their own server.');
    }
    const body = Buffer.from(await request.arrayBuffer());
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(url, { method: request.method, headers: Object.fromEntries(request.headers),
        signal: request.signal, agent }, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
        }
        const empty = request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), {
          status: incoming.statusCode, statusText: incoming.statusMessage, headers
        }));
      });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  };
  fetch.close = () => agent.destroy();
  return fetch;
}
