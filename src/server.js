// Fastify entrypoint. Runs migrations, mounts plugins/routes, listens.
//
// The HTTP server and the worker share this single process (see PLAN.md
// "Architecture") so the queue runs in the same event loop. Future-us can
// extract the worker to its own container without touching the public API.

import { setTimeout as wait } from 'node:timers/promises';

import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';

import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { assertConfig, config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { ensureDataDirs } from './lib/paths.js';
import { authPlugin } from './lib/auth.js';
import { buildsRoutes } from './routes/builds.js';
import { runsRoutes } from './routes/runs.js';
import { startWorker, stopWorker } from './worker/runner.js';

async function buildServer() {
  assertConfig();
  await ensureDataDirs();
  runMigrations();

  const fastify = Fastify({
    loggerInstance: logger,                      // Fastify 5: pass an existing pino instance
    bodyLimit: config.maxUploadBytes,           // accept large multipart bundles
    disableRequestLogging: false,
    trustProxy: true,                            // Northflank fronts us with a proxy
    genReqId: () => crypto.randomUUID(),
  });

  // --- Plugins ---
  await fastify.register(authPlugin);
  await fastify.register(fastifyMultipart, {
    limits: {
      // One bundle per cell. 600 MB default per file; we have up to 9 cells per
      // build so a single multipart request can be sizeable.
      fileSize: config.maxUploadBytes,
      // Keep field count generous so additions to the metadata schema don't
      // require a config tweak.
      fields: 64,
      files: 64,
      headerPairs: 1000,
    },
  });

  // --- Routes ---
  // /healthz is intentionally unauthenticated — Northflank pings it.
  fastify.get('/healthz', async () => ({
    ok: true,
    version: config.gitSha,
    packageVersion: config.packageVersion,
    uptimeSec: Math.round(process.uptime()),
  }));

  await fastify.register(buildsRoutes);
  await fastify.register(runsRoutes);

  return fastify;
}

async function start() {
  const fastify = await buildServer();

  // --- Graceful shutdown ---
  // SIGTERM is what Northflank/Docker send during deploys. We close the HTTP
  // listener first (no new requests), give in-flight work a few seconds, then
  // close the DB. The worker (Phase 3) hooks into the same signal handler.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info({ signal }, 'shutdown started');
    try {
      // 1. Stop accepting new HTTP connections (so the proxy stops sending them).
      await fastify.close();
      // 2. Drain the worker. This blocks until the in-flight cell completes,
      //    which can be up to CELL_TIMEOUT_MS. Northflank gives ~30s by
      //    default — a long-running cell will be SIGKILLed by the platform
      //    and resume after restart (orphan recovery marks it failed).
      await stopWorker();
      // 3. Final flushes.
      await wait(250); // let pino flush
      closeDb();
      process.exit(0);
    } catch (err) {
      fastify.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await fastify.listen({ port: config.port, host: config.host });

  // Worker starts after the HTTP listener so failed worker boot doesn't keep
  // the API offline (the API is useful read-only even with a dead worker).
  startWorker();
}

start().catch(err => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
