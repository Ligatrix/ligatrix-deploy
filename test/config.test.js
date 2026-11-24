import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, redactUrl } from '../app/src/config.js';

test('defaults apply when the environment is empty', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.readyCheck, 'none');
  assert.equal(config.readyTarget, null);
  assert.equal(config.shutdownTimeoutMs, 10000);
  assert.ok(Object.isFrozen(config));
});

test('DATABASE_URL turns on the postgres readiness check and is redacted', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://app:s3cret@db:6543/app' });
  assert.equal(config.readyCheck, 'postgres');
  assert.deepEqual({ ...config.readyTarget }, { host: 'db', port: 6543 });
  assert.equal(config.databaseUrlRedacted, 'postgres://app:***@db:6543/app');
  assert.ok(!JSON.stringify(config).includes('s3cret'));
});

test('postgres port defaults to 5432', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://app@db/app' });
  assert.equal(config.readyTarget.port, 5432);
});

test('every problem is reported at once', () => {
  try {
    loadConfig({ PORT: 'eighty', LOG_LEVEL: 'verbose', SHUTDOWN_TIMEOUT_MS: '5' });
    assert.fail('expected ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 3);
    assert.match(error.message, /PORT must be a whole number/);
    assert.match(error.message, /LOG_LEVEL must be one of/);
    assert.match(error.message, /SHUTDOWN_TIMEOUT_MS must be between 100 and 120000/);
  }
});

test('out-of-range port is rejected', () => {
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT must be between 0 and 65535/);
});

test('negative and fractional numbers are rejected', () => {
  assert.throws(() => loadConfig({ READY_TIMEOUT_MS: '-5' }), /READY_TIMEOUT_MS must be a whole number/);
  assert.throws(() => loadConfig({ PORT: '3000.5' }), /PORT must be a whole number/);
});

test('a non-postgres DATABASE_URL is rejected', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://db/app' }), /must use postgres:\/\//);
  assert.throws(() => loadConfig({ DATABASE_URL: 'not a url' }), /not a valid URL/);
});

test('READY_CHECK=postgres without DATABASE_URL is rejected', () => {
  assert.throws(() => loadConfig({ READY_CHECK: 'postgres' }), /needs DATABASE_URL/);
});

test('READY_CHECK=tcp needs a host:port target', () => {
  assert.throws(() => loadConfig({ READY_CHECK: 'tcp' }), /needs READY_CHECK_TARGET/);
  assert.throws(() => loadConfig({ READY_CHECK: 'tcp', READY_CHECK_TARGET: 'cache' }), /must be host:port/);
  const config = loadConfig({ READY_CHECK: 'tcp', READY_CHECK_TARGET: 'cache:6379' });
  assert.deepEqual({ ...config.readyTarget }, { host: 'cache', port: 6379 });
});

test('READY_CHECK=none overrides a configured database', () => {
  const config = loadConfig({ READY_CHECK: 'NONE', DATABASE_URL: 'postgres://db/app' });
  assert.equal(config.readyCheck, 'none');
});

test('drain delay must be shorter than the shutdown timeout', () => {
  assert.throws(
    () => loadConfig({ DRAIN_DELAY_MS: '5000', SHUTDOWN_TIMEOUT_MS: '5000' }),
    /DRAIN_DELAY_MS must be shorter than SHUTDOWN_TIMEOUT_MS/,
  );
});

test('redactUrl leaves password-less URLs alone and survives garbage', () => {
  assert.equal(redactUrl('postgres://db/app'), 'postgres://db/app');
  assert.equal(redactUrl('::::'), '[unparseable]');
});
