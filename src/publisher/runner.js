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

import { Sentry } from '../lib/sentry.js';
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
        Sentry.captureException(err, {
          tags: {
            kind: 'publish_failure',
            app: cell.app,
            mode: cell.mode,
            serve_mode: cell.serve_mode,
            throttle_method: cell.throttle_method,
          },
          contexts: {
            cell: {
              cellId: cell.cell_id,
              buildId: cell.build_id,
              commit: cell.commit_sha,
              branch: cell.branch,
              status: cell.status,
            },
          },
        });
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
    SELECT c.cell_id, c.build_id, c.app, c.mode, c.serve_mode, c.throttle_method,
           c.status, c.error, c.started_at, c.completed_at,
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
    SELECT run_id, run_index, performance_score, lcp_ms, lcp_element, fcp_ms, tbt_ms,
           cls, total_bytes, run_duration_ms, sentry_sdk_init_ms,
           sentry_sdk_pre_init_ms, collected_at
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
    throttle_method: cell.throttle_method,
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

  // Sentry's metrics product accepts a fixed set of unit strings
  // (integer/number/{nano,micro,milli}second/.../byte/.../percentage/...).
  // 'ratio' is NOT in that list — emitting it makes the backend fall back
  // to a string-typed field and refuse to compute p50/p90 over it. Score
  // and CLS therefore both go through the numeric path below.

  // collect number of runs as a metric (only as attributes doesn't allow for visualization in Sentry)
  Sentry.metrics.count('lighthouse.run.completed', 1, {
    attributes: attrs,
  });

  if (run.performance_score != null) {
    // LHR scores are 0..1 floats; Lighthouse's own UI shows them as 0..100.
    // We multiply here so Sentry dashboards render '78%' instead of '0.78'
    // and so 'percentage' (a valid Sentry unit) describes the value.
    Sentry.metrics.distribution('lighthouse.score', run.performance_score * 100, {
      unit: 'percentage',
      attributes: attrs,
    });
  }
  if (run.lcp_ms != null) {
    // Tag the LCP metric with the element Lighthouse blamed for it (CSS
    // selector), so dashboards can answer "which element drives LCP" per
    // app/mode. Absent when the LCP-element audit was not-applicable.
    Sentry.metrics.distribution('lighthouse.lcp', run.lcp_ms, {
      unit: 'millisecond',
      attributes: run.lcp_element ? { ...attrs, lcp_element: run.lcp_element } : attrs,
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
    // CLS is a unitless cumulative-layout-shift score (typically 0..0.25,
    // can exceed 1). 'number' tells Sentry it's a plain numeric distribution.
    Sentry.metrics.distribution('lighthouse.cls', run.cls, {
      unit: 'number',
      attributes: attrs,
    });
  }
  if (run.total_bytes != null) {
    Sentry.metrics.distribution('lighthouse.bytes', run.total_bytes, {
      unit: 'byte',
      attributes: attrs,
    });
  }
  if (run.run_duration_ms != null) {
    // Lighthouse's own `timing.total`: how long this single run took
    // end-to-end. Always present for a successful run.
    Sentry.metrics.distribution('lighthouse.run_duration', run.run_duration_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
  if (run.sentry_sdk_init_ms != null) {
    // `performance.measure('sentry-sdk-init-duration')` from the instrumented
    // test app, surfaced by Lighthouse's user-timings audit. Null for
    // no-sentry cells, so the dashboard only sees it where it's meaningful.
    Sentry.metrics.distribution('lighthouse.sentry_sdk_init', run.sentry_sdk_init_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
  if (run.sentry_sdk_pre_init_ms != null) {
    // `performance.measure('sentry-sdk-pre-init-duration')` — emitted by the
    // instrumented apps alongside the init measure. Same null semantics.
    Sentry.metrics.distribution('lighthouse.sentry_sdk_pre_init', run.sentry_sdk_pre_init_ms, {
      unit: 'millisecond',
      attributes: attrs,
    });
  }
}
