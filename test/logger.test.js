import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../app/src/logger.js';

function capture(options = {}) {
  const lines = [];
  const stream = { write: (chunk) => lines.push(JSON.parse(chunk)) };
  const clock = () => new Date('2026-01-02T03:04:05.000Z');
  return { lines, logger: createLogger({ stream, clock, ...options }) };
}

test('writes one JSON object per line with time, level and message', () => {
  const { lines, logger } = capture();
  logger.info('listening', { port: 3000 });
  assert.deepEqual(lines, [{ time: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'listening', port: 3000 }]);
});

test('drops entries below the configured level', () => {
  const { lines, logger } = capture({ level: 'warn' });
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  logger.error('d');
  assert.deepEqual(lines.map((l) => l.msg), ['c', 'd']);
});

test('serialises errors and carries child fields', () => {
  const { lines, logger } = capture();
  logger.child({ service: 'reference-app' }).error('failed', { error: new Error('boom') });
  assert.equal(lines[0].service, 'reference-app');
  assert.equal(lines[0].error.message, 'boom');
  assert.match(lines[0].error.stack, /Error: boom/);
});

test('rejects an unknown level', () => {
  assert.throws(() => createLogger({ level: 'loud' }), /Unknown log level/);
});
