// Centralised env var parsing. Read once at startup, fail fast on bad input.
//
// Anywhere else in the codebase, `import { config } from './lib/config.js'`
// and read the typed value. Never touch `process.env` directly outside this file.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

/** Parse a positive integer env var, fall back to default on missing/invalid. */
function intEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  const minOk = allowZero ? n >= 0 : n > 0;
  if (!Number.isFinite(n) || !minOk) {
    throw new Error(`Invalid ${name}: ${raw} (expected ${allowZero ? 'non-negative' : 'positive'} integer)`);
  }
  return n;
}

/** Required string env var, throws if unset. */
function requireEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing required env var: ${name}`);
  return raw;
}

const dataDir = resolve(process.env.DATA_DIR ?? './data');

export const config = {
  port: intEnv('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // Identity / versioning. Northflank exposes the four NF_* build args
  // automatically when listed in the service's Build args config. We prefer
  // those (truthier than what a human would manually pass) and fall back to
  // the local-build GIT_SHA arg, then the package version for bare local dev.
  packageVersion: pkg.version,
  gitSha: process.env.NF_GIT_SHA || process.env.GIT_SHA || `dev-${pkg.version}`,
  gitBranch: process.env.NF_GIT_BRANCH || null,
  previousBuildSha: process.env.NF_PREVIOUS_BUILD_GIT_SHA || null,
  buildId: process.env.NF_BUILD_ID || null,

  // Storage
  dataDir,
  buildsDir: join(dataDir, 'builds'),
  reportsDir: join(dataDir, 'reports'),
  dbPath: join(dataDir, 'db.sqlite'),

  // Auth
  uploadToken: process.env.UPLOAD_TOKEN ?? '',
  dashboardUsername: process.env.DASHBOARD_USERNAME ?? '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',

  // Limits
  // 100 MB is generous now that bundles ship without node_modules. The old
  // 600 MB ceiling was for the everything-included tarballs.
  maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 104_857_600),
  // 0 = delete bundles as soon as a build leaves the queue (useful for tests).
  bundleRetentionDays: intEnv('BUNDLE_RETENTION_DAYS', 7, { allowZero: true }),

  // Lighthouse runtime
  chromePath: process.env.CHROME_PATH ?? '',
  numRuns: intEnv('LIGHTHOUSE_NUM_RUNS', 5),
  cellTimeoutMs: intEnv('CELL_TIMEOUT_MS', 15 * 60 * 1000),     // 15 min hard ceiling per cell
  installTimeoutMs: intEnv('INSTALL_TIMEOUT_MS', 5 * 60 * 1000),// 5 min ceiling for pre-lhci installCmd
  workerIdleSleepMs: intEnv('WORKER_IDLE_SLEEP_MS', 5000),       // poll cadence when queue is empty

  // Disk pressure
  diskFullThreshold: parseFloat(process.env.DISK_FULL_THRESHOLD ?? '0.9'), // 0..1; >this rejects uploads with 507

  // Sentry publisher
  sentryDsn: process.env.SENTRY_DSN ?? '',
  sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV ?? 'development'),
  publisherPollMs: intEnv('PUBLISHER_POLL_MS', 10_000),          // cadence for the publisher loop
  sentryFlushTimeoutMs: intEnv('SENTRY_FLUSH_TIMEOUT_MS', 2_000),
};

/**
 * Validate config at startup. Called from server bootstrap so misconfigurations
 * fail before the HTTP listener binds (loud, early, obvious).
 */
export function assertConfig() {
  if (!config.uploadToken) {
    throw new Error('UPLOAD_TOKEN must be set');
  }
  if (config.uploadToken.length < 24) {
    throw new Error('UPLOAD_TOKEN is too short (need ≥24 chars; use `openssl rand -hex 32`)');
  }
  if (config.dashboardUsername && !config.dashboardPassword) {
    throw new Error('DASHBOARD_USERNAME set but DASHBOARD_PASSWORD is empty');
  }
}

// Re-export to make `requireEnv` available where useful (e.g. one-off scripts).
export { requireEnv };
