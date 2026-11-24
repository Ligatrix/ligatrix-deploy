// Configuration is read once, from the environment, and validated as a whole.
// Every problem is reported together so a bad deploy fails with one clear message
// instead of a crash loop that reveals one missing variable at a time.

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const READY_CHECKS = Object.freeze(['none', 'tcp', 'postgres']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function readInt(env, name, fallback, { min, max }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    problems.push(`${name} must be a whole number, got "${raw}"`);
    return fallback;
  }
  const value = Number(raw.trim());
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}, got ${value}`);
    return fallback;
  }
  return value;
}

function readEnum(env, name, fallback, allowed, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (!allowed.includes(value)) {
    problems.push(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
    return fallback;
  }
  return value;
}

function parseHostPort(raw) {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(raw.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, ''), port };
}

function parseDatabaseUrl(raw, problems) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push('DATABASE_URL is not a valid URL');
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`DATABASE_URL must use postgres:// or postgresql://, got "${url.protocol}//"`);
    return null;
  }
  if (!url.hostname) {
    problems.push('DATABASE_URL has no host');
    return null;
  }
  const port = url.port ? Number(url.port) : 5432;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
}

/** Replace the password in a connection URL so it can be logged. */
export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[unparseable]';
  }
}

/**
 * Build the service configuration from an environment object.
 * Throws ConfigError listing every problem found.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const port = readInt(env, 'PORT', 3000, { min: 0, max: 65535 }, problems);
  const host = env.HOST?.trim() || '0.0.0.0';
  const logLevel = readEnum(env, 'LOG_LEVEL', 'info', LOG_LEVELS, problems);
  const shutdownTimeoutMs = readInt(env, 'SHUTDOWN_TIMEOUT_MS', 10000, { min: 100, max: 120000 }, problems);
  const drainDelayMs = readInt(env, 'DRAIN_DELAY_MS', 0, { min: 0, max: 60000 }, problems);
  const readyTimeoutMs = readInt(env, 'READY_TIMEOUT_MS', 1000, { min: 50, max: 30000 }, problems);
  const serviceName = env.SERVICE_NAME?.trim() || 'reference-app';

  const databaseUrl = env.DATABASE_URL?.trim() || '';
  const readyCheck = readEnum(env, 'READY_CHECK', databaseUrl ? 'postgres' : 'none', READY_CHECKS, problems);

  let readyTarget = null;
  if (readyCheck === 'postgres') {
    if (!databaseUrl) problems.push('READY_CHECK=postgres needs DATABASE_URL');
    else readyTarget = parseDatabaseUrl(databaseUrl, problems);
  } else if (readyCheck === 'tcp') {
    const raw = env.READY_CHECK_TARGET?.trim();
    if (!raw) problems.push('READY_CHECK=tcp needs READY_CHECK_TARGET as host:port');
    else {
      readyTarget = parseHostPort(raw);
      if (!readyTarget) problems.push(`READY_CHECK_TARGET must be host:port, got "${raw}"`);
    }
  }

  if (drainDelayMs >= shutdownTimeoutMs) {
    problems.push('DRAIN_DELAY_MS must be shorter than SHUTDOWN_TIMEOUT_MS');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    serviceName,
    host,
    port,
    logLevel,
    shutdownTimeoutMs,
    drainDelayMs,
    readyTimeoutMs,
    readyCheck,
    readyTarget: readyTarget ? Object.freeze(readyTarget) : null,
    databaseUrlRedacted: databaseUrl ? redactUrl(databaseUrl) : null,
  });
}
