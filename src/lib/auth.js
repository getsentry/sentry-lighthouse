// Auth plugins. Two independent layers:
//   - Bearer token on the upload endpoints (CI ↔ server).
//   - Optional HTTP basic auth on the read API + dashboard (humans ↔ server).
//
// Each is registered as a Fastify plugin and applied selectively via per-route
// `onRequest` hooks. We don't want a single global auth or we'd block /healthz
// (which Northflank pings unauthenticated).

import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyBearerAuth from '@fastify/bearer-auth';
import fp from 'fastify-plugin';

import { config } from './config.js';

/**
 * Register both auth plugins under named scopes. Routes opt in like:
 *
 *     fastify.route({
 *       method: 'POST', url: '/api/builds',
 *       onRequest: fastify.requireUploadToken,
 *       handler: …
 *     });
 *
 *     fastify.route({
 *       method: 'GET', url: '/',
 *       onRequest: fastify.requireDashboardAuth,
 *       handler: …
 *     });
 */
async function authPluginImpl(fastify) {
  // --- Bearer token (mandatory; UPLOAD_TOKEN is asserted at boot) ---
  await fastify.register(fastifyBearerAuth, {
    keys: new Set([config.uploadToken]),
    addHook: false, // we expose the hook manually, no global mounting
    errorResponse: err => ({ error: 'unauthorized', message: err.message }),
  });

  // `verifyBearerAuth` is the per-route hook fastify-bearer-auth exposes when
  // `addHook: false`. Re-expose under a name that reads well at the call site.
  fastify.decorate('requireUploadToken', fastify.verifyBearerAuth);

  // --- HTTP basic auth (optional; only mount the hook if creds are configured) ---
  if (config.dashboardUsername && config.dashboardPassword) {
    await fastify.register(fastifyBasicAuth, {
      authenticate: { realm: 'sentry-lhci' },
      validate: (username, password, _req, _reply, done) => {
        const ok = username === config.dashboardUsername && password === config.dashboardPassword;
        done(ok ? null : new Error('Invalid credentials'));
      },
    });
    fastify.decorate('requireDashboardAuth', fastify.basicAuth);
  } else {
    // No-op hook so route definitions don't have to branch on `if (auth)`.
    fastify.decorate('requireDashboardAuth', (_req, _reply, done) => done());
  }
}

export const authPlugin = fp(authPluginImpl, { name: 'auth' });
