import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../app/src/config.js';
import { createLogger } from '../app/src/logger.js';
import { createService } from '../app/src/server.js';
import { runHealthcheck } from '../app/src/healthcheck.js';

const MAIN = fileURLToPath(new URL('../app/src/main.js', import.meta.url));
const silent = createLogger({ level: 'error', stream: { write() {} } });

async function start(env, checkDependency) {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', ...env });
  const service = createService({ config, logger: silent, checkDependency });
  const { port } = await service.listen();
  return { service, port };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('an in-flight request completes before shutdown resolves', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { service, port } = await start({}, async () => { await gate; return { ok: true, latencyMs: 0 }; });

  const inflight = get(port, '/readyz');
  await new Promise((r) => setTimeout(r, 50));
  let done = false;
  const stopping = service.shutdown('test').then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, 'shutdown must wait for the in-flight request');

  release();
  const res = await inflight;
  await stopping;
  assert.equal(res.status, 200);
  assert.equal(res.headers.connection, 'close');
  await assert.rejects(get(port, '/healthz'), /ECONNREFUSED/);
});

test('during the drain delay /readyz reports draining while connections are still accepted', async () => {
  const { service, port } = await start({ DRAIN_DELAY_MS: '300' }, async () => ({ ok: true }));
  const stopping = service.shutdown('test');
  assert.equal(service.draining, true);
  const ready = await get(port, '/readyz');
  assert.equal(ready.status, 503);
  assert.equal(JSON.parse(ready.body).status, 'draining');
  const live = await get(port, '/healthz');
  assert.equal(live.status, 200);
  await stopping;
});

test('shutdown closes stuck connections once the timeout passes', async () => {
  const { service, port } = await start({ SHUTDOWN_TIMEOUT_MS: '200' }, () => new Promise(() => {}));
  const stuck = get(port, '/readyz');
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  await service.shutdown('test');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2000, `took ${elapsed} ms`);
  await assert.rejects(stuck, /socket hang up|ECONNRESET/);
});

test('calling shutdown twice returns the same promise', async () => {
  const { service } = await start({}, async () => ({ ok: true }));
  assert.equal(service.shutdown('a'), service.shutdown('b'));
  await service.shutdown('c');
});

function runMain(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  let buffer = '';
  const listeners = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const entry = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      lines.push(entry);
      listeners.forEach((fn) => fn(entry));
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = (msg) => new Promise((resolve) => {
    const found = lines.find((l) => l.msg === msg);
    if (found) resolve(found);
    else listeners.push((l) => l.msg === msg && resolve(l));
  });
  return { child, lines, exited, waitFor };
}

test('the process exits 0 after SIGTERM and logs the shutdown', async () => {
  const run = runMain({ LOG_LEVEL: 'info' });
  const listening = await run.waitFor('listening');
  assert.equal(await runHealthcheck({ port: listening.port }), 0);
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 0);
  const messages = run.lines.map((l) => l.msg);
  assert.deepEqual(messages.slice(-2), ['shutdown started', 'shutdown complete']);
  assert.equal(run.lines.at(-1).reason, 'SIGTERM');
});

test('the process exits 78 with every problem when configuration is invalid', async () => {
  const run = runMain({ PORT: 'x', LOG_LEVEL: 'loud' });
  assert.equal(await run.exited, 78);
  assert.equal(run.lines[0].msg, 'invalid configuration');
  assert.equal(run.lines[0].problems.length, 2);
});

test('the container healthcheck fails when nothing is listening or the status is not 200', async () => {
  const { service, port } = await start({}, async () => ({ ok: true }));
  assert.equal(await runHealthcheck({ port, path: '/missing' }), 1);
  await service.shutdown('test');
  assert.equal(await runHealthcheck({ port, timeoutMs: 500 }), 1);
});
