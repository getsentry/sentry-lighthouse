// Publisher entrypoint. Runs as a separate process from the HTTP server
// (see src/supervisor.js for how they're co-launched in Docker).
//
// Bootstrap order matters: Sentry.init() runs first via the side-effect
// import below, before any module that calls Sentry.metrics.*. Then we run
// migrations (idempotent; safe even if the server already ran them — both
// processes share the volume), then start the polling loop.

import { setProcessRole } from './lib/sentry.js';
setProcessRole('publisher');

import { setTimeout as wait } from 'node:timers/promises';

import * as Sentry from '@sentry/node';

import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { logger } from './lib/logger.js';
import { startPublisher, stopPublisher } from './publisher/runner.js';
import { config } from './lib/config.js';

async function main() {
  runMigrations();
  const loop = startPublisher();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'publisher: shutdown started');
    try {
      await stopPublisher();
      await Sentry.flush(config.sentryFlushTimeoutMs);
      await Sentry.close(config.sentryFlushTimeoutMs);
      await wait(250); // pino flush
      closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'publisher: shutdown failed');
      process.exit(1);
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await loop;
}

main().catch(err => {
  logger.fatal({ err }, 'publisher: fatal');
  process.exit(1);
});
