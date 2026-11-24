#!/usr/bin/env node
// Process entry point: configuration, signals, exit codes.

import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { dependencyCheckFor } from './readiness.js';
import { createService } from './server.js';

// sysexits.h EX_CONFIG: lets an orchestrator tell "bad configuration" from a crash.
const EXIT_CONFIG = 78;

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  createLogger({ level: 'error' }).error('invalid configuration', { problems: error.problems });
  process.exit(EXIT_CONFIG);
}

const logger = createLogger({ level: config.logLevel, base: { service: config.serviceName } });
const service = createService({ config, logger, checkDependency: dependencyCheckFor(config) });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    service.shutdown(signal).then(() => process.exit(0));
  });
}

process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('unhandled rejection', { error });
  process.exit(1);
});

try {
  await service.listen();
} catch (error) {
  logger.error('could not start listening', { error });
  process.exit(1);
}
