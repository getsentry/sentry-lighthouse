// Publisher loop.
//
// Polls SQLite for completed (or failed) cells with `published_at IS NULL`,
// emits each of their runs to Sentry as distribution metrics, then marks the
// cell as published. The "median run" question is answered Sentry-side via
// distribution aggregation — we ship raw data points.
//
// Designed to be safe to crash + restart at any point:
//   - We flush Sentry *before* marking `published_at`. If the process dies
//     after flush but before the UPDATE, we re-emit the cell on next boot.
//     That's at-least-once delivery; Sentry's metrics product is idempotent
//     enough at the dashboard level (we'd just see a momentary blip in the
//     count metric) that double-emission isn't catastrophic.
//   - One cell at a time. The publisher has plenty of headroom for the
//     workload (9 cells/night). Sequential processing keeps the failure mode
//     simple.

import { setTimeout as wait } from 'node:timers/promises';

import { Sentry } from './sentry.js';
import { getDb } from '../db/index.js';
import { config } from '../lib/config.js';
import { logger as rootLogger } from '../lib/logger.js';

let shouldStop = false;
let inFlight = null;

export function stopPublisher() {
  shouldStop = true;
  return inFlight ?? Promise.resolve();
}

export async function startPublisher() {
  rootLogger.info({ pollMs: config.publisherPollMs }, 'publisher loop started');
  while (!shouldStop) {
    const cells = pickUnpublishedCells();
    if (cells.length === 0) {
      await wait(config.publisherPollMs);
      continue;
    }
    for (const cell of cells) {
      if (shouldStop) break;
      inFlight = publishCell(cell).catch(err => {
        rootLogger.error({ err: err.message, cellId: cell.cell_id }, 'publish failed; will retry next poll');
      });
      try { await inFlight; } finally { inFlight = null; }
    }
  }
  rootLogger.info('publisher loop stopped');
}

// --- Query side ---------------------------------------------------------

function pickUnpublishedCells() {
  // We join builds → cells to get the per-build attributes (commit, branch)
  // in one round-trip. The partial index `cells_unpublished` keeps this
  // cheap even with a large history.
  return getDb().prepare(`
    SELECT c.cell_id, c.build_id, c.app, c.mode, c.serve_mode, c.status,
           c.error, c.started_at, c.completed_at,
           b.commit_sha, b.branch
      FROM cells c
      JOIN builds b ON b.build_id = c.build_id
     WHERE c.status IN ('completed','failed')
       AND c.published_at IS NULL
     ORDER BY c.completed_at ASC
     LIMIT 50
  `).all();
}

function loadRunsForCell(cellId) {
  return getDb().prepare(`
    SELECT run_id, run_index, performance_score, lcp_ms, fcp_ms, tbt_ms,
           cls, total_bytes, collected_at
      FROM runs WHERE cell_id = ? ORDER BY run_index
  `).all(cellId);
}

// --- Emit side ----------------------------------------------------------

async function publishCell(cell) {
  const log = rootLogger.child({
    cellId: cell.cell_id, buildId: cell.build_id,
    app: cell.app, mode: cell.mode, status: cell.status,
  });

  const baseAttrs = {
    app: cell.app,
    mode: cell.mode,
    branch: cell.branch,
    commit: cell.commit_sha,
    serve_mode: cell.serve_mode,
  };

  if (cell.status === 'failed') {
    // No runs to ship; just account for the failure so dashboards can
    // surface "X out of Y cells failed this week".
    Sentry.metrics.count('lighthouse.cell.completed', 1, {
      attributes: { ...baseAttrs, result: 'failed' },
    });
    log.info('publishing failed cell (count only)');
  } else {
    const runs = loadRunsForCell(cell.cell_id);
    if (runs.length === 0) {
      log.warn('cell is completed but has no runs — nothing to publish');
    }
    for (const run of runs) {
      emitRunMetrics(run, baseAttrs);
    }
    Sentry.metrics.count('lighthouse.cell.completed', 1, {
      attributes: { ...baseAttrs, result: 'completed', runs: runs.length },
    });
    log.info({ runs: runs.length }, 'publishing completed cell');
  }

  // Flush BEFORE we mark published, so a crash here means a retry rather
  // than a silent loss. At-least-once > at-most-once for this workload.
  await Sentry.flush(config.sentryFlushTimeoutMs);

  getDb().prepare(`UPDATE cells SET published_at = ? WHERE cell_id = ?`)
    .run(new Date().toISOString(), cell.cell_id);
}

function emitRunMetrics(run, baseAttrs) {
  const attrs = { ...baseAttrs, run_index: run.run_index };

  // Score is a 0..1 ratio. Sentry's distribution chart can render p50/p90
  // out of the box once we have a few builds in.
  if (run.performance_score != null) {
    Sentry.metrics.distribution('lighthouse.score', run.performance_score, {
      unit: 'ratio',
      attributes: attrs,
    });
  }
  if (run.lcp_ms != null) {
    Sentry.metrics.distribution('lighthouse.lcp', run.lcp_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
  if (run.fcp_ms != null) {
    Sentry.metrics.distribution('lighthouse.fcp', run.fcp_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
  if (run.tbt_ms != null) {
    Sentry.metrics.distribution('lighthouse.tbt', run.tbt_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
  if (run.cls != null) {
    // CLS is a unitless score (cumulative layout shift), not a 0..1 ratio.
    Sentry.metrics.distribution('lighthouse.cls', run.cls, { attributes: attrs });
  }
  if (run.total_bytes != null) {
    Sentry.metrics.distribution('lighthouse.bytes', run.total_bytes, {
      unit: 'byte',
      attributes: attrs,
    });
  }
}
