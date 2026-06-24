// Read-only DB queries backing the dashboard pages. These run the same SQLite
// handle the API + worker use; the dashboard never mutates state.
//
// Kept separate from `src/routes/*` (the JSON API) on purpose: the API speaks a
// stable wire contract for CI, while these shape data specifically for HTML
// rendering (and lean on `activeMetrics()` so the column list tracks the
// schema).

import { getDb } from '../db/index.js';
import { activeMetrics } from './metrics.js';
import { median } from './format.js';

const DAY_MS = 86_400_000;

/** Top-of-page counters: queue health + lifetime totals. */
export function getOverview() {
  const db = getDb();
  const cutoff7 = new Date(Date.now() - 7 * DAY_MS).toISOString();

  const builds = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?), 0) AS last7 FROM builds`,
  ).get(cutoff7);

  const cells = db.prepare(`
    SELECT
      COUNT(*)                                              AS total,
      COALESCE(SUM(status = 'completed'), 0)                AS completed,
      COALESCE(SUM(status = 'failed'), 0)                   AS failed,
      COALESCE(SUM(status = 'queued'), 0)                   AS queued,
      COALESCE(SUM(status = 'running'), 0)                  AS running,
      COALESCE(SUM(status = 'completed' AND published_at IS NULL), 0) AS pend_ok,
      COALESCE(SUM(status = 'failed'    AND published_at IS NULL), 0) AS pend_fail
    FROM cells
  `).get();

  const runs = db.prepare(`SELECT COUNT(*) AS total FROM runs`).get();

  const terminal = cells.completed + cells.failed;
  return {
    buildsTotal: builds.total,
    buildsLast7: builds.last7,
    cellsTotal: cells.total,
    cellsCompleted: cells.completed,
    cellsFailed: cells.failed,
    passRate: terminal ? cells.completed / terminal : null,
    runsTotal: runs.total,
    queue: {
      queued: cells.queued,
      running: cells.running,
      pendingPublish: cells.pend_ok + cells.pend_fail,
    },
  };
}

/** Paginated build list (newest first), with cell counts + a rough avg score. */
export function listBuilds({ limit = 40, before = null } = {}) {
  const db = getDb();
  const cols = `
    b.build_id, b.commit_sha, b.branch, b.triggered_by, b.created_at,
    b.completed_at, b.status,
    (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id) AS cells_total,
    (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'completed') AS cells_completed,
    (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'failed') AS cells_failed,
    (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status IN ('queued','running')) AS cells_pending,
    (SELECT AVG(r.performance_score)
       FROM runs r JOIN cells c ON c.cell_id = r.cell_id
      WHERE c.build_id = b.build_id) AS avg_score
  `;
  if (before) {
    return db.prepare(`
      SELECT ${cols} FROM builds b
      WHERE b.created_at < (SELECT created_at FROM builds WHERE build_id = ?)
      ORDER BY b.created_at DESC LIMIT ?
    `).all(before, limit);
  }
  return db.prepare(`
    SELECT ${cols} FROM builds b ORDER BY b.created_at DESC LIMIT ?
  `).all(limit);
}

/** Full build detail: the build row + every cell with its runs inlined. */
export function getBuildDetail(buildId) {
  const db = getDb();
  const build = db.prepare(`
    SELECT build_id, commit_sha, branch, triggered_by, workflow_run_url,
           created_at, completed_at, status
    FROM builds WHERE build_id = ?
  `).get(buildId);
  if (!build) return null;

  const cells = db.prepare(`
    SELECT cell_id, app, mode, serve_mode, status, error, url, published_at,
           queued_at, started_at, completed_at
    FROM cells WHERE build_id = ? ORDER BY app, mode
  `).all(buildId);

  // Build the run SELECT from the live metric set so we never reference a
  // column the schema doesn't have. Keys come from the fixed RUN_METRICS
  // whitelist, so no injection surface.
  const metricCols = activeMetrics().map(m => m.key);
  const selectCols = ['cell_id', 'run_id', 'run_index', 'report_html_path', 'collected_at', ...metricCols].join(', ');
  const runs = db.prepare(`
    SELECT ${selectCols} FROM runs
    WHERE cell_id IN (SELECT cell_id FROM cells WHERE build_id = ?)
    ORDER BY cell_id, run_index
  `).all(buildId);

  const byCell = new Map();
  for (const r of runs) {
    if (!byCell.has(r.cell_id)) byCell.set(r.cell_id, []);
    byCell.get(r.cell_id).push(r);
  }
  for (const c of cells) c.runs = byCell.get(c.cell_id) ?? [];

  return { build, cells };
}

/**
 * Per (app, mode) trend series for the home page sparklines: the median
 * performance score + median LCP of each recent build that produced runs for
 * that combination, oldest→newest, capped at `perGroup` builds.
 */
export function getTrends({ perGroup = 24 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.app AS app, c.mode AS mode, c.build_id AS build_id,
           b.created_at AS created_at, b.commit_sha AS commit_sha,
           r.performance_score AS score, r.lcp_ms AS lcp
    FROM runs r
    JOIN cells c ON c.cell_id = r.cell_id
    JOIN builds b ON b.build_id = c.build_id
    WHERE c.status = 'completed'
    ORDER BY b.created_at ASC
  `).all();

  // group -> buildId -> { createdAt, commit, scores[], lcps[] }
  const groups = new Map();
  for (const row of rows) {
    const gKey = `${row.app}\u0000${row.mode}`;
    if (!groups.has(gKey)) groups.set(gKey, { app: row.app, mode: row.mode, builds: new Map() });
    const g = groups.get(gKey);
    if (!g.builds.has(row.build_id)) {
      g.builds.set(row.build_id, { buildId: row.build_id, createdAt: row.created_at, commit: row.commit_sha, scores: [], lcps: [] });
    }
    const b = g.builds.get(row.build_id);
    if (row.score != null) b.scores.push(row.score);
    if (row.lcp != null) b.lcps.push(row.lcp);
  }

  const series = [];
  for (const g of groups.values()) {
    const points = [...g.builds.values()]
      .map(b => ({
        buildId: b.buildId,
        createdAt: b.createdAt,
        commit: b.commit,
        score: median(b.scores),
        lcp: median(b.lcps),
      }))
      .slice(-perGroup);
    if (points.length === 0) continue;
    series.push({ app: g.app, mode: g.mode, points, latest: points[points.length - 1] });
  }

  // Stable, human-friendly ordering: app then mode.
  series.sort((a, b) => a.app.localeCompare(b.app) || a.mode.localeCompare(b.mode));
  return series;
}
