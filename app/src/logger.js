// One JSON object per line on stdout: what log shippers (Docker's json-file driver,
// Loki, CloudWatch, Datadog) expect, and what `jq` can read during an incident.

import { LOG_LEVELS } from './config.js';

const RANK = Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index]));

function serialiseError(error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

export function createLogger({
  level = 'info',
  stream = process.stdout,
  clock = () => new Date(),
  base = {},
} = {}) {
  if (!(level in RANK)) throw new TypeError(`Unknown log level "${level}"`);
  const threshold = RANK[level];

  function write(entryLevel, msg, fields = {}) {
    if (RANK[entryLevel] < threshold) return;
    const entry = { time: clock().toISOString(), level: entryLevel, msg, ...base };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = value instanceof Error ? serialiseError(value) : value;
    }
    stream.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level, stream, clock, base: { ...base, ...extra } }),
  };
}
