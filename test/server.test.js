import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../app/src/config.js';
import { createLogger } from '../app/src/logger.js';
import { createService } from '../app/src/server.js';

async function start({ env = {}, checkDependency = async () => ({ ok: true, latencyMs: 1 }) } = {}) {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'debug', ...env });
  const entries = [];
  const logger = createLogger({ level: 'debug', stream: { write: (l) => entries.push(JSON.parse(l)) } });
  const service = createService({ config, logger, checkDependency });
  const { port } = await service.listen();
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  return { service, url, entries, stop: () => service.shutdown('test') };
}

test('/healthz answers 200 without touching the dependency', async (t) => {
  let probed = false;
  const app = await start({ checkDependency: async () => { probed = true; return { ok: false }; } });
  t.after(app.stop);
  const res = await fetch(app.url('/healthz'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).status, 'ok');
  assert.equal(probed, false);
});

test('/readyz is 200 when the dependency answers', async (t) => {
  const app = await start({ env: { DATABASE_URL: 'postgres://db/app' } });
  t.after(app.stop);
  const res = await fetch(app.url('/readyz'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ready', checks: { postgres: { ok: true, latencyMs: 1 } } });
});

test('/readyz is 503 and logs a warning when the dependency fails', async (t) => {
  const app = await start({ checkDependency: async () => ({ ok: false, latencyMs: 3, error: 'ECONNREFUSED' }) });
  t.after(app.stop);
  const res = await fetch(app.url('/readyz'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'unavailable');
  assert.ok(app.entries.some((e) => e.level === 'warn' && e.error === 'ECONNREFUSED'));
});

test('/readyz is 503 when the dependency check throws', async (t) => {
  const app = await start({ checkDependency: async () => { throw new Error('resolver down'); } });
  t.after(app.stop);
  const res = await fetch(app.url('/readyz'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).checks.none.error, 'resolver down');
});

test('/ serves the HTML page and its stylesheet', async (t) => {
  const app = await start();
  t.after(app.stop);
  const page = await fetch(app.url('/'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<h1>Reference service<\/h1>/);
  const css = await fetch(app.url('/assets/site.css'));
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('unknown paths are 404 and other methods 405 with Allow', async (t) => {
  const app = await start();
  t.after(app.stop);
  assert.equal((await fetch(app.url('/nope'))).status, 404);
  const post = await fetch(app.url('/'), { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('HEAD returns headers without a body', async (t) => {
  const app = await start();
  t.after(app.stop);
  const res = await fetch(app.url('/healthz'), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('a valid X-Request-ID is echoed and logged; an invalid one is replaced', async (t) => {
  const app = await start();
  t.after(app.stop);
  const kept = await fetch(app.url('/'), { headers: { 'x-request-id': 'req-123.abc' } });
  assert.equal(kept.headers.get('x-request-id'), 'req-123.abc');
  const replaced = await fetch(app.url('/'), { headers: { 'x-request-id': 'bad id\twith spaces' } });
  assert.match(replaced.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const logged = app.entries.find((e) => e.msg === 'request' && e.requestId === 'req-123.abc');
  assert.equal(logged.status, 200);
  assert.equal(logged.level, 'info');
});

test('probe requests are logged at debug, not info', async (t) => {
  const app = await start();
  t.after(app.stop);
  await fetch(app.url('/healthz?x=1'));
  const entry = app.entries.find((e) => e.msg === 'request' && e.path === '/healthz');
  assert.equal(entry.level, 'debug');
});
