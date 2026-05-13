// Fastify entrypoint. Runs migrations, mounts plugins/routes, listens.
//
// The HTTP server and the worker share this single process (see PLAN.md
// "Architecture") so the queue runs in the same event loop. Future-us can
// extract the worker to its own container without touching the public API.

import { setTimeout as wait } from 'node:timers/promises';

import Fastify from 'fastify';

import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { assertConfig, config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { ensureDataDirs } from './lib/paths.js';
import { authPlugin } from './lib/auth.js';

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

  // --- Routes ---
  // /healthz is intentionally unauthenticated — Northflank pings it.
  fastify.get('/healthz', async () => ({
    ok: true,
    version: config.gitSha,
    packageVersion: config.packageVersion,
    uptimeSec: Math.round(process.uptime()),
  }));

  // Placeholder so callers get a real 401 rather than 404 before Phase 2 lands.
  fastify.post('/api/builds', {
    onRequest: fastify.requireUploadToken,
    handler: async (_req, reply) => {
      reply.code(501);
      return { error: 'not_implemented', message: 'Upload endpoint lands in Phase 2' };
    },
  });

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
      await fastify.close();
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
}

start().catch(err => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
