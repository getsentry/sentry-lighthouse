// Worker loop. Pulls queued cells one at a time, runs Lighthouse, writes
// results back to SQLite + /data/reports/. Designed for single-process
// deployment per PLAN.md — one in-flight cell at a time per Google's
// variability docs.

import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { extract as tarExtract } from 'tar';

import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { logger as rootLogger } from '../lib/logger.js';
import { lhrJsonPath, reportDir, reportHtmlPath } from '../lib/paths.js';
import { config } from '../lib/config.js';
import { resolveChromePath } from './chrome.js';
import { collectLighthouse, extractMetrics } from './lighthouse.js';

let shouldStop = false;
let processingPromise = null;

/** True while a cell is mid-flight. Used by graceful shutdown to wait it out. */
export function isCellInFlight() {
  return processingPromise !== null;
}

/** Signal the loop to stop after the current cell finishes. */
export async function stopWorker() {
  shouldStop = true;
  if (processingPromise) {
    rootLogger.info('shutdown: waiting for in-flight cell to finish');
    try { await processingPromise; } catch { /* already logged by processCell */ }
  }
}

/** Kick off the loop. Returns the loop promise; caller normally doesn't await it. */
export function startWorker() {
  resolveChromePath();
  recoverOrphanedCells();
  return runLoop().catch(err => {
    rootLogger.fatal({ err }, 'worker loop crashed');
    process.exit(1);
  });
}

async function runLoop() {
  rootLogger.info({ numRuns: config.numRuns, cellTimeoutMs: config.cellTimeoutMs }, 'worker loop started');
  while (!shouldStop) {
    const cell = pickNextQueuedCell();
    if (!cell) {
      await wait(config.workerIdleSleepMs);
      continue;
    }
    processingPromise = processCell(cell);
    try {
      await processingPromise;
    } finally {
      processingPromise = null;
    }
  }
  rootLogger.info('worker loop stopped');
}

// --- Queue management ----------------------------------------------------

function recoverOrphanedCells() {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const res = db.prepare(`
    UPDATE cells
       SET status='failed',
           error='orphaned: process restarted while cell was running',
           completed_at = ?
     WHERE status = 'running'
  `).run(nowIso);
  if (res.changes) {
    rootLogger.warn({ count: res.changes }, 'recovered orphaned running cells');
    // Reconcile parent builds — anything where every cell is now terminal
    // gets its status flipped.
    settleTerminalBuilds(db, nowIso);
  }
}

function pickNextQueuedCell() {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM cells
       WHERE status = 'queued'
       ORDER BY queued_at ASC
       LIMIT 1
    `).get();
    if (!row) return null;
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE cells SET status='running', started_at=? WHERE cell_id=?`).run(nowIso, row.cell_id);
    db.prepare(`UPDATE builds SET status='running' WHERE build_id=? AND status='queued'`).run(row.build_id);
    return row;
  })();
}

// --- Per-cell processing -------------------------------------------------

async function processCell(cell) {
  const log = rootLogger.child({
    cellId: cell.cell_id,
    buildId: cell.build_id,
    app: cell.app,
    mode: cell.mode,
    serveMode: cell.serve_mode,
  });
  log.info({ bundlePath: cell.bundle_path }, 'cell: started');

  const extractDir = await mkdtemp(join(tmpdir(), `lhci-cell-${cell.cell_id}-`));
  try {
    log.debug({ extractDir }, 'cell: extracting bundle');
    await tarExtract({ file: cell.bundle_path, cwd: extractDir });

    log.info('cell: invoking lhci');
    const runs = await collectLighthouse({ cell, extractDir, log });
    if (runs.length === 0) {
      throw new Error('lhci produced no runs (empty manifest)');
    }

    log.info({ runs: runs.length }, 'cell: lhci done, moving artefacts');
    const persisted = await persistRunArtefacts(runs);

    writeRunsToDb({ cell, persisted });
    log.info({ runs: persisted.length }, 'cell: completed');
  } catch (err) {
    log.error({ err: err.message }, 'cell: failed');
    markCellFailed(cell.cell_id, err.message);
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(err => {
      log.warn({ err: err.message, extractDir }, 'cell: temp dir cleanup failed');
    });
  }
}

