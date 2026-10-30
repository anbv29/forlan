let sequence = 0;

export function inProcessProvider(handler) {
  const original = globalThis.fetch;
  const baseUrl = 'http://127.0.0.1:1/fixture-' + (++sequence) + '/v1';
  const pending = new Set();
  globalThis.fetch = async (url, options) => {
    if (url !== baseUrl + '/chat/completions') return original(url, options);
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const cleanup = () => { pending.delete(abort); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Provider closed.')); };
      pending.add(abort);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      let status = 200;
      const headers = {};
      const response = {
        setHeader(name, value) { headers[name] = value; },
        writeHead(code) { status = code; },
        end(body) { cleanup(); resolve(new Response(body, { status, headers })); }
      };
      const request = { headers: Object.fromEntries(new Headers(options.headers)) };
      Promise.resolve().then(() => handler(request, response, JSON.parse(options.body)))
        .catch(error => { response.writeHead(500); response.end(error.message); });
    });
  };
  return { baseUrl, async close() {
    for (const abort of pending) abort();
    globalThis.fetch = original;
  } };
}
