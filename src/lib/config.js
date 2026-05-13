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
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: ${raw} (expected positive integer)`);
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

  // Identity / versioning
  packageVersion: pkg.version,
  // GIT_SHA is baked in at Docker build time (ARG/ENV). Falls back to package
  // version so local dev still gets *some* identifier in /healthz.
  gitSha: process.env.GIT_SHA ?? `dev-${pkg.version}`,

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
  maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 629_145_600), // 600 MB
  bundleRetentionDays: intEnv('BUNDLE_RETENTION_DAYS', 7),

  // Lighthouse runtime
  chromePath: process.env.CHROME_PATH ?? '',
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
