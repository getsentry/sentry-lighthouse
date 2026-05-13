// Periodic bundle retention sweep.
//
// Removes /data/builds/<buildId>/*.tar.gz once the build is older than
// BUNDLE_RETENTION_DAYS. We intentionally do NOT delete the build/cell/run
// rows or the LHR/HTML reports — historical data lives forever (the
// long-term home is Sentry anyway). Only the raw bundles, which are big and
// post-process-only useful for `/api/builds/:id/rerun`, are removed.
//
// Runs in-process as a setInterval. Cheap, single-tenant, no need for an
// external cron.

import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getDb } from '../db/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function runCleanupOnce() {
  const cutoffIso = new Date(Date.now() - config.bundleRetentionDays * ONE_DAY_MS).toISOString();
  const oldBuilds = getDb().prepare(`
    SELECT build_id FROM builds
     WHERE created_at < ?
       AND status IN ('completed','failed')
  `).all(cutoffIso);

  let bundlesDeleted = 0;
  let buildsTouched = 0;
  for (const { build_id } of oldBuilds) {
    const dir = join(config.buildsDir, build_id);
    try {
      const entries = await readdir(dir).catch(() => null);
      if (entries === null) continue; // build dir already gone
      const tarballs = entries.filter(f => f.endsWith('.tar.gz'));
      if (tarballs.length > 0) {
        buildsTouched++;
        for (const t of tarballs) {
          await rm(join(dir, t), { force: true });
          bundlesDeleted++;
        }
      }
      // Drop the build dir if it's empty (covers both fresh cleanups and
      // dirs left behind by previous cleanup runs that pre-dated this
      // call). rmdir refuses if anything's left, which is what we want —
      // we never want to nuke unexpected contents.
      await rmdir(dir).catch(() => {});
    } catch (err) {
      logger.warn({ err: err.message, buildId: build_id }, 'cleanup: build dir failed');
    }
  }

  if (bundlesDeleted > 0) {
    logger.info({ bundlesDeleted, buildsTouched, retentionDays: config.bundleRetentionDays }, 'cleanup: bundles removed');
  } else {
    logger.debug('cleanup: nothing to remove');
  }

  return { bundlesDeleted, buildsTouched };
}

let timer = null;
let stopped = false;

/** Kick off the periodic loop. First run happens after `intervalMs`, not at boot. */
export function startCleanupLoop({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (timer) return; // idempotent
  stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await runCleanupOnce(); } catch (err) {
      logger.warn({ err: err.message }, 'cleanup tick threw');
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  logger.info({ intervalMs, retentionDays: config.bundleRetentionDays }, 'cleanup loop scheduled');
}

export function stopCleanupLoop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
