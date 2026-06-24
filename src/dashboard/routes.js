// Dashboard routes: server-rendered HTML at `/` and `/builds/:buildId`, plus
// the static CSS/JS served out of `views/` (the dir the Dockerfile already
// copies). Read-only — every page is a GET and only ever reads the DB.
//
// Auth: these opt into `requireDashboardAuth`, the optional HTTP-basic hook
// from src/lib/auth.js. When DASHBOARD_USERNAME/PASSWORD are unset that hook is
// a no-op, so the dashboard is public by default (same posture as the read API).

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';

import { getOverview, listBuilds, getBuildDetail, getTrends } from './queries.js';
import { renderHome, renderBuild, renderError } from './views.js';

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = resolve(here, '..', '..', 'views');

const BUILD_ID_PARAM_SCHEMA = {
  type: 'object',
  required: ['buildId'],
  properties: { buildId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } },
};

function htmlReply(reply, html, code = 200) {
  reply.code(code).type('text/html; charset=utf-8');
  return html;
}

export async function dashboardRoutes(fastify) {
  // Static assets (dashboard.css / dashboard.js) under /assets/*.
  await fastify.register(fastifyStatic, {
    root: assetsRoot,
    prefix: '/assets/',
    index: false,
    // Long cache + the GIT_SHA-stamped HTML means a deploy busts stale CSS/JS
    // via the changing query string we could add later; for now a short cache
    // keeps iteration painless without hammering the server.
    maxAge: '5m',
  });

  // Home: overview + trends + recent builds.
  fastify.get('/', { onRequest: fastify.requireDashboardAuth }, async (req, reply) => {
    const overview = getOverview();
    const builds = listBuilds({ limit: 40 });
    const trends = getTrends({ perGroup: 24 });
    return htmlReply(reply, renderHome({ overview, builds, trends }));
  });

  // Build detail.
  fastify.get('/builds/:buildId', {
    onRequest: fastify.requireDashboardAuth,
    schema: { params: BUILD_ID_PARAM_SCHEMA },
    handler: async (req, reply) => {
      const detail = getBuildDetail(req.params.buildId);
      if (!detail) {
        return htmlReply(reply, renderError({
          code: 404,
          title: 'Build not found',
          message: `No build with id ${req.params.buildId}.`,
        }), 404);
      }
      return htmlReply(reply, renderBuild(detail));
    },
  });

  // A malformed build id (fails the param schema) shouldn't 400-with-JSON in
  // the browser — give an HTML 404 instead. Scoped to this plugin only.
  fastify.setErrorHandler((err, req, reply) => {
    if (err.validation && req.url.startsWith('/builds/')) {
      return htmlReply(reply, renderError({
        code: 404,
        title: 'Build not found',
        message: 'That build id is not valid.',
      }), 404);
    }
    throw err;
  });
}