/**
 * Move each LHR (json + html) out of lhci's `.lighthouseci/` directory and
 * into our content-addressed `/data/reports/<runId>/`. Every run gets its
 * own HTML report kept on disk — storage is cheap and Sentry handles the
 * "median run" question on its end via distribution metrics.
 *
 * Done as a non-DB step first so a partial fs write doesn't leave
 * half-inserted rows.
 */
async function persistRunArtefacts(runs) {
  const out = [];
  for (const r of runs) {
    const runId = newId();
    const dir = reportDir(runId);
    await mkdir(dir, { recursive: true });

    const newJsonPath = lhrJsonPath(runId, r.runIndex);
    await rename(r.jsonPath, newJsonPath);

    let newHtmlPath = null;
    if (r.htmlPath) {
      newHtmlPath = reportHtmlPath(runId);
      await rename(r.htmlPath, newHtmlPath);
    }

    const lhr = JSON.parse(await readFile(newJsonPath, 'utf8'));
    out.push({
      runId,
      runIndex: r.runIndex,
      jsonPath: newJsonPath,
      htmlPath: newHtmlPath,
      metrics: extractMetrics(lhr),
    });
  }
  return out;
}

function writeRunsToDb({ cell, persisted }) {
  const db = getDb();
  // is_representative is a vestigial column from before we switched to
  // "ship every run as a distribution data point". Always 0; safe to drop in
  // a follow-up migration.
  const insertRun = db.prepare(`
    INSERT INTO runs (
      run_id, cell_id, run_index, is_representative,
      performance_score, lcp_ms, fcp_ms, tbt_ms, cls, total_bytes,
      lhr_json_path, report_html_path, collected_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const completedIso = new Date().toISOString();

  db.transaction(() => {
    for (const r of persisted) {
      insertRun.run(
        r.runId, cell.cell_id, r.runIndex,
        r.metrics.score, r.metrics.lcpMs, r.metrics.fcpMs, r.metrics.tbtMs,
        r.metrics.cls, r.metrics.bytes,
        r.jsonPath, r.htmlPath, completedIso,
      );
    }
    db.prepare(`UPDATE cells SET status='completed', completed_at=? WHERE cell_id=?`)
      .run(completedIso, cell.cell_id);
    settleTerminalBuild(db, cell.build_id, completedIso);
  })();
}

function markCellFailed(cellId, errMsg) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE cells SET status='failed', error=?, completed_at=? WHERE cell_id=?`)
      .run(errMsg, nowIso, cellId);
    const cell = db.prepare(`SELECT build_id FROM cells WHERE cell_id=?`).get(cellId);
    if (cell) settleTerminalBuild(db, cell.build_id, nowIso);
  })();
}

function settleTerminalBuild(db, buildId, nowIso) {
  const counts = db.prepare(`
    SELECT
      SUM(status IN ('queued','running')) AS pending,
      SUM(status = 'failed')              AS failed,
      COUNT(*)                            AS total
    FROM cells WHERE build_id = ?
  `).get(buildId);
  if (counts.pending > 0) return;
  const finalStatus = counts.failed > 0 ? 'failed' : 'completed';
  db.prepare(`UPDATE builds SET status=?, completed_at=? WHERE build_id=?`).run(finalStatus, nowIso, buildId);
}

function settleTerminalBuilds(db, nowIso) {
  const builds = db.prepare(`
    SELECT DISTINCT b.build_id
      FROM builds b
     WHERE b.status IN ('queued','running')
  `).all();
  for (const { build_id } of builds) {
    settleTerminalBuild(db, build_id, nowIso);
  }
}
