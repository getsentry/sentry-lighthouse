// Sentry SDK boot. Shared by every long-running entrypoint (server,
// publisher, supervisor) so any unhandled error or explicit captureException
// from any of them flows into the same Sentry project that receives the
// metrics.
//
// Imported for side-effects: `import './lib/sentry.js'` at the top of each
// entrypoint is enough. Init happens at module evaluation, before any
// downstream module that emits metrics or throws is reached.
//
// If SENTRY_DSN is unset the SDK initialises in disabled mode (no network
// egress, no telemetry) — which is the right local-dev default when you
// only care about the worker.

import * as Sentry from '@sentry/node';

import { config } from './config.js';
import { logger } from './logger.js';

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    release: config.gitSha,
    // No tracing. The lab is two polling loops + a tarball-extract worker —
    // nothing useful for OTel/spans, and disabling avoids the bootstrap
    // overhead.
    tracesSampleRate: 0,
    enabled: true,
  });
  // Global-scope attributes attach to every event (errors) AND every metric
  // envelope without per-call boilerplate. SDK ≥10.33.0 propagates these
  // through both pipelines.
  Sentry.getGlobalScope().setAttributes({
    service: 'sentry-lighthouse',
    deploy_env: config.sentryEnvironment,
  });
  logger.info({ environment: config.sentryEnvironment, release: config.gitSha }, 'sentry initialised');
} else {
  Sentry.init({ enabled: false });
  logger.warn('SENTRY_DSN not set — Sentry events and metrics are disabled');
}

/**
 * Set the per-process role tag. Called once at boot by each entrypoint so
 * Sentry events/metrics can be filtered by which process emitted them.
 */
export function setProcessRole(role) {
  Sentry.getGlobalScope().setAttributes({ process_role: role });
  Sentry.getGlobalScope().setTag('process_role', role);
}

export { Sentry };
