// Sentry SDK boot for the publisher process.
//
// Imported for side-effects: just doing `import './sentry.js'` at the top of
// publisher.js is enough. Per the Sentry skill docs, init should happen
// before any other module that emits metrics — keeping the import side-
// effect-only makes that contract impossible to break by re-ordering.
//
// If SENTRY_DSN is unset the SDK is initialised in disabled mode (no
// network egress, no telemetry), which is what local dev wants when you
// only care about the worker side.

import * as Sentry from '@sentry/node';

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    release: config.gitSha,
    // No tracing — the publisher is a polling loop with one DB read per tick,
    // there's nothing useful to trace. Disabling it also avoids the OTel
    // bootstrap overhead.
    tracesSampleRate: 0,
    // Error events still flow: if the publisher crashes or `Sentry.flush`
    // throws, we want to know about it in the same Sentry project that
    // receives our metrics.
    enabled: true,
  });
  // Global scope attributes attach to every metric envelope without us
  // re-passing them at every call site (SDK ≥10.33.0).
  Sentry.getGlobalScope().setAttributes({
    service: 'sentry-lhci',
    deploy_env: config.sentryEnvironment,
  });
  logger.info({ environment: config.sentryEnvironment, release: config.gitSha }, 'sentry initialised');
} else {
  Sentry.init({ enabled: false });
  logger.warn('SENTRY_DSN not set — publisher will run but emit nothing');
}

export { Sentry };
