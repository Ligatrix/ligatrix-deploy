// The reference service: three routes that a load balancer and an operator need,
// plus a page, and a shutdown that finishes in-flight requests before exiting.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reference service</title>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<main>
<h1>Reference service</h1>
<p>This is the reference service shipped with ligatrix-deploy. Replace it with your application;
keep the two probe endpoints.</p>
<ul>
<li><a href="/healthz">/healthz</a>: the process is alive</li>
<li><a href="/readyz">/readyz</a>: the process can serve traffic (its database answers)</li>
</ul>
</main>
</body>
</html>
`;

const CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1d2330;background:#f6f7f9}
main{max-width:40rem;margin:4rem auto;padding:0 1.5rem}
h1{font-size:1.6rem;margin:0 0 1rem}
a{color:#2453c9}
`;

function sendResponse(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  const payload = isJson ? `${JSON.stringify(body)}\n` : body;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : headers['content-type'],
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

export function createService({ config, logger, checkDependency, now = () => Date.now() }) {
  const startedAt = now();
  let draining = false;
  let shutdownPromise = null;

  // A response written while draining asks the client (nginx) not to reuse the
  // connection, including responses to requests that arrived before shutdown.
  const send = (res, status, body, headers = {}) =>
    sendResponse(res, status, body, draining ? { ...headers, connection: 'close' } : headers);

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    }

    switch (pathname) {
      case '/healthz':
        return send(res, 200, {
          status: 'ok',
          uptimeSeconds: Math.floor((now() - startedAt) / 1000),
        }, { 'cache-control': 'no-store' });

      case '/readyz': {
        if (draining) {
          return send(res, 503, { status: 'draining' }, { 'cache-control': 'no-store' });
        }
        let result;
        try {
          result = await checkDependency();
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        const status = result.ok ? 200 : 503;
        if (!result.ok) logger.warn('dependency check failed', { check: config.readyCheck, error: result.error });
        return send(res, status, {
          status: result.ok ? 'ready' : 'unavailable',
          checks: { [config.readyCheck]: result },
        }, { 'cache-control': 'no-store' });
      }

      case '/':
        return send(res, 200, PAGE, { 'content-type': 'text/html; charset=utf-8' });

      case '/assets/site.css':
        return send(res, 200, CSS, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        });

      default:
        return send(res, 404, { error: 'not_found' });
    }
  }

  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const path = req.url.split('?')[0];
      const fields = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      };
      // Probes arrive every few seconds; keep them out of the info stream.
      if (PROBE_PATHS.has(path) && res.statusCode < 500) logger.debug('request', fields);
      else logger.info('request', fields);
    });

    route(req, res).catch((error) => {
      logger.error('unhandled error', { requestId, error });
      if (!res.headersSent) send(res, 500, { error: 'internal_error', requestId });
      else res.destroy();
    });
  });

  // nginx keeps upstream connections open for up to 60 s; the app must keep them
  // longer, or nginx can reuse a socket the app has just closed and return a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        const address = server.address();
        logger.info('listening', {
          host: address.address,
          port: address.port,
          readyCheck: config.readyCheck,
          database: config.databaseUrlRedacted,
        });
        resolve(address);
      });
    });
  }

  function shutdown(reason = 'requested') {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    logger.info('shutdown started', { reason, drainDelayMs: config.drainDelayMs });

    shutdownPromise = new Promise((resolve) => {
      const force = setTimeout(() => {
        logger.warn('shutdown timeout reached, closing open connections', {
          timeoutMs: config.shutdownTimeoutMs,
        });
        server.closeAllConnections();
      }, config.shutdownTimeoutMs);
      force.unref();

      const stopAccepting = () => {
        server.close(() => {
          clearTimeout(force);
          logger.info('shutdown complete', { reason });
          resolve();
        });
        server.closeIdleConnections();
      };

      // Keep accepting during the drain delay so the proxy can see /readyz fail first.
      if (config.drainDelayMs > 0) setTimeout(stopAccepting, config.drainDelayMs).unref();
      else stopAccepting();
    });
    return shutdownPromise;
  }

  return {
    server,
    listen,
    shutdown,
    get draining() {
      return draining;
    },
  };
}
