// Filesystem path helpers. Single source of truth so we never sprinkle
// `join(DATA_DIR, 'builds', id, …)` in random places.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from './config.js';

export function buildDir(buildId) {
  return join(config.buildsDir, buildId);
}

export function bundlePath(buildId, app, mode) {
  // Filenames are flat inside the build dir, so `<app>-<mode>.tar.gz` is enough
  // to disambiguate cells within one build.
  return join(buildDir(buildId), `${app}-${mode}.tar.gz`);
}

export function reportDir(runId) {
  return join(config.reportsDir, runId);
}

export function lhrJsonPath(runId, runIndex) {
  return join(reportDir(runId), `lhr-${runIndex}.json`);
}

export function reportHtmlPath(runId) {
  return join(reportDir(runId), 'report.html');
}

/** Create the on-disk skeleton expected by the rest of the app. Called once at boot. */
export async function ensureDataDirs() {
  await mkdir(config.buildsDir, { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });
}
