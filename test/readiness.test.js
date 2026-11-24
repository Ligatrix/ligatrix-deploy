import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkPostgres, checkTcp, dependencyCheckFor } from '../app/src/readiness.js';

async function fakeServer(onConnection) {
  const server = net.createServer(onConnection);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function closedPort() {
  const { port, close } = await fakeServer(() => {});
  await close();
  return port;
}

test('postgres probe succeeds when the server answers the SSLRequest with N', async () => {
  let received;
  const fake = await fakeServer((socket) => socket.once('data', (data) => {
    received = data;
    socket.write('N');
  }));
  const result = await checkPostgres({ host: '127.0.0.1', port: fake.port, timeoutMs: 1000 });
  await fake.close();
  assert.equal(result.ok, true);
  assert.equal(typeof result.latencyMs, 'number');
  assert.deepEqual([...received], [0, 0, 0, 8, 4, 210, 22, 47]);
});

test('postgres probe fails when something else is listening', async () => {
  const fake = await fakeServer((socket) => socket.once('data', () => socket.write('HTTP/1.1 400\r\n')));
  const result = await checkPostgres({ host: '127.0.0.1', port: fake.port, timeoutMs: 1000 });
  await fake.close();
  assert.equal(result.ok, false);
  assert.match(result.error, /unexpected reply 0x48/);
});

test('postgres probe times out when the server never answers', async () => {
  const sockets = [];
  const fake = await fakeServer((socket) => sockets.push(socket));
  const result = await checkPostgres({ host: '127.0.0.1', port: fake.port, timeoutMs: 100 });
  sockets.forEach((s) => s.destroy());
  await fake.close();
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 100 ms/);
});

test('tcp probe reports a refused connection', async () => {
  const result = await checkTcp({ host: '127.0.0.1', port: await closedPort(), timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ECONNREFUSED');
});

test('tcp probe succeeds on an open port', async () => {
  const fake = await fakeServer((socket) => socket.end());
  const result = await checkTcp({ host: '127.0.0.1', port: fake.port });
  await fake.close();
  assert.equal(result.ok, true);
});

test('dependencyCheckFor skips the probe when no check is configured', async () => {
  const check = dependencyCheckFor({ readyCheck: 'none', readyTarget: null, readyTimeoutMs: 100 });
  assert.deepEqual(await check(), { ok: true, latencyMs: 0, skipped: true });
});
