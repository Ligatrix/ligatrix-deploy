// Dependency probes for /readyz, written against node:net so the service has no
// runtime dependencies. The Postgres probe sends the protocol's SSLRequest packet:
// a real server answers with a single byte, 'S' or 'N', which proves something that
// speaks Postgres is listening, not merely that a port is open. It never logs in,
// so the probe needs no credentials and cannot exhaust the connection limit for long.

import net from 'node:net';

const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

function probe({ host, port, timeoutMs, onConnect, onData }) {
  const started = process.hrtime.bigint();
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1_000_000n);

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok ? { ok: true, latencyMs: elapsed() } : { ok: false, latencyMs: elapsed(), error });
    };

    const timer = setTimeout(() => finish(false, `timed out after ${timeoutMs} ms`), timeoutMs);

    socket.once('connect', () => onConnect(socket, finish));
    socket.on('data', (chunk) => onData?.(chunk, finish));
    socket.once('error', (error) => finish(false, error.code || error.message));
    socket.once('close', () => finish(false, 'connection closed before a reply'));
  });
}

/** Succeeds when a TCP connection can be opened. */
export function checkTcp({ host, port, timeoutMs = 1000 }) {
  return probe({
    host,
    port,
    timeoutMs,
    onConnect: (_socket, finish) => finish(true),
  });
}

/** Succeeds when the peer answers a Postgres SSLRequest with 'S' or 'N'. */
export function checkPostgres({ host, port, timeoutMs = 1000 }) {
  return probe({
    host,
    port,
    timeoutMs,
    onConnect: (socket) => socket.write(SSL_REQUEST),
    onData: (chunk, finish) => {
      const reply = String.fromCharCode(chunk[0]);
      if (reply === 'S' || reply === 'N') finish(true);
      else finish(false, `unexpected reply 0x${chunk[0].toString(16).padStart(2, '0')}`);
    },
  });
}

/** Pick the probe described by the configuration. */
export function dependencyCheckFor(config) {
  const { readyCheck, readyTarget, readyTimeoutMs } = config;
  if (readyCheck === 'none') return async () => ({ ok: true, latencyMs: 0, skipped: true });
  const fn = readyCheck === 'postgres' ? checkPostgres : checkTcp;
  return () => fn({ ...readyTarget, timeoutMs: readyTimeoutMs });
}
